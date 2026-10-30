/**
 * What the sales turn reads and writes in Postgres (docs/DM_SALES_PLAN.md S6): the conversation's state between messages, whether a
 * message is still the one to answer, the history the model reads, and the one statement that records a turn.
 *
 * Plain SQL in one place, like `claimInbound` in the pipeline, so `turn.ts` is the decision and this is the bookkeeping. Every statement
 * is scoped to one conversation, and the writes to its tenant too.
 *
 * **A turn is recorded in ONE statement**: the bot's reply (`messages`, with its `ai_meta`) and the conversation's new state (`stage`,
 * the qualifier count, the link just sent, a pause) are written together or not at all. A turn that sent a link and then lost the write of
 * "a link was sent" would offer the same link again, and a state that moved without the reply it belongs to is a conversation that lies
 * about what was said. Written only after the send succeeded, so a failed send leaves the state as it was and the retry answers again.
 */
import { queryOne, queryRows } from '../../db/query.js';
import type { AiAgentRow, MessageRow } from '../../db/rows.js';
import { ATTACHMENT_ACK_TYPE, WORDLESS_MESSAGE_TYPES } from '../../webhook/attachments.js';
import { STAGES, type HandoffReason, type Intent, type Stage } from './types.js';

export interface SalesState {
    stage: Stage;
    qualifierTurns: number;
    abuseStrikes: number;
    offerId: string | null;
    /** The offers whose link this conversation has been sent. */
    offersLinked: string[];
    lastLinkAt: Date | null;
    optedOutAt: Date | null;
    /** The bot's own replies to this conversation in the last hour: the loop breaker's count. */
    aiRepliesLastHour: number;
}

const isStage = (value: unknown): value is Stage => typeof value === 'string' && (STAGES as readonly string[]).includes(value);

/** What a conversation that has never had a sales turn is: at the start, with nothing sent. */
export const FRESH_STATE: SalesState = {
    stage: 'new', qualifierTurns: 0, abuseStrikes: 0, offerId: null, offersLinked: [], lastLinkAt: null, optedOutAt: null, aiRepliesLastHour: 0,
};

interface StateRow {
    stage: string | null;
    qualifier_turns: number | null;
    abuse_strikes: number | null;
    offer_id: string | null;
    offers_linked: string[] | null;
    last_link_at: Date | null;
    opted_out_at: Date | null;
    ai_replies_last_hour: number | string | null;
}

/**
 * The conversation's sales state, and it stamps `last_inbound_at` (the person has just written) in the same statement: one round trip,
 * and the 24 h window the follow-up job reads (S9) is kept for exactly the conversations the sales turn answers. A conversation that is
 * not there reads as a fresh one.
 */
export async function loadSalesState(conversationId: string): Promise<SalesState> {
    const row = await queryOne<StateRow>(
        `UPDATE conversations
            SET last_inbound_at = NOW()
          WHERE id = $1
      RETURNING stage, qualifier_turns, abuse_strikes, offer_id, offers_linked, last_link_at, opted_out_at,
                (SELECT COUNT(*) FROM messages
                  WHERE conversation_id = $1 AND direction = 'outbound' AND sender = 'ai'
                    AND created_at > NOW() - INTERVAL '1 hour') AS ai_replies_last_hour`,
        [conversationId]
    );
    if (!row) return { ...FRESH_STATE };
    return {
        stage: isStage(row.stage) ? row.stage : 'new',
        qualifierTurns: Number(row.qualifier_turns ?? 0),
        abuseStrikes: Number(row.abuse_strikes ?? 0),
        offerId: row.offer_id ?? null,
        offersLinked: Array.isArray(row.offers_linked) ? row.offers_linked : [],
        lastLinkAt: row.last_link_at ?? null,
        optedOutAt: row.opted_out_at ?? null,
        aiRepliesLastHour: Number(row.ai_replies_last_hour ?? 0),
    };
}

/**
 * The moment a message became ready to be answered, as SQL for the table aliased `a`: its `created_at`, except for a word-less message Meta Muse has read
 * (`messages.perception` with status `ok`), which could not be answered until the read was stored, so it is `perception.stored_at`. `$3` is `WORDLESS_MESSAGE_TYPES`.
 * A text keeps its `created_at`, so for every message there ever was before perception this is exactly what the statement below compared.
 */
const READY_AT = (a: string): string => `CASE WHEN COALESCE(${a}.message_type, 'text') = ANY($3::text[]) AND ${a}.perception->>'status' = 'ok'
                           THEN COALESCE((${a}.perception->>'stored_at')::timestamptz, ${a}.created_at) ELSE ${a}.created_at END`;

