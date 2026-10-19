/**
 * `/api/whatsapp`: the connection, the agent's mode and the billing choice, over real HTTP.
 *
 * Each route runs through its WHOLE stack (the owner guard, then the handler) in a real Express app on an ephemeral port, with a database and
 * a Graph that exist only in memory: `pool.query` is a small in-memory router over the statements these routes make, `metaHttp` and
 * `axios.get` (which `debug_token` uses) are recorders that THROW on any call a test did not arrange. `.env` holds live production
 * credentials, and nothing here may reach Postgres or Meta.
 *
 * What is pinned, because each is a way this could go wrong in front of real people:
 *   - the token is in NO answer, audit row or log line, and is stored only as `enc:v1:…`;
 *   - reads are open to a member and every write is the owner's, refused before anything is read or sent;
 *   - connecting asks Meta in a fixed order and stops at the first refusal, storing nothing;
 *   - mode `everyone` is refused with 409 whatever the connection looks like (the go-live gate does not exist yet);
 *   - a billable-reply choice and a test-sender list are validated, and a typo is a 400, never a silent default.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { pool } from '../config/db.js';
import { decryptSecret, encryptSecret } from '../config/crypto.js';
import { metaHttp } from '../services/http.js';
import { API_VERSION } from '../services/instagram.js';
import { resolveTenant } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { goLiveStatus, whatsappRouter } from './whatsapp.js';
import type { WhatsAppConnection } from '../services/whatsappConnections.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PHONE = '106540352242922';
const OTHER_PHONE = '109999999999999';
const WABA = '102290129340398';
const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789-SECRET';
const BASE = `https://graph.facebook.com/${API_VERSION}`;
const APP_ID = '847772258381375';

interface Session { userId?: string | null; role?: string; tenantId?: string; tenantRole?: 'owner' | 'operator' | 'viewer' }
const OWNER: Session = { userId: USER, role: 'user', tenantId: TENANT, tenantRole: 'owner' };

// ─── The world ──────────────────────────────────────────────────────────────────────────

interface Conn {
    id: string; creator_id: string; external_account_id: string; display_name: string | null; status: string; last_error: string | null;
    scopes: string[]; access_token: string | null; access_expires_at: Date | null; last_refreshed_at: Date | null; created_at: Date;
    profile: Record<string, unknown> | null; settings: Record<string, unknown>; connected_by_user_id: string | null;
}
interface Agent { whatsapp_mode: string; whatsapp_test_senders: string[] }

let conns: Conn[];
let agents: Map<string, Agent>;
let audits: Array<{ action: string; targetId: unknown; detail: any }>;
let statements: Array<{ sql: string; params: unknown[] }>;
let logs: string[];
let responses: string[];
/** Every call to Meta, in order. */
let order: string[];
let graphAuth: string[];

/** What Meta answers. Each test overrides the piece it is about. */
let meta: {
    debug: (token: string) => unknown;
    health: () => unknown;
    extras: () => unknown;
    subscribe: () => unknown;
    unsubscribe: () => unknown;
};

let server: Server;
let origin: string;
let restoreSink: (() => void) | undefined;
const originalQuery = pool.query;
const originals = { get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete, axiosGet: axios.get };
const savedEnv: Record<string, string | undefined> = {};

const rowOf = (c: Conn) => {
    const { access_token, connected_by_user_id, ...rest } = c;
    return { ...rest, has_token: access_token !== null };
};

function seed(over: Partial<Conn> = {}): Conn {
    const c: Conn = {
        id: `c-${conns.length + 1}`, creator_id: TENANT, external_account_id: PHONE, display_name: 'Test Number', status: 'active', last_error: null,
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], access_token: encryptSecret(TOKEN), access_expires_at: null,
        last_refreshed_at: new Date('2026-10-19T08:00:00Z'), created_at: new Date('2026-10-18T08:00:00Z'),
        profile: { waba_id: WABA, display_phone_number: '+1 555-025-3483', quality_rating: 'GREEN', messaging_limit: 'TIER_250', name_status: 'APPROVED', is_test_number: false },
        settings: {}, connected_by_user_id: USER, ...over,
    };
    conns.push(c);
    return c;
}

const mine = () => conns.find((c) => c.creator_id === TENANT);

