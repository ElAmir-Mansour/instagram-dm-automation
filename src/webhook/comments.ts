/**
 * The comment pipeline: `entry.changes` → campaign match → private reply (+ public reply).
 *
 * Handles both platforms. Instagram sends `field: 'comments'`; Facebook Pages send
 * `field: 'feed'` with `item: 'comment'`, and the two payloads name nothing the same way.
 */
import { queryCount, queryOne } from '../db/query.js';
import type { InteractionRow } from '../db/rows.js';
import { sendPrivateReply, sendPublicReply, sendDirectMessage, likeComment } from '../services/instagram.js';
import { getCreatorByPageId } from '../services/tenant.js';
import { matchCampaign } from '../services/matching.js';
import { loadLiveCampaigns, type LiveCampaign } from '../services/liveCampaigns.js';
import { recordPrivateReplyRecipient } from '../services/dmSales/bridge.js';
import { profileContextOrLegacy, ProfileUnreadableError } from '../services/profile/context.js';
import type { ArabicRegister } from '../services/profile/types.js';
import { checkFairSendQuota, canDmRecipient, recordDmSent } from '../utils/rateLimiter.js';
import { noteMetaFailure } from '../services/tokenHealth.js';
import { classifyDmError, dmFallbackReply, shouldPostDmFallback } from './errors.js';
import { describeError, log, withLogContext } from '../utils/log.js';
import { FINAL_ATTEMPT, type WebhookHandlerOptions } from './options.js';

interface NormalizedComment {
    commentId: string;
    postId: string;
    text: string;
    senderUsername: string;
    senderId: string;
    isFacebookComment: boolean;
}

/**
 * Comment ids this process created by replying publicly.
 *
 * Self-comments are normally filtered by comparing `value.from.id` to the stored page id, but
 * on Instagram-Login comment webhooks `from.id` is an app-scoped IGSID that may not equal the
 * business account id we store. If it does not, our own public reply comes back as a webhook
 * with a *new* comment_id — which the interactions ON CONFLICT cannot suppress — and the app
 * can answer itself indefinitely. Remembering what we just posted closes that loop.
 *
 * TODO: verify the IGSID-equals-business-account-id assumption against production logs; if it
 * holds, the pageOwnerId check alone is sufficient and this becomes belt-and-braces.
 *
 * Best effort only: this is per-instance memory, so a cold start between our reply and the
 * echo webhook loses it. The DB-backed fix is a `self_authored` marker on interactions.
 */
const selfAuthoredCommentIds = new Set<string>();
const SELF_AUTHORED_CAP = 500;

function rememberSelfAuthored(commentId: string | undefined): void {
    if (!commentId) return;
    // Bounded: a warm instance handling thousands of comments must not grow this forever.
    if (selfAuthoredCommentIds.size >= SELF_AUTHORED_CAP) {
        const oldest = selfAuthoredCommentIds.values().next().value;
        if (oldest) selfAuthoredCommentIds.delete(oldest);
    }
    selfAuthoredCommentIds.add(commentId);
}

/** Flatten the Instagram and Facebook comment payloads into one shape. */
function normalizeComment(change: any): NormalizedComment | null {
    if (change?.field === 'comments') {
        // Instagram comment webhook: field = 'comments'
        const v = change.value;
        return {
            commentId: v?.id,
            postId: v?.media?.id,
            text: v?.text?.toLowerCase() || '',
            senderUsername: v?.from?.username || v?.from?.id,
            senderId: v?.from?.id,
            isFacebookComment: false,
        };
    }

    if (change?.field === 'feed' && change.value?.item === 'comment' && change.value?.verb === 'add') {
        // Facebook Page comment webhook: field = 'feed', item = 'comment'
        const v = change.value;
        return {
            commentId: v?.comment_id,
            postId: v?.post_id,
            text: v?.message?.toLowerCase() || '',
            senderUsername: v?.from?.name || v?.from?.id,
            senderId: v?.from?.id,
            isFacebookComment: true,
        };
    }

    log('debug', 'comment.unhandled_field', { field: change?.field, item: change?.value?.item });
    return null;
}

export async function handleCommentChange(
    change: any,
    entryId: string,
    options: WebhookHandlerOptions = FINAL_ATTEMPT
): Promise<void> {
    const comment = normalizeComment(change);
    if (!comment) return;

    // Everything below inherits these fields, so one comment's whole journey — match, send,
    // like, public reply — can be pulled out of interleaved output with one filter.
    return withLogContext(
        {
            comment_id: comment.commentId,
            platform: comment.isFacebookComment ? 'facebook' : 'instagram',
        },
        () => processComment(comment, entryId, options)
    );
}

