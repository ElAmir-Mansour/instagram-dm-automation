/**
 * What a TikTok connection keeps of `user.info.profile` (P33): written when TikTok granted the scope, never asked for when it did not,
 * cleared when a reconnect reads none, and invisible to a deployment that has not applied v44.
 *
 * `tiktokHttp` and the pool are stand-ins that throw on anything a test did not arrange, so nothing here can reach TikTok or Postgres.
 * The rule the first group pins is the one the whole feature rests on: with the scope not granted (every connection made while the
 * operator setting is off), `completeConnection` makes exactly the requests and the one INSERT it always made, and no other.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { decryptSecret } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import { tiktokHttp, TIKTOK_API_BASE } from './tiktok.js';
import { completeConnection, hasProfileScope, readStoredProfile, summariseConnection, type StoredTikTokProfile } from './tiktokConnections.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROW_ID = '77777777-7777-4777-8777-777777777777';
const BIO = 'عطور شرقية وغربية — شحن لكل المدن ✨';
const original = { post: tiktokHttp.post, get: tiktokHttp.get, query: pool.query };

interface Recorded { method: 'get' | 'post'; url: string; params?: unknown; headers?: unknown }
let http: Recorded[];
let statements: Array<{ sql: string; params: unknown[] }>;
/** What the connection row held BEFORE this connect: `ON CONFLICT` keeps columns the INSERT does not name. */
let existingProfile: unknown;
/** `undefined`: a database that has not applied v44, whose rows have no `profile` key at all. */
let hasProfileColumn: boolean;
let restoreSink: () => void;
let grantedScope: string;
let profileAnswer: () => Promise<{ status: number; data: unknown }>;
let saved: string | undefined;
/** The row the INSERT last answered with: what `UPDATE … RETURNING *` returns, with its profile changed. */
let lastRow: Record<string, unknown>;

const norm = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
    saved = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
    http = [];
    statements = [];
    existingProfile = null;
    hasProfileColumn = true;
    grantedScope = 'user.info.basic,video.upload';
    profileAnswer = async () => ({
        status: 200,
        data: { data: { user: { open_id: 'open-1', username: 'nour.perfumes', bio_description: BIO, profile_deep_link: 'https://www.tiktok.com/@nour.perfumes', is_verified: true } }, error: { code: 'ok' } },
    });
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);

    (tiktokHttp as any).post = async (url: string, _body: unknown, config: any) => {
        http.push({ method: 'post', url, headers: config?.headers });
        return { status: 200, data: { access_token: 'act.1', refresh_token: 'rft.1', open_id: 'open-1', scope: grantedScope, expires_in: 86400, refresh_expires_in: 31536000 } };
    };
    (tiktokHttp as any).get = async (url: string, config: any) => {
        http.push({ method: 'get', url, params: config?.params, headers: config?.headers });
        if (String(config?.params?.fields).includes('bio_description')) return profileAnswer();
        return { status: 200, data: { data: { user: { open_id: 'open-1', display_name: 'Nour', avatar_url: 'https://p16.example/a.jpg' } }, error: { code: 'ok' } } };
    };
    (pool as unknown as { query: unknown }).query = async (rawSql: string, params: unknown[] = []) => {
        const sql = norm(rawSql);
        statements.push({ sql, params });
        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(sql)) {
            const value = params[0] === 'tiktok.client_key' ? 'tt-client-key-123' : params[0] === 'tiktok.client_secret' ? 'tt-client-secret-1234567890' : null;
            return { rows: value === null ? [] : [{ value, is_secret: false }], rowCount: value === null ? 0 : 1 };
        }
        if (/^INSERT INTO platform_connections /.test(sql)) {
            const row: Record<string, unknown> = {
                id: ROW_ID, creator_id: params[0], platform: 'tiktok', external_account_id: params[1], display_name: params[2], avatar_url: params[3],
                scopes: params[4], access_token: params[5], refresh_token: params[7], status: 'active',
                ...(hasProfileColumn ? { profile: existingProfile } : {}),
            };
            lastRow = row;
            return { rows: [row], rowCount: 1 };
        }
        if (/^UPDATE platform_connections SET profile = \$2::jsonb WHERE id = \$1 RETURNING \*$/.test(sql)) {
            if (!hasProfileColumn) throw Object.assign(new Error('column "profile" of relation "platform_connections" does not exist'), { code: '42703' });
            const profile = params[1] === null ? null : JSON.parse(String(params[1]));
            return { rows: [{ ...lastRow, profile }], rowCount: 1 };
        }
        throw new Error(`no answer for: ${sql}`);
    };
});