function fakeQuery(sql: string, params: any[] = []): { rows: any[]; rowCount: number } {
    const q = sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: q, params });
    const result = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });

    if (q.startsWith('SELECT') && q.includes('FROM platform_connections')) {
        const withToken = q.includes(', access_token FROM platform_connections');
        const found = q.includes("external_account_id = $1 AND status <> 'revoked'")
            ? conns.filter((c) => c.external_account_id === params[0] && c.status !== 'revoked')
            : conns.filter((c) => c.creator_id === params[0]);
        return result(found.map((c) => (withToken ? { ...rowOf(c), access_token: c.access_token } : rowOf(c))));
    }
    if (q.startsWith('DELETE FROM platform_connections')) {
        const before = conns.length;
        conns = conns.filter((c) => !(c.external_account_id === params[0] && c.status === 'revoked' && c.creator_id !== params[1]));
        return result([], before - conns.length);
    }
    if (q.startsWith('INSERT INTO platform_connections')) {
        const [creatorId, phone, name, scopes, token, expires, userId, profile] = params;
        if (conns.some((c) => c.external_account_id === phone && c.creator_id !== creatorId)) {
            throw Object.assign(new Error('duplicate key value violates unique constraint "uq_platform_connections_account"'), { code: '23505' });
        }
        const existing = conns.find((c) => c.creator_id === creatorId);
        if (existing) {
            if (existing.external_account_id !== phone) existing.settings = {};
            Object.assign(existing, {
                external_account_id: phone, display_name: name, scopes, access_token: token, access_expires_at: expires, status: 'active',
                last_error: null, last_refreshed_at: new Date(), connected_by_user_id: userId, profile: JSON.parse(profile),
            });
            return result([rowOf(existing)]);
        }
        const created = seed({
            creator_id: creatorId, external_account_id: phone, display_name: name, scopes, access_token: token, access_expires_at: expires,
            connected_by_user_id: userId, profile: JSON.parse(profile), settings: {}, last_refreshed_at: new Date(),
        });
        return result([rowOf(created)]);
    }
    if (q.startsWith('UPDATE platform_connections')) {
        if (q.includes('SET display_name = COALESCE')) {
            const c = conns.find((x) => x.id === params[0] && x.status !== 'revoked');
            if (!c) return result([]);
            c.display_name = params[1] ?? c.display_name;
            c.profile = { ...(c.profile ?? {}), ...JSON.parse(params[2]) };
            c.last_refreshed_at = new Date();
            return result([rowOf(c)]);
        }
        if (q.includes("SET status = 'invalid'")) {
            const c = conns.find((x) => x.id === params[0] && x.status !== 'revoked');
            if (c) { c.status = 'invalid'; c.last_error = params[1]; }
            return result([], c ? 1 : 0);
        }
        if (q.includes("SET status = 'active', last_error = NULL")) {
            const c = conns.find((x) => x.id === params[0] && x.status === 'invalid');
            if (c) { c.status = 'active'; c.last_error = null; }
            return result([], c ? 1 : 0);
        }
        if (q.includes('SET access_token = NULL')) {
            const c = conns.find((x) => x.creator_id === params[0] && x.status !== 'revoked');
            if (c) Object.assign(c, { access_token: null, access_expires_at: null, status: 'revoked', last_error: null, settings: {} });
            return result([], c ? 1 : 0);
        }
        if (q.includes('SET settings = COALESCE')) {
            const c = conns.find((x) => x.creator_id === params[0] && x.status !== 'revoked');
            if (!c) return result([]);
            c.settings = { ...c.settings, ...JSON.parse(params[1]) };
            return result([rowOf(c)]);
        }
    }
    if (q.startsWith('SELECT whatsapp_mode, whatsapp_test_senders FROM ai_agents')) {
        const a = agents.get(params[0]);
        return result(a ? [a] : []);
    }
    if (q.startsWith('UPDATE ai_agents')) {
        const a = agents.get(params[0]);
        if (!a) return result([]);
        if (params[1] !== null) a.whatsapp_mode = params[1];
        if (params[2] !== null) a.whatsapp_test_senders = params[2];
        return result([{ ...a }]);
    }
    if (q.startsWith('INSERT INTO audit_log')) {
        audits.push({ action: params[2], targetId: params[4], detail: JSON.parse(params[5]) });
        return result([{ id: `audit-${audits.length}` }]);
    }
    if (q.startsWith('SELECT email FROM users WHERE id = $1')) return result([{ email: 'owner@example.test' }]);
    throw new Error(`no result arranged for SQL: ${q}`);
}

const metaError = (code: number, message: string, status = 400) =>
    Object.assign(new Error(message), { response: { status, data: { error: { code, message } } } });

const goodDebug = (over: Record<string, unknown> = {}) => ({
    is_valid: true, type: 'SYSTEM_USER', app_id: APP_ID, expires_at: 0,
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management'], ...over,
});

