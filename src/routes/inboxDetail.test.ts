/**
 * The inbox's detail view, server side: the list's preview and profile fields, the message log's extras, and the profile refresh.
 *
 * Every handler is pulled off the router's own stack and run against a stubbed `pool.query` and `metaHttp.get`, like
 * inboxAnalytics.test.ts. What is asserted is the SQL each one sends (the tenant filter, the bound parameters), the shape it answers
 * with, and what it does when a part of that is not available. Nothing here reaches Postgres or Meta.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import apiRouter, { conversationsQuery } from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const originalGet = metaHttp.get;
let graphCalls: Array<{ url: string; config: any }> = [];
let onGraph: (url: string, config: any) => Promise<any>;
beforeEach(() => {
    graphCalls = [];
    onGraph = async (url) => { throw new Error(`no GET was arranged for ${url}`); };
    (metaHttp as any).get = (url: string, config: any) => { graphCalls.push({ url, config }); return onGraph(url, config); };
});
afterEach(() => { (metaHttp as any).get = originalGet; });

function handlerFor(method: string, path: string) {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return { last: layer!.route!.stack[layer!.route!.stack.length - 1]!.handle, all: layer!.route!.stack.map((s) => s.handle) };
}

interface Sent { sql: string; params: unknown[] }

async function call(
    method: string, path: string,
    req: { query?: Record<string, unknown>; params?: Record<string, string>; body?: unknown },
    answer: (sql: string, params: unknown[]) => { rows: unknown[] } | Error = () => ({ rows: [] }),
) {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
    const sent: Sent[] = [];
    const original = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const out = answer(sql, params);
        if (out instanceof Error) throw out;
        return { ...out, rowCount: out.rows.length };
    };
    try {
        await handlerFor(method, path).last(
            { query: {}, params: {}, body: {}, ...req, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, headers: {} },
            res,
            () => {}
        );
    } finally {
        (pool as unknown as { query: unknown }).query = original;
    }
    return { res, sent };
}

// ─── GET /conversations ──────────────────────────────────────────────────────────────────────
describe('GET /conversations — the preview and the profile', () => {
    it('reads the newest message once and lifts the cards out of its JSON, as paths and not the whole body', () => {
        const sql = conversationsQuery('c.creator_id = $1', 2, 3).replace(/\s+/g, ' ');
        assert.match(sql, /LEFT JOIN LATERAL \( SELECT m\.text, m\.direction, m\.message_type,/);
        assert.match(sql, /jsonb_typeof\(m\.raw_payload #> '\{attachment,payload,elements\}'\) = 'array'/);
        assert.match(sql, /jsonb_array_length\(m\.raw_payload #> '\{attachment,payload,elements\}'\) END AS cards/);
        assert.match(sql, /m\.raw_payload #>> '\{attachment,payload,elements,0,title\}' AS card_title/);
        assert.match(sql, /ORDER BY m\.created_at DESC LIMIT 1/);
        assert.match(sql, /lm\.cards AS last_message_cards/);
        assert.match(sql, /lm\.card_title AS last_message_card_title/);
        assert.match(sql, /lm\.message_type AS last_message_type/);
        assert.match(sql, /lm\.text AS last_message_text/);
        assert.match(sql, /lm\.direction AS last_message_direction/);
        assert.ok(!/SELECT c\.\*, lm\.raw_payload|, m\.raw_payload,/.test(sql), 'an inbound row’s raw_payload is the whole Meta event: never carried out of the lateral');
    });

    it('counts the thread’s messages for the header, and the paging parameters stay where they were', () => {
        const sql = conversationsQuery('c.creator_id = $1 AND (x)', 4, 5).replace(/\s+/g, ' ');
        assert.match(sql, /SELECT COUNT\(m2\.id\)::int AS n FROM messages m2 WHERE m2\.conversation_id = c\.id/);
        assert.match(sql, /mc\.n AS message_count/);
        assert.match(sql, /WHERE c\.creator_id = \$1 AND \(x\) ORDER BY c\.last_message_at DESC LIMIT \$4 OFFSET \$5$/);
        assert.ok(!/COUNT\(\*\)/.test(sql));
    });

    it('answers every thread in one shape: the profile typed (null before v40), the preview fields, the count', async () => {
        const { res, sent } = await call('get', '/conversations', { query: {} }, (sql) => (
            /SELECT COUNT\(\*\)::int as total/.test(sql)
                ? { rows: [{ total: 3 }] }
                : { rows: [
                    {
                        id: 'a', platform: 'instagram', username: 'sam_dev', profile_name: 'Sam Dev', profile_pic_url: 'https://cdn.example.test/s.jpg',
                        follower_count: 4200, is_user_follow_business: true, is_business_follow_user: false, is_verified_user: false,
                        profile_fetched_at: '2026-10-14T09:00:00Z', created_at: '2026-03-04T09:30:00Z',
                        last_message_text: '[Structured Template]', last_message_direction: 'outbound', last_message_type: 'carousel',
                        last_message_cards: 2, last_message_card_title: 'Prompt engineering', message_count: 27,
                    },
                    { id: 'b', platform: 'facebook', username: null, profile_pic_url: 'javascript:alert(1)', last_message_text: 'hi', last_message_direction: 'inbound' },
                    { id: 'c' },   // a database without v26 or v40
                ] }
        ));
        assert.equal(res.statusCode, 200);
        const [a, b, c] = res.body.data;
        assert.equal(a.profile_name, 'Sam Dev');
        assert.equal(a.profile_pic_url, 'https://cdn.example.test/s.jpg');
        assert.equal(a.follower_count, 4200);
        assert.equal(a.is_user_follow_business, true);
        assert.equal(a.is_business_follow_user, false, 'false survives: it is an answer');
        assert.equal(a.last_message_cards, 2);
        assert.equal(a.last_message_card_title, 'Prompt engineering');
        assert.equal(a.message_count, 27);
        assert.equal(a.created_at, '2026-03-04T09:30:00Z', 'the first-message date is the row’s own');
        assert.equal(b.profile_pic_url, null, 'a picture that is not http(s) is not sent to the page');
        assert.equal(b.platform, 'facebook');
        for (const key of ['profile_name', 'profile_pic_url', 'follower_count', 'is_user_follow_business', 'is_verified_user', 'last_message_cards', 'message_count', 'last_message_type']) {
            assert.equal(c[key], null, `${key} is null, not absent, on a database without the migrations`);
        }
        assert.equal(c.platform, null);
        // Tenant-scoped, as before.
        assert.deepEqual(sent[0]!.params, [TENANT, 20, 0]);
    });

    it('searches the name on the profile as well as the handle and the id', async () => {
        const { sent } = await call('get', '/conversations', { query: { search: ' sam ' } }, (sql) => (
            /COUNT\(\*\)/.test(sql) ? { rows: [{ total: 1 }] } : { rows: [{ id: 'a' }] }
        ));
        assert.match(sent[0]!.sql, /c\.username ILIKE \$2 OR c\.instagram_user_id ILIKE \$2 OR c\.profile_name ILIKE \$2/);
        assert.deepEqual(sent[0]!.params, [TENANT, '%sam%', 20, 0]);
    });

    it('a search on a database without v40 (no `profile_name` column) is asked again without it, and answers', async () => {
        let first = true;
        const { res, sent } = await call('get', '/conversations', { query: { search: 'sam' } }, (sql) => {
            if (first && /profile_name ILIKE/.test(sql)) {
                first = false;
                return Object.assign(new Error('column c.profile_name does not exist'), { code: '42703' });
            }
            return /COUNT\(\*\)/.test(sql) ? { rows: [{ total: 1 }] } : { rows: [{ id: 'a', username: 'sam_dev' }] };
        });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.data[0].id, 'a');
        const asked = sent.filter((s) => /FROM conversations c/.test(s.sql) && !/COUNT\(\*\)/.test(s.sql));
        assert.equal(asked.length, 2);
        assert.ok(/profile_name ILIKE/.test(asked[0]!.sql) && !/profile_name/.test(asked[1]!.sql.replace(/c\.\*/, '')));
    });

    it('any other failure is still a 500, with and without a search', async () => {
        for (const query of [{ search: 'sam' }, {}]) {
            const { res } = await call('get', '/conversations', { query }, () => Object.assign(new Error('connection terminated'), { code: '57P01' }));
            assert.equal(res.statusCode, 500);
        }
        const { res, sent } = await call('get', '/conversations', { query: {} }, () => Object.assign(new Error('x'), { code: '42703' }));
        assert.equal(res.statusCode, 500, 'a missing column with NO search is not retried: the list reads c.* and cannot hit it');
        assert.equal(sent.length, 1);
    });
});

