/**
 * The Ads Manager sync (research R4): the nested structure answer into `ads_objects` with its parent links, review and delivery state;
 * a row missing twice marked DELETED (and once not); results per day in the ad account's zone, the last 3 days provisional, reach never
 * summed; the point budget (no Graph call when the pacer cannot spend); the async 28-day report; breakdowns, tolerated before their table
 * exists. Pure parsers first, then the runs with a fake pool and a stubbed Graph (`deps`), as in src/services/ads/pacer.test.ts.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb, type Rows } from '../monteur/testDb.js';
import { AdsGraphError } from './graph.js';
import { resetBreakdownAvailability } from './mirror.js';
import type { PacerStatus } from './pacer.js';
import {
    dayInTz, parseBreakdownRows, parseInsightRows, parseStructure, requestTodaySync, structureIsComplete, summariseTargeting, syncAllAds,
    syncDailyAds, syncInsights, syncStructure, type SyncDeps,
} from './sync.js';

const C = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '1234567890';
const NOW = new Date('2026-10-22T10:00:00Z');
const uuidFor = (meta: string) => `00000000-0000-4000-8000-${String(meta).padStart(12, '0')}`;

// ─── Fixtures ───────────────────────────────────────────────────────────────────────────────

const creative = { id: '444444', object_story_id: '999_888', effective_instagram_media_id: '17900000000000000', thumbnail_url: 'https://t/1.jpg' };

function campaignsPage(extra: { adsetsNext?: boolean; adsNext?: boolean; next?: string } = {}) {
    return {
        data: [
            {
                id: '111111', name: 'AutoReply boost 7f9c2a10-0000-4000-8000-000000000001 · instagram · campaign', objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED',
                effective_status: 'PAUSED', daily_budget: '5000', special_ad_categories: [], start_time: '2026-10-20T08:00:00+0000', stop_time: '2026-10-30T08:00:00+0000',
                adsets: {
                    data: [
                        {
                            id: '222222', name: 'Riyadh 25-45', status: 'ACTIVE', effective_status: 'CAMPAIGN_PAUSED', lifetime_budget: '30000', destination_type: 'INSTAGRAM_DIRECT',
                            optimization_goal: 'CONVERSATIONS', start_time: '2026-10-20T08:00:00+0000', end_time: '2026-10-30T08:00:00+0000',
                            learning_stage_info: { status: 'LEARNING', attributed_to: 'x' },
                            targeting: { geo_locations: { countries: ['SA', 'AE'] }, age_min: 25, age_max: 45, genders: [1], locales: [28] },
                            ads: {
                                data: [
                                    {
                                        id: '333333', name: 'Reel ad', status: 'ACTIVE', effective_status: 'DISAPPROVED', creative,
                                        issues_info: [{ error_summary: 'Ad disapproved', error_message: 'long text' }],
                                        ad_review_feedback: { global: { 'Misleading claims': 'We removed it' } },
                                    },
                                    { id: '333334', name: 'Second ad', status: 'PAUSED', effective_status: 'ADSET_PAUSED', creative },
                                ],
                                ...(extra.adsNext ? { paging: { next: 'https://graph/next', cursors: { after: 'a' } } } : {}),
                            },
                        },
                    ],
                    ...(extra.adsetsNext ? { paging: { next: 'https://graph/next', cursors: { after: 'a' } } } : {}),
                },
            },
        ],
        ...(extra.next ? { paging: { next: 'https://graph/next', cursors: { after: extra.next } } } : {}),
    };
}

const action = (action_type: string, value: string) => ({ action_type, value });

// ─── The fake world ─────────────────────────────────────────────────────────────────────────

interface World {
    db: FakeDb;
    settings: Map<string, string>;
    calls: { kind: 'get' | 'post'; path: string; params: Record<string, unknown> }[];
    deps: SyncDeps;
    clock: { ms: number };
    get: (path: string, params: Record<string, string>) => any;
    post: (path: string, params: Record<string, unknown>) => any;
    pacer: PacerStatus | null;
    /** Rows the missing-rows SELECT answers. */
    missingRows: { id: string; missing: string | null }[];
    sql(pattern: RegExp): { sql: string; params: any[] }[];
}

