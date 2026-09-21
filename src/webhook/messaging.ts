/**
 * The DM pipeline: `entry.messaging` → Gemini → Meta Send API.
 *
 * Previously ~180 lines inline in the webhook handler, sharing one try/catch with the comment
 * pipeline — so a duplicate-key error here aborted the comment events queued behind it.
 */
import { queryCount, queryOne } from '../db/query.js';
import type { ConversationRow, MessageRow } from '../db/rows.js';
import { generateAiResponse } from '../services/ai.js';
import { sendDirectMessage } from '../services/instagram.js';
import { isPermanentMetaError } from '../services/http.js';
import { noteMetaFailure } from '../services/tokenHealth.js';
import { getCreatorByPageId, type Creator } from '../services/tenant.js';
import { checkFairSendQuota } from '../utils/rateLimiter.js';
import { toMetaMessage, applyDisclosure, type MetaMessagePayload } from './meta-payload.js';
import { FINAL_ATTEMPT, type WebhookHandlerOptions } from './options.js';
import { describeError, log, withLogContext } from '../utils/log.js';

/**
 * Meta asks for a fresh disclosure "after a significant lapse of time". The policy never
 * quantifies it; a week is long enough that the thread reads as a new conversation to the
 * person on the other end.
 */
const DISCLOSURE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long one attempt may hold an inbound message before another may take it.
 *
 * Only reached when an invocation dies mid-flight: a transient failure releases its own claim
 * explicitly. Generous on purpose — taking a claim from a run that is still working is how the
 * same person gets answered twice, which is worse than being answered a few minutes late.
 * Matches `CLAIM_VISIBILITY_SECONDS` in src/jobs/runner.ts for the same reason.
 */
const REPLY_CLAIM_VISIBILITY_SECONDS = 300;

interface NormalizedDm {
    senderId: string;
    text: string;
    payload: string;
    isStoryMention: boolean;
    /** Meta's message id — the dedupe key. Null for events that carry none. */
    metaMessageId: string | null;
}

/**
 * Flatten the three shapes a messaging event arrives in (plain message, quick reply,
 * postback) into one. Returns null for events with nothing to reply to.
 */
function normalizeDm(event: any): NormalizedDm | null {
    const senderId = event?.sender?.id;

    let text: string = event?.message?.text || '';
    let payload = '';

    if (event?.message?.quick_reply) {
        payload = event.message.quick_reply.payload || '';
        log('debug', 'dm.quick_reply', { payload });
    }

    if (event?.postback) {
        text = event.postback.title || '';
        payload = event.postback.payload || '';
        log('debug', 'dm.postback', { payload });
    }

    let isStoryMention = false;
    if (Array.isArray(event?.message?.attachments)) {
        const storyMention = event.message.attachments.find((att: any) => att.type === 'story_mention');
        if (storyMention) {
            isStoryMention = true;
            log('debug', 'dm.story_mention', { sender_id: senderId });
        }
    }

    if (!senderId || (!text && !payload && !isStoryMention)) {
        // Reached by read watermarks, delivery receipts, reactions, referrals — and by a real
        // message whose only content is an attachment this pipeline cannot describe to Gemini
        // (an image, a voice note, a shared reel). The second case is a person waiting for an
        // answer, so it is logged with enough to tell the two apart.
        log('debug', 'dm.skipped_empty', {
            has_message: Boolean(event?.message),
            attachment_types: Array.isArray(event?.message?.attachments)
                ? event.message.attachments.map((att: any) => att?.type ?? 'unknown')
                : [],
            event_keys: event && typeof event === 'object' ? Object.keys(event) : [],
        });
        return null;
    }

    return {
        senderId,
        text,
        payload,
        isStoryMention,
        metaMessageId: event?.message?.mid ?? event?.postback?.mid ?? null,
    };
}

/**
 * Which endpoint the Send API call has to use.
 *
 * Meta requires `/{page-id}/messages` for Page access tokens; `/me/messages` only resolves
 * correctly for Instagram-Login tokens. The comment path has always threaded the Facebook
 * Page id through — the DM path never did, so every Facebook Messenger reply went to `/me`.
 * There is no `field === 'feed'` marker on a messaging event, so the signal is the page id
 * the event is addressed to.
 */