// ─── GET /conversations/:id/messages ─────────────────────────────────────────────────────────
describe('GET /conversations/:id/messages — the AI’s model and a failing reply', () => {
    // Newest first, as the query orders them; the route reverses.
    const stored = [
        { id: 'a1', direction: 'outbound', sender: 'ai', text: '[Structured Template]', message_type: 'carousel', meta_message_id: null,
          raw_payload: { attachment: { payload: { elements: [{ title: 'Prompt engineering' }] } } }, created_at: '2026-10-14T10:00:06Z' },
        { id: 'q1', direction: 'inbound', sender: 'customer', text: 'prices?', payload: 'PRICE', meta_message_id: 'mid-1',
          raw_payload: { postback: { payload: 'PRICE' } }, reply_attempts: 2, handled_at: '2026-10-14T10:00:06Z', created_at: '2026-10-14T10:00:00Z' },
    ];

    const answer = (over: { usage?: unknown[] | Error; agent?: unknown[] | Error; jobs?: unknown[] | Error } = {}) => (sql: string) => {
        const pick = (v: unknown[] | Error | undefined, dflt: unknown[]) => (v instanceof Error ? v : { rows: v ?? dflt });
        if (/SELECT 1 FROM conversations/.test(sql)) return { rows: [{ '?column?': 1 }] };
        // A copy: the route reverses what it is handed, in place, and the fixture is shared by every test in this block.
        if (/FROM messages WHERE conversation_id/.test(sql)) return { rows: [...stored] };
        if (/JOIN ai_usage/.test(sql)) return pick(over.usage, [{ message_id: 'a1', model: 'claude-sonnet-5-5', provider: 'anthropic' }]);
        if (/FROM ai_agents/.test(sql)) return pick(over.agent, [{ model: 'gemini-2.5-flash' }]);
        if (/FROM jobs/.test(sql)) return pick(over.jobs, [{ dedupe_key: 'dm:mid-1', status: 'failed', attempts: 3, max_attempts: 3, last_error: 'DM Send Failed: x (Code: 10903)' }]);
        return new Error(`no result arranged for SQL: ${sql}`);
    };

    it('keeps the log as it was (oldest first, the JSONB payloads as objects) and adds `ai` and `delivery`', async () => {
        const { res } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, answer());
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.map((r: any) => r.id), ['q1', 'a1']);
        const [q, a] = res.body;
        assert.deepEqual(a.ai, { model: 'claude-sonnet-5-5', provider: 'anthropic', source: 'usage' });
        assert.equal(q.ai, null);
        assert.deepEqual(q.delivery, { state: 'failed', code: 10903, attempts: 3, max_attempts: 3 });
        assert.equal(a.delivery, null);
        assert.equal(typeof a.raw_payload, 'object', 'the carousel the page draws is the object the column holds');
        assert.equal(q.reply_attempts, 2);
        assert.equal(q.handled_at, '2026-10-14T10:00:06Z', 'what the page pairs a reply to its message by');
        assert.equal(q.payload, 'PRICE');
    });

    it('names the agent’s model, marked as that, when no usage row matched the reply', async () => {
        const { res } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, answer({ usage: [] }));
        assert.deepEqual(res.body[1].ai, { model: 'gemini-2.5-flash', provider: null, source: 'agent' });
    });

    it('is the log, unannotated, when every extra fails: the list is never held hostage', async () => {
        const down = new Error('relation does not exist');
        const { res } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, answer({ usage: down, agent: down, jobs: down }));
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.map((r: any) => [r.id, r.ai, r.delivery]), [['q1', null, null], ['a1', null, null]]);
    });

    it('scopes the usage lookup to this tenant and the queue lookup to this conversation’s own message ids', async () => {
        const { sent } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, answer());
        const usage = sent.find((s) => /JOIN ai_usage/.test(s.sql))!;
        assert.equal(usage.params[1], TENANT);
        assert.deepEqual(usage.params[0], ['a1']);
        const jobs = sent.find((s) => /FROM jobs/.test(s.sql))!;
        assert.deepEqual(jobs.params, [['dm:mid-1']]);
    });

    it('still refuses another tenant’s conversation before reading anything else', async () => {
        const { res, sent } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, (sql) => (/SELECT 1 FROM conversations/.test(sql) ? { rows: [] } : new Error('read past the ownership check')));
        assert.equal(res.statusCode, 404);
        assert.equal(sent.length, 1);
    });
});

