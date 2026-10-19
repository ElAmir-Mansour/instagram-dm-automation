/**
 * What an account-level WhatsApp event does to the connection, and who is told, once.
 *
 * The events are Meta's own published samples (`src/webhook/__fixtures__/whatsapp/`), read from disk and run the way production runs them:
 * the body -> `planJobs` -> the `wa.event` job's payload -> the handler. A shape no sample exists for (a restriction that stops replies, a ban
 * that disables, a name Meta declined) is that sample with ONE field changed, and the test says which, never a payload written from memory.
 *
 * The database is `whatsappTestSupport.ts`: an in-memory `platform_connections` that really judges the compare-and-set, so a lost race and a
 * duplicate are the real thing. Telegram is a recorder; `metaHttp` and `axios` refuse every call (an account event asks Meta nothing).
 *
 * What is pinned, because each is a way this goes wrong without anyone noticing:
 *   - every field of every sample maps to the profile / status / alert it should, and the informational ones change nothing
 *   - the same event twice is ONE alert; GREEN -> YELLOW -> GREEN -> YELLOW is FOUR (review M13), because "same" is judged against the stored
 *     value and never the clock
 *   - a disconnection, ban or restriction that stops replying makes the connection `invalid`, and only Meta saying it is over brings it back;
 *     a "reconnected" cannot revive a token that is dead
 *   - an alert that cannot be sent gives its claim back and fails the job, so the retry sends it once; alerts switched off are not an error
 *   - a lost compare-and-set re-decides against what won
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import type { WaEventPayload } from '../jobs/types.js';
import { planJobs } from '../webhook/router.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from './http.js';
import { telegramHttp } from './notify.js';
import { checkFreeTierAlert, handleAccountEvent, planAccountEvent } from './whatsappAccount.js';
import { buildWhatsAppAlertText } from './whatsappNotify.js';
import { connectionQuery, fakeConnection, newConnectionDb, type ConnectionDb } from './whatsappTestSupport.js';

type Account = Extract<WaEventPayload, { kind: 'account' }>;

const FIXTURES = fileURLToPath(new URL('../webhook/__fixtures__/whatsapp/', import.meta.url));
const CHAT = '424242';
const BOT = '123456789:AAEhBP0av28dummydummydummydummydummy12';

let db: ConnectionDb;
let usage: { service: number; queries: number };
let telegram: Array<{ url: string; body: { chat_id: string; text: string } }>;
let telegramAnswer: 'ok' | 'reject' | 'unreachable';
let settings: Record<string, string>;
let logs: Array<Record<string, any>>;
let metaCalls: string[];
let statements: string[];
const originalQuery = pool.query;
const originals = { get: metaHttp.get, post: metaHttp.post, axiosGet: axios.get, axiosPost: axios.post, telegram: telegramHttp.post };
let restoreSink: (() => void) | undefined;
let savedKey: string | undefined;

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    db = newConnectionDb([fakeConnection()]);
    usage = { service: 0, queries: 0 };
    telegram = [];
    telegramAnswer = 'ok';
    settings = { 'notify.telegram_bot_token': BOT, 'notify.telegram_chat_id': CHAT, 'notify.telegram_enabled': 'true' };
    logs = [];
    metaCalls = [];
    statements = [];
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);
    (pool as unknown as { query: unknown }).query = async (sqlIn: string, params: unknown[] = []) => {
        const sql = sqlIn.replace(/\s+/g, ' ').trim();
        statements.push(sql);
        const mine = connectionQuery(db, sql, params);
        if (mine) return mine;
        if (/FROM app_settings WHERE key/.test(sql)) {
            const keys: string[] = Array.isArray(params[0]) ? (params[0] as string[]) : [String(params[0])];
            return { rows: keys.filter((k) => k in settings).map((key) => ({ key, value: settings[key], is_secret: false })), rowCount: 0 };
        }
        if (/FROM channel_usage/.test(sql)) { usage.queries++; return { rows: [{ n: usage.service }], rowCount: 1 }; }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    const refuse = (verb: string) => async (url: string) => { metaCalls.push(`${verb} ${url}`); throw new Error(`no Meta call may be made: ${verb} ${url}`); };
    (metaHttp as any).get = refuse('GET');
    (metaHttp as any).post = refuse('POST');
    (axios as any).get = refuse('axios GET');
    (axios as any).post = refuse('axios POST');
    (telegramHttp as any).post = async (url: string, body: any) => {
        telegram.push({ url, body });
        if (telegramAnswer === 'reject') throw Object.assign(new Error('Forbidden'), { response: { status: 403, data: { description: 'Forbidden: bot was blocked by the user' } } });
        if (telegramAnswer === 'unreachable') throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
        return { data: { ok: true } };
    };
});

afterEach(() => {
    assert.deepEqual(metaCalls, [], 'a Meta call was made');
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    restoreSink?.();
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originals.get;
    (metaHttp as any).post = originals.post;
    (axios as any).get = originals.axiosGet;
    (axios as any).post = originals.axiosPost;
    (telegramHttp as any).post = originals.telegram;
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

const sample = (name: string): any => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8'));
const accountPayloads = (body: any): Account[] => planJobs(body).filter((j) => j.kind === 'wa.event').map((j) => j.payload as Account).filter((p) => p.kind === 'account');

/** The sample, with the connection's Messaging account set to the sample's own `entry.id`: the lookup is the real one, the sample is untouched. */
function receiveSample(name: string, edit: (body: any) => void = () => {}): Account[] {
    const body = sample(name);
    edit(body);
    for (const c of db.connections) if (c.profile) c.profile.waba_id = body.entry[0].id;
    return accountPayloads(body);
}

