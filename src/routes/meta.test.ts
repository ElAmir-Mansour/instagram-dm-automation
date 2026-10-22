/**
 * The Meta connection routes, over real HTTP (P27).
 *
 * The callback is the one route a browser reaches with no session, so everything that binds a returned code to a tenant happens
 * there: the state must match the cookie set in the browser that began the flow, and must be spendable exactly once. These run
 * both routers in a real Express app on an ephemeral port (a redirect, a Set-Cookie and a hash query are exactly what a hand-built
 * fake `res` gets subtly wrong), with a database and a Graph that exist only in memory (metaLoginHarness.ts): nothing here can
 * reach Postgres or Meta.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { decryptSecret } from '../config/crypto.js';
import { APP_SETTING_KEYS } from '../services/appSettings.js';
import { FakeDb, FakeGraph, page } from '../services/metaLoginHarness.js';
import { LOGIN_SCOPES, completeMetaConnection } from '../services/metaLogin.js';
import { createOAuthState, readPick } from '../services/oauthState.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { metaPublicRouter, metaRouter, STATE_COOKIE } from './meta.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const OWNER_TENANT = '99999999-9999-4999-8999-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const BASE = 'https://autoreply.example';
const CODE = 'AQDauthorizationcodefrommeta0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL';
const OWNER_TOKEN_PLAIN = 'OWNER-PAGE-TOKEN-never-touched-0123456789abcdef';

interface Session { userId?: string | null; role?: string; tenantId?: string; tenantRole?: 'owner' | 'operator' | 'viewer' }
const OWNER_SESSION: Session = { userId: USER, role: 'user', tenantId: TENANT, tenantRole: 'owner' };

let server: Server;
let origin: string;
let db: FakeDb;
let graph: FakeGraph;
let logs: string[];
let restoreSink: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/meta', metaPublicRouter);
    // What requireAuth and resolveTenant do, from a header: this file tests the routes, api.test.ts tests the mount.
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
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'PUBLIC_BASE_URL']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
    process.env.META_APP_ID = '111222333444555';
    process.env.META_APP_SECRET = 'the-app-secret-0123456789-never-in-a-log';
    delete process.env.META_LOGIN_CONFIG_ID;
    delete process.env.PUBLIC_BASE_URL;
    db = new FakeDb().install();
    graph = new FakeGraph().install();
    db.settings.set(APP_SETTING_KEYS.publicBaseUrl, BASE);
    db.settings.set(APP_SETTING_KEYS.metaLoginEnabled, 'true');
    db.addCreator(TENANT, { name: 'New Tenant' });
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    restoreSink?.();
    graph.restore();
    db.restore();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

/** A state minted the way POST /connect mints one, and the cookie header the browser that began the flow would send. */
async function begin(over: { reconnect?: boolean; returnTo?: 'settings' | 'welcome' | null; creatorId?: string; userId?: string | null } = {}) {
    const nonce = await createOAuthState({
        purpose: 'meta', creatorId: over.creatorId ?? TENANT, userId: over.userId === undefined ? USER : over.userId,
        returnTo: over.returnTo === undefined ? 'settings' : over.returnTo, payload: { v: 1, reconnect: over.reconnect === true },
    });
    return { nonce, cookie: `${STATE_COOKIE}=${nonce}` };
}