/**
 * Is `messageId` no longer the message to answer? Two ways, both checked against the moment the message was ready to be answered (`READY_AT`: its own `created_at`,
 * or for a word-less message that was read, the moment its perception was stored):
 *
 *   - `newerUnhandled`: a LATER inbound message in the same conversation has not been answered yet. A burst of messages makes one job
 *     each; the newest answers all of them (the model reads the whole burst in its history), and this one stands down.
 *   - `answered`: somebody (this bot on an earlier attempt, a person from the inbox) has already replied after it. Answering again is a
 *     second reply to one message; it is what a job resumed after a crash between the send and the bookkeeping would do.
 *
 * **What has no words counts only once it has been read.** A photo (or any other word-less message, `webhook/attachments.ts`) used to be answered by a fixed
 * line from the kit (`webhook/attachmentAck.ts`), never by this turn. So a photo sent right after a question must not make the question's turn stand down as "a
 * later message is waiting" (nobody would answer the words), and an ack sent after a question (for a photo that came in meanwhile) must not make a retry of
 * that question look "already answered": the ack was not an answer to it. Both are read off `message_type`, the contract that `WORDLESS_MESSAGE_TYPES` and
 * `ATTACHMENT_ACK_TYPE` name. That is still so for a word-less message nobody read (every one with Meta Muse's switches off).
 *
 * With them on (src/services/perception), a word-less message whose perception was stored `ok` IS answered by a turn, so:
 *   - as a LATER message it counts as waiting, like a text, from the moment it was read, and not before: a photo still being read is not an answer to wait for.
 *     (A story mention is read too, but it is thanked and not answered, so it never makes a question stand down.)
 *   - as THIS message it stands down only for a reply sent after its perception was stored. A text sent while a reel was being read was answered while the reel was
 *     not yet readable, and that reply is not the reel's answer: the reel is answered unless a reply came after it was read.
 * Texts are compared on their `created_at` exactly as before, so the same statement answers the same for every conversation that holds no perception.
 */
export async function supersession(conversationId: string, messageId: string): Promise<{ newerUnhandled: boolean; answered: boolean }> {
    const row = await queryOne<{ newer_unhandled: boolean; answered: boolean }>(
        `WITH me AS (SELECT ${READY_AT('m')} AS ready_at FROM messages m WHERE m.id = $2)
         SELECT EXISTS (SELECT 1 FROM messages n
                         WHERE n.conversation_id = $1 AND n.direction = 'inbound' AND n.id <> $2 AND n.handled_at IS NULL
                           AND ${READY_AT('n')} > (SELECT ready_at FROM me)
                           AND (COALESCE(n.message_type, 'text') <> ALL($3::text[])
                                OR (n.perception->>'status' = 'ok' AND n.message_type <> 'story_mention'))) AS newer_unhandled,
                EXISTS (SELECT 1 FROM messages o
                         WHERE o.conversation_id = $1 AND o.direction = 'outbound'
                           AND o.created_at > (SELECT ready_at FROM me)
                           AND COALESCE(o.message_type, '') <> $4) AS answered`,
        [conversationId, messageId, WORDLESS_MESSAGE_TYPES, ATTACHMENT_ACK_TYPE]
    );
    return { newerUnhandled: row?.newer_unhandled === true, answered: row?.answered === true };
}

/**
 * The last `limit` messages of the conversation, oldest first: who wrote each, and what. The message being answered is among them.
 *
 * Two things a text row does not say, which the model has to see (`salesTurns` writes them into the turns):
 *   - `payload`: on an INBOUND row, the code of the quick reply a person tapped (`OTHER_COURSES`), while `text` is only the button's title;
 *   - `raw_payload`: on an OUTBOUND row, what was actually sent. A carousel or a row of buttons is stored with the placeholder text
 *     `[Structured Template]`, and its cards and buttons live only here. It is read for outbound rows ONLY: on an inbound row it is the whole
 *     Meta event, which nothing here needs and which is large.
 */
export type HistoryRow = Pick<MessageRow, 'direction' | 'text' | 'sender'> & { payload?: string | null; raw_payload?: unknown };

