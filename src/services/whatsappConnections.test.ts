/**
 * The WhatsApp connection row: what is stored, what is read back, and that the token only ever leaves through `getAccessToken`.
 *
 * `pool.query` is replaced by a router that answers on the SQL it is handed and THROWS on a statement a test did not arrange; `metaHttp` and
 * `axios.get` (which `debug_token` uses) are replaced by recorders that throw on any call a test did not arrange. No database, no Meta.
 *
 * What a stub cannot prove is what Postgres does with a statement, so those tests pin the statement's shape instead (the `CASE` that keeps
 * the owner's settings on a reconnect of the same number, the `status <> 'revoked'` of the webhook lookup, the columns a read selects).
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { decryptSecret, encryptSecret } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from './http.js';
import type { PhoneNumberHealth } from './whatsapp.js';
import {
    DEFAULT_WHATSAPP_SETTINGS, EMPTY_PROFILE, getAccessToken, getConnection, getConnectionByPhoneNumberId, isAlertThreshold,
    isAuthRefusal, markConnectionActive, markConnectionInvalid, profileFacts, readProfile, readSettings, refreshHealth,
    revokeConnection, saveConnection, updateHealth, updateSettings, WhatsAppNotConnectedError, WhatsAppNumberInUseError,
} from './whatsappConnections.js';

const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const PHONE = '106540352242922';
const WABA = '102290129340398';

const HEALTH: PhoneNumberHealth = {
    displayPhoneNumber: '+1 555-025-3483', verifiedName: 'Test Number', qualityRating: 'GREEN', codeVerificationStatus: 'VERIFIED',
    nameStatus: 'APPROVED', throughput: 'STANDARD', numberStatus: 'CONNECTED', messagingLimit: 'TIER_250', isTestNumber: true,
};

let statements: Array<{ sql: string; params: unknown[] }>;
let respond: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number };
const originalQuery = pool.query;
const originals = { get: metaHttp.get, axiosGet: axios.get };
let restoreSink: (() => void) | undefined;
let savedKey: string | undefined;
let savedAppId: string | undefined;
let savedAppSecret: string | undefined;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    savedAppId = process.env.META_APP_ID;
    savedAppSecret = process.env.META_APP_SECRET;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.META_APP_ID = '847772258381375';
    process.env.META_APP_SECRET = 'the-app-secret-never-in-a-log';
    statements = [];
    respond = (sql) => { throw new Error(`no result arranged for SQL: ${sql}`); };
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const r = respond(sql, params);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (metaHttp as any).get = async (url: string) => { throw new Error(`no GET was arranged for ${url}`); };
    (axios as any).get = async (url: string) => { throw new Error(`no axios GET was arranged for ${url}`); };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originals.get;
    (axios as any).get = originals.axiosGet;
    for (const [k, v] of [['TOKEN_ENCRYPTION_KEY', savedKey], ['META_APP_ID', savedAppId], ['META_APP_SECRET', savedAppSecret]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** A row as the connection SELECTs return it (no token column, `has_token` instead). */
const row = (over: Record<string, unknown> = {}) => ({
    id: 'c-1', creator_id: CREATOR, external_account_id: PHONE, display_name: 'Test Number', status: 'active', last_error: null,
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], has_token: true, access_expires_at: null,
    last_refreshed_at: new Date('2026-10-19T08:00:00Z'), created_at: new Date('2026-10-18T08:00:00Z'),
    profile: { waba_id: WABA, display_phone_number: '+1 555-025-3483', quality_rating: 'GREEN', is_test_number: true },
    settings: { allow_billable: true, free_tier_alert_at: 800 },
    ...over,
});