function world(): World {
    const db = installFakeDb();
    const settings = new Map<string, string>([
        [`ads.settings.${C}`, JSON.stringify({ adAccountId: `act_${ACCOUNT}`, maxDailyBudget: 20, monthlyCap: 300 })],
        [`ads.token.${C}`, 'EAAB-token-for-tests'],
        [`ads.enabled.${C}`, 'true'],
    ]);
    const w: World = {
        db, settings, calls: [], clock: { ms: NOW.getTime() }, pacer: null, missingRows: [],
        get: () => ({ data: [] }),
        post: () => ({}),
        sql: (pattern) => db.ran(pattern),
        deps: undefined as unknown as SyncDeps,
    };
    w.deps = {
        get: async (path, params) => {
            w.calls.push({ kind: 'get', path, params });
            return { data: w.get(path, params) };
        },
        post: async (path, params) => {
            w.calls.push({ kind: 'post', path, params });
            return { data: w.post(path, params) };
        },
        now: () => new Date(w.clock.ms),
        sleep: async (ms) => { w.clock.ms += ms; },
        pacer: async () => w.pacer,
    };
    const row = (rows: any[]): Rows => ({ rows });
    db.routes.push(
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => row(settings.has(p[0]) ? [{ value: settings.get(p[0]), is_secret: false }] : [])],
        [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); return row([]); }],
        [/^SELECT key FROM app_settings WHERE key LIKE 'ads.enabled/, () => row([...settings.keys()].filter((k) => k.startsWith('ads.enabled.')).map((key) => ({ key })))],
        [/^SELECT id, campaign_id, adset_id, ad_id, creative_id FROM ad_boosts/, () => row([])],
        [/^INSERT INTO ads_objects/, (p) => row([{ id: uuidFor(p[3]) }])],
        [/^SELECT id, app_meta->>'sync_missing' AS missing FROM ads_objects/, () => row(w.missingRows)],
    );
    // The account read every sync starts with.
    w.get = (path) => (path === `act_${ACCOUNT}` ? { currency: 'USD', timezone_name: 'Asia/Baghdad' } : { data: [] });
    return w;
}

const stateOf = (w: World) => JSON.parse(w.settings.get(`ads.sync.${C}`) ?? '{}');
const graphCalls = (w: World) => w.calls.filter((c) => c.path !== `act_${ACCOUNT}`);

let w: World;
beforeEach(() => {
    resetBreakdownAvailability();
    w = world();
});
afterEach(() => w.db.restore());

// ─── The parsers ────────────────────────────────────────────────────────────────────────────

describe('parseStructure', () => {
    const objs = parseStructure([campaignsPage()]);
    const by = (id: string) => objs.find((o) => o.metaId === id)!;

    it('flattens campaign, ad sets, ads and their creative with the parent links', () => {
        assert.deepEqual(objs.map((o) => `${o.level}:${o.metaId}`), ['campaign:111111', 'adset:222222', 'ad:333333', 'ad:333334', 'creative:444444']);
        assert.equal(by('111111').parentMetaId, null);
        assert.equal(by('222222').parentMetaId, '111111');
        assert.equal(by('333333').parentMetaId, '222222');
        assert.equal(by('333333').creativeMetaId, '444444');
        assert.equal(by('444444').parentMetaId, null);
    });

    it('keeps the delivery state apart from the configured status, and the budgets in minor units', () => {
        assert.equal(by('222222').status, 'ACTIVE');
        assert.equal(by('222222').effectiveStatus, 'CAMPAIGN_PAUSED');
        assert.equal(by('111111').dailyBudgetMinor, 5000);
        assert.equal(by('222222').lifetimeBudgetMinor, 30000);
        assert.equal(by('111111').objective, 'OUTCOME_ENGAGEMENT');
        assert.equal(by('222222').optimizationGoal, 'CONVERSATIONS');
        assert.equal(by('222222').destinationType, 'INSTAGRAM_DIRECT');
    });

    it('stores review for the ad (issues, feedback) and the ad set (learning), and not the children inside a parent\'s raw', () => {
        assert.deepEqual((by('333333').review as any).issues_info, [{ error_summary: 'Ad disapproved', error_message: 'long text' }]);
        assert.deepEqual((by('222222').review as any).learning_stage_info, { status: 'LEARNING', attributed_to: 'x' });
        assert.equal(by('111111').review, null);
        assert.equal('adsets' in by('111111').raw, false);
        assert.equal('ads' in by('222222').raw, false);
        assert.equal('creative' in by('333333').raw, true);
    });

    it('summarises targeting for display only', () => {
        assert.deepEqual(by('222222').targetingSummary, { countries: ['SA', 'AE'], age_min: 25, age_max: 45, genders: ['male'], locales: [28], placements: 'automatic' });
        assert.deepEqual(summariseTargeting({ publisher_platforms: ['instagram'], instagram_positions: ['reels'] })?.['placements'], ['instagram', 'instagram_reels']);
        assert.equal(summariseTargeting(null), null);
    });
});

describe('structureIsComplete', () => {
    it('is true for a whole answer and false when a nested edge has a next page', () => {
        assert.equal(structureIsComplete([campaignsPage()]), true);
        assert.equal(structureIsComplete([campaignsPage({ adsetsNext: true })]), false);
        assert.equal(structureIsComplete([campaignsPage({ adsNext: true })]), false);
    });
});

describe('dayInTz', () => {
    it('is the calendar day of the ad account, not UTC\'s', () => {
        const late = new Date('2026-10-22T22:30:00Z');
        assert.equal(dayInTz(late, 'UTC'), '2026-10-22');
        assert.equal(dayInTz(late, 'Asia/Baghdad'), '2026-10-23');
        assert.equal(dayInTz(late, 'America/Los_Angeles'), '2026-10-22');
        assert.equal(dayInTz(late, 'Not/AZone'), '2026-10-22');
    });
});

