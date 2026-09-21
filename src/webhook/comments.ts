/**
 * The comment pipeline: `entry.changes` → campaign match → private reply (+ public reply).
 *
 * Handles both platforms. Instagram sends `field: 'comments'`; Facebook Pages send
 * `field: 'feed'` with `item: 'comment'`, and the two payloads name nothing the same way.
 */
import { queryCount, queryOne, queryRows } from '../db/query.js';
import type { CampaignRow as CampaignTableRow, InteractionRow } from '../db/rows.js';
import { sendPrivateReply, sendPublicReply, sendDirectMessage, likeComment } from '../services/instagram.js';
import { getCreatorByPageId } from '../services/tenant.js';
import { matchCampaign } from '../services/matching.js';
import { checkSendQuota, canDmRecipient, recordDmSent } from '../utils/rateLimiter.js';
import { classifyDmError } from './errors.js';
import { describeError, log, withLogContext } from '../utils/log.js';

/**
 * Exactly the campaign columns this pipeline selects.
 *
 * Derived from the table's row type rather than redeclared, so a column rename shows up here
 * as a compile error instead of as a campaign that silently stops matching.
 */
type CampaignRow = Pick<
    CampaignTableRow,
    'id' | 'trigger_keyword' | 'dm_template' | 'public_reply_template' | 'post_id' | 'is_active' | 'created_at'
>;

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

export async function handleCommentChange(change: any, entryId: string): Promise<void> {
    const comment = normalizeComment(change);
    if (!comment) return;

    // Everything below inherits these fields, so one comment's whole journey — match, send,
    // like, public reply — can be pulled out of interleaved output with one filter.
    return withLogContext(
        {
            comment_id: comment.commentId,
            platform: comment.isFacebookComment ? 'facebook' : 'instagram',
        },
        () => processComment(comment, entryId)
    );
}

async function processComment(comment: NormalizedComment, entryId: string): Promise<void> {
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
    // ORDER BY is not cosmetic: without it Postgres returns heap order, so a generic campaign
    // could shadow a post-specific one on the same keyword and the winner could change after
    // a VACUUM. Most specific first, then longest keyword, then newest.
    const campaigns = await queryRows<CampaignRow>(
        `SELECT id, trigger_keyword, dm_template, public_reply_template, post_id, is_active, created_at
           FROM campaigns
          WHERE creator_id = $1 AND is_active = true
          ORDER BY (post_id IS NOT NULL) DESC, length(trigger_keyword) DESC, created_at DESC`,
        [creator.id]
    );

    const matchedCampaign = matchCampaign<CampaignRow>(text, postId, campaigns);

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

    // Log interaction as PENDING. The UNIQUE on comment_id makes this the idempotency claim:
    // no row back means another delivery of the same comment already owns it.
    const claimed = await queryOne<Pick<InteractionRow, 'id'>>(
        // creator_id is written directly rather than left to be derived through `campaigns`.
        // The dashboard filters on it, and a NULL here is indistinguishable from the webhook
        // having stopped — the row simply vanishes from the tenant's activity log.
        `INSERT INTO interactions (campaign_id, creator_id, comment_id, sender_username, post_id, status, platform)
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)
         ON CONFLICT (comment_id) DO NOTHING
         RETURNING id`,
        [matchedCampaign.id, creator.id, commentId, senderUsername, postId, isFacebookComment ? 'facebook' : 'instagram']
    );

    if (!claimed) {
        log('info', 'comment.duplicate_ignored');
        return;
    }

    const interactionId = claimed.id;

    // ── Rate limits, checked before anything leaves the building ──────────────
    if (!(await canDmRecipient(creator.id, senderId))) {
        log('info', 'dm.skipped_recipient_cap', { sender_username: senderUsername });
        await queryCount(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            ['FAILED', 'Skipped: recipient already received an automated DM within 24 hours.', interactionId]
        );
        return;
    }

    const quota = await checkSendQuota(creator.id, 'dm');
    if (!quota.allowed) {
        // Worth alerting on: this means real customers are being dropped.
        log('error', 'dm.quota_exhausted', {
            creator_id: creator.id, count: quota.count, limit: quota.limit, source: 'comment',
        });
        await queryCount(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            [
                'FAILED',
                `Skipped: hourly DM quota reached (${quota.count}/${quota.limit}). Meta throttles automated sends at ~200/hr.`,
                interactionId,
            ]
        );
        return;
    }

    // Dispatch Messages
    try {
        // ── Step 1: Send Private DM (the core action) ──────────────────
        const fbPageId = isFacebookComment ? creator.facebook_page_id ?? undefined : undefined;
        const dmText: string = matchedCampaign.dm_template.replace(/{username}/g, senderUsername);

        if (dmText.includes('[SPLIT]')) {
            const parts = dmText.split('[SPLIT]');
            log('info', 'dm.sending_split', { parts: parts.length });

            // First message must be a private reply to the comment to initiate the conversation
            await sendPrivateReply(commentId, (parts[0] ?? '').trim(), creator.page_access_token, fbPageId);

            // Subsequent messages can be sent as direct messages to the user ID
            for (let i = 1; i < parts.length; i++) {
                const part = (parts[i] ?? '').trim();
                if (part) {
                    await new Promise((resolve) => setTimeout(resolve, 500)); // 500ms delay to keep ordering
                    await sendDirectMessage(senderId, { text: part }, creator.page_access_token, fbPageId);
                }
            }
        } else {
            await sendPrivateReply(commentId, dmText, creator.page_access_token, fbPageId);
        }

        // Mark SENT immediately — DM is what matters
        await queryCount('UPDATE interactions SET status = $1 WHERE id = $2', ['SENT', interactionId]);
        await recordDmSent(creator.id, senderId);
        log('info', 'dm.sent', { creator_id: creator.id, campaign_id: matchedCampaign.id });

        // ── Step 1.5: Auto-Like Comment (best-effort algorithmic boost) ──
        try {
            await likeComment(commentId, creator.page_access_token);
            log('debug', 'comment.liked');
        } catch (likeErr: any) {
            log('warn', 'comment.like_failed', describeError(likeErr));
        }
    } catch (dmError: any) {
        // Private DM failed → FAILED
        log('error', 'dm.send_failed', { creator_id: creator.id, ...describeError(dmError) });

        const classified = classifyDmError(dmError);
        await queryCount(
            'UPDATE interactions SET status = $1, error_log = $2 WHERE id = $3',
            [classified.status, classified.error, interactionId]
        );
        return; // skip public reply
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