describe('readProfile', () => {
    it('reads what is stored, and nothing that is not text', () => {
        const p = readProfile({
            waba_id: WABA, display_phone_number: '+1 555', quality_rating: 'GREEN', messaging_limit: 'TIER_250', is_test_number: true,
            throughput: { level: 'x' }, name_status: '  ', read_at: '2026-10-19T08:00:00.000Z',
        });
        assert.equal(p.waba_id, WABA);
        assert.equal(p.messaging_limit, 'TIER_250');
        assert.equal(p.is_test_number, true);
        assert.equal(p.throughput, null, 'an object is not a throughput level');
        assert.equal(p.name_status, null, 'whitespace is nothing');
        assert.equal(p.read_at, '2026-10-19T08:00:00.000Z');
    });

    it('reads a missing, null or malformed column as an empty profile', () => {
        for (const junk of [undefined, null, 'x', 5, [], [1]]) assert.deepEqual(readProfile(junk), EMPTY_PROFILE);
        assert.notEqual(readProfile(null), EMPTY_PROFILE, 'a copy, so a caller cannot edit the shared default');
    });

    it('only ever reads is_test_number from a literal true', () => {
        assert.equal(readProfile({ is_test_number: 'true' }).is_test_number, false);
        assert.equal(readProfile({ is_test_number: 1 }).is_test_number, false);
    });
});

describe('readSettings', () => {
    it('defaults to blocking billable sends and alerting at 900', () => {
        assert.deepEqual(readSettings({}), { allow_billable: false, free_tier_alert_at: 900 });
        assert.deepEqual(readSettings(undefined), DEFAULT_WHATSAPP_SETTINGS);
        assert.deepEqual(readSettings(null), DEFAULT_WHATSAPP_SETTINGS);
    });

    it('allows billable sends only for a literal true: a truthy string must not spend the owner’s money', () => {
        for (const v of ['true', 1, 'yes', {}, [], 'on']) assert.equal(readSettings({ allow_billable: v }).allow_billable, false, JSON.stringify(v));
        assert.equal(readSettings({ allow_billable: true }).allow_billable, true);
    });

    it('takes a threshold only when it is a whole number from 0 to 1000', () => {
        assert.equal(readSettings({ free_tier_alert_at: 500 }).free_tier_alert_at, 500);
        assert.equal(readSettings({ free_tier_alert_at: 0 }).free_tier_alert_at, 0);
        assert.equal(readSettings({ free_tier_alert_at: 1000 }).free_tier_alert_at, 1000);
        for (const bad of [-1, 1001, 1.5, '800', null, NaN, Infinity]) assert.equal(readSettings({ free_tier_alert_at: bad }).free_tier_alert_at, 900, String(bad));
        assert.equal(isAlertThreshold(0), true);
        assert.equal(isAlertThreshold(1001), false);
    });
});

describe('profileFacts', () => {
    it('names what Meta said and leaves waba_id and timezone alone', () => {
        const facts = profileFacts(HEALTH, new Date('2026-10-19T09:00:00Z'));
        assert.equal(facts.display_phone_number, '+1 555-025-3483');
        assert.equal(facts.number_status, 'CONNECTED');
        assert.equal(facts.is_test_number, true);
        assert.equal(facts.read_at, '2026-10-19T09:00:00.000Z');
        assert.ok(!('waba_id' in facts), 'waba_id is typed by the owner, so a health read must not overwrite it with null');
        assert.ok(!('timezone' in facts));
    });
});

describe('reading a connection', () => {
    it('selects NO token column: the typed connection cannot carry one even by mistake', async () => {
        respond = () => ({ rows: [row()] });

        const c = await getConnection(CREATOR);

        assert.equal(statements.length, 1);
        assert.match(statements[0]!.sql, /FROM platform_connections WHERE creator_id = \$1 AND platform = 'whatsapp'/);
        assert.match(statements[0]!.sql, /access_token IS NOT NULL AS has_token/);
        assert.doesNotMatch(statements[0]!.sql, /access_token\s*(,|FROM)/i, 'the select list holds no bare access_token');
        assert.doesNotMatch(statements[0]!.sql, /refresh_token/);
        assert.equal(c?.hasToken, true);
        assert.ok(!Object.keys(c!).some((k) => /token$/i.test(k) && k !== 'hasToken'), 'no field of the connection is a token');
    });

    it('maps the row: ids, dates as ISO, profile and settings typed', async () => {
        respond = () => ({ rows: [row()] });

        const c = (await getConnection(CREATOR))!;

        assert.equal(c.creatorId, CREATOR);
        assert.equal(c.phoneNumberId, PHONE);
        assert.equal(c.displayName, 'Test Number');
        assert.equal(c.status, 'active');
        assert.equal(c.accessExpiresAt, null, 'a token that never expires has no expiry');
        assert.equal(c.lastRefreshedAt, '2026-10-19T08:00:00.000Z');
        assert.equal(c.profile.waba_id, WABA);
        assert.deepEqual(c.settings, { allow_billable: true, free_tier_alert_at: 800 });
    });

    it('answers null for a tenant that never connected', async () => {
        respond = () => ({ rows: [] });
        assert.equal(await getConnection(CREATOR), null);
    });

    it('reads a row from before v50 (no settings) with the safe defaults', async () => {
        respond = () => ({ rows: [row({ settings: undefined })] });
        assert.deepEqual((await getConnection(CREATOR))!.settings, DEFAULT_WHATSAPP_SETTINGS);
    });
});