async function callback(query: string, cookie?: string) {
    const res = await fetch(`${origin}/api/meta/callback?${query}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const location = res.headers.get('location') ?? '';
    const url = new URL(location, origin);
    const hash = url.hash;
    const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
    return {
        status: res.status, location, route: hash.slice(0, hash.indexOf('?') === -1 ? undefined : hash.indexOf('?')), params,
        outcome: params.get('meta'), reason: params.get('reason'), setCookie: res.headers.get('set-cookie') ?? '',
    };
}

async function api(method: string, path: string, over: { session?: Session | null; body?: unknown; headers?: Record<string, string> } = {}) {
    const session = over.session === undefined ? OWNER_SESSION : over.session;
    const res = await fetch(`${origin}/api/meta${path}`, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(session ? { 'x-test-session': JSON.stringify(session) } : {}),
            ...over.headers,
        },
        body: over.body === undefined ? undefined : JSON.stringify(over.body),
        redirect: 'manual',
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text, setCookie: res.headers.get('set-cookie') ?? '' };
}

/** Everything a secret could hide in after a flow. */
function everywhere(extra: string[] = []): string {
    return [logs.join('\n'), db.everything(), ...extra].join('\n');
}

async function connectOwnerTenant(): Promise<void> {
    const { encryptSecret } = await import('../config/crypto.js');
    db.addCreator(OWNER_TENANT, {
        name: 'owner', instagram_page_id: '17841499999999991', facebook_page_id: '100000000000001',
        page_access_token: encryptSecret(OWNER_TOKEN_PLAIN), token_status: 'valid',
    });
}

// ─── The callback ───────────────────────────────────────────────────────────────────────

describe('GET /api/meta/callback: before anything is spent', () => {
    it('sends a cancelled dialog back to Settings, touching nothing', async () => {
        const r = await callback('error=access_denied&error_reason=user_denied&state=abc');
        assert.equal(r.status, 302);
        assert.equal(r.route, '#/settings', 'params belong in the hash query, where App.hashParam reads them');
        assert.equal(r.outcome, 'error');
        assert.equal(r.reason, 'denied');
        assert.equal(db.statements.length, 0);
        assert.equal(graph.calls.length, 0);
    });

    it('reads any other refusal from Meta as meta_error', async () => {
        assert.equal((await callback('error=server_error&state=abc')).reason, 'meta_error');
    });

    it('spends the state on a denial that is ours, so it can be used for nothing, and returns to where the flow began', async () => {
        const { nonce, cookie } = await begin({ returnTo: 'welcome' });
        const r = await callback(`error=access_denied&state=${nonce}`, cookie);
        assert.equal(r.route, '#/welcome');
        assert.equal(r.reason, 'denied');
        assert.ok(db.oauth.find((o) => o.nonce === nonce)!.used_at, 'the denied state is spent');
    });

    it('does not spend a state for a denial that carries no matching cookie', async () => {
        const { nonce } = await begin();
        const r = await callback(`error=access_denied&state=${nonce}`, `${STATE_COOKIE}=another`);
        assert.equal(r.route, '#/settings');
        assert.equal(db.oauth.find((o) => o.nonce === nonce)!.used_at, null);
    });

    it('needs both a state and a code', async () => {
        assert.equal((await callback('code=c1')).reason, 'missing_code');
        assert.equal((await callback('state=s1')).reason, 'missing_code');
        assert.equal((await callback('')).reason, 'missing_code');
        assert.equal(db.statements.length, 0);
    });

    it('refuses a state with no matching cookie BEFORE spending it', async () => {
        // A state lifted from a log or a referrer and replayed in another browser. Spending it here would let the attacker's
        // attempt burn the victim's legitimate one.
        const { nonce, cookie } = await begin();
        const before = db.statements.length;

        const none = await callback(`code=${CODE}&state=${nonce}`);
        assert.equal(none.reason, 'state_mismatch');
        const wrong = await callback(`code=${CODE}&state=${nonce}`, `${STATE_COOKIE}=a-different-state`);
        assert.equal(wrong.reason, 'state_mismatch');
        assert.equal(db.statements.length, before, 'no database call at all');
        assert.equal(graph.calls.length, 0);
        assert.equal(db.oauth.find((o) => o.nonce === nonce)!.used_at, null, 'the legitimate state is still good');

        graph.pages = [page(1)];
        assert.equal((await callback(`code=${CODE}&state=${nonce}`, cookie)).outcome, 'connected');
    });

    it('refuses a state that is unknown or has expired', async () => {
        const unknown = await callback(`code=${CODE}&state=${'x'.repeat(43)}`, `${STATE_COOKIE}=${'x'.repeat(43)}`);
        assert.equal(unknown.reason, 'state_expired');
        const { nonce, cookie } = await begin();
        db.now += 11 * 60_000;
        assert.equal((await callback(`code=${CODE}&state=${nonce}`, cookie)).reason, 'state_expired');
        assert.equal(graph.calls.length, 0);
    });

    it('refuses a state minted for another flow: a TikTok state is not a Meta state', async () => {
        const nonce = await createOAuthState({ purpose: 'tiktok', creatorId: TENANT, userId: USER });
        const r = await callback(`code=${CODE}&state=${nonce}`, `${STATE_COOKIE}=${nonce}`);
        assert.equal(r.reason, 'state_expired');
        assert.equal(graph.calls.length, 0);
    });

    it('always clears the state cookie on the way out', async () => {
        const r = await callback('error=access_denied');
        assert.match(r.setCookie, new RegExp(`${STATE_COOKIE}=;`));
        assert.match(r.setCookie, /Path=\/api\/meta\/callback/);
        assert.match(r.setCookie, /Max-Age=0/);
        assert.match(r.setCookie, /HttpOnly/);
        assert.match(r.setCookie, /Secure/);
        assert.match(r.setCookie, /SameSite=Lax/);
    });
});

describe('GET /api/meta/callback: a state is spent exactly once', () => {
    it('connects on the first use and refuses the same state, cookie and code on the second, asking Meta nothing', async () => {
        graph.pages = [page(1)];
        const { nonce, cookie } = await begin();

        const first = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(first.outcome, 'connected');
        const connected = db.snapshotCreators();
        const callsAfterFirst = graph.calls.length;

        const replay = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(replay.outcome, 'error');
        assert.equal(replay.reason, 'state_expired', 'a replayed callback is refused');
        assert.equal(graph.calls.length, callsAfterFirst, 'and not one more call went to Meta');
        assert.equal(db.snapshotCreators(), connected);
    });

    it('lets only one of two simultaneous callbacks carrying the same state through', async () => {
        graph.pages = [page(1)];
        const { nonce, cookie } = await begin();
        const [a, b] = await Promise.all([callback(`code=${CODE}&state=${nonce}`, cookie), callback(`code=${CODE}&state=${nonce}`, cookie)]);
        assert.deepEqual([a.outcome, b.outcome].sort(), ['connected', 'error']);
        assert.equal(graph.called(/POST .*subscribed_apps/).length, 1, 'one Page was subscribed once');
    });
});

describe('GET /api/meta/callback: the outcomes', () => {
    it('connects one usable Page with Instagram and returns to Settings', async () => {
        graph.pages = [page(1)];
        const { nonce, cookie } = await begin();
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.status, 302);
        assert.equal(r.route, '#/settings');
        assert.equal(r.outcome, 'connected');
        assert.equal(r.reason, null);
        assert.equal(r.params.get('warn'), null);
        assert.match(r.setCookie, /Max-Age=0/);

        const row = db.creators.get(TENANT)!;
        assert.equal(row.facebook_page_id, '200000000000001');
        assert.ok(row.page_access_token);
        assert.deepEqual(graph.called(/POST .*subscribed_apps/).map((c) => c.path), ['/200000000000001/subscribed_apps']);
    });

    it('returns to the setup wizard when the flow began there', async () => {
        graph.pages = [page(1)];
        const { nonce, cookie } = await begin({ returnTo: 'welcome' });
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.route, '#/welcome');
        assert.equal(r.outcome, 'connected');
    });

    it('says what went wrong, in the redirect, when the connection is kept but the webhook was not subscribed', async () => {
        graph.pages = [page(1)];
        graph.fail(/POST .*subscribed_apps/, 400, { message: 'Requires pages_manage_metadata', code: 200 });
        const { nonce, cookie } = await begin();
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.outcome, 'connected');
        assert.equal(r.params.get('warn'), 'subscribe_failed');
    });

    it('sends several Pages to the picker with a pick bound to this tenant and user', async () => {
        graph.pages = [page(1), page(2)];
        const { nonce, cookie } = await begin({ returnTo: 'welcome' });
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.route, '#/connect-meta');
        assert.equal(r.outcome, 'pick');
        assert.equal(r.params.get('return_to'), 'welcome');
        const pick = r.params.get('pick')!;
        assert.ok(await readPick(pick, TENANT, USER));
        assert.equal(await readPick(pick, OTHER_TENANT, USER), null);
        assert.equal(db.creators.get(TENANT)!.page_access_token, null, 'nothing connected until a choice is made');
        assert.equal(graph.called(/POST .*subscribed_apps/).length, 0);
    });

    for (const [name, setup, reason] of [
        ['the code was refused', () => graph.fail(/GET \/oauth\/access_token/, 400, { message: 'This authorization code has expired.', code: 100 }), 'code_exchange_failed'],
        ['the long-lived exchange was refused', () => graph.fail(/GET \/oauth\/access_token/, 400, { message: 'no', code: 100 }, 1, (cfg) => Boolean(cfg.params?.fb_exchange_token)), 'token_exchange_failed'],
        ['a read after the exchange failed', () => graph.fail(/GET \/me\/accounts/, 400, { message: 'no', code: 190 }), 'graph_failed'],
        ['nothing was granted', () => { graph.granted = []; }, 'not_tester'],
        ['a core permission was declined', () => { graph.granted = LOGIN_SCOPES.filter((s) => s !== 'pages_manage_metadata'); }, 'permissions_missing'],
        ['the user manages no Page', () => { graph.pages = []; }, 'no_pages'],
        ['the token is not a PAGE token', () => graph.inspections.set(page(1).access_token!, { type: 'USER' }), 'token_invalid'],
        ['the Meta app is not configured', () => { delete process.env.META_APP_SECRET; }, 'not_configured'],
        ['the encryption key is missing, so a Page token cannot be stored', () => { delete process.env.TOKEN_ENCRYPTION_KEY; }, 'encryption_unavailable'],
    ] as Array<[string, () => unknown, string]>) {
        it(`returns reason ${reason} when ${name}, connecting nothing`, async () => {
            graph.pages = [page(1)];
            const { nonce, cookie } = await begin();
            setup();
            const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
            assert.equal(r.outcome, 'error');
            assert.equal(r.reason, reason);
            assert.equal(db.creators.get(TENANT)!.page_access_token, null);
            assert.equal(graph.called(/POST .*subscribed_apps/).length, 0);
        });
    }

    it('returns page_in_use when another tenant holds the Page, and never touches that tenant\'s webhook', async () => {
        const p = page(1);
        graph.pages = [p];
        db.addCreator(OTHER_TENANT, { name: 'Competitor', facebook_page_id: p.id, instagram_page_id: p.instagram_business_account!.id, page_access_token: 'enc:v1:x:y:z' });
        const { nonce, cookie } = await begin();
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.reason, 'page_in_use');
        assert.equal(graph.called(/subscribed_apps/).length, 0);
        assert.ok(!r.location.includes('Competitor'));
    });

    it('returns exchange_failed for a failure that is not Meta\'s, and logs it', async () => {
        graph.pages = [page(1)];
        const { nonce, cookie } = await begin();
        db.failOn = /FROM creators WHERE id = \$1/;
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.outcome, 'error');
        assert.equal(r.reason, 'exchange_failed');
        assert.equal(r.route, '#/settings');
        assert.ok(logs.some((l) => /meta\.oauth_callback_failed/.test(l)));
        assert.equal(graph.calls.length, 0);
    });

    it('refuses when the operator has switched Connect with Facebook off, and spends the state', async () => {
        db.settings.delete(APP_SETTING_KEYS.metaLoginEnabled);
        const { nonce, cookie } = await begin({ returnTo: 'welcome' });
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.reason, 'disabled');
        assert.equal(r.route, '#/welcome');
        assert.equal(graph.calls.length, 0);
    });

    it('refuses when no public base URL is saved: the redirect URI cannot be built, and is not taken from the request', async () => {
        db.settings.delete(APP_SETTING_KEYS.publicBaseUrl);
        const { nonce, cookie } = await begin();
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.reason, 'no_base_url');
        assert.equal(graph.calls.length, 0);
    });

    it('exchanges the code with the saved base URL\'s redirect URI, not the Host it was reached on', async () => {
        graph.pages = [page(1)];
        const { nonce, cookie } = await begin();
        await callback(`code=${CODE}&state=${nonce}`, cookie);
        const exchange = graph.called(/GET \/oauth\/access_token/)[0]!;
        assert.equal(exchange.params?.redirect_uri, `${BASE}/api/meta/callback`);
        assert.ok(!String(exchange.params?.redirect_uri).includes('127.0.0.1'));
    });
});

describe('GET /api/meta/callback: a connection that exists is never overwritten by accident', () => {
    it('refuses to connect over the owner\'s tenant without an explicit reconnect, asking Meta nothing and changing nothing', async () => {
        await connectOwnerTenant();
        graph.pages = [page(1)];
        const before = db.snapshotCreators();
        const { nonce, cookie } = await begin({ creatorId: OWNER_TENANT });

        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.outcome, 'error');
        assert.equal(r.reason, 'already_connected');
        assert.equal(graph.calls.length, 0, 'the code is not even exchanged');
        assert.equal(db.snapshotCreators(), before, 'his connection is byte-identical');
        assert.ok(!everywhere().includes(OWNER_TOKEN_PLAIN));
    });

    it('with an explicit reconnect to a DIFFERENT Page, asks for confirmation instead of replacing anything', async () => {
        await connectOwnerTenant();
        graph.pages = [page(1)];
        const before = db.snapshotCreators();
        const { nonce, cookie } = await begin({ creatorId: OWNER_TENANT, reconnect: true });

        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.outcome, 'pick', 'asked, not connected');
        assert.equal(db.snapshotCreators(), before, 'the connection is untouched until the owner confirms');
        assert.equal(graph.called(/subscribed_apps/).length, 0, 'and the webhook was not re-subscribed or changed');
    });

    it('cannot be reconnected by a state that was minted without the reconnect, whatever the callback is told', async () => {
        await connectOwnerTenant();
        const before = db.snapshotCreators();
        const { nonce, cookie } = await begin({ creatorId: OWNER_TENANT, reconnect: false });
        const r = await callback(`code=${CODE}&state=${nonce}&reconnect=true&reconnect=1`, cookie);
        assert.equal(r.reason, 'already_connected', 'a query parameter is not an intent: only the state\'s payload is');
        assert.equal(db.snapshotCreators(), before);
    });
});

describe('secrets never leave', () => {
    it('keeps every token, the code and the app secret out of redirects, cookies, logs, stored rows and audit rows', async () => {
        const p = page(1);
        graph.pages = [p];
        graph.fail(/POST .*subscribed_apps/, 400, { message: `Requires permission for token ${p.access_token} and code ${CODE}`, code: 200 });
        const { nonce, cookie } = await begin();
        const ok = await callback(`code=${CODE}&state=${nonce}`, cookie);

        graph.pages = [page(2), page(3)];
        const second = await begin();
        const pick = await callback(`code=${CODE}&state=${second.nonce}`, second.cookie);

        graph.fail(/GET \/me\/permissions/, 400, { message: `Invalid token ${graph.longToken}`, code: 190 });
        const third = await begin();
        const failed = await callback(`code=${CODE}&state=${third.nonce}`, third.cookie);

        const secrets = [p.access_token!, page(2).access_token!, page(3).access_token!, graph.shortToken, graph.longToken, CODE, process.env.META_APP_SECRET!];
        const visible = [ok, pick, failed].map((r) => r.location + r.setCookie).join('\n');
        const hay = everywhere([visible]);
        for (const secret of secrets) assert.ok(!hay.includes(secret), `leaked: ${secret.slice(0, 12)}…`);
    });
});

describe('secrets never leave: choosing and disconnecting', () => {
    it('keeps the Page tokens out of every response, log line, stored row and audit row, from the pick to the disconnect', async () => {
        graph.pages = [page(1), page(2)];
        const { nonce, cookie } = await begin();
        const picked = await callback(`code=${CODE}&state=${nonce}`, cookie);
        const pick = picked.params.get('pick')!;

        const list = await api('GET', `/candidates?pick=${pick}`);
        const select = await api('POST', '/select', { body: { pick, pageId: '200000000000002' } });
        const connection = await api('GET', '/connection');
        const disconnect = await api('POST', '/disconnect', { body: { confirm: true } });
        assert.equal(disconnect.status, 200);

        const secrets = [page(1).access_token!, page(2).access_token!, graph.shortToken, graph.longToken, CODE, process.env.META_APP_SECRET!];
        const responses = [picked.location, list.text, select.text, connection.text, disconnect.text].join('\n');
        const hay = everywhere([responses]);
        for (const secret of secrets) assert.ok(!hay.includes(secret), `leaked: ${secret.slice(0, 12)}…`);
        assert.ok(db.audit.length >= 2 && db.audit.every((a) => !/EAA|enc:v1/.test(a.detail)));
    });
});

// ─── Starting a connection ──────────────────────────────────────────────────────────────

describe('POST /api/meta/connect', () => {
    it('mints a state, sets the cookie, and returns the Login dialog URL', async () => {
        const r = await api('POST', '/connect', { body: { returnTo: 'welcome' } });
        assert.equal(r.status, 200);
        const url = new URL(r.json.url);
        assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
        assert.equal(url.searchParams.get('client_id'), '111222333444555');
        assert.equal(url.searchParams.get('redirect_uri'), `${BASE}/api/meta/callback`);
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('scope'), LOGIN_SCOPES.join(','), 'no configuration id saved: a scope list');

        const state = url.searchParams.get('state')!;
        const row = db.oauth.find((o) => o.nonce === state)!;
        assert.equal(row.platform, 'meta');
        assert.equal(row.creator_id, TENANT);
        assert.equal(row.user_id, USER);
        assert.equal(row.return_to, 'welcome');
        assert.deepEqual(JSON.parse(decryptSecret(row.payload!)), { v: 1, reconnect: false });

        assert.equal(r.setCookie, `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/api/meta/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
        assert.ok(!r.text.includes(process.env.META_APP_SECRET!));
    });

    it('uses the saved configuration id when there is one (and the env fallback otherwise)', async () => {
        db.settings.set(APP_SETTING_KEYS.metaLoginConfigId, '987654321098765');
        const url = new URL((await api('POST', '/connect')).json.url);
        assert.equal(url.searchParams.get('config_id'), '987654321098765');
        assert.equal(url.searchParams.get('scope'), null);

        db.settings.delete(APP_SETTING_KEYS.metaLoginConfigId);
        process.env.META_LOGIN_CONFIG_ID = '123456789012345';
        assert.equal(new URL((await api('POST', '/connect')).json.url).searchParams.get('config_id'), '123456789012345');
    });

    it('builds the redirect URI from the saved base URL, not from the Host header it was asked on', async () => {
        const r = await api('POST', '/connect', { headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' } });
        assert.equal(new URL(r.json.url).searchParams.get('redirect_uri'), `${BASE}/api/meta/callback`);
    });

    it('asks for a reconnect with auth_type, and remembers the reconnect in the state', async () => {
        await completeMetaConnection({
            creatorId: TENANT, userId: USER, metaUserId: '1', reconnect: false,
            choice: { pageId: '200000000000001', name: 'P', accessToken: page(1).access_token!, igId: '17841400000000001', igUsername: 'p' },
        });
        const refused = await api('POST', '/connect');
        assert.equal(refused.status, 409);
        assert.equal(refused.json.code, 'ALREADY_CONNECTED');
        assert.equal(db.oauth.filter((o) => o.platform === 'meta').length, 0, 'no state was minted for a refused connect');

        const r = await api('POST', '/connect', { body: { reconnect: true, authType: 'reauthorize' } });
        assert.equal(r.status, 200);
        const url = new URL(r.json.url);
        assert.equal(url.searchParams.get('auth_type'), 'reauthorize');
        const row = db.oauth.find((o) => o.nonce === url.searchParams.get('state'))!;
        assert.deepEqual(JSON.parse(decryptSecret(row.payload!)), { v: 1, reconnect: true });
    });

    it('is switched off by default, and says so with a code', async () => {
        db.settings.delete(APP_SETTING_KEYS.metaLoginEnabled);
        const r = await api('POST', '/connect');
        assert.equal(r.status, 409);
        assert.equal(r.json.code, 'META_LOGIN_DISABLED');
        assert.equal(db.oauth.length, 0);
    });

    it('needs the Meta app and the public base URL', async () => {
        delete process.env.META_APP_SECRET;
        assert.equal((await api('POST', '/connect')).json.code, 'NOT_CONFIGURED');
        process.env.META_APP_SECRET = 'the-app-secret-0123456789-never-in-a-log';
        db.settings.delete(APP_SETTING_KEYS.publicBaseUrl);
        assert.equal((await api('POST', '/connect')).json.code, 'NO_BASE_URL');
    });

    it('rejects a returnTo or authType it does not know', async () => {
        assert.equal((await api('POST', '/connect', { body: { returnTo: 'elsewhere' } })).status, 400);
        assert.equal((await api('POST', '/connect', { body: { authType: 'reauthenticate' } })).status, 400);
    });

    it('is for the tenant\'s owner only', async () => {
        for (const tenantRole of ['operator', 'viewer'] as const) {
            const r = await api('POST', '/connect', { session: { ...OWNER_SESSION, tenantRole } });
            assert.equal(r.status, 403, tenantRole);
        }
        assert.equal(db.oauth.length, 0);
    });
});

