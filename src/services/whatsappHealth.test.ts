/**
 * The daily WhatsApp health read: what one number's read changes, who is told, and that one tenant's trouble never reaches the next.
 *
 * `whatsappTestSupport.ts` is the database (an in-memory `platform_connections` that judges the real compare-and-set); `metaHttp.get` answers
 * the phone-number reads (the core fields, then the two extras, as `getPhoneNumberHealth` asks them) and `axios.get` answers `debug_token`;
 * Telegram is a recorder. Nothing leaves the process.
 *
 * What is pinned, because each is a way this goes wrong without anyone noticing:
 *   - a quality, limit, number-status or name change is told ONCE (the second read of the same value is quiet) and GREEN -> YELLOW -> GREEN
 *     -> YELLOW across four days is four alerts
 *   - the first reading of something, with nothing to compare it with, is recorded and not announced
 *   - 190, 200 and 10 mark the connection invalid and tell the owner once, however many days it stays dead; any other failure changes nothing
 *   - a connection that comes back says so once, and a block Meta put on the account is not undone by a token that checks out
 *   - one tenant's failure (a Meta timeout, a database error mid-write, Telegram down) is counted against that tenant; the rest are read, and
 *     the sweep returns instead of throwing into the cron that called it
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from './http.js';
import { telegramHttp } from './notify.js';
import { checkConnectionHealth, healthChanges, refreshAllWhatsAppConnections } from './whatsappHealth.js';
import { activeAccountBlock, getConnection, readProfile } from './whatsappConnections.js';
import { connectionQuery, fakeConnection, newConnectionDb, type ConnectionDb, type FakeConnection } from './whatsappTestSupport.js';

const A = '106540352242922';
const B = '106540352242923';
const C = '106540352242924';
const CREATOR_A = '11111111-1111-4111-8111-111111111111';
const CREATOR_B = '22222222-2222-4222-8222-222222222222';
const CREATOR_C = '33333333-3333-4333-8333-333333333333';

interface MetaAnswer {
    core?: Record<string, unknown>;
    extras?: Record<string, unknown>;
    /** Thrown by the core read (a Graph failure). */
    coreError?: unknown;
}

let db: ConnectionDb;
let meta: Record<string, MetaAnswer>;
let metaCalls: string[];
let debug: unknown;
let telegram: string[];
let telegramAnswer: 'ok' | 'unreachable';
let logs: Array<Record<string, any>>;
let statements: string[];
let queryFails: ((sql: string, params: unknown[]) => boolean) | null;
const originalQuery = pool.query;
const originals = { get: metaHttp.get, post: metaHttp.post, axiosGet: axios.get, axiosPost: axios.post, telegram: telegramHttp.post };
let restoreSink: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

const GOOD = { display_phone_number: '+1 555-078-3881', verified_name: 'Lucky Shrub', quality_rating: 'GREEN', code_verification_status: 'VERIFIED', name_status: 'APPROVED', throughput: { level: 'STANDARD' } };
const EXTRAS = { status: 'CONNECTED', whatsapp_business_manager_messaging_limit: 'TIER_250' };