describe('getConnectionByPhoneNumberId: the webhook’s tenant lookup', () => {
    it('asks for any row that is not revoked, keyed on the phone number id', async () => {
        respond = () => ({ rows: [row()] });

        const c = await getConnectionByPhoneNumberId(PHONE);

        assert.match(statements[0]!.sql, /WHERE platform = 'whatsapp' AND external_account_id = \$1 AND status <> 'revoked'/);
        assert.deepEqual(statements[0]!.params, [PHONE]);
        assert.equal(c?.creatorId, CREATOR);
    });

    it('returns an invalid connection: it still STORES inbound messages, because Meta never redelivers them', async () => {
        respond = () => ({ rows: [row({ status: 'invalid', last_error: 'token expired' })] });
        const c = await getConnectionByPhoneNumberId(PHONE);
        assert.equal(c?.status, 'invalid');
        assert.equal(c?.lastError, 'token expired');
    });

    it('returns null when nothing matches (a revoked row is excluded by the statement itself)', async () => {
        respond = () => ({ rows: [] });
        assert.equal(await getConnectionByPhoneNumberId('999'), null);
    });
});

describe('getAccessToken', () => {
    it('decrypts the stored token, and says which connection it belongs to', async () => {
        respond = () => ({ rows: [{ ...row(), access_token: encryptSecret(TOKEN) }] });

        const { accessToken, connection } = await getAccessToken(CREATOR);

        assert.equal(accessToken, TOKEN);
        assert.equal(connection.phoneNumberId, PHONE);
        assert.ok(!('access_token' in connection) && !('accessToken' in connection), 'the connection beside it carries no token');
        assert.match(statements[0]!.sql, /, access_token FROM platform_connections/);
    });

    it('refuses a tenant that never connected, a disconnected one and a row with no token', async () => {
        for (const rows of [[], [{ ...row({ status: 'revoked' }), access_token: null }], [{ ...row(), access_token: null }]]) {
            respond = () => ({ rows });
            await assert.rejects(() => getAccessToken(CREATOR), WhatsAppNotConnectedError);
        }
    });

    it('refuses to send through an invalid connection, unless the caller is the one asking Meta whether it recovered', async () => {
        respond = () => ({ rows: [{ ...row({ status: 'invalid', last_error: 'Session has expired' }), access_token: encryptSecret(TOKEN) }] });

        await assert.rejects(() => getAccessToken(CREATOR), (err: Error) => err instanceof WhatsAppNotConnectedError && /Session has expired/.test(err.message));
        assert.equal((await getAccessToken(CREATOR, { allowInvalid: true })).accessToken, TOKEN);
    });
});