/**
 * A `[SPLIT]` template, divided into the one message that opens the conversation and the
 * follow-ups.
 *
 * The asymmetry is Meta's, not a preference: **exactly one private reply is allowed per
 * comment, ever.** So the first part is the step that can succeed or fail, and once it has
 * succeeded there is no way to try it again. Everything after it is a follow-up to a thread
 * that is already open, which is why the pipeline marks the interaction SENT after the first
 * part rather than after the last.
 *
 * Empty parts are dropped: a template ending in `[SPLIT]`, or with two in a row, otherwise
 * produced an empty send that Meta rejects with "param message must be a non-empty object".
 */
export function splitDmTemplate(dmText: string): { first: string; followUps: string[] } {
    const parts = dmText.split('[SPLIT]').map((part) => part.trim()).filter(Boolean);
    // An all-whitespace template has no usable parts. Falling back to the original text keeps
    // the failure where it was — one rejected send with a Meta error naming the empty
    // message — rather than turning it into a silent no-op that looks like success.
    return { first: parts[0] ?? dmText, followUps: parts.slice(1) };
}

/**
 * Take ownership of this comment, or decline.
 *
 * `interactions.comment_id UNIQUE` is the claim, and it was doing two jobs at once: suppressing
 * a Meta redelivery, and — unintentionally — suppressing a *retry*. The row is written PENDING
 * before anything is sent, so once a send failed, every later attempt inserted nothing, logged
 * `comment.duplicate_ignored` and returned successfully. The job was marked done and the
 * customer was never messaged.
 *
 * The distinction the UNIQUE index cannot make is between "we already finished with this
 * comment" and "we started and did not finish". `status` already records exactly that: PENDING
 * is only ever at rest when nothing was sent, because SENT is written before `recordDmSent`
 * and every failure path writes FAILED or USER_BLOCKED_DMS. So a PENDING row is unfinished
 * work and may be resumed; anything else is done.
 */
async function claimInteraction(
    campaignId: string,
    creatorId: string,
    comment: NormalizedComment
): Promise<{ id: string; resumed: boolean } | null> {
    const { commentId, senderUsername, postId, isFacebookComment } = comment;
    const platform = isFacebookComment ? 'facebook' : 'instagram';

    const claimed = await queryOne<Pick<InteractionRow, 'id'>>(
        // creator_id is written directly rather than left to be derived through `campaigns`.
        // The dashboard filters on it, and a NULL here is indistinguishable from the webhook
        // having stopped — the row simply vanishes from the tenant's activity log.
        `INSERT INTO interactions (campaign_id, creator_id, comment_id, sender_username, post_id, status, platform)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
         ON CONFLICT (comment_id) DO NOTHING
         RETURNING id`,
        [campaignId, creatorId, commentId, senderUsername, postId, platform]
    );
    if (claimed) return { id: claimed.id, resumed: false };

    const existing = await queryOne<Pick<InteractionRow, 'id' | 'status'>>(
        'SELECT id, status FROM interactions WHERE comment_id = $1',
        [commentId]
    );
    // No row after a conflict means it was deleted between the two statements — nothing to
    // resume, and re-inserting would fight whatever deleted it.
    if (!existing) return null;
    if (existing.status !== 'PENDING') return null;

    return { id: existing.id, resumed: true };
}

/**
 * The register the public fallback reply is written in: the tenant's comment surface's (`profileContextOrLegacy`).
 *
 * When the profile cannot be read the owner gets his Gulf wording (that is `profileContextOrLegacy`'s). Any other tenant's
 * read throws, and what happens next depends on whether a retry is left:
 *
 *   - one is: it re-throws, so the job runner backs off and tries again. The caller reads this BEFORE it writes the
 *     interaction FAILED, so the row is still PENDING and the retry resumes it (`claimInteraction`); read after, the retry
 *     would find a finished row, ignore it as a duplicate, and the public reply would be lost with nothing to say so;
 *   - none is (the last attempt, or the inline path with no retry at all): the reply goes out in the neutral wording (no
 *     register: Arabic reads as MSA, English as English) rather than not at all, and a `comment.fallback_register_unreadable`
 *     line says so. `neutral` is true then, so the row's note can say it too.
 */