async function handle(payloads: Account[]) {
    const outcomes = [];
    for (const p of payloads) outcomes.push(await handleAccountEvent(p));
    return outcomes;
}

const conn = (i = 0) => db.connections[i]!;
const profile = (i = 0) => conn(i).profile as Record<string, any>;
const logged = (event: string) => logs.filter((l) => l.event === event);
const texts = () => telegram.map((t) => t.body.text);
const touchedConnections = () => statements.filter((s) => /^UPDATE platform_connections/.test(s)).length;

// ─── The samples: every field to the change it should make ──────────────────────────────

describe('account_update', () => {
    it('ACCOUNT_DELETED: the connection is invalid, blocked as deleted, and the owner is told', async () => {
        await handle(receiveSample('account-update-account-deleted'));
        assert.equal(conn().status, 'invalid');
        assert.equal(profile().account_block, 'deleted');
        assert.match(String(conn().last_error), /deleted/);
        assert.equal(profile().disconnection.event, 'ACCOUNT_DELETED');
        assert.equal(telegram.length, 1);
        assert.match(texts()[0]!, /WhatsApp/);
        assert.match(texts()[0]!, /واتساب/);
        assert.match(texts()[0]!, /\+1 555-078-3881/);
    });

    it('ACCOUNT_OFFBOARDED: invalid, blocked as offboarded', async () => {
        await handle(receiveSample('account-update-account-offboarded'));
        assert.deepEqual([conn().status, profile().account_block, telegram.length], ['invalid', 'offboarded', 1]);
    });

    it('PARTNER_REMOVED with disconnection_info: invalid, blocked as disconnected, with Meta’s reason and who started it', async () => {
        await handle(receiveSample('account-update-partner-removed-disconnection'));
        assert.deepEqual([conn().status, profile().account_block], ['invalid', 'disconnected']);
        assert.deepEqual([profile().disconnection.reason, profile().disconnection.initiated_by], ['PRIMARY_INACTIVITY', 'SYSTEM']);
        assert.match(String(conn().last_error), /PRIMARY_INACTIVITY/);
        assert.match(texts()[0]!, /PRIMARY_INACTIVITY/);
    });

    it('PARTNER_REMOVED without disconnection_info: a partner left the account, this app is untouched, nobody is told', async () => {
        const outcomes = await handle(receiveSample('account-update-partner-removed'));
        assert.deepEqual(outcomes, [{ kind: 'informational' }]);
        assert.deepEqual([conn().status, telegram.length, touchedConnections()], ['active', 0, 0]);
    });

    it('ACCOUNT_RECONNECTED: a connection Meta had offboarded goes back to active, its block cleared, and the owner is told', async () => {
        await handle(receiveSample('account-update-account-offboarded'));
        assert.equal(conn().status, 'invalid');

        await handle(receiveSample('account-update-account-reconnected'));

        assert.deepEqual([conn().status, conn().last_error, profile().account_block, profile().disconnection], ['active', null, undefined, null]);
        assert.equal(telegram.length, 2);
        assert.match(texts()[1]!, /connected again/);
    });

    it('ACCOUNT_RECONNECTED does not revive a connection that is invalid because its TOKEN is dead', async () => {
        conn().status = 'invalid';
        conn().last_error = 'Session has expired';
        await handle(receiveSample('account-update-account-reconnected'));
        assert.deepEqual([conn().status, conn().last_error], ['invalid', 'Session has expired']);
        assert.equal(profile().account_block, undefined);
    });

    it('ACCOUNT_RESTRICTION on business-initiated messaging and adding numbers: recorded and told, replies untouched, still active', async () => {
        await handle(receiveSample('account-update-account-restriction'));
        assert.equal(conn().status, 'active');
        assert.equal(profile().account_block, undefined);
        assert.deepEqual(profile().restriction.types, ['RESTRICTED_ADD_PHONE_NUMBER_ACTION', 'RESTRICTED_BIZ_INITIATED_MESSAGING']);
        assert.equal(profile().restriction.stops_sending, false);
        assert.equal(telegram.length, 1);
        assert.match(texts()[0]!, /RESTRICTED_BIZ_INITIATED_MESSAGING/);
        assert.match(texts()[0]!, /replies are not affected/);
    });

    it('ACCOUNT_RESTRICTION on customer-initiated messaging (synthetic: the sample with that type and a future end): invalid until the end', async () => {
        const end = 1641330498 + 7 * 86400;
        await handle(receiveSample('account-update-account-restriction', (body) => {
            body.entry[0].changes[0].value.restriction_info = [{ restriction_type: 'RESTRICTED_CUSTOMER_INITIATED_MESSAGING', expiration: end }];
        }));
        assert.deepEqual([conn().status, profile().account_block, profile().block_until], ['invalid', 'restricted', new Date(end * 1000).toISOString()]);
        assert.equal(profile().restriction.stops_sending, true);
        assert.match(texts()[0]!, /sending is stopped/);
    });

    it('a customer-initiated restriction that had ALREADY ended when Meta announced it stops nothing (the sample’s own times: expiration = time)', async () => {
        await handle(receiveSample('account-update-account-restriction', (body) => {
            body.entry[0].changes[0].value.restriction_info = [{ restriction_type: 'RESTRICTED_CUSTOMER_INITIATED_MESSAGING', expiration: 1641330498 }];
        }));
        assert.equal(conn().status, 'active');
        assert.equal(profile().restriction.stops_sending, false);
    });

    it('ACCOUNT_VIOLATION: the type is recorded and told; the connection keeps working', async () => {
        await handle(receiveSample('account-update-account-violation'));
        assert.deepEqual([conn().status, profile().violation.type], ['active', 'ADULT']);
        assert.match(texts()[0]!, /ADULT/);
    });

    it('DISABLED_UPDATE REINSTATE (the sample): told, recorded; and it lifts a ban', async () => {
        await handle(receiveSample('account-update-disabled-update', (body) => { body.entry[0].changes[0].value.ban_info.waba_ban_state = 'DISABLE'; }));
        assert.deepEqual([conn().status, profile().account_block], ['invalid', 'banned']);

        await handle(receiveSample('account-update-disabled-update'));

        assert.deepEqual([conn().status, profile().account_block, profile().ban.state], ['active', undefined, 'REINSTATE']);
        assert.equal(telegram.length, 2);
        assert.match(texts()[1]!, /reinstated/);
    });

    it('DISABLED_UPDATE SCHEDULE_FOR_DISABLE warns and changes no status; an unknown ban state is logged, never guessed', async () => {
        await handle(receiveSample('account-update-disabled-update', (body) => { body.entry[0].changes[0].value.ban_info.waba_ban_state = 'SCHEDULE_FOR_DISABLE'; }));
        assert.deepEqual([conn().status, telegram.length], ['active', 1]);
        assert.match(texts()[0]!, /going to disable/);

        const outcomes = await handle(receiveSample('account-update-disabled-update', (body) => { body.entry[0].changes[0].value.ban_info.waba_ban_state = 'SOMETHING_NEW'; }));
        assert.deepEqual(outcomes, [{ kind: 'unhandled' }]);
        assert.equal(logged('wa.account_event_unhandled').at(-1)!.reason, 'unknown_ban_state');
        assert.equal(telegram.length, 1);
    });

    for (const name of [
        'account-update-ad-account-linked', 'account-update-auth-intl-price-eligibility-update', 'account-update-business-primary-location-country-update',
        'account-update-mm-lite-terms-signed', 'account-update-partner-added', 'account-update-partner-app-installed', 'account-update-partner-app-uninstalled',
        'account-update-partner-client-certification-status-update', 'account-update-volume-based-pricing-tier-update',
    ]) {
        it(`${name}: on record and nothing else: no write, no alert`, async () => {
            const outcomes = await handle(receiveSample(name));
            assert.deepEqual(outcomes, [{ kind: 'informational' }]);
            assert.deepEqual([telegram.length, touchedConnections(), conn().status], [0, 0, 'active']);
            assert.equal(logged('wa.account_event').length, 1);
        });
    }

    it('covers every account_update sample in the folder (a new one must be a decision, not an accident)', async () => {
        const { readdirSync } = await import('node:fs');
        const samples = readdirSync(FIXTURES).filter((f) => f.startsWith('account-update-')).map((f) => f.replace(/\.json$/, ''));
        assert.equal(samples.length, 17);
        for (const name of samples) {
            const plan = planAccountEvent('account_update', sample(name).entry[0].changes[0].value, sample(name).entry[0].time);
            assert.notEqual(plan.kind, 'unhandled', `${name} must be either handled or deliberately informational`);
        }
    });

    it('an event this build does not know is logged by name and completes: no write, no alert, no throw', async () => {
        const outcomes = await handle(receiveSample('account-update-account-deleted', (body) => { body.entry[0].changes[0].value.event = 'ACCOUNT_SOMETHING_NEW'; }));
        assert.deepEqual(outcomes, [{ kind: 'unhandled' }]);
        const entry = logged('wa.account_event_unhandled');
        assert.deepEqual([entry.length, entry[0]!.reason, entry[0]!.meta_event], [1, 'unknown_event', 'ACCOUNT_SOMETHING_NEW']);
        assert.deepEqual([touchedConnections(), telegram.length], [0, 0]);
    });

    it('an unknown field and a payload missing what its event needs are the same: unhandled, completed', async () => {
        assert.deepEqual(await handleAccountEvent({ kind: 'account', entryId: '1', field: 'account_review_update', value: { decision: 'APPROVED' }, time: 1 }), { kind: 'unhandled' });
        assert.deepEqual(await handleAccountEvent({ kind: 'account', entryId: '1', field: 'account_update', value: {}, time: 1 }), { kind: 'unhandled' });
        assert.deepEqual(await handleAccountEvent({ kind: 'account', entryId: '1', field: 'account_update', value: null, time: 1 }), { kind: 'unhandled' });
        assert.deepEqual(await handleAccountEvent({ kind: 'account', entryId: '1', field: 'account_update', value: { event: 'ACCOUNT_RESTRICTION', restriction_info: [] }, time: 1 }), { kind: 'unhandled' });
        assert.equal(logged('wa.account_event_unhandled').length, 4);
        assert.deepEqual([touchedConnections(), telegram.length], [0, 0]);
    });
});

