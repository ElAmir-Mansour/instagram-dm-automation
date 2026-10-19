/**
 * The bot's answer to a DM with no words in it (a photo, a voice note, a shared reel, a story mention: `attachments.ts`): ONE fixed line from
 * the language kit, never a model, in every `sales_mode`. "I can't open that here; if your question is written, I'll help" for anything the
 * bot cannot open, the thanks for a mention in a story, and nothing at all for a sticker (a thumbs-up is not a question).
 *
 * **It is an acknowledgement, never an answer.** Three things it must not do, and the claim statement below is what enforces them, in the
 * database and so across the jobs that make one DM each:
 *   - answer a photo that arrived while the customer's words are still being answered (the words get a real answer; "please type your
 *     question" to someone who just did is the one reply worse than silence): the second `NOT EXISTS`;
 *   - answer every photo of a burst: the first `NOT EXISTS` (a later message from them is waiting, so it is the one to answer, and the
 *     burst is acknowledged once, on its newest) and the third (it already asked within a day and they have written nothing since);
 *   - answer twice for one message when a job is retried or run twice: the claim is the INSERT itself, and a second attempt finds the first
 *     one's row.
 *
 * **The claim is the outbound row.** Written BEFORE the send, in one statement that inserts only when none of the three conditions holds
 * (`RETURNING id`: no row, no ack). The usual order in this app is send first and record after, so that a failed send leaves nothing behind;
 * here the row has to come first to be a claim at all, so a failed send deletes it again (a refused quota too), which is the same
 * guarantee the other way round. The one thing that can be left behind is the row of an ack that DID go out whose later bookkeeping failed,
 * and that row is exactly what stops a retry from sending it twice.
 *
 * What the caller (`answerDm`, messaging.ts) keeps: the paused-bot check before this, the inbound row's `markHandled` after it, and the
 * catch that decides what a thrown send error means (retry on a transient one, final on a permanent Meta error). The ack is never retried
 * for its own sake: a refused quota is `'quota'` and the message is handled.
 */
import { queryCount, queryOne } from '../db/query.js';
import { decideAgent } from '../services/ai.js';
import { loadAgent } from '../services/dmSales/store.js';
import { sendDirectMessage } from '../services/instagram.js';
import type { ProfileContext } from '../services/profile/context.js';
import { kitFor } from '../services/profile/kits.js';
import { checkFairSendQuota } from '../utils/rateLimiter.js';
import { describeError, log } from '../utils/log.js';
import { ATTACHMENT_ACK_TYPE, WORDLESS_MESSAGE_TYPES, type Wordless } from './attachments.js';
import { applyDisclosure, type MetaMessagePayload } from './meta-payload.js';

export interface WordlessAckInput {
    creator: { id: string; page_access_token: string };
    /** The Facebook Page id when the DM is a Messenger one; undefined for Instagram (the endpoint `me`). */
    pageId: string | undefined;
    conversation: { id: string };
    /** The word-less message being acknowledged: its row, and who sent it. */
    inbound: { id: string; senderId: string };
    wordless: Wordless;
    /** The profile's DM context: the language and register the line is written in. */
    ctx: ProfileContext<'dm'>;
    /** Whether the automated-service disclosure goes in front of the line, and its words (the pipeline's `needsDisclosure`): passed in, as for the sales turn. */
    disclosure: { needed: boolean; line: string };
}

/**
 * What happened, for the log and the tests; the caller handles the message whichever it is.
 *   sent       the line went out
 *   no_line    nothing to say for this kind (a sticker)
 *   agent_off  the owner's agent is switched off or unconfigured: it says nothing, as it always did
 *   skipped    the claim refused: a later message is waiting, words are still being answered, or it already asked
 *   quota      the hourly send quota is spent: nothing sent, and no retry for an acknowledgement
 */
export type WordlessAckResult = 'sent' | 'no_line' | 'agent_off' | 'skipped' | 'quota';

/**
 * Insert the ack's outbound row if, and only if, no later inbound message is waiting, no words are being answered, and it has not asked
 * already. `$7` is the inbound claim, `$8` the word-less `message_type`s (a row is word-less exactly when its type is one of them; `'text'`
 * stands for a row written before `message_type` existed). The 15 minutes bound "still being answered": an unhandled row older than that is
 * one a job abandoned, and must not silence the ack for ever. Explicit casts on the values only because the statement has no VALUES for
 * Postgres to take the types from. Exported so the WhatsApp acknowledgement (`whatsappMediaInput.ts`) claims with the SAME statement: the rules of "once per burst,
 * never over words, never twice in a day" are one text, not two that could drift.
 */