// ─── GET /conversations/:id/messages — what Meta Muse saw, and why it answered (docs/specs/005-muse-sees T039) ───────────────────────────
describe('GET /conversations/:id/messages — the perception and the decision trace ride with the rows', () => {
    // What the pipeline stores (migration v60 `messages.perception`; v39 `ai_meta`, to which the turn adds `reason`, `perceived` and `recalled`), as `pg` hands JSONB back: objects.
    const perception = {
        v: 1, kind: 'reel', status: 'ok', seen: 'A 37-second reel showing a Python decorator.', transcript: '', about_owner: 'own_content', confidence: 0.92,
        model: 'muse-spark-1.3', stored_at: '2026-10-30T10:00:05.000Z', ms: 8200, usd: 0.021,
    };
    const unreadable = { v: 1, kind: 'image', status: 'unreadable', reason: 'low_confidence', model: 'muse-spark-1.3', stored_at: '2026-10-30T11:00:05.000Z', ms: 3000, usd: 0.004 };
    const meta = { engine: 'providers', intent: 'info', stage: 'recommend', next_action: 'recommend', perceived: true, recalled: false, reason: 'The reel is about decorators, which the Python guide covers.' };
    // Newest first, as the query orders them; the route reverses.
    const stored = () => [
        { id: 'a1', direction: 'outbound', sender: 'ai', text: 'ده بيشرح الـ decorators', message_type: 'text', meta_message_id: null, ai_meta: meta, perception: null, created_at: '2026-10-30T10:00:12Z' },
        { id: 'p2', direction: 'inbound', sender: 'customer', text: '[photo]', message_type: 'image', meta_message_id: 'mid-2', ai_meta: null, perception: unreadable, created_at: '2026-10-30T11:00:00Z' },
        { id: 'q1', direction: 'inbound', sender: 'customer', text: '[shared reel] A 37-second reel showing a Python decorator.', message_type: 'reel', meta_message_id: 'mid-1', ai_meta: null, perception, created_at: '2026-10-30T10:00:00Z' },
        { id: 't0', direction: 'inbound', sender: 'customer', text: 'hello', message_type: 'text', meta_message_id: 'mid-0', ai_meta: null, perception: null, created_at: '2026-10-30T09:00:00Z' },
    ];
    const answer = (sql: string) => {
        if (/SELECT 1 FROM conversations/.test(sql)) return { rows: [{ '?column?': 1 }] };
        if (/FROM messages WHERE conversation_id/.test(sql)) return { rows: stored() };
        return { rows: [] };
    };

    it('reads the whole row, so the column v60 added comes back with it and the route has no list of columns to forget', async () => {
        const { sent } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, answer);
        const read = sent.find((s) => /FROM messages WHERE conversation_id/.test(s.sql))!;
        assert.match(read.sql, /^SELECT \* FROM messages WHERE conversation_id = \$1 ORDER BY created_at DESC LIMIT 100$/);
        assert.deepEqual(read.params, [CONV]);
    });

    it('answers `perception` on the customer\'s messages and `ai_meta` on the reply as the objects the pipeline stored, untouched, oldest first', async () => {
        const { res } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, answer);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.map((r: any) => r.id), ['t0', 'q1', 'p2', 'a1']);
        const byId = new Map(res.body.map((r: any) => [r.id, r]));
        assert.deepEqual((byId.get('q1') as any).perception, perception, 'what was understood, field for field');
        assert.equal(typeof (byId.get('q1') as any).perception, 'object', 'an object, not a string the page has to parse');
        assert.deepEqual((byId.get('p2') as any).perception, unreadable, 'and an honest failure is a row\'s too');
        assert.equal((byId.get('t0') as any).perception, null, 'a message perception never ran for is null');
        assert.deepEqual((byId.get('a1') as any).ai_meta, meta, 'the decision: the action, the reason and the flags');
        assert.equal((byId.get('a1') as any).ai_meta.perceived, true);
        assert.equal((byId.get('a1') as any).ai_meta.reason, meta.reason);
    });

    it('answers the readable text the pipeline stored beside it, so the page can tell a description from words the customer wrote', async () => {
        const { res } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, answer);
        const reel = res.body.find((r: any) => r.id === 'q1');
        assert.equal(reel.message_type, 'reel');
        assert.match(reel.text, /^\[shared reel\] A 37-second reel/);
        assert.equal(res.body.find((r: any) => r.id === 't0').text, 'hello');
    });

    it('gives a row from before v60 (no column at all) back as it is, and the page reads that as "perception never ran"', async () => {
        const { res } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, (sql) => (
            /SELECT 1 FROM conversations/.test(sql)
                ? { rows: [{ '?column?': 1 }] }
                : { rows: [{ id: 'old', direction: 'inbound', sender: 'customer', text: '[photo]', message_type: 'image', meta_message_id: null, created_at: '2026-10-01T09:00:00Z' }] }
        ));
        assert.equal(res.statusCode, 200);
        assert.equal('perception' in res.body[0], false);
    });
});