afterEach(() => {
    restoreSink();
    (tiktokHttp as any).post = original.post;
    (tiktokHttp as any).get = original.get;
    (pool as unknown as { query: unknown }).query = original.query;
    if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved;
});

const connect = () => completeConnection({ creatorId: TENANT, userId: null, code: 'the-code', redirectUri: 'https://autoreply.example/api/tiktok/callback' });
const writes = () => statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql));

describe('completeConnection with the profile scope NOT granted (the setting off: every connection made today)', () => {
    it('makes exactly the requests it always made: the token exchange and the one user-info call for the name and the avatar', async () => {
        await connect();
        assert.deepEqual(http.map((h) => [h.method, h.url, h.params ?? null]), [
            ['post', `${TIKTOK_API_BASE}/v2/oauth/token/`, null],
            ['get', `${TIKTOK_API_BASE}/v2/user/info/`, { fields: 'open_id,avatar_url,display_name' }],
        ]);
    });

    it('writes exactly the one INSERT it always wrote, with the parameters it always had, and no statement about a profile', async () => {
        const row = await connect();
        const w = writes();
        assert.equal(w.length, 1);
        assert.match(w[0]!.sql, /^INSERT INTO platform_connections /);
        assert.equal(w[0]!.params.length, 10, 'the same ten parameters');
        assert.ok(!w[0]!.sql.includes('profile'), 'the INSERT does not name the new column');
        assert.equal(statements.some((s) => s.sql.includes('profile')), false);
        assert.equal(row.display_name, 'Nour');
        assert.deepEqual(row.scopes, ['user.info.basic', 'video.upload']);
    });

    it('does the same on a database that has not applied v44: its rows have no profile key, and nothing is written for one', async () => {
        hasProfileColumn = false;
        const row = await connect();
        assert.equal(writes().length, 1);
        assert.equal(row.profile, undefined);
    });

    it('stores nothing and asks for nothing even if the scope is named by something that is not the granted list', async () => {
        grantedScope = 'user.info.basic,video.upload';
        await connect();
        assert.equal(http.some((h) => String(JSON.stringify(h.params)).includes('bio_description')), false);
    });
});

describe('completeConnection with the profile scope granted', () => {
    beforeEach(() => { grantedScope = 'user.info.basic,user.info.profile,video.upload'; });

    it('asks for the profile fields in a second request, after the unchanged user-info call', async () => {
        await connect();
        assert.deepEqual(http.map((h) => [h.method, h.url, h.params ?? null]), [
            ['post', `${TIKTOK_API_BASE}/v2/oauth/token/`, null],
            ['get', `${TIKTOK_API_BASE}/v2/user/info/`, { fields: 'open_id,avatar_url,display_name' }],
            ['get', `${TIKTOK_API_BASE}/v2/user/info/`, { fields: 'open_id,username,bio_description,profile_deep_link,is_verified' }],
        ]);
        assert.deepEqual(http[2]!.headers, { Authorization: 'Bearer act.1' });
    });

    it('stores the fields TikTok returned, with the time, apart from the connection\'s own INSERT', async () => {
        const row = await connect();
        const w = writes();
        assert.equal(w.length, 2);
        assert.match(w[0]!.sql, /^INSERT INTO platform_connections /);
        assert.ok(!w[0]!.sql.includes('profile'), 'the INSERT is still the INSERT');
        assert.match(w[1]!.sql, /^UPDATE platform_connections SET profile = \$2::jsonb WHERE id = \$1/);
        const stored = JSON.parse(String(w[1]!.params[1])) as StoredTikTokProfile;
        assert.deepEqual({ ...stored, fetchedAt: undefined }, { username: 'nour.perfumes', bio: BIO, profileLink: 'https://www.tiktok.com/@nour.perfumes', verified: true, fetchedAt: undefined });
        assert.ok(!Number.isNaN(Date.parse(stored.fetchedAt)), 'an ISO time');
        assert.deepEqual(readStoredProfile(row.profile), stored);
        assert.deepEqual(row.scopes, ['user.info.basic', 'user.info.profile', 'video.upload']);
    });

    it('keeps no count: TikTok returns none for this scope, and none is asked for or stored', async () => {
        await connect();
        const stored = JSON.parse(String(writes()[1]!.params[1])) as Record<string, unknown>;
        assert.deepEqual(Object.keys(stored).sort(), ['bio', 'fetchedAt', 'profileLink', 'username', 'verified']);
    });

    it('still connects, with its name and avatar, when TikTok refuses the profile fields: they are decoration, and the code is spent', async () => {
        profileAnswer = async () => {
            throw Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, data: { error: { code: 'scope_not_authorized', message: 'no', log_id: 'l' } } } });
        };
        const row = await connect();
        assert.equal(row.display_name, 'Nour');
        assert.equal(writes().length, 1, 'only the INSERT: nothing was read, so nothing is written');
    });

    it('still connects when the profile cannot be saved (a database that has not applied v44)', async () => {
        hasProfileColumn = false;
        const row = await connect();
        assert.equal(row.display_name, 'Nour');
        assert.equal(writes().length, 2, 'the INSERT, and the UPDATE that failed');
    });

    it('does not save a profile that holds nothing: an account with no bio, no username and no link', async () => {
        profileAnswer = async () => ({ status: 200, data: { data: { user: { open_id: 'open-1', username: '', bio_description: '  ', is_verified: false } }, error: { code: 'ok' } } });
        await connect();
        assert.equal(writes().length, 1);
    });

    it('never puts a token in the profile it stores', async () => {
        await connect();
        const w = writes();
        assert.ok(!String(w[1]!.params[1]).includes('act.1') && !String(w[1]!.params[1]).includes('rft.1'));
        assert.equal(decryptSecret(String(w[0]!.params[5])), 'act.1', 'the tokens go in the INSERT, encrypted');
    });
});