before(async () => {
    const app = express();
    app.use(express.json());
    // What requireAuth and resolveTenant do, from a header: this file tests the routes, the last describe tests the mount.
    app.use((req, _res, next) => {
        const raw = req.get('x-test-session');
        if (raw) {
            const s = JSON.parse(raw) as Session;
            req.session = { userId: s.userId ?? null, role: s.role ?? 'user', tenantId: s.tenantId } as typeof req.session;
            req.tenantRole = s.tenantRole;
        }
        next();
    });
    app.use('/api/whatsapp', whatsappRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET']) savedEnv[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
    process.env.META_APP_ID = APP_ID;
    process.env.META_APP_SECRET = 'the-app-secret-never-in-a-log';

    conns = [];
    agents = new Map([[TENANT, { whatsapp_mode: 'off', whatsapp_test_senders: [] }]]);
    audits = [];
    statements = [];
    logs = [];
    responses = [];
    order = [];
    graphAuth = [];
    meta = {
        debug: () => goodDebug(),
        health: () => ({ display_phone_number: '+1 555-025-3483', verified_name: 'Test Number', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', name_status: 'APPROVED', throughput: { level: 'STANDARD' } }),
        extras: () => ({ status: 'CONNECTED', whatsapp_business_manager_messaging_limit: 'TIER_250' }),
        subscribe: () => ({ success: true }),
        unsubscribe: () => ({ success: true }),
    };

    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);

    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => fakeQuery(sql, params);

    const unarranged = (what: string) => { throw new Error(`no Meta call was arranged: ${what}`); };
    (metaHttp as any).get = async (url: string, config: any) => {
        graphAuth.push(config?.headers?.Authorization);
        if (url === `${BASE}/${PHONE}` || url === `${BASE}/${OTHER_PHONE}`) {
            const fields = String(config?.params?.fields ?? '');
            order.push(fields.startsWith('display_phone_number') ? 'health' : 'extras');
            const answer = fields.startsWith('display_phone_number') ? meta.health() : meta.extras();
            if (answer instanceof Error) throw answer;
            return { data: answer };
        }
        return unarranged(`GET ${url}`);
    };
    (metaHttp as any).post = async (url: string, _body: unknown, config: any) => {
        graphAuth.push(config?.headers?.Authorization);
        if (url === `${BASE}/${WABA}/subscribed_apps`) {
            order.push('subscribe');
            const answer = meta.subscribe();
            if (answer instanceof Error) throw answer;
            return { data: answer };
        }
        return unarranged(`POST ${url}`);
    };
    (metaHttp as any).delete = async (url: string, config: any) => {
        graphAuth.push(config?.headers?.Authorization);
        if (url === `${BASE}/${WABA}/subscribed_apps`) {
            order.push('unsubscribe');
            const answer = meta.unsubscribe();
            if (answer instanceof Error) throw answer;
            return { data: answer };
        }
        return unarranged(`DELETE ${url}`);
    };
    (axios as any).get = async (url: string, config: any) => {
        if (!/\/debug_token$/.test(url)) return unarranged(`axios GET ${url}`);
        order.push('debug_token');
        const answer = meta.debug(config?.params?.input_token);
        if (answer instanceof Error) throw answer;
        return { data: { data: answer } };
    };
});

afterEach(() => {
    restoreSink?.();
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originals.get;
    (metaHttp as any).post = originals.post;
    (metaHttp as any).delete = originals.delete;
    (axios as any).get = originals.axiosGet;
    for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

async function call(method: string, path: string, over: { session?: Session; body?: unknown } = {}) {
    const session = over.session ?? OWNER;
    const res = await fetch(`${origin}/api/whatsapp${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-session': JSON.stringify(session) },
        ...(over.body !== undefined ? { body: JSON.stringify(over.body) } : {}),
    });
    const text = await res.text();
    responses.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

const connectBody = (over: Record<string, unknown> = {}) => ({ waba_id: WABA, phone_number_id: PHONE, access_token: TOKEN, ...over });

/** Nothing the owner pastes may appear in anything that leaves the process or is stored in the clear. */
function assertTokenNowhere(): void {
    for (const r of responses) assert.ok(!r.includes(TOKEN), 'the token is in a response');
    for (const l of logs) assert.ok(!l.includes(TOKEN), 'the token is in a log line');
    assert.ok(!JSON.stringify(audits).includes(TOKEN), 'the token is in an audit row');
    for (const s of statements) {
        const stored = JSON.stringify(s.params);
        if (stored.includes(TOKEN)) assert.fail(`the plaintext token is a parameter of: ${s.sql.slice(0, 80)}`);
    }
}

const noMetaCalls = () => assert.deepEqual(order, [], 'Meta was not asked anything');

// ─── Who may call what ──────────────────────────────────────────────────────────────────

describe('who may call what', () => {
    interface RouteLayer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { minimumRole?: string } }> } }
    const guards = () => new Map(((whatsappRouter as unknown as { stack: RouteLayer[] }).stack)
        .filter((l) => l.route)
        .flatMap((l) => Object.keys(l.route!.methods).map((m) => [
            `${m.toUpperCase()} ${l.route!.path}`,
            l.route!.stack.map((s) => s.handle?.minimumRole).find((r): r is string => typeof r === 'string') ?? null,
        ] as const)));

    it('is exactly six routes: one open read, five owner-only writes', () => {
        assert.deepEqual([...guards()].sort(), [
            ['DELETE /connection', 'owner'],
            ['GET /connection', null],
            ['POST /connect', 'owner'],
            ['POST /refresh', 'owner'],
            ['PUT /agent', 'owner'],
            ['PUT /billing', 'owner'],
        ]);
    });

    it('is mounted on the API router below resolveTenant, which is what sets the tenant and the role', () => {
        const middleware = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack
            .filter((l) => !l.route).map((l) => l.handle);
        const at = middleware.indexOf(whatsappRouter as unknown as never);
        assert.ok(at >= 0, 'the WhatsApp router must be mounted on the API router');
        assert.ok(at > middleware.indexOf(resolveTenant), 'and below resolveTenant, or its routes would act as no tenant');
    });

    for (const role of ['operator', 'viewer'] as const) {
        it(`refuses ${role} on every write, before anything is read, stored or sent`, async () => {
            seed();
            const session = { ...OWNER, tenantRole: role };
            for (const [method, path, body] of [
                ['POST', '/connect', connectBody()],
                ['POST', '/refresh', {}],
                ['DELETE', '/connection', undefined],
                ['PUT', '/agent', { mode: 'test' }],
                ['PUT', '/billing', { allow_billable: true }],
            ] as const) {
                const r = await call(method, path, { session, body });
                assert.equal(r.status, 403, `${method} ${path}`);
                assert.equal(r.body.code, 'INSUFFICIENT_TENANT_ROLE');
            }
            assert.equal(statements.length, 0, 'no database statement ran');
            noMetaCalls();
            assert.equal(audits.length, 0);
            assert.equal(mine()!.status, 'active');
            assert.deepEqual(agents.get(TENANT), { whatsapp_mode: 'off', whatsapp_test_senders: [] });
        });
    }

    it('lets a viewer read the connection', async () => {
        seed();
        const r = await call('GET', '/connection', { session: { ...OWNER, tenantRole: 'viewer' } });
        assert.equal(r.status, 200);
        assert.equal(r.body.connected, true);
    });
});

// ─── Reading ────────────────────────────────────────────────────────────────────────────

describe('GET /connection', () => {
    it('answers for a tenant that never connected: not connected, agent off, the meter at zero of 1,000', async () => {
        const r = await call('GET', '/connection');

        assert.equal(r.status, 200);
        assert.equal(r.body.connected, false);
        assert.equal(r.body.status, null);
        assert.equal(r.body.phone_number_id, null);
        assert.equal(r.body.mode, 'off');
        assert.deepEqual(r.body.test_senders, []);
        assert.equal(r.body.allow_billable, false);
        assert.equal(r.body.go_live.ready, false);
        noMetaCalls();
    });

    it('has the contract’s shape for a connected number, and reads the owner’s settings and agent', async () => {
        seed({ settings: { allow_billable: true, free_tier_alert_at: 750 }, profile: { waba_id: WABA, display_phone_number: '+1 555-025-3483', quality_rating: 'GREEN', messaging_limit: 'TIER_250', name_status: 'APPROVED', number_status: 'CONNECTED', is_test_number: true } });
        agents.set(TENANT, { whatsapp_mode: 'test', whatsapp_test_senders: ['EG.123'] });

        const r = await call('GET', '/connection');

        assert.equal(r.status, 200);
        assert.deepEqual({ ...r.body, usage: undefined, go_live: undefined }, {
            connected: true, status: 'active', phone_number_id: PHONE, display_phone_number: '+1 555-025-3483', verified_name: 'Test Number',
            quality_rating: 'GREEN', messaging_limit: 'TIER_250', name_status: 'APPROVED', number_status: 'CONNECTED', is_test_number: true,
            last_error: null, last_refreshed_at: '2026-10-19T08:00:00.000Z', token_expires_at: null, mode: 'test', test_senders: ['EG.123'],
            usage: undefined, allow_billable: true, free_tier_alert_at: 750, go_live: undefined,
        });
        noMetaCalls();
    });

    it('carries the usage placeholder, clearly the current month at zero of 1,000, until the ledger exists', async () => {
        seed();
        const { usage } = (await call('GET', '/connection')).body;
        assert.match(usage.period, /^\d{4}-(0[1-9]|1[0-2])$/);
        const now = new Date();
        assert.equal(usage.period, `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
        assert.deepEqual({ ...usage, period: undefined }, { period: undefined, free_used: 0, free_limit: 1000, billable: 0, est_cost_usd: 0, projected_cost_usd: 0 });
    });

    it('lists what stands between the owner and `everyone`, and never says ready in this phase', async () => {
        seed({ profile: { waba_id: WABA, is_test_number: true } });
        const { go_live } = (await call('GET', '/connection')).body;
        assert.equal(go_live.ready, false);
        assert.deepEqual(go_live.missing, ['not_test_number', 'public_pages', 'provider_allow_list']);

        conns = [];
        seed({ status: 'invalid', profile: { waba_id: WABA, is_test_number: false } });
        assert.deepEqual((await call('GET', '/connection')).body.go_live.missing, ['active_connection', 'public_pages', 'provider_allow_list']);
    });

    it('shows a connection Meta refused as not connected but with its number and reason, so the card can say "reconnect"', async () => {
        seed({ status: 'invalid', last_error: 'Session has expired' });
        const r = await call('GET', '/connection');
        assert.equal(r.body.connected, false);
        assert.equal(r.body.status, 'invalid');
        assert.equal(r.body.phone_number_id, PHONE);
        assert.equal(r.body.last_error, 'Session has expired');
    });

    it('shows a disconnected one as nothing: no number, no name', async () => {
        seed({ status: 'revoked', access_token: null });
        const r = await call('GET', '/connection');
        assert.equal(r.body.connected, false);
        assert.equal(r.body.status, 'revoked');
        assert.equal(r.body.phone_number_id, null);
        assert.equal(r.body.verified_name, null);
    });

    it('NEVER returns the token, however the row is read', async () => {
        seed();
        const r = await call('GET', '/connection');
        assert.ok(!r.text.includes(TOKEN));
        assert.ok(!r.text.includes('enc:v1'), 'nor its encrypted form');
        assert.ok(!/access_token|accessToken/.test(r.text), 'nor a field that could hold one');
        assertTokenNowhere();
    });

    it('answers 503 with the migration to apply when the database is behind', async () => {
        (pool as unknown as { query: unknown }).query = async () => { throw Object.assign(new Error('column "settings" does not exist'), { code: '42703' }); };
        const r = await call('GET', '/connection');
        assert.equal(r.status, 503);
        assert.match(r.body.error, /migration v50/);
    });
});

// ─── Connecting ─────────────────────────────────────────────────────────────────────────

describe('POST /connect', () => {
    it('validates with Meta in a fixed order, subscribes the app, stores the token encrypted and answers the card’s state', async () => {
        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 200);
        assert.deepEqual(order, ['debug_token', 'health', 'extras', 'subscribe']);
        assert.equal(r.body.connected, true);
        assert.equal(r.body.status, 'active');
        assert.equal(r.body.phone_number_id, PHONE);
        assert.equal(r.body.display_phone_number, '+1 555-025-3483');
        assert.equal(r.body.verified_name, 'Test Number');
        assert.equal(r.body.quality_rating, 'GREEN');
        assert.equal(r.body.messaging_limit, 'TIER_250');
        assert.equal(r.body.number_status, 'CONNECTED');
        assert.equal(r.body.mode, 'off', 'connecting does not switch the agent on');
        assert.equal(r.body.allow_billable, false, 'nor allow billable replies');

        const stored = mine()!;
        assert.match(stored.access_token!, /^enc:v1:/);
        assert.equal(decryptSecret(stored.access_token), TOKEN);
        assert.equal(stored.external_account_id, PHONE);
        assert.equal((stored.profile as any).waba_id, WABA);
        assert.deepEqual(stored.scopes, ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management']);
        assert.equal(stored.connected_by_user_id, USER);
    });

    it('NEVER returns the token, and it is in no log line, audit row or statement parameter (outside its encrypted form)', async () => {
        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 200);
        assert.ok(!r.text.includes(TOKEN));
        assert.ok(!/access_token|accessToken|enc:v1/.test(r.text));
        assertTokenNowhere();
        // …and not on a failing path either: a Meta refusal that echoes the token in its words.
        meta.health = () => metaError(190, `Invalid OAuth access token ${TOKEN}`);
        const refused = await call('POST', '/connect', { body: connectBody() });
        assert.equal(refused.status, 400);
        assert.match(refused.body.error, /Invalid OAuth access token \[token\]/);
        assertTokenNowhere();
    });

    it('sends the token to Meta only in the Authorization header of the Graph calls', async () => {
        await call('POST', '/connect', { body: connectBody() });
        assert.equal(graphAuth.length, 3, 'health, extras, subscribe');
        for (const a of graphAuth) assert.equal(a, `Bearer ${TOKEN}`);
    });

    it('records who connected which number, without the token', async () => {
        await call('POST', '/connect', { body: connectBody() });

        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'whatsapp.connect');
        assert.equal(audits[0]!.targetId, TENANT);
        assert.equal(audits[0]!.detail.phone_number_id, PHONE);
        assert.equal(audits[0]!.detail.waba_id, WABA);
        assert.deepEqual(audits[0]!.detail.scopes, ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management']);
    });

    it('trims what was pasted', async () => {
        const r = await call('POST', '/connect', { body: connectBody({ waba_id: ` ${WABA}\n`, phone_number_id: `${PHONE} `, access_token: `  ${TOKEN}\n` }) });
        assert.equal(r.status, 200);
        assert.equal(decryptSecret(mine()!.access_token), TOKEN);
    });

    it('refuses a body that is not three well-formed strings, and asks Meta nothing', async () => {
        for (const [body, code] of [
            [connectBody({ waba_id: undefined }), 'invalid_waba_id'],
            [connectBody({ waba_id: 'abc' }), 'invalid_waba_id'],
            [connectBody({ waba_id: 102290129340398 }), 'invalid_waba_id'],
            [connectBody({ phone_number_id: '12' }), 'invalid_phone_number_id'],
            [connectBody({ phone_number_id: '106540352242922/../me' }), 'invalid_phone_number_id'],
            [connectBody({ access_token: undefined }), 'invalid_access_token'],
            [connectBody({ access_token: 'short' }), 'invalid_access_token'],
            [connectBody({ access_token: 'has a space in it, which no token does' }), 'invalid_access_token'],
            [connectBody({ access_token: 12345 }), 'invalid_access_token'],
        ] as Array<[Record<string, unknown>, string]>) {
            const r = await call('POST', '/connect', { body });
            assert.equal(r.status, 400, JSON.stringify(body));
            assert.equal(r.body.code, code);
        }
        const empty = await call('POST', '/connect', { body: undefined });
        assert.equal(empty.status, 400);
        assert.equal(conns.length, 0);
        noMetaCalls();
    });

    it('refuses an invalid token and stops there: nothing more is asked of Meta, nothing stored', async () => {
        meta.debug = () => goodDebug({ is_valid: false, error: { message: 'Session has expired' } });

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 400);
        assert.match(r.body.error, /Session has expired/);
        assert.deepEqual(order, ['debug_token']);
        assert.equal(conns.length, 0);
        assert.equal(audits.length, 0);
    });

    it('refuses a token that lacks a scope, naming it', async () => {
        meta.debug = () => goodDebug({ scopes: ['whatsapp_business_management', 'business_management'] });

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'missing_scopes');
        assert.match(r.body.error, /whatsapp_business_messaging/);
        assert.deepEqual(order, ['debug_token']);
        assert.equal(conns.length, 0);
    });

    it('refuses a token issued to a different Meta app, which would subscribe the wrong app and receive nothing', async () => {
        meta.debug = () => goodDebug({ app_id: '555' });

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 400);
        assert.match(r.body.error, /different Meta app/);
        assert.deepEqual(order, ['debug_token']);
        assert.equal(conns.length, 0);
    });

    it('refuses a number another workspace holds BEFORE asking Meta anything, let alone writing to it', async () => {
        seed({ creator_id: OTHER_TENANT });

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'number_in_use');
        noMetaCalls();
        assert.equal(conns.length, 1);
        assert.equal(conns[0]!.creator_id, OTHER_TENANT);
    });

    it('catches the same number claimed in the race between the check and the insert', async () => {
        const original = (pool as unknown as { query: (sql: string, p?: unknown[]) => unknown }).query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            if (/^\s*INSERT INTO platform_connections/.test(sql)) throw Object.assign(new Error('duplicate key'), { code: '23505' });
            return (original as any)(sql, params);
        };

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'number_in_use');
        assert.equal(audits.length, 0);
    });

    it('lets a tenant reconnect its own number, replacing the connection in place', async () => {
        seed({ status: 'invalid', last_error: 'Session has expired', access_token: encryptSecret('EAAGold-token-0123456789012345') });

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 200);
        assert.equal(conns.length, 1);
        assert.equal(mine()!.status, 'active');
        assert.equal(mine()!.last_error, null);
        assert.equal(decryptSecret(mine()!.access_token), TOKEN);
    });

    it('answers 400 in Meta’s words, storing nothing, when the number cannot be read with this token', async () => {
        meta.health = () => metaError(100, 'Unsupported get request. Object with ID does not exist, or missing permissions');

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'number_unreadable');
        assert.match(r.body.error, /Object with ID/);
        assert.deepEqual(order, ['debug_token', 'health'], 'and the webhook is never subscribed for a number that cannot be read');
        assert.equal(conns.length, 0);
    });

    it('answers 502, storing nothing and subscribing nothing, when Meta cannot be reached', async () => {
        meta.health = () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });

        const r = await call('POST', '/connect', { body: connectBody() });

        assert.equal(r.status, 502);
        assert.equal(r.body.code, 'meta_unreachable');
        assert.deepEqual(order, ['debug_token', 'health', 'health'], 'the read is a GET, so it is tried once more; the webhook is never subscribed');
        assert.equal(conns.length, 0);
    });

    it('answers 502 when debug_token itself is down, and 400 when Meta refuses the app credentials', async () => {
        meta.debug = () => Object.assign(new Error('Request failed with status code 503'), { response: { status: 503, data: {} } });
        assert.equal((await call('POST', '/connect', { body: connectBody() })).status, 502);

        meta.debug = () => metaError(190, 'Invalid OAuth access token - Cannot parse access token');
        const refused = await call('POST', '/connect', { body: connectBody() });
        assert.equal(refused.status, 400);
        assert.match(refused.body.error, /Cannot parse access token/);
        assert.equal(conns.length, 0);
    });

    it('stores nothing when the subscription is refused, or when Meta answers 200 without success', async () => {
        meta.subscribe = () => metaError(200, '(#200) Requires whatsapp_business_management permission');
        const refused = await call('POST', '/connect', { body: connectBody() });
        assert.equal(refused.status, 400);
        assert.equal(refused.body.code, 'subscribe_failed');
        assert.equal(conns.length, 0);

        meta.subscribe = () => ({ success: false });
        const falsy = await call('POST', '/connect', { body: connectBody() });
        assert.equal(falsy.status, 400);
        assert.equal(falsy.body.code, 'subscribe_failed');
        assert.equal(conns.length, 0);
        assert.equal(audits.length, 0);
    });

    it('accepts a token that expires, and shows when', async () => {
        meta.debug = () => goodDebug({ expires_at: 1_800_000_000 });
        const r = await call('POST', '/connect', { body: connectBody() });
        assert.equal(r.status, 200);
        assert.equal(r.body.token_expires_at, '2027-01-15T08:00:00.000Z');
    });

    it('shows a test number as one, so the card can say so', async () => {
        const r = await call('POST', '/connect', { body: connectBody() });
        assert.equal(r.body.is_test_number, true);
        assert.ok(r.body.go_live.missing.includes('not_test_number'));
    });
});