const metaError = (code: number, message: string) => Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: { code, message } } } });

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.META_APP_ID = '847772258381375';
    process.env.META_APP_SECRET = 'the-app-secret-never-in-a-log';
    db = newConnectionDb([fakeConnection({ id: 'conn-a', creator_id: CREATOR_A, external_account_id: A })]);
    meta = { [A]: { core: GOOD, extras: EXTRAS } };
    metaCalls = [];
    debug = { is_valid: true, app_id: '847772258381375', expires_at: 0, scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'] };
    telegram = [];
    telegramAnswer = 'ok';
    logs = [];
    statements = [];
    queryFails = null;
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);
    (pool as unknown as { query: unknown }).query = async (sqlIn: string, params: unknown[] = []) => {
        const sql = sqlIn.replace(/\s+/g, ' ').trim();
        statements.push(sql);
        if (queryFails?.(sql, params)) throw new Error('connection terminated unexpectedly');
        const mine = connectionQuery(db, sql, params);
        if (mine) return mine;
        if (/FROM app_settings WHERE key/.test(sql)) {
            const rows = [['notify.telegram_bot_token', '123456789:AAEhBP0av28dummydummydummydummydummy12'], ['notify.telegram_chat_id', '424242'], ['notify.telegram_enabled', 'true']];
            return { rows: rows.map(([key, value]) => ({ key, value, is_secret: false })), rowCount: 3 };
        }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    (metaHttp as any).get = async (url: string, config: any) => {
        metaCalls.push(`GET ${url} ${config?.params?.fields ?? ''}`);
        const phone = url.split('/').pop()!;
        const answer = meta[phone];
        if (!answer) throw new Error(`no Meta answer arranged for ${phone}`);
        if (String(config.params.fields).startsWith('display_phone_number')) {
            if (answer.coreError) throw answer.coreError;
            return { data: answer.core };
        }
        if (!answer.extras) throw metaError(100, 'Tried accessing nonexisting field');
        return { data: answer.extras };
    };
    (metaHttp as any).post = async (url: string) => { throw new Error(`no POST may be made: ${url}`); };
    (axios as any).get = async (url: string) => { metaCalls.push(`axios GET ${url}`); return { data: { data: debug } }; };
    (axios as any).post = async (url: string) => { throw new Error(`no axios POST may be made: ${url}`); };
    (telegramHttp as any).post = async (_url: string, body: any) => {
        telegram.push(body.text);
        if (telegramAnswer === 'unreachable') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        return { data: { ok: true } };
    };
});

afterEach(() => {
    restoreSink?.();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originals.get;
    (metaHttp as any).post = originals.post;
    (axios as any).get = originals.axiosGet;
    (axios as any).post = originals.axiosPost;
    (telegramHttp as any).post = originals.telegram;
});

const conn = (id = 'conn-a'): FakeConnection => db.connections.find((c) => c.id === id)!;
const profile = (id = 'conn-a') => conn(id).profile as Record<string, any>;
const logged = (event: string) => logs.filter((l) => l.event === event);
const addTenant = (id: string, creator: string, phone: string, over: Partial<FakeConnection> = {}) => {
    db.connections.push(fakeConnection({ id, creator_id: creator, external_account_id: phone, ...over }));
    meta[phone] = { core: GOOD, extras: EXTRAS };
};

// ─── One number ─────────────────────────────────────────────────────────────────────────

