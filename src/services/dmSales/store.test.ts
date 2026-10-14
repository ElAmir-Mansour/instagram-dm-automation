/**
 * What the sales turn reads and writes (`store.ts`): the state it keeps between messages, whether a message is still the one to answer, and
 * the one statement that records a turn.
 *
 * `pool.query` answers on the SQL it is handed and records it. What is pinned is the SHAPE of the statements and what is made of their rows:
 * a statement that dropped `AND creator_id = $2` would let a turn write into another tenant's conversation; one that wrote the reply and the
 * state separately could leave a link sent and not recorded, so the same link is offered twice.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { FRESH_STATE, loadAgent, loadHistory, loadSalesState, recordTurn, supersession, type TurnRecord } from './store.js';
import { STAGES } from './types.js';

let original: typeof pool.query;
let asked: { sql: string; params: any[] }[];

const answering = (rows: any[], rowCount = rows.length): void => {
    (pool as any).query = async (sql: string, params: any[] = []) => {
        asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        return { rows, rowCount };
    };
};

beforeEach(() => { original = pool.query; asked = []; });
afterEach(() => { (pool as any).query = original; });

describe('loadSalesState', () => {
    it('reads the state and stamps last_inbound_at in ONE statement, scoped to the conversation', async () => {
        answering([{
            stage: 'link', qualifier_turns: 2, abuse_strikes: 1, offer_id: 'plan', offers_linked: ['plan'], last_link_at: new Date('2026-10-14T08:00:00Z'),
            opted_out_at: null, ai_replies_last_hour: '3',
        }]);
        const state = await loadSalesState('conv-1');

        assert.equal(asked.length, 1);
        assert.match(asked[0]!.sql, /^UPDATE conversations SET last_inbound_at = NOW\(\) WHERE id = \$1 RETURNING stage, qualifier_turns, abuse_strikes, offer_id, offers_linked, last_link_at, opted_out_at,/);
        assert.match(asked[0]!.sql, /FROM messages WHERE conversation_id = \$1 AND direction = 'outbound' AND sender = 'ai' AND created_at > NOW\(\) - INTERVAL '1 hour'/);
        assert.deepEqual(asked[0]!.params, ['conv-1']);
        assert.deepEqual(state, {
            stage: 'link', qualifierTurns: 2, abuseStrikes: 1, offerId: 'plan', offersLinked: ['plan'], lastLinkAt: new Date('2026-10-14T08:00:00Z'),
            optedOutAt: null, aiRepliesLastHour: 3,
        });
    });

    it('reads a conversation that is not there as a fresh one, and a stage the code does not know as the start', async () => {
        answering([]);
        assert.deepEqual(await loadSalesState('gone'), FRESH_STATE);
        answering([{ stage: 'sold', qualifier_turns: null, abuse_strikes: null, offer_id: null, offers_linked: null, last_link_at: null, opted_out_at: null, ai_replies_last_hour: null }]);
        assert.deepEqual(await loadSalesState('conv-1'), FRESH_STATE);
    });

    it('knows every stage the flow has', async () => {
        for (const stage of STAGES) {
            answering([{ stage, qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0 }]);
            assert.equal((await loadSalesState('conv-1')).stage, stage);
        }
    });
});

describe('supersession', () => {
    it('compares with the message\'s own created_at: a later unhandled inbound, and any reply after it', async () => {
        answering([{ newer_unhandled: true, answered: false }]);
        assert.deepEqual(await supersession('conv-1', 'msg-1'), { newerUnhandled: true, answered: false });
        assert.deepEqual(asked[0]!.params, ['conv-1', 'msg-1']);
        assert.match(asked[0]!.sql, /n\.direction = 'inbound' AND n\.id <> \$2 AND n\.handled_at IS NULL AND n\.created_at > \(SELECT created_at FROM messages WHERE id = \$2\)/);
        assert.match(asked[0]!.sql, /o\.direction = 'outbound' AND o\.created_at > \(SELECT created_at FROM messages WHERE id = \$2\)/);
        assert.match(asked[0]!.sql, /n\.conversation_id = \$1/);
        assert.match(asked[0]!.sql, /o\.conversation_id = \$1/);
    });

    it('is neither when the database says nothing', async () => {
        answering([]);
        assert.deepEqual(await supersession('conv-1', 'msg-1'), { newerUnhandled: false, answered: false });
        answering([{ newer_unhandled: 'true', answered: 1 }]);
        assert.deepEqual(await supersession('conv-1', 'msg-1'), { newerUnhandled: false, answered: false }, 'only a real true counts');
    });
});

describe('loadHistory and loadAgent', () => {
    it('gives the last messages oldest first, from the newest-first query', async () => {
        answering([{ direction: 'outbound', text: 'b', sender: 'ai' }, { direction: 'inbound', text: 'a', sender: 'customer' }]);
        assert.deepEqual((await loadHistory('conv-1', 12)).map((r) => r.text), ['a', 'b']);
        assert.deepEqual(asked[0]!.params, ['conv-1', 12]);
        assert.match(asked[0]!.sql, /ORDER BY created_at DESC LIMIT \$2/);
    });

    it('reads what a stored row does not say: the tapped button\'s code, and what the bot actually sent (its own rows only, never an inbound event)', async () => {
        answering([]);
        await loadHistory('conv-1', 12);
        assert.match(asked[0]!.sql, /^SELECT direction, text, sender, payload, CASE WHEN direction = 'outbound' THEN raw_payload END AS raw_payload FROM messages WHERE conversation_id = \$1/);
    });

    it('reads the agent by its tenant: the switch, the persona and the knowledge base', async () => {
        answering([{ is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'm', temperature: 0.7 }]);
        assert.equal((await loadAgent('creator-1'))?.system_prompt, 'p');
        assert.deepEqual(asked[0]!.params, ['creator-1']);
        assert.match(asked[0]!.sql, /FROM ai_agents WHERE creator_id = \$1/);
    });
});

describe('recordTurn', () => {
    const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
        conversationId: 'conv-1', creatorId: 'creator-1', stage: 'link', qualifierTurns: 1, abuseStrikes: 0, intent: 'ready_to_buy', offerId: 'plan', linkedOfferId: 'plan',
        pauseBot: false, handoffReason: null, stampHandoff: false, optOut: false,
        message: { type: 'text', text: 'Here you go', payload: { text: 'Here you go' }, aiMeta: { engine: 'providers', intent: 'ready_to_buy' } }, ...over,
    });

    it('writes the reply and the new state in ONE statement, scoped to the conversation AND its tenant', async () => {
        answering([], 1);
        await recordTurn(turn());

        assert.equal(asked.length, 1, 'one statement, not two');
        const { sql, params } = asked[0]!;
        assert.match(sql, /^WITH reply AS \( INSERT INTO messages \(conversation_id, creator_id, direction, message_type, text, raw_payload, sender, ai_meta\) VALUES \(\$1, \$2, 'outbound', \$13, \$14, \$15::jsonb, 'ai', \$16::jsonb\) RETURNING id \) UPDATE conversations SET /);
        assert.match(sql, /WHERE id = \$1 AND creator_id = \$2 RETURNING last_link_at, \(SELECT id FROM reply\) AS reply_id$/);
        assert.deepEqual(params.slice(0, 12), ['conv-1', 'creator-1', 'link', 1, 0, 'ready_to_buy', 'plan', 'plan', false, null, false, false]);
        assert.deepEqual(params.slice(12, 14), ['text', 'Here you go']);
        assert.deepEqual(JSON.parse(params[14]), { text: 'Here you go' });
        assert.deepEqual(JSON.parse(params[15]), { engine: 'providers', intent: 'ready_to_buy' });
    });

    it('hands back what the follow-up needs from the very statement that recorded the link: the database\'s own link time and the reply row\'s id', async () => {
        const linkAt = new Date('2026-10-14T09:00:00.123Z');
        answering([{ last_link_at: linkAt, reply_id: 'msg-9' }], 1);
        assert.deepEqual(await recordTurn(turn()), { linkAt, replyId: 'msg-9' });
        // A statement that matched no conversation (a wrong tenant) records nothing, and says so: there is no link to follow up.
        answering([], 0);
        assert.deepEqual(await recordTurn(turn()), { linkAt: null, replyId: null });
        // Nothing sent: nothing to hand back.
        answering([], 1);
        assert.deepEqual(await recordTurn(turn({ message: null, linkedOfferId: null })), { linkAt: null, replyId: null });
    });

    it('the state assignments keep what the turn did not name: an intent, an offer, a hand-off reason are only replaced when there is one', async () => {
        answering([], 1);
        await recordTurn(turn());
        const { sql } = asked[0]!;
        assert.match(sql, /last_intent = COALESCE\(\$6::text, last_intent\)/);
        assert.match(sql, /offer_id = COALESCE\(\$7::text, offer_id\)/);
        assert.match(sql, /handoff_reason = COALESCE\(\$10::text, handoff_reason\)/);
        assert.match(sql, /offers_linked = CASE WHEN \$8::text IS NOT NULL AND NOT \(\$8::text = ANY\(offers_linked\)\) THEN array_append\(offers_linked, \$8::text\) ELSE offers_linked END/, 'a link is added once');
        assert.match(sql, /last_link_at = CASE WHEN \$8::text IS NOT NULL THEN NOW\(\) ELSE last_link_at END/);
        assert.match(sql, /is_bot_active = CASE WHEN \$9::boolean THEN FALSE ELSE is_bot_active END/, 'a pause is never an un-pause');
        assert.match(sql, /handoff_at = CASE WHEN \$11::boolean THEN NOW\(\) ELSE handoff_at END/);
        assert.match(sql, /opted_out_at = CASE WHEN \$12::boolean THEN NOW\(\) ELSE opted_out_at END/);
    });

    it('writes the state alone, still scoped to the tenant, when nothing was sent', async () => {
        answering([], 1);
        await recordTurn(turn({ message: null, pauseBot: true, stage: 'closed', handoffReason: 'abuse', linkedOfferId: null }));

        assert.equal(asked.length, 1);
        assert.match(asked[0]!.sql, /^UPDATE conversations SET stage = \$3,/);
        assert.match(asked[0]!.sql, /WHERE id = \$1 AND creator_id = \$2$/);
        assert.ok(!/INSERT INTO messages/.test(asked[0]!.sql));
        assert.equal(asked[0]!.params.length, 12);
        assert.deepEqual(asked[0]!.params.slice(2), ['closed', 1, 0, 'ready_to_buy', 'plan', null, true, 'abuse', false, false]);
    });
});