describe('account_alerts', () => {
    it('an ACTIVE alert is told with Meta’s severity, type and words, and its state is stored', async () => {
        await handle(receiveSample('account-alerts'));
        assert.equal(telegram.length, 1);
        const text = texts()[0]!;
        assert.match(text, /WARNING/);
        assert.match(text, /INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED/);
        assert.match(text, /Limits cannot be increased/);
        assert.equal(profile().alerts['alert:INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED'], 'ACTIVE:WARNING');
        assert.equal(conn().status, 'active');
    });

    it('a RESOLVED alert is recorded and not announced, and its return alerts again', async () => {
        await handle(receiveSample('account-alerts'));
        await handle(receiveSample('account-alerts', (b) => { b.entry[0].time += 10; b.entry[0].changes[0].value.alert_info.alert_status = 'RESOLVED'; }));
        assert.equal(telegram.length, 1, 'the resolution is quiet');
        await handle(receiveSample('account-alerts', (b) => { b.entry[0].time += 20; }));
        assert.equal(telegram.length, 2, 'ACTIVE again is news');
    });
});

describe('phone_number_name_update', () => {
    it('APPROVED (the sample): name_status and the verified name are updated, and the owner is told', async () => {
        conn().display_name = 'Old Name';
        profile().name_status = 'PENDING_REVIEW';
        await handle(receiveSample('phone-number-name-update'));
        assert.deepEqual([profile().name_status, conn().display_name], ['APPROVED', 'Lucky Shrub']);
        assert.match(texts()[0]!, /Business name approved: Lucky Shrub/);
    });

    it('DECLINED (synthetic: the sample with that decision and a reason): the name is kept, the reason is shown', async () => {
        await handle(receiveSample('phone-number-name-update', (b) => {
            const v = b.entry[0].changes[0].value;
            v.decision = 'DECLINED';
            v.rejection_reason = 'NAME_NOT_MATCHING_WEBSITE';
        }));
        assert.deepEqual([profile().name_status, conn().display_name], ['DECLINED', 'Lucky Shrub'], 'unchanged display_name: the declined name is not the verified one');
        assert.match(texts()[0]!, /declined: Lucky Shrub/);
        assert.match(texts()[0]!, /NAME_NOT_MATCHING_WEBSITE/);
    });
});