function resolveDmPageId(creator: Creator, addressedTo: (string | undefined)[]): string | undefined {
    if (!creator.facebook_page_id) return undefined;
    return addressedTo.some((id) => id && id === creator.facebook_page_id)
        ? creator.facebook_page_id
        : undefined;
}

function needsDisclosure(disclosedAt: string | Date | null | undefined): boolean {
    if (!disclosedAt) return true;
    const at = disclosedAt instanceof Date ? disclosedAt.getTime() : Date.parse(disclosedAt);
    if (Number.isNaN(at)) return true;
    return Date.now() - at > DISCLOSURE_MAX_AGE_MS;
}

export async function handleMessagingEvent(
    event: any,
    entryId: string,
    options: WebhookHandlerOptions = FINAL_ATTEMPT
): Promise<void> {
    const recipientId = event?.recipient?.id;

    // Ignore echo messages (sent by the page itself)
    if (event?.message?.is_echo) {
        log('debug', 'dm.skipped_echo');
        return;
    }

    const dm = normalizeDm(event);
    if (!dm) return;

    // The Meta message id is the dedupe key, so it is the field to correlate on: every line
    // below belongs to this one inbound message, retries included.
    return withLogContext({ mid: dm.metaMessageId, sender_id: dm.senderId }, () =>
        processDm(dm, event, recipientId, entryId, options)
    );
}

/** The inbound row, plus whether this attempt inherited it from a previous one. */
interface InboundClaim {
    id: string;
    resumed: boolean;
    attempts: number;
}

/**
 * Write down the inbound message and claim the right to answer it.
 *
 * `messages.meta_message_id UNIQUE` was carrying two meanings at once. It correctly stopped a
 * Meta redelivery from re-running a paid Gemini call and re-sending a DM to a real person — and
 * it also, unintentionally, stopped every *retry* from doing anything, because the row is
 * written before the AI call. So a transient Gemini 503 or a Meta blip meant: inbound row
 * saved, no reply sent, job marked done, and every subsequent attempt logging
 * `dm.duplicate_ignored` and returning successfully. The customer was never answered and
 * nothing anywhere said so. Four months of untested DM traffic would have surfaced this the
 * first time Gemini rate-limited a request.
 *
 * v14 splits the two meanings: the UNIQUE index still dedupes, and `handled_at` records
 * whether the pipeline ever reached a conclusion. `reply_claimed_at` is a visibility timeout
 * so that resuming cannot become two runs answering the same person at once.
 */