// ─── POST /conversations/:id/refresh-profile ─────────────────────────────────────────────────
describe('POST /conversations/:id/refresh-profile — the lazy backfill', () => {
    const THREAD = { id: CONV, instagram_user_id: '17841400003051', platform: 'instagram', page_access_token: 'EAAGplain' };

    const answer = (over: { thread?: Record<string, unknown> | null; claim?: boolean; store?: Error } = {}) => (sql: string) => {
        if (/FROM conversations c JOIN creators cr/.test(sql.replace(/\s+/g, ' '))) {
            const thread = over.thread === undefined ? THREAD : over.thread;
            return { rows: thread ? [thread] : [] };
        }
        if (/SET profile_checked_at = NOW\(\)/.test(sql)) return { rows: over.claim === false ? [] : [{ id: CONV }] };
        if (/profile_fetched_at = NOW\(\)/.test(sql)) {
            return over.store ?? { rows: [{
                username: 'sam_dev', profile_name: 'Sam Dev', profile_pic_url: 'https://cdn.example.test/s.jpg', follower_count: 4200,
                is_user_follow_business: true, is_business_follow_user: false, is_verified_user: false,
                profile_fetched_at: '2026-10-14T10:00:00Z', profile_checked_at: '2026-10-14T10:00:00Z',
            }] };
        }
        return new Error(`no result arranged for SQL: ${sql}`);
    };
    const meta = () => ({ data: { name: 'Sam Dev', username: 'sam_dev', profile_pic: 'https://cdn.example.test/s.jpg', follower_count: 4200 } });

    it('is an operator’s action, behind the same role gate as every other thing the inbox sends', () => {
        const { all } = handlerFor('post', '/conversations/:id/refresh-profile');
        assert.equal(all.length, 2, 'the role gate, then the handler');
    });

    it('looks the sender up with the tenant’s own token and answers the stored profile', async () => {
        onGraph = async () => meta();
        const { res, sent } = await call('post', '/conversations/:id/refresh-profile', { params: { id: CONV } }, answer());
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.refreshed, true);
        assert.equal(res.body.reason, 'refreshed');
        assert.equal(res.body.profile.profile_name, 'Sam Dev');
        assert.equal(res.body.profile.follower_count, 4200);
        assert.equal(graphCalls.length, 1);
        assert.match(graphCalls[0]!.url, /\/17841400003051$/);
        assert.equal(graphCalls[0]!.config.headers.Authorization, 'Bearer EAAGplain');
        // The conversation is read scoped to the tenant, so another tenant's thread is a 404 and not a lookup with its token.
        assert.deepEqual(sent[0]!.params, [CONV, TENANT]);
        assert.match(sent[0]!.sql, /c\.id = \$1 AND c\.creator_id = \$2/);
    });

    it('does not call Meta when the throttle says the sender was looked up recently', async () => {
        const { res } = await call('post', '/conversations/:id/refresh-profile', { params: { id: CONV } }, answer({ claim: false }));
        assert.equal(res.statusCode, 200);
        assert.deepEqual({ refreshed: res.body.refreshed, reason: res.body.reason }, { refreshed: false, reason: 'throttled' });
        assert.equal(res.body.profile, undefined);
        assert.equal(graphCalls.length, 0);
    });

    it('a lookup Meta refuses is a 200 that says it did not refresh, never a 500 and never a throw', async () => {
        onGraph = async () => { throw Object.assign(new Error('refused'), { response: { status: 400, data: { error: { code: 230, message: 'User consent is required' } } } }); };
        const { res } = await call('post', '/conversations/:id/refresh-profile', { params: { id: CONV } }, answer());
        assert.equal(res.statusCode, 200);
        assert.deepEqual({ refreshed: res.body.refreshed, reason: res.body.reason }, { refreshed: false, reason: 'failed' });
    });

    it('is Instagram only, and says "skipped" for a Messenger thread, an unattributed one, or a tenant with no Meta connection', async () => {
        for (const thread of [{ ...THREAD, platform: 'facebook' }, { ...THREAD, platform: null }, { ...THREAD, page_access_token: null }]) {
            const { res, sent } = await call('post', '/conversations/:id/refresh-profile', { params: { id: CONV } }, answer({ thread }));
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.reason, 'skipped', JSON.stringify(thread.platform));
            assert.equal(res.body.refreshed, false);
            assert.ok(!sent.some((s) => /profile_checked_at/.test(s.sql)), 'the throttle’s claim was not even taken');
        }
        assert.equal(graphCalls.length, 0);
    });

    it('404s a conversation that is not this tenant’s, and an id that is not a UUID, without touching Meta', async () => {
        const missing = await call('post', '/conversations/:id/refresh-profile', { params: { id: CONV } }, answer({ thread: null }));
        assert.equal(missing.res.statusCode, 404);
        const bad = await call('post', '/conversations/:id/refresh-profile', { params: { id: 'not-a-uuid' } }, answer());
        assert.equal(bad.res.statusCode, 404);
        assert.equal(bad.sent.length, 0);
        assert.equal(graphCalls.length, 0);
    });

    it('a database that fails while reading the thread is a 500 with no detail', async () => {
        const { res } = await call('post', '/conversations/:id/refresh-profile', { params: { id: CONV } }, () => new Error('connection terminated'));
        assert.equal(res.statusCode, 500);
        assert.ok(!JSON.stringify(res.body).includes('connection'));
    });
});