// ─── Refreshing ─────────────────────────────────────────────────────────────────────────

describe('POST /refresh', () => {
    it('re-reads the number from Meta and answers the card’s state, keeping the waba id', async () => {
        seed();
        meta.health = () => ({ display_phone_number: '+1 555-025-3483', verified_name: 'Renamed', quality_rating: 'YELLOW', name_status: 'APPROVED' });

        const r = await call('POST', '/refresh');

        assert.equal(r.status, 200);
        assert.deepEqual(order, ['health', 'extras']);
        assert.equal(r.body.quality_rating, 'YELLOW');
        assert.equal(r.body.verified_name, 'Renamed');
        assert.equal((mine()!.profile as any).waba_id, WABA, 'a health read does not forget the account id the owner typed');
        assertTokenNowhere();
    });

    it('answers 409 for a tenant that never connected, asking Meta nothing', async () => {
        const r = await call('POST', '/refresh');
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'not_connected');
        noMetaCalls();
    });

    it('answers 409 for a disconnected one', async () => {
        seed({ status: 'revoked', access_token: null });
        assert.equal((await call('POST', '/refresh')).status, 409);
        noMetaCalls();
    });

    it('marks the connection invalid when Meta refuses the token, and answers the state it now has (not an error)', async () => {
        seed();
        meta.health = () => metaError(190, 'Error validating access token: Session has expired');

        const r = await call('POST', '/refresh');

        assert.equal(r.status, 200);
        assert.equal(r.body.connected, false);
        assert.equal(r.body.status, 'invalid');
        assert.match(r.body.last_error, /Session has expired/);
        assert.equal(mine()!.status, 'invalid');
    });

    it('leaves a working connection alone, answering 502, when Meta fails for any other reason', async () => {
        for (const failure of [
            Object.assign(new Error('boom'), { response: { status: 500, data: {} } }),
            Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
        ]) {
            conns = [];
            seed();
            meta.health = () => failure;
            const r = await call('POST', '/refresh');
            assert.equal(r.status, 502);
            assert.equal(mine()!.status, 'active', 'a hiccup must not flip a working connection');
        }
        conns = [];
        seed();
        meta.health = () => metaError(100, 'Unsupported get request');
        const refused = await call('POST', '/refresh');
        assert.equal(refused.status, 502);
        assert.equal(refused.body.code, 'meta_refused');
        assert.equal(mine()!.status, 'active');
    });

    it('brings an invalid connection back once the token is valid with both scopes again', async () => {
        seed({ status: 'invalid', last_error: 'Session has expired' });

        const r = await call('POST', '/refresh');

        assert.equal(r.status, 200);
        assert.deepEqual(order, ['health', 'extras', 'debug_token']);
        assert.equal(r.body.connected, true);
        assert.equal(r.body.last_error, null);
        assert.equal(mine()!.status, 'active');
    });
});

