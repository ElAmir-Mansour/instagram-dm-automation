/**
 * The TikTok and YouTube connect flows, after their OAuth state moved into the shared module (P26).
 *
 * The move was meant to change nothing they do. What they do, in the parts the state module touches, is pinned here over real HTTP:
 * the cookie they set and clear, the state row they write (the columns v18 gave it and no others), the statements they issue, the
 * redirects they send, and the single-use / purpose / expiry rules. `tiktok.test.ts` keeps its own callback tests as they were;
 * YouTube had none, so they are written here.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { APP_SETTING_KEYS } from '../services/appSettings.js';
import { FakeDb } from '../services/metaLoginHarness.js';
import { createOAuthState } from '../services/oauthState.js';
import { consumeOAuthState as consumeTikTok } from '../services/tiktokConnections.js';
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

let savedKey: string | undefined;

beforeEach(() => {
    // Only the Meta state in the "another flow" test is encrypted; TikTok and YouTube never are.
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
});

afterEach(() => {
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

async function connect(platform: 'tiktok' | 'youtube') {
    const res = await fetch(`${origin}/api/${platform}/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return { status: res.status, json: (await res.json()) as { url: string }, setCookie: res.headers.get('set-cookie') ?? '' };
}

const FLOWS = [
    { platform: 'tiktok' as const, cookie: TIKTOK_COOKIE, consume: consumeTikTok, stateParam: 'state' },
    { platform: 'youtube' as const, cookie: YOUTUBE_COOKIE, consume: consumeYouTube, stateParam: 'state' },
];

for (const flow of FLOWS) {
    describe(`${flow.platform}: POST /api/${flow.platform}/connect`, () => {
        it('mints a state of the platform\'s own, with exactly the columns v18 gave oauth_states', async () => {
            const r = await connect(flow.platform);
            assert.equal(r.status, 200);
            const state = new URL(r.json.url).searchParams.get(flow.stateParam)!;
            const row = db.oauth.find((o) => o.nonce === state)!;
            assert.equal(row.platform, flow.platform);
            assert.equal(row.creator_id, TENANT);
            assert.equal(row.user_id, USER);
            assert.equal(row.return_to, null);
            assert.equal(row.payload, null);
            assert.ok(Math.abs(row.expires_at.getTime() - (Date.now() + 600_000)) < 5_000, 'ten minutes');

            const inserts = db.statements.filter((s) => /^INSERT INTO oauth_states/.test(s.sql));
            assert.equal(inserts.length, 1);
            assert.equal(inserts[0]!.sql, 'INSERT INTO oauth_states (nonce, platform, creator_id, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)');
            assert.equal(inserts[0]!.params[1], flow.platform);
        });

        it('sets the same cookie as ever: HttpOnly, Secure, Lax, scoped to the callback, ten minutes', async () => {
            const r = await connect(flow.platform);
            const state = new URL(r.json.url).searchParams.get(flow.stateParam)!;
            assert.equal(r.setCookie, `${flow.cookie}=${encodeURIComponent(state)}; Path=/api/${flow.platform}/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);
        });

        it('puts the saved base URL\'s callback in the authorise URL', async () => {
            const r = await connect(flow.platform);
            assert.equal(new URL(r.json.url).searchParams.get('redirect_uri'), `${BASE}/api/${flow.platform}/callback`);
        });

        it('never issues a statement that names a v35 column', async () => {
            await connect(flow.platform);
            for (const s of db.statements.filter((st) => /oauth_states/.test(st.sql))) assert.doesNotMatch(s.sql, /return_to|payload/);
        });
    });

    describe(`${flow.platform}: GET /api/${flow.platform}/callback`, () => {
        it('sends a cancelled consent screen back to Settings, touching nothing', async () => {
            const r = await callback(flow.platform, 'error=access_denied&state=abc');
            assert.equal(r.status, 302);
            assert.match(r.location, /^\/dashboard#\/settings\?/);
            assert.equal(r.params.get(flow.platform), 'error');
            assert.equal(r.params.get('reason'), 'denied');
            assert.equal(db.statements.length, 0);
        });

        it('needs a code and a state', async () => {
            assert.equal((await callback(flow.platform, 'state=abc')).params.get('reason'), 'missing_code');
            assert.equal((await callback(flow.platform, 'code=abc')).params.get('reason'), 'missing_code');
        });

        it('refuses a state with no matching cookie BEFORE spending it', async () => {
            const state = await createOAuthState({ purpose: flow.platform, creatorId: TENANT, userId: USER });
            const none = await callback(flow.platform, `code=c1&state=${state}`);
            assert.equal(none.params.get('reason'), 'state_mismatch');
            const wrong = await callback(flow.platform, `code=c1&state=${state}`, `${flow.cookie}=another`);
            assert.equal(wrong.params.get('reason'), 'state_mismatch');
            assert.equal(db.oauth.find((o) => o.nonce === state)!.used_at, null, 'not spent by the attempts');
        });

        it('refuses a state that was already used, one that expired, and one that was minted for another flow', async () => {
            const spent = await createOAuthState({ purpose: flow.platform, creatorId: TENANT, userId: USER });
            assert.ok(await flow.consume(spent));
            assert.equal((await callback(flow.platform, `code=c1&state=${spent}`, `${flow.cookie}=${spent}`)).params.get('reason'), 'state_expired');

            const old = await createOAuthState({ purpose: flow.platform, creatorId: TENANT, userId: USER });
            db.now += 11 * 60_000;
            assert.equal((await callback(flow.platform, `code=c1&state=${old}`, `${flow.cookie}=${old}`)).params.get('reason'), 'state_expired');

            const meta = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, payload: { v: 1, reconnect: true } });
            assert.equal((await callback(flow.platform, `code=c1&state=${meta}`, `${flow.cookie}=${meta}`)).params.get('reason'), 'state_expired');
            assert.equal(db.oauth.find((o) => o.nonce === meta)!.used_at, null, 'a Meta state is not spent by this callback');
        });

        it('always clears the state cookie on the way out, in the same bytes as before', async () => {
            const r = await callback(flow.platform, 'error=access_denied');
            assert.equal(r.setCookie, `${flow.cookie}=; Path=/api/${flow.platform}/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
        });

        it('spends the state in one UPDATE that names all three conditions, and returns only the two columns it always did', async () => {
            // Through the platform's own door. (The callback goes on to the provider after this, which no test here may do.)
            const state = await createOAuthState({ purpose: flow.platform, creatorId: TENANT, userId: USER });
            assert.deepEqual(await flow.consume(state), { creatorId: TENANT, userId: USER });
            const update = db.statements.find((s) => /^UPDATE oauth_states SET used_at = NOW\(\)/.test(s.sql))!;
            assert.match(update.sql, /WHERE nonce = \$1 AND platform = \$2 AND used_at IS NULL AND expires_at > NOW\(\) RETURNING creator_id, user_id$/);
            assert.deepEqual(update.params, [state, flow.platform]);
        });
    });
}