// ─── The Page pick ──────────────────────────────────────────────────────────────────────

describe('GET /api/meta/candidates and POST /api/meta/select', () => {
    /** Two usable Pages, one with no Instagram account, and one the user cannot run; a pick for the owner session. */
    async function twoPages(over: { reconnect?: boolean } = {}) {
        graph.pages = [page(1), page(2), page(3, { ig: false }), page(4, { tasks: ['ANALYZE'] })];
        const { nonce, cookie } = await begin({ reconnect: over.reconnect });
        const r = await callback(`code=${CODE}&state=${nonce}`, cookie);
        assert.equal(r.outcome, 'pick');
        return r.params.get('pick')!;
    }

    it('lists names and ids and why a Page is disabled, and never a token', async () => {
        const pick = await twoPages();
        const r = await api('GET', `/candidates?pick=${pick}`);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.candidates.map((c: any) => [c.pageId, c.usable, c.reason, c.instagram?.username ?? null]), [
            ['200000000000001', true, null, 'page1'],
            ['200000000000002', true, null, 'page2'],
            ['200000000000003', true, null, null],
            ['200000000000004', false, 'no_role', 'page4'],
        ]);
        assert.equal(r.json.connectedAs.name, 'Test Owner');
        assert.ok(!/EAA|access_token|token/i.test(r.text.replace(/"expiresAt"/g, '')), 'no token, and no field named for one');
        assert.ok(r.json.candidates.every((c: any) => c.replaces === false));
    });

    it('is not there for another tenant, another user, a made-up pick or a malformed one: 404, so existence is not disclosed', async () => {
        const pick = await twoPages();
        for (const session of [
            { ...OWNER_SESSION, tenantId: OTHER_TENANT },
            { ...OWNER_SESSION, userId: OTHER_USER },
            { ...OWNER_SESSION, userId: null },
        ]) {
            const r = await api('GET', `/candidates?pick=${pick}`, { session });
            assert.equal(r.status, 404, JSON.stringify(session));
            assert.deepEqual(r.json, { error: 'Not found.' });
        }
        assert.equal((await api('GET', `/candidates?pick=${'z'.repeat(43)}`)).status, 404);
        assert.equal((await api('GET', `/candidates?pick=x`)).status, 404);
        assert.equal((await api('GET', `/candidates`)).status, 404);
    });

    it('is for the tenant\'s owner only', async () => {
        const pick = await twoPages();
        assert.equal((await api('GET', `/candidates?pick=${pick}`, { session: { ...OWNER_SESSION, tenantRole: 'viewer' } })).status, 403);
        assert.equal((await api('POST', '/select', { session: { ...OWNER_SESSION, tenantRole: 'operator' }, body: { pick, pageId: '200000000000001' } })).status, 403);
    });

    it('connects the chosen Page and NULLS the pick\'s payload at the moment of the choice', async () => {
        const pick = await twoPages();
        assert.ok(db.oauth.find((o) => o.nonce === pick)!.payload, 'the pick holds the Pages until a choice is made');

        const r = await api('POST', '/select', { body: { pick, pageId: '200000000000002' } });
        assert.equal(r.status, 200);
        assert.equal(r.json.success, true);
        assert.equal(r.json.result.pageId, '200000000000002');
        assert.equal(r.json.result.webhookSubscribed, true);

        const row = db.oauth.find((o) => o.nonce === pick)!;
        assert.equal(row.payload, null, 'the Page tokens are gone from the table');
        assert.ok(row.used_at);
        assert.equal(db.creators.get(TENANT)!.facebook_page_id, '200000000000002');
        assert.equal(db.creators.get(TENANT)!.meta_user_id, '90001');
        assert.deepEqual(graph.called(/POST .*subscribed_apps/).map((c) => c.path), ['/200000000000002/subscribed_apps'], 'only the chosen Page was subscribed');
        assert.ok(!r.text.includes('EAA'));
    });

    it('is spent by the choice: a second select, or a read, finds nothing', async () => {
        const pick = await twoPages();
        assert.equal((await api('POST', '/select', { body: { pick, pageId: '200000000000001' } })).status, 200);
        const again = await api('POST', '/select', { body: { pick, pageId: '200000000000002' } });
        assert.equal(again.status, 404);
        assert.equal(again.json.code, 'PICK_EXPIRED');
        assert.equal((await api('GET', `/candidates?pick=${pick}`)).status, 404);
        assert.equal(db.creators.get(TENANT)!.facebook_page_id, '200000000000001', 'the first choice stands');
    });

    it('lets only one of two simultaneous choices connect', async () => {
        const pick = await twoPages();
        const [a, b] = await Promise.all([
            api('POST', '/select', { body: { pick, pageId: '200000000000001' } }),
            api('POST', '/select', { body: { pick, pageId: '200000000000002' } }),
        ]);
        assert.deepEqual([a.status, b.status].sort(), [200, 404]);
        assert.equal(graph.called(/POST .*subscribed_apps/).length, 1);
    });

    it('cannot be used from another tenant\'s or another user\'s session', async () => {
        const pick = await twoPages();
        db.addCreator(OTHER_TENANT, { name: 'Other' });
        for (const session of [{ ...OWNER_SESSION, tenantId: OTHER_TENANT }, { ...OWNER_SESSION, userId: OTHER_USER }]) {
            const r = await api('POST', '/select', { session, body: { pick, pageId: '200000000000001' } });
            assert.equal(r.status, 404);
        }
        assert.ok(db.oauth.find((o) => o.nonce === pick)!.payload, 'and the attempts took nothing from the pick');
        assert.equal(db.creators.get(OTHER_TENANT)!.page_access_token, null);
    });

    it('refuses a Page the user cannot run, or one that is not on the list, and leaves the pick standing', async () => {
        const pick = await twoPages();
        const noRole = await api('POST', '/select', { body: { pick, pageId: '200000000000004' } });
        assert.equal(noRole.status, 400);
        assert.equal(noRole.json.code, 'PAGE_UNUSABLE');
        assert.equal((await api('POST', '/select', { body: { pick, pageId: '999999999' } })).json.code, 'PAGE_UNUSABLE');
        assert.equal((await api('POST', '/select', { body: { pick, pageId: 'not-an-id' } })).json.code, 'PAGE_UNUSABLE');
        assert.ok(db.oauth.find((o) => o.nonce === pick)!.payload, 'a mistake costs nothing');
        assert.equal((await api('POST', '/select', { body: { pick, pageId: '200000000000001' } })).status, 200);
    });

    it('needs Facebook-only to be asked for when the Page has no Instagram account', async () => {
        const pick = await twoPages();
        const refused = await api('POST', '/select', { body: { pick, pageId: '200000000000003' } });
        assert.equal(refused.status, 400);
        assert.equal(refused.json.code, 'INSTAGRAM_NOT_LINKED');
        assert.ok(db.oauth.find((o) => o.nonce === pick)!.payload);

        const ok = await api('POST', '/select', { body: { pick, pageId: '200000000000003', facebookOnly: true } });
        assert.equal(ok.status, 200);
        assert.equal(db.creators.get(TENANT)!.instagram_page_id, null);
        assert.equal(db.creators.get(TENANT)!.facebook_page_id, '200000000000003');
    });

    it('refuses a Page another tenant holds with a 409, and leaves the pick standing for another choice', async () => {
        const pick = await twoPages();
        const taken = page(1);
        db.addCreator(OTHER_TENANT, { name: 'Competitor', facebook_page_id: taken.id, instagram_page_id: taken.instagram_business_account!.id, page_access_token: 'enc:v1:x:y:z' });
        const r = await api('POST', '/select', { body: { pick, pageId: taken.id } });
        assert.equal(r.status, 409);
        assert.equal(r.json.code, 'PAGE_IN_USE');
        assert.ok(!/Competitor/.test(r.text), 'the other tenant is not named');
        assert.ok(db.oauth.find((o) => o.nonce === pick)!.payload, 'not spent: the person can choose another');
        assert.equal(graph.called(/POST .*subscribed_apps/).length, 0);

        assert.equal((await api('POST', '/select', { body: { pick, pageId: '200000000000002' } })).status, 200);
    });

    it('asks for confirmation to replace a connected Page, flagging it in the list, and spends nothing until it is given', async () => {
        await completeMetaConnection({
            creatorId: TENANT, userId: USER, metaUserId: '1', reconnect: false,
            choice: { pageId: '200000000000001', name: 'Page 1', accessToken: page(1).access_token!, igId: '17841400000000001', igUsername: 'page1' },
        });
        const pick = await twoPages({ reconnect: true });

        const list = await api('GET', `/candidates?pick=${pick}`);
        assert.deepEqual(list.json.current, { pageId: '200000000000001', instagramId: '17841400000000001', pageName: 'Page 1' });
        assert.deepEqual(list.json.candidates.map((c: any) => c.replaces), [false, true, true, true]);

        const refused = await api('POST', '/select', { body: { pick, pageId: '200000000000002' } });
        assert.equal(refused.status, 409);
        assert.equal(refused.json.code, 'PAGE_CHANGE_UNCONFIRMED');
        assert.equal(db.creators.get(TENANT)!.facebook_page_id, '200000000000001');
        assert.ok(db.oauth.find((o) => o.nonce === pick)!.payload, 'the pick stands');

        const ok = await api('POST', '/select', { body: { pick, pageId: '200000000000002', confirmPageChange: true } });
        assert.equal(ok.status, 200);
        assert.equal(ok.json.result.replaced, true);
        assert.equal(db.creators.get(TENANT)!.facebook_page_id, '200000000000002');
    });

    it('spends the pick when Meta then refuses the token: the person starts again, and no token is left behind', async () => {
        const pick = await twoPages();
        graph.inspections.set(page(2).access_token!, { type: 'USER' });
        const r = await api('POST', '/select', { body: { pick, pageId: '200000000000002' } });
        assert.equal(r.status, 400);
        assert.equal(r.json.code, 'TOKEN_INVALID');
        assert.equal(db.oauth.find((o) => o.nonce === pick)!.payload, null);
        assert.equal(db.creators.get(TENANT)!.page_access_token, null);
        assert.ok(!r.text.includes('EAA'));
    });

    it('answers a pick that expired with a code the UI can act on', async () => {
        const pick = await twoPages();
        db.now += 11 * 60_000;
        const r = await api('POST', '/select', { body: { pick, pageId: '200000000000001' } });
        assert.equal(r.status, 404);
        assert.equal(r.json.code, 'PICK_EXPIRED');
    });
});