describe('checkConnectionHealth', () => {
    it('an unchanged number: the facts are refreshed, nobody is told, nothing is invalid', async () => {
        const check = await checkConnectionHealth(CREATOR_A);
        assert.deepEqual(check, { outcome: 'ok', alerts: 0, alertFailures: 0 });
        assert.deepEqual([conn().status, telegram.length], ['active', 0]);
        assert.notEqual(profile().read_at, '2026-10-18T08:00:00.000Z', 'the read is noted');
        assert.equal(logged('wa.health_checked').length, 1);
    });

    it('a quality drop is told once: the next read of the same value is quiet', async () => {
        meta[A]!.core = { ...GOOD, quality_rating: 'YELLOW' };
        assert.equal((await checkConnectionHealth(CREATOR_A)).alerts, 1);
        assert.match(telegram[0]!, /Quality dropped \(GREEN → YELLOW\)/);
        assert.match(telegram[0]!, /واتساب/);
        assert.equal(profile().quality_rating, 'YELLOW');

        assert.equal((await checkConnectionHealth(CREATOR_A)).alerts, 0);
        assert.equal(telegram.length, 1);
    });

    it('GREEN -> YELLOW -> GREEN -> YELLOW over four days is four alerts', async () => {
        for (const rating of ['YELLOW', 'GREEN', 'YELLOW', 'RED']) {
            meta[A]!.core = { ...GOOD, quality_rating: rating };
            await checkConnectionHealth(CREATOR_A);
        }
        assert.equal(telegram.length, 4);
        assert.match(telegram[1]!, /Quality is good again \(YELLOW → GREEN\)/);
        assert.match(telegram[3]!, /\(YELLOW → RED\)/);
    });

    it('a change that is not news (UNKNOWN: not enough data yet) is recorded and not told', async () => {
        meta[A]!.core = { ...GOOD, quality_rating: 'UNKNOWN' };
        assert.equal((await checkConnectionHealth(CREATOR_A)).alerts, 0);
        assert.equal(profile().quality_rating, 'UNKNOWN');
        assert.equal(profile().alerts.quality, 'UNKNOWN');
    });

    it('the first reading of a thing with nothing to compare it with is recorded and not announced', async () => {
        delete profile().quality_rating;
        delete profile().messaging_limit;
        delete profile().number_status;
        delete profile().name_status;
        assert.deepEqual(await checkConnectionHealth(CREATOR_A), { outcome: 'ok', alerts: 0, alertFailures: 0 });
        assert.deepEqual(profile().alerts, { quality: 'GREEN', limit: 'TIER_250', number_status: 'CONNECTED', name: 'APPROVED:Lucky Shrub' });
        // ...and the next real change is told against that baseline.
        meta[A]!.core = { ...GOOD, quality_rating: 'RED' };
        assert.equal((await checkConnectionHealth(CREATOR_A)).alerts, 1);
    });

    it('a messaging-limit change (whatsapp_business_manager_messaging_limit) is told with what it was', async () => {
        meta[A]!.extras = { ...EXTRAS, whatsapp_business_manager_messaging_limit: 'TIER_1K' };
        assert.equal((await checkConnectionHealth(CREATOR_A)).alerts, 1);
        assert.match(telegram[0]!, /TIER_250 to TIER_1K/);
        assert.equal(profile().messaging_limit, 'TIER_1K');
        assert.ok(metaCalls.some((c) => c.includes('whatsapp_business_manager_messaging_limit')), 'the limit field is asked for');
    });

    it('extras Meta refuses cost the limit and the status and nothing else: no crash, no false alert', async () => {
        delete meta[A]!.extras;
        meta[A]!.core = { ...GOOD, quality_rating: 'YELLOW' };
        const check = await checkConnectionHealth(CREATOR_A);
        assert.equal(check.outcome, 'ok');
        assert.equal(check.alerts, 1, 'only the quality');
        assert.match(telegram[0]!, /Quality dropped/);
    });

    it('a number that goes FLAGGED and then recovers is told both times', async () => {
        meta[A]!.extras = { ...EXTRAS, status: 'FLAGGED' };
        await checkConnectionHealth(CREATOR_A);
        meta[A]!.extras = EXTRAS;
        await checkConnectionHealth(CREATOR_A);
        assert.match(telegram[0]!, /FLAGGED \(was CONNECTED\)/);
        assert.match(telegram[1]!, /CONNECTED \(was FLAGGED\)/);
    });

    it('a name review answer is told (and a wait is not)', async () => {
        profile().name_status = 'PENDING_REVIEW';
        meta[A]!.core = { ...GOOD, name_status: 'AVAILABLE_WITHOUT_REVIEW' };
        assert.equal((await checkConnectionHealth(CREATOR_A)).alerts, 0);
        meta[A]!.core = { ...GOOD, name_status: 'APPROVED', verified_name: 'Lucky Shrub Ltd' };
        assert.equal((await checkConnectionHealth(CREATOR_A)).alerts, 1);
        assert.match(telegram[0]!, /Business name approved: Lucky Shrub Ltd/);
        assert.equal(conn().display_name, 'Lucky Shrub Ltd');
    });

    it('never reads a disconnected connection, or one with no token', async () => {
        conn().access_token = null;
        assert.equal((await checkConnectionHealth(CREATOR_A)).outcome, 'skipped');
        conn().access_token = 'x';
        conn().status = 'revoked';
        assert.equal((await checkConnectionHealth(CREATOR_A)).outcome, 'skipped');
        assert.equal((await checkConnectionHealth('99999999-9999-4999-8999-999999999999')).outcome, 'skipped');
        assert.deepEqual(metaCalls, []);
    });
});

