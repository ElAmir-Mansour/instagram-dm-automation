/**
 * `GET /api/attention`: the route in front of the attention summary.
 *
 * The handler is pulled off the router's own stack and run against a stubbed `pool.query`, like inboxDetail.test.ts. What is asserted is
 * what only the route decides: where it sits (behind the session and tenant checks, so it acts as the session's tenant and no other),
 * who it answers (any role; `counts.platform` for a platform_admin session only), and what it says when a read fails. What the summary
 * contains is `src/services/attention.test.ts`'s. Nothing here reaches Postgres or Meta.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { requireLiveSession, resolveTenant } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

let events: Array<{ level: string; event: string }>;
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { events.push({ level, event: JSON.parse(line).event }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const originalGet = metaHttp.get;
const originalPost = metaHttp.post;
let graphCalls: string[];
beforeEach(() => {
    events = [];
    graphCalls = [];
    (metaHttp as any).get = async (url: string) => { graphCalls.push(`GET ${url}`); throw new Error('no Graph call may be made'); };
    (metaHttp as any).post = async (url: string) => { graphCalls.push(`POST ${url}`); throw new Error('no Graph call may be made'); };
});
afterEach(() => {
    (metaHttp as any).get = originalGet;
    (metaHttp as any).post = originalPost;
});

interface Layer { handle: Function; route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }
const layers = (): Layer[] => (apiRouter as unknown as { stack: Layer[] }).stack;
const attentionLayer = () => layers().find((l) => l.route?.path === '/attention' && l.route.methods.get);

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

interface Sent { sql: string; params: unknown[] }

async function get(
    session: Record<string, unknown>,
    req: { query?: Record<string, unknown>; params?: Record<string, string> } = {},
    answer: (sql: string) => unknown[] | Error = () => [],
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
        sent.push({ sql: flat(sql), params });
        const out = answer(sql);
        if (out instanceof Error) throw out;
        return { rows: out, rowCount: out.length };
    };
    try {
        const layer = attentionLayer();
        assert.ok(layer, 'GET /attention must be mounted');
        const handlers = layer!.route!.stack;
        await handlers[handlers.length - 1]!.handle({ query: {}, params: {}, body: {}, headers: {}, ...req, session }, res, () => {});
    } finally {
        (pool as unknown as { query: unknown }).query = original;
    }
    return { res, sent };
}

const connectedTenant = (sql: string): unknown[] =>
    /FROM creators c\s+WHERE c\.id = \$1 AND c\.page_access_token IS NOT NULL/.test(sql) ? [{ integration: 'meta', broken: false, at: null }] : [];

describe('GET /attention: where it sits', () => {
    it('is mounted, once, with no handler of its own beyond the route (no role guard: every role reads it)', () => {
        const all = layers().filter((l) => l.route?.path === '/attention');
        assert.equal(all.length, 1);
        assert.deepEqual(Object.keys(all[0]!.route!.methods), ['get']);
        assert.equal(all[0]!.route!.stack.length, 1);
    });

    it('is mounted behind the session check and the tenant resolver, so it can only act as the session’s tenant', () => {
        const at = layers().findIndex((l) => l.route?.path === '/attention');
        const live = layers().findIndex((l) => l.handle === requireLiveSession);
        const tenant = layers().findIndex((l) => l.handle === resolveTenant);
        assert.ok(live >= 0 && tenant >= 0, 'both guards are on the router');
        assert.ok(live < at, 'behind requireLiveSession');
        assert.ok(tenant < at, 'behind resolveTenant');
    });
});

describe('GET /attention: who it answers', () => {
    it('answers a tenant user with the contract’s shape and no platform count', async () => {
        const { res } = await get({ userId: 'u-1', role: 'user', tenantId: TENANT }, {}, connectedTenant);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body).sort(), ['checkedAt', 'counts', 'heartbeat', 'items']);
        assert.deepEqual(Object.keys(res.body.heartbeat).sort(), ['lastCommentAt', 'lastDmAt', 'lastWebhookAt', 'queue', 'worker']);
        assert.deepEqual(Object.keys(res.body.heartbeat.queue).sort(), ['failed', 'oldestPendingAt', 'pending']);
        assert.deepEqual(Object.keys(res.body.heartbeat.worker).sort(), ['lastSeenAt', 'online']);
        assert.deepEqual(res.body.items, []);
        assert.deepEqual(res.body.counts, { inbox: 0, studio: 0, scheduler: 0 });
        assert.equal('platform' in res.body.counts, false);
        assert.ok(Number.isFinite(Date.parse(res.body.checkedAt)));
    });

    it('adds counts.platform for a platform_admin session', async () => {
        const answer = (sql: string): unknown[] => {
            if (/FROM jobs\s*$/.test(sql.trim())) return [{ pending: 0, running: 0, failed: 0, done: 0, cancelled: 0, oldest_pending_at: null, stale: 1 }];
            if (/FROM schema_migrations/.test(sql)) return [{ filename: 'schema.sql' }];
            return connectedTenant(sql);
        };
        const { res } = await get({ userId: 'u-1', role: 'platform_admin', tenantId: TENANT }, {}, answer);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.counts.platform, 2);
    });

    it('does not read the platform signals at all for anyone else', async () => {
        const { sent } = await get({ userId: 'u-1', role: 'user', tenantId: TENANT }, {}, connectedTenant);
        assert.ok(!sent.some((s) => /FROM schema_migrations|FROM jobs\s*$/.test(s.sql)), 'no ledger or global queue read');
    });

    it('carries what the summary found: a handoff, an overdue post and a broken connection', async () => {
        const answer = (sql: string): unknown[] => {
            if (/FROM conversations c/.test(sql)) return [{ kind: 'handoff', reason: 'refund', n: 2, oldest_at: new Date('2026-10-19T04:00:00Z') }, { kind: 'waiting', reason: null, n: 1, oldest_at: new Date('2026-10-19T08:00:00Z') }];
            if (/FROM scheduled_posts s/.test(sql) && /archived_at/.test(sql)) return [{ failed: 0, failed_oldest_at: null, overdue: 1, overdue_oldest_at: new Date('2026-10-19T08:00:00Z') }];
            if (/FROM creators c\s+WHERE c\.id = \$1 AND c\.page_access_token/.test(sql)) return [{ integration: 'meta', broken: true, at: new Date('2026-10-18T10:00:00Z') }];
            return [];
        };
        const { res } = await get({ userId: 'u-1', role: 'user', tenantId: TENANT }, {}, answer);
        assert.deepEqual(res.body.items.map((i: any) => i.type), ['connection_broken', 'handoff', 'post_overdue']);
        assert.deepEqual(res.body.counts, { inbox: 3, studio: 0, scheduler: 1 });
        assert.deepEqual(res.body.items[1].sentence, { key: 'attention.handoff', params: { n: 2, reason: 'refund' } });
        assert.deepEqual(res.body.items[1].action, { verb: 'attention.verb.reply', href: '#/inbox?filter=todo' });
    });
});

describe('GET /attention: tenant scope', () => {
    it('reads for the session’s tenant, in every statement', async () => {
        const { sent } = await get({ userId: 'u-1', role: 'user', tenantId: TENANT }, {}, connectedTenant);
        assert.equal(sent.length, 5);
        for (const s of sent) assert.equal(s.params[0], TENANT, s.sql.slice(0, 80));
    });

    it('ignores a tenant named in the query or the path: the session decides', async () => {
        const { sent } = await get(
            { userId: 'u-1', role: 'user', tenantId: TENANT },
            { query: { tenant: OTHER, tenantId: OTHER, creator_id: OTHER, creatorId: OTHER }, params: { tenantId: OTHER, id: OTHER } },
            connectedTenant
        );
        for (const s of sent) {
            assert.equal(s.params[0], TENANT, s.sql.slice(0, 80));
            assert.ok(!s.params.includes(OTHER));
        }
    });

    it('never calls Meta', async () => {
        await get({ userId: 'u-1', role: 'platform_admin', tenantId: TENANT }, {}, connectedTenant);
        assert.deepEqual(graphCalls, []);
    });
});

describe('GET /attention: when a read fails', () => {
    it('is a 500 with a fixed sentence and no detail from the error, and logs it', async () => {
        const { res } = await get({ userId: 'u-1', role: 'user', tenantId: TENANT }, {}, () => new Error('password authentication failed for user "x"'));
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to read what needs attention.' });
        assert.ok(events.some((e) => e.level === 'error' && e.event === 'api.attention_failed'));
    });

    it('is not a half answer: no items, no counts', async () => {
        const { res } = await get({ userId: 'u-1', role: 'user', tenantId: TENANT }, {}, (sql) => (/FROM scheduled_posts s/.test(sql) && /archived_at/.test(sql) ? new Error('boom') : connectedTenant(sql)));
        assert.equal(res.statusCode, 500);
        assert.equal('items' in res.body, false);
        assert.equal('counts' in res.body, false);
    });

    it('names migration v45 when a column is missing, so the cause is not a mystery', async () => {
        const missing = Object.assign(new Error('column "archived_at" does not exist'), { code: '42703' });
        const { res } = await get({ userId: 'u-1', role: 'user', tenantId: TENANT }, {}, (sql) => (/archived_at/.test(sql) ? missing : connectedTenant(sql)));
        assert.equal(res.statusCode, 500);
        assert.equal(res.body.migrationPending, true);
        assert.match(res.body.error, /migration v45/);
        assert.match(res.body.error, /npm run migrate/);
    });

    it('throws nothing when the session carries no tenant: the handler answers 500 instead of crashing the process', async () => {
        const { res } = await get({ userId: 'u-1', role: 'user' }, {}, connectedTenant);
        assert.equal(res.statusCode, 500);
    });
});