describe('phone_number_quality_update', () => {
    it('THROUGHPUT_UPGRADE with TIER_UNLIMITED (the sample): the limit and throughput are stored, the limit is told, a health read is asked for', async () => {
        const outcomes = await handle(receiveSample('phone-number-quality-update'));
        assert.deepEqual([profile().messaging_limit, profile().throughput], ['TIER_UNLIMITED', 'HIGH']);
        assert.equal(telegram.length, 1, 'the throughput upgrade is quiet, the limit is not');
        assert.match(texts()[0]!, /TIER_250 to TIER_UNLIMITED/);
        assert.deepEqual(outcomes[0], { kind: 'applied', connections: 1, applied: 2, duplicates: 0, alerted: 1, readHealthFor: [conn().creator_id] });
    });

    it('FLAGGED (the sample with that event): the number is FLAGGED and the owner is told; a limit that did not move is not announced', async () => {
        await handle(receiveSample('phone-number-quality-update', (b) => { const v = b.entry[0].changes[0].value; v.event = 'FLAGGED'; v.current_limit = 'TIER_250'; }));
        assert.equal(profile().number_status, 'FLAGGED');
        assert.equal(telegram.length, 1);
        assert.match(texts()[0]!, /FLAGGED \(was CONNECTED\)/);
    });

    it('UNFLAGGED brings it back to CONNECTED and says so', async () => {
        profile().number_status = 'FLAGGED';
        await handle(receiveSample('phone-number-quality-update', (b) => { const v = b.entry[0].changes[0].value; v.event = 'UNFLAGGED'; v.current_limit = 'TIER_250'; }));
        assert.equal(profile().number_status, 'CONNECTED');
        assert.match(texts()[0]!, /CONNECTED \(was FLAGGED\)/);
    });

    it('an event that is neither a limit nor a known state is unhandled, not guessed', async () => {
        const outcomes = await handle(receiveSample('phone-number-quality-update', (b) => { const v = b.entry[0].changes[0].value; delete v.current_limit; v.event = 'SOMETHING_NEW'; }));
        assert.deepEqual(outcomes, [{ kind: 'unhandled' }]);
        assert.equal(touchedConnections(), 0);
    });

    it('is applied to the number it names: two numbers on one account, one event', async () => {
        db.connections.push(fakeConnection({
            id: 'conn-2', creator_id: '22222222-2222-4222-8222-222222222222', external_account_id: '777', display_name: 'Other',
            profile: { ...fakeConnection().profile, display_phone_number: '+1 555-000-1111', messaging_limit: 'TIER_250' },
        }));
        await handle(receiveSample('phone-number-quality-update'));
        assert.equal(profile(0).messaging_limit, 'TIER_UNLIMITED');
        assert.equal(profile(1).messaging_limit, 'TIER_250', 'the other number is not this event’s');
    });
});

