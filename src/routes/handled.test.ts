/**
 * "Mark handled" on a DM thread, and what the conversation list says about it (UX US1: audit IN-01 and IN-02, FR-003, FR-006).
 *
 * `POST` and `DELETE /api/conversations/:id/handled` set and clear `conversations.handled_at` (v45): the owner's way out of "needs you" for a
 * thread he answered from the Instagram app, which nothing else records. The list adds `handled_at`, `window_ends_at` and `effective_ai` to each
 * item, and the assistant state those came from.
 *
 * Run through the route's WHOLE stack (role guard, then handler) with `pool.query` stubbed, like `salesVariantsSettings.test.ts`: the guard and the
 * tenant filter are the point. What is pinned: a viewer cannot mark, the row is the SESSION's tenant's and another tenant's id is a 404 that writes
 * nothing, both directions are audited with the conversation id and nothing the person said, a database without v45 answers a migration hint, and
 * the changes the owner's OWN reply and an Instagram-app echo make to a thread never clear the stamp (only a customer's message does: the upsert).
 *
 * Its own file, with the conversations half in its own `describe`s, so it merges cleanly beside the posts half of the archive/handled work.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { AUDIT_ACTIONS, isAuditAction } from '../services/audit.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Json = any;

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CONV = '33333333-3333-4333-8333-333333333333';
const PATH = '/conversations/:id/handled';

function stackFor(method: string, path: string): Handle[] {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as Json,
        status(code: number) { this.statusCode = code; return this; },
        set() { return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

interface Sent { sql: string; params: unknown[] }
type Answer = (sql: string, params: unknown[]) => { rows: Json[] } | Error | undefined;

let restoreSink: (() => void) | undefined;
let originalQuery: typeof pool.query;
let sent: Sent[];
let audits: Array<{ action: string; targetType: unknown; targetId: unknown; detail: Json }>;
let answer: Answer;

/** A thread as the list query returns it: the row, with the newest message's facts and the window facts. */
const THREAD = {
    id: CONV, creator_id: TENANT, instagram_user_id: '17841400003051', platform: 'instagram', username: 'sara_dev', is_bot_active: false,
    last_message_at: '2026-10-18T10:00:00.000Z', stage: 'handoff', handoff_at: '2026-10-18T10:00:00.000Z',
    last_message_text: 'refund please', last_message_direction: 'inbound', last_inbound_message_at: '2026-10-18T10:00:00.000Z', handled_at: null,
};
const AGENT_ON = { is_active: true, sales_mode: 'off', sales_test_senders: [] };

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    originalQuery = pool.query;
    sent = [];
    audits = [];
    answer = () => undefined;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ email: 'owner@example.test' }], rowCount: 1 };
        if (/INSERT INTO audit_log/.test(sql)) {
            audits.push({ action: String(params[2]), targetType: params[3], targetId: params[4], detail: JSON.parse(String(params[5])) });
            return { rows: [{ id: 'a-1' }], rowCount: 1 };
        }
        const out = answer(sql, params);
        if (out instanceof Error) throw out;
        if (out) return { ...out, rowCount: out.rows.length };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    restoreSink?.();
});

const OWNER = { userId: 'u-owner', role: 'user', tenantId: TENANT };