async function claimInbound(
    conversationId: string,
    creatorId: string,
    dm: NormalizedDm,
    event: any
): Promise<InboundClaim | null> {
    const inserted = await queryOne<Pick<MessageRow, 'id'>>(
        `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, payload,
                               raw_payload, meta_message_id, reply_claimed_at, reply_attempts)
         VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, NOW(), 1)
         ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
            conversationId,
            creatorId,
            dm.isStoryMention ? 'story_mention' : 'text',
            dm.text || (dm.isStoryMention ? '[Story Mention]' : ''),
            dm.payload || null,
            JSON.stringify(event),
            dm.metaMessageId,
        ]
    );
    if (inserted) return { id: inserted.id, resumed: false, attempts: 1 };

    // An event with no `mid` can never conflict (the unique index is partial), so reaching
    // here means there is a row with this mid already.
    const resumed = await queryOne<Pick<MessageRow, 'id' | 'reply_attempts'>>(
        `UPDATE messages
            SET reply_claimed_at = NOW(),
                reply_attempts = reply_attempts + 1
          WHERE meta_message_id = $1
            AND handled_at IS NULL
            AND (reply_claimed_at IS NULL OR reply_claimed_at < NOW() - make_interval(secs => $2))
      RETURNING id, reply_attempts`,
        [dm.metaMessageId, REPLY_CLAIM_VISIBILITY_SECONDS]
    );

    // No row means either the message was already handled — the redelivery case this index
    // exists for — or another attempt is holding a live claim on it right now. Both mean
    // "not ours to answer".
    if (!resumed) return null;

    return { id: resumed.id, resumed: true, attempts: resumed.reply_attempts };
}

/** Terminal: the pipeline reached a conclusion for this inbound message, good or bad. */
async function markHandled(messageId: string): Promise<void> {
    await queryCount(
        'UPDATE messages SET handled_at = NOW(), reply_claimed_at = NULL WHERE id = $1',
        [messageId]
    );
}

/**
 * Non-terminal: hand the message back so the next attempt can claim it immediately.
 *
 * Without this, a released message would wait out the whole visibility window before a retry
 * could touch it — and the job runner's first backoff is ~30 seconds, far shorter than that.
 * Releasing explicitly is what makes the retry actually reach the work.
 */
async function releaseInbound(messageId: string): Promise<void> {
    await queryCount(
        'UPDATE messages SET reply_claimed_at = NULL WHERE id = $1 AND handled_at IS NULL',
        [messageId]
    );
}

async function processDm(
    dm: NormalizedDm,
    event: any,
    recipientId: string | undefined,
    entryId: string,
    options: WebhookHandlerOptions
): Promise<void> {
    log('info', 'dm.received', { is_story_mention: dm.isStoryMention, has_payload: Boolean(dm.payload) });

    // Whether this attempt may leave work for another one.
    //
    // The `mid` is load-bearing and not decoration: it is the only thing that lets a second
    // attempt recognise the row the first one wrote. Without it the partial unique index never
    // fires, so a retry would insert a *second* inbound row for the same event and answer the
    // same person twice. An event with no `mid` therefore gets exactly one attempt, whatever
    // the job budget says.
    const mayRetry = Boolean(dm.metaMessageId) && !options.lastAttempt;

    // recipientId from message events = Instagram Business Account ID (most reliable)
    // entryId = could be IG ID (app-level sub) or FB Page ID (page-level sub)
    const creator = await getCreatorByPageId(recipientId, entryId);
    if (!creator) {
        log('warn', 'dm.no_creator', { recipient_id: recipientId, entry_id: entryId });
        return;
    }

    // 1. Fetch or create the conversation thread.
    //    One statement, not SELECT-then-INSERT: two DMs a second apart raced on the
    //    unique_creator_user constraint and the loser's duplicate-key error killed the batch.
    //    The DO UPDATE also replaces the separate last_message_at write.
    const conversation = await queryOne<Pick<ConversationRow, 'id' | 'is_bot_active' | 'ai_disclosed_at'>>(
        `INSERT INTO conversations (creator_id, instagram_user_id, status)
         VALUES ($1, $2, 'active')
         ON CONFLICT (creator_id, instagram_user_id)
         DO UPDATE SET last_message_at = NOW()
         RETURNING id, is_bot_active, ai_disclosed_at`,
        [creator.id, dm.senderId]
    );

    if (!conversation) {
        // An upsert with DO UPDATE always returns its row, so no row means the statement did
        // not do what this code assumes. Previously this read `convRes.rows[0].id` and threw
        // a TypeError three lines later, from a place that said nothing about the cause.
        log('error', 'dm.conversation_upsert_empty', { creator_id: creator.id });
        return;
    }
    const conversationId: string = conversation.id;

    // 2. Log the inbound message — and claim the right to answer it. See `claimInbound`.
    const claim = await claimInbound(conversationId, creator.id, dm, event);
    if (!claim) {
        log('info', 'dm.duplicate_ignored');
        return;
    }
    if (claim.resumed) {
        log('info', 'dm.resumed', { message_id: claim.id, reply_attempts: claim.attempts });
    }

    // 3. Call AI Agent to reply if Bot is active
    if (!conversation.is_bot_active) {
        log('info', 'dm.bot_paused', { conversation_id: conversationId });
        // Terminal, not a failure: the operator took this thread over deliberately, and a
        // retry must not decide later that the bot should have answered after all.
        await markHandled(claim.id);
        return;
    }

    try {
        // Query Gemini. Timed, because this is both the dominant marginal cost of the product
        // and the reason the webhook cannot finish inside Meta's timeout.
        const startedAt = Date.now();
        const aiRes = await generateAiResponse(conversationId, dm.text || dm.payload, creator.id);
        log('info', 'ai.replied', {
            creator_id: creator.id,
            duration_ms: Date.now() - startedAt,
            message_type: aiRes?.message_type ?? null,
        });

        // null means the creator's AI agent is switched off — a deliberate "say nothing",
        // not a failure. Every real failure throws, so there is nothing to paper over here.
        if (!aiRes) {
            log('info', 'ai.agent_disabled', { creator_id: creator.id });
            await markHandled(claim.id);
            return;
        }

        // Format Meta payload
        let metaMessagePayload: MetaMessagePayload = toMetaMessage(aiRes);

        // One quota check per reply, not per network call: a disclosure that has to travel as
        // its own message is still one logical reply to one person.
        const quota = await checkFairSendQuota(creator.id, 'dm');
        if (!quota.allowed) {
            // Meta throttles automated sends at roughly 200/hr, and the app-wide pool above
            // that is shared with every other tenant. Real customers are going unanswered
            // either way, so this is alert-worthy.
            log('error', 'dm.quota_exhausted', {
                creator_id: creator.id,
                count: quota.count,
                limit: quota.limit,
                blocked_by: quota.blockedBy,
                app_count: quota.app.count,
                app_limit: quota.app.limit,
                source: 'dm',
            });
            // Retried rather than dropped. The counters are hourly, so the runner's backoff
            // (~30s, ~2m, ~8m) may well spend every attempt inside the same window — but it
            // may not, and the alternative is a real customer silently never answered, which
            // is what happened before. Nothing else will come back for this message: the
            // queue's `dedupe_key` is `dm:<mid>`, so a later Meta redelivery of the same
            // message is refused at enqueue and never becomes a second job.
            if (mayRetry) {
                await releaseInbound(claim.id);
                throw new Error(
                    `Send quota exhausted (${quota.blockedBy}: ${quota.count}/${quota.limit}).`
                );
            }
            await markHandled(claim.id);
            return;
        }

        const pageId = resolveDmPageId(creator, [recipientId, entryId]);

        // Meta policy: disclose the automated service at the start of a thread, and again
        // after a long gap.
        const discloseNow = needsDisclosure(conversation.ai_disclosed_at);
        if (discloseNow) {
            const disclosure = applyDisclosure(metaMessagePayload);
            metaMessagePayload = disclosure.payload;
            if (disclosure.standalone) {
                log('info', 'dm.disclosure_standalone');
                await sendDirectMessage(
                    dm.senderId,
                    { text: disclosure.standalone },
                    creator.page_access_token,
                    pageId
                );
            }
        }

        // Send DM using Meta Send API
        await sendDirectMessage(dm.senderId, metaMessagePayload, creator.page_access_token, pageId);
        log('info', 'dm.sent', {
            creator_id: creator.id, message_type: aiRes.message_type, disclosed: discloseNow,
        });

        // Recorded only after a successful send, so a failed first reply still discloses next time.
        if (discloseNow) {
            await queryCount('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [conversationId]);
        }

        // Log outbound message
        await queryCount(
            `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload)
             VALUES ($1, $2, 'outbound', $3, $4, $5)`,
            [
                conversationId,
                creator.id,
                aiRes.message_type,
                metaMessagePayload.text || '[Structured Template]',
                JSON.stringify(metaMessagePayload),
            ]
        );

        // Last, so that a crash anywhere above leaves the message claimable again. Writing it
        // earlier would turn a failed send into a message nobody ever retries.
        await markHandled(claim.id);
    } catch (aiError: any) {
        log('error', 'dm.pipeline_failed', { creator_id: creator.id, ...describeError(aiError) });

        await noteMetaFailure(creator.id, aiError);

        // A Gemini rate limit, a Meta 500 and a socket reset are all transient — and all of
        // them used to end here, logged and swallowed, with the job marked done and the
        // inbound row permanently unanswerable. Re-raising lets the runner back off and try
        // again; releasing the claim is what lets that attempt reach the work.
        //
        // A permanent Meta error (dead token, recipient blocked DMs) is recorded as final
        // instead: retrying it is how an app attracts Meta's enforcement attention.
        const permanent = isPermanentMetaError(aiError);
        if (!permanent && mayRetry) {
            await releaseInbound(claim.id);
            throw aiError;
        }

        await markHandled(claim.id);
    }
}
