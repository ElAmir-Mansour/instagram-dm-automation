/**
 * The daily recheck of every connected tenant's Meta token (P29).
 *
 * What is pinned, because each is a way the sweep hurts somebody:
 *
 *   - **The owner's token is valid.** His PAGE token never expires (`expires_at: 0`); reading that `0` as "expired in 1970" would
 *     flag the one tenant that is live. The shape is tested as Meta sends it, and the sweep is run over it end to end.
 *   - **A transient failure is never written down.** A timeout, a 5xx, a rate limit, a refused app token, a body that is not an
 *     answer, "not valid" because Meta could not look: none of them says anything about the TOKEN, and each leaves every row exactly
 *     as it was (the whole creators table is compared, not just the status). "Reconnect due" is derived from what is stored, so
 *     a Meta outage cannot raise it. The owner is checked against every one of these.
 *   - **A definitive answer is.** Revoked, the wrong type, data access lapsed: `invalid`. Valid with less than 14 days of data
 *     access: stored valid, and due. A later valid answer heals both (the person reconnected).
 *   - **Nothing but health is written**, never the Page ids, the token or the `meta_*` columns; no token reaches a log line.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { encryptSecret } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import { FakeDb, FakeGraph, graphError, type FakeCreator } from './metaLoginHarness.js';
import { getMetaConnection, RECONNECT_DUE_DAYS } from './metaLogin.js';
import { classifyCheckFailure, classifyDebugToken, recheckAllMetaTokens, recheckOneMetaToken } from './metaTokenRecheck.js';

const OWNER = '99999999-9999-4999-8999-999999999999';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_C = '33333333-3333-4333-8333-333333333333';
const NEWBIE = '44444444-4444-4444-8444-444444444444';
const OWNER_TOKEN = 'EAAOwnerPageTokenNeverExpires0123456789abcdefghijk';
const TOKEN_A = 'EAATenantAPageToken0123456789abcdefghijklmnopqr';
const TOKEN_B = 'EAATenantBPageToken0123456789abcdefghijklmnopqr';
const TOKEN_C = 'EAATenantCPageToken0123456789abcdefghijklmnopqr';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const seconds = (ms: number): number => Math.floor(ms / 1000);

/** The body of a `debug_token` answer for a PAGE token, as Meta sends it: `expires_at: 0` is "never expires". */
const body = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    app_id: '111222333444555', type: 'PAGE', application: 'AutoReply', is_valid: true, expires_at: 0,
    data_access_expires_at: seconds(NOW + 80 * DAY), scopes: ['instagram_basic', 'pages_show_list'], ...over,
});

// ─── classifyDebugToken ─────────────────────────────────────────────────────────────────

