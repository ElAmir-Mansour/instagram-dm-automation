/**
 * A reply that failed on its LAST attempt is a handoff (docs/DM_SALES_PLAN.md §6 "Model failure: never silence", S8), in every `sales_mode`.
 *
 * Found live on 2026-10-14: a DM got no reply at all. Gemini timed out or answered 503 on all three attempts of the job, the pipeline's
 * `catch` reached its last attempt with nothing left to retry, marked the message handled and sent nothing, so the customer was left
 * waiting for an answer that was never going to come, and nobody was told. Silence is the one outcome worse than an apology.
 *
 * What happens now, for a failure that is NOT a permanent Meta one (a blocked recipient, a dead token: those stay as they were, because
 * nothing can be sent to them and retrying them is how an app attracts Meta's enforcement attention):
 *
 *   1. The conversation is STAMPED, and NOT paused: `stage = 'handoff'`, `handoff_at`, `handoff_reason = 'unsure'`, and `is_bot_active` is left
 *      exactly as it was. A model that is down is an outage, not a customer who asked for a person, and a paused thread would sit there with
 *      nobody answering it (the owner may not even have an alert set up): the customer's NEXT message gets a normal bot reply. The stamp is
 *      what the inbox's "Needs you" reads, bot on or not (a sales handoff, which does pause the bot, is flagged by the same stamp).
 *      `conversations.handoff_reason` allows only unsure, refund, complaint, wants_human, hot_lead and abuse (migration v39), and `unsure` is
 *      the closest to "the assistant could not answer": it is what the sales turn records when its model fails (`turn.ts` `modelFailed`).
 *      The ALERT says what really happened (`engine_failed`). Done BEFORE the send, so the flag is there even if the line cannot go out.
 *   2. The customer is sent the handoff line ONCE: the profile's own (`dm.handoff.message`) or the language kit's (`lines.handoff`, "I have passed your message to {owner}…"), with
 *      the automated-service disclosure in front when it has not been given. One quota check, like every reply.
 *   3. The owner is told on every channel he switched on (Telegram and/or email), the same alert a handoff turn sends (`handoff.ts`).
 *
 * **It cannot loop.** This is the end of the last attempt: it never throws (every step is in its own try/catch and logs), the caller marks
 * the message handled after it whatever happened, and a line that cannot be sent is logged and let go.
 *
 * **It does not answer someone who has been answered.** A reply already sent for this message (by this attempt, or an earlier one that
 * recorded it), or a person's own reply from the inbox, means there is nothing to hand over.
 */
import { queryCount } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { checkFairSendQuota } from '../../utils/rateLimiter.js';
import { disclosureLine } from '../../webhook/meta-payload.js';
import { sendDirectMessage } from '../instagram.js';
import { profileContextOrLegacy, type ProfileContext } from '../profile/context.js';
import { kitFor } from '../profile/kits.js';
import { notifyOwner } from './handoff.js';
import { creatorName } from './prompt.js';
import { supersession } from './store.js';
import { capUtf8Bytes } from './text.js';
import { withDisclosure } from './turn.js';
import { MAX_REPLY_BYTES } from './types.js';

export interface FailureHandoffInput {
    creator: { id: string; page_access_token: string };
    /** The Facebook Page id for a Messenger DM; undefined for Instagram (the endpoint `me`). */
    pageId: string | undefined;
    conversationId: string;
    /** The inbound message that went unanswered. */
    inboundId: string;
    senderId: string;
    /** The DM context when the pipeline had already read it. Absent: it is read here, and a profile that cannot be read means no line can be spoken in the tenant's voice. */
    ctx: ProfileContext<'dm'> | null;
    /** The automated-service disclosure has not been given on this thread (or is a week old) and goes in front of this line. */
    disclosureNeeded: boolean;
    /** A reply to this very message was already sent by this attempt: the failure came after it, and the customer has been answered. */
    replied: boolean;
}

export type FailureHandoffOutcome =
    | 'handed_over'        // stamped (the bot stays on); `lineSent` says whether the customer got the line
    | 'already_answered';  // nothing to hand over

export interface FailureHandoffResult {
    outcome: FailureHandoffOutcome;
    /** The handoff line went out to the customer. */
    lineSent: boolean;
}

/** `handoff_reason` as the conversation records it: see the top of the file. */
export const FAILURE_HANDOFF_REASON = 'unsure';

/**
 * Stamp the handoff, in one statement, and NEVER touch `is_bot_active`: see the top of the file. Where it cannot be written (v39 is not
 * applied, a statement failed) it is logged and the customer still gets the line and the owner the alert.
 */
async function stamp(conversationId: string, creatorId: string): Promise<'stamped' | 'failed'> {
    try {
        await queryCount(
            `UPDATE conversations
                SET stage = 'handoff', handoff_at = NOW(), handoff_reason = $3
              WHERE id = $1 AND creator_id = $2`,
            [conversationId, creatorId, FAILURE_HANDOFF_REASON]
        );
        return 'stamped';
    } catch (err) {
        log('warn', 'dm.failure_handoff_stamp_failed', { conversation_id: conversationId, ...describeError(err) });
        return 'failed';
    }
}