describe('business_capability_update', () => {
    it('stores the portfolio’s daily limit and number cap and tells the owner', async () => {
        await handle(receiveSample('business-capability-update'));
        assert.deepEqual(profile().business_capability, { max_daily_conversations: 2000, max_phone_numbers: 25, at: new Date(1739321024 * 1000).toISOString() });
        assert.match(texts()[0]!, /Daily business-initiated limit: 2,000/);
        assert.match(texts()[0]!, /Max phone numbers: 25/);
    });

    it('a second event with a new value says what it was', async () => {
        await handle(receiveSample('business-capability-update'));
        await handle(receiveSample('business-capability-update', (b) => { b.entry[0].time += 1; b.entry[0].changes[0].value.max_daily_conversations_per_business = 10000; }));
        assert.match(texts()[1]!, /10,000 \(was 2,000\)/);
    });
});

// ─── Once ───────────────────────────────────────────────────────────────────────────────

describe('once per distinct change', () => {
    it('the same event delivered twice is one alert, one write, and the second says it was a duplicate', async () => {
        const payloads = receiveSample('account-update-account-violation');
        const first = await handleAccountEvent(payloads[0]!);
        const second = await handleAccountEvent(payloads[0]!);
        assert.equal(telegram.length, 1);
        assert.equal(db.cas.written, 1);
        assert.deepEqual([(first as any).applied, (first as any).duplicates, (second as any).applied, (second as any).duplicates], [1, 0, 0, 1]);
    });

    it('also when the repeat is a different job (Meta redelivers): one alert for every state-like event', async () => {
        for (const name of ['account-update-account-deleted', 'account-update-account-restriction', 'account-alerts', 'phone-number-name-update', 'business-capability-update', 'phone-number-quality-update']) {
            db.connections[0] = fakeConnection({ display_name: 'Old Name' });
            telegram.length = 0;
            for (let i = 0; i < 3; i++) await handle(receiveSample(name));
            assert.equal(telegram.length, 1, name);
        }
    });

    it('GREEN -> YELLOW -> GREEN -> YELLOW is four alerts, not two: each differs from the one before, however soon (review M13)', async () => {
        const tier = (limit: string, time: number) => receiveSample('phone-number-quality-update', (b) => {
            b.entry[0].time = time;
            const v = b.entry[0].changes[0].value;
            v.event = 'UPGRADE';
            v.current_limit = limit;
        });
        for (const [limit, time] of [['TIER_1K', 100], ['TIER_250', 101], ['TIER_1K', 102], ['TIER_250', 103]] as const) await handle(tier(limit, time));
        assert.deepEqual(texts().map((t) => /(TIER_\w+) to (TIER_\w+)/.exec(t)!.slice(1)), [['TIER_250', 'TIER_1K'], ['TIER_1K', 'TIER_250'], ['TIER_250', 'TIER_1K'], ['TIER_1K', 'TIER_250']]);
        // ...and a repeat of the last one is quiet again.
        await handle(tier('TIER_250', 104));
        assert.equal(telegram.length, 4);
    });

    it('a second violation of the same type is a second alert, because its time differs; the same event again is not', async () => {
        const violation = (time: number) => receiveSample('account-update-account-violation', (b) => { b.entry[0].time = time; });
        await handle(violation(1000));
        await handle(violation(1000));
        await handle(violation(2000));
        assert.equal(telegram.length, 2);
    });

    it('disconnect, reconnect, disconnect is three alerts; a repeated disconnect in a row is one', async () => {
        for (const name of ['account-update-account-offboarded', 'account-update-account-offboarded', 'account-update-account-reconnected', 'account-update-account-offboarded']) await handle(receiveSample(name));
        assert.equal(telegram.length, 3);
        assert.equal(conn().status, 'invalid');
    });

    it('a connection with no stored alert and a profile that already shows the value is not told (the first event does not announce what the owner sees)', async () => {
        await handle(receiveSample('phone-number-quality-update', (b) => { b.entry[0].changes[0].value.current_limit = 'TIER_250'; b.entry[0].changes[0].value.event = 'UPGRADE'; }));
        assert.equal(telegram.length, 0);
        assert.equal(touchedConnections(), 0, 'and nothing was written');
    });
});