// ─── Reading and removing ───────────────────────────────────────────────────────────────

describe('GET /api/meta/connection', () => {
    it('is readable by any member, and says whether Connect is on, the app is set up and the tenant is connected', async () => {
        const r = await api('GET', '/connection', { session: { ...OWNER_SESSION, tenantRole: 'viewer' } });
        assert.equal(r.status, 200);
        assert.equal(r.json.enabled, true);
        assert.equal(r.json.appConfigured, true);
        assert.equal(r.json.redirectUriConfigured, true);
        assert.equal(r.json.usesConfiguration, false);
        assert.equal(r.json.connection.connected, false);
        assert.equal(r.json.connection.via, null);
    });

    it('never carries a token, for a connected tenant', async () => {
        await connectOwnerTenant();
        const r = await api('GET', '/connection', { session: { ...OWNER_SESSION, tenantId: OWNER_TENANT } });
        assert.equal(r.json.connection.connected, true);
        assert.equal(r.json.connection.via, 'token');
        assert.ok(!r.text.includes(OWNER_TOKEN_PLAIN) && !r.text.includes('enc:v1'));
    });

    it('answers 404 for a tenant that does not exist', async () => {
        assert.equal((await api('GET', '/connection', { session: { ...OWNER_SESSION, tenantId: OTHER_TENANT } })).status, 404);
    });
});