// ─── Disconnecting ──────────────────────────────────────────────────────────────────────

describe('DELETE /connection', () => {
    it('unsubscribes the app with the token it is about to wipe, wipes it, switches the agent off and answers 204', async () => {
        seed({ settings: { allow_billable: true } });
        agents.set(TENANT, { whatsapp_mode: 'test', whatsapp_test_senders: ['EG.123'] });

        const r = await call('DELETE', '/connection');

        assert.equal(r.status, 204);
        assert.equal(r.text, '');
        assert.deepEqual(order, ['unsubscribe']);
        assert.equal(graphAuth[0], `Bearer ${TOKEN}`);
        const c = mine()!;
        assert.equal(c.access_token, null, 'the token is wiped');
        assert.equal(c.status, 'revoked');
        assert.deepEqual(c.settings, {}, 'the billing choice does not survive a disconnect');
        assert.equal(agents.get(TENANT)!.whatsapp_mode, 'off', 'reconnecting must not silently resume answering');
        assert.deepEqual(agents.get(TENANT)!.whatsapp_test_senders, ['EG.123'], 'the test list is the owner’s and stays');
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'whatsapp.disconnect');
        assert.equal(audits[0]!.detail.unsubscribed_from_meta, true);
        assertTokenNowhere();
    });

    it('still disconnects when Meta will not unsubscribe: an account Meta considers dead must not trap the owner', async () => {
        seed({ status: 'invalid' });
        meta.unsubscribe = () => metaError(190, 'Invalid OAuth access token');

        const r = await call('DELETE', '/connection');

        assert.equal(r.status, 204);
        assert.equal(mine()!.status, 'revoked');
        assert.equal(mine()!.access_token, null);
        assert.equal(audits[0]!.detail.unsubscribed_from_meta, false);
    });

    it('answers 404 when there is nothing to disconnect, and does not touch the agent', async () => {
        agents.set(TENANT, { whatsapp_mode: 'test', whatsapp_test_senders: [] });

        const never = await call('DELETE', '/connection');
        assert.equal(never.status, 404);

        seed({ status: 'revoked', access_token: null });
        const twice = await call('DELETE', '/connection');
        assert.equal(twice.status, 404);

        assert.equal(agents.get(TENANT)!.whatsapp_mode, 'test');
        noMetaCalls();
        assert.equal(audits.length, 0);
    });

    it('shows as disconnected afterwards, and stops the webhook lookup matching the number', async () => {
        seed();
        await call('DELETE', '/connection');

        const r = await call('GET', '/connection');
        assert.equal(r.body.connected, false);
        assert.equal(r.body.status, 'revoked');
        assert.equal(r.body.phone_number_id, null);
        assert.equal(conns.filter((c) => c.external_account_id === PHONE && c.status !== 'revoked').length, 0);
    });

    it('lets another workspace take the number once it is disconnected', async () => {
        seed();
        await call('DELETE', '/connection');

        const r = await call('POST', '/connect', { session: { ...OWNER, tenantId: OTHER_TENANT }, body: connectBody() });

        assert.equal(r.status, 200);
        assert.equal(conns.length, 1, 'the revoked row held no data and is gone');
        assert.equal(conns[0]!.creator_id, OTHER_TENANT);
    });
});