/** The line as the bot's own outbound row, with the `ai_meta` the inbox reads; without `ai_meta` when the column is not there. */
async function recordLine(input: FailureHandoffInput, text: string): Promise<void> {
    const payload = JSON.stringify({ text });
    try {
        await queryCount(
            `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender, ai_meta)
             VALUES ($1, $2, 'outbound', 'text', $3, $4, 'ai', $5::jsonb)`,
            [input.conversationId, input.creator.id, text, payload, JSON.stringify({
                engine: 'rule', stage: 'handoff', next_action: 'handoff', handoff_reason: FAILURE_HANDOFF_REASON, failed: 'last_attempt',
            })]
        );
        return;
    } catch (err) {
        log('warn', 'dm.failure_handoff_ai_meta_failed', { conversation_id: input.conversationId, ...describeError(err) });
    }
    await queryCount(
        `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender)
         VALUES ($1, $2, 'outbound', 'text', $3, $4, 'ai')`,
        [input.conversationId, input.creator.id, text, payload]
    );
}

/**
 * Hand a conversation over after a reply failed for the last time. NEVER throws: see the top of the file.
 */
export async function handoffAfterFailure(input: FailureHandoffInput): Promise<FailureHandoffResult> {
    const logBase = { creator_id: input.creator.id, conversation_id: input.conversationId };
    try {
        if (input.replied) {
            log('info', 'dm.failure_handoff_skipped', { ...logBase, why: 'replied' });
            return { outcome: 'already_answered', lineSent: false };
        }
        // Somebody answered this message already: an earlier attempt that recorded its reply, or the owner from the inbox.
        try {
            if ((await supersession(input.conversationId, input.inboundId)).answered) {
                log('info', 'dm.failure_handoff_skipped', { ...logBase, why: 'already_answered' });
                return { outcome: 'already_answered', lineSent: false };
            }
        } catch (err) {
            log('warn', 'dm.failure_handoff_check_failed', { ...logBase, ...describeError(err) });
        }

        const written = await stamp(input.conversationId, input.creator.id);

        // The words of the customer's line are the tenant's, so they need the profile: the one the pipeline read, else one more try.
        let ctx = input.ctx;
        if (!ctx) {
            try {
                ctx = await profileContextOrLegacy(input.creator.id, 'dm');
            } catch (err) {
                log('warn', 'dm.failure_handoff_no_profile', { ...logBase, ...describeError(err) });
            }
        }

        let lineSent = false;
        if (ctx) {
            lineSent = await sendLine(input, ctx, logBase);
        }

        // The owner is told whether or not the line went out: that is exactly when somebody has to look.
        await notifyOwner({
            creatorId: input.creator.id, conversationId: input.conversationId,
            plan: { kind: 'handoff', reason: 'engine_failed' }, language: ctx?.language.code ?? 'ar',
        });

        log('error', 'dm.failure_handoff', { ...logBase, state: written, line_sent: lineSent, reason: FAILURE_HANDOFF_REASON });
        return { outcome: 'handed_over', lineSent };
    } catch (err) {
        // Whatever this was, the message is about to be marked handled by the caller: it must never be the reason it is not.
        log('error', 'dm.failure_handoff_error', { ...logBase, ...describeError(err) });
        return { outcome: 'handed_over', lineSent: false };
    }
}

/** The line to the customer: quota, disclosure, send, record. True when it was sent. Never throws. */
async function sendLine(input: FailureHandoffInput, ctx: ProfileContext<'dm'>, logBase: Record<string, unknown>): Promise<boolean> {
    try {
        const kit = kitFor(ctx.language).sales;
        const line = capUtf8Bytes(ctx.handoff?.message.trim() || kit.lines.handoff(creatorName(ctx, kit)), MAX_REPLY_BYTES);

        // One quota check for the reply, as every send path does. A line that would break the hourly limit is not sent.
        const quota = await checkFairSendQuota(input.creator.id, 'dm');
        if (!quota.allowed) {
            log('error', 'dm.quota_exhausted', { ...logBase, count: quota.count, limit: quota.limit, blocked_by: quota.blockedBy, source: 'dm', failure_handoff: true });
            return false;
        }

        let outgoing: { text: string } = { text: line };
        if (input.disclosureNeeded) {
            const disclosed = withDisclosure({ text: line }, disclosureLine(ctx.language.code));
            outgoing = { text: disclosed.payload.text ?? line };
            if (disclosed.standalone) {
                await sendDirectMessage(input.senderId, { text: disclosed.standalone }, input.creator.page_access_token, input.pageId);
            }
        }
        await sendDirectMessage(input.senderId, outgoing, input.creator.page_access_token, input.pageId);
        log('info', 'dm.sent', { ...logBase, message_type: 'text', disclosed: input.disclosureNeeded, failure_handoff: true });

        // Recorded only after the send landed (a failed send leaves the thread without a line it never got), each on its own so a
        // failure of one does not skip the other.
        if (input.disclosureNeeded) {
            try {
                await queryCount('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [input.conversationId]);
            } catch (err) {
                log('warn', 'dm.failure_handoff_disclosure_unrecorded', { ...logBase, ...describeError(err) });
            }
        }
        try {
            await recordLine(input, line);
        } catch (err) {
            log('warn', 'dm.failure_handoff_line_unrecorded', { ...logBase, ...describeError(err) });
        }
        return true;
    } catch (err) {
        // The send itself failed (or the quota read did): logged, and the customer is not tried again. A person has the flag and the alert.
        log('error', 'dm.failure_handoff_send_failed', { ...logBase, ...describeError(err) });
        return false;
    }
}