describe('classifyDebugToken: what Meta definitively said', () => {
    it('reads the owner\'s never-expiring PAGE token (expires_at: 0) as valid', () => {
        const v = classifyDebugToken(body(), NOW);
        assert.equal(v.kind, 'valid');
        assert.equal(v.reason, null);
        assert.equal(v.inspection?.expiresAt, null, '0 is "never expires", not the epoch');
        assert.equal(v.expiring, null);
    });

    it('reads a PAGE token that says nothing about its dates as valid: no date is no deadline', () => {
        assert.equal(classifyDebugToken(body({ expires_at: undefined, data_access_expires_at: undefined }), NOW).kind, 'valid');
        assert.equal(classifyDebugToken(body({ data_access_expires_at: 0 }), NOW).kind, 'valid');
    });

    it('keeps a token with missing scopes valid: it works, some features do not', () => {
        const v = classifyDebugToken(body({ scopes: ['pages_show_list'] }), NOW);
        assert.equal(v.kind, 'valid');
        assert.match(v.inspection?.error ?? '', /Missing \d+ required scope/);
    });

    it(`is expiring when data access ends within ${RECONNECT_DUE_DAYS} days, and names how many`, () => {
        const v = classifyDebugToken(body({ data_access_expires_at: seconds(NOW + 9.5 * DAY) }), NOW);
        assert.equal(v.kind, 'expiring');
        assert.deepEqual(v.expiring, { by: 'data_access', days: 10 });
        assert.equal(v.inspection?.isValid, true);
    });

    it('draws the line exactly at the window: just inside is expiring, just outside is valid', () => {
        assert.equal(classifyDebugToken(body({ data_access_expires_at: seconds(NOW + RECONNECT_DUE_DAYS * DAY - 60_000) }), NOW).kind, 'expiring');
        assert.equal(classifyDebugToken(body({ data_access_expires_at: seconds(NOW + RECONNECT_DUE_DAYS * DAY + 60_000) }), NOW).kind, 'valid');
    });

    it('is expiring when a real expires_at is near, and reports the earlier of the two dates', () => {
        const token = classifyDebugToken(body({ expires_at: seconds(NOW + 3 * DAY) }), NOW);
        assert.equal(token.kind, 'expiring');
        assert.deepEqual(token.expiring, { by: 'token', days: 3 });
        const both = classifyDebugToken(body({ expires_at: seconds(NOW + 3 * DAY), data_access_expires_at: seconds(NOW + 6 * DAY) }), NOW);
        assert.deepEqual(both.expiring, { by: 'token', days: 3 });
    });

    it('is invalid when Meta says the token is not valid, with Meta\'s own reason', () => {
        const v = classifyDebugToken(body({ is_valid: false, error: { code: 190, subcode: 460, message: 'The session is invalid because the user changed their password.' } }), NOW);
        assert.equal(v.kind, 'invalid');
        assert.match(v.reason ?? '', /not valid: The session is invalid/);
        assert.equal(v.inspection?.isValid, false);
    });

    it('is invalid for a "not valid" with no error object, or an unknown code: that is Meta saying no', () => {
        assert.equal(classifyDebugToken({ is_valid: false }, NOW).kind, 'invalid');
        assert.equal(classifyDebugToken({ is_valid: false, error: { code: 190 } }, NOW).kind, 'invalid');
        assert.equal(classifyDebugToken({ is_valid: false, error: { code: 100, message: 'bad' } }, NOW).kind, 'invalid');
    });

    it('is invalid for a token of the wrong type even though Meta calls it valid: a USER token cannot publish or reply', () => {
        const v = classifyDebugToken(body({ type: 'USER' }), NOW);
        assert.equal(v.kind, 'invalid');
        assert.match(v.reason ?? '', /Wrong token type: "USER"/);
    });

    it('is invalid when data access has already lapsed, though the token still reports valid: every read fails', () => {
        const v = classifyDebugToken(body({ data_access_expires_at: seconds(NOW - DAY) }), NOW);
        assert.equal(v.kind, 'invalid');
        assert.match(v.reason ?? '', /Data access has expired/);
    });
});

describe('classifyDebugToken: what is not an answer is never a verdict', () => {
    for (const [name, data] of [
        ['nothing at all', undefined],
        ['null', null],
        ['a string (an error page)', '<html>502 Bad Gateway</html>'],
        ['a number', 5],
        ['a list', []],
        ['an empty object', {}],
        ['an object with no is_valid', { type: 'PAGE', expires_at: 0 }],
        ['an is_valid that is text', { is_valid: 'false' }],
        ['an is_valid that is a number', { is_valid: 0 }],
    ] as Array<[string, unknown]>) {
        it(`is transient for ${name}, and carries nothing to store`, () => {
            const v = classifyDebugToken(data, NOW);
            assert.equal(v.kind, 'transient');
            assert.equal(v.inspection, null);
        });
    }

    for (const code of [1, 2, 4, 17, 32, 341, 368, 613]) {
        it(`is transient when Meta calls the token "not valid" only because it could not look (code ${code})`, () => {
            const v = classifyDebugToken({ is_valid: false, error: { code, message: 'Please retry your request later.' } }, NOW);
            assert.equal(v.kind, 'transient');
            assert.equal(v.inspection, null);
        });
    }
});