// ─── The agent ──────────────────────────────────────────────────────────────────────────

describe('PUT /agent', () => {
    it('saves the mode and the test senders (BSUIDs and phone numbers, trimmed and unique) and answers the card’s state', async () => {
        seed();

        const r = await call('PUT', '/agent', { body: { mode: 'test', test_senders: [' EG.13491208655302741918 ', '20100123456', 'EG.13491208655302741918'] } });

        assert.equal(r.status, 200);
        assert.equal(r.body.mode, 'test');
        assert.deepEqual(r.body.test_senders, ['EG.13491208655302741918', '20100123456']);
        assert.deepEqual(agents.get(TENANT), { whatsapp_mode: 'test', whatsapp_test_senders: ['EG.13491208655302741918', '20100123456'] });
        assert.equal(audits[0]!.action, 'whatsapp.agent_write');
        assert.equal(audits[0]!.detail.mode, 'test');
        assert.equal(audits[0]!.detail.test_sender_count, 2);
        assert.ok(!JSON.stringify(audits).includes('20100123456'), 'the numbers are not in the audit ledger');
        noMetaCalls();
    });

    it('works before WhatsApp is connected: the owner may set the test list first', async () => {
        const r = await call('PUT', '/agent', { body: { mode: 'test', test_senders: ['EG.1'] } });
        assert.equal(r.status, 200);
        assert.equal(r.body.connected, false);
        assert.equal(r.body.mode, 'test');
    });

    it('leaves the senders alone when the body does not name them, and clears them for an explicit empty list', async () => {
        agents.set(TENANT, { whatsapp_mode: 'test', whatsapp_test_senders: ['EG.1'] });

        await call('PUT', '/agent', { body: { mode: 'off' } });
        assert.deepEqual(agents.get(TENANT), { whatsapp_mode: 'off', whatsapp_test_senders: ['EG.1'] });

        await call('PUT', '/agent', { body: { mode: 'off', test_senders: null } });
        assert.deepEqual(agents.get(TENANT)!.whatsapp_test_senders, ['EG.1'], 'null is "not given", as on Instagram’s settings');

        await call('PUT', '/agent', { body: { mode: 'off', test_senders: [] } });
        assert.deepEqual(agents.get(TENANT)!.whatsapp_test_senders, []);
    });

    it('ALWAYS refuses `everyone` with 409 and what is missing, even for an active, non-test connection, and writes nothing', async () => {
        seed({ profile: { waba_id: WABA, is_test_number: false }, status: 'active' });
        agents.set(TENANT, { whatsapp_mode: 'test', whatsapp_test_senders: ['EG.1'] });

        const r = await call('PUT', '/agent', { body: { mode: 'everyone' } });

        assert.equal(r.status, 409);
        assert.equal(r.body.error, 'go_live_not_ready');
        assert.ok(Array.isArray(r.body.missing) && r.body.missing.length > 0);
        assert.ok(r.body.missing.includes('public_pages') && r.body.missing.includes('provider_allow_list'));
        assert.equal(agents.get(TENANT)!.whatsapp_mode, 'test', 'the mode did not move');
        assert.ok(!statements.some((s) => /^UPDATE ai_agents/.test(s.sql)), 'no UPDATE ran');
        assert.equal(audits.length, 0);
    });

    it('refuses `everyone` for a tenant that never connected, and with senders in the same body', async () => {
        const r = await call('PUT', '/agent', { body: { mode: 'everyone', test_senders: ['EG.1'] } });
        assert.equal(r.status, 409);
        assert.equal(r.body.error, 'go_live_not_ready');
        assert.ok(r.body.missing.includes('active_connection'));
        assert.deepEqual(agents.get(TENANT), { whatsapp_mode: 'off', whatsapp_test_senders: [] }, 'not even the list was saved');
    });

    it('refuses a mode that is not one of the three', async () => {
        for (const mode of ['on', 'EVERYONE', '', null, 1, undefined]) {
            const r = await call('PUT', '/agent', { body: { mode } });
            assert.equal(r.status, 400, String(mode));
            assert.equal(r.body.code, 'invalid_mode');
        }
        assert.equal(audits.length, 0);
    });

    it('refuses a test sender that is not a WhatsApp id or a phone number, naming it, and saves nothing', async () => {
        for (const bad of ['12345', 'eg.123', '+20100123456', 'oops', 'EG.12-3']) {
            const r = await call('PUT', '/agent', { body: { mode: 'test', test_senders: ['EG.1', bad] } });
            assert.equal(r.status, 400, bad);
            assert.equal(r.body.code, 'invalid_test_senders');
            assert.ok(r.body.error.includes(`"${bad}"`), r.body.error);
        }
        assert.deepEqual(agents.get(TENANT), { whatsapp_mode: 'off', whatsapp_test_senders: [] });
    });

    it('allows 20 test senders and refuses 21', async () => {
        const make = (n: number) => Array.from({ length: n }, (_, i) => `EG.${1000 + i}`);
        assert.equal((await call('PUT', '/agent', { body: { mode: 'test', test_senders: make(20) } })).status, 200);
        const r = await call('PUT', '/agent', { body: { mode: 'test', test_senders: make(21) } });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /At most 20/);
    });

    it('says so, creating nothing, when the tenant has no AI agent yet', async () => {
        agents.clear();
        const r = await call('PUT', '/agent', { body: { mode: 'test' } });
        assert.equal(r.status, 409);
        assert.equal(r.body.error, 'agent_not_configured');
        assert.ok(!statements.some((s) => /INSERT INTO ai_agents/.test(s.sql)));
    });

    it('acts on the session’s own tenant only', async () => {
        agents.set(OTHER_TENANT, { whatsapp_mode: 'off', whatsapp_test_senders: [] });
        await call('PUT', '/agent', { body: { mode: 'test', test_senders: ['EG.1'] } });
        assert.deepEqual(agents.get(OTHER_TENANT), { whatsapp_mode: 'off', whatsapp_test_senders: [] });
        assert.equal(agents.get(TENANT)!.whatsapp_mode, 'test');
    });
});