describe('a refused token', () => {
    for (const code of [190, 200, 10]) {
        it(`${code}: the connection is invalid with Meta’s words, and the owner is told`, async () => {
            meta[A]!.coreError = metaError(code, 'Error validating access token: Session has expired');
            const check = await checkConnectionHealth(CREATOR_A);
            assert.deepEqual(check, { outcome: 'invalid', alerts: 1, alertFailures: 0 });
            assert.deepEqual([conn().status, /Session has expired/.test(String(conn().last_error))], ['invalid', true]);
            assert.match(telegram[0]!, /Meta refused the WhatsApp token/);
            assert.match(telegram[0]!, new RegExp(`Code ${code}`));
            assert.match(telegram[0]!, /incoming messages are still stored/i);
        });
    }

    it('stays quiet on every later day it is still refused: one alert, not one a day', async () => {
        meta[A]!.coreError = metaError(190, 'Session has expired');
        for (let day = 0; day < 4; day++) await checkConnectionHealth(CREATOR_A);
        assert.equal(telegram.length, 1);
        assert.equal(conn().status, 'invalid');
    });

    it('is reported even when something else marked it invalid first and nobody was told (the dead token a send found)', async () => {
        conn().status = 'invalid';
        conn().last_error = 'Session has expired';
        meta[A]!.coreError = metaError(190, 'Session has expired');
        await checkConnectionHealth(CREATOR_A);
        assert.equal(telegram.length, 1);
    });

    it('comes back with the token: active again, and the owner who was told it was dead is told it works', async () => {
        meta[A]!.coreError = metaError(190, 'Session has expired');
        await checkConnectionHealth(CREATOR_A);
        delete meta[A]!.coreError;

        const check = await checkConnectionHealth(CREATOR_A);

        assert.deepEqual([check.outcome, conn().status, conn().last_error], ['ok', 'active', null]);
        assert.equal(telegram.length, 2);
        assert.match(telegram[1]!, /works again/);
        assert.equal(profile().alerts.connection, 'active');
        await checkConnectionHealth(CREATOR_A);
        assert.equal(telegram.length, 2, 'once');
    });

    it('does not come back while the token is missing a scope: a read that works is not proof it can send', async () => {
        meta[A]!.coreError = metaError(190, 'Session has expired');
        await checkConnectionHealth(CREATOR_A);
        delete meta[A]!.coreError;
        debug = { is_valid: true, app_id: '847772258381375', expires_at: 0, scopes: ['whatsapp_business_messaging'] };
        const check = await checkConnectionHealth(CREATOR_A);
        assert.deepEqual([check.outcome, conn().status, telegram.length], ['invalid', 'invalid', 1]);
    });

    it('any other failure leaves a working connection exactly as it was: no invalid, no alert', async () => {
        for (const failure of [new Error('socket hang up'), metaError(100, 'Unsupported get request'), metaError(131056, 'pair rate limit')]) {
            meta[A]!.coreError = failure;
            await assert.rejects(() => checkConnectionHealth(CREATOR_A));
            assert.deepEqual([conn().status, telegram.length], ['active', 0]);
        }
    });
});

