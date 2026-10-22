/**
 * The spending guard (research R8; tasks T020): after switch-on the monthly cap is held by pausing every ACTIVE campaign in the ad
 * account once the month reached it or one more day could pass it. What v1 got wrong and this pins:
 *   - `ads.cap_checked` is written only AFTER a successful check (v1 wrote it first, so a Meta failure went unchecked for an hour);
 *   - it takes a deadline and stops between tenants and between pauses;
 *   - a pause raises a `cap_paused` alert and writes an `ads.cap_paused` audit row (v1 only logged);
 *   - two hours without a successful check raises `guard_blind`.
 * Meta is stubbed at `metaHttp`, the database with the fake pool; Telegram at `telegramHttp`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { metaHttp } from '../http.js';
import { telegramHttp } from '../notify.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { resetAdsApiVersionCache } from './graph.js';
import { ADS_GUARD_ACTOR_EMAIL, BLIND_AFTER_MS, runGuard } from './guard.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACC = '509787248064459';
const NOW = new Date('2026-10-22T10:00:00Z');
const HOUR = 3_600_000;

interface MetaState {
    spent: string;
    campaigns: any[];
    fail: null | { code: number; subcode?: number; status?: number };
}

describe('runGuard', () => {
    let db: FakeDb;
    let settings: Map<string, string>;
    let writes: Array<{ key: string; value: string | null }>;
    let paused: string[];
    let audits: any[][];
    let alerts: any[][];
    let telegram: any[];
    let meta: MetaState;
    let originalGet: typeof metaHttp.get;
    let originalPost: typeof metaHttp.post;
    let originalTelegram: typeof telegramHttp.post;

    const metaError = (f: NonNullable<MetaState['fail']>) => Object.assign(new Error('meta'), { response: { status: f.status ?? 400, headers: {}, data: { error: { code: f.code, error_subcode: f.subcode, message: 'nope' } } } });

    beforeEach(() => {
        db = installFakeDb();
        settings = new Map([
            [`ads.enabled.${TENANT}`, 'true'],
            [`ads.settings.${TENANT}`, JSON.stringify({ adAccountId: ACC, maxDailyBudget: 20, monthlyCap: 100, tokenSource: 'pasted' })],
            [`ads.token.${TENANT}`, 'EAAB-token-for-tests-0123456789'],
            [`ads.alerts.${TENANT}`, JSON.stringify({ telegramChatId: '4242', lang: 'en' })],
            ['notify.telegram_bot_token', '123456789:AAH_fake_token_for_tests_0123456789abcd'],
            ['ads.copy_admin', 'false'],
        ]);
        writes = [];
        paused = [];
        audits = [];
        alerts = [];
        telegram = [];
        meta = { spent: '50', campaigns: [], fail: null };
        const value = (key: string) => (settings.has(key) ? [{ key, value: settings.get(key), is_secret: false }] : []);
        db.routes.push(
            [/^SELECT key FROM app_settings WHERE key LIKE 'ads\.enabled\.%' AND value = 'true'/, () => ({ rows: [...settings.keys()].filter((k) => k.startsWith('ads.enabled.') && settings.get(k) === 'true').map((key) => ({ key })) })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: value(p[0]) })],
            [/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, (p) => ({ rows: (p[0] as string[]).flatMap(value) })],
            [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); writes.push({ key: p[0], value: p[1] }); return { rows: [] }; }],
            [/^DELETE FROM app_settings WHERE key = \$1/, (p) => { settings.delete(p[0]); writes.push({ key: p[0], value: null }); return { rows: [] }; }],
            [/^SELECT id, scheduled_post_id, campaign_id FROM ad_boosts/, () => ({ rows: [] })],
            [/^INSERT INTO audit_log/, (p) => { audits.push(p); return { rows: [{ id: 'a1' }] }; }],
            [/^INSERT INTO ads_alerts/, (p) => { if (alerts.some((a) => a[1] === p[1] && a[3] === p[3])) return { rows: [] }; alerts.push(p); return { rows: [{ id: `al${alerts.length}` }] }; }],
        );
        originalGet = metaHttp.get;
        originalPost = metaHttp.post;
        originalTelegram = telegramHttp.post;
        (metaHttp as any).get = async (url: string) => {
            if (meta.fail) throw metaError(meta.fail);
            if (url.endsWith(`/act_${ACC}`)) return { data: { name: 'ElAmir Mansour', currency: 'USD', account_status: 1, timezone_offset_hours_utc: 3, funding_source: '123' }, headers: {} };
            if (url.endsWith(`/act_${ACC}/insights`)) return { data: { data: [{ spend: meta.spent }] }, headers: {} };
            if (url.endsWith(`/act_${ACC}/campaigns`)) return { data: { data: meta.campaigns }, headers: {} };
            throw new Error(`unexpected GET ${url}`);
        };
        (metaHttp as any).post = async (url: string, body: URLSearchParams) => {
            if (body.get('status') === 'PAUSED') paused.push(url.split('/').pop()!);
            return { data: { success: true }, headers: {} };
        };
        (telegramHttp as any).post = async (_url: string, body: any) => { telegram.push(body); return { data: { ok: true } }; };
        resetAdsApiVersionCache();
    });
    afterEach(() => {
        db.restore();
        (metaHttp as any).get = originalGet;
        (metaHttp as any).post = originalPost;
        (telegramHttp as any).post = originalTelegram;
    });

    const active = (id: string, dailyMinor: number) => ({ id, status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: String(dailyMinor) });

    it('under the cap: pauses nothing, and writes cap_checked after the check', async () => {
        meta.campaigns = [active('111111', 1000)];
        const r = await runGuard({ now: NOW });
        assert.deepEqual({ checked: r.checked, paused: r.paused, failed: r.failed }, { checked: 1, paused: 0, failed: 0 });
        assert.deepEqual(paused, []);
        assert.equal(settings.get(`ads.cap_checked.${TENANT}`), NOW.toISOString());
    });

    it('when one more day could pass the cap: pauses every ACTIVE campaign, alerts cap_paused and writes an audit row', async () => {
        meta.spent = '90';
        meta.campaigns = [active('111111', 1000), active('222222', 500), { id: '333333', status: 'PAUSED', daily_budget: '9900' }];
        const r = await runGuard({ now: NOW });
        assert.equal(r.paused, 2);
        assert.deepEqual(paused.sort(), ['111111', '222222']);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0]![1], 'cap_paused');
        assert.equal(telegram.length, 1);
        assert.match(telegram[0].text, /paused/i);
        assert.equal(audits.length, 1);
        assert.equal(audits[0]![1], ADS_GUARD_ACTOR_EMAIL);
        assert.equal(audits[0]![2], 'ads.cap_paused');
        assert.deepEqual(JSON.parse(audits[0]![5]).campaign_ids.sort(), ['111111', '222222']);
        assert.equal(settings.get(`ads.cap_checked.${TENANT}`), NOW.toISOString());
    });

    it('a Meta failure writes NO cap_checked (only the attempt), and the next drain after 10 minutes tries again', async () => {
        meta.fail = { code: 1, status: 500 };
        settings.set(`ads.cap_checked.${TENANT}`, new Date(NOW.getTime() - 30 * 60_000).toISOString());
        // 30 minutes since the last success: not due yet.
        assert.equal((await runGuard({ now: NOW })).checked, 0);
        settings.set(`ads.cap_checked.${TENANT}`, new Date(NOW.getTime() - HOUR - 1).toISOString());
        const r = await runGuard({ now: NOW });
        assert.equal(r.failed, 1);
        assert.notEqual(settings.get(`ads.cap_checked.${TENANT}`), NOW.toISOString());
        assert.equal(settings.get(`ads.cap_attempt.${TENANT}`), NOW.toISOString());
        assert.equal((await runGuard({ now: new Date(NOW.getTime() + 5 * 60_000) })).checked, 0, 'not again within 10 minutes');
        meta.fail = null;
        const later = new Date(NOW.getTime() + 11 * 60_000);
        assert.equal((await runGuard({ now: later })).checked, 1);
        assert.equal(settings.get(`ads.cap_checked.${TENANT}`), later.toISOString());
    });

    it('a pause that fails leaves cap_checked unwritten, so the next drain pauses the rest', async () => {
        meta.spent = '100';
        meta.campaigns = [active('111111', 1000)];
        (metaHttp as any).post = async () => { throw metaError({ code: 2, status: 503 }); };
        const r = await runGuard({ now: NOW });
        assert.equal(r.failed, 1);
        assert.equal(settings.has(`ads.cap_checked.${TENANT}`), false);
    });

    it('raises guard_blind once two hours have passed without a successful check', async () => {
        meta.fail = { code: 80004 };
        settings.set(`ads.cap_checked.${TENANT}`, new Date(NOW.getTime() - BLIND_AFTER_MS - 1).toISOString());
        const r = await runGuard({ now: NOW });
        assert.equal(r.blind, 1);
        assert.ok(alerts.some((a) => a[1] === 'guard_blind'));
    });

    it('is not blind within the two hours', async () => {
        meta.fail = { code: 1, status: 500 };
        settings.set(`ads.cap_checked.${TENANT}`, new Date(NOW.getTime() - HOUR - 60_000).toISOString());
        const r = await runGuard({ now: NOW });
        assert.equal(r.blind, 0);
        assert.equal(alerts.length, 0);
    });

    it('a dead token marks the tenant\'s token dead and raises token_dead', async () => {
        meta.fail = { code: 190, subcode: 463 };
        await runGuard({ now: NOW });
        assert.ok(alerts.some((a) => a[1] === 'token_dead'));
        assert.equal(JSON.parse(settings.get(`ads.health.${TENANT}`)!).token.health, 'dead');
    });

    it('stops at the deadline, before touching a tenant', async () => {
        const r = await runGuard({ now: NOW, deadline: Date.now() - 1 });
        assert.equal(r.checked, 0);
        assert.equal(r.stoppedAtDeadline, true);
    });

    it('skips a tenant without ads enabled, or without a token or a cap', async () => {
        settings.delete(`ads.enabled.${TENANT}`);
        assert.equal((await runGuard({ now: NOW })).checked, 0);
        settings.set(`ads.enabled.${TENANT}`, 'true');
        settings.delete(`ads.token.${TENANT}`);
        assert.equal((await runGuard({ now: NOW })).checked, 0);
    });

    it('force checks at once, whatever the hour, for one tenant (a cap lowered below the spend)', async () => {
        settings.set(`ads.cap_checked.${TENANT}`, new Date(NOW.getTime() - 60_000).toISOString());
        meta.spent = '120';
        meta.campaigns = [active('111111', 1000)];
        const r = await runGuard({ now: NOW, only: TENANT, force: true });
        assert.equal(r.paused, 1);
    });
});