describe('POST /api/meta/disconnect', () => {
    beforeEach(async () => {
        await completeMetaConnection({
            creatorId: TENANT, userId: USER, metaUserId: '1', reconnect: false,
            choice: { pageId: '200000000000001', name: 'Page 1', accessToken: page(1).access_token!, igId: '17841400000000001', igUsername: 'page1' },
        });
        graph.calls.length = 0;
    });

    it('needs an explicit confirmation, so a stray request cannot empty a connection', async () => {
        const before = db.snapshotCreators();
        for (const body of [undefined, {}, { confirm: 'true' }, { confirm: 1 }, { confirm: false }]) {
            const r = await api('POST', '/disconnect', { body });
            assert.equal(r.status, 400);
            assert.equal(r.json.code, 'CONFIRMATION_REQUIRED');
        }
        assert.equal(db.snapshotCreators(), before);
        assert.equal(graph.calls.length, 0);
    });

    it('unsubscribes the Page and deletes the ids and the token', async () => {
        const r = await api('POST', '/disconnect', { body: { confirm: true } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { success: true, unsubscribedFromWebhook: true });
        assert.equal(graph.called(/DELETE \/200000000000001\/subscribed_apps/).length, 1);
        const row = db.creators.get(TENANT)!;
        assert.deepEqual([row.page_access_token, row.instagram_page_id, row.facebook_page_id], [null, null, null]);
        assert.ok(db.audit.some((a) => a.action === 'meta.disconnect'));
    });

    it('says so when there is nothing to disconnect', async () => {
        await api('POST', '/disconnect', { body: { confirm: true } });
        const again = await api('POST', '/disconnect', { body: { confirm: true } });
        assert.equal(again.status, 404);
        assert.equal(again.json.code, 'NOT_CONNECTED');
    });

    it('is for the tenant\'s owner only', async () => {
        const before = db.snapshotCreators();
        for (const tenantRole of ['operator', 'viewer'] as const) {
            assert.equal((await api('POST', '/disconnect', { session: { ...OWNER_SESSION, tenantRole }, body: { confirm: true } })).status, 403);
        }
        assert.equal(db.snapshotCreators(), before);
    });
});

// ─── Operator settings ──────────────────────────────────────────────────────────────────

describe('GET and POST /api/meta/app-settings', () => {
    const ADMIN_SESSION: Session = { userId: ADMIN, role: 'platform_admin', tenantId: TENANT, tenantRole: 'owner' };

    it('is for a platform admin only: a tenant owner gets a 404', async () => {
        assert.equal((await api('GET', '/app-settings')).status, 404);
        assert.equal((await api('POST', '/app-settings', { body: { enabled: true } })).status, 404);
        assert.equal((await api('GET', '/app-settings', { session: null })).status, 404);
    });

    it('reports the switch, the configuration id, the redirect URI and the Deauthorize Callback URL to register, and the scopes, with no secret', async () => {
        db.settings.set(APP_SETTING_KEYS.metaLoginConfigId, '987654321098765');
        const r = await api('GET', '/app-settings', { session: ADMIN_SESSION });
        assert.equal(r.status, 200);
        assert.equal(r.json.enabled, true);
        assert.deepEqual(r.json.configId, { set: true, source: 'database', value: '987654321098765' });
        assert.equal(r.json.mode, 'configuration');
        assert.deepEqual(r.json.register, { redirectUri: `${BASE}/api/meta/callback`, deauthorizeUrl: `${BASE}/api/meta/deauthorize` });
        assert.deepEqual(r.json.scopes, [...LOGIN_SCOPES]);
        assert.deepEqual(r.json.webhookFields, ['feed', 'messages', 'messaging_postbacks', 'messaging_referrals']);
        assert.deepEqual(r.json.app, { idSet: true, secretSet: true });
        assert.ok(!r.text.includes(process.env.META_APP_SECRET!));
    });

    it('is off by default', async () => {
        db.settings.delete(APP_SETTING_KEYS.metaLoginEnabled);
        const r = await api('GET', '/app-settings', { session: ADMIN_SESSION });
        assert.equal(r.json.enabled, false);
        assert.equal(r.json.mode, 'scope');
    });

    it('saves the switch and the configuration id, and writes an audit row naming the fields, not the id', async () => {
        db.settings.delete(APP_SETTING_KEYS.metaLoginEnabled);
        const r = await api('POST', '/app-settings', { session: ADMIN_SESSION, body: { enabled: true, configId: ' 987654321098765 ' } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.changed, ['enabled', 'config_id']);
        assert.equal(db.settings.get(APP_SETTING_KEYS.metaLoginEnabled), 'true');
        assert.equal(db.settings.get(APP_SETTING_KEYS.metaLoginConfigId), '987654321098765');

        const audit = db.audit.find((a) => a.action === 'settings.meta_login_write')!;
        assert.deepEqual(JSON.parse(audit.detail), { fields: ['enabled', 'config_id'], enabled: true });
        assert.equal(audit.actor_user_id, ADMIN);
    });

    it('clears the id with an empty string and the switch with false, so the defaults come back', async () => {
        db.settings.set(APP_SETTING_KEYS.metaLoginConfigId, '987654321098765');
        const r = await api('POST', '/app-settings', { session: ADMIN_SESSION, body: { enabled: false, configId: '' } });
        assert.equal(r.status, 200);
        assert.equal(db.settings.has(APP_SETTING_KEYS.metaLoginEnabled), false);
        assert.equal(db.settings.has(APP_SETTING_KEYS.metaLoginConfigId), false);
    });

    it('rejects what is not a configuration id, a boolean, or anything at all', async () => {
        for (const body of [{ configId: 'abc' }, { configId: '12' }, { configId: '1'.repeat(31) }, { configId: 12345678 }, { enabled: 'yes' }, {}]) {
            const r = await api('POST', '/app-settings', { session: ADMIN_SESSION, body });
            assert.equal(r.status, 400, JSON.stringify(body));
        }
        assert.equal(db.audit.length, 0);
    });
});

// ─── The wizard's test comment ──────────────────────────────────────────────────────────

describe('GET /api/meta/comment-check', () => {
    const IG = '17841400000000001';
    const FB = '200000000000001';
    const SECRET_TEXT = 'a comment nobody asked the check to repeat';
    const minutesAgo = (n: number): Date => new Date(Date.now() - n * 60_000);

    /** A tenant that connected with Login 30 minutes ago: it holds an Instagram account and a Page. */
    function connected(over: { id?: string; ig?: string; fb?: string; at?: Date | null } = {}): void {
        db.addCreator(over.id ?? TENANT, {
            name: 'New Tenant', instagram_page_id: over.ig ?? IG, facebook_page_id: over.fb ?? FB,
            page_access_token: 'enc:v1:stored', meta_connected_at: over.at === undefined ? minutesAgo(30) : over.at,
        });
    }
    /** What the webhook writes: `creator_id` NULL, the Meta id the delivery was addressed to in `tenant_key`. */
    const job = (over: Partial<{ kind: string; creator_id: string | null; tenant_key: string | null; created_at: Date }> = {}) => {
        db.jobs.push({
            kind: 'comment.process', creator_id: null, tenant_key: IG, created_at: minutesAgo(5),
            payload: { change: { value: { text: SECRET_TEXT } } }, ...over,
        });
    };
    const check = (session: Session | null = OWNER_SESSION, query = '') => api('GET', `/comment-check${query}`, { session });

    it('says "not connected" for a tenant with no Meta connection, and does not even look at the queue', async () => {
        job();
        const r = await check();
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { connected: false, since: null, received: false, count: 0, latestAt: null });
        assert.equal(db.statements.filter((s) => /FROM jobs/.test(s.sql)).length, 0);
    });

    it('waits while nothing has arrived, and turns green when a comment job for this tenant does', async () => {
        connected();
        const waiting = await check();
        assert.equal(waiting.json.connected, true);
        assert.equal(waiting.json.received, false);
        assert.equal(waiting.json.count, 0);
        assert.equal(waiting.json.latestAt, null);

        job({ created_at: minutesAgo(5) });
        const green = await check();
        assert.equal(green.json.received, true);
        assert.equal(green.json.count, 1);
        assert.ok(Math.abs(new Date(green.json.latestAt).getTime() - minutesAgo(5).getTime()) < 5_000, 'the latest job\'s time');
    });

    it('finds the job by the Meta id it was addressed to, for an Instagram comment and for a Facebook one', async () => {
        connected();
        job({ tenant_key: IG });
        job({ tenant_key: FB });
        assert.equal((await check()).json.count, 2);
    });

    it('also finds a job that names the tenant itself, should the webhook ever start filling that in', async () => {
        connected();
        job({ tenant_key: null, creator_id: TENANT });
        assert.equal((await check()).json.received, true);
    });

    it('counts only comment jobs: not a DM, not anything else in the queue', async () => {
        connected();
        job({ kind: 'dm.process' });
        job({ kind: 'monteur.sweep' });
        assert.equal((await check()).json.received, false);
    });

    it('counts only what arrived AFTER the connection: an older comment is not proof', async () => {
        connected({ at: minutesAgo(30) });
        job({ created_at: minutesAgo(31) });
        job({ created_at: minutesAgo(600) });
        assert.equal((await check()).json.received, false);
        job({ created_at: minutesAgo(29) });
        assert.equal((await check()).json.count, 1);
    });

    it('for a connection with no recorded time (a pasted token), counts the last day only', async () => {
        connected({ at: null });
        job({ created_at: minutesAgo(3 * 24 * 60) });
        assert.equal((await check()).json.received, false);
        job({ created_at: minutesAgo(120) });
        const r = await check();
        assert.equal(r.json.count, 1);
        assert.ok(Date.now() - new Date(r.json.since).getTime() < 24 * 3_600_000 + 5_000, 'the window is a day');
    });

    it('is scoped to the session\'s tenant: another tenant\'s comments are never counted, and nothing in the request can say otherwise', async () => {
        connected();
        db.addCreator(OTHER_TENANT, {
            name: 'Other', instagram_page_id: '17841400000000099', facebook_page_id: '200000000000099',
            page_access_token: 'enc:v1:other', meta_connected_at: minutesAgo(30),
        });
        job({ tenant_key: '17841400000000099' });
        job({ tenant_key: '200000000000099' });
        job({ tenant_key: null, creator_id: OTHER_TENANT });

        const mine = await check(OWNER_SESSION, `?creatorId=${OTHER_TENANT}&tenantId=${OTHER_TENANT}&tenant_key=17841400000000099`);
        assert.equal(mine.json.received, false, 'a query string cannot point the check at another tenant');
        assert.equal(mine.json.count, 0);

        const theirs = await check({ ...OWNER_SESSION, tenantId: OTHER_TENANT }, `?creatorId=${TENANT}`);
        assert.equal(theirs.json.count, 3, 'and they see only their own');
    });

    it('returns a count and a time, never what a comment said', async () => {
        connected();
        job();
        const r = await check();
        assert.deepEqual(Object.keys(r.json).sort(), ['connected', 'count', 'latestAt', 'received', 'since']);
        assert.ok(!r.text.includes(SECRET_TEXT));
    });

    it('is for an operator and above: a viewer is refused', async () => {
        connected();
        assert.equal((await check({ ...OWNER_SESSION, tenantRole: 'viewer' })).status, 403);
        assert.equal((await check({ ...OWNER_SESSION, tenantRole: 'operator' })).status, 200);
        assert.equal((await check({ ...OWNER_SESSION, tenantRole: 'owner' })).status, 200);
    });

    it('answers 404 for a tenant that does not exist', async () => {
        assert.equal((await check({ ...OWNER_SESSION, tenantId: OTHER_TENANT })).status, 404);
    });

    it('fails with a clear 500, and no detail, when the queue cannot be read', async () => {
        connected();
        db.failOn = /FROM jobs/;
        const r = await check();
        assert.equal(r.status, 500);
        assert.equal(r.json.error, 'Failed to check for the test comment.');
    });
});

// ─── The mount ──────────────────────────────────────────────────────────────────────────

describe('how the routes are mounted', () => {
    interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { minimumRole?: string } }> }; handle: unknown }

    const routes = (metaRouter as unknown as { stack: Layer[] }).stack
        .filter((l) => l.route)
        .map((l) => ({
            key: `${Object.keys(l.route!.methods)[0]!.toUpperCase()} ${l.route!.path}`,
            guard: l.route!.stack.map((s) => s.handle?.minimumRole).find((m): m is string => typeof m === 'string') ?? null,
        }));

    it('guards every mutating tenant route with the owner role, and every Page-pick route too', () => {
        const byKey = new Map(routes.map((r) => [r.key, r.guard]));
        for (const key of ['POST /connect', 'POST /select', 'POST /disconnect', 'GET /candidates']) {
            assert.equal(byKey.get(key), 'owner', `${key} must require an owner`);
        }
        const unguardedMutations = routes.filter((r) => !r.key.startsWith('GET ') && !r.guard && !r.key.endsWith('/app-settings'));
        assert.deepEqual(unguardedMutations, []);
    });

    it('leaves the connection summary readable by any member', () => {
        assert.equal(new Map(routes.map((r) => [r.key, r.guard])).get('GET /connection'), null);
    });

    it('guards the test-comment check with the operator role', () => {
        assert.equal(new Map(routes.map((r) => [r.key, r.guard])).get('GET /comment-check'), 'operator');
    });

    it('mounts the callback above requireAuth and the rest below resolveTenant on the API router', () => {
        const stack = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack.filter((l) => !l.route).map((l) => l.handle);
        const publicAt = stack.indexOf(metaPublicRouter);
        const privateAt = stack.indexOf(metaRouter);
        const authAt = stack.indexOf(requireAuth);
        const tenantAt = stack.indexOf(resolveTenant);
        assert.ok(publicAt >= 0 && privateAt >= 0 && authAt >= 0 && tenantAt >= 0, JSON.stringify({ publicAt, privateAt, authAt, tenantAt }));
        assert.ok(publicAt < authAt, 'the callback carries no session, so it sits above requireAuth');
        assert.ok(privateAt > tenantAt, 'everything else acts as the session\'s tenant');
    });
});
