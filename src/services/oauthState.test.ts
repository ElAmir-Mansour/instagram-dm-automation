/**
 * The OAuth state lifecycle, shared by TikTok, YouTube and Meta.
 *
 * A state is what binds a returned `code` to a tenant, so its guarantees are the security of every connect flow: it is spent at most
 * once, only before it expires, only for the purpose it was minted for, and a Page pick holds Page tokens for the minutes it is
 * needed and not a moment longer. These run against `FakeDb`, which applies the conditions that are IN the SQL it is given, so a
 * condition deleted from a statement is a condition the test sees missing.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { isEncrypted } from '../config/crypto.js';
import { consumeOAuthState as consumeTikTok, createOAuthState as createTikTok } from './tiktokConnections.js';
import { consumeOAuthState as consumeYouTube, createOAuthState as createYouTube } from './youtubeConnections.js';
import { FakeDb } from './metaLoginHarness.js';
import {
    consumeOAuthState, consumePick, createOAuthState, isReturnTo, NONCE_PATTERN, OAUTH_STATE_TTL_MS, purgeOAuthStates, readCookie,
    readPick, stateCookie,
} from './oauthState.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';
const MINUTE = 60_000;

let db: FakeDb;
let savedKey: string | undefined;

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    db = new FakeDb().install();
    // One clock. `createOAuthState` stamps `expires_at` from `Date.now()`, and `NOW()` in FakeDb is `db.now`, frozen when the
    // FakeDb was made. Left apart, the wall clock kept running between the two, and under the full run's load it ran 2 ms or more
    // ahead, so a state moved "1 ms past its expiry" was still live and was spent.
    mock.method(Date, 'now', () => db.now);
});

afterEach(() => {
    mock.restoreAll();
    db.restore();
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

describe('createOAuthState', () => {
    it('mints 32 random bytes, base64url, that the pattern accepts, and a different one each time', async () => {
        const a = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER });
        const b = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER });
        assert.notEqual(a, b);
        assert.equal(Buffer.from(a, 'base64url').length, 32);
        assert.match(a, NONCE_PATTERN);
    });

    it('lives ten minutes, or the time it was given', async () => {
        const nonce = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER });
        const row = db.oauth.find((r) => r.nonce === nonce)!;
        assert.equal(OAUTH_STATE_TTL_MS, 10 * MINUTE);
        assert.ok(Math.abs(row.expires_at.getTime() - (Date.now() + OAUTH_STATE_TTL_MS)) < 5_000);
        const short = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, ttlMs: MINUTE });
        assert.ok(Math.abs(db.oauth.find((r) => r.nonce === short)!.expires_at.getTime() - (Date.now() + MINUTE)) < 5_000);
    });

    it('stores a Meta payload encrypted, and the return_to beside it', async () => {
        const nonce = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, returnTo: 'welcome', payload: { v: 1, reconnect: true, note: 'plaintext-marker' } });
        const row = db.oauth.find((r) => r.nonce === nonce)!;
        assert.equal(row.return_to, 'welcome');
        assert.ok(isEncrypted(row.payload), 'enc:v1');
        assert.ok(!row.payload!.includes('plaintext-marker'));
        assert.equal(row.platform, 'meta');
    });

    it('sweeps states that expired over a day ago, and a Meta state also clears the payload of any that expired unspent', async () => {
        const old = await createOAuthState({ purpose: 'tiktok', creatorId: TENANT, userId: USER });
        db.oauth.find((r) => r.nonce === old)!.expires_at = new Date(db.now - 2 * 86_400_000);
        const stale = await createOAuthState({ purpose: 'meta_pick', creatorId: TENANT, userId: USER, payload: { v: 1, secret: 'x' } });
        db.oauth.find((r) => r.nonce === stale)!.expires_at = new Date(db.now - 5 * MINUTE);

        await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER });
        assert.ok(!db.oauth.some((r) => r.nonce === old), 'the day-old row is deleted');
        assert.equal(db.oauth.find((r) => r.nonce === stale)!.payload, null, 'the expired pick holds no payload any more');
    });

    it('refuses a return_to or a payload on a purpose that has neither (TikTok, YouTube)', async () => {
        await assert.rejects(createOAuthState({ purpose: 'tiktok', creatorId: TENANT, userId: USER, returnTo: 'welcome' }), /no return_to or payload/);
        await assert.rejects(createOAuthState({ purpose: 'youtube', creatorId: TENANT, userId: USER, payload: { a: 1 } }), /no return_to or payload/);
    });
});

describe('consumeOAuthState: single use', () => {
    it('spends a state once, and the second attempt finds nothing', async () => {
        const nonce = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, returnTo: 'settings', payload: { v: 1, reconnect: false } });
        const first = await consumeOAuthState(nonce, 'meta');
        assert.deepEqual(first, { creatorId: TENANT, userId: USER, returnTo: 'settings', payload: { v: 1, reconnect: false } });

        assert.equal(await consumeOAuthState(nonce, 'meta'), null, 'a state is spent at most once');
        assert.equal(await consumeOAuthState(nonce, 'meta'), null);
    });

    it('is decided in the one UPDATE, whose WHERE names all three conditions', async () => {
        const nonce = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER });
        await consumeOAuthState(nonce, 'meta');
        const update = db.statements.find((s) => /^UPDATE oauth_states SET used_at = NOW\(\)/.test(s.sql))!;
        assert.match(update.sql, /WHERE nonce = \$1 AND platform = \$2 AND used_at IS NULL AND expires_at > NOW\(\) RETURNING/);
    });

    it('refuses a state after it expires', async () => {
        const nonce = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER });
        db.now += OAUTH_STATE_TTL_MS + 1;
        assert.equal(await consumeOAuthState(nonce, 'meta'), null);
    });

    it('refuses a state minted for another purpose: a TikTok state is not a Meta state', async () => {
        const tiktok = await createOAuthState({ purpose: 'tiktok', creatorId: TENANT, userId: USER });
        assert.equal(await consumeOAuthState(tiktok, 'meta'), null);
        assert.equal(await consumeOAuthState(tiktok, 'youtube'), null);
        const pick = await createOAuthState({ purpose: 'meta_pick', creatorId: TENANT, userId: USER, payload: { v: 1 } });
        assert.equal(await consumeOAuthState(pick, 'meta'), null, 'a Page pick cannot be spent as a login state');
        assert.ok(await consumeOAuthState(tiktok, 'tiktok'), 'and the right purpose still works');
    });

    it('refuses an unknown state', async () => {
        assert.equal(await consumeOAuthState('not-a-state', 'meta'), null);
    });

    it('reads a payload it cannot open as nothing, not as an error', async () => {
        const nonce = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, payload: { v: 1, reconnect: true } });
        db.oauth.find((r) => r.nonce === nonce)!.payload = 'enc:v1:AAAA:BBBB:CCCC';
        const claim = await consumeOAuthState(nonce, 'meta');
        assert.ok(claim, 'the state is still spent');
        assert.equal(claim!.payload, null);
    });
});

describe('TikTok and YouTube: the statements they have always issued', () => {
    it('never name a v35 column, so a deployment ahead of its migration still connects them', async () => {
        const tt = await createTikTok(TENANT, USER);
        const yt = await createYouTube(TENANT, USER);
        assert.ok(await consumeTikTok(tt));
        assert.ok(await consumeYouTube(yt));
        const sql = db.statements.map((s) => s.sql).filter((s) => /oauth_states/.test(s));
        assert.ok(sql.length >= 6);
        for (const s of sql) assert.doesNotMatch(s, /return_to|payload/, s);
    });

    it('write the platform they always did, with no return_to and no payload', async () => {
        const tt = await createTikTok(TENANT, USER);
        const yt = await createYouTube(TENANT, null);
        const rows = db.oauth;
        assert.deepEqual(rows.find((r) => r.nonce === tt), { ...rows.find((r) => r.nonce === tt)!, platform: 'tiktok', user_id: USER, return_to: null, payload: null });
        assert.deepEqual([rows.find((r) => r.nonce === yt)!.platform, rows.find((r) => r.nonce === yt)!.user_id], ['youtube', null]);
    });

    it('still answer exactly { creatorId, userId }, and spend only their own platform', async () => {
        const tt = await createTikTok(TENANT, USER);
        const yt = await createYouTube(TENANT, USER);
        assert.equal(await consumeYouTube(tt), null, 'a TikTok state is not a YouTube state');
        assert.equal(await consumeTikTok(yt), null, 'and the other way round');
        assert.deepEqual(await consumeTikTok(tt), { creatorId: TENANT, userId: USER });
        assert.deepEqual(await consumeYouTube(yt), { creatorId: TENANT, userId: USER });
        assert.equal(await consumeTikTok(tt), null, 'single-use here as well');
    });
});

describe('the Page pick', () => {
    const PAYLOAD = { v: 1, metaUserId: '90001', choices: [{ pageId: '1', accessToken: 'EAA-PAGE-TOKEN-MUST-STAY-ENCRYPTED-0123456789abcdef' }] };

    async function makePick() {
        return createOAuthState({ purpose: 'meta_pick', creatorId: TENANT, userId: USER, returnTo: 'welcome', payload: PAYLOAD });
    }

    it('holds the Pages and their tokens encrypted, never in the clear', async () => {
        const nonce = await makePick();
        const stored = db.oauth.find((r) => r.nonce === nonce)!.payload!;
        assert.ok(isEncrypted(stored));
        assert.ok(!stored.includes('EAA-PAGE-TOKEN'));
        assert.ok(!db.everything().includes('EAA-PAGE-TOKEN'), 'in no parameter and no row');
    });

    it('is readable, without being spent, only by the tenant AND the user who made it', async () => {
        const nonce = await makePick();
        const mine = await readPick(nonce, TENANT, USER);
        assert.deepEqual(mine?.payload, PAYLOAD);
        assert.equal(mine?.returnTo, 'welcome');
        assert.ok(await readPick(nonce, TENANT, USER), 'reading does not spend it');

        assert.equal(await readPick(nonce, OTHER_TENANT, USER), null, 'another tenant');
        assert.equal(await readPick(nonce, TENANT, OTHER_USER), null, 'another user');
        assert.equal(await readPick(nonce, TENANT, null), null, 'a legacy session is not the user who made it');
    });

    it('treats a legacy shared-password session (no user) as its own: the pick it made is readable by it alone', async () => {
        const nonce = await createOAuthState({ purpose: 'meta_pick', creatorId: TENANT, userId: null, payload: PAYLOAD });
        assert.ok(await readPick(nonce, TENANT, null));
        assert.equal(await readPick(nonce, TENANT, USER), null);
    });

    it('is not readable once it has expired', async () => {
        const nonce = await makePick();
        db.now += OAUTH_STATE_TTL_MS + 1;
        assert.equal(await readPick(nonce, TENANT, USER), null);
        assert.equal(await consumePick(nonce, TENANT, USER), null);
    });

    it('is spent by a choice in ONE statement that also nulls the payload, and hands the payload back once', async () => {
        const nonce = await makePick();
        const spent = await consumePick(nonce, TENANT, USER);
        assert.deepEqual(spent?.payload, PAYLOAD);

        const row = db.oauth.find((r) => r.nonce === nonce)!;
        assert.equal(row.payload, null, 'the Page tokens are gone from the table at the moment of the choice');
        assert.ok(row.used_at);
        assert.equal(await consumePick(nonce, TENANT, USER), null, 'a second choice finds nothing');
        assert.equal(await readPick(nonce, TENANT, USER), null);

        const statement = db.statements.find((s) => /^WITH picked AS/.test(s.sql))!;
        assert.match(statement.sql, /SET used_at = NOW\(\), payload = NULL/);
        assert.match(statement.sql, /used_at IS NULL AND expires_at > NOW\(\) FOR UPDATE/);
    });

    it('cannot be spent by another tenant or another user', async () => {
        const nonce = await makePick();
        assert.equal(await consumePick(nonce, OTHER_TENANT, USER), null);
        assert.equal(await consumePick(nonce, TENANT, OTHER_USER), null);
        assert.ok(db.oauth.find((r) => r.nonce === nonce)!.payload, 'and the attempt took nothing from it');
        assert.ok(await consumePick(nonce, TENANT, USER));
    });

    it('never reaches SQL with a value that is not a nonce', async () => {
        const before = db.statements.length;
        assert.equal(await readPick("x'; DROP TABLE oauth_states;--", TENANT, USER), null);
        assert.equal(await consumePick('', TENANT, USER), null);
        assert.equal(db.statements.length, before);
    });

    it('cannot be spent as a login state, nor can a login state be read as a pick', async () => {
        const login = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, payload: { v: 1, reconnect: false } });
        assert.equal(await readPick(login, TENANT, USER), null);
        assert.equal(await consumePick(login, TENANT, USER), null);
    });
});

describe('purgeOAuthStates', () => {
    it('clears the payload of every state that is spent or expired, and deletes what expired over a day ago', async () => {
        const live = await createOAuthState({ purpose: 'meta_pick', creatorId: TENANT, userId: USER, payload: { v: 1 } });
        const expired = await createOAuthState({ purpose: 'meta_pick', creatorId: TENANT, userId: USER, payload: { v: 1 } });
        const spent = await createOAuthState({ purpose: 'meta', creatorId: TENANT, userId: USER, payload: { v: 1, reconnect: false } });
        const ancient = await createOAuthState({ purpose: 'tiktok', creatorId: TENANT, userId: USER });
        db.oauth.find((r) => r.nonce === expired)!.expires_at = new Date(db.now - MINUTE);
        db.oauth.find((r) => r.nonce === ancient)!.expires_at = new Date(db.now - 3 * 86_400_000);
        db.oauth.find((r) => r.nonce === spent)!.used_at = new Date(db.now);

        const result = await purgeOAuthStates();
        assert.deepEqual(result, { scrubbed: 2, deleted: 1 });
        assert.ok(db.oauth.find((r) => r.nonce === live)!.payload, 'a live pick keeps its payload');
        assert.equal(db.oauth.find((r) => r.nonce === expired)!.payload, null);
        assert.equal(db.oauth.find((r) => r.nonce === spent)!.payload, null);
        assert.ok(!db.oauth.some((r) => r.nonce === ancient));
    });
});

describe('the state cookie', () => {
    it('is HttpOnly, Secure and Lax, scoped to one path, and byte-for-byte what TikTok and YouTube have always set', () => {
        assert.equal(
            stateCookie('tiktok_oauth_state', '/api/tiktok/callback', 'a/b', 600),
            'tiktok_oauth_state=a%2Fb; Path=/api/tiktok/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax'
        );
        assert.equal(
            stateCookie('meta_oauth_state', '/api/meta/callback', '', 0),
            'meta_oauth_state=; Path=/api/meta/callback; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
        );
    });

    it('is found among other cookies, decoded, and a malformed one is nothing', () => {
        assert.equal(readCookie('a=1; meta_oauth_state=x%2Fy; b=2', 'meta_oauth_state'), 'x/y');
        assert.equal(readCookie('a=1', 'meta_oauth_state'), null);
        assert.equal(readCookie(undefined, 'meta_oauth_state'), null);
        assert.equal(readCookie('meta_oauth_state=%E0%A4%A', 'meta_oauth_state'), null);
    });
});

describe('isReturnTo', () => {
    it('knows the two places a flow returns to', () => {
        assert.ok(isReturnTo('settings') && isReturnTo('welcome'));
        for (const bad of ['', 'Settings', 'home', null, undefined, 3, {}]) assert.equal(isReturnTo(bad), false);
    });
});
