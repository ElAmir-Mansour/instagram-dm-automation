/**
 * The stored copy (research R2): what an upsert may and may not overwrite, the deletion rule, the sums of results (reach never summed),
 * the spend the screens show, the breakdown table that may not exist yet, and the view the dashboard receives. A fake pool answers by
 * SQL (src/services/monteur/testDb.ts), so the statements themselves are asserted.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import {
    boostIdFromName, breakdownsUnavailable, childrenOf, effectiveLabelKey, getObject, listObjects, markMissing, missDecision, resetBreakdownAvailability,
    resultsFor, reviewReasons, spendFromMirror, toObjectRow, toObjectView, upsertBreakdowns, upsertInsights, upsertObjects, type BreakdownRow, type InsightRow,
    type ObjectRow, type ParsedObject, type QueuedOp, type ResultTotals,
} from './mirror.js';

const C = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '1234567890';

let db: FakeDb;
beforeEach(() => {
    resetBreakdownAvailability();
    db = installFakeDb();
});
afterEach(() => db.restore());

const parsed = (over: Partial<ParsedObject> = {}): ParsedObject => ({
    level: 'campaign', metaId: '111111', parentMetaId: null, creativeMetaId: null, name: 'Spring', status: 'ACTIVE', effectiveStatus: 'ACTIVE', objective: 'OUTCOME_TRAFFIC',
    destinationType: null, optimizationGoal: null, dailyBudgetMinor: 5000, lifetimeBudgetMinor: null, startTime: null, endTime: null, targetingSummary: null, review: null, raw: { id: '111111' }, ...over,
});

const row = (over: Partial<ObjectRow> = {}): ObjectRow => ({
    id: ID, creatorId: C, adAccountId: ACCOUNT, level: 'campaign', metaId: '111111', parentId: null, name: 'Spring', origin: 'meta', status: 'ACTIVE', effectiveStatus: 'ACTIVE',
    objective: null, destinationType: null, optimizationGoal: null, budgetKind: 'daily', budgetAmount: 50, currency: 'USD', startTime: null, endTime: null, targetingSummary: null,
    review: null, appMeta: {}, raw: null, syncedAt: '2026-10-22T10:00:00.000Z', ...over,
});

const totals = (over: Partial<ResultTotals> = {}): ResultTotals => ({ spend: 20, impressions: 1000, reach: null, clicks: 40, linkClicks: 30, conversations: 4, firstReplies: 3, leads: 0, ...over });

describe('upsertObjects', () => {
    beforeEach(() => {
        db.routes.push(
            [/^SELECT id, campaign_id, adset_id, ad_id, creative_id FROM ad_boosts/, () => ({ rows: [{ id: 'boost-from-table', campaign_id: '777777', adset_id: null, ad_id: null, creative_id: null }] })],
            [/^INSERT INTO ads_objects/, (p) => ({ rows: [{ id: `id-${p[3]}` }] })],
        );
    });

    it('updates what Meta says on a conflict and never origin or app_meta (a Boost row stays boost)', async () => {
        await upsertObjects(C, ACCOUNT, 'USD', [parsed()], new Date());
        const [insert] = db.ran(/^INSERT INTO ads_objects/);
        const conflict = insert!.sql.slice(insert!.sql.indexOf('DO UPDATE SET'), insert!.sql.indexOf('RETURNING'));
        assert.ok(conflict.length > 40, 'there is an update list');
        assert.doesNotMatch(conflict, /\borigin\b/);
        assert.doesNotMatch(conflict, /\bapp_meta\b/);
        for (const col of ['name', 'status', 'effective_status', 'budget_kind', 'budget_amount', 'review', 'targeting_summary', 'raw', 'synced_at']) assert.match(conflict, new RegExp(`\\b${col} = `));
        assert.match(insert!.sql, /ON CONFLICT \(creator_id, level, meta_id\) WHERE meta_id IS NOT NULL/);
    });

    it('gives a new row origin meta, or boost when the name or an ad_boosts row says so', async () => {
        await upsertObjects(C, ACCOUNT, 'USD', [
            parsed({ metaId: '1' }),
            parsed({ metaId: '2', name: 'AutoReply boost 7f9c2a10-aaaa-4000-8000-000000000001 · facebook · campaign' }),
            parsed({ metaId: '777777', name: 'renamed in Ads Manager' }),
        ], new Date());
        const by = (m: string) => db.ran(/^INSERT INTO ads_objects/).find((s) => s.params[3] === m)!.params;
        assert.equal(by('1')[6], 'meta');
        assert.deepEqual(JSON.parse(by('1')[19]), {});
        assert.equal(by('2')[6], 'boost');
        assert.equal(JSON.parse(by('2')[19]).boost_id, '7f9c2a10-aaaa-4000-8000-000000000001');
        assert.equal(by('777777')[6], 'boost');
        assert.equal(JSON.parse(by('777777')[19]).boost_id, 'boost-from-table');
    });

    it('converts Meta\'s minor units with the account currency (a whole-unit currency is not divided)', async () => {
        await upsertObjects(C, ACCOUNT, 'USD', [parsed({ metaId: '1', dailyBudgetMinor: 1250 })], new Date());
        await upsertObjects(C, ACCOUNT, 'JPY', [parsed({ metaId: '2', dailyBudgetMinor: null, lifetimeBudgetMinor: 5000 })], new Date());
        const by = (m: string) => db.ran(/^INSERT INTO ads_objects/).find((s) => s.params[3] === m)!.params;
        assert.deepEqual([by('1')[12], by('1')[13]], ['daily', 12.5]);
        assert.deepEqual([by('2')[12], by('2')[13]], ['lifetime', 5000]);
        assert.deepEqual([by('1')[12]], ['daily']);
    });

    it('touches app_meta afterwards only to reset the miss count and keep creative_id, scoped to the tenant', async () => {
        const ids = await upsertObjects(C, ACCOUNT, 'USD', [parsed(), parsed({ level: 'ad', metaId: '333', parentMetaId: '111111', creativeMetaId: '444' })], new Date());
        assert.equal(ids.get('111111'), 'id-111111');
        const [relink] = db.ran(/^UPDATE ads_objects o SET app_meta/);
        assert.match(relink!.sql, /\(o\.app_meta - 'sync_missing'\) \|\|/);
        assert.match(relink!.sql, /o\.creator_id = \$3/);
        assert.deepEqual(relink!.params, [['id-111111', 'id-333'], [null, '444'], C]);
    });
});

describe('markMissing and missDecision', () => {
    it('the first miss counts, the second deletes', () => {
        assert.deepEqual(missDecision(null), { next: 1, deleted: false });
        assert.deepEqual(missDecision('1'), { next: 2, deleted: true });
        assert.deepEqual(missDecision(7), { next: 8, deleted: true });
    });

    it('returns how many rows were deleted now, and updates only this tenant\'s rows', async () => {
        db.routes.push([/^SELECT id, app_meta->>'sync_missing'/, () => ({ rows: [{ id: 'a', missing: null }, { id: 'b', missing: '1' }, { id: 'c', missing: '1' }] })]);
        assert.equal(await markMissing(C, ACCOUNT, new Set(['9']), ['campaign']), 2);
        for (const s of db.ran(/^UPDATE ads_objects/)) assert.match(s.sql, /creator_id = \$/);
        assert.equal(await markMissing(C, ACCOUNT, new Set(), []), 0);
    });
});

describe('upsertInsights', () => {
    const r = (over: Partial<InsightRow> = {}): InsightRow => ({
        creatorId: C, level: 'ad', metaId: '333', day: '2026-10-21', currency: 'USD', spend: 5, impressions: 10, reach: 8, clicks: 2, linkClicks: 1, conversationsStarted: 0,
        firstReplies: 0, leads: 0, follows: null, videoViews: 0, actions: null, attribution: '7d_click,1d_view', provisional: true, ...over,
    });

    it('overwrites a day on conflict, and sends one row once when the same key appears twice (the last wins)', async () => {
        assert.equal(await upsertInsights([r(), r({ spend: 9 }), r({ day: '2026-10-20' })]), 2);
        const [s] = db.ran(/^INSERT INTO ads_insights_daily/);
        assert.match(s!.sql, /ON CONFLICT \(creator_id, level, meta_id, day\) DO UPDATE/);
        const sent = JSON.parse(s!.params[0]);
        assert.equal(sent.length, 2);
        assert.equal(sent.find((x: any) => x.day === '2026-10-21').spend, 9);
        assert.equal(await upsertInsights([]), 0);
    });
});

describe('upsertBreakdowns', () => {
    const b = (over: Partial<BreakdownRow> = {}): BreakdownRow => ({
        creatorId: C, level: 'ad', metaId: '333', day: '2026-10-21', breakdown: 'country', key: 'SA', currency: 'USD', spend: 1, impressions: 1, clicks: 0, linkClicks: 0,
        conversationsStarted: 0, leads: 0, follows: null, provisional: true, ...over,
    });

    it('writes the rows keyed by (tenant, level, object, day, breakdown, key)', async () => {
        assert.equal(await upsertBreakdowns([b(), b({ breakdown: 'placement', key: 'instagram:reels' })]), 2);
        assert.match(db.ran(/ads_insights_breakdown/)[0]!.sql, /ON CONFLICT \(creator_id, level, meta_id, day, breakdown, key\)/);
    });

    it('returns 0 without throwing when the table does not exist (42P01), and remembers it', async () => {
        db.routes.push([/INSERT INTO ads_insights_breakdown/, () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); }]);
        assert.equal(breakdownsUnavailable(), false);
        assert.equal(await upsertBreakdowns([b()]), 0);
        assert.equal(breakdownsUnavailable(), true);
        assert.equal(db.ran(/^ROLLBACK/).length, 1, 'the transaction was rolled back, not left open');
    });

    it('throws any other database error', async () => {
        db.routes.push([/INSERT INTO ads_insights_breakdown/, () => { throw Object.assign(new Error('deadlock'), { code: '40P01' }); }]);
        await assert.rejects(() => upsertBreakdowns([b()]), /deadlock/);
        assert.equal(breakdownsUnavailable(), false);
    });
});

describe('resultsFor', () => {
    const sum = (metaId: string, day: string, spend: string, impressions: string, conversations: string) => ({
        object_id: metaId, day, spend, impressions, clicks: '10', link_clicks: '6', conversations, first_replies: '1', leads: '0',
    });
    beforeEach(() => {
        db.routes.push(
            [/SUM\(i\.spend\)::text AS spend/, () => ({ rows: [sum('555', '2026-10-20', '10.10', '100', '2'), sum('555', '2026-10-21', '5.20', '50', '1'), sum('666', '2026-10-21', '1.00', '9', '0')] })],
            [/reach::text AS reach FROM ads_insights_daily/, () => ({ rows: [{ meta_id: '555', day: '2026-10-20', reach: '80' }, { meta_id: '555', day: '2026-10-21', reach: '45' }] })],
        );
    });

    it('sums spend, impressions, clicks, link clicks, conversations and leads across days and rows', async () => {
        const { daily, totals: t } = await resultsFor(C, 'campaign', ['555', '666'], '2026-10-20', '2026-10-21');
        assert.equal(daily.length, 3);
        const a = t.get('555')!;
        assert.equal(a.spend, 15.3);
        assert.equal(a.impressions, 150);
        assert.equal(a.clicks, 20);
        assert.equal(a.linkClicks, 12);
        assert.equal(a.conversations, 3);
        assert.equal(t.get('666')!.spend, 1);
    });

    it('never sums reach across days: per day it is the object\'s own row, in the total it is null over several days', async () => {
        const { daily, totals: t } = await resultsFor(C, 'campaign', ['555', '666'], '2026-10-20', '2026-10-21');
        assert.deepEqual(daily.filter((d) => d.metaId === '555').map((d) => d.reach), [80, 45]);
        assert.equal(daily.find((d) => d.metaId === '666')!.reach, null, 'no own-level row: null, not a guess');
        assert.equal(t.get('555')!.reach, null);
    });

    it('over a single day the total reach is that day\'s own-level row', async () => {
        const { totals: t } = await resultsFor(C, 'campaign', ['555'], '2026-10-21', '2026-10-21');
        assert.equal(t.get('555')!.reach, 45);
    });

    it('sums the ads under a campaign through the stored parent links and names the tenant', async () => {
        await resultsFor(C, 'campaign', ['555'], '2026-10-20', '2026-10-21');
        const [s] = db.ran(/SUM\(i\.spend\)/);
        assert.match(s!.sql, /JOIN ads_objects c ON c\.id = s\.parent_id/);
        assert.match(s!.sql, /i\.creator_id = \$1/);
        assert.equal(s!.params[0], C);
    });

    it('gives empty totals for an object with no rows, and for no ids', async () => {
        db.routes.length = 0;
        assert.equal((await resultsFor(C, 'ad', ['9'], '2026-10-20', '2026-10-21')).totals.get('9')!.spend, 0);
        assert.equal((await resultsFor(C, 'ad', [], '2026-10-20', '2026-10-21')).daily.length, 0);
    });
});

describe('spendFromMirror', () => {
    it('prefers the account\'s own row of a day and falls back to the sum of the ads\' rows', async () => {
        db.routes.push(
            [/level = 'account'/, () => ({ rows: [{ day: '2026-10-22', spend: '40.00', provisional: true, synced_at: '2026-10-22T09:00:00Z' }] })],
            [/BOOL_OR\(i\.provisional\)/, () => ({ rows: [
                { day: '2026-10-22', spend: '12.00', provisional: true, synced_at: '2026-10-22T08:00:00Z' },
                { day: '2026-10-10', spend: '100.50', provisional: false, synced_at: '2026-10-22T08:00:00Z' },
            ] })],
        );
        const s = await spendFromMirror(C, ACCOUNT, '2026-10-22', '2026-10-01');
        assert.equal(s.spentToday, 40);
        assert.equal(s.spentThisMonth, 140.5);
        assert.equal(s.provisionalFrom, '2026-10-22');
        assert.equal(s.syncedAt, '2026-10-22T08:00:00.000Z');
        for (const st of db.statements) assert.match(st.sql, /creator_id = \$1/);
    });

    it('is zero with no rows', async () => {
        assert.deepEqual(await spendFromMirror(C, ACCOUNT, '2026-10-22', '2026-10-01'), { spentToday: 0, spentThisMonth: 0, provisionalFrom: null, syncedAt: null });
    });
});

describe('reads by id and filter', () => {
    const db_row = { id: ID, creator_id: C, ad_account_id: ACCOUNT, level: 'campaign', meta_id: '111111', parent_id: null, name: 'Spring', origin: 'meta', status: 'ACTIVE',
        effective_status: 'ACTIVE', objective: null, destination_type: null, optimization_goal: null, budget_kind: 'daily', budget_amount: '50.00', currency: 'USD',
        start_time: new Date('2026-10-20T08:00:00Z'), end_time: null, targeting_summary: null, review: null, app_meta: null, raw: null, synced_at: new Date('2026-10-22T10:00:00Z') };

    it('getObject takes our uuid or a Meta id, always with the tenant, and refuses anything else without asking the database', async () => {
        db.routes.push([/FROM ads_objects WHERE/, () => ({ rows: [db_row] })]);
        const a = await getObject(C, ID);
        assert.equal(a?.budgetAmount, 50);
        assert.equal(a?.startTime, '2026-10-20T08:00:00.000Z');
        assert.deepEqual(a?.appMeta, {});
        assert.ok(await getObject(C, '111111'));
        assert.match(db.statements[0]!.sql, /id = \$2::uuid AND creator_id = \$1/);
        assert.match(db.statements[1]!.sql, /meta_id = \$2 AND creator_id = \$1/);
        db.statements.length = 0;
        assert.equal(await getObject(C, "1' OR '1'='1"), null);
        assert.equal(await childrenOf(C, 'nope').then((r) => r.length), 0);
        assert.equal(db.statements.length, 0);
    });

    it('listObjects leaves out deleted rows and creatives unless asked, and filters on the configured status', async () => {
        db.routes.push([/FROM ads_objects WHERE/, () => ({ rows: [db_row] })]);
        await listObjects(C, {});
        assert.match(db.statements[0]!.sql, /level <> 'creative'/);
        assert.match(db.statements[0]!.sql, /status IS DISTINCT FROM 'DELETED'/);
        await listObjects(C, { level: 'adset', status: ['active', 'paused'], parentId: ID });
        const s = db.statements[1]!;
        assert.match(s.sql, /status = ANY\(\$3::text\[\]\)/);
        assert.deepEqual(s.params, [C, 'adset', ['ACTIVE', 'PAUSED'], ID]);
        assert.equal((await listObjects(C, { parentId: 'x' })).length, 0);
    });

    it('toObjectRow keeps NUMERIC strings as numbers and Dates as ISO', () => {
        assert.equal(toObjectRow(db_row as never).budgetAmount, 50);
    });
});

describe('toObjectView', () => {
    it('maps the label to an i18n key and the delivery state through', () => {
        assert.equal(effectiveLabelKey('WITH_ISSUES'), 'ads.status.with_issues');
        assert.equal(effectiveLabelKey(null), 'ads.status.unknown');
        assert.equal(effectiveLabelKey('Bad Value!'), 'ads.status.unknown');
        const v = toObjectView(row({ effectiveStatus: 'CAMPAIGN_PAUSED' }));
        assert.equal(v.effectiveLabel, 'ads.status.campaign_paused');
        assert.equal(v.effectiveStatus, 'CAMPAIGN_PAUSED');
    });

    it('a budget is editable unless there is none or the object is archived or deleted', () => {
        assert.equal(toObjectView(row()).budget.editable, true);
        assert.equal(toObjectView(row({ budgetKind: 'none', budgetAmount: null })).budget.editable, false);
        assert.equal(toObjectView(row({ status: 'ARCHIVED' })).budget.editable, false);
        assert.equal(toObjectView(row({ status: 'DELETED' })).budget.editable, false);
        const v = toObjectView(row({ level: 'adset' }), { editsLeftThisHour: 3 });
        assert.deepEqual(v.budget, { kind: 'daily', amount: 50, currency: 'USD', editable: true, editsLeftThisHour: 3 });
        assert.equal(toObjectView(row()).budget.editsLeftThisHour, null);
    });

    it('reads review reasons from issues_info and ad_review_feedback, and the learning stage', () => {
        const v = toObjectView(row({ level: 'ad', review: {
            issues_info: [{ error_summary: 'Ad disapproved' }, { error_message: 'Fix the text' }], ad_review_feedback: { global: { Misleading: 'We removed it', CODE_7: '123' } },
            learning_stage_info: { status: 'LEARNING' },
        } }));
        assert.deepEqual(v.review, { reasons: ['Ad disapproved', 'Fix the text', 'We removed it', 'CODE_7'], learning: 'LEARNING' });
        assert.deepEqual(toObjectView(row()).review, { reasons: [], learning: null });
        assert.deepEqual(reviewReasons({ issues_info: Array.from({ length: 9 }, (_, i) => ({ error_summary: `r${i}` })) }).length, 6);
    });

    it('results: cost per conversation is spend over conversations, or null; the result follows the optimisation goal', () => {
        const v = toObjectView(row({ level: 'adset', optimizationGoal: 'CONVERSATIONS' }), { results: totals() });
        assert.deepEqual(v.results, {
            spend: 20, impressions: 1000, reach: null, linkClicks: 30, conversations: 4, costPerConversation: 5, results: 4, costPerResult: 5,
            appConversations: 0, trackedClicks: 0, handoffs: 0, costPerTrackedClick: null,
        });
        const none = toObjectView(row({ optimizationGoal: 'CONVERSATIONS' }), { results: totals({ conversations: 0 }) });
        assert.equal(none.results!.costPerConversation, null);
        assert.equal(none.results!.results, null);
        const clicks = toObjectView(row({ optimizationGoal: 'LINK_CLICKS' }), { results: totals() });
        assert.equal(clicks.results!.results, 30);
        assert.equal(toObjectView(row()).results, null);
    });

    it('A3: an ad carries what the app saw of it (conversations, tracked clicks, hand-offs), and a cost per tracked click', () => {
        const v = toObjectView(row({ level: 'ad', optimizationGoal: 'CONVERSATIONS' }), { results: totals(), app: { conversations: 3, trackedClicks: 4, handoffs: 1 } });
        assert.equal(v.results!.appConversations, 3);
        assert.equal(v.results!.trackedClicks, 4);
        assert.equal(v.results!.handoffs, 1);
        assert.equal(v.results!.costPerTrackedClick, 5);
    });

    it('lists only the ops still in flight, and shows a boost id and the creative of an ad', () => {
        const op = (state: string): QueuedOp => ({ id: state, kind: 'status', state, objectKey: ID, notBefore: '', attempts: 0, result: null, createdAt: '', finishedAt: null, actorVia: 'owner' });
        const v = toObjectView(row({ level: 'ad', appMeta: { boost_id: 'b1', creative_id: '444' }, origin: 'boost', parentId: 'p', raw: { creative: { id: '444', effective_instagram_media_id: '179', thumbnail_url: 'https://t/1.jpg' } } }),
            { queuedOps: ['pending', 'running', 'verify', 'done', 'failed', 'cancelled'].map(op) });
        assert.deepEqual(v.queued.map((o) => o.state), ['pending', 'running', 'verify']);
        assert.deepEqual(v.appMeta, { boostId: 'b1' });
        assert.deepEqual(v.creative, { kind: 'post', thumbUrl: 'https://t/1.jpg', postId: '179' });
        assert.equal(v.origin, 'boost');
        assert.equal(v.parentId, 'p');
        assert.deepEqual(toObjectView(row()).appMeta, {});
        assert.equal(toObjectView(row()).creative, null);
    });

    it('boostIdFromName reads the v1 name and nothing else', () => {
        assert.equal(boostIdFromName('AutoReply boost 7f9c2a10-aaaa-4000-8000-000000000001 · instagram · ad'), '7f9c2a10-aaaa-4000-8000-000000000001');
        assert.equal(boostIdFromName('My AutoReply boost campaign'), null);
        assert.equal(boostIdFromName(null), null);
    });
});