export const CLAIM_ACK = `INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender, ai_meta)
SELECT $1, $2, 'outbound', $3::text, $4::text, $5::jsonb, 'ai', $6::jsonb
 WHERE NOT EXISTS (  -- a later message from them is waiting: it is the one to answer (and a burst acks once, on its newest)
        SELECT 1 FROM messages n
         WHERE n.conversation_id = $1 AND n.direction = 'inbound' AND n.id <> $7
           AND n.created_at > (SELECT created_at FROM messages WHERE id = $7))
   AND NOT EXISTS (  -- words of theirs are still being answered: an ack would ask for what they already wrote
        SELECT 1 FROM messages w
         WHERE w.conversation_id = $1 AND w.direction = 'inbound' AND w.id <> $7 AND w.handled_at IS NULL
           AND w.created_at > NOW() - INTERVAL '15 minutes'
           AND COALESCE(w.message_type, 'text') <> ALL($8::text[]))
   AND NOT EXISTS (  -- already asked within a day, and they have written nothing since
        SELECT 1 FROM messages a
         WHERE a.conversation_id = $1 AND a.direction = 'outbound' AND a.message_type = $3
           AND a.created_at > NOW() - INTERVAL '24 hours'
           AND a.created_at > COALESCE((SELECT MAX(x.created_at) FROM messages x
                                         WHERE x.conversation_id = $1 AND x.direction = 'inbound'
                                           AND COALESCE(x.message_type, 'text') <> ALL($8::text[])), '-infinity'::timestamptz))
RETURNING id`;

export async function acknowledgeWordless(input: WordlessAckInput): Promise<WordlessAckResult> {
    const { creator, conversation, inbound, wordless, ctx } = input;
    const logBase = { creator_id: creator.id, conversation_id: conversation.id };

    // 1. The line. A sticker has none, and the row is still stored and handled by the caller.
    const lines = kitFor(ctx.language).attachments;
    const line = wordless.ack === 'mention' ? lines.mention : wordless.ack === 'media' ? lines.media : null;
    if (line === null) {
        log('info', 'dm.wordless_silent', { ...logBase, wordless_kind: wordless.kind });
        return 'no_line';
    }

    // 2. The agent. The owner's switch is honoured as `generateAiResponse` and the sales turn honour it: off or unconfigured, say nothing.
    const agentChoice = decideAgent(await loadAgent(creator.id), false, ctx.language.code);
    if (!agentChoice.speak) {
        log(agentChoice.reason === 'unconfigured' ? 'warn' : 'debug', `ai.${agentChoice.reason}`, { creator_id: creator.id });
        return 'agent_off';
    }

    // 3. The claim: the outbound row, first. What the bot said is `line` without the disclosure, as the sales path stores it.
    const claimed = await queryOne<{ id: string }>(CLAIM_ACK, [
        conversation.id,
        creator.id,
        ATTACHMENT_ACK_TYPE,
        line,
        JSON.stringify({ text: line }),
        JSON.stringify({ engine: 'rule', reply: ATTACHMENT_ACK_TYPE, kind: wordless.kind }),
        inbound.id,
        WORDLESS_MESSAGE_TYPES,
    ]);
    if (!claimed) {
        log('info', 'dm.wordless_ack_skipped', { ...logBase, wordless_kind: wordless.kind });
        return 'skipped';
    }

    /** Take the claim back: nothing went out, so nothing may say that something did. Best effort: a row left behind only silences the next ack. */
    const unclaim = async (): Promise<void> => {
        try {
            await queryCount('DELETE FROM messages WHERE id = $1', [claimed.id]);
        } catch (err) {
            log('error', 'dm.wordless_unclaim_failed', { ...logBase, message_id: claimed.id, ...describeError(err) });
        }
    };

    // 4. The same quota the reply paths use. Refused: no retry for an acknowledgement, the caller marks the message handled.
    let quota: Awaited<ReturnType<typeof checkFairSendQuota>>;
    try {
        quota = await checkFairSendQuota(creator.id, 'dm');
    } catch (err) {
        // A counter that cannot be read is a thrown error the caller retries: the claim must not stay behind to make that retry "already asked".
        await unclaim();
        throw err;
    }
    if (!quota.allowed) {
        log('error', 'dm.quota_exhausted', {
            creator_id: creator.id, count: quota.count, limit: quota.limit, blocked_by: quota.blockedBy,
            app_count: quota.app.count, app_limit: quota.app.limit, source: 'dm_ack',
        });
        await unclaim();
        return 'quota';
    }

    // 5. The disclosure exactly as the legacy path does it. A plain line always carries it as a prefix; the standalone branch is the
    //    helper's contract, handled so that it could never be dropped.
    let outgoing: MetaMessagePayload = { text: line };
    try {
        if (input.disclosure.needed) {
            const disclosed = applyDisclosure(outgoing, input.disclosure.line);
            outgoing = disclosed.payload;
            if (disclosed.standalone) {
                log('info', 'dm.disclosure_standalone', logBase);
                await sendDirectMessage(inbound.senderId, { text: disclosed.standalone }, creator.page_access_token, input.pageId);
            }
        }
        await sendDirectMessage(inbound.senderId, outgoing, creator.page_access_token, input.pageId);
    } catch (err) {
        // 6. Nothing went out: take the claim back, and let `answerDm`'s catch decide between a retry and a final answer.
        await unclaim();
        throw err;
    }
    log('info', 'dm.sent', { ...logBase, message_type: ATTACHMENT_ACK_TYPE, disclosed: input.disclosure.needed, wordless_kind: wordless.kind });

    // Recorded only after a successful send, so a failed first reply still discloses next time: the statement the other paths use.
    if (input.disclosure.needed) await queryCount('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [conversation.id]);
    return 'sent';
}
