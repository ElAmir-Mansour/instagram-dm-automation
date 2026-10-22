/**
 * `/api/ads` through the whole router (contracts/dashboard-api.md; tasks T023): the ADS_DISABLED gate on every route, the role of each
 * route (viewer reads, owner writes), `confirm: true` before anything that can start spend, the error shape
 * `{ error, code, field?, metaCode?, retryAt? }`, the setup steps instead of an error for a tenant that is not set up, and a cap lowered
 * below the month's spend that saves anyway and says every active campaign is being paused.
 *
 * The router is called as Express calls it, with the database faked by SQL (the settings live in a Map) and Meta stubbed at `metaHttp`.
 */
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, describe, it } from 'node:test';
import { metaHttp } from '../services/http.js';
import { telegramHttp } from '../services/notify.js';
import { installFakeDb, type FakeDb } from '../services/monteur/testDb.js';
import { resetAdsApiVersionCache } from '../services/ads/graph.js';
import { forgetMoneyPicture } from '../services/ads/money.js';
import { adsRouter } from './ads.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACC = '509787248064459';
const TOKEN = 'EAAB-token-for-tests-0123456789';

type Role = 'viewer' | 'operator' | 'owner';

interface FakeRes {
    statusCode: number;
    body: any;
    status(code: number): FakeRes;
    json(payload: unknown): FakeRes;
    setHeader(): void;
    getHeader(): undefined;
}

async function call(method: string, url: string, opts: { role?: Role; body?: unknown } = {}): Promise<FakeRes> {
    const [path, qs] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(qs ?? ''));
    return new Promise((resolve, reject) => {
        const res: FakeRes = {
            statusCode: 200,
            body: undefined,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; resolve(this); return this; },
            setHeader() {},
            getHeader() { return undefined; },
        };
        const req = {
            method, url, originalUrl: `/api/ads${url}`, baseUrl: '', path, headers: {}, params: {}, query, body: opts.body ?? {},
            session: { userId: 'u1', role: 'user', tenantId: TENANT }, tenantRole: opts.role ?? 'owner',
        };
        (adsRouter as any)(req, res, (err?: unknown) => (err ? reject(err) : resolve({ ...res, statusCode: 404, body: { error: 'no route' } })));
    });
}