describe('classifyCheckFailure: a call that did not answer says nothing about the token', () => {
    for (const [name, err] of [
        ['a 5xx from Meta', graphError(503, { message: 'Service Unavailable', code: 2 })],
        ['a rate limit', graphError(429, { message: 'Too many calls', code: 4 })],
        ['a code 190 on the CALL: the app\'s own credentials, not the tenant\'s token', graphError(400, { message: 'Invalid OAuth access token - Cannot parse access token', code: 190 })],
        ['a code 190 with a token-death subcode on the call', graphError(400, { message: 'The session has been invalidated', code: 190, error_subcode: 460 })],
        ['a timeout', Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' })],
        ['no network at all', Object.assign(new Error('getaddrinfo ENOTFOUND graph.facebook.com'), { code: 'ENOTFOUND' })],
        ['something that is not an error', 'boom'],
        ['nothing', undefined],
    ] as Array<[string, unknown]>) {
        it(`is transient for ${name}`, () => {
            const v = classifyCheckFailure(err);
            assert.equal(v.kind, 'transient');
            assert.equal(v.inspection, null);
        });
    }
});

// ─── The sweep ──────────────────────────────────────────────────────────────────────────

let db: FakeDb;
let graph: FakeGraph;
let logs: string[];
let restoreSink: () => void;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.META_APP_ID = '111222333444555';
    process.env.META_APP_SECRET = 'the-app-secret-0123456789-never-in-a-log';
    db = new FakeDb().install();
    graph = new FakeGraph().install();
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    restoreSink();
    graph.restore();
    db.restore();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** The owner: connected by a pasted token, a never-expiring PAGE token, none of the v35 columns. */
function owner(over: Partial<FakeCreator> = {}): FakeCreator {
    return db.addCreator(OWNER, {
        name: 'owner', instagram_page_id: '17841499999999991', facebook_page_id: '100000000000001',
        page_access_token: encryptSecret(OWNER_TOKEN), token_status: 'valid', token_last_checked_at: new Date(NOW - 3 * DAY), ...over,
    });
}

/** A tenant that connected with Facebook Login: v35 columns set, a Page token of its own. */
function tenant(id: string, token: string, n: number, over: Partial<FakeCreator> = {}): FakeCreator {
    return db.addCreator(id, {
        name: `tenant ${n}`, instagram_page_id: `1784140000000000${n}`, facebook_page_id: `20000000000000${n}`,
        page_access_token: encryptSecret(token), token_status: 'valid', token_last_checked_at: new Date(NOW - 2 * DAY),
        meta_user_id: '90001', meta_page_name: `Page ${n}`, instagram_username: `page${n}`,
        meta_connected_at: new Date(NOW - 20 * DAY), meta_webhook_subscribed_at: new Date(NOW - 20 * DAY), ...over,
    });
}

const HEALTH = ['token_status', 'token_error', 'token_expires_at', 'token_data_access_expires_at', 'token_last_checked_at'] as const;
/** Everything on the row EXCEPT the five health columns. */
const connection = (row: FakeCreator): string => JSON.stringify(Object.fromEntries(Object.entries(row).filter(([k]) => !(HEALTH as readonly string[]).includes(k))));
const updates = (): string[] => db.statements.filter((s) => /^UPDATE creators/.test(s.sql)).map((s) => s.sql);

describe('the sweep: the owner', () => {
    it('reads his never-expiring PAGE token as valid, end to end, and writes only health', async () => {
        const row = owner();
        const before = connection(row);
        const result = await recheckAllMetaTokens({ now: () => NOW });
        assert.deepEqual(result, { checked: 1, valid: 1, expiring: 0, invalid: 0, transient: 0, skipped: 0, moreRemaining: false });
        assert.equal(row.token_status, 'valid');
        assert.equal(row.token_error, null);
        assert.equal(row.token_expires_at, null, 'expires_at 0 is stored as "never", not as 1970');
        assert.ok(row.token_data_access_expires_at, 'the data-access date is kept fresh');
        assert.ok(row.token_last_checked_at!.getTime() > NOW - DAY, 'and the check is stamped');
        assert.equal(connection(row), before, 'the Page ids, the token and every other column are exactly as they were');
        const summary = await getMetaConnection(OWNER);
        assert.equal(summary?.connected, true);
        assert.equal(summary?.reconnectDue, false);
        assert.equal(summary?.reconnectReason, null);
    });

    /** Each way Meta can fail to answer, set up for every token in the sweep (the owner's and the tenant's: both meet the same bad minute). */
    const TRANSIENT: Array<[string, (tokens: string[]) => void]> = [
        ['a Meta outage (503)', () => { graph.fail(/GET \/debug_token/, 503, { message: 'Service Unavailable', code: 2 }, 99); }],
        ['a rate limit (429)', () => { graph.fail(/GET \/debug_token/, 429, { message: 'Too many calls', code: 4 }, 99); }],
        ['a refused app token: code 190 on the call itself', () => { graph.fail(/GET \/debug_token/, 400, { message: 'Invalid OAuth access token - Cannot parse access token', code: 190 }, 99); }],
        ['a timeout', () => { graph.onDebugToken = () => { throw Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }); }; }],
        ['no network', () => { graph.onDebugToken = () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND graph.facebook.com'), { code: 'ENOTFOUND' }); }; }],
        ['a 200 whose body is empty', (tokens) => { tokens.forEach((t) => graph.rawDebugBodies.set(t, undefined)); }],
        ['a 200 whose body is a page of HTML', (tokens) => { tokens.forEach((t) => graph.rawDebugBodies.set(t, '<html>Bad gateway</html>')); }],
        ['a 200 with a body that is not an inspection', (tokens) => { tokens.forEach((t) => graph.rawDebugBodies.set(t, { is_valid: 'unknown' })); }],
        ['"not valid" because Meta could not look (code 2)', (tokens) => {
            tokens.forEach((t) => graph.inspections.set(t, { is_valid: false, error: { code: 2, message: 'Service temporarily unavailable' } }));
        }],
    ];
    for (const [name, arrange] of TRANSIENT) {
        it(`is never marked on ${name}: the whole table is exactly as it was, and no write was even attempted`, async () => {
            owner();
            tenant(TENANT_A, TOKEN_A, 1);
            arrange([OWNER_TOKEN, TOKEN_A]);
            const before = db.snapshotCreators();
            const result = await recheckAllMetaTokens({ now: () => NOW });
            assert.equal(result.transient, 2, 'both tenants met the same bad minute');
            assert.equal(result.valid + result.expiring + result.invalid, 0);
            assert.equal(db.snapshotCreators(), before, 'nothing on any row changed: not the status, not the last-checked stamp');
            assert.deepEqual(updates(), [], 'and no UPDATE of creators was issued');
            for (const id of [OWNER, TENANT_A]) {
                const summary = await getMetaConnection(id);
                assert.equal(summary?.reconnectDue, false, 'a Meta outage never raises "reconnect due"');
                assert.equal(summary?.tokenStatus, 'valid');
            }
        });
    }

    it('heals nothing and breaks nothing when Meta is down for one tenant and fine for the next', async () => {
        owner();
        tenant(TENANT_A, TOKEN_A, 1);
        graph.fail(/GET \/debug_token/, 503, { message: 'Service Unavailable', code: 2 }, 1);
        const result = await recheckAllMetaTokens({ now: () => NOW });
        assert.equal(result.transient, 1);
        assert.equal(result.valid, 1, 'the sweep went on to the next tenant');
    });
});

describe('the sweep: a definitive answer is written', () => {
    it('marks a revoked token invalid, with Meta\'s reason, and raises "reconnect due"; the connection itself is kept', async () => {
        const row = tenant(TENANT_A, TOKEN_A, 1);
        const before = connection(row);
        graph.inspections.set(TOKEN_A, { is_valid: false, error: { code: 190, subcode: 460, message: 'The session is invalid because the user changed their password.' } });
        const result = await recheckAllMetaTokens({ now: () => NOW });
        assert.equal(result.invalid, 1);
        assert.equal(row.token_status, 'invalid');
        assert.match(row.token_error ?? '', /changed their password/);
        assert.equal(connection(row), before, 'ids and the stored token stay: the tenant reconnects over them');
        const summary = await getMetaConnection(TENANT_A);
        assert.equal(summary?.reconnectDue, true);
        assert.equal(summary?.reconnectReason, 'invalid');
        assert.equal(summary?.connected, true);
    });

    it('stores an expiring token as valid, and raises "reconnect due" from its date', async () => {
        const row = tenant(TENANT_A, TOKEN_A, 1);
        graph.inspections.set(TOKEN_A, { data_access_expires_at: seconds(Date.now() + 6 * DAY) });
        const result = await recheckAllMetaTokens({ now: () => Date.now() });
        assert.equal(result.expiring, 1);
        assert.equal(row.token_status, 'valid', 'it works today');
        assert.ok(row.token_data_access_expires_at && row.token_data_access_expires_at.getTime() < Date.now() + 7 * DAY);
        const summary = await getMetaConnection(TENANT_A);
        assert.equal(summary?.reconnectDue, true);
        assert.equal(summary?.reconnectReason, 'expiring');
    });

    it('marks a token of the wrong type invalid, and one whose data access lapsed', async () => {
        const a = tenant(TENANT_A, TOKEN_A, 1);
        const b = tenant(TENANT_B, TOKEN_B, 2);
        graph.inspections.set(TOKEN_A, { type: 'USER' });
        graph.inspections.set(TOKEN_B, { data_access_expires_at: seconds(Date.now() - DAY) });
        const result = await recheckAllMetaTokens({ now: () => Date.now() });
        assert.equal(result.invalid, 2);
        assert.equal(a.token_status, 'invalid');
        assert.equal(b.token_status, 'invalid');
    });

    it('lets a later valid answer heal an invalid status: the person reconnected', async () => {
        const row = tenant(TENANT_A, TOKEN_A, 1, { token_status: 'invalid', token_error: 'Meta reports the token as not valid.' });
        assert.equal((await getMetaConnection(TENANT_A))?.reconnectDue, true);
        await recheckAllMetaTokens({ now: () => Date.now() });
        assert.equal(row.token_status, 'valid');
        assert.equal(row.token_error, null);
        assert.equal((await getMetaConnection(TENANT_A))?.reconnectDue, false);
    });

    it('never asks about a tenant with no token, and writes nothing for it', async () => {
        db.addCreator(NEWBIE, { name: 'just created' });
        owner();
        const before = JSON.stringify(db.creators.get(NEWBIE));
        const result = await recheckAllMetaTokens({ now: () => NOW });
        assert.equal(result.checked, 1);
        assert.equal(graph.called(/debug_token/).length, 1, 'one call, for the one token');
        assert.equal(JSON.stringify(db.creators.get(NEWBIE)), before);
    });

    it('skips a token that cannot be read (a rotated key) without writing or asking Meta', async () => {
        const row = tenant(TENANT_A, TOKEN_A, 1, { page_access_token: 'enc:v1:not-a-real-ciphertext' });
        const before = JSON.stringify(row);
        const result = await recheckAllMetaTokens({ now: () => NOW });
        assert.deepEqual([result.skipped, result.checked], [1, 0]);
        assert.equal(JSON.stringify(row), before);
        assert.equal(graph.called(/debug_token/).length, 0);
    });

    it('answers for one tenant on its own', async () => {
        tenant(TENANT_A, TOKEN_A, 1);
        graph.inspections.set(TOKEN_A, { is_valid: false });
        assert.equal(await recheckOneMetaToken(TENANT_A, NOW), 'invalid');
        assert.equal(await recheckOneMetaToken(NEWBIE, NOW), 'skipped');
    });
});

describe('the sweep: order, limits and secrets', () => {
    it('asks the longest-unchecked first, so a tenant whose last try was transient is first in line', async () => {
        tenant(TENANT_A, TOKEN_A, 1, { token_last_checked_at: new Date(NOW - 1 * DAY) });
        tenant(TENANT_B, TOKEN_B, 2, { token_last_checked_at: new Date(NOW - 5 * DAY) });
        tenant(TENANT_C, TOKEN_C, 3, { token_last_checked_at: null });
        await recheckAllMetaTokens({ now: () => NOW });
        assert.deepEqual(graph.called(/debug_token/).map((c) => c.params?.input_token), [TOKEN_C, TOKEN_B, TOKEN_A]);
    });

    it('stops at its limit and says there is more, leaving the rest for tomorrow in order', async () => {
        tenant(TENANT_A, TOKEN_A, 1, { token_last_checked_at: new Date(NOW - 1 * DAY) });
        tenant(TENANT_B, TOKEN_B, 2, { token_last_checked_at: new Date(NOW - 5 * DAY) });
        tenant(TENANT_C, TOKEN_C, 3, { token_last_checked_at: new Date(NOW - 3 * DAY) });
        const result = await recheckAllMetaTokens({ limit: 2, now: () => NOW });
        assert.equal(result.checked, 2);
        assert.equal(result.moreRemaining, true);
        assert.deepEqual(graph.called(/debug_token/).map((c) => c.params?.input_token), [TOKEN_B, TOKEN_C]);
    });

    it('stops when its time budget is spent, and says there is more', async () => {
        tenant(TENANT_A, TOKEN_A, 1, { token_last_checked_at: new Date(NOW - 3 * DAY) });
        tenant(TENANT_B, TOKEN_B, 2, { token_last_checked_at: new Date(NOW - 2 * DAY) });
        let clock = NOW;
        const result = await recheckAllMetaTokens({ budgetMs: 1_000, now: () => (clock += 600) });
        assert.equal(result.checked, 1);
        assert.equal(result.moreRemaining, true);
    });

    it('survives a database that is gone: it reports nothing and throws nothing', async () => {
        db.failOn = /^SELECT id FROM creators WHERE page_access_token IS NOT NULL/;
        const result = await recheckAllMetaTokens({ now: () => NOW });
        assert.deepEqual(result, { checked: 0, valid: 0, expiring: 0, invalid: 0, transient: 0, skipped: 0, moreRemaining: false });
    });

    it('puts no token, no app secret and no request config in a log line or a stored row, whatever happens', async () => {
        owner();
        tenant(TENANT_A, TOKEN_A, 1);
        tenant(TENANT_B, TOKEN_B, 2);
        graph.fail(/GET \/debug_token/, 503, { message: 'Service Unavailable', code: 2 }, 1);
        graph.inspections.set(TOKEN_B, { is_valid: false, error: { code: 190, message: 'Error validating access token.' } });
        await recheckAllMetaTokens({ now: () => NOW });
        const haystack = [logs.join('\n'), db.everything()].join('\n');
        for (const secret of [OWNER_TOKEN, TOKEN_A, TOKEN_B, 'the-app-secret-0123456789-never-in-a-log', 'REQUEST-CONFIG-SECRET', 'REQUEST-CONFIG-MUST-NOT-LEAK']) {
            assert.ok(!haystack.includes(secret), `leaked ${secret.slice(0, 12)}…`);
        }
        assert.ok(logs.some((l) => l.includes('token.recheck_transient')), 'the transient failure is logged');
        assert.ok(logs.some((l) => l.includes('token.reconnect_due')), 'and the definitive one is logged where an alert can see it');
    });
});