describe('saveConnection', () => {
    const input = () => ({
        creatorId: CREATOR, userId: 'u-1', phoneNumberId: PHONE, wabaId: WABA, accessToken: TOKEN, health: HEALTH,
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], accessExpiresAt: null,
    });

    it('encrypts the token and writes it nowhere in plaintext', async () => {
        respond = (sql) => (/^\s*INSERT/.test(sql) ? { rows: [row()] } : { rows: [], rowCount: 0 });

        const saved = await saveConnection(input());

        const insert = statements.find((s) => /^INSERT INTO platform_connections/.test(s.sql))!;
        const stored = insert.params[4] as string;
        assert.match(stored, /^enc:v1:/);
        assert.equal(decryptSecret(stored), TOKEN);
        assert.ok(!JSON.stringify(statements.map((s) => s.params)).includes(TOKEN), 'no statement parameter holds the plaintext token');
        assert.ok(!JSON.stringify(saved).includes(TOKEN));
        assert.equal(saved.phoneNumberId, PHONE);
    });

    it('stores the facts Meta gave, the waba id the owner typed, and the scopes granted', async () => {
        respond = (sql) => (/^\s*INSERT/.test(sql) ? { rows: [row()] } : { rows: [], rowCount: 0 });

        await saveConnection(input());

        const insert = statements.find((s) => /^INSERT INTO platform_connections/.test(s.sql))!;
        assert.deepEqual(insert.params.slice(0, 4), [CREATOR, PHONE, 'Test Number', ['whatsapp_business_messaging', 'whatsapp_business_management']]);
        const profile = JSON.parse(insert.params[7] as string);
        assert.equal(profile.waba_id, WABA);
        assert.equal(profile.display_phone_number, '+1 555-025-3483');
        assert.equal(profile.is_test_number, true);
        assert.equal(insert.params[6], 'u-1');
    });

    it('writes an active connection with no refresh token (WhatsApp has none), replacing the tenant’s row in place', async () => {
        respond = (sql) => (/^\s*INSERT/.test(sql) ? { rows: [row()] } : { rows: [], rowCount: 0 });

        await saveConnection(input());

        const sql = statements.find((s) => /^INSERT INTO platform_connections/.test(s.sql))!.sql;
        assert.match(sql, /VALUES \(\$1, 'whatsapp', \$2, \$3, \$4, \$5, \$6, NULL, NULL, 'active', NULL, NOW\(\), NULL, \$7, \$8::jsonb\)/);
        assert.match(sql, /ON CONFLICT \(creator_id, platform\) DO UPDATE SET/);
        assert.match(sql, /status = 'active', last_error = NULL/);
    });

    it('keeps the owner’s settings when the SAME number is reconnected and resets them when the number changes', async () => {
        respond = (sql) => (/^\s*INSERT/.test(sql) ? { rows: [row()] } : { rows: [], rowCount: 0 });

        await saveConnection(input());

        const sql = statements.find((s) => /^INSERT INTO platform_connections/.test(s.sql))!.sql;
        assert.match(
            sql,
            /settings = CASE WHEN platform_connections\.external_account_id = EXCLUDED\.external_account_id THEN platform_connections\.settings ELSE '\{\}'::jsonb END/,
            'agreeing to billable replies for one number says nothing about another'
        );
    });

    it('deletes another tenant’s REVOKED row for this number first (it holds no data and would reserve the number forever)', async () => {
        respond = (sql) => (/^\s*INSERT/.test(sql) ? { rows: [row()] } : { rows: [], rowCount: 0 });

        await saveConnection(input());

        assert.match(statements[0]!.sql, /^DELETE FROM platform_connections WHERE platform = 'whatsapp' AND external_account_id = \$1 AND status = 'revoked' AND creator_id <> \$2/);
        assert.deepEqual(statements[0]!.params, [PHONE, CREATOR]);
        assert.match(statements[1]!.sql, /^INSERT INTO platform_connections/, 'and only then the insert');
    });

    it('turns a unique violation on the number into WhatsAppNumberInUseError', async () => {
        respond = (sql) => {
            if (/^\s*INSERT/.test(sql)) throw Object.assign(new Error('duplicate key value violates unique constraint "uq_platform_connections_account"'), { code: '23505' });
            return { rows: [], rowCount: 0 };
        };
        await assert.rejects(() => saveConnection(input()), WhatsAppNumberInUseError);
    });

    it('lets any other database error through', async () => {
        respond = (sql) => {
            if (/^\s*INSERT/.test(sql)) throw Object.assign(new Error('connection lost'), { code: '08006' });
            return { rows: [], rowCount: 0 };
        };
        await assert.rejects(() => saveConnection(input()), /connection lost/);
    });
});