describe('the compare-and-set', () => {
    it('a writer that wins the race makes this one re-decide: the other already stored the same change, so there is no second alert', async () => {
        const payloads = receiveSample('account-update-account-violation');
        let raced = false;
        db.beforeUpdate = () => {
            if (raced) return;
            raced = true;
            // The other writer stores the same violation (and would have alerted) between our read and our write.
            profile().alerts = { violation: 'ADULT@1743451903' };
            profile().violation = { type: 'ADULT', at: 'x' };
        };
        const outcome = await handleAccountEvent(payloads[0]!);
        assert.equal(db.cas.lost, 1);
        assert.deepEqual([(outcome as any).applied, (outcome as any).duplicates], [0, 1]);
        assert.equal(telegram.length, 0, 'the winner alerts, not us');
    });

    it('a writer that changes something else makes this one retry against the new profile and still apply (nothing of theirs is overwritten)', async () => {
        const payloads = receiveSample('account-update-account-violation');
        let raced = false;
        db.beforeUpdate = () => {
            if (raced) return;
            raced = true;
            profile().quality_rating = 'YELLOW';
        };
        await handleAccountEvent(payloads[0]!);
        assert.equal(db.cas.lost, 1);
        assert.deepEqual([profile().quality_rating, profile().violation.type, telegram.length], ['YELLOW', 'ADULT', 1]);
    });

    it('throws after three lost races, so the job is retried and nothing is half-applied', async () => {
        const payloads = receiveSample('account-update-account-violation');
        db.beforeUpdate = () => { profile().quality_rating = String(Math.random()); };
        await assert.rejects(() => handleAccountEvent(payloads[0]!), /kept changing/);
        assert.equal(telegram.length, 0);
        assert.equal(profile().violation, undefined);
    });
});