describe('/api/ads', () => {
    let db: FakeDb;
    let settings: Map<string, string>;
    let secrets: Set<string>;
    let metaGets: string[];
    let metaPosts: Array<{ url: string; body: URLSearchParams }>;
    let spent: string;
    let campaigns: any[];
    let throttle: boolean;
    let originalGet: typeof metaHttp.get;
    let originalPost: typeof metaHttp.post;
    let originalTelegram: typeof telegramHttp.post;

    const configure = () => {
        settings.set(`ads.settings.${TENANT}`, JSON.stringify({ adAccountId: ACC, maxDailyBudget: 20, monthlyCap: 100, tokenSource: 'pasted' }));
        settings.set(`ads.token.${TENANT}`, TOKEN);
    };

    beforeEach(() => {
        db = installFakeDb({ platformTenant: TENANT });
        settings = new Map([[`ads.enabled.${TENANT}`, 'true']]);
        metaGets = [];
        metaPosts = [];
        spent = '50';
        campaigns = [];
        throttle = false;
        secrets = new Set();
        const value = (key: string) => (settings.has(key) ? [{ key, value: settings.get(key), is_secret: secrets.has(key) }] : []);
        db.routes.push(
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: value(p[0]) })],
            [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, (p) => ({ rows: (p[0] as string[]).flatMap(value) })],
            [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); if (p[2]) secrets.add(p[0]); else secrets.delete(p[0]); return { rows: [] }; }],
            [/^DELETE FROM app_settings WHERE key = \$1/, (p) => { settings.delete(p[0]); return { rows: [] }; }],
            [/^SELECT key FROM app_settings WHERE key LIKE 'ads\.enabled\.%'/, () => ({ rows: [{ key: `ads.enabled.${TENANT}` }] })],
            [/^SELECT COALESCE\(SUM\(\(payload->>'worst_case_delta'\)::numeric\), 0\)::text AS total FROM ads_ops/, () => ({ rows: [{ total: '0' }] })],
            [/^SELECT COUNT\(\*\)::text AS n FROM ads_ops/, () => ({ rows: [{ n: '0' }] })],
            [/^INSERT INTO audit_log/, () => ({ rows: [{ id: 'a' }] })],
            [/^INSERT INTO ads_alerts/, () => ({ rows: [{ id: 'al' }] })],
            [/^SELECT email FROM users/, () => ({ rows: [{ email: 'owner@example.com' }] })],
            [/FROM ad_boosts/, () => ({ rows: [] })],
        );
        originalGet = metaHttp.get;
        originalPost = metaHttp.post;
        originalTelegram = telegramHttp.post;
        (metaHttp as any).get = async (url: string) => {
            metaGets.push(url);
            if (throttle) throw Object.assign(new Error('x'), { response: { status: 400, headers: { 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 120 }) }, data: { error: { code: 80004, message: 'too many calls' } } } });
            if (url.endsWith(`/act_${ACC}`)) return { data: { name: 'Acc', currency: 'USD', account_status: 1, timezone_offset_hours_utc: 3, funding_source: '1' }, headers: {} };
            if (url.endsWith(`/act_${ACC}/insights`)) return { data: { data: [{ spend: spent }] }, headers: {} };
            if (url.endsWith(`/act_${ACC}/campaigns`)) return { data: { data: campaigns }, headers: {} };
            return { data: {}, headers: {} };
        };
        (metaHttp as any).post = async (url: string, body: URLSearchParams) => { metaPosts.push({ url, body }); return { data: { success: true }, headers: {} }; };
        (telegramHttp as any).post = async () => ({ data: { ok: true } });
        resetAdsApiVersionCache();
        forgetMoneyPicture();
    });
    afterEach(() => {
        db.restore();
        (metaHttp as any).get = originalGet;
        (metaHttp as any).post = originalPost;
        (telegramHttp as any).post = originalTelegram;
    });

    describe('the ADS_DISABLED gate', () => {
        for (const [method, url] of [['GET', '/settings'], ['GET', '/overview'], ['GET', '/money'], ['POST', '/settings'], ['POST', '/spend-cap'], ['POST', '/boosts/x/activate'], ['GET', '/boosts']] as const) {
            it(`${method} ${url} is 404 ADS_DISABLED when ads are off for the tenant`, async () => {
                settings.delete(`ads.enabled.${TENANT}`);
                const res = await call(method, url, { body: { confirm: true } });
                assert.equal(res.statusCode, 404);
                assert.equal(res.body.code, 'ADS_DISABLED');
                assert.equal(metaGets.length + metaPosts.length, 0);
            });
        }
    });

    describe('roles', () => {
        for (const url of ['/settings', '/overview', '/money', '/boosts']) {
            it(`a viewer may read GET ${url}`, async () => {
                const res = await call('GET', url, { role: 'viewer' });
                assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            });
        }
        for (const [method, url] of [['POST', '/settings'], ['POST', '/settings/test'], ['POST', '/settings/alerts'], ['POST', '/spend-cap'], ['GET', '/accounts'], ['POST', '/boosts'], ['POST', '/boosts/x/activate'], ['POST', '/campaigns/123456/status'], ['POST', '/campaigns/123456/budget'], ['DELETE', '/campaigns/123456']] as const) {
            it(`${method} ${url} is the owner's: an operator gets 403`, async () => {
                const res = await call(method, url, { role: 'operator', body: { confirm: true } });
                assert.equal(res.statusCode, 403);
                assert.equal(metaPosts.length, 0);
            });
        }
    });

    describe('confirm before spending', () => {
        it('activate, resume and the spending limit need confirm: true, refused before any Meta call', async () => {
            configure();
            for (const [url, b] of [['/boosts/x/activate', {}], ['/campaigns/123456/status', { status: 'ACTIVE' }], ['/spend-cap', { amount: 50 }]] as const) {
                const res = await call('POST', url, { body: b });
                assert.equal(res.statusCode, 400, url);
                assert.deepEqual({ code: res.body.code, field: res.body.field }, { code: 'INVALID', field: 'confirm' });
            }
            assert.equal(metaGets.length + metaPosts.length, 0);
        });
    });

    describe('a tenant that is not set up', () => {
        it('GET /overview answers configured:false with the four steps, not 409', async () => {
            const res = await call('GET', '/overview');
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.configured, false);
            assert.deepEqual(res.body.steps.map((s: any) => s.id), ['token', 'account', 'payment', 'limits']);
            assert.ok(res.body.steps.every((s: any) => s.done === false && typeof s.hintCode === 'string'));
            assert.equal(metaGets.length, 0);
        });

        it('GET /settings answers configured:false with the steps', async () => {
            const res = await call('GET', '/settings');
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.configured, false);
            assert.equal(res.body.steps.length, 4);
            assert.deepEqual(res.body.token, { set: false, last4: null, source: null, expiresAt: null, health: 'unknown' });
        });

        it('GET /money answers NOT_CONFIGURED (200, fits nothing)', async () => {
            const res = await call('GET', '/money?candidate=lifetime:30:3');
            assert.equal(res.statusCode, 200);
            assert.deepEqual({ fits: res.body.fits, reason: res.body.reason }, { fits: false, reason: 'NOT_CONFIGURED' });
        });
    });

    describe('GET /money', () => {
        it('gives what is left and whether a candidate fits, by the money rule', async () => {
            configure();
            campaigns = [{ id: '111111', status: 'ACTIVE', lifetime_budget: '2000' }];
            const res = await call('GET', '/money?candidate=lifetime:30:3');
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.remaining, 30, '100 cap − 50 spent − 20 still to spend');
            assert.equal(res.body.fits, true);
            assert.equal(res.body.excludesTax, true);
            forgetMoneyPicture();
            const over = await call('GET', '/money?candidate=lifetime:30.01:3');
            assert.equal(over.body.fits, false);
            assert.equal(over.body.reason, 'OVER_MONTHLY_CAP');
        });

        it('refuses a malformed candidate', async () => {
            configure();
            const res = await call('GET', '/money?candidate=weekly:5');
            assert.deepEqual({ status: res.statusCode, code: res.body.code, field: res.body.field }, { status: 400, code: 'INVALID', field: 'candidate' });
        });
    });

    describe('the error shape', () => {
        it('a throttle is 429 RATE_LIMITED with metaCode and retryAt, never retried', async () => {
            configure();
            throttle = true;
            const res = await call('GET', '/overview');
            assert.equal(res.statusCode, 200, 'the overview answers from the stored copy');
            assert.equal(metaGets.length, 0, 'the overview never calls Meta (A2: stored copy only)');
            const resume = await call('POST', '/campaigns/123456/status', { body: { status: 'ACTIVE', confirm: true } });
            assert.equal(resume.statusCode, 429);
            assert.equal(resume.body.code, 'RATE_LIMITED');
            assert.equal(resume.body.metaCode, 80004);
            assert.ok(!Number.isNaN(Date.parse(resume.body.retryAt)));
            assert.equal(typeof resume.body.error, 'string');
        });

        it('an invalid setting is 400 with code and field', async () => {
            const res = await call('POST', '/settings', { body: { monthlyCap: -5 } });
            assert.deepEqual({ status: res.statusCode, code: res.body.code, field: res.body.field }, { status: 400, code: 'INVALID', field: 'monthlyCap' });
        });
    });

    describe('POST /settings', () => {
        it('lowering the cap below this month\'s spend saves, pauses the active campaigns at once, and warns will_pause_all', async () => {
            configure();
            spent = '80';
            campaigns = [{ id: '111111', status: 'ACTIVE', daily_budget: '1000' }];
            const res = await call('POST', '/settings', { body: { monthlyCap: 60, maxDailyBudget: 10 } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.deepEqual(res.body.warnings, ['will_pause_all']);
            assert.equal(JSON.parse(settings.get(`ads.settings.${TENANT}`)!).monthlyCap, 60, 'saved');
            assert.ok(metaPosts.some((p) => p.url.endsWith('/111111') && p.body.get('status') === 'PAUSED'), 'the guard ran at once');
        });

        it('a cap above the spend saves with no warning', async () => {
            configure();
            const res = await call('POST', '/settings', { body: { monthlyCap: 500 } });
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.warnings, undefined);
        });

        it('refuses a limit above the platform ceiling with OVER_CEILING, for a managed client', async () => {
            db.restore();
            db = installFakeDb({ platformTenant: '99999999-9999-4999-8999-999999999999' });
            const value = (key: string) => (settings.has(key) ? [{ key, value: settings.get(key), is_secret: false }] : []);
            db.routes.push(
                [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: value(p[0]) })],
                [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, (p) => ({ rows: (p[0] as string[]).flatMap(value) })],
                [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); return { rows: [] }; }],
            );
            settings.set(`ads.ceiling.${TENANT}`, JSON.stringify({ maxDailyBudget: 10, monthlyCap: 200 }));
            const res = await call('POST', '/settings', { body: { monthlyCap: 250 } });
            assert.deepEqual({ status: res.statusCode, code: res.body.code, field: res.body.field }, { status: 400, code: 'OVER_CEILING', field: 'monthlyCap' });
            const ok = await call('POST', '/settings', { body: { monthlyCap: 200 } });
            assert.equal(ok.statusCode, 200);
        });

        it('never answers with the token', async () => {
            const previous = process.env['TOKEN_ENCRYPTION_KEY'];
            process.env['TOKEN_ENCRYPTION_KEY'] = 'a'.repeat(64);
            after(() => { if (previous === undefined) delete process.env['TOKEN_ENCRYPTION_KEY']; else process.env['TOKEN_ENCRYPTION_KEY'] = previous; });
            const res = await call('POST', '/settings', { body: { token: TOKEN, adAccountId: `act_${ACC}`, maxDailyBudget: 10, monthlyCap: 100 } });
            assert.equal(res.statusCode, 200);
            assert.doesNotMatch(JSON.stringify(res.body), /EAAB-token-for-tests/);
            assert.equal(res.body.token.last4, '6789');
        });
    });

    describe('POST /settings/alerts', () => {
        it('saves the recipients, keeps the required kinds on, and sends a test when asked', async () => {
            settings.set('notify.telegram_bot_token', '123456789:AAH_fake_token_for_tests_0123456789abcd');
            const res = await call('POST', '/settings/alerts', { body: { telegramChatId: '4242', lang: 'en', kinds: { cap_paused: false, token_expiring: false }, test: true } });
            assert.equal(res.statusCode, 200, JSON.stringify(res.body));
            assert.equal(res.body.alerts.kinds.cap_paused, true);
            assert.equal(res.body.alerts.kinds.token_expiring, false);
            assert.deepEqual(res.body.test, { telegram: 'sent', email: 'off' });
            const bad = await call('POST', '/settings/alerts', { body: { email: 'not-an-address' } });
            assert.deepEqual({ status: bad.statusCode, field: bad.body.field }, { status: 400, field: 'email' });
        });
    });
});