describe('the small writes', () => {
    it('updateHealth merges the facts into the profile (so waba_id survives) and refreshes the name', async () => {
        respond = () => ({ rows: [row()] });

        await updateHealth('c-1', HEALTH);

        assert.match(statements[0]!.sql, /profile = COALESCE\(profile, '\{\}'::jsonb\) \|\| \$3::jsonb/);
        assert.match(statements[0]!.sql, /display_name = COALESCE\(\$2, display_name\)/);
        assert.match(statements[0]!.sql, /status <> 'revoked'/);
        assert.ok(!('waba_id' in JSON.parse(statements[0]!.params[2] as string)));
    });

    it('markConnectionInvalid cuts the reason to 500 characters and never touches a revoked row', async () => {
        respond = () => ({ rows: [], rowCount: 1 });
        await markConnectionInvalid('c-1', 'x'.repeat(900));
        assert.equal((statements[0]!.params[1] as string).length, 500);
        assert.match(statements[0]!.sql, /status <> 'revoked'/);
    });

    it('markConnectionActive only moves an invalid row', async () => {
        respond = () => ({ rows: [], rowCount: 1 });
        await markConnectionActive('c-1');
        assert.match(statements[0]!.sql, /status = 'invalid'/);
    });

    it('revokeConnection wipes the token and the owner’s billing choice, and says whether there was anything to revoke', async () => {
        respond = () => ({ rows: [], rowCount: 1 });
        assert.equal(await revokeConnection(CREATOR), true);
        assert.match(statements[0]!.sql, /access_token = NULL/);
        assert.match(statements[0]!.sql, /status = 'revoked'/);
        assert.match(statements[0]!.sql, /settings = '\{\}'::jsonb/);
        assert.match(statements[0]!.sql, /status <> 'revoked'/);

        respond = () => ({ rows: [], rowCount: 0 });
        assert.equal(await revokeConnection(CREATOR), false);
    });

    it('updateSettings merges only the keys given, and answers null when there is no live connection', async () => {
        respond = () => ({ rows: [row()] });
        const c = await updateSettings(CREATOR, { allow_billable: true });
        assert.equal(c?.settings.allow_billable, true);
        assert.match(statements[0]!.sql, /settings = COALESCE\(settings, '\{\}'::jsonb\) \|\| \$2::jsonb/);
        assert.match(statements[0]!.sql, /status <> 'revoked'/);
        assert.equal(statements[0]!.params[1], JSON.stringify({ allow_billable: true }));

        respond = () => ({ rows: [] });
        assert.equal(await updateSettings(CREATOR, { allow_billable: true }), null);
    });
});