describe('parseInsightRows', () => {
    const opts = { creatorId: C, currency: 'USD', tz: 'Asia/Baghdad', today: new Date('2026-10-22T22:30:00Z'), level: 'ad' as const };
    const row = (day: string, over: Record<string, unknown> = {}) => ({
        ad_id: '333333', date_start: day, date_stop: day, spend: '12.345', impressions: '1000', reach: '800', clicks: '50', inline_link_clicks: '30',
        actions: [action('onsite_conversion.messaging_conversation_started_7d', '4'), action('onsite_conversion.messaging_first_reply', '3'), action('lead', '2'),
            action('onsite_conversion.lead_grouped', '2'), action('post_engagement', '9')],
        video_play_actions: [action('video_view', '77')], ...over,
    });

    it('maps the actions, keeps Meta\'s day (already the account\'s) and money in major units', () => {
        const [r] = parseInsightRows([row('2026-10-23')], opts);
        assert.equal(r!.day, '2026-10-23');
        assert.equal(r!.metaId, '333333');
        assert.equal(r!.spend, 12.35);
        assert.equal(r!.conversationsStarted, 4);
        assert.equal(r!.firstReplies, 3);
        assert.equal(r!.leads, 2, 'lead and lead_grouped are alternatives, not parts');
        assert.equal(r!.linkClicks, 30);
        assert.equal(r!.videoViews, 77);
        assert.equal(r!.follows, null);
        assert.equal(r!.attribution, '7d_click,1d_view');
        assert.equal(r!.currency, 'USD');
        assert.equal((r!.actions as unknown[]).length, 5);
    });

    it('marks the last 3 days of the account\'s today provisional (today is 2026-10-23 in Riyadh), and not the 4th', () => {
        const days = ['2026-10-23', '2026-10-22', '2026-10-21', '2026-10-20', '2026-10-01'];
        const out = parseInsightRows(days.map((d) => row(d)), opts);
        assert.deepEqual(out.map((r) => r.provisional), [true, true, true, false, false]);
    });

    it('keeps each day\'s reach as Meta gave it (it is never summed here or later)', () => {
        const out = parseInsightRows([row('2026-10-21', { reach: '500' }), row('2026-10-22', { reach: '600' })], opts);
        assert.deepEqual(out.map((r) => r.reach), [500, 600]);
    });

    it('takes an account row\'s object from the ad account id and drops rows without their id or day', () => {
        const acct = parseInsightRows([{ date_start: '2026-10-22', spend: '3', reach: '9' }, { date_start: '2026-10-22', spend: '1' }], { ...opts, level: 'account', accountId: ACCOUNT });
        assert.equal(acct.length, 2);
        assert.equal(acct[0]!.metaId, ACCOUNT);
        assert.equal(parseInsightRows([{ date_start: '2026-10-22' }, { ad_id: '1' }], opts).length, 0);
    });
});

describe('parseBreakdownRows', () => {
    const base = { creatorId: C, currency: 'USD', tz: 'UTC', today: NOW, level: 'ad' as const };
    it('keys by ISO country, or by publisher_platform:platform_position', () => {
        const country = parseBreakdownRows([{ ad_id: '1', date_start: '2026-10-22', country: 'SA', spend: '5', impressions: '10', clicks: '2', inline_link_clicks: '1',
            actions: [action('onsite_conversion.messaging_conversation_started_7d', '2')] }], { ...base, breakdown: 'country' });
        assert.equal(country[0]!.key, 'SA');
        assert.equal(country[0]!.breakdown, 'country');
        assert.equal(country[0]!.conversationsStarted, 2);
        assert.equal(country[0]!.provisional, true);
        const place = parseBreakdownRows([{ ad_id: '1', date_start: '2026-10-01', publisher_platform: 'instagram', platform_position: 'reels', spend: '1' }, { ad_id: '1', date_start: '2026-10-01', spend: '1' }], { ...base, breakdown: 'placement' });
        assert.equal(place.length, 1, 'a row without its placement is dropped');
        assert.equal(place[0]!.key, 'instagram:reels');
        assert.equal(place[0]!.provisional, false);
    });
});

// ─── The structure sync ─────────────────────────────────────────────────────────────────────

