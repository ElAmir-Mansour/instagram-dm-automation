/**
 * `GET /api/ads/results` (A6, Results history): what the Results tab reads. Postgres only, never Meta, never a sum across currencies.
 *
 * The handler is pulled off `adsResultsRouter`'s stack and run against a stubbed pool, like growth.test.ts: each statement is matched
 * by a regex on its flattened SQL and answered with the fake rows arranged for the test. Meta is a stubbed `metaHttp` that throws.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import { adsResultsRouter } from './adsResults.js';
import { resultKindOf } from '../services/ads/results.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

type Rows = { rows: any[]; rowCount?: number };
let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows | Promise<Rows>][] = [];
let metaCalls: string[] = [];
const original = { query: pool.query, connect: pool.connect, post: metaHttp.post, get: metaHttp.get };

beforeEach(() => {
    statements = [];
    routes = [];
    metaCalls = [];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? await route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as any).query = run;
    (pool as any).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).post = async (url: string) => { metaCalls.push(url); throw new Error(`no Meta POST arranged for ${url}`); };
    (metaHttp as any).get = async (url: string) => { metaCalls.push(url); throw new Error(`no Meta GET arranged for ${url}`); };
});

afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
    (metaHttp as any).post = original.post;
    (metaHttp as any).get = original.get;
});

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: any }

function handlerFor(router: unknown, method: string, path: string): Function {
    const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.at(-1)!.handle;
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

async function get(query: Record<string, unknown> = {}) {
    const res = fakeRes();
    await handlerFor(adsResultsRouter, 'get', '/results')(
        { params: {}, query, headers: {}, body: {}, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, tenantRole: 'viewer' },
        res, () => {}
    );
    return res;
}

// ─── Fixtures: one campaign with two ad sets (conversations / link clicks), a second campaign (leads) ──────────────────────

const objects = [
    { id: 'app-camp1', meta_id: 'camp1', level: 'campaign', parent_id: null, name: 'Spring offers', effective_status: 'ACTIVE', objective: 'OUTCOME_ENGAGEMENT', optimization_goal: null, destination_type: null, currency: 'EGP' },
    { id: 'app-set1', meta_id: 'set1', level: 'adset', parent_id: 'app-camp1', name: 'DM set', effective_status: 'ACTIVE', objective: null, optimization_goal: 'CONVERSATIONS', destination_type: 'INSTAGRAM_DIRECT', currency: 'EGP' },
    { id: 'app-set2', meta_id: 'set2', level: 'adset', parent_id: 'app-camp1', name: 'Traffic set', effective_status: 'ACTIVE', objective: null, optimization_goal: 'LINK_CLICKS', destination_type: 'WEBSITE', currency: 'EGP' },
    { id: 'app-ad1', meta_id: 'ad1', level: 'ad', parent_id: 'app-set1', name: 'Ad one', effective_status: 'ACTIVE', objective: null, optimization_goal: null, destination_type: null, currency: 'EGP' },
    { id: 'app-ad2', meta_id: 'ad2', level: 'ad', parent_id: 'app-set2', name: 'Ad two', effective_status: 'PAUSED', objective: null, optimization_goal: null, destination_type: null, currency: 'EGP' },
    { id: 'app-camp2', meta_id: 'camp2', level: 'campaign', parent_id: null, name: 'Leads', effective_status: 'ACTIVE', objective: 'OUTCOME_LEADS', optimization_goal: null, destination_type: null, currency: 'USD' },
    { id: 'app-set3', meta_id: 'set3', level: 'adset', parent_id: 'app-camp2', name: 'Lead set', effective_status: 'ACTIVE', objective: null, optimization_goal: 'LEAD_GENERATION', destination_type: null, currency: 'USD' },
    { id: 'app-ad3', meta_id: 'ad3', level: 'ad', parent_id: 'app-set3', name: 'Ad three', effective_status: 'ACTIVE', objective: null, optimization_goal: null, destination_type: null, currency: 'USD' },
];

const SYNCED = new Date('2026-10-04T06:00:00Z');
function daily(meta_id: string, day: string, over: Record<string, unknown> = {}) {
    return {
        meta_id, day, currency: 'EGP', spend: 0, impressions: 0, reach: null, clicks: 0, link_clicks: 0, conversations_started: 0,
        first_replies: 0, leads: 0, follows: null, provisional: false, synced_at: SYNCED, ...over,
    };
}

const EGP_ROWS = [
    daily('ad1', '2026-10-01', { spend: 10, impressions: 1000, reach: 800, clicks: 50, link_clicks: 30, conversations_started: 5, first_replies: 4, leads: 1 }),
    daily('ad1', '2026-10-02', { spend: 12.5, impressions: 1200, reach: 900, clicks: 60, link_clicks: 35, conversations_started: 6, first_replies: 5 }),
    daily('ad2', '2026-10-01', { spend: 6, impressions: 500, reach: 400, clicks: 25, link_clicks: 20, conversations_started: 1 }),
];
const USD_ROW = daily('ad3', '2026-10-02', { currency: 'USD', spend: 4, impressions: 300, clicks: 9, link_clicks: 7, leads: 2, provisional: true });

interface Arrange {
    daily?: any[]; reach?: any[]; breakdown?: any[]; direct?: any[]; viaChat?: any[]; handoffs?: any[]; latest?: string | null; settings?: unknown;
}
function arrange(a: Arrange = {}) {
    const rows = a.daily ?? [...EGP_ROWS];
    routes.push(
        [/FROM app_settings/, () => ({ rows: a.settings === undefined ? [] : [{ value: JSON.stringify(a.settings), is_secret: false }] })],
        [/MAX\(day\)/, () => ({ rows: [{ latest: a.latest === undefined ? '2026-10-02' : a.latest }] })],
        [/FROM ads_objects/, () => ({ rows: objects })],
        [/FROM ads_insights_daily WHERE creator_id = \$1 AND level = 'ad'/, () => ({ rows })],
        [/FROM ads_insights_daily WHERE creator_id = \$1 AND level = \$2/, () => ({ rows: a.reach ?? [] })],
        [/FROM ads_insights_breakdown/, () => ({ rows: a.breakdown ?? [] })],
        [/tl\.ads_object_id = ANY/, () => ({ rows: a.direct ?? [] })],
        [/JOIN conversations c/, () => ({ rows: a.viaChat ?? [] })],
        [/^SELECT .* FROM conversations c/, () => ({ rows: a.handoffs ?? [] })],
    );
}

const RANGE = { from: '2026-10-01', to: '2026-10-02' };

// ─── The route ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /api/ads/results', () => {
    it('is behind the viewer role and reads Postgres only', async () => {
        const guard = (adsResultsRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === '/results')!.route!.stack[0]!;
        assert.equal((guard.handle as unknown as { minimumRole: string }).minimumRole, 'viewer');
        arrange({ daily: [...EGP_ROWS, USD_ROW], settings: { account: { timezone: 'Africa/Cairo' } } });
        const res = await get({ ...RANGE, breakdown: 'country' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(metaCalls, [], 'no Meta HTTP call, ever');
    });

    it('every statement is parameterised and carries the creator id', async () => {
        arrange({ daily: [...EGP_ROWS, USD_ROW] });
        for (const level of ['account', 'campaign', 'adset', 'ad']) await get({ level, ...RANGE, breakdown: 'placement', ids: 'ad1' });
        assert.ok(statements.length > 10);
        for (const s of statements) {
            assert.ok(!/\bad1\b|camp1|set1/.test(s.sql), `no value is spliced into SQL: ${s.sql}`);
            assert.ok(s.params.some((p) => typeof p === 'string' && p.includes(TENANT)), `creator id is bound: ${s.sql}`);
            if (!/FROM app_settings/.test(s.sql)) {
                assert.equal(s.params[0], TENANT, `creator id is $1: ${s.sql}`);
                assert.match(s.sql, /creator_id = \$1|tl\.creator_id = \$1/, s.sql);
            }
        }
    });

    it('level=ad: one row per ad per day, with its own reach, name and result kind', async () => {
        arrange();
        const res = await get({ level: 'ad', ...RANGE });
        assert.equal(res.statusCode, 200);
        const b = res.body;
        assert.equal(b.level, 'ad');
        assert.equal(b.breakdown, null);
        assert.equal(b.excludesTax, true);
        assert.deepEqual([b.from, b.to], ['2026-10-01', '2026-10-02']);
        assert.equal(b.rows.length, 3);
        const r = b.rows.find((x: any) => x.id === 'ad1' && x.day === '2026-10-01');
        assert.deepEqual(r, {
            day: '2026-10-01', id: 'ad1', key: null, currency: 'EGP', spend: 10, impressions: 1000, reach: 800, clicks: 50, linkClicks: 30,
            conversations: 5, firstReplies: 4, leads: 1, follows: null, results: 5, provisional: false,
        });
        assert.equal(b.rows.find((x: any) => x.id === 'ad2').results, 20, 'ad two optimises for link clicks');
        const ad2 = b.objects.find((o: any) => o.id === 'ad2');
        assert.deepEqual(ad2, { id: 'ad2', appId: 'app-ad2', level: 'ad', name: 'Ad two', effectiveStatus: 'PAUSED', resultKind: 'link_clicks' });
        assert.equal(b.currency, 'EGP');
        assert.deepEqual(b.currencies, ['EGP']);
        assert.equal(b.syncedAt, SYNCED.toISOString());
        assert.equal(b.provisionalFrom, null);
    });

    it('level=campaign: rolls the ads up through their ad sets, summing each ad’s own result metric; reach is null without an own-level row', async () => {
        arrange();
        const res = await get({ level: 'campaign', ...RANGE });
        const b = res.body;
        assert.deepEqual(b.rows.map((r: any) => [r.day, r.id]), [['2026-10-01', 'camp1'], ['2026-10-02', 'camp1']]);
        const d1 = b.rows[0];
        assert.equal(d1.spend, 16);
        assert.equal(d1.linkClicks, 50);
        assert.equal(d1.conversations, 6);
        assert.equal(d1.results, 5 + 20, 'ad one counts conversations, ad two counts link clicks');
        assert.equal(d1.reach, null, 'reach is not additive');
        const camp = b.objects.find((o: any) => o.id === 'camp1');
        assert.equal(camp.name, 'Spring offers');
        assert.equal(camp.resultKind, 'conversations', 'OUTCOME_ENGAGEMENT');
    });

    it('level=adset rolls up to the ad set; level=account to the one account id', async () => {
        arrange();
        const sets = (await get({ level: 'adset', ...RANGE })).body;
        assert.deepEqual([...new Set(sets.rows.map((r: any) => r.id))].sort(), ['set1', 'set2']);
        assert.equal(sets.objects.find((o: any) => o.id === 'set2').resultKind, 'link_clicks');
        const acct = (await get({ level: 'account', ...RANGE })).body;
        assert.deepEqual([...new Set(acct.rows.map((r: any) => r.id))], ['account']);
        assert.equal(acct.rows.find((r: any) => r.day === '2026-10-01').spend, 16);
        assert.equal(acct.rows.find((r: any) => r.day === '2026-10-02').spend, 12.5);
    });

    it('level defaults to account', async () => {
        arrange();
        const res = await get(RANGE);
        assert.equal(res.body.level, 'account');
    });

    it('reach comes only from an own-level row', async () => {
        arrange({ reach: [{ meta_id: 'camp1', day: '2026-10-01', reach: 1100, synced_at: SYNCED }] });
        const res = await get({ level: 'campaign', ...RANGE });
        assert.equal(res.body.rows.find((r: any) => r.day === '2026-10-01').reach, 1100);
        assert.equal(res.body.rows.find((r: any) => r.day === '2026-10-02').reach, null);
        const ads = await get({ level: 'ad', ...RANGE });
        assert.equal(ads.body.rows.find((r: any) => r.id === 'ad1' && r.day === '2026-10-02').reach, 900);
    });

    it('ids filter: only the named objects at that level, whatever their ads', async () => {
        arrange();
        const res = await get({ level: 'adset', ids: 'set2', ...RANGE });
        assert.deepEqual(res.body.rows.map((r: any) => r.id), ['set2']);
        assert.deepEqual(res.body.objects.map((o: any) => o.id), ['set2']);
        assert.equal(res.body.totals.byCurrency.EGP.spend, 6);
        const ad = await get({ level: 'ad', ids: 'ad1,ad2', ...RANGE });
        assert.equal(ad.body.rows.length, 3);
        const sql = statements.find((s) => /FROM ads_insights_daily WHERE creator_id = \$1 AND level = 'ad'/.test(s.sql) && s.params.some((p) => Array.isArray(p)));
        assert.ok(sql, 'an ad-level id filter is applied in SQL');
        assert.deepEqual(sql!.params.find((p) => Array.isArray(p)), ['ad1', 'ad2']);
    });

    it('cost per figures are spend / count to two places, null on zero', async () => {
        arrange();
        const b = (await get({ level: 'account', ...RANGE })).body;
        const t = b.totals.byCurrency.EGP;
        assert.equal(t.spend, 28.5);
        assert.equal(t.conversations, 12);
        assert.equal(t.linkClicks, 85);
        assert.equal(t.costPerConversation, 2.38);
        assert.equal(t.costPerLinkClick, 0.34);
        assert.equal(t.results, 5 + 6 + 20);
        assert.equal(t.costPerResult, 0.92);
        assert.equal(t.costPerFollow, null, 'Meta reported no follows');
        assert.equal(t.follows, null);
        assert.equal(t.costPerTrackedClick, null, 'no tracked clicks, no cost');
        assert.equal(t.costPerLead, 28.5, 'one lead');
    });
});

// ─── Range ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('range defaults and validation', () => {
    it('defaults to the 28 days ending on the latest stored day', async () => {
        arrange({ latest: '2026-10-02' });
        const res = await get({});
        assert.deepEqual([res.body.from, res.body.to], ['2026-09-05', '2026-10-02']);
    });

    it('defaults to the 28 days ending today (UTC) when nothing is stored', async () => {
        arrange({ latest: null, daily: [] });
        const res = await get({});
        const today = new Date().toISOString().slice(0, 10);
        assert.equal(res.body.to, today);
        const span = (Date.parse(res.body.to) - Date.parse(res.body.from)) / 86_400_000 + 1;
        assert.equal(span, 28);
    });

    it('an explicit to with no from reaches 28 days back from it', async () => {
        arrange();
        const res = await get({ to: '2026-10-28' });
        assert.deepEqual([res.body.from, res.body.to], ['2026-10-01', '2026-10-28']);
    });

    for (const [name, query, field] of [
        ['bad level', { level: 'galaxy' }, 'level'],
        ['bad from', { from: '2026-13-01' }, 'from'],
        ['from that is not a date', { from: 'yesterday' }, 'from'],
        ['bad to', { from: '2026-10-01', to: '2026-02-31' }, 'to'],
        ['from after to', { from: '2026-10-05', to: '2026-10-01' }, 'from'],
        ['a span of more than 400 days', { from: '2025-01-01', to: '2026-10-01' }, 'from'],
        ['bad breakdown', { breakdown: 'age' }, 'breakdown'],
        ['an id with a quote', { level: 'ad', ids: "ad1,a'; DROP TABLE x" }, 'ids'],
        ['too many ids', { level: 'ad', ids: Array.from({ length: 201 }, (_, i) => `ad${i}`).join(',') }, 'ids'],
    ] as const) {
        it(`400 INVALID with the field: ${name}`, async () => {
            arrange();
            const res = await get(query as Record<string, unknown>);
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 'INVALID');
            assert.equal(res.body.field, field);
            assert.equal(typeof res.body.error, 'string');
            assert.equal(statements.length, 0, 'refused before any database read');
        });
    }

    it('exactly 400 days is allowed', async () => {
        arrange();
        const res = await get({ from: '2025-09-04', to: '2026-10-08' });
        assert.equal(res.statusCode, 200);
    });
});

// ─── Breakdowns ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('breakdowns', () => {
    const bd = (meta_id: string, day: string, key: string, over: Record<string, unknown> = {}) => ({
        meta_id, day, key, currency: 'EGP', spend: 0, impressions: 0, clicks: 0, link_clicks: 0, conversations_started: 0, leads: 0, follows: null,
        provisional: false, synced_at: SYNCED, ...over,
    });

    it('country: rows come from the breakdown rows, one per key, and EG + SA add up to the total', async () => {
        arrange({
            breakdown: [
                bd('ad1', '2026-10-01', 'EG', { spend: 7, impressions: 700, clicks: 35, link_clicks: 21, conversations_started: 4, leads: 1 }),
                bd('ad1', '2026-10-01', 'SA', { spend: 3, impressions: 300, clicks: 15, link_clicks: 9, conversations_started: 1 }),
            ],
        });
        const res = await get({ level: 'ad', ids: 'ad1', ...RANGE, breakdown: 'country' });
        assert.equal(res.body.breakdown, 'country');
        const keys = res.body.rows.map((r: any) => r.key).sort();
        assert.deepEqual(keys, ['EG', 'SA']);
        const sum = (k: string) => res.body.rows.reduce((a: number, r: any) => a + r[k], 0);
        assert.equal(sum('spend'), 10);
        assert.equal(sum('impressions'), 1000);
        assert.equal(sum('linkClicks'), 30);
        assert.equal(sum('conversations'), 5);
        const day1 = (await get({ level: 'ad', ids: 'ad1', from: '2026-10-01', to: '2026-10-01' })).body.rows[0];
        assert.equal(sum('spend'), day1.spend, 'the countries add up to the unbroken total of that day');
        assert.equal(res.body.rows[0].reach, null);
        const sql = statements.find((s) => /FROM ads_insights_breakdown/.test(s.sql))!;
        assert.ok(sql.params.includes('country'));
        assert.equal(sql.params[0], TENANT);
    });

    it('placement, rolled up to the campaign, keeps the key', async () => {
        arrange({
            breakdown: [
                bd('ad1', '2026-10-01', 'instagram:reels', { spend: 4, conversations_started: 2 }),
                bd('ad2', '2026-10-01', 'instagram:reels', { spend: 2, link_clicks: 8 }),
                bd('ad2', '2026-10-01', 'facebook:feed', { spend: 4, link_clicks: 12 }),
            ],
        });
        const res = await get({ level: 'campaign', ...RANGE, breakdown: 'placement' });
        const reels = res.body.rows.find((r: any) => r.key === 'instagram:reels');
        assert.equal(reels.id, 'camp1');
        assert.equal(reels.spend, 6);
        assert.equal(reels.results, 2 + 8);
        assert.equal(res.body.rows.length, 2);
    });

    it('a breakdown answer keeps the totals and the app joins unbroken', async () => {
        arrange({ breakdown: [bd('ad1', '2026-10-01', 'EG', { spend: 1 })], direct: [{ day: '2026-10-01', app_id: 'app-ad1', n: 3 }] });
        const res = await get({ level: 'account', ...RANGE, breakdown: 'country' });
        assert.equal(res.body.totals.byCurrency.EGP.spend, 28.5);
        assert.equal(res.body.appDaily.length, 1);
        assert.equal(res.body.appJoins.trackedClicks.direct, 3);
    });
});

// ─── Currencies and provisional days ─────────────────────────────────────────────────────────────────────────────────────

describe('currencies', () => {
    it('two currencies are never summed: byCurrency has both, and the single currency is null', async () => {
        arrange({ daily: [...EGP_ROWS, USD_ROW] });
        const b = (await get({ level: 'account', ...RANGE })).body;
        assert.equal(b.currency, null);
        assert.deepEqual(b.currencies, ['EGP', 'USD']);
        assert.deepEqual(Object.keys(b.totals.byCurrency).sort(), ['EGP', 'USD']);
        assert.equal(b.totals.byCurrency.EGP.spend, 28.5);
        assert.equal(b.totals.byCurrency.USD.spend, 4);
        assert.equal(b.totals.byCurrency.USD.leads, 2);
        assert.equal(b.totals.byCurrency.USD.costPerLead, 2);
        const day2 = b.rows.filter((r: any) => r.day === '2026-10-02');
        assert.deepEqual(day2.map((r: any) => [r.currency, r.spend]).sort(), [['EGP', 12.5], ['USD', 4]], 'one row per currency, never merged');
        const per = b.perObject.map((p: any) => p.currency).sort();
        assert.deepEqual(per, ['EGP', 'USD']);
    });
});

describe('provisional days', () => {
    it('flags the row and reports the earliest provisional day', async () => {
        arrange({
            daily: [
                ...EGP_ROWS.slice(0, 1),
                daily('ad1', '2026-10-02', { spend: 5, provisional: true, synced_at: new Date('2026-10-05T00:00:00Z') }),
                daily('ad2', '2026-10-01', { spend: 5, provisional: true }),
            ],
        });
        const b = (await get({ level: 'account', ...RANGE })).body;
        assert.equal(b.provisionalFrom, '2026-10-01');
        assert.equal(b.rows.find((r: any) => r.day === '2026-10-01').provisional, true, 'any provisional ad row makes the day provisional');
        assert.equal(b.rows.find((r: any) => r.day === '2026-10-02').provisional, true);
        assert.equal(b.syncedAt, '2026-10-05T00:00:00.000Z', 'the newest synced_at');
    });

    it('settled rows give provisionalFrom null', async () => {
        arrange();
        const b = (await get({ level: 'ad', ...RANGE })).body;
        assert.equal(b.provisionalFrom, null);
        assert.ok(b.rows.every((r: any) => r.provisional === false));
    });
});

// ─── App joins ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('the app’s own joins', () => {
    const joins = {
        direct: [{ day: '2026-10-01', app_id: 'app-ad1', n: 4 }, { day: '2026-10-02', app_id: 'app-ad2', n: 2 }],
        viaChat: [{ day: '2026-10-01', meta_id: 'ad1', n: 3 }],
        handoffs: [{ day: '2026-10-02', meta_id: 'ad1', n: 1 }, { day: '2026-10-02', meta_id: 'ad2', n: 2 }],
    };

    it('counts direct, via chat and hand-offs per day per object, and rolls them up', async () => {
        arrange(joins);
        const ad = (await get({ level: 'ad', ...RANGE })).body;
        assert.deepEqual(ad.appDaily.find((a: any) => a.id === 'ad1' && a.day === '2026-10-01'), { day: '2026-10-01', id: 'ad1', trackedDirect: 4, trackedViaChat: 3, handoffs: 0 });
        assert.deepEqual(ad.appDaily.find((a: any) => a.id === 'ad2'), { day: '2026-10-02', id: 'ad2', trackedDirect: 2, trackedViaChat: 0, handoffs: 2 });
        const camp = (await get({ level: 'campaign', ...RANGE })).body;
        assert.deepEqual(camp.appDaily.map((a: any) => a.id), ['camp1', 'camp1']);
        assert.equal(camp.appJoins.trackedClicks.direct, 6);
        assert.equal(camp.appJoins.trackedClicks.viaChat, 3);
        assert.equal(camp.appJoins.handoffs, 3);
        const acct = (await get({ level: 'account', ...RANGE })).body;
        assert.deepEqual(acct.appJoins, { trackedClicks: { direct: 6, viaChat: 3 }, handoffs: 3 });
    });

    it('costPerTrackedClick uses direct + viaChat, per object and in the totals', async () => {
        arrange(joins);
        const b = (await get({ level: 'ad', ...RANGE })).body;
        const ad1 = b.perObject.find((p: any) => p.id === 'ad1');
        assert.deepEqual(ad1.trackedClicks, { direct: 4, viaChat: 3 });
        assert.equal(ad1.costPerTrackedClick, 3.21, '22.5 / 7');
        assert.equal(ad1.handoffs, 1);
        const t = b.totals.byCurrency.EGP;
        assert.deepEqual(t.trackedClicks, { direct: 6, viaChat: 3 });
        assert.equal(t.handoffs, 3);
        assert.equal(t.costPerTrackedClick, 3.17, '28.5 / 9');
    });

    it('uses the account time zone for the day, UTC when none is stored, and only people’s clicks', async () => {
        arrange({ ...joins, settings: { account: { timezone: 'Africa/Cairo' } } });
        await get({ level: 'ad', ...RANGE });
        const direct = statements.find((s) => /tl\.ads_object_id = ANY/.test(s.sql))!;
        assert.ok(direct.params.includes('Africa/Cairo'));
        assert.match(direct.sql, /is_prefetch = false/);
        assert.match(direct.sql, /AT TIME ZONE \$2/);

        statements.length = 0;
        routes.length = 0;
        arrange({ ...joins, settings: { account: { timezone: 'Not/AZone' } } });
        await get({ level: 'ad', ...RANGE });
        assert.ok(statements.find((s) => /tl\.ads_object_id = ANY/.test(s.sql))!.params.includes('UTC'));

        statements.length = 0;
        routes.length = 0;
        arrange(joins);
        await get({ level: 'ad', ...RANGE });
        assert.ok(statements.find((s) => /tl\.ads_object_id = ANY/.test(s.sql))!.params.includes('UTC'));
    });

    it('counts a click once: a via-chat click excludes links that already point at an ad', async () => {
        arrange(joins);
        await get({ level: 'ad', ...RANGE });
        const via = statements.find((s) => /JOIN conversations c/.test(s.sql))!;
        assert.match(via.sql, /tl\.ads_object_id IS NULL/);
        assert.match(via.sql, /is_prefetch = false/);
    });

    it('an app-join table that is missing (42P01 / 42703) leaves the joins at zero, not a 500', async () => {
        arrange();
        routes.unshift([/tl\.ads_object_id = ANY/, () => { throw Object.assign(new Error('column "ads_object_id" does not exist'), { code: '42703' }); }]);
        const res = await get({ level: 'ad', ...RANGE });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.appJoins.trackedClicks.direct, 0);
    });
});

// ─── Result kinds ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('resultKind', () => {
    it('maps the ad set’s optimisation goal first, then the campaign objective', () => {
        const k = (optimizationGoal: string | null, objective: string | null, destinationType: string | null = null) => resultKindOf({ optimizationGoal, objective, destinationType });
        assert.equal(k('CONVERSATIONS', null), 'conversations');
        assert.equal(k('REPLIES', null), 'conversations');
        assert.equal(k('LINK_CLICKS', 'OUTCOME_LEADS'), 'link_clicks', 'the goal wins over the objective');
        assert.equal(k('LANDING_PAGE_VIEWS', null), 'link_clicks');
        assert.equal(k('LEAD_GENERATION', null), 'leads');
        assert.equal(k('QUALITY_LEAD', null), 'leads');
        assert.equal(k('PROFILE_VISIT', null), 'follows');
        assert.equal(k(null, 'OUTCOME_LEADS'), 'leads');
        assert.equal(k(null, 'OUTCOME_TRAFFIC'), 'link_clicks');
        assert.equal(k(null, 'OUTCOME_ENGAGEMENT'), 'conversations');
        assert.equal(k('REACH', 'OUTCOME_ENGAGEMENT', 'ON_PAGE'), 'follows');
        assert.equal(k(null, 'OUTCOME_ENGAGEMENT', 'ON_PROFILE'), 'follows');
        assert.equal(k(null, null), 'link_clicks', 'unknown');
        assert.equal(k('SOMETHING_NEW', 'OUTCOME_SOMETHING'), 'link_clicks');
    });

    it('an ad takes its kind from its ad set, a lead ad counts leads', async () => {
        arrange({ daily: [...EGP_ROWS, USD_ROW] });
        const b = (await get({ level: 'ad', ...RANGE })).body;
        assert.deepEqual(b.objects.map((o: any) => [o.id, o.resultKind]), [['ad1', 'conversations'], ['ad2', 'link_clicks'], ['ad3', 'leads']]);
        assert.equal(b.rows.find((r: any) => r.id === 'ad3').results, 2);
    });
});

// ─── Missing tables, errors ──────────────────────────────────────────────────────────────────────────────────────────────

describe('failures', () => {
    it('a database without the ads tables yet answers empty, not 500', async () => {
        routes.push([/ads_/, () => { throw Object.assign(new Error('relation "ads_insights_daily" does not exist'), { code: '42P01' }); }]);
        const res = await get({ level: 'campaign', ...RANGE });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.rows, []);
        assert.deepEqual(res.body.objects, []);
        assert.deepEqual(res.body.totals, { byCurrency: {} });
        assert.equal(res.body.currency, null);
        assert.deepEqual(res.body.currencies, []);
        assert.equal(res.body.syncedAt, null);
        assert.equal(res.body.provisionalFrom, null);
        assert.equal(res.body.excludesTax, true);
        assert.deepEqual(res.body.appJoins, { trackedClicks: { direct: 0, viaChat: 0 }, handoffs: 0 });
    });

    it('an unexpected database error is logged and answered 500, without the message', async () => {
        const logs: string[] = [];
        const previous = setLogSink((_level, line) => { logs.push(line); });
        try {
            routes.push([/FROM ads_objects/, () => { throw new Error('connection reset at 10.0.0.1'); }]);
            const res = await get({ ...RANGE });
            assert.equal(res.statusCode, 500);
            assert.ok(!JSON.stringify(res.body).includes('10.0.0.1'));
            assert.ok(logs.some((l) => l.includes('ads.read_results_failed')));
        } finally {
            setLogSink(previous);
        }
    });

    it('no Meta call even when the rows are empty', async () => {
        arrange({ daily: [] });
        const res = await get({ level: 'account', ...RANGE });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.rows, []);
        assert.deepEqual(metaCalls, []);
    });
});