async function fallbackRegister(creatorId: string, options: WebhookHandlerOptions): Promise<{ register: ArabicRegister | null; neutral: boolean }> {
    try {
        const { language } = await profileContextOrLegacy(creatorId, 'comment_reply');
        return { register: language.register, neutral: false };
    } catch (err) {
        if (!(err instanceof ProfileUnreadableError) || !options.lastAttempt) throw err;
        log('warn', 'comment.fallback_register_unreadable', {
            creator_id: creatorId, ...describeError(err), effect: 'no retry is left: the public reply goes out in the neutral wording',
        });
        return { register: null, neutral: true };
    }
}

async function processComment(
    comment: NormalizedComment,
    entryId: string,
    options: WebhookHandlerOptions
): Promise<void> {
    const { commentId, postId, text, senderUsername, senderId, isFacebookComment } = comment;

    log('info', 'comment.received', { post_id: postId, sender_username: senderUsername });

    if (commentId && selfAuthoredCommentIds.has(commentId)) {
        log('debug', 'comment.skipped_self_authored');
        return;
    }

    // Fetch Creator config — matches by IG page ID or FB page ID
    const creator = await getCreatorByPageId(entryId);
    if (!creator) {
        // Not necessarily a bug — a webhook for a page this deployment does not serve. But
        // it is also exactly what a mis-set page id looks like, so it is worth a warning.
        log('warn', 'comment.no_creator', { entry_id: entryId });
        return;
    }

    // Ignore self-comments — use the correct page ID field per platform
    const pageOwnerId = isFacebookComment ? creator.facebook_page_id : creator.instagram_page_id;
    if (senderId === pageOwnerId) {
        log('debug', 'comment.skipped_page_owner');
        return;
    }

    // Fetch campaigns & match keyword with Arabic normalization & post_id targeting.
    // The query (live only, most specific first) lives in services/liveCampaigns.ts, shared
    // with the dashboard's dry run, so what "Try a comment" says is what this line decides.
    const campaigns = await loadLiveCampaigns(creator.id);

    const matchedCampaign = matchCampaign<LiveCampaign>(text, postId, campaigns);

    if (!matchedCampaign) {
        // The single most common reason for "the automation is not working". A comment that
        // matches nothing writes no row at all, so without this line there is no evidence
        // the comment was ever seen.
        log('info', 'comment.no_campaign_match', {
            creator_id: creator.id,
            candidates: campaigns.length,
        });
        return;
    }
    log('info', 'comment.matched', {
        creator_id: creator.id,
        campaign_id: matchedCampaign.id,
        keyword: matchedCampaign.trigger_keyword,
    });

    const claim = await claimInteraction(matchedCampaign.id, creator.id, comment);
    if (!claim) {
        log('info', 'comment.duplicate_ignored');
        return;
    }

    const interactionId = claim.id;
    if (claim.resumed) {
        // Worth its own line: it means a previous attempt at this exact comment failed
        // transiently and left the work to be finished. Without it, a resumed interaction is
        // indistinguishable from a first delivery in the logs.
        log('info', 'comment.resumed', { interaction_id: interactionId });
    }

    // ── Rate limits, checked before anything leaves the building ──────────────
    if (!(await canDmRecipient(creator.id, senderId))) {
        log('info', 'dm.skipped_recipient_cap', { sender_username: senderUsername });
        await queryCount(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            ['FAILED', 'Skipped: recipient already received an automated DM within 24 hours.', interactionId]
        );
        return;
    }

    // Both ceilings: this creator's own hourly budget, and the app-wide pool every tenant
    // draws on. The second is the one that is not obvious — Meta's app-level limit does not
    // scale with tenant count, so a neighbour's viral reel is a real reason this send is
    // refused, and `error_log` has to say so or the operator debugs their own account.
    const quota = await checkFairSendQuota(creator.id, 'dm');
    if (!quota.allowed) {
        // Worth alerting on: this means real customers are being dropped.
        log('error', 'dm.quota_exhausted', {
            creator_id: creator.id,
            count: quota.count,
            limit: quota.limit,
            blocked_by: quota.blockedBy,
            app_count: quota.app.count,
            app_limit: quota.app.limit,
            source: 'comment',
        });
        const explanation = quota.blockedBy === 'app'
            ? `Skipped: the app-wide Meta send budget is exhausted (${quota.app.count}/${quota.app.limit} this hour). That budget is shared by every account on this app, so nothing is necessarily wrong with this one.`
            : `Skipped: hourly DM quota reached (${quota.count}/${quota.limit}). Meta throttles automated sends at ~200/hr.`;
        await queryCount(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            ['FAILED', explanation, interactionId]
        );
        return;
    }

    const fbPageId = isFacebookComment ? creator.facebook_page_id ?? undefined : undefined;
    const dmText: string = matchedCampaign.dm_template.replace(/{username}/g, senderUsername);

    const { first: firstPart, followUps } = splitDmTemplate(dmText);
    if (followUps.length > 0) {
        log('info', 'dm.sending_split', { parts: followUps.length + 1 });
    }

    // ── Step 1: the private reply — the core action, and the only retryable one ──
    // Meta's answer is kept: it names who the reply went to (`recipient_id`), which the comment → DM bridge writes down below.
    let privateReply: unknown;
    try {
        privateReply = await sendPrivateReply(commentId, firstPart, creator.page_access_token, fbPageId);
    } catch (dmError: any) {
        log('error', 'dm.send_failed', { creator_id: creator.id, ...describeError(dmError) });

        // A dead token is the one Meta failure that stops the whole account rather than one
        // send, and until now nothing noticed it at a call site.
        await noteMetaFailure(creator.id, dmError);

        const classified = classifyDmError(dmError);

        // A permanent failure — dead token, missing scope, recipient blocked DMs — will not
        // become true on the fourth try, so it is recorded as final and the job succeeds.
        //
        // A transient one used to be recorded the same way: FAILED, forever, on one blip,
        // with no way back except an operator noticing. The row stays PENDING instead and the
        // error re-raises, so the job runner backs off and comes back — at which point
        // `claimInteraction` resumes this same row rather than treating it as a duplicate.
        // On the last attempt there is nothing to come back, so it is written down as final
        // like any other failure.
        if (!classified.permanent && !options.lastAttempt) {
            await queryCount(
                'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
                ['PENDING', `Retrying after a transient failure: ${classified.error}`, interactionId]
            );
            throw dmError;
        }

        // The register of the public reply this failure is about to get, read before anything is written (see
        // `fallbackRegister`): a tenant whose profile cannot be read leaves the row PENDING and the job retries, instead of a
        // FAILED row that no retry would reach. Read only here, so a comment whose DM went out costs no profile read.
        let fallback: { register: ArabicRegister | null; neutral: boolean } | null = null;
        if (shouldPostDmFallback(dmError)) {
            try {
                fallback = await fallbackRegister(creator.id, options);
            } catch (readErr: any) {
                await queryCount(
                    'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
                    ['PENDING', `Retrying: the tenant's profile could not be read for the public reply. ${classified.error}`, interactionId]
                );
                throw readErr;
            }
        }

        await queryCount(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            [classified.status, classified.error, interactionId]
        );

        // The DM can never arrive. Reply publicly instead, so the person who asked isn't left
        // with nothing; the campaign's own "check your DMs" reply would send them to an empty
        // inbox, so it is skipped with everything else downstream.
        if (fallback) {
            try {
                const posted = await sendPublicReply(
                    commentId, dmFallbackReply({ dmText, isFacebook: isFacebookComment, register: fallback.register }), creator.page_access_token, isFacebookComment
                );
                rememberSelfAuthored(posted?.id);
                log('info', 'dm.fallback_public_reply', { reply_comment_id: posted?.id, platform: isFacebookComment ? 'facebook' : 'instagram' });
                await queryCount('UPDATE interactions SET error_log = $1 WHERE id = $2',
                    [`${classified.error} Replied publicly with the link instead${fallback.neutral ? ' (in the neutral wording: the tenant\'s profile could not be read)' : ''}.`, interactionId]);
            } catch (fallbackErr: any) {
                log('warn', 'dm.fallback_public_reply_failed', describeError(fallbackErr));
                await noteMetaFailure(creator.id, fallbackErr);
                await queryCount('UPDATE interactions SET error_log = $1 WHERE id = $2',
                    [`${classified.error} The public fallback reply failed too: ${fallbackErr?.message ?? fallbackErr}`, interactionId]);
            }
        }
        return; // skip everything downstream
    }

    // The conversation is open and cannot be opened again, so the status is settled here —
    // before anything else has a chance to fail. This used to sit after the whole `[SPLIT]`
    // loop, which made part 3 of a 3-part template able to mark the interaction FAILED even
    // though the person had already received parts 1 and 2. Worse, a retry of that row then
    // re-sent the private reply, which Meta refuses outright — so the retry could only ever
    // fail, three times, before recording a failure for a DM that was largely delivered.
    await queryCount('UPDATE interactions SET status = $1 WHERE id = $2', ['SENT', interactionId]);
    await recordDmSent(creator.id, senderId);
    log('info', 'dm.sent', { creator_id: creator.id, campaign_id: matchedCampaign.id });

    // ── Step 1.25: the comment → DM bridge (docs/DM_SALES_PLAN.md S10) — best effort, like the like and the public reply ──
    // Who the private reply went to, written on the interaction so that this person's DM can find the campaign (src/services/dmSales/bridge.ts).
    // After SENT, in its own statement and its own try/catch: whatever happens here, the status stays SENT and everything below still runs.
    // One UPDATE by primary key and no Graph call, so the comment's latency is what it was.
    try {
        await recordPrivateReplyRecipient(privateReply, {
            interactionId, creatorId: creator.id, campaignId: matchedCampaign.id, commenterId: senderId,
            platform: isFacebookComment ? 'facebook' : 'instagram',
        });
    } catch (bridgeErr: any) {
        log('warn', 'comment.bridge_failed', { creator_id: creator.id, interaction_id: interactionId, ...describeError(bridgeErr) });
    }

    // ── Step 1.5: the remaining [SPLIT] parts — best effort, like the public reply ──
    const totalParts = followUps.length + 1;
    for (const [index, part] of followUps.entries()) {
        try {
            await new Promise((resolve) => setTimeout(resolve, 500)); // keep ordering
            await sendDirectMessage(senderId, { text: part }, creator.page_access_token, fbPageId);
        } catch (followUpErr: any) {
            log('warn', 'dm.split_part_failed', {
                part: index + 2, of: totalParts, ...describeError(followUpErr),
            });
            await noteMetaFailure(creator.id, followUpErr);
            await queryCount(
                'UPDATE interactions SET error_log = $1 WHERE id = $2',
                [
                    `Message ${index + 2} of ${totalParts} failed to send (the first message was delivered): ${followUpErr.message}`,
                    interactionId,
                ]
            );
            // Stop rather than pressing on: the parts are a sequence, and delivering part 3
            // without part 2 reads worse to the recipient than stopping short.
            break;
        }
    }

    // ── Step 1.75: Auto-Like Comment (best-effort algorithmic boost) ──
    try {
        await likeComment(commentId, creator.page_access_token);
        log('debug', 'comment.liked');
    } catch (likeErr: any) {
        log('warn', 'comment.like_failed', describeError(likeErr));
    }

    // ── Step 2: Public Reply (best-effort, won't affect SENT status) ──
    if (matchedCampaign.public_reply_template) {
        try {
            // Split public replies by | and pick a random variation
            const replyTemplates = matchedCampaign.public_reply_template.split('|');
            const chosenReply = (replyTemplates[Math.floor(Math.random() * replyTemplates.length)] ?? '').trim();
            const publicReplyText = chosenReply.replace(/{username}/g, senderUsername);

            // Instagram: /{commentId}/replies  |  Facebook: /{commentId}/comments
            const posted = await sendPublicReply(
                commentId,
                publicReplyText,
                creator.page_access_token,
                isFacebookComment
            );
            // Meta echoes our own reply back as a new comment webhook; remember its id so the
            // next delivery is recognised as ours rather than answered.
            rememberSelfAuthored(posted?.id);
            log('info', 'comment.public_reply_sent', { reply_comment_id: posted?.id });
        } catch (publicErr: any) {
            // Public reply failed but DM already succeeded — log but keep SENT
            log('warn', 'comment.public_reply_failed', describeError(publicErr));
            await noteMetaFailure(creator.id, publicErr);

            let errorMsg = publicErr.message;
            if (errorMsg.includes('Code: 200')) {
                errorMsg = `App missing permission. Please add 'pages_manage_engagement' in Meta Developer Console -> App Review, and regenerate your Page Access Token. (${publicErr.message})`;
            }

            await queryCount(
                'UPDATE interactions SET error_log = $1 WHERE id = $2',
                [`Public reply failed: ${errorMsg}`, interactionId]
            );
        }
    }
}