describe('syncStructure', () => {
    beforeEach(() => {
        w.get = (path) => (path === `act_${ACCOUNT}` ? { currency: 'USD', timezone_name: 'Asia/Baghdad' } : campaignsPage());
    });

    it('upserts every object, parents first, with the parent ids, delivery state, review, money in major units and a boost origin by name', async () => {
        const r = await syncStructure(C, {}, w.deps);
        assert.equal(r.complete, true);
        const inserts = w.sql(/^INSERT INTO ads_objects/);
        assert.deepEqual(inserts.map((s) => `${s.params[2]}:${s.params[3]}`), ['campaign:111111', 'adset:222222', 'creative:444444', 'ad:333333', 'ad:333334']);
        const byMeta = (id: string) => inserts.find((s) => s.params[3] === id)!.params;
        assert.equal(byMeta('222222')[4], uuidFor('111111'), 'ad set → campaign row');
        assert.equal(byMeta('333333')[4], uuidFor('222222'), 'ad → ad set row');
        assert.equal(byMeta('444444')[4], null);
        assert.equal(byMeta('333333')[8], 'DISAPPROVED');
        assert.equal(byMeta('222222')[7], 'ACTIVE');
        assert.equal(byMeta('111111')[12], 'daily');
        assert.equal(byMeta('111111')[13], 50);
        assert.equal(byMeta('222222')[12], 'lifetime');
        assert.equal(byMeta('222222')[13], 300);
        assert.equal(JSON.parse(byMeta('333333')[18]).issues_info[0].error_summary, 'Ad disapproved');
        assert.equal(JSON.parse(byMeta('222222')[18]).learning_stage_info.status, 'LEARNING');
        assert.equal(byMeta('111111')[6], 'boost', 'the name carries a v1 boost id');
        assert.equal(JSON.parse(byMeta('111111')[19]).boost_id, '7f9c2a10-0000-4000-8000-000000000001');
        assert.equal(byMeta('222222')[6], 'meta');
        assert.equal(JSON.parse(byMeta('333333')[19]).creative_id, '444444');
        assert.equal(byMeta('222222')[14], 'USD');
    });

    it('asks Meta once for the campaigns with the nested fields, then records itself done', async () => {
        await syncStructure(C, {}, w.deps);
        const g = graphCalls(w);
        assert.equal(g.length, 1);
        assert.equal(g[0]!.path, `act_${ACCOUNT}/campaigns`);
        assert.match(String(g[0]!.params['fields']), /adsets\.limit\(50\)\{.*ads\.limit\(50\)\{.*creative\{id,object_story_id/);
        assert.ok(stateOf(w).structureAt);
        assert.equal(stateOf(w).account.tz, 'Asia/Baghdad');
    });

    it('follows paging.next by its cursor and reads every page before marking deletions', async () => {
        let page = 0;
        w.get = (path, params) => {
            if (path === `act_${ACCOUNT}`) return { currency: 'USD', timezone_name: 'Asia/Baghdad' };
            page++;
            if (page === 1) return campaignsPage({ next: 'CUR1' });
            assert.equal(params['after'], 'CUR1');
            return { data: [] };
        };
        const r = await syncStructure(C, {}, w.deps);
        assert.equal(graphCalls(w).length, 2);
        assert.equal(r.complete, true);
        assert.equal(w.sql(/FROM ads_objects WHERE creator_id = \$1 AND ad_account_id/).length, 1);
    });

    it('marks a row missing once as 1 and does not delete it', async () => {
        w.missingRows = [{ id: uuidFor('555555'), missing: null }];
        await syncStructure(C, {}, w.deps);
        const [select] = w.sql(/^SELECT id, app_meta->>'sync_missing'/);
        assert.deepEqual(select!.params.slice(0, 2), [C, ACCOUNT]);
        assert.deepEqual(select!.params[2], ['campaign', 'adset', 'ad'], 'creatives are never marked: an unused one is not listed');
        assert.ok(select!.params[3].includes('111111') && select!.params[3].includes('333333'), 'the ids seen are passed');
        assert.equal(w.sql(/SET status = 'DELETED'/).length, 0);
        const counted = w.sql(/jsonb_set\(app_meta, '\{sync_missing\}', '1'::jsonb\)/);
        assert.equal(counted.length, 1);
        assert.deepEqual(counted[0]!.params, [[uuidFor('555555')], C]);
    });

    it('marks a row missing twice in a row DELETED (status and effective_status)', async () => {
        w.missingRows = [{ id: uuidFor('555555'), missing: '1' }];
        const r = await syncStructure(C, {}, w.deps);
        assert.equal(r.deleted, 1);
        const del = w.sql(/SET status = 'DELETED', effective_status = 'DELETED'/);
        assert.equal(del.length, 1);
        assert.deepEqual(del[0]!.params, [[uuidFor('555555')], [2], C]);
        assert.equal(w.sql(/'\{sync_missing\}', '1'::jsonb/).length, 0);
    });

    it('marks nothing missing when a nested edge was cut off or a page was not read', async () => {
        w.missingRows = [{ id: uuidFor('555555'), missing: '1' }];
        w.get = (path) => (path === `act_${ACCOUNT}` ? { currency: 'USD', timezone_name: 'Asia/Baghdad' } : campaignsPage({ adsetsNext: true }));
        const nested = await syncStructure(C, {}, w.deps);
        assert.equal(nested.complete, true, 'every page was read');
        assert.equal(w.sql(/^SELECT id, app_meta->>'sync_missing'/).length, 0, 'but a nested edge has more: no deletion marking');

        // A budget that runs out after the first of two pages (the account is already known, so the pacer is asked once per page).
        w.db.statements.length = 0;
        let served = 0;
        w.get = (path) => (path === `act_${ACCOUNT}` ? { currency: 'USD', timezone_name: 'Asia/Baghdad' } : (served++, campaignsPage({ next: 'CUR1' })));
        w.pacer = { scoreEstimate: 0, windowStartedAt: NOW, blockedUntil: null, tier: null, servedVersion: null, lastUsage: {} };
        const realPacer = w.deps.pacer;
        let asked = 0;
        w.deps.pacer = async (acct) => {
            asked++;
            return asked > 1 ? { ...w.pacer!, scoreEstimate: 45 } : realPacer(acct);
        };
        const cut = await syncStructure(C, {}, w.deps);
        assert.equal(cut.complete, false);
        assert.equal(cut.skipped, 'pacer');
        assert.equal(served, 1);
        assert.equal(w.sql(/^SELECT id, app_meta->>'sync_missing'/).length, 0);
        assert.equal(w.sql(/^INSERT INTO ads_objects/).length > 0, true, 'what was read is still stored');
    });

    it('respects the point budget: no Graph call when the pacer cannot spend, and none while Meta has the account blocked', async () => {
        w.pacer = { scoreEstimate: 45, windowStartedAt: NOW, blockedUntil: null, tier: null, servedVersion: null, lastUsage: {} };
        const full = await syncStructure(C, {}, w.deps);
        assert.equal(full.skipped, 'pacer');
        assert.equal(w.calls.length, 0);
        assert.ok(full.retryAt, 'it says when to try again');

        w.pacer = { scoreEstimate: 0, windowStartedAt: NOW, blockedUntil: new Date(NOW.getTime() + 60_000), tier: null, servedVersion: null, lastUsage: {} };
        const blocked = await syncStructure(C, {}, w.deps);
        assert.equal(blocked.skipped, 'pacer');
        assert.equal(w.calls.length, 0);
        assert.equal(w.sql(/^INSERT INTO ads_objects/).length, 0);
    });

    it('does nothing for a tenant without an ad account or token, and ends quietly on a throttle', async () => {
        w.settings.delete(`ads.token.${C}`);
        assert.equal((await syncStructure(C, {}, w.deps)).skipped, 'not_configured');
        assert.equal(w.calls.length, 0);

        w.settings.set(`ads.token.${C}`, 'EAAB-token-for-tests');
        w.get = (path) => {
            if (path === `act_${ACCOUNT}`) return { currency: 'USD', timezone_name: 'Asia/Baghdad' };
            throw new AdsGraphError('slow down', null, 'throttle', new Date(NOW.getTime() + 300_000), null, 400);
        };
        const r = await syncStructure(C, {}, w.deps);
        assert.equal(r.skipped, 'throttle');
        assert.equal(r.retryAt?.toISOString(), '2026-10-22T10:05:00.000Z');
    });

    it('stops before the deadline', async () => {
        const r = await syncStructure(C, { deadline: NOW.getTime() }, w.deps);
        assert.equal(r.skipped, 'deadline');
        assert.equal(w.calls.length, 0);
    });
});

// ─── The results sync ───────────────────────────────────────────────────────────────────────

describe('syncInsights', () => {
    const adRow = (day: string) => ({ ad_id: '333333', adset_id: '222222', campaign_id: '111111', date_start: day, spend: '10', impressions: '100', reach: '90', clicks: '5', inline_link_clicks: '4',
        actions: [action('onsite_conversion.messaging_conversation_started_7d', '1')] });

    function answer(rows: { ad: any[]; campaign?: any[]; account?: any[] }) {
        w.get = (path, params) => {
            if (path === `act_${ACCOUNT}`) return { currency: 'USD', timezone_name: 'Asia/Baghdad' };
            if (params['breakdowns']) return { data: [] };
            const level = params['level'];
            return { data: level === 'ad' ? rows.ad : level === 'campaign' ? (rows.campaign ?? []) : (rows.account ?? []) };
        };
    }
    const stored = (level: string) => w.sql(/^INSERT INTO ads_insights_daily/).flatMap((s) => JSON.parse(s.params[0])).filter((r: any) => r.level === level);

    it('today: ad rows per day in the account zone, then campaign and account reach/spend rows; the last 3 days provisional', async () => {
        w.clock.ms = new Date('2026-10-22T22:30:00Z').getTime(); // already the 23rd in Riyadh
        answer({
            ad: [adRow('2026-10-23'), adRow('2026-10-20')],
            campaign: [{ campaign_id: '111111', date_start: '2026-10-23', reach: '70', frequency: '1.2', spend: '10' }],
            account: [{ date_start: '2026-10-23', reach: '65', frequency: '1.3', spend: '10' }],
        });
        const r = await syncInsights(C, 'today', {}, w.deps);
        assert.equal(r.complete, true);
        const calls = graphCalls(w);
        assert.deepEqual(calls.map((c) => c.params['level']), ['ad', 'campaign', 'account']);
        assert.equal(calls[0]!.params['date_preset'], 'today');
        assert.equal(calls[0]!.params['time_increment'], '1');
        assert.match(String(calls[0]!.params['action_attribution_windows']), /7d_click.*1d_view/);
        assert.match(String(calls[1]!.params['fields']), /^campaign_id,reach,frequency,spend$/);

        const ads = stored('ad');
        assert.deepEqual(ads.map((a: any) => [a.day, a.provisional]), [['2026-10-23', true], ['2026-10-20', false]]);
        assert.equal(ads[0].conversations_started, 1);
        assert.equal(stored('campaign')[0].meta_id, '111111');
        assert.equal(stored('campaign')[0].reach, 70);
        assert.equal(stored('account')[0].meta_id, ACCOUNT);
        assert.equal(stored('account')[0].reach, 65, 'the account\'s own reach, not a sum of the ads\'');
        assert.ok(stateOf(w).todayAt);
    });

    it('spends no point and makes no call when the pacer cannot spend', async () => {
        w.settings.set(`ads.sync.${C}`, JSON.stringify({ account: { currency: 'USD', tz: 'Asia/Baghdad', at: NOW.toISOString() } }));
        w.pacer = { scoreEstimate: 44.5, windowStartedAt: NOW, blockedUntil: null, tier: null, servedVersion: null, lastUsage: {} };
        const r = await syncInsights(C, 'today', {}, w.deps);
        assert.equal(r.skipped, 'pacer');
        assert.equal(w.calls.length, 0);
        assert.equal(w.sql(/^INSERT INTO ads_insights_daily/).length, 0);
    });

    it('28 days: a time_range of 28 account days and the done time', async () => {
        answer({ ad: [adRow('2026-10-21')] });
        const seen: Record<string, string>[] = [];
        const base = w.get;
        w.get = (path, params) => {
            seen.push(params);
            return base(path, params);
        };
        const r = await syncInsights(C, '28d', {}, w.deps);
        assert.equal(r.complete, true);
        const range = JSON.parse(seen.find((p) => p['level'] === 'ad' && !p['breakdowns'])!['time_range']!);
        assert.deepEqual(range, { since: '2026-09-25', until: '2026-10-22' });
        assert.ok(stateOf(w).dailyAt);
    });

    it('28 days: reads the ads by country and by placement, and upserts both with their keys and the 3-day provisional rule', async () => {
        answer({ ad: [adRow('2026-10-21')] });
        const seen: Record<string, string>[] = [];
        const base = w.get;
        w.get = (path, params) => {
            if (params['breakdowns']) seen.push({ path, ...params });
            if (params['breakdowns'] === 'country') {
                return { data: [
                    { ad_id: '333333', date_start: '2026-10-20', country: 'EG', spend: '4', impressions: '40', clicks: '3', inline_link_clicks: '2',
                      actions: [action('onsite_conversion.messaging_conversation_started_7d', '1')] },
                    { ad_id: '333333', date_start: '2026-10-19', country: 'EG', spend: '5', impressions: '50' },
                ] };
            }
            if (params['breakdowns']) {
                return { data: [
                    { ad_id: '333333', date_start: '2026-10-21', publisher_platform: 'instagram', platform_position: 'reels', spend: '6' },
                    { ad_id: '333333', date_start: '2026-10-18', publisher_platform: 'instagram', platform_position: 'reels', spend: '7' },
                ] };
            }
            return base(path, params);
        };
        const r = await syncInsights(C, '28d', {}, w.deps);
        assert.equal(r.complete, true);

        assert.deepEqual(seen.map((p) => p['breakdowns']), ['country', 'publisher_platform,platform_position']);
        for (const p of seen) {
            assert.equal(p['path'], `act_${ACCOUNT}/insights`);
            assert.equal(p['level'], 'ad');
            assert.equal(p['time_increment'], '1');
            assert.deepEqual(JSON.parse(p['time_range']!), { since: '2026-09-25', until: '2026-10-22' });
        }

        const upserts = w.sql(/^INSERT INTO ads_insights_breakdown/);
        assert.equal(upserts.length, 2, 'one statement per breakdown read');
        assert.match(upserts[0]!.sql, /ON CONFLICT \(creator_id, level, meta_id, day, breakdown, key\)/);
        const rows = upserts.flatMap((s) => JSON.parse(s.params[0]));
        assert.deepEqual(
            rows.map((x: any) => [x.creator_id, x.level, x.meta_id, x.day, x.breakdown, x.key, x.provisional]),
            [
                [C, 'ad', '333333', '2026-10-20', 'country', 'EG', true],
                [C, 'ad', '333333', '2026-10-19', 'country', 'EG', false],
                [C, 'ad', '333333', '2026-10-21', 'placement', 'instagram:reels', true],
                [C, 'ad', '333333', '2026-10-18', 'placement', 'instagram:reels', false],
            ],
            'the last 3 account days (22, 21, 20) are provisional'
        );
        assert.deepEqual([rows[0].spend, rows[0].impressions, rows[0].clicks, rows[0].link_clicks, rows[0].conversations_started, rows[0].currency], [4, 40, 3, 2, 1, 'USD']);
        assert.equal(r.stored >= 4 + 1, true, 'the breakdown rows are counted in what was stored');
    });

    it('today: no breakdown is read (they are the daily job\'s)', async () => {
        answer({ ad: [adRow('2026-10-22')] });
        const r = await syncInsights(C, 'today', {}, w.deps);
        assert.equal(r.complete, true);
        assert.equal(graphCalls(w).filter((c) => c.params['breakdowns']).length, 0);
        assert.equal(w.sql(/^INSERT INTO ads_insights_breakdown/).length, 0);
    });

    it('28 days: a table that does not exist yet (42P01) costs nothing more than one skipped write, and the sync still completes', async () => {
        answer({ ad: [adRow('2026-10-21')] });
        const base = w.get;
        w.get = (path, params) => (params['breakdowns'] ? { data: [{ ad_id: '333333', date_start: '2026-10-21', country: 'SA', spend: '4' }] } : base(path, params));
        w.db.routes.unshift([/^INSERT INTO ads_insights_breakdown/, () => { throw Object.assign(new Error('relation "ads_insights_breakdown" does not exist'), { code: '42P01' }); }]);
        const r = await syncInsights(C, '28d', {}, w.deps);
        assert.equal(r.complete, true);
        assert.equal(graphCalls(w).filter((c) => c.params['breakdowns']).length, 1, 'the placement read is skipped once the table is known to be missing');
        assert.ok(stateOf(w).dailyAt);

        w.calls.length = 0;
        await syncInsights(C, '28d', {}, w.deps);
        assert.equal(graphCalls(w).filter((c) => c.params['breakdowns']).length, 0, 'and later runs do not read breakdowns at all');
    });

    describe('the async report for a long range', () => {
        const page = (rows: any[], next?: string) => ({ data: rows, ...(next ? { paging: { next: 'https://graph/n', cursors: { after: next } } } : {}) });

        it('more than 2 pages: POST the report, poll until it completed, read its rows, forget the run id', async () => {
            let adPages = 0;
            let polls = 0;
            w.get = (path, params) => {
                if (path === `act_${ACCOUNT}`) return { currency: 'USD', timezone_name: 'Asia/Baghdad' };
                if (path === 'RUN1') { polls++; return { async_status: polls < 3 ? 'Job Running' : 'Job Completed' }; }
                if (path === 'RUN1/insights') return page([adRow('2026-10-19')]);
                if (params['breakdowns'] || params['level'] !== 'ad') return { data: [] };
                adPages++;
                return page([adRow('2026-10-21')], `P${adPages}`);
            };
            w.post = () => ({ report_run_id: 'RUN1' });
            const r = await syncInsights(C, '28d', {}, w.deps);
            assert.equal(adPages, 2, 'two pages are read directly');
            assert.equal(w.calls.filter((c) => c.kind === 'post').length, 1);
            assert.equal(w.calls.find((c) => c.kind === 'post')!.params['limit'], undefined);
            assert.equal(polls, 3);
            assert.equal(r.complete, true);
            assert.equal(stored('ad').some((a: any) => a.day === '2026-10-19'), true);
            assert.equal(stateOf(w).pendingReportRunId, null);
        });

        it('not done by the deadline: the run id is stored, and the next run resumes it instead of posting another', async () => {
            let status = 'Job Running';
            let adPages = 0;
            w.get = (path, params) => {
                if (path === `act_${ACCOUNT}`) return { currency: 'USD', timezone_name: 'Asia/Baghdad' };
                if (path === 'RUN2') return { async_status: status };
                if (path === 'RUN2/insights') return page([adRow('2026-10-19')]);
                if (params['breakdowns'] || params['level'] !== 'ad') return { data: [] };
                adPages++;
                return page([adRow('2026-10-21')], `MORE${adPages}`); // a cursor that moves on, or the read would stop at the repeat
            };
            w.post = () => ({ report_run_id: 'RUN2' });
            const first = await syncInsights(C, '28d', { deadline: NOW.getTime() + 8_000 }, w.deps);
            assert.equal(first.complete, false);
            assert.equal(first.reportPending, true);
            assert.equal(stateOf(w).pendingReportRunId, 'RUN2');

            w.calls.length = 0;
            status = 'Job Completed';
            const second = await syncInsights(C, '28d', {}, w.deps);
            assert.equal(second.complete, true);
            assert.equal(w.calls.filter((c) => c.kind === 'post').length, 0, 'no second report');
            assert.ok(w.calls.some((c) => c.path === 'RUN2/insights'));
            assert.equal(stateOf(w).pendingReportRunId, null);
        });
    });
});

// ─── A manual refresh ───────────────────────────────────────────────────────────────────────

describe('requestTodaySync', () => {
    it('queues once, then answers retryAt for 15 minutes counted from the request or the last today-sync', async () => {
        const first = await requestTodaySync(C, NOW);
        assert.deepEqual(first, { queued: true, notBefore: NOW.toISOString() });
        const again = await requestTodaySync(C, new Date(NOW.getTime() + 5 * 60_000));
        assert.deepEqual(again, { queued: false, retryAt: '2026-10-22T10:15:00.000Z' });
        assert.deepEqual(await requestTodaySync(C, new Date(NOW.getTime() + 15 * 60_000)), { queued: true, notBefore: '2026-10-22T10:15:00.000Z' });

        w.settings.set(`ads.sync.${C}`, JSON.stringify({ todayAt: new Date(NOW.getTime() - 60_000).toISOString() }));
        assert.equal((await requestTodaySync(C, NOW)).queued, false);
    });
});

// ─── The drain and the cron ─────────────────────────────────────────────────────────────────

describe('syncAllAds', () => {
    const deadline = () => NOW.getTime() + 60_000;
    const account = { currency: 'USD', tz: 'Asia/Baghdad', at: NOW.toISOString() };
    const emptyAnswer = () => {
        w.get = (path) => (path === `act_${ACCOUNT}/campaigns` ? campaignsPage() : path === `act_${ACCOUNT}` ? { currency: 'USD', timezone_name: 'Asia/Baghdad' } : { data: [] });
    };

    it('syncs structure and today for a tenant that has never synced, and records both', async () => {
        emptyAnswer();
        const s = await syncAllAds(deadline(), w.deps);
        assert.deepEqual({ tenants: s.tenants, structure: s.structure, today: s.today, failed: s.failed }, { tenants: 1, structure: 1, today: 1, failed: 0 });
        assert.ok(stateOf(w).structureAt);
        assert.ok(stateOf(w).todayAt);
    });

    it('leaves a tenant alone when the structure is under an hour old and today\'s results under 4 hours', async () => {
        w.settings.set(`ads.sync.${C}`, JSON.stringify({ structureAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(), todayAt: new Date(NOW.getTime() - 3_600_000).toISOString(), account }));
        emptyAnswer();
        await syncAllAds(deadline(), w.deps);
        assert.equal(w.calls.length, 0);
    });

    it('reads today\'s results ahead of the schedule when a manual refresh is pending', async () => {
        const fresh = new Date(NOW.getTime() - 30 * 60_000).toISOString();
        w.settings.set(`ads.sync.${C}`, JSON.stringify({ structureAt: fresh, todayAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(), todayRequestedAt: new Date(NOW.getTime() - 60_000).toISOString(), account }));
        emptyAnswer();
        const s = await syncAllAds(deadline(), w.deps);
        assert.equal(s.today, 1);
        assert.equal(graphCalls(w)[0]!.params['date_preset'], 'today');
    });

    it('skips a tenant whose ads are switched off, and does not call Meta when the pacer cannot spend', async () => {
        w.settings.set(`ads.enabled.${C}`, 'false');
        // The route answers the platform switch; a `false` row is not listed by the query's value filter.
        w.db.routes.unshift([/^SELECT key FROM app_settings WHERE key LIKE 'ads.enabled/, () => ({ rows: [] })]);
        assert.equal((await syncAllAds(deadline(), w.deps)).tenants, 0);

        w.db.routes.shift();
        w.settings.set(`ads.enabled.${C}`, 'true');
        w.pacer = { scoreEstimate: 0, windowStartedAt: NOW, blockedUntil: new Date(NOW.getTime() + 60_000), tier: null, servedVersion: null, lastUsage: {} };
        const s = await syncAllAds(deadline(), w.deps);
        assert.equal(s.skipped, 1);
        assert.equal(w.calls.length, 0);
    });

    it('never throws: a tenant that fails is counted and logged, not raised', async () => {
        w.settings.set(`ads.sync.${C}`, JSON.stringify({ account }));
        w.get = () => { throw new Error('boom'); };
        const s = await syncAllAds(deadline(), w.deps);
        assert.equal(s.failed, 1);
        assert.equal(s.tenants, 1);
        assert.equal(stateOf(w).structureAt ?? null, null, 'a failed run does not record itself as done');
    });

    it('an ad account Meta will not describe is skipped, not failed: the next run asks again', async () => {
        w.get = () => { throw new Error('boom'); };
        const s = await syncAllAds(deadline(), w.deps);
        assert.deepEqual({ failed: s.failed, skipped: s.skipped, structure: s.structure }, { failed: 0, skipped: 1, structure: 0 });
    });

    it('stops before the deadline', async () => {
        emptyAnswer();
        const s = await syncAllAds(NOW.getTime(), w.deps);
        assert.equal(s.tenants, 0);
        assert.equal(w.calls.length, 0);
    });

    it('syncDailyAds reads the 28 days once a day and skips a tenant done in the last 20 hours', async () => {
        emptyAnswer();
        const first = await syncDailyAds(deadline(), w.deps);
        assert.equal(first.daily, 1);
        w.calls.length = 0;
        const again = await syncDailyAds(deadline(), w.deps);
        assert.equal(again.daily, 0);
        assert.equal(w.calls.length, 0);
    });
});

// ─── Isolation ──────────────────────────────────────────────────────────────────────────────

describe('tenant isolation', () => {
    it('every statement that touches an ads table (but the pacer) names creator_id', async () => {
        w.get = (path, params) => {
            if (path === `act_${ACCOUNT}`) return { currency: 'USD', timezone_name: 'Asia/Baghdad' };
            if (path.endsWith('/campaigns')) return campaignsPage();
            return { data: params['level'] === 'ad' ? [{ ad_id: '333333', date_start: '2026-10-22', spend: '1' }] : [] };
        };
        w.missingRows = [{ id: uuidFor('1'), missing: null }, { id: uuidFor('2'), missing: '1' }];
        await syncStructure(C, {}, w.deps);
        await syncInsights(C, '28d', {}, w.deps);
        const touching = w.db.statements.filter((s) => /\bads_(objects|insights_daily|insights_breakdown|ops|alerts)\b/.test(s.sql));
        assert.ok(touching.length >= 6);
        for (const s of touching) assert.match(s.sql, /creator_id/, s.sql.slice(0, 80));
    });
});