// ─── Billing ────────────────────────────────────────────────────────────────────────────

describe('PUT /billing', () => {
    it('saves the owner’s choice and the alert threshold into the connection’s settings', async () => {
        seed();

        const r = await call('PUT', '/billing', { body: { allow_billable: true, free_tier_alert_at: 800 } });

        assert.equal(r.status, 200);
        assert.equal(r.body.allow_billable, true);
        assert.equal(r.body.free_tier_alert_at, 800);
        assert.deepEqual(mine()!.settings, { allow_billable: true, free_tier_alert_at: 800 });
        assert.equal(audits[0]!.action, 'whatsapp.billing_write');
        assert.equal(audits[0]!.detail.allow_billable, true);
        noMetaCalls();
    });

    it('changes only what the body names: turning billable off keeps the threshold', async () => {
        seed({ settings: { allow_billable: true, free_tier_alert_at: 800 } });

        const r = await call('PUT', '/billing', { body: { allow_billable: false } });

        assert.equal(r.status, 200);
        assert.deepEqual(mine()!.settings, { allow_billable: false, free_tier_alert_at: 800 });
    });

    it('defaults to blocking billable replies and alerting at 900', async () => {
        seed();
        const r = await call('GET', '/connection');
        assert.equal(r.body.allow_billable, false);
        assert.equal(r.body.free_tier_alert_at, 900);
    });

    it('requires allow_billable to be a real boolean: "true" must not spend the owner’s money', async () => {
        seed();
        for (const allow_billable of ['true', 1, 'yes', null, undefined, {}]) {
            const r = await call('PUT', '/billing', { body: { allow_billable } });
            assert.equal(r.status, 400, JSON.stringify(allow_billable));
            assert.equal(r.body.code, 'invalid_allow_billable');
        }
        assert.deepEqual(mine()!.settings, {});
    });

    it('takes a threshold only as a whole number from 0 to 1,000', async () => {
        seed();
        for (const bad of [-1, 1001, 1.5, '800', true]) {
            const r = await call('PUT', '/billing', { body: { allow_billable: true, free_tier_alert_at: bad } });
            assert.equal(r.status, 400, String(bad));
            assert.equal(r.body.code, 'invalid_free_tier_alert_at');
        }
        for (const good of [0, 1000, 900]) {
            assert.equal((await call('PUT', '/billing', { body: { allow_billable: false, free_tier_alert_at: good } })).status, 200, String(good));
        }
        assert.deepEqual(mine()!.settings, { allow_billable: false, free_tier_alert_at: 900 });
    });

    it('answers 409, saving nothing, when WhatsApp is not connected or was disconnected', async () => {
        const never = await call('PUT', '/billing', { body: { allow_billable: true } });
        assert.equal(never.status, 409);
        assert.equal(never.body.error, 'not_connected');

        seed({ status: 'revoked', access_token: null });
        const revoked = await call('PUT', '/billing', { body: { allow_billable: true } });
        assert.equal(revoked.status, 409);
        assert.deepEqual(mine()!.settings, {});
        assert.equal(audits.length, 0);
    });
});