describe('a block Meta put on the account', () => {
    it('is not undone by a token that checks out: the connection stays invalid and nothing new is said', async () => {
        conn().status = 'invalid';
        conn().last_error = 'Meta disabled this WhatsApp account.';
        profile().account_block = 'banned';
        profile().alerts = { connection: 'invalid', ban: 'DISABLE:April 17, 2025' };
        const check = await checkConnectionHealth(CREATOR_A);
        assert.deepEqual([check.outcome, conn().status, profile().account_block, telegram.length], ['invalid', 'invalid', 'banned', 0]);
        assert.equal(logged('whatsapp.connection_blocked').length, 1);
        assert.ok(!metaCalls.some((c) => c.includes('debug_token')), 'the token is not even asked about: it would prove nothing');
    });

    it('a restriction that has ended is cleared by the clock, the token is checked, and the owner is told it works', async () => {
        conn().status = 'invalid';
        profile().account_block = 'restricted';
        profile().block_until = '2001-01-01T00:00:00.000Z';
        profile().alerts = { connection: 'invalid', restriction: 'RESTRICTED_CUSTOMER_INITIATED_MESSAGING@978307200' };
        const check = await checkConnectionHealth(CREATOR_A);
        assert.deepEqual([check.outcome, conn().status, profile().account_block, profile().block_until], ['ok', 'active', undefined, undefined]);
        assert.match(telegram[0]!, /works again/);
    });

    it('a restriction that has not ended still holds', async () => {
        conn().status = 'invalid';
        profile().account_block = 'restricted';
        profile().block_until = '2100-01-01T00:00:00.000Z';
        profile().alerts = { connection: 'invalid' };
        await checkConnectionHealth(CREATOR_A);
        assert.deepEqual([conn().status, profile().account_block], ['invalid', 'restricted']);
    });
});

describe('the block on the profile', () => {
    it('is read only when it is one of the five Meta-driven kinds, and a restriction ends by the clock', () => {
        assert.equal(readProfile({ account_block: 'banned' }).account_block, 'banned');
        assert.equal(readProfile({ account_block: 'because' }).account_block, undefined);
        assert.ok(!('account_block' in readProfile({})), 'a profile without a block is unchanged');
        assert.equal(readProfile({ account_block: 'restricted', block_until: '2100-01-01T00:00:00.000Z' }).block_until, '2100-01-01T00:00:00.000Z');
        assert.equal(readProfile({ block_until: '2100-01-01T00:00:00.000Z' }).block_until, undefined, 'an end without a block is nothing');
        const now = new Date('2026-10-19T00:00:00Z');
        assert.equal(activeAccountBlock({ account_block: 'restricted', block_until: '2026-10-18T00:00:00.000Z' }, now), null);
        assert.equal(activeAccountBlock({ account_block: 'restricted', block_until: '2026-10-20T00:00:00.000Z' }, now), 'restricted');
        assert.equal(activeAccountBlock({ account_block: 'restricted' }, now), 'restricted', 'no stated end: it holds until Meta says');
        assert.equal(activeAccountBlock({ account_block: 'banned', block_until: '2001-01-01T00:00:00.000Z' }, now), 'banned', 'only a restriction ends by the clock');
        assert.equal(activeAccountBlock({}, now), null);
    });
});

describe('healthChanges', () => {
    it('is pure: no change at all for two identical reads of a connection that never had an alert', async () => {
        const c = (await getConnection(CREATOR_A))!;
        const keys = healthChanges(c, c).map((ch) => ch.key);
        assert.deepEqual(keys, ['quality', 'limit', 'number_status', 'name', 'connection']);
    });
});

// ─── The sweep ──────────────────────────────────────────────────────────────────────────