describe('the alert', () => {
    it('a failed send gives the claim back and fails the job; the retry sends it once', async () => {
        const payloads = receiveSample('account-update-account-violation');
        telegramAnswer = 'reject';
        await assert.rejects(() => handleAccountEvent(payloads[0]!), /was not delivered \(failed\)/);
        assert.equal(profile().alerts.violation, undefined, 'the claim was released');
        assert.equal(profile().violation.type, 'ADULT', 'the state is kept: it is true whether or not the owner heard');

        telegramAnswer = 'ok';
        await handleAccountEvent(payloads[0]!);
        await handleAccountEvent(payloads[0]!);
        assert.equal(telegram.length, 2, 'one failed attempt and one that went out; the third call is a duplicate');
        assert.equal(profile().alerts.violation, 'ADULT@1743451903');
    });

    it('a state change that was told keeps the value the owner last heard: a failed send restores THAT, so tomorrow’s read still sees the difference', async () => {
        profile().alerts = { limit: 'TIER_250' };
        telegramAnswer = 'unreachable';
        await assert.rejects(() => handle(receiveSample('phone-number-quality-update')));
        assert.equal(profile().alerts.limit, 'TIER_250');
    });

    it('with alerts switched off the state is stored, nothing is sent, and the job completes', async () => {
        settings['notify.telegram_enabled'] = 'false';
        await handle(receiveSample('account-update-account-deleted'));
        assert.deepEqual([conn().status, telegram.length], ['invalid', 0]);
        assert.equal(logged('wa.alert_not_sent').length, 1);
    });

    it('an account event for a number nobody has connected completes with a warning, writes nothing and asks Meta nothing', async () => {
        db.connections.length = 0;
        const outcomes = await handle(receiveSample('account-update-account-deleted'));
        assert.deepEqual(outcomes, [{ kind: 'no_connection' }]);
        assert.equal(logged('wa.account_event_no_connection').length, 1);
        assert.equal(touchedConnections(), 0);
    });

    it('never touches a connection the owner disconnected', async () => {
        conn().status = 'revoked';
        const outcomes = await handle(receiveSample('account-update-account-deleted'));
        assert.deepEqual(outcomes, [{ kind: 'no_connection' }]);
        assert.equal(conn().status, 'revoked');
    });

    it('names WhatsApp and the number in both languages and carries nothing from a conversation; Meta’s words lose their links', () => {
        const text = buildWhatsAppAlertText(
            { kind: 'account_alert', severity: 'WARNING', type: 'X', description: 'Read https://evil.example/x and www.evil.example now' },
            { number: '+1 555-078-3881', name: 'Lucky Shrub', phoneNumberId: '106540352242922' }
        );
        assert.match(text, /^واتساب: /);
        assert.match(text, /\nWhatsApp: /);
        assert.match(text, /الرقم: \+1 555-078-3881 \(Lucky Shrub\)/);
        assert.match(text, /Number: \+1 555-078-3881 \(Lucky Shrub\)/);
        assert.ok(!/evil/.test(text), 'a link in Meta’s text is replaced');
        assert.match(text, /\[link\]/);
        const noNumber = buildWhatsAppAlertText({ kind: 'reconnected' }, { number: null, name: null, phoneNumberId: '106540352242922' });
        assert.match(noNumber, /ID 106540352242922/);
    });

    it('is plain text with no parse mode and goes to the owner’s chat', async () => {
        await handle(receiveSample('account-update-account-violation'));
        assert.equal(telegram[0]!.body.chat_id, CHAT);
        assert.ok(!('parse_mode' in telegram[0]!.body));
        assert.match(telegram[0]!.url, /\/sendMessage$/);
    });
});