async function run(method: string, path: string, role: 'owner' | 'operator' | 'viewer', req: { params?: Record<string, string>; body?: unknown; query?: Record<string, unknown> } = {}) {
    const res = fakeRes();
    const full = { query: {}, params: {}, body: {}, ...req, session: OWNER, tenantRole: role, headers: {}, originalUrl: `/api${path}` };
    for (const handle of stackFor(method, path)) {
        let passed = false;
        await handle(full, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

const writes = () => sent.filter((s) => /UPDATE conversations/.test(s.sql));

/** The statements a successful mark runs: the stamp, then the summary's own reads. */
function arrange(over: { updated?: Json[]; thread?: Json | null; agent?: Json | null } = {}): void {
    answer = (sql) => {
        if (/UPDATE conversations SET handled_at/.test(sql)) return { rows: over.updated ?? [{ id: CONV, handled_at: new Date('2026-10-18T12:00:00.000Z') }] };
        if (/FROM conversations c/.test(sql)) {
            const thread = over.thread === undefined ? { ...THREAD, handled_at: new Date('2026-10-18T12:00:00.000Z') } : over.thread;
            return { rows: thread ? [thread] : [] };
        }
        if (/FROM tracked_links/.test(sql)) return { rows: [] };
        if (/FROM ai_agents/.test(sql)) return { rows: over.agent === null ? [] : [over.agent ?? AGENT_ON] };
        return undefined;
    };
}

// ─── POST and DELETE /conversations/:id/handled ────────────────────────────────────────────────

describe('POST /conversations/:id/handled', () => {
    it('stamps the thread for the SESSION\'s tenant and answers it as the list item it is, now handled', async () => {
        arrange();
        const res = await run('post', PATH, 'operator', { params: { id: CONV } });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(writes().length, 1);
        assert.match(writes()[0]!.sql, /^UPDATE conversations SET handled_at = NOW\(\) WHERE id = \$1 AND creator_id = \$2/);
        assert.deepEqual(writes()[0]!.params, [CONV, TENANT], 'this thread, this tenant, and nobody else');
        assert.equal(res.body.id, CONV);
        assert.equal(res.body.handled_at, '2026-10-18T12:00:00.000Z', 'ISO, like every stamp on the list');
        // The same shape as a list item, so the page can swap its copy for this one.
        assert.equal(res.body.window_ends_at, '2026-10-19T10:00:00.000Z');
        assert.equal(res.body.effective_ai, 'paused_thread');
        assert.equal(res.body.stage, 'handoff', 'the stage is untouched: only what the owner sees changes');
        assert.equal(res.body.is_bot_active, false, 'and who answers is untouched');
    });

    it('is the owner\'s and an operator\'s, and a viewer\'s is refused before any SQL', async () => {
        arrange();
        for (const role of ['owner', 'operator'] as const) {
            sent.length = 0;
            assert.equal((await run('post', PATH, role, { params: { id: CONV } })).statusCode, 200, role);
        }
        sent.length = 0;
        const refused = await run('post', PATH, 'viewer', { params: { id: CONV } });
        assert.equal(refused.statusCode, 403);
        assert.equal(sent.length, 0, 'nothing was read or written');
        const refusedUndo = await run('delete', PATH, 'viewer', { params: { id: CONV } });
        assert.equal(refusedUndo.statusCode, 403);
        assert.equal(sent.length, 0);
    });

    it('writes an audit entry with the actor, the conversation and the tenant, and nothing the person said', async () => {
        arrange();
        await run('post', PATH, 'operator', { params: { id: CONV } });

        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, AUDIT_ACTIONS.dmConversationHandled);
        assert.equal(audits[0]!.action, 'dm.conversation_handled');
        assert.equal(audits[0]!.targetType, 'conversation');
        assert.equal(audits[0]!.targetId, CONV);
        assert.deepEqual(audits[0]!.detail, { tenant_id: TENANT }, 'ids only: no handle, no message text');
        assert.equal(isAuditAction('dm.conversation_handled'), true);
        assert.equal(isAuditAction('dm.conversation_unhandled'), true);
        const actor = sent.find((s) => /INSERT INTO audit_log/.test(s.sql))!;
        assert.equal(actor.params[1], 'owner@example.test', 'the actor is the signed-in person');
    });

    it('is a 404 that writes and audits nothing for an id that is not a conversation, and for another tenant\'s conversation', async () => {
        arrange({ updated: [] });
        const notUuid = await run('post', PATH, 'owner', { params: { id: 'not-a-uuid' } });
        assert.equal(notUuid.statusCode, 404);
        assert.equal(sent.length, 0, 'a malformed id is refused before the database');

        // Another tenant's conversation: the UPDATE is filtered by `creator_id`, matches no row, and so there is nothing to answer.
        const foreign = await run('post', PATH, 'owner', { params: { id: CONV } });
        assert.equal(foreign.statusCode, 404);
        assert.deepEqual(writes()[0]!.params, [CONV, TENANT], 'the session\'s tenant is in the filter, not one the client names');
        assert.equal(audits.length, 0, 'nothing happened, so nothing is recorded');
        assert.ok(!sent.some((s) => /FROM conversations c/.test(s.sql)), 'and no summary is built for it');
    });

    it('still succeeds when the summary cannot be built: the stamp is set and recorded, and the answer carries it', async () => {
        answer = (sql) => {
            if (/UPDATE conversations SET handled_at/.test(sql)) return { rows: [{ id: CONV, handled_at: new Date('2026-10-18T12:00:00.000Z') }] };
            if (/FROM conversations c/.test(sql)) return new Error('connection terminated');
            return undefined;
        };
        const res = await run('post', PATH, 'owner', { params: { id: CONV } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { id: CONV, handled_at: '2026-10-18T12:00:00.000Z' });
        assert.equal(audits.length, 1);
    });

    it('on a database without v45 says so, with the migration to run, instead of a bare 500', async () => {
        answer = (sql) => (/UPDATE conversations SET handled_at/.test(sql)
            ? Object.assign(new Error('column "handled_at" of relation "conversations" does not exist'), { code: '42703' })
            : undefined);
        const res = await run('post', PATH, 'owner', { params: { id: CONV } });
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.migrationPending, true);
        assert.match(res.body.error, /migration v45/);
        assert.equal(audits.length, 0);
    });

    it('any other failure is a 500 and is not recorded as done', async () => {
        answer = (sql) => (/UPDATE conversations SET handled_at/.test(sql) ? Object.assign(new Error('connection terminated'), { code: '57P01' }) : undefined);
        const res = await run('post', PATH, 'owner', { params: { id: CONV } });
        assert.equal(res.statusCode, 500);
        assert.equal(audits.length, 0);
    });
});

describe('DELETE /conversations/:id/handled', () => {
    it('clears the stamp, scoped to the tenant, audits the undo, and answers the thread as not handled', async () => {
        answer = (sql) => {
            if (/UPDATE conversations SET handled_at = NULL/.test(sql)) return { rows: [{ id: CONV, handled_at: null }] };
            if (/FROM conversations c/.test(sql)) return { rows: [{ ...THREAD, handled_at: null }] };
            if (/FROM tracked_links/.test(sql)) return { rows: [] };
            if (/FROM ai_agents/.test(sql)) return { rows: [AGENT_ON] };
            return undefined;
        };
        const res = await run('delete', PATH, 'operator', { params: { id: CONV } });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.match(writes()[0]!.sql, /^UPDATE conversations SET handled_at = NULL WHERE id = \$1 AND creator_id = \$2/);
        assert.deepEqual(writes()[0]!.params, [CONV, TENANT]);
        assert.equal(res.body.handled_at, null);
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, AUDIT_ACTIONS.dmConversationUnhandled);
        assert.equal(audits[0]!.targetId, CONV);
    });

    it('is a 404 for a thread that is not this tenant\'s', async () => {
        answer = (sql) => (/UPDATE conversations SET handled_at = NULL/.test(sql) ? { rows: [] } : undefined);
        const res = await run('delete', PATH, 'owner', { params: { id: CONV } });
        assert.equal(res.statusCode, 404);
        assert.equal(audits.length, 0);
    });
});

// ─── Only a customer's message clears it ──────────────────────────────────────────────────────

describe('what clears handled_at: a customer\'s message and nothing else', () => {
    it('the DM pipeline\'s inbound upsert clears it, in the statement that bumps last_message_at', () => {
        const source = readFileSync('src/webhook/messaging.ts', 'utf8');
        const upsert = source.slice(source.indexOf('INSERT INTO conversations (creator_id, instagram_user_id, status, platform)'));
        const statement = upsert.slice(0, upsert.indexOf('RETURNING'));
        assert.match(statement, /DO UPDATE SET last_message_at = NOW\(\),\s*handled_at = NULL,/,
            'a new question must put the thread back in To do, and in the same statement, so there is no window between the two writes');
    });

    it('an Instagram-app echo and the bot\'s own writes leave the stamp alone', () => {
        // Every other writer of `conversations` that moves `last_message_at` or the AI switch: none may mention `handled_at`.
        for (const file of ['src/webhook/echo.ts', 'src/services/dmSales/failureHandoff.ts', 'src/services/dmSales/store.ts']) {
            const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            const updates = source.match(/UPDATE conversations[\s\S]*?(?:`|')/g) ?? [];
            for (const statement of updates) assert.doesNotMatch(statement, /handled_at/, `${file}: ${statement.slice(0, 80)}`);
        }
    });

    it('the owner\'s own manual reply pauses the AI and bumps last_message_at, and does not touch handled_at either way', async () => {
        const originalPost = metaHttp.post;
        const original = process.env.TOKEN_ENCRYPTION_KEY;
        process.env.TOKEN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
        (metaHttp as unknown as { post: unknown }).post = async () => ({ data: { message_id: 'sent-1' } });
        try {
            answer = (sql) => {
                if (/FROM conversations c\s*JOIN creators cr/.test(sql)) {
                    return { rows: [{ ...THREAD, page_access_token: encryptSecret('page-token'), facebook_page_id: null }] };
                }
                if (/INSERT INTO messages/.test(sql)) return { rows: [] };
                if (/UPDATE conversations SET last_message_at = NOW\(\), is_bot_active = false/.test(sql)) return { rows: [] };
                return undefined;
            };
            const res = await run('post', '/conversations/:id/messages', 'operator', { params: { id: CONV }, body: { text: 'Sent your refund.' } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            const touched = sent.filter((s) => /UPDATE conversations/.test(s.sql));
            assert.equal(touched.length, 1);
            assert.doesNotMatch(touched[0]!.sql, /handled_at/);
        } finally {
            (metaHttp as unknown as { post: unknown }).post = originalPost;
            if (original === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = original;
        }
    });
});

// ─── GET /conversations: handled_at, window_ends_at, effective_ai ───────────────────────────────

describe('GET /conversations: what each item says about handling, the window and who answers', () => {
    const list = (rows: Json[], agent: Json | Error | null = AGENT_ON): Answer => (sql) => {
        if (/SELECT COUNT\(\*\)::int as total/.test(sql)) return { rows: [{ total: rows.length }] };
        if (/FROM tracked_links/.test(sql)) return { rows: [] };
        if (/FROM ai_agents/.test(sql)) return agent instanceof Error ? agent : { rows: agent ? [agent] : [] };
        if (/FROM conversations c/.test(sql)) return { rows };
        return undefined;
    };
    const get = async () => run('get', '/conversations', 'viewer', { query: {} });

    it('carries handled_at as ISO or null, the window\'s end (the last message from the customer + 24 h), and the effective state, on every item', async () => {
        answer = list([
            { ...THREAD, id: 'a', handled_at: new Date('2026-10-18T12:00:00.000Z') },
            { ...THREAD, id: 'b', handled_at: null, is_bot_active: true, last_inbound_message_at: null },
            { id: 'c' },   // a database without v39 or v45: the columns are absent
        ]);
        const res = await get();

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        const [a, b, c] = res.body.data;
        assert.equal(a.handled_at, '2026-10-18T12:00:00.000Z');
        assert.equal(a.window_ends_at, '2026-10-19T10:00:00.000Z');
        assert.equal(a.effective_ai, 'paused_thread');
        assert.equal(b.handled_at, null);
        assert.equal(b.window_ends_at, null, 'no message from the customer, no window');
        assert.equal(b.effective_ai, 'on');
        assert.equal(c.handled_at, null, 'null, not absent');
        assert.equal(c.window_ends_at, null);
        assert.equal(c.effective_ai, 'on');
    });

    it('says "off_global" on every thread while the assistant is switched off, whatever the thread\'s own switch says', async () => {
        answer = list([{ ...THREAD, id: 'a', is_bot_active: true }, { ...THREAD, id: 'b', is_bot_active: false }], { ...AGENT_ON, is_active: false });
        const res = await get();
        assert.deepEqual(res.body.data.map((x: Json) => x.effective_ai), ['off_global', 'off_global']);
        assert.deepEqual(res.body.assistant, { configured: true, is_active: false, sales_mode: 'off', sales_test_senders: [] });
    });

    it('says "off_global" for a tenant with no agent row: nothing answers there, so it is never "AI active", and `configured` says why', async () => {
        answer = list([{ ...THREAD, id: 'a', is_bot_active: true }], null);
        const res = await get();
        assert.equal(res.body.data[0].effective_ai, 'off_global');
        assert.deepEqual(res.body.assistant, { configured: false, is_active: false, sales_mode: 'off', sales_test_senders: [] });
    });

    it('reads the sales mode: "test" marks only the listed senders\' threads, "on" marks every thread that is not paused', async () => {
        const rows = [
            { ...THREAD, id: 'mine', instagram_user_id: '17841400003051', is_bot_active: true },
            { ...THREAD, id: 'theirs', instagram_user_id: '17841499999999', is_bot_active: true },
            { ...THREAD, id: 'paused', instagram_user_id: '17841400003051', is_bot_active: false },
        ];
        answer = list(rows, { is_active: true, sales_mode: 'test', sales_test_senders: ['17841400003051'] });
        assert.deepEqual((await get()).body.data.map((x: Json) => x.effective_ai), ['sales_test', 'on', 'paused_thread']);

        answer = list(rows, { is_active: true, sales_mode: 'on', sales_test_senders: [] });
        assert.deepEqual((await get()).body.data.map((x: Json) => x.effective_ai), ['sales_live', 'sales_live', 'paused_thread']);
    });

    it('a database without the sales columns is read as is_active alone, and the sales mode is off', async () => {
        let first = true;
        answer = (sql, params) => {
            if (/FROM ai_agents/.test(sql) && /sales_mode/.test(sql)) {
                first = false;
                return Object.assign(new Error('column "sales_mode" does not exist'), { code: '42703' });
            }
            return list([{ ...THREAD, id: 'a', is_bot_active: true }], { is_active: true })(sql, params);
        };
        const res = await get();
        assert.equal(first, false, 'the v39 columns were tried first');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.data[0].effective_ai, 'on');
        assert.deepEqual(res.body.assistant, { configured: true, is_active: true, sales_mode: 'off', sales_test_senders: [] });
    });

    it('when the assistant cannot be read, the list still answers: `assistant` is null and an item says only what its own switch says, never "off"', async () => {
        answer = list([{ ...THREAD, id: 'a', is_bot_active: true }, { ...THREAD, id: 'b', is_bot_active: false }], new Error('connection terminated'));
        const res = await get();
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.assistant, null);
        assert.deepEqual(res.body.data.map((x: Json) => x.effective_ai), ['on', 'paused_thread']);
    });

    it('is readable by a viewer: it states, it changes nothing', async () => {
        answer = list([{ ...THREAD }]);
        assert.equal((await get()).statusCode, 200);
    });

    it('keeps another tenant\'s assistant out of this tenant\'s list: the lookup is bound to the session\'s tenant', async () => {
        answer = list([{ ...THREAD }]);
        await get();
        const lookup = sent.find((s) => /FROM ai_agents/.test(s.sql))!;
        assert.deepEqual(lookup.params, [TENANT]);
        assert.ok(!lookup.params.includes(OTHER_TENANT));
    });
});
