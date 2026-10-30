/**
 * The two routes behind "Where Meta sends your events" (`routes/meta.ts`), over real HTTP, and the health route that carries the stored answer to the banners.
 *
 * `GET /api/meta/webhooks` is a live read of the Meta app's subscriptions for the Settings card; `POST /api/meta/webhooks/repair` is the button. Both run in a real Express app on
 * an ephemeral port, with a Meta app, a database and two alert channels that exist only in memory (`metaWebhooksHarness.ts`): nothing here can reach Meta or Postgres.
 *
 * What is pinned, because each is a way the owner is hurt rather than helped:
 *   - **Platform admin only, and a 404 for everyone else** (the answer the app settings beside them give, so a tenant owner learns nothing about the route). The write also
 *     carries the owner guard every mutating route must, and still answers the 404 first.
 *   - **No stray request rewrites where Meta sends events for the whole app**: without `{ "confirm": true }` the answer is a 400 and Meta is not called.
 *   - **Why it cannot be done is a code, before anything is sent**: not configured, no public address, no verify token (409), Meta not answering the first read (502).
 *     A refusal by Meta of one step is that step's result in a 200: the dashboard reads a 401 as signed out.
 *   - **The card is told what the button would do**, and when an event of each kind last reached THIS workspace, and nothing of another's.
 *   - **No secret leaves**: not in a body, not in a log line, not in the audit row.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { pool } from '../config/db.js';
import { APP_SETTING_KEYS } from '../services/appSettings.js';
import { graphError } from '../services/metaLoginHarness.js';
import { checkMetaWebhooks } from '../services/metaWebhooks.js';
import {
    FakeChannels, FakeMeta, FakeWebhookDb, healthySubscriptions, incidentSubscriptions, OUR_BASE, OUR_CALLBACK, timeoutError,
} from '../services/metaWebhooksHarness.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { metaRouter } from './meta.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const APP_ID = '111222333444555';
const APP_SECRET = 'the-app-secret-0123456789-never-in-a-log';
const APP_TOKEN = `${APP_ID}|${APP_SECRET}`;
const VERIFY = 'env-verify-token-0123456789';

interface Session { userId?: string | null; role?: string; tenantId?: string; tenantRole?: 'owner' | 'operator' | 'viewer' }
const ADMIN_SESSION: Session = { userId: ADMIN, role: 'platform_admin', tenantId: TENANT, tenantRole: 'owner' };
const OWNER_SESSION: Session = { userId: USER, role: 'user', tenantId: TENANT, tenantRole: 'owner' };

let server: Server;
let origin: string;
let db: FakeWebhookDb;
let meta: FakeMeta;
let channels: FakeChannels;
let logs: string[];
let restoreSink: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

before(async () => {
    const app = express();
    app.use(express.json());
    // What requireAuth and resolveTenant do, from a header: this file tests the routes, meta.test.ts and api.test.ts test the mount.
    app.use((req, _res, next) => {
        const raw = req.get('x-test-session');
        if (raw) {
            const s = JSON.parse(raw) as Session;
            req.session = { userId: s.userId ?? null, role: s.role ?? 'user', tenantId: s.tenantId } as typeof req.session;
            req.tenantRole = s.tenantRole;
        }
        next();
    });
    app.use('/api/meta', metaRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_VERIFY_TOKEN', 'PUBLIC_BASE_URL']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
    process.env.META_APP_ID = APP_ID;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_VERIFY_TOKEN = VERIFY;
    delete process.env.PUBLIC_BASE_URL;
    db = new FakeWebhookDb().install();
    meta = new FakeMeta().install();
    channels = new FakeChannels().install();
    db.set(APP_SETTING_KEYS.publicBaseUrl, OUR_BASE);
    meta.subscriptions = incidentSubscriptions();
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    restoreSink?.();
    channels.restore();
    meta.restore();
    db.restore();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

async function api(method: string, path: string, over: { session?: Session | null; body?: unknown } = {}) {
    const session = over.session === undefined ? ADMIN_SESSION : over.session;
    const res = await fetch(`${origin}/api/meta${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(session ? { 'x-test-session': JSON.stringify(session) } : {}) },
        body: over.body === undefined ? undefined : JSON.stringify(over.body),
        redirect: 'manual',
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
}

const noSecrets = (text: string): void => {
    for (const secret of [APP_SECRET, APP_TOKEN, VERIFY]) assert.ok(!text.includes(secret), `a response, a log line or a row carries ${secret.slice(0, 12)}…`);
};

// ─── GET /api/meta/webhooks ─────────────────────────────────────────────────────────────

describe('GET /api/meta/webhooks', () => {
    it('is for a platform admin only: a tenant owner, an operator and a request with no session all get a 404, and Meta is never asked', async () => {
        assert.equal((await api('GET', '/webhooks', { session: OWNER_SESSION })).status, 404);
        assert.equal((await api('GET', '/webhooks', { session: { ...OWNER_SESSION, tenantRole: 'operator' } })).status, 404);
        assert.equal((await api('GET', '/webhooks', { session: null })).status, 404);
        assert.equal(meta.calls.length, 0);
    });

    it('reads Meta now and says where each event type goes, what is wrong, and what the button would do', async () => {
        const r = await api('GET', '/webhooks');
        assert.equal(r.status, 200);
        assert.equal(r.json.ok, false);
        assert.deepEqual(r.json.expected, { url: OUR_CALLBACK, host: 'msg-response-auto.vercel.app' });
        assert.deepEqual(r.json.objects.map((o: any) => [o.object, o.host, o.ours]), [
            ['instagram', 'staging.as-systems.tech', false], ['whatsapp_business_account', 'msg-response-auto.vercel.app', true],
            ['page', 'msg-response-auto.vercel.app', true], ['user', 'staging.as-systems.tech', false],
        ]);
        assert.deepEqual(r.json.problems.map((p: any) => [p.object, p.kind, p.host]), [['instagram', 'elsewhere', 'staging.as-systems.tech']]);
        assert.deepEqual(r.json.plan.map((s: any) => [s.object, s.kind, s.version, s.fields.length]), [['instagram', 'elsewhere', 'v25.0', 5], ['page', 'missing_field', 'v25.0', 4], ['user', 'elsewhere', 'v26.0', 0]]);
        assert.deepEqual(r.json.plan[1].addedFields, ['messaging_referrals']);
        assert.equal(typeof r.json.checkedAt, 'string');
    });

    it('has an empty plan when everything is ours, and nothing but the one read is sent to Meta', async () => {
        meta.subscriptions = healthySubscriptions();
        const r = await api('GET', '/webhooks');
        assert.equal(r.json.ok, true);
        assert.deepEqual([r.json.problems, r.json.plan], [[], []]);
        assert.deepEqual(meta.calls.map((c) => c.method), ['GET'], 'a read never writes');
        assert.equal(meta.calls[0]!.authorization, `Bearer ${APP_TOKEN}`);
    });

    it('stores what it read, so the banners agree with the card at once', async () => {
        await api('GET', '/webhooks');
        const stored = JSON.parse(db.get(APP_SETTING_KEYS.metaWebhooksStatus)!);
        assert.equal(stored.ok, false);
        assert.equal(stored.objects.length, 4);
    });

    it('says when an event of each kind last reached THIS workspace, and shows nothing of another one', async () => {
        db.addCreator(TENANT, { instagram_page_id: '17841400000000001', facebook_page_id: '200000000000001' });
        db.addCreator(OTHER_TENANT, { instagram_page_id: '17841400000000002', facebook_page_id: '200000000000002' });
        db.jobs.push({ kind: 'comment.process', tenant_key: '17841400000000001', created_at: new Date('2026-10-28T10:00:00Z') });
        db.jobs.push({ kind: 'dm.process', tenant_key: '200000000000001', created_at: new Date('2026-10-30T10:00:00Z') });
        db.jobs.push({ kind: 'comment.process', tenant_key: '17841400000000002', created_at: new Date('2026-10-30T11:00:00Z') });
        const mine = await api('GET', '/webhooks');
        assert.deepEqual(mine.json.lastEvents, { instagram: '2026-10-28T10:00:00.000Z', facebook: '2026-10-30T10:00:00.000Z', whatsapp: null });
        const theirs = await api('GET', '/webhooks', { session: { ...ADMIN_SESSION, tenantId: OTHER_TENANT } });
        assert.deepEqual(theirs.json.lastEvents, { instagram: '2026-10-30T11:00:00.000Z', facebook: null, whatsapp: null });
    });

    it('still answers when the events of this workspace cannot be read: the card then goes without them', async () => {
        db.failOn = /FROM creators WHERE id = \$1/;
        const r = await api('GET', '/webhooks');
        assert.equal(r.status, 200);
        assert.equal(r.json.lastEvents, null);
        assert.ok(logs.some((l) => l.includes('api.meta_webhooks_last_events_failed')));
    });

    it('is a 409 with a code when there is nothing to ask Meta with: NOT_CONFIGURED, NO_BASE_URL', async () => {
        delete process.env.META_APP_SECRET;
        const a = await api('GET', '/webhooks');
        assert.deepEqual([a.status, a.json.code], [409, 'NOT_CONFIGURED']);
        process.env.META_APP_SECRET = APP_SECRET;
        db.settings.delete(APP_SETTING_KEYS.publicBaseUrl);
        const b = await api('GET', '/webhooks');
        assert.deepEqual([b.status, b.json.code], [409, 'NO_BASE_URL']);
        assert.equal(meta.calls.length, 0);
    });

    it('is a 502 GRAPH_FAILED, never a 401, when Meta does not answer, with Meta\'s words and none of the secrets', async () => {
        meta.fail(/^GET /, graphError(400, { message: `Invalid OAuth access token ${APP_TOKEN}`, code: 190 }));
        const r = await api('GET', '/webhooks');
        assert.deepEqual([r.status, r.json.code], [502, 'GRAPH_FAILED']);
        assert.ok(r.json.error.includes('Invalid OAuth access token'));
        noSecrets(r.text);
        noSecrets(logs.join('\n'));
        assert.ok(!r.text.includes('REQUEST-CONFIG'));
    });

    it('is a plain 500, with no detail, when the database cannot be read', async () => {
        db.failOn = /app_settings/;
        const r = await api('GET', '/webhooks');
        assert.equal(r.status, 500);
        assert.equal(r.json.error, 'Failed to read where Meta sends the events.');
    });
});

// ─── POST /api/meta/webhooks/repair ─────────────────────────────────────────────────────

describe('POST /api/meta/webhooks/repair', () => {
    it('is for a platform admin only: a tenant owner gets the same 404 as for the read, before anything is looked at', async () => {
        assert.equal((await api('POST', '/webhooks/repair', { session: OWNER_SESSION, body: { confirm: true } })).status, 404);
        assert.equal((await api('POST', '/webhooks/repair', { session: null, body: { confirm: true } })).status, 404);
        assert.equal(meta.calls.length, 0);
        assert.equal(db.audit.length, 0);
    });

    it('refuses without { "confirm": true }: a 400, nothing sent to Meta, no audit row', async () => {
        for (const body of [undefined, {}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }]) {
            const r = await api('POST', '/webhooks/repair', { body });
            assert.deepEqual([r.status, r.json.code], [400, 'CONFIRMATION_REQUIRED'], JSON.stringify(body));
        }
        assert.equal(meta.calls.length, 0);
        assert.equal(db.audit.length, 0);
    });

    it('sends everything back, and answers with what was done, what Meta says now, and what is left to do (nothing)', async () => {
        const r = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.equal(r.status, 200);
        assert.equal(r.json.success, true);
        assert.deepEqual(r.json.steps, [{ object: 'instagram', ok: true }, { object: 'page', ok: true }, { object: 'user', ok: true }]);
        assert.equal(r.json.confirmed, true);
        assert.equal(r.json.ok, true);
        assert.deepEqual([r.json.problems, r.json.plan], [[], []]);
        assert.ok(r.json.objects.every((o: any) => o.ours), 'what Meta says now');
        assert.equal(r.json.before.find((o: any) => o.object === 'instagram').host, 'staging.as-systems.tech');
        assert.deepEqual(r.json.pages, { checked: 0, resubscribed: 0, failed: 0 });
        assert.equal(meta.subscriptions.find((s) => s.object === 'instagram')!.callback_url, OUR_CALLBACK);
    });

    it('writes the audit row as the admin who pressed it, and no secret is in the answer, the row or a log line', async () => {
        const r = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.equal(db.audit.length, 1);
        assert.deepEqual([db.audit[0]!.action, db.audit[0]!.actor_user_id], ['meta.webhooks_repair', ADMIN]);
        noSecrets(r.text);
        noSecrets(db.audit[0]!.detail);
        noSecrets(logs.join('\n'));
    });

    it('is a 409 with a code before anything is sent: NOT_CONFIGURED, NO_BASE_URL, NO_VERIFY_TOKEN', async () => {
        delete process.env.META_APP_SECRET;
        const a = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.deepEqual([a.status, a.json.code], [409, 'NOT_CONFIGURED']);
        process.env.META_APP_SECRET = APP_SECRET;
        db.settings.delete(APP_SETTING_KEYS.publicBaseUrl);
        const b = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.deepEqual([b.status, b.json.code], [409, 'NO_BASE_URL']);
        db.set(APP_SETTING_KEYS.publicBaseUrl, OUR_BASE);
        delete process.env.META_VERIFY_TOKEN;
        const c = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.deepEqual([c.status, c.json.code], [409, 'NO_VERIFY_TOKEN']);
        assert.ok(c.json.error.includes('verify token'));
        assert.equal(meta.calls.length, 0);
        assert.equal(db.audit.length, 0);
    });

    it('is a 502 GRAPH_FAILED when Meta does not answer the first read, and changes nothing', async () => {
        meta.fail(/^GET /, graphError(500, { message: 'Service unavailable', code: 2 }));
        const r = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.deepEqual([r.status, r.json.code], [502, 'GRAPH_FAILED']);
        assert.equal(meta.called(/^POST /).length, 0);
    });

    it('reports a step Meta refused in that step, in a 200 with Meta\'s words: the dashboard reads a 401 as signed out, and this is not one', async () => {
        meta.fail(/^POST .*\/subscriptions$/, graphError(400, { message: 'Callback verification failed with the following errors: HTTP Status Code = 403', code: 2200 }), 1);
        const r = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.steps.map((s: any) => s.ok), [false, true, true]);
        assert.ok(r.json.steps[0].error.startsWith('Callback verification failed'));
        assert.equal(r.json.ok, false, 'instagram is still elsewhere');
        assert.deepEqual(r.json.plan.map((s: any) => s.object), ['instagram'], 'and the button still has something to do');
    });

    it('says a step that timed out may still have gone through, and does not try it twice', async () => {
        meta.fail(/^POST .*\/subscriptions$/, timeoutError(), 1);
        const r = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.equal(r.status, 200);
        assert.ok(r.json.steps[0].error.includes('did not answer in time'));
        assert.equal(meta.called(/^POST .*\/subscriptions$/).length, 3);
    });

    it('says the change could not be confirmed when the subscriptions cannot be read back', async () => {
        meta.fail(/^GET .*\/subscriptions$/, graphError(500, { message: 'down', code: 2 }), 1, 1);
        const r = await api('POST', '/webhooks/repair', { body: { confirm: true } });
        assert.equal(r.status, 200);
        assert.equal(r.json.confirmed, false);
    });
});

// ─── The mount ──────────────────────────────────────────────────────────────────────────

describe('how the two routes are mounted', () => {
    interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { minimumRole?: string; name?: string } }> } }
    const layers = (metaRouter as unknown as { stack: Layer[] }).stack.filter((l) => l.route);
    const find = (method: string, path: string) => layers.find((l) => l.route!.path === path && l.route!.methods[method.toLowerCase()]);

    it('puts the platform-admin check first on both, and the owner role on the write (every mutating route here carries one)', () => {
        const read = find('GET', '/webhooks')!.route!.stack.map((s) => s.handle);
        const write = find('POST', '/webhooks/repair')!.route!.stack.map((s) => s.handle);
        assert.equal(read[0]!.name, 'requirePlatformAdmin');
        assert.equal(write[0]!.name, 'requirePlatformAdmin', 'it runs first, so anyone else gets the 404 and never a 403 that confirms the route');
        assert.equal(write[1]!.minimumRole, 'owner');
    });
});

// ─── The health route carries the stored answer ─────────────────────────────────────────

describe('GET /api/health/tenant: the stored answer, for the banners', () => {
    interface HandlerLayer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }
    const handler = (): Function => {
        const layer = (apiRouter as unknown as { stack: HandlerLayer[] }).stack.find((l) => l.route?.path === '/health/tenant' && l.route.methods['get']);
        assert.ok(layer, 'GET /health/tenant must be mounted');
        return layer!.route!.stack.at(-1)!.handle;
    };
    const HEALTH_ROW = {
        id: TENANT, name: 'Owner', is_active: true, instagram_page_id: '17841400000000001', facebook_page_id: '200000000000001', token_status: 'valid',
        token_last_checked_at: null, token_error: null, token_expires_at: null, token_data_access_expires_at: null, last_comment_at: null, last_inbound_dm_at: null,
        last_job_at: new Date('2026-10-30T11:59:00Z'), dm_this_hour: 0, jobs_pending: 0, jobs_running: 0, jobs_failed: 0, jobs_oldest_pending_at: null, posts_pending: 0, posts_failed_7d: 0,
    };

    /** The route, over a pool that answers the health query and reads the settings from `db`. */
    async function health(over: { failSettings?: boolean } = {}) {
        const run = (sql: string, params: unknown[] = []) => {
            const flatSql = sql.replace(/\s+/g, ' ').trim();
            if (/^SELECT c\.id, c\.name, c\.is_active/.test(flatSql)) return Promise.resolve({ rows: [HEALTH_ROW], rowCount: 1 });
            if (over.failSettings && /app_settings/.test(flatSql)) return Promise.reject(new Error('connection terminated unexpectedly'));
            return (db as unknown as { query: (s: string, p: unknown[]) => Promise<unknown> }).query(sql, params);
        };
        const previous = pool.query;
        (pool as unknown as { query: unknown }).query = run;
        const res = { statusCode: 200, body: null as any, status(code: number) { this.statusCode = code; return this; }, json(payload: unknown) { this.body = payload; return this; } };
        try {
            await handler()({ session: { tenantId: TENANT }, params: {}, query: {}, headers: {}, body: {} }, res, () => {});
        } finally {
            (pool as unknown as { query: unknown }).query = previous;
        }
        return res;
    }

    it('adds the stored summary to the tenant\'s health: what is wrong, with no call to Meta', async () => {
        await checkMetaWebhooks({ force: true });
        const callsBefore = meta.calls.length;
        const res = await health();
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.tenantId, TENANT);
        assert.equal(res.body.webhooks.ok, false);
        assert.deepEqual(res.body.webhooks.problems, [{
            object: 'instagram', host: 'staging.as-systems.tech', kind: 'elsewhere', fields: ['comments', 'mentions', 'messages', 'messaging_postbacks', 'story_insights'],
        }]);
        assert.equal(typeof res.body.webhooks.checkedAt, 'string');
        assert.equal(meta.calls.length, callsBefore, 'a page load never asks Meta');
        assert.equal(res.body.lastWebhookAt, '2026-10-30T11:59:00.000Z', 'the rest of the health answer is as it was');
    });

    it('says nothing is known (null), neither all well nor broken, before the first check', async () => {
        const res = await health();
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.webhooks, null);
    });

    it('says all is well when the stored answer is', async () => {
        meta.subscriptions = healthySubscriptions();
        await checkMetaWebhooks({ force: true });
        const res = await health();
        assert.deepEqual([res.body.webhooks.ok, res.body.webhooks.problems], [true, []]);
    });

    it('still answers when the setting cannot be read: the health of the tenant is not hostage to it', async () => {
        await checkMetaWebhooks({ force: true });
        const res = await health({ failSettings: true });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.webhooks, null);
        assert.equal(res.body.tenantId, TENANT);
        assert.ok(logs.some((l) => l.includes('api.tenant_health_webhooks_unread')));
    });
});