// ─── The free replies ───────────────────────────────────────────────────────────────────

describe('the free-reply alert', () => {
    const check = (at = new Date('2026-10-19T10:00:00Z')) => checkFreeTierAlert({ creatorId: conn().creator_id, phoneNumberId: conn().external_account_id, at });

    it('is quiet below the owner’s threshold and sends nothing', async () => {
        usage.service = 899;
        assert.equal(await check(), 'below');
        assert.equal(telegram.length, 0);
        assert.equal(profile().free_tier_alerted_period, undefined);
    });

    it('fires when the count reaches 900, says 900 / 1,000, and stores the period', async () => {
        usage.service = 900;
        assert.equal(await check(), 'alerted');
        assert.equal(telegram.length, 1);
        assert.match(texts()[0]!, /900 \/ 1,000/);
        assert.match(texts()[0]!, /واتساب/);
        assert.equal(profile().free_tier_alerted_period, '2026-10');
    });

    it('never double-alerts in the same period, and does not even count again once it has told', async () => {
        usage.service = 900;
        await check();
        usage.queries = 0;
        usage.service = 951;
        assert.equal(await check(), 'already');
        assert.equal(await check(), 'already');
        assert.equal(telegram.length, 1);
        assert.equal(usage.queries, 0, 'the stored period answers before the ledger is read');
    });

    it('alerts again in the next period', async () => {
        usage.service = 900;
        await check();
        usage.service = 920;
        assert.equal(await check(new Date('2026-11-02T10:00:00Z')), 'alerted');
        assert.equal(telegram.length, 2);
        assert.equal(profile().free_tier_alerted_period, '2026-11');
    });

    it('uses the owner’s own threshold', async () => {
        conn().settings = { allow_billable: false, free_tier_alert_at: 500 };
        usage.service = 499;
        assert.equal(await check(), 'below');
        usage.service = 500;
        assert.equal(await check(), 'alerted');
        assert.match(texts()[0]!, /500 \/ 1,000/);
    });

    it('says what happens next: replies stop without a billing choice, are charged with one', async () => {
        usage.service = 1000;
        await check();
        assert.match(texts()[0]!, /used up/);
        assert.match(texts()[0]!, /replies stop until next month/);

        conn().settings = { allow_billable: true, free_tier_alert_at: 900 };
        delete profile().free_tier_alerted_period;
        await check();
        assert.match(texts()[1]!, /billable and are charged/);
    });

    it('a send that fails gives the period back, so the next delivery tries again', async () => {
        usage.service = 900;
        telegramAnswer = 'unreachable';
        assert.equal(await check(), 'alertFailed');
        assert.equal(profile().free_tier_alerted_period, undefined);
        telegramAnswer = 'ok';
        assert.equal(await check(), 'alerted');
        assert.equal(telegram.length, 2);
    });

    it('with alerts off it stores the period and sends nothing', async () => {
        settings['notify.telegram_enabled'] = 'false';
        usage.service = 900;
        assert.equal(await check(), 'off');
        assert.equal(profile().free_tier_alerted_period, '2026-10');
    });

    it('is a no-op for a number with no connection, and never throws when the database does', async () => {
        assert.equal(await checkFreeTierAlert({ creatorId: conn().creator_id, phoneNumberId: 'nope' }), 'no_connection');
        (pool as unknown as { query: unknown }).query = async () => { throw new Error('connection reset'); };
        assert.equal(await check(), 'alertFailed');
        assert.equal(logged('wa.free_tier_check_failed').length, 1);
    });
});
