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
 * Is `messageId` no longer the message to answer? Two ways, both checked against the row's own `created_at`:
 *
 *   - `newerUnhandled`: a LATER inbound message in the same conversation has not been answered yet. A burst of messages makes one job
 *     each; the newest answers all of them (the model reads the whole burst in its history), and this one stands down.
 *   - `answered`: somebody (this bot on an earlier attempt, a person from the inbox) has already replied after it. Answering again is a
 *     second reply to one message; it is what a job resumed after a crash between the send and the bookkeeping would do.
 */
export async function supersession(conversationId: string, messageId: string): Promise<{ newerUnhandled: boolean; answered: boolean }> {
    const row = await queryOne<{ newer_unhandled: boolean; answered: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM messages n
                         WHERE n.conversation_id = $1 AND n.direction = 'inbound' AND n.id <> $2 AND n.handled_at IS NULL
                           AND n.created_at > (SELECT created_at FROM messages WHERE id = $2)) AS newer_unhandled,
                EXISTS (SELECT 1 FROM messages o
                         WHERE o.conversation_id = $1 AND o.direction = 'outbound'
                           AND o.created_at > (SELECT created_at FROM messages WHERE id = $2)) AS answered`,
        [conversationId, messageId]
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
    /** The reply that went out. Null when nothing was sent (a pause, a stood-down message). */
    message: { type: string; text: string; payload: unknown; aiMeta: Record<string, unknown> } | null;
}

/** The state assignments, $1 the conversation and $2 its tenant, then these ten in this order. */
const SET_STATE = `stage = $3, qualifier_turns = $4, abuse_strikes = $5,
               last_intent = COALESCE($6::text, last_intent),
               offer_id = COALESCE($7::text, offer_id),
               offers_linked = CASE WHEN $8::text IS NOT NULL AND NOT ($8::text = ANY(offers_linked)) THEN array_append(offers_linked, $8::text) ELSE offers_linked END,
               last_link_at = CASE WHEN $8::text IS NOT NULL THEN NOW() ELSE last_link_at END,
               is_bot_active = CASE WHEN $9::boolean THEN FALSE ELSE is_bot_active END,
               handoff_reason = COALESCE($10::text, handoff_reason),
               handoff_at = CASE WHEN $11::boolean THEN NOW() ELSE handoff_at END,
               opted_out_at = CASE WHEN $12::boolean THEN NOW() ELSE opted_out_at END`;

/** Record a turn: the reply and the new state in one statement (see the top of the file), or the state alone when nothing was sent. */
export async function recordTurn(record: TurnRecord): Promise<void> {
    const state = [
        record.stage, record.qualifierTurns, record.abuseStrikes, record.intent, record.offerId, record.linkedOfferId,
        record.pauseBot, record.handoffReason, record.stampHandoff, record.optOut,
    ];
    const { message } = record;
    if (!message) {
        await queryRows(
            `UPDATE conversations SET ${SET_STATE} WHERE id = $1 AND creator_id = $2`,
            [record.conversationId, record.creatorId, ...state]
        );
        return;
    }
    // `sender = 'ai'` as the old path writes it: the inbox tags the bot's replies apart from the operator's own.
    await queryRows(
        `WITH reply AS (
             INSERT INTO messages (conversation_id, creator_id, direction, message_type, text, raw_payload, sender, ai_meta)
             VALUES ($1, $2, 'outbound', $13, $14, $15::jsonb, 'ai', $16::jsonb)
         )
         UPDATE conversations SET ${SET_STATE} WHERE id = $1 AND creator_id = $2`,
        [record.conversationId, record.creatorId, ...state, message.type, message.text, JSON.stringify(message.payload), JSON.stringify(message.aiMeta)]
    );
}
