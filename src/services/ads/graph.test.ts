/**
 * The ads Graph client (research R1, R5; contracts/meta-graph.md "Errors handled specially"): every Marketing API call goes to the ads
 * module's own pinned version, feeds Meta's usage headers to the pacer, and turns Meta's errors into classes the rest of the app acts on.
 * A throttle is NEVER retried (each retry spends points and lengthens Meta's block); a create keeps the `creates` rule of http.ts (only a
 * call that certainly never reached Meta is sent again).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { metaHttp, withRetry } from '../http.js';
import { setLogSink } from '../../utils/log.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import {
    adsGet, adsPost, AdsGraphError, classifyAdsError, normaliseApiVersion, adsApiVersion, resetAdsApiVersionCache, withAdsContext,
    ADS_DEFAULT_VERSION,
} from './graph.js';

function metaError(code: number, subcode?: number, headers: Record<string, string> = {}, status = 400) {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, headers, data: { error: { code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), message: `meta ${code}/${subcode ?? ''}`, fbtrace_id: 'TRACE' } } },
    });
}

describe('classifyAdsError', () => {
    const cases: Array<[number, number | undefined, string]> = [
        [17, 2446079, 'throttle'],
        [613, undefined, 'throttle'],
        [613, 1996, 'throttle'],
        [80000, undefined, 'throttle'],
        [80003, undefined, 'throttle'],
        [80004, undefined, 'throttle'],
        [80014, undefined, 'throttle'],
        [4, 1504022, 'throttle'],
        [4, 1504039, 'throttle'],
        [613, 1487632, 'budget_limit'],
        [613, 4841018, 'object_busy'],
        [17, 1885172, 'spend_cap_limit'],
        [190, undefined, 'token_dead'],
        [190, 463, 'token_dead'],
        [102, undefined, 'token_dead'],
        [200, 1870090, 'terms'],
        [10, 1341012, 'page_assignment'],
        [100, 33, 'other'],
        [200, undefined, 'other'],
    ];
    for (const [code, subcode, klass] of cases) {
        it(`${code}/${subcode ?? '*'} is ${klass}`, () => assert.equal(classifyAdsError(code, subcode), klass));
    }
});

describe('withRetry({ ads: true })', () => {
    for (const [code, subcode] of [[17, 2446079], [613, undefined], [80004, undefined], [4, 1504022], [613, 1487632], [613, 4841018], [17, 1885172], [4, undefined], [32, undefined]] as const) {
        it(`never retries ${code}/${subcode ?? '*'}`, async () => {
            let calls = 0;
            await assert.rejects(withRetry(async () => { calls++; throw metaError(code, subcode); }, { ads: true, baseMs: 1 }));
            assert.equal(calls, 1);
        });
    }

    it('still retries a read that failed on a 5xx or a dropped connection', async () => {
        let calls = 0;
        const out = await withRetry(async () => { if (++calls < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); return 'ok'; }, { ads: true, baseMs: 1 });
        assert.equal(out, 'ok');
        assert.equal(calls, 3);
    });

    it('a create follows the creates rule, minus throttles: a timeout or a 5xx is never resent, a connection that never went out is', async () => {
        let calls = 0;
        await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); }, { ads: true, creates: true, baseMs: 1 }));
        assert.equal(calls, 1);
        calls = 0;
        await assert.rejects(withRetry(async () => { calls++; throw metaError(613); }, { ads: true, creates: true, baseMs: 1 }));
        assert.equal(calls, 1, 'without ads mode a create retries 613; with it, a throttle is never retried');
        calls = 0;
        const out = await withRetry(async () => { if (++calls < 2) throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' }); return 'ok'; }, { ads: true, creates: true, baseMs: 1 });
        assert.equal(out, 'ok');
    });
});

describe('normaliseApiVersion', () => {
    it('accepts v25.0 and later, refuses anything older or malformed', () => {
        assert.equal(normaliseApiVersion('v26.0'), 'v26.0');
        assert.equal(normaliseApiVersion(' v25.0 '), 'v25.0');
        assert.equal(normaliseApiVersion('v27.1'), 'v27.1');
        assert.equal(normaliseApiVersion('v24.0'), null);
        assert.equal(normaliseApiVersion('v21.0'), null);
        assert.equal(normaliseApiVersion('26'), null);
        assert.equal(normaliseApiVersion(''), null);
        assert.equal(normaliseApiVersion(null), null);
    });
});

describe('the calls', () => {
    let db: FakeDb;
    let originalGet: typeof metaHttp.get;
    let originalPost: typeof metaHttp.post;
    let lines: Array<Record<string, unknown>>;
    let restoreSink: () => void;
    let pacerWrites: any[][];
    const TENANT = '11111111-1111-4111-8111-111111111111';

    beforeEach(() => {
        db = installFakeDb();
        pacerWrites = [];
        db.routes.push([/^INSERT INTO ads_pacer/, (p) => { pacerWrites.push(p); return { rows: [] }; }]);
        originalGet = metaHttp.get;
        originalPost = metaHttp.post;
        lines = [];
        const previous = setLogSink((_level, line: string) => { try { lines.push(JSON.parse(line)); } catch { /* not ours */ } });
        restoreSink = () => { setLogSink(previous); };
        resetAdsApiVersionCache();
    });
    afterEach(() => {
        db.restore();
        (metaHttp as any).get = originalGet;
        (metaHttp as any).post = originalPost;
        restoreSink();
        resetAdsApiVersionCache();
    });

    it('calls the pinned default version, with the token in the header and never in the URL', async () => {
        let seen: { url: string; config: any } | null = null;
        (metaHttp as any).get = async (url: string, config: any) => { seen = { url, config }; return { data: { id: '1' }, headers: {} }; };
        await adsGet('act_123/insights', { fields: 'spend' }, 'SECRET-TOKEN', { label: 'spend' });
        assert.equal(seen!.url, `https://graph.facebook.com/${ADS_DEFAULT_VERSION}/act_123/insights`);
        assert.equal(seen!.config.headers.Authorization, 'Bearer SECRET-TOKEN');
        assert.doesNotMatch(seen!.url, /SECRET/);
    });

    it('uses the platform setting ads.api_version, and ignores a stored value below the v25.0 floor', async () => {
        db.routes.push([/FROM app_settings WHERE key = \$1/, (p) => ({ rows: p[0] === 'ads.api_version' ? [{ value: 'v27.0', is_secret: false }] : [] })]);
        assert.equal(await adsApiVersion(), 'v27.0');
        resetAdsApiVersionCache();
        db.routes.unshift([/FROM app_settings WHERE key = \$1/, () => ({ rows: [{ value: 'v24.0', is_secret: false }] })]);
        assert.equal(await adsApiVersion(), ADS_DEFAULT_VERSION);
    });

    it('feeds the usage headers to the pacer when the tenant and account are known, and spends a write as 3 points', async () => {
        (metaHttp as any).post = async () => ({ data: { id: '9' }, headers: { 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 10, reset_time_duration: 0, ads_api_access_tier: 'development_access' }) } });
        await withAdsContext({ creatorId: TENANT, adAccountId: '555' }, () => adsPost('987', { status: 'PAUSED' }, 't', { label: 'pause' }));
        assert.equal(pacerWrites.length, 2, 'one reserve, one observe');
        assert.equal(pacerWrites[0]![2], 3);
        assert.equal(pacerWrites[1]![0], '555');
        assert.equal(pacerWrites[1]![2], 6, '10% of 60 points');
    });

    it('a throttle blocks the account until the time Meta named, logs ads.throttled with retryAt, and is thrown as RATE-LIMITED without a second attempt', async () => {
        let calls = 0;
        (metaHttp as any).get = async () => { calls++; throw metaError(80004, undefined, { 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 240 }) }); };
        const err = await withAdsContext({ creatorId: TENANT, adAccountId: '555' }, () => adsGet('act_555/campaigns', {}, 't', { label: 'campaigns' })).catch((e) => e);
        assert.ok(err instanceof AdsGraphError);
        assert.equal(err.klass, 'throttle');
        assert.equal(err.metaCode, 80004);
        assert.ok(err.retryAt instanceof Date && err.retryAt.getTime() - Date.now() > 200_000, 'retryAt from reset_time_duration');
        assert.equal(calls, 1);
        const blockWrite = pacerWrites.find((p) => p[4] instanceof Date);
        assert.ok(blockWrite, 'blocked_until written');
        const line = lines.find((l) => l['event'] === 'ads.throttled');
        assert.ok(line, 'ads.throttled is logged');
        assert.ok(JSON.stringify(line).includes('retry_at'));
    });

    it('refuses to call at all while the account is blocked', async () => {
        const until = new Date(Date.now() + 60_000);
        db.routes.unshift([/^SELECT score_estimate, window_started_at, blocked_until, last_usage FROM ads_pacer WHERE ad_account_id = \$1 FOR UPDATE$/, () => ({ rows: [{ score_estimate: '0', window_started_at: new Date(), blocked_until: until, last_usage: {} }] })]);
        let calls = 0;
        (metaHttp as any).get = async () => { calls++; return { data: {}, headers: {} }; };
        const err = await withAdsContext({ creatorId: TENANT, adAccountId: '555' }, () => adsGet('act_555', {}, 't', { label: 'account' })).catch((e) => e);
        assert.ok(err instanceof AdsGraphError);
        assert.equal(err.klass, 'throttle');
        assert.deepEqual(err.retryAt, until);
        assert.equal(calls, 0);
    });

    it('a served version that differs from the pinned one is a version_mismatch signal', async () => {
        (metaHttp as any).get = async () => ({ data: {}, headers: { 'facebook-api-version': 'v25.0' } });
        await adsGet('me', { fields: 'id' }, 't', { label: 'me' });
        assert.ok(lines.some((l) => JSON.stringify(l).includes('ads.version_mismatch') && JSON.stringify(l).includes('v25.0')));
    });

    it('carries Meta\'s code, subcode and trace id, and never the token, in what it throws', async () => {
        (metaHttp as any).get = async () => { throw metaError(190, 463); };
        const err = await adsGet('me', {}, 'SECRET-TOKEN', { label: 'me' }).catch((e) => e);
        assert.equal(err.klass, 'token_dead');
        assert.equal(err.metaCode, 190);
        assert.equal(err.metaSubcode, 463);
        assert.equal(err.fbtraceId, 'TRACE');
        assert.doesNotMatch(String(err.message) + JSON.stringify(lines), /SECRET-TOKEN/);
    });

    it('a pacer that cannot be reached does not stop the call (Meta still enforces its own limit)', async () => {
        db.routes.unshift([/ads_pacer/, () => { throw new Error('relation "ads_pacer" does not exist'); }]);
        (metaHttp as any).get = async () => ({ data: { ok: 1 }, headers: {} });
        const out = await withAdsContext({ creatorId: TENANT, adAccountId: '555' }, () => adsGet('act_555', {}, 't', { label: 'account' }));
        assert.deepEqual(out.data, { ok: 1 });
    });
});