describe('refreshHealth', () => {
    const withToken = (over: Record<string, unknown> = {}) => ({ ...row(over), access_token: encryptSecret(TOKEN) });

    function arrangeMeta(opts: { health?: () => Promise<unknown>; debug?: unknown } = {}) {
        const seen: Array<{ url: string; fields?: string }> = [];
        (metaHttp as any).get = async (url: string, config: any) => {
            seen.push({ url, fields: config?.params?.fields });
            if (opts.health) return opts.health();
            return { data: config.params.fields.startsWith('display_phone_number')
                ? { display_phone_number: '+1 555-025-3483', verified_name: 'Test Number', quality_rating: 'YELLOW', throughput: { level: 'STANDARD' } }
                : { status: 'CONNECTED' } };
        };
        (axios as any).get = async (url: string) => {
            seen.push({ url });
            return { data: { data: opts.debug ?? { is_valid: true, app_id: '847772258381375', expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] } } };
        };
        return seen;
    }

    function arrangeDb(status: 'active' | 'invalid') {
        respond = (sql) => {
            if (/, access_token FROM platform_connections/.test(sql)) return { rows: [withToken({ status, last_error: status === 'invalid' ? 'Session has expired' : null })] };
            if (/SET display_name = COALESCE/.test(sql)) return { rows: [row({ status, last_error: status === 'invalid' ? 'Session has expired' : null, profile: { waba_id: WABA, quality_rating: 'YELLOW' } })] };
            return { rows: [], rowCount: 1 };
        };
    }

    it('reads the number with the stored token and merges the facts, without asking debug_token of a healthy connection', async () => {
        const seen = arrangeMeta();
        arrangeDb('active');

        const c = await refreshHealth(CREATOR);

        assert.equal(c.status, 'active');
        assert.equal(c.profile.quality_rating, 'YELLOW');
        assert.ok(seen.every((s) => !s.url.includes('debug_token')), 'a healthy connection is not re-inspected');
        assert.ok(statements.some((s) => /SET display_name = COALESCE/.test(s.sql)));
    });

    it('brings an invalid connection back to active only when debug_token says the token is valid and carries both scopes', async () => {
        arrangeMeta();
        arrangeDb('invalid');

        const c = await refreshHealth(CREATOR);

        assert.equal(c.status, 'active');
        assert.equal(c.lastError, null);
        assert.ok(statements.some((s) => /SET status = 'active'/.test(s.sql)));
    });

    it('leaves it invalid when the token is valid but a scope is gone: a read that works is not proof it can send', async () => {
        arrangeMeta({ debug: { is_valid: true, app_id: '847772258381375', expires_at: 0, scopes: ['whatsapp_business_messaging'] } });
        arrangeDb('invalid');

        const c = await refreshHealth(CREATOR);

        assert.equal(c.status, 'invalid');
        assert.ok(!statements.some((s) => /SET status = 'active'/.test(s.sql)));
    });

    it('marks the connection invalid, with Meta’s words, when Meta refuses the token, and rethrows', async () => {
        arrangeMeta({ health: async () => { throw Object.assign(new Error('x'), { response: { status: 400, data: { error: { code: 190, message: 'Error validating access token: Session has expired' } } } }); } });
        arrangeDb('active');

        await assert.rejects(() => refreshHealth(CREATOR), (err: unknown) => isAuthRefusal(err));

        const invalid = statements.find((s) => /SET status = 'invalid'/.test(s.sql));
        assert.ok(invalid, 'the connection is marked invalid');
        assert.match(String(invalid!.params[1]), /Session has expired/);
        assert.ok(!String(invalid!.params[1]).includes(TOKEN));
    });

    it('stores a reason with no token in it, even when Meta echoes the token in its refusal', async () => {
        arrangeMeta({ health: async () => { throw Object.assign(new Error('x'), { response: { status: 400, data: { error: { code: 190, message: `Invalid OAuth access token ${TOKEN}` } } } }); } });
        arrangeDb('active');

        await assert.rejects(() => refreshHealth(CREATOR), (err: Error) => !err.message.includes(TOKEN));

        const invalid = statements.find((s) => /SET status = 'invalid'/.test(s.sql))!;
        assert.ok(!String(invalid.params[1]).includes(TOKEN));
        assert.match(String(invalid.params[1]), /Invalid OAuth access token \[token\]/);
    });

    it('leaves a working connection exactly as it was when Meta fails for any other reason', async () => {
        for (const failure of [
            Object.assign(new Error('boom'), { response: { status: 500, data: {} } }),
            Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
            Object.assign(new Error('bad field'), { response: { status: 400, data: { error: { code: 100, message: 'Unsupported get request' } } } }),
        ]) {
            statements = [];
            arrangeMeta({ health: async () => { throw failure; } });
            arrangeDb('active');
            await assert.rejects(() => refreshHealth(CREATOR));
            assert.ok(!statements.some((s) => /SET status = 'invalid'/.test(s.sql)), `${(failure as any).code ?? (failure as any).response.status} must not flip a working connection`);
        }
    });

    it('says not connected for a tenant with no usable connection, and asks Meta nothing', async () => {
        const seen = arrangeMeta();
        respond = () => ({ rows: [] });
        await assert.rejects(() => refreshHealth(CREATOR), WhatsAppNotConnectedError);
        assert.equal(seen.length, 0);
    });

    it('classifies 190, 200 and 10 as a refusal of the token or a permission, and nothing else', () => {
        const err = (code: number) => ({ response: { status: 400, data: { error: { code } } } });
        for (const code of [190, 200, 10]) assert.equal(isAuthRefusal(err(code)), true, String(code));
        for (const code of [100, 1, 2, 4, 131047, 131056]) assert.equal(isAuthRefusal(err(code)), false, String(code));
        assert.equal(isAuthRefusal(new Error('x')), false);
        assert.equal(isAuthRefusal(undefined), false);
    });
});