// ─── The gate ───────────────────────────────────────────────────────────────────────────

describe('goLiveStatus', () => {
    const connection = (over: Partial<WhatsAppConnection> = {}): WhatsAppConnection => ({
        id: 'c', creatorId: TENANT, phoneNumberId: PHONE, displayName: 'X', status: 'active', lastError: null, scopes: [], hasToken: true,
        accessExpiresAt: null, lastRefreshedAt: null, connectedAt: null,
        profile: { waba_id: WABA, waac_id: null, display_phone_number: null, quality_rating: null, messaging_limit: null, name_status: null, code_verification_status: null, throughput: null, number_status: null, is_test_number: false, timezone: null, read_at: null },
        settings: { allow_billable: false, free_tier_alert_at: 900 }, ...over,
    });

    it('is never ready in this phase, for any connection', () => {
        for (const c of [null, connection(), connection({ status: 'invalid' }), connection({ status: 'revoked' })]) {
            assert.equal(goLiveStatus(c).ready, false);
        }
    });

    it('names the connection problems, then always the two checks the later phase adds', () => {
        assert.deepEqual(goLiveStatus(connection()).missing, ['public_pages', 'provider_allow_list']);
        assert.deepEqual(goLiveStatus(null).missing, ['active_connection', 'public_pages', 'provider_allow_list']);
        assert.deepEqual(goLiveStatus(connection({ profile: { ...connection().profile, is_test_number: true } })).missing, ['not_test_number', 'public_pages', 'provider_allow_list']);
    });
});