export async function loadHistory(conversationId: string, limit: number): Promise<HistoryRow[]> {
    const rows = await queryRows<HistoryRow>(
        `SELECT direction, text, sender, payload,
                CASE WHEN direction = 'outbound' THEN raw_payload END AS raw_payload
           FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [conversationId, limit]
    );
    return rows.reverse();
}

/** The agent row a sales turn needs: whether the bot is switched on, and the owner's persona and knowledge base (the fields `decideAgent` reads). */
export type SalesAgentRow = Pick<AiAgentRow, 'is_active' | 'system_prompt' | 'knowledge_base' | 'model' | 'temperature'>;

export async function loadAgent(creatorId: string): Promise<SalesAgentRow | null> {
    return queryOne<SalesAgentRow>(
        'SELECT is_active, system_prompt, knowledge_base, model, temperature FROM ai_agents WHERE creator_id = $1',
        [creatorId]
    );
}

/** What a turn leaves behind, in the conversation and, when something was sent, in `messages`. */
export interface TurnRecord {
    conversationId: string;
    creatorId: string;
    stage: Stage;
    qualifierTurns: number;
    abuseStrikes: number;
    /** What the person's message was; null leaves the last one. */
    intent: Intent | null;
    /** The offer in play after this turn; null leaves it. */
    offerId: string | null;
    /** The offer whose link was sent in this very reply; null when none was. */
    linkedOfferId: string | null;
    /** Pause the bot (`is_bot_active = false`): a hand-off, an opt-out, a second insult, a loop. */
    pauseBot: boolean;
    /** Why a person is needed; null leaves it. */
    handoffReason: HandoffReason | null;
    /** Stamp `handoff_at`: this turn handed the conversation to a person. */
    stampHandoff: boolean;
    /** They asked to be left alone: stamp `opted_out_at`. */
    optOut: boolean;
    /**
     * The A/B arm this turn ASSIGNS the conversation (S14, `variants.ts`): written only while the column is still NULL, in the same statement as the
     * reply, so an arm is never moved once given. Absent or null (every turn but the one that assigns, and every tenant with no experiment): the
     * statement is exactly what it was before the column existed, so a database that has not had v42 applied still records the turn.
     */
    variant?: string | null;
    /** The reply that went out. Null when nothing was sent (a pause, a stood-down message). */
    message: { type: string; text: string; payload: unknown; aiMeta: Record<string, unknown> } | null;
}

/** The state assignments, $1 the conversation and $2 its tenant, then these ten in this order. The arm (S14) comes after them: `setState`. */
const SET_STATE = `stage = $3, qualifier_turns = $4, abuse_strikes = $5,
               last_intent = COALESCE($6::text, last_intent),
               offer_id = COALESCE($7::text, offer_id),
               offers_linked = CASE WHEN $8::text IS NOT NULL AND NOT ($8::text = ANY(offers_linked)) THEN array_append(offers_linked, $8::text) ELSE offers_linked END,
               last_link_at = CASE WHEN $8::text IS NOT NULL THEN NOW() ELSE last_link_at END,
               is_bot_active = CASE WHEN $9::boolean THEN FALSE ELSE is_bot_active END,
               handoff_reason = COALESCE($10::text, handoff_reason),
               handoff_at = CASE WHEN $11::boolean THEN NOW() ELSE handoff_at END,
               opted_out_at = CASE WHEN $12::boolean THEN NOW() ELSE opted_out_at END`;

/** `SET_STATE` plus the arm, at parameter `$n`, only when there is one to write: `COALESCE` keeps an arm the conversation already has. */
const setState = (variantParam: number | null): string => (variantParam === null ? SET_STATE : `${SET_STATE},
               sales_variant = COALESCE(sales_variant, $${variantParam}::text)`);

/**
 * What the recording statement hands back, for the one thing that happens after a turn is recorded: a link was just sent, so the follow-up is
 * scheduled (`followupJob.ts`). `linkAt` is the database's own `last_link_at`, in the precision the later reads see it in; `replyId` is the message
 * row that carried the link. Both null when the statement matched no conversation (the state did not move, so no link was recorded).
 */
export interface RecordedTurn {
    linkAt: Date | null;
    replyId: string | null;
}

/** Record a turn: the reply and the new state in one statement (see the top of the file), or the state alone when nothing was sent. */
export async function recordTurn(record: TurnRecord): Promise<RecordedTurn> {
    const state = [
        record.stage, record.qualifierTurns, record.abuseStrikes, record.intent, record.offerId, record.linkedOfferId,
        record.pauseBot, record.handoffReason, record.stampHandoff, record.optOut,
    ];
    const { message } = record;
    const variant = record.variant ?? null;
    if (!message) {
        await queryRows(
            `UPDATE conversations SET ${setState(variant === null ? null : state.length + 3)} WHERE id = $1 AND creator_id = $2`,
            [record.conversationId, record.creatorId, ...state, ...(variant === null ? [] : [variant])]
        );
        return { linkAt: null, replyId: null };
    }
    // `sender = 'ai'` as the old path writes it: the inbox tags the bot's replies apart from the operator's own.
    const rows = await queryRows<RecordedRow & Record<string, unknown>>(
        `WITH reply AS (
             INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender, ai_meta)
             VALUES ($1, $2, 'outbound', $13, $14, $15::jsonb, 'ai', $16::jsonb)
             RETURNING id
         )
         UPDATE conversations SET ${setState(variant === null ? null : state.length + 7)} WHERE id = $1 AND creator_id = $2
         RETURNING last_link_at, (SELECT id FROM reply) AS reply_id`,
        [
            record.conversationId, record.creatorId, ...state, message.type, message.text, JSON.stringify(message.payload), JSON.stringify(message.aiMeta),
            ...(variant === null ? [] : [variant]),
        ]
    );
    return recordedOf(rows[0]);
}

interface RecordedRow {
    last_link_at: Date | null;
    reply_id: string | null;
}

function recordedOf(row: RecordedRow | undefined): RecordedTurn {
    return {
        linkAt: row?.last_link_at instanceof Date ? row.last_link_at : row?.last_link_at ? new Date(row.last_link_at) : null,
        replyId: typeof row?.reply_id === 'string' ? row.reply_id : null,
    };
}
