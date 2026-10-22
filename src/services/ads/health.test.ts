/**
 * The daily ads health check (research R8; tasks T021): for every tenant with ads enabled, the token, the ad account's status and
 * funding, and the version Meta served. Each problem becomes an alert (deduped per day by notify.ts), and what was seen is stored in
 * `ads.health.<tenant>` so the screens read it instead of calling Meta.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { metaHttp } from '../http.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { resetAdsApiVersionCache } from './graph.js';
import { accountAlerts, checkTenantHealth, runAdsHealth } from './health.js';
import { isQueueStopped, type AccountSnapshot } from './settings.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACC = '509787248064459';
const NOW = new Date('2026-10-22T10:00:00Z');

const snapshot = (over: Partial<AccountSnapshot>): AccountSnapshot => ({
    name: 'Acc', currency: 'USD', timezone: 'Asia/Riyadh', timezoneOffsetHours: 3, status: 1, statusLabel: 'active', disableReason: null,
    hasPaymentMethod: true, isPrepay: false, spendCap: null, amountSpent: 0, minDailyBudget: 1, billingUrl: '', adsManagerUrl: '', syncedAt: NOW.toISOString(), ...over,
});

describe('accountAlerts', () => {
    it('a healthy account raises nothing', () => {
        assert.deepEqual(accountAlerts(snapshot({})), []);
    });

    it('status 2, 100 and 101 are account_disabled; 3 and 9 are payment', () => {
        assert.deepEqual(accountAlerts(snapshot({ status: 2, statusLabel: 'disabled', disableReason: 'Ads integrity policy' })).map((a) => a.kind), ['account_disabled']);
        assert.deepEqual(accountAlerts(snapshot({ status: 100, statusLabel: 'closed' })).map((a) => a.kind), ['account_disabled']);
        assert.deepEqual(accountAlerts(snapshot({ status: 101, statusLabel: 'closed' })).map((a) => a.kind), ['account_disabled']);
        const unsettled = accountAlerts(snapshot({ status: 3, statusLabel: 'unsettled' }));
        assert.deepEqual(unsettled.map((a) => a.kind), ['payment']);
        assert.equal(unsettled[0]!.kind === 'payment' && unsettled[0]!.reason, 'unsettled');
        const grace = accountAlerts(snapshot({ status: 9, statusLabel: 'active' }));
        assert.equal(grace[0]!.kind === 'payment' && grace[0]!.reason, 'grace_period');
    });

    it('no funding source is a payment alert; "could not tell" is not', () => {
        const none = accountAlerts(snapshot({ hasPaymentMethod: false }));
        assert.deepEqual(none.map((a) => a.kind), ['payment']);
        assert.equal(none[0]!.kind === 'payment' && none[0]!.reason, 'no_payment_method');
        assert.deepEqual(accountAlerts(snapshot({ hasPaymentMethod: null })), []);
    });
});

describe('checkTenantHealth and runAdsHealth', () => {
    let db: FakeDb;
    let settings: Map<string, string>;
    let alerts: any[][];
    let deleted: string[];
    let account: Record<string, unknown>;
    let headers: Record<string, string>;
    let meFails: null | number;
    let originalGet: typeof metaHttp.get;
    let originalAxiosGet: typeof axios.get;
    let debugToken: Record<string, unknown>;

    beforeEach(() => {
        db = installFakeDb();
        settings = new Map([
            [`ads.enabled.${TENANT}`, 'true'],
            [`ads.settings.${TENANT}`, JSON.stringify({ adAccountId: ACC, maxDailyBudget: 20, monthlyCap: 100, tokenSource: 'pasted' })],
            [`ads.token.${TENANT}`, 'EAAB-token-for-tests-0123456789'],
            ['ads.copy_admin', 'false'],
        ]);
        alerts = [];
        deleted = [];
        account = { name: 'ElAmir Mansour', currency: 'USD', account_status: 1, timezone_offset_hours_utc: 3, timezone_name: 'Asia/Riyadh', funding_source_details: { id: '1', display_string: 'Visa *1234', type: 1 }, is_prepay_account: false, spend_cap: '0', amount_spent: '1250' };
        headers = { 'facebook-api-version': 'v26.0' };
        meFails = null;
        debugToken = { is_valid: true, type: 'USER', expires_at: 0, scopes: ['ads_management', 'ads_read', 'business_management'] };
        const value = (key: string) => (settings.has(key) ? [{ key, value: settings.get(key), is_secret: false }] : []);
        db.routes.push(
            [/^SELECT key FROM app_settings WHERE key LIKE 'ads\.enabled\.%' AND value = 'true'/, () => ({ rows: [{ key: `ads.enabled.${TENANT}` }] })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: value(p[0]) })],
            [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, (p) => ({ rows: (p[0] as string[]).flatMap(value) })],
            [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); return { rows: [] }; }],
            [/^INSERT INTO ads_alerts/, (p) => { alerts.push(p); return { rows: [{ id: `al${alerts.length}` }] }; }],
            [/^DELETE FROM ads_(alerts|ops)/, (_p, sql) => { deleted.push(sql); return { rows: [], rowCount: 0 }; }],
        );
        originalGet = metaHttp.get;
        originalAxiosGet = axios.get;
        (metaHttp as any).get = async (url: string) => {
            if (url.endsWith('/me')) {
                if (meFails) throw Object.assign(new Error('x'), { response: { status: 400, headers: {}, data: { error: { code: meFails, message: 'Invalid OAuth access token' } } } });
                return { data: { id: '42' }, headers };
            }
            if (url.endsWith(`/act_${ACC}`)) return { data: account, headers };
            throw new Error(`unexpected GET ${url}`);
        };
        (axios as any).get = async () => ({ data: { data: debugToken } });
        resetAdsApiVersionCache();
    });
    afterEach(() => {
        db.restore();
        (metaHttp as any).get = originalGet;
        (axios as any).get = originalAxiosGet;
    });

    const health = () => JSON.parse(settings.get(`ads.health.${TENANT}`)!);

    it('stores the account as Meta described it, the token as ok, and raises nothing for a healthy account', async () => {
        const r = await checkTenantHealth(TENANT, NOW);
        assert.deepEqual(r.alerts, []);
        const h = health();
        assert.equal(h.token.health, 'ok');
        assert.equal(h.account.name, 'ElAmir Mansour');
        assert.equal(h.account.timezone, 'Asia/Riyadh');
        assert.equal(h.account.hasPaymentMethod, true);
        assert.equal(h.account.amountSpent, 12.5, 'amount_spent is read in cents');
        assert.equal(h.account.spendCap, null, 'a spend cap of 0 is no limit');
        assert.equal(h.servedVersion, 'v26.0');
        assert.doesNotMatch(settings.get(`ads.health.${TENANT}`)!, /Visa \*1234|EAAB/, 'no card string and no token in the stored copy');
    });

    it('a disabled account raises account_disabled', async () => {
        account = { ...account, account_status: 2, disable_reason: 1 };
        const r = await checkTenantHealth(TENANT, NOW);
        assert.deepEqual(r.alerts, ['account_disabled']);
    });

    it('no funding source raises payment', async () => {
        account = { ...account, funding_source_details: null, funding_source: null };
        delete (account as any).funding_source_details;
        account['funding_source'] = '';
        const r = await checkTenantHealth(TENANT, NOW);
        assert.deepEqual(r.alerts, ['payment']);
    });

    it('a token Meta refuses with 190 is token_dead, and the tenant\'s queue stops', async () => {
        meFails = 190;
        const r = await checkTenantHealth(TENANT, NOW);
        assert.deepEqual(r.alerts, ['token_dead']);
        assert.equal(health().token.health, 'dead');
        assert.equal(isQueueStopped(health()), true);
    });

    it('a Connect token expiring within 14 days raises token_expiring', async () => {
        settings.set(`ads.settings.${TENANT}`, JSON.stringify({ adAccountId: ACC, maxDailyBudget: 20, monthlyCap: 100, tokenSource: 'connect' }));
        debugToken = { ...debugToken, expires_at: Math.floor((NOW.getTime() + 5 * 86_400_000) / 1000) };
        const r = await checkTenantHealth(TENANT, NOW);
        assert.deepEqual(r.alerts, ['token_expiring']);
        assert.equal(health().token.health, 'expiring');
    });

    it('a served version different from the pinned one raises version_mismatch', async () => {
        headers = { 'facebook-api-version': 'v25.0' };
        const r = await checkTenantHealth(TENANT, NOW);
        assert.deepEqual(r.alerts, ['version_mismatch']);
    });

    it('runAdsHealth checks every enabled tenant and sweeps alerts after a year and finished ops after 180 days', async () => {
        const r = await runAdsHealth({ now: NOW });
        assert.equal(r.checked, 1);
        assert.ok(deleted.some((s) => /ads_alerts/.test(s) && /1 year/.test(s)));
        assert.ok(deleted.some((s) => /ads_ops/.test(s) && /180 days/.test(s) && /'done', 'failed', 'cancelled'/.test(s)));
    });
});