describe('refreshAllWhatsAppConnections', () => {
    it('reads every connected number and counts what it found', async () => {
        addTenant('conn-b', CREATOR_B, B);
        addTenant('conn-c', CREATOR_C, C);
        meta[B]!.core = { ...GOOD, quality_rating: 'RED' };
        meta[C]!.coreError = metaError(190, 'Session has expired');
        const result = await refreshAllWhatsAppConnections();
        assert.deepEqual(result, { checked: 3, invalid: 1, alerts: 2, alertFailures: 0, skipped: 0, failed: 0, moreRemaining: false });
        assert.deepEqual([conn('conn-a').status, conn('conn-b').status, conn('conn-c').status], ['active', 'active', 'invalid']);
    });

    it('does not list a disconnected number or one with no token', async () => {
        addTenant('conn-b', CREATOR_B, B, { status: 'revoked', access_token: null });
        addTenant('conn-c', CREATOR_C, C, { access_token: null });
        const result = await refreshAllWhatsAppConnections();
        assert.equal(result.checked, 1);
        assert.ok(!metaCalls.some((c) => c.includes(B) || c.includes(C)));
    });

    it('one tenant’s Meta failure does not stop the rest, and is counted against that tenant', async () => {
        addTenant('conn-b', CREATOR_B, B);
        addTenant('conn-c', CREATOR_C, C);
        meta[A]!.core = { ...GOOD, quality_rating: 'YELLOW' };
        meta[B]!.coreError = new Error('socket hang up');
        meta[C]!.core = { ...GOOD, quality_rating: 'YELLOW' };
        const result = await refreshAllWhatsAppConnections();
        assert.deepEqual([result.failed, result.checked, result.alerts], [1, 2, 2]);
        assert.equal(profile('conn-a').quality_rating, 'YELLOW');
        assert.equal(profile('conn-c').quality_rating, 'YELLOW', 'the tenant after the failure was still read');
        assert.equal(logged('wa.health_sweep_row_failed').length, 1);
        assert.equal(logged('wa.health_sweep_row_failed')[0]!.creator_id, CREATOR_B);
    });

    it('one tenant’s database error in the middle of its own write does not stop the rest either, and the sweep does not throw', async () => {
        addTenant('conn-b', CREATOR_B, B);
        addTenant('conn-c', CREATOR_C, C);
        for (const phone of [A, B, C]) meta[phone]!.core = { ...GOOD, quality_rating: 'YELLOW' };
        // Every statement about B's connection fails (the read of it, the claim, the write).
        queryFails = (_sql, params) => params.includes('conn-b') || params.includes(CREATOR_B);
        const result = await refreshAllWhatsAppConnections();
        assert.deepEqual([result.failed, result.checked, result.alerts], [1, 2, 2]);
        assert.deepEqual([profile('conn-a').quality_rating, profile('conn-c').quality_rating], ['YELLOW', 'YELLOW']);
    });

    it('a listing that fails returns zeros instead of throwing into the cron', async () => {
        queryFails = (sql) => /SELECT creator_id FROM platform_connections/.test(sql);
        const result = await refreshAllWhatsAppConnections();
        assert.deepEqual(result, { checked: 0, invalid: 0, alerts: 0, alertFailures: 0, skipped: 0, failed: 0, moreRemaining: false });
        assert.equal(logged('wa.health_sweep_failed').length, 1);
        assert.deepEqual(metaCalls, []);
    });

    it('Telegram being down does not fail the sweep: the alert is counted, and the claim is given back so tomorrow tries again', async () => {
        meta[A]!.core = { ...GOOD, quality_rating: 'YELLOW' };
        telegramAnswer = 'unreachable';
        const first = await refreshAllWhatsAppConnections();
        assert.deepEqual([first.alertFailures, first.alerts, first.failed], [1, 0, 0]);
        assert.equal(profile().alerts.quality, 'GREEN', 'the value the owner last heard');

        telegramAnswer = 'ok';
        const second = await refreshAllWhatsAppConnections();
        assert.deepEqual([second.alerts, second.alertFailures], [1, 0]);
        assert.match(telegram.at(-1)!, /\(GREEN → YELLOW\)/);
    });

    it('reads the least recently read first and says when there are more than it took', async () => {
        addTenant('conn-b', CREATOR_B, B, { last_refreshed_at: null });
        addTenant('conn-c', CREATOR_C, C, { last_refreshed_at: new Date('2026-10-01T00:00:00Z') });
        const result = await refreshAllWhatsAppConnections({ limit: 2 });
        assert.deepEqual([result.checked, result.moreRemaining], [2, true]);
        const asked = metaCalls.filter((c) => /display_phone_number/.test(c)).map((c) => c.split('/').pop()!.split(' ')[0]);
        assert.deepEqual(asked, [B, C], 'never-read first, then the oldest; A (read yesterday) waits');
    });
});
