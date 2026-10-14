/**
 * TikTok's and YouTube's connect flows come back to the setup wizard when the wizard began them (P28).
 *
 * `oauthFlows.test.ts` pins what these flows did before: the columns v18 gave `oauth_states`, and no others, so that a deployment
 * that runs ahead of its migration still connects them. That stays true for every flow that began in Settings (and for one the
 * wizard began, in the INSERT). What is new is exactly one extra statement, and only when the wizard asks:
 *
 *   - `POST /connect { returnTo: 'welcome' }` writes `return_to` APART from the v18 INSERT, and a failure of that write (no v35 column)
 *     is only a flow that returns to Settings, never one that does not connect;
 *   - the callbacks send the browser back to the wizard's connect step (`#/welcome?step=connect&tiktok=…`) for a flow that began
 *     there, after the state was spent or, for a cancelled dialog, once the cookie matched it; and to Settings otherwise, always
 *     when the callback cannot trust the browser or the state. The return address is read only from a state of the callback's own
 *     platform: a Meta state's `return_to` is not TikTok's.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { APP_SETTING_KEYS } from '../services/appSettings.js';
import { FakeDb } from '../services/metaLoginHarness.js';
import { createOAuthState } from '../services/oauthState.js';
import { tiktokHttp } from '../services/tiktok.js';
import { consumeOAuthState as consumeTikTok } from '../services/tiktokConnections.js';
import { youtubeHttp } from '../services/youtube.js';
import { consumeOAuthState as consumeYouTube } from '../services/youtubeConnections.js';
import { setLogSink } from '../utils/log.js';
import { STATE_COOKIE as TIKTOK_COOKIE, tiktokPublicRouter, tiktokRouter } from './tiktok.js';
import { STATE_COOKIE as YOUTUBE_COOKIE, youtubePublicRouter, youtubeRouter } from './youtube.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const BASE = 'https://autoreply.example';

let server: Server;
let origin: string;
let db: FakeDb;
let restoreSink: (() => void) | undefined;
let restoreHttp: (() => void) | undefined;
let savedKey: string | undefined;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/tiktok', tiktokPublicRouter);
    app.use('/api/youtube', youtubePublicRouter);
    app.use((req, _res, next) => {
        req.session = { userId: USER, role: 'user', tenantId: TENANT } as typeof req.session;
        req.tenantRole = 'owner';
        next();
    });
    app.use('/api/tiktok', tiktokRouter);
    app.use('/api/youtube', youtubeRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = '12'.repeat(32);
    db = new FakeDb().install();
    db.settings.set(APP_SETTING_KEYS.publicBaseUrl, BASE);
    db.settings.set(APP_SETTING_KEYS.tiktokClientKey, 'tt-client-key-123');
    db.settings.set(APP_SETTING_KEYS.tiktokClientSecret, 'tt-client-secret-1234567890');
    db.settings.set(APP_SETTING_KEYS.youtubeClientId, '123456789-abcdef.apps.googleusercontent.com');
    db.settings.set(APP_SETTING_KEYS.youtubeClientSecret, 'yt-client-secret-1234567890');
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);

    // The provider's token exchange, which no test here may reach: it fails at once, as a provider that refused the code would.
    const instances = [tiktokHttp, youtubeHttp] as unknown as Array<Record<string, unknown>>;
    const kept = instances.map((i) => ({ post: i.post, get: i.get, request: i.request }));
    for (const i of instances) for (const m of ['post', 'get', 'request']) i[m] = async () => { throw new Error('no network in this test'); };
    restoreHttp = () => instances.forEach((i, n) => Object.assign(i, kept[n]));
});

afterEach(() => {
    restoreHttp?.();
    restoreSink?.();
    db.restore();
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

async function callback(platform: 'tiktok' | 'youtube', query: string, cookie?: string) {
    const res = await fetch(`${origin}/api/${platform}/callback?${query}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const location = res.headers.get('location') ?? '';
    const hash = new URL(location, origin).hash;
    const params = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
    return { status: res.status, location, params, setCookie: res.headers.get('set-cookie') ?? '' };
}

async function connectAs(platform: 'tiktok' | 'youtube', body: unknown) {
    const res = await fetch(`${origin}/api/${platform}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json()) as { url?: string; error?: string };
    return { status: res.status, json, state: json.url ? new URL(json.url).searchParams.get('state')! : null };
}

const FLOWS = [
    { platform: 'tiktok' as const, cookie: TIKTOK_COOKIE, consume: consumeTikTok },
    { platform: 'youtube' as const, cookie: YOUTUBE_COOKIE, consume: consumeYouTube },
];

for (const flow of FLOWS) {
    describe(`${flow.platform}: coming back to the setup wizard`, () => {
        it('asks for it with returnTo: "welcome", keeping the v18 INSERT as it was and writing return_to in its own statement', async () => {
            const r = await connectAs(flow.platform, { returnTo: 'welcome' });
            assert.equal(r.status, 200);
            assert.equal(db.oauth.find((o) => o.nonce === r.state)!.return_to, 'welcome');
            const inserts = db.statements.filter((s) => /^INSERT INTO oauth_states/.test(s.sql));
            assert.equal(inserts[0]!.sql, 'INSERT INTO oauth_states (nonce, platform, creator_id, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)');
            const writes = db.statements.filter((s) => /SET return_to/.test(s.sql));
            assert.equal(writes.length, 1);
            assert.equal(writes[0]!.sql, 'UPDATE oauth_states SET return_to = $3 WHERE nonce = $1 AND platform = $2 AND used_at IS NULL');
            assert.deepEqual(writes[0]!.params, [r.state, flow.platform, 'welcome']);
        });

        it('writes nothing extra for Settings, whether it is asked for or left out: a deployment that has not run v35 still connects', async () => {
            for (const body of [{}, { returnTo: 'settings' }]) {
                db.statements.length = 0;
                const r = await connectAs(flow.platform, body);
                assert.equal(r.status, 200);
                assert.equal(db.oauth.find((o) => o.nonce === r.state)!.return_to, null);
                assert.equal(db.statements.filter((s) => /return_to|payload/.test(s.sql)).length, 0, JSON.stringify(body));
            }
        });

        it('still connects when the return_to column is missing: the flow then simply returns to Settings', async () => {
            db.failOn = /SET return_to/;
            const r = await connectAs(flow.platform, { returnTo: 'welcome' });
            assert.equal(r.status, 200, 'the connection is never put at risk by where it returns to');
            assert.ok(r.json.url);
            db.failOn = null;
            const cancelled = await callback(flow.platform, `error=access_denied&state=${r.state}`, `${flow.cookie}=${r.state}`);
            assert.match(cancelled.location, /^\/dashboard#\/settings\?/);
        });

        it('refuses a returnTo it does not know, minting no state', async () => {
            const r = await connectAs(flow.platform, { returnTo: 'elsewhere' });
            assert.equal(r.status, 400);
            assert.equal(db.oauth.length, 0);
        });

        it('sends a cancelled dialog back to the wizard\'s connect step, with the reason', async () => {
            const { state } = await connectAs(flow.platform, { returnTo: 'welcome' });
            const r = await callback(flow.platform, `error=access_denied&state=${state}`, `${flow.cookie}=${state}`);
            assert.equal(r.status, 302);
            assert.match(r.location, /^\/dashboard#\/welcome\?/);
            assert.equal(r.params.get('step'), 'connect');
            assert.equal(r.params.get(flow.platform), 'error');
            assert.equal(r.params.get('reason'), 'denied');
            assert.match(r.setCookie, /Max-Age=0/);
        });

        it('returns to the wizard when the provider\'s exchange fails after the state was spent', async () => {
            const { state } = await connectAs(flow.platform, { returnTo: 'welcome' });
            const r = await callback(flow.platform, `code=c1&state=${state}`, `${flow.cookie}=${state}`);
            assert.match(r.location, /^\/dashboard#\/welcome\?/);
            assert.equal(r.params.get('step'), 'connect');
            assert.equal(r.params.get(flow.platform), 'error');
            assert.equal(r.params.get('reason'), 'exchange_failed');
            assert.ok(db.oauth.find((o) => o.nonce === state)!.used_at, 'the state was spent');
        });

        it('returns a Settings flow to Settings, as it always did', async () => {
            const { state } = await connectAs(flow.platform, {});
            const r = await callback(flow.platform, `code=c1&state=${state}`, `${flow.cookie}=${state}`);
            assert.match(r.location, /^\/dashboard#\/settings\?/);
            assert.equal(r.params.get('step'), null);
            assert.equal(r.params.get(flow.platform), 'error');
        });

        it('goes to Settings whenever it cannot trust the browser or the state to say where the flow began', async () => {
            const { state } = await connectAs(flow.platform, { returnTo: 'welcome' });
            // No cookie, or somebody else's: the state may have been lifted from somewhere, and says nothing about this browser.
            assert.match((await callback(flow.platform, `error=access_denied&state=${state}`)).location, /^\/dashboard#\/settings\?/);
            assert.match((await callback(flow.platform, `error=access_denied&state=${state}`, `${flow.cookie}=another`)).location, /^\/dashboard#\/settings\?/);
            assert.match((await callback(flow.platform, `code=c1&state=${state}`, `${flow.cookie}=another`)).location, /^\/dashboard#\/settings\?/);
            assert.match((await callback(flow.platform, `state=${state}`, `${flow.cookie}=${state}`)).location, /^\/dashboard#\/settings\?/);
            // Spent: the state is no longer anybody's to complete.
            assert.ok(await flow.consume(state!));
            assert.match((await callback(flow.platform, `code=c1&state=${state}`, `${flow.cookie}=${state}`)).location, /^\/dashboard#\/settings\?/);
        });

        it('reads the return address only from a state of its own platform', async () => {
            const meta = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, returnTo: 'welcome', payload: { v: 1, reconnect: false } });
            const r = await callback(flow.platform, `error=access_denied&state=${meta}`, `${flow.cookie}=${meta}`);
            assert.match(r.location, /^\/dashboard#\/settings\?/, 'a Meta state\'s return_to is not this flow\'s');
        });
    });
}