describe('a reconnect never leaves another account\'s profile on the connection', () => {
    const OLD: StoredTikTokProfile = { username: 'someone.else', bio: 'the previous account\'s bio', profileLink: 'https://www.tiktok.com/@someone.else', verified: false, fetchedAt: '2026-09-01T00:00:00.000Z' };

    it('clears the stored profile when the new connection read none (the scope is off now, or it is a different TikTok account)', async () => {
        existingProfile = OLD;
        const row = await connect();
        const w = writes();
        assert.equal(w.length, 2);
        assert.match(w[1]!.sql, /^UPDATE platform_connections SET profile = \$2::jsonb WHERE id = \$1/);
        assert.equal(w[1]!.params[1], null);
        assert.equal(readStoredProfile(row.profile), null);
    });

    it('replaces it when the new connection read one', async () => {
        existingProfile = OLD;
        grantedScope = 'user.info.basic,user.info.profile,video.upload';
        const row = await connect();
        assert.equal(readStoredProfile(row.profile)?.username, 'nour.perfumes');
    });

    it('writes nothing for a connection that had no profile and read none', async () => {
        existingProfile = null;
        await connect();
        assert.equal(writes().length, 1);
    });
});

describe('readStoredProfile, hasProfileScope and the summary', () => {
    it('reads JSON the way it was written, and tolerates a column that is not the shape this release writes', () => {
        const good = { username: 'u', bio: 'b', profileLink: 'https://www.tiktok.com/@u', verified: true, fetchedAt: '2026-10-14T00:00:00.000Z' };
        assert.deepEqual(readStoredProfile(good), good);
        for (const v of [null, undefined, 'x', 7, [], {}, { bio: 5, username: null }, { verified: true }, { fetchedAt: '2026-10-14T00:00:00.000Z' }]) assert.equal(readStoredProfile(v), null);
        assert.deepEqual(readStoredProfile({ bio: 'b' }), { username: null, bio: 'b', profileLink: null, verified: null, fetchedAt: '' });
    });

    it('knows the scope from the list TikTok granted, and from nothing else', () => {
        assert.equal(hasProfileScope(['user.info.basic', 'user.info.profile']), true);
        assert.equal(hasProfileScope(['user.info.basic', 'video.upload']), false);
        assert.equal(hasProfileScope([]), false);
    });

    it('does not show the dashboard the profile: the summary is what it was', () => {
        const summary = summariseConnection({
            id: ROW_ID, creator_id: TENANT, platform: 'tiktok', external_account_id: 'open-1', display_name: 'Nour', avatar_url: null,
            scopes: ['user.info.basic', 'user.info.profile'], access_token: 'x', access_expires_at: null, refresh_token: 'y', refresh_expires_at: null,
            status: 'active', last_error: null, last_refreshed_at: null, refresh_claimed_at: null, connected_by_user_id: null,
            profile: { username: 'u', bio: 'a bio' }, created_at: new Date(), updated_at: new Date(),
        });
        assert.ok(!JSON.stringify(summary).includes('a bio'));
    });
});
