/**
 * The stored copy of the ad account (research R2): `ads_objects` (campaigns, ad sets, ads, creatives) and `ads_insights_daily` (results
 * per day). Every `GET /api/ads/*` reads these two tables and nothing else, so a screen never costs Meta points; `sync.ts` is the only
 * thing that fills them, from Meta's reads.
 *
 * Rules that live here, so every writer and reader agrees:
 *
 *   - A row is keyed by (tenant, level, Meta id). An upsert updates what Meta says (name, status, budget, review...) and NEVER `origin` or
 *     `app_meta`: those are the app's own facts. A Boost row stays `boost` and keeps its `boost_id`; an object made in Ads Manager is
 *     `meta`; one made by the app (A3) is `app`. Two sync-owned keys are the exception, merged in a separate statement that touches only
 *     them: `creative_id` (which creative an ad uses) and `sync_missing` (below).
 *   - Deletion is marked, not assumed. A row the account no longer lists gets `app_meta.sync_missing` +1 per COMPLETE structure sync; the
 *     second miss in a row sets `status` and `effective_status` to DELETED, one sighting resets the count. A sync that did not read every
 *     page never calls `markMissing`: a page that failed to load is not a campaign that vanished.
 *   - Money is major units of the row's currency (NUMERIC(14,2)); Meta's minor units are converted on the way in (`money.ts`).
 *   - Reach is not additive: not across days (a person reached on Monday and Tuesday counts once), not across levels. Sums of results
 *     therefore leave reach out, and a total reach is only ever the object's own row of a single day.
 *   - Days are the AD ACCOUNT's calendar days (Meta's `date_start` already is), never UTC's.
 */
import { queryCount, queryOne, queryRows } from '../../db/query.js';
import { log } from '../../utils/log.js';
import { withTransaction, type Exec } from '../studio/common.js';
import { fromMinorUnits, roundMoney } from './money.js';

// ─── Types ──────────────────────────────────────────────────────────────────────────────────

export type ObjectLevel = 'campaign' | 'adset' | 'ad' | 'creative';
export type ObjectOrigin = 'app' | 'boost' | 'proposal' | 'meta';
export type InsightLevel = 'account' | 'campaign' | 'adset' | 'ad';

/** One Meta object as the structure sync read it, before it is stored. Budgets are Meta's minor units: the currency is the account's. */
export interface ParsedObject {
    level: ObjectLevel;
    metaId: string;
    /** The campaign (for an ad set) or the ad set (for an ad), by Meta id. A creative has none: the ad points at it. */
    parentMetaId: string | null;
    /** The creative an ad uses, by Meta id. */
    creativeMetaId: string | null;
    name: string | null;
    status: string | null;
    effectiveStatus: string | null;
    objective: string | null;
    destinationType: string | null;
    optimizationGoal: string | null;
    dailyBudgetMinor: number | null;
    lifetimeBudgetMinor: number | null;
    startTime: string | null;
    endTime: string | null;
    targetingSummary: Record<string, unknown> | null;
    review: { issues_info: unknown; ad_review_feedback: unknown; learning_stage_info: unknown } | null;
    /** This object's own fields as Meta sent them, without the children nested under it. */
    raw: Record<string, unknown>;
}

/** One day of results of one object, money in major units. `reach` is valid for this row's own level and day only. */
export interface InsightRow {
    creatorId: string;
    level: InsightLevel;
    metaId: string;
    /** `YYYY-MM-DD` in the ad account's time zone. */
    day: string;
    currency: string;
    spend: number;
    impressions: number;
    reach: number;
    clicks: number;
    linkClicks: number;
    conversationsStarted: number;
    firstReplies: number;
    leads: number;
    follows: number | null;
    videoViews: number;
    actions: unknown[] | null;
    attribution: string | null;
    provisional: boolean;
}

export interface ObjectRow {
    id: string;
    creatorId: string;
    adAccountId: string;
    level: ObjectLevel;
    metaId: string | null;
    parentId: string | null;
    name: string | null;
    origin: ObjectOrigin;
    status: string | null;
    effectiveStatus: string | null;
    objective: string | null;
    destinationType: string | null;
    optimizationGoal: string | null;
    budgetKind: 'daily' | 'lifetime' | 'none';
    budgetAmount: number | null;
    currency: string;
    startTime: string | null;
    endTime: string | null;
    targetingSummary: Record<string, unknown> | null;
    review: Record<string, unknown> | null;
    appMeta: Record<string, unknown>;
    raw: Record<string, unknown> | null;
    syncedAt: string | null;
}

/** Totals of one object over a range. `reach` is null unless the range is a single day (see the file's header). */
export interface ResultTotals {
    spend: number;
    impressions: number;
    reach: number | null;
    clicks: number;
    linkClicks: number;
    conversations: number;
    firstReplies: number;
    leads: number;
}

export interface DailyResults extends ResultTotals {
    /** The object these numbers belong to (the id asked for). */
    metaId: string;
    day: string;
}

/** The queue's view of an op (`ops.ts` `OpView`): only what the screen needs to show a badge. Structurally the same type. */
export interface QueuedOp {
    id: string;
    kind: string;
    state: string;
    objectKey: string;
    notBefore: string;
    attempts: number;
    result: unknown;
    createdAt: string;
    finishedAt: string | null;
    actorVia: string;
}

export interface ObjectView {
    id: string;
    level: ObjectLevel;
    metaId: string | null;
    name: string;
    origin: ObjectOrigin;
    status: string | null;
    effectiveStatus: string | null;
    /** An i18n key: `ads.status.<lowercase effective status>`. */
    effectiveLabel: string;
    review: { reasons: string[]; learning: string | null };
    objective: string | null;
    destinationType: string | null;
    optimizationGoal: string | null;
    budget: { kind: 'daily' | 'lifetime' | 'none'; amount: number | null; currency: string; editable: boolean; editsLeftThisHour: number | null };
    schedule: { start: string | null; end: string | null };
    targetingSummary: Record<string, unknown> | null;
    creative: { kind: 'post' | 'dynamic' | 'media'; thumbUrl: string | null; postId?: string } | null;
    appMeta: { boostId?: string };
    results: {
        spend: number;
        impressions: number;
        reach: number | null;
        linkClicks: number;
        conversations: number;
        costPerConversation: number | null;
        results: number | null;
        costPerResult: number | null;
        /**
         * A3, ads only: what the app saw that Meta cannot (`ads/attribution.ts` `resultsByAd`): conversations that began from this ad (by
         * `entry_source.ad_id`), people's clicks on the tracked links sent in them, and the hand-offs to a person. Zero for any other level.
         */
        appConversations: number;
        trackedClicks: number;
        handoffs: number;
        costPerTrackedClick: number | null;
    } | null;
    /** Ops on this object that have not finished: pending, running or in verify. */
    queued: QueuedOp[];
    parentId: string | null;
    syncedAt: string | null;
}

// ─── Small pure helpers ─────────────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Two misses in a row: one miss can be a page that was cut short or Meta's own lag. */
export const MISSES_TO_DELETE = 2;
const LEVEL_RANK: Record<ObjectLevel, number> = { campaign: 0, adset: 1, creative: 2, ad: 3 };
/** Objects per transaction: short, so the pooled connection is back quickly and no Graph call ever waits inside one. */
const UPSERT_CHUNK = 50;
const INSIGHT_CHUNK = 500;

/** v1 names every boost object `AutoReply boost <boost id> · <platform> · <what>` (`metaAds.ts` `name()`). */
const BOOST_NAME = /^AutoReply boost ([0-9A-Za-z-]{6,64})(?:\s|$)/;

/** The v1 boost id a Meta object's name carries, or null. */
export function boostIdFromName(name: string | null | undefined): string | null {
    return typeof name === 'string' ? (BOOST_NAME.exec(name)?.[1] ?? null) : null;
}

const iso = (v: unknown): string | null => {
    if (v === null || v === undefined || v === '') return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const n = (v: unknown): number => {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(x) ? x : 0;
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** `i18n` key of Meta's delivery state, e.g. `ads.status.with_issues`. */
export function effectiveLabelKey(effectiveStatus: string | null | undefined): string {
    const s = typeof effectiveStatus === 'string' ? effectiveStatus.trim().toLowerCase() : '';
    return `ads.status.${/^[a-z_]+$/.test(s) ? s : 'unknown'}`;
}

// ─── Objects: writes ────────────────────────────────────────────────────────────────────────

interface ObjectInsert { id: string }

/**
 * Store what the structure sync read. New rows get origin `boost` when the object is Boost's (its name carries a v1 boost id, or the
 * `ad_boosts` row lists its Meta id) and `meta` otherwise; an existing row keeps its origin and `app_meta` whatever Meta says now.
 * Parents are stored before their children (campaign, ad set, creative, ad) so every link resolves; chunks of 50 are one short transaction
 * each. Returns Meta id → the app's row id.
 */
export async function upsertObjects(creatorId: string, adAccountId: string, currency: string, objs: ParsedObject[], syncedAt: Date): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (objs.length === 0) return ids;
    const boostLinks = await loadBoostLinks(creatorId);
    const ordered = [...objs].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
    for (let i = 0; i < ordered.length; i += UPSERT_CHUNK) {
        const chunk = ordered.slice(i, i + UPSERT_CHUNK);
        await withTransaction(async (tx) => {
            const relink: { id: string; creative: string | null }[] = [];
            for (const o of chunk) {
                const id = await upsertOne(tx, creatorId, adAccountId, currency, o, ids, boostLinks, syncedAt);
                ids.set(o.metaId, id);
                relink.push({ id, creative: o.level === 'ad' ? o.creativeMetaId : null });
            }
            await relinkSyncKeys(tx, creatorId, relink);
        });
    }
    return ids;
}

/** Meta id → boost id for every object an `ad_boosts` row made, so a boost renamed in Ads Manager is still Boost's. */
async function loadBoostLinks(creatorId: string): Promise<Map<string, string>> {
    const rows = await queryRows<{ id: string; campaign_id: string | null; adset_id: string | null; ad_id: string | null; creative_id: string | null }>(
        "SELECT id, campaign_id, adset_id, ad_id, creative_id FROM ad_boosts WHERE creator_id = $1 AND status <> 'failed'",
        [creatorId]
    );
    const out = new Map<string, string>();
    for (const r of rows) for (const m of [r.campaign_id, r.adset_id, r.ad_id, r.creative_id]) if (m) out.set(m, r.id);
    return out;
}

function budgetOf(o: ParsedObject, currency: string): { kind: 'daily' | 'lifetime' | 'none'; amount: number | null } {
    if (o.dailyBudgetMinor && o.dailyBudgetMinor > 0) return { kind: 'daily', amount: roundMoney(fromMinorUnits(o.dailyBudgetMinor, currency)) };
    if (o.lifetimeBudgetMinor && o.lifetimeBudgetMinor > 0) return { kind: 'lifetime', amount: roundMoney(fromMinorUnits(o.lifetimeBudgetMinor, currency)) };
    return { kind: 'none', amount: null };
}

async function upsertOne(tx: Exec, creatorId: string, adAccountId: string, currency: string, o: ParsedObject, ids: Map<string, string>, boostLinks: Map<string, string>, syncedAt: Date): Promise<string> {
    const boostId = boostIdFromName(o.name) ?? boostLinks.get(o.metaId) ?? null;
    const appMeta: Record<string, unknown> = {};
    if (boostId) appMeta['boost_id'] = boostId;
    if (o.level === 'ad' && o.creativeMetaId) appMeta['creative_id'] = o.creativeMetaId;
    const budget = budgetOf(o, currency);
    const parentId = o.parentMetaId ? (ids.get(o.parentMetaId) ?? null) : null;
    // The DO UPDATE list names every Meta-owned column and neither `origin` nor `app_meta`: a Boost row stays `boost`, whatever Meta says.
    const res = await tx.query<ObjectInsert>(
        `INSERT INTO ads_objects (creator_id, ad_account_id, level, meta_id, parent_id, name, origin, status, effective_status, objective,
                                  destination_type, optimization_goal, budget_kind, budget_amount, currency, start_time, end_time,
                                  targeting_summary, review, app_meta, raw, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19::jsonb, $20::jsonb, $21::jsonb, $22)
         ON CONFLICT (creator_id, level, meta_id) WHERE meta_id IS NOT NULL DO UPDATE SET
             ad_account_id = EXCLUDED.ad_account_id, parent_id = COALESCE(EXCLUDED.parent_id, ads_objects.parent_id),
             name = COALESCE(EXCLUDED.name, ads_objects.name), status = EXCLUDED.status, effective_status = EXCLUDED.effective_status,
             objective = EXCLUDED.objective, destination_type = EXCLUDED.destination_type, optimization_goal = EXCLUDED.optimization_goal,
             budget_kind = EXCLUDED.budget_kind, budget_amount = EXCLUDED.budget_amount, currency = EXCLUDED.currency,
             start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time, targeting_summary = EXCLUDED.targeting_summary,
             review = EXCLUDED.review, raw = EXCLUDED.raw, synced_at = EXCLUDED.synced_at, updated_at = NOW()
         RETURNING id`,
        [
            creatorId, adAccountId, o.level, o.metaId, parentId, o.name, boostId ? 'boost' : 'meta', o.status, o.effectiveStatus, o.objective,
            o.destinationType, o.optimizationGoal, budget.kind, budget.amount, currency, iso(o.startTime), iso(o.endTime),
            o.targetingSummary ? JSON.stringify(o.targetingSummary) : null, o.review ? JSON.stringify(o.review) : null,
            JSON.stringify(appMeta), JSON.stringify(o.raw), syncedAt,
        ]
    );
    const id = res.rows[0]?.id;
    if (!id) throw new Error('upsertObjects: the database returned no id for an upserted object.');
    return id;
}

/**
 * After a sighting: reset the miss count, and keep `creative_id` current (an ad whose creative was swapped in Ads Manager). These two
 * keys are the sync's own; the statement merges them into `app_meta` and leaves every other key (`boost_id`, `proposal_id`, an offer) alone.
 */
async function relinkSyncKeys(tx: Exec, creatorId: string, rows: { id: string; creative: string | null }[]): Promise<void> {
    if (rows.length === 0) return;
    await tx.query(
        `UPDATE ads_objects o
            SET app_meta = (o.app_meta - 'sync_missing') || CASE WHEN v.creative IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('creative_id', v.creative) END
           FROM unnest($1::uuid[], $2::text[]) AS v(id, creative)
          WHERE o.id = v.id AND o.creator_id = $3
            AND (o.app_meta ? 'sync_missing' OR (v.creative IS NOT NULL AND o.app_meta->>'creative_id' IS DISTINCT FROM v.creative))`,
        [rows.map((r) => r.id), rows.map((r) => r.creative), creatorId]
    );
}

/** What a miss does to a row: the next count, and whether that count deletes it. Pure, so the rule has a test of its own. */
export function missDecision(current: unknown): { next: number; deleted: boolean } {
    const next = Math.max(0, Math.floor(n(current))) + 1;
    return { next, deleted: next >= MISSES_TO_DELETE };
}

/**
 * Rows of this ad account at `levels` that Meta did not list in this COMPLETE structure sync. The first miss only counts it; the second
 * in a row sets `status` and `effective_status` to DELETED. Call it only when every page was read. Drafts (no Meta id yet) and rows
 * already DELETED are left alone. Returns how many rows were marked DELETED now.
 */
export async function markMissing(creatorId: string, adAccountId: string, seenMetaIds: Set<string>, levels: readonly ObjectLevel[]): Promise<number> {
    if (levels.length === 0) return 0;
    const rows = await queryRows<{ id: string; missing: string | null }>(
        `SELECT id, app_meta->>'sync_missing' AS missing FROM ads_objects
          WHERE creator_id = $1 AND ad_account_id = $2 AND level = ANY($3::text[]) AND meta_id IS NOT NULL
            AND NOT (meta_id = ANY($4::text[])) AND status IS DISTINCT FROM 'DELETED'`,
        [creatorId, adAccountId, [...levels], [...seenMetaIds]]
    );
    if (rows.length === 0) return 0;
    const counting: string[] = [];
    const deleting: { id: string; next: number }[] = [];
    for (const r of rows) {
        const d = missDecision(r.missing);
        if (d.deleted) deleting.push({ id: r.id, next: d.next });
        else counting.push(r.id);
    }
    await withTransaction(async (tx) => {
        if (counting.length > 0) {
            await tx.query(
                `UPDATE ads_objects SET app_meta = jsonb_set(app_meta, '{sync_missing}', '1'::jsonb), updated_at = NOW() WHERE id = ANY($1::uuid[]) AND creator_id = $2`,
                [counting, creatorId]
            );
        }
        if (deleting.length > 0) {
            await tx.query(
                `UPDATE ads_objects o
                    SET status = 'DELETED', effective_status = 'DELETED', app_meta = jsonb_set(o.app_meta, '{sync_missing}', to_jsonb(v.next)), updated_at = NOW()
                   FROM unnest($1::uuid[], $2::int[]) AS v(id, next)
                  WHERE o.id = v.id AND o.creator_id = $3`,
                [deleting.map((d) => d.id), deleting.map((d) => d.next), creatorId]
            );
        }
    });
    return deleting.length;
}

// ─── Insights: writes ───────────────────────────────────────────────────────────────────────

/**
 * Upsert days of results; the same (tenant, level, object, day) is overwritten, so the trailing 28 days are simply rewritten each day.
 * One statement per 500 rows (`jsonb_to_recordset`: one bound parameter however many rows), the last of two rows with the same key wins.
 */
export async function upsertInsights(rows: InsightRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const unique = new Map<string, InsightRow>();
    for (const r of rows) unique.set(`${r.creatorId}|${r.level}|${r.metaId}|${r.day}`, r);
    const all = [...unique.values()];
    for (let i = 0; i < all.length; i += INSIGHT_CHUNK) {
        const chunk = all.slice(i, i + INSIGHT_CHUNK).map((r) => ({
            creator_id: r.creatorId, level: r.level, meta_id: r.metaId, day: r.day, currency: r.currency, spend: r.spend, impressions: r.impressions,
            reach: r.reach, clicks: r.clicks, link_clicks: r.linkClicks, conversations_started: r.conversationsStarted, first_replies: r.firstReplies,
            leads: r.leads, follows: r.follows, video_views: r.videoViews, actions: r.actions, attribution: r.attribution, provisional: r.provisional,
        }));
        await withTransaction(async (tx) => {
            await tx.query(
                `INSERT INTO ads_insights_daily (creator_id, level, meta_id, day, currency, spend, impressions, reach, clicks, link_clicks,
                                                 conversations_started, first_replies, leads, follows, video_views, actions, attribution, provisional, synced_at)
                 SELECT x.creator_id, x.level, x.meta_id, x.day, x.currency, x.spend, x.impressions, x.reach, x.clicks, x.link_clicks,
                        x.conversations_started, x.first_replies, x.leads, x.follows, x.video_views, x.actions, x.attribution, x.provisional, NOW()
                   FROM jsonb_to_recordset($1::jsonb) AS x(creator_id uuid, level text, meta_id text, day date, currency text, spend numeric,
                        impressions bigint, reach bigint, clicks bigint, link_clicks bigint, conversations_started int, first_replies int,
                        leads int, follows int, video_views int, actions jsonb, attribution text, provisional boolean)
                 ON CONFLICT (creator_id, level, meta_id, day) DO UPDATE SET
                     currency = EXCLUDED.currency, spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, reach = EXCLUDED.reach,
                     clicks = EXCLUDED.clicks, link_clicks = EXCLUDED.link_clicks, conversations_started = EXCLUDED.conversations_started,
                     first_replies = EXCLUDED.first_replies, leads = EXCLUDED.leads, follows = EXCLUDED.follows, video_views = EXCLUDED.video_views,
                     actions = EXCLUDED.actions, attribution = EXCLUDED.attribution, provisional = EXCLUDED.provisional, synced_at = NOW()`,
                [JSON.stringify(chunk)]
            );
        });
    }
    return all.length;
}

// ─── Breakdowns: writes ─────────────────────────────────────────────────────────────────────

export type BreakdownKind = 'country' | 'placement';

/** One day of one object's results split by country (`key` an ISO code) or placement (`key` `<publisher_platform>:<platform_position>`). */
export interface BreakdownRow {
    creatorId: string;
    level: 'campaign' | 'adset' | 'ad';
    metaId: string;
    day: string;
    breakdown: BreakdownKind;
    key: string;
    currency: string;
    spend: number;
    impressions: number;
    clicks: number;
    linkClicks: number;
    conversationsStarted: number;
    leads: number;
    follows: number | null;
    provisional: boolean;
}

let breakdownTableMissing = false;

/** True once an upsert found no `ads_insights_breakdown` table (a deploy before its migration): the sync stops reading breakdowns that cannot be stored. */
export function breakdownsUnavailable(): boolean {
    return breakdownTableMissing;
}

/**
 * Upsert breakdown rows. The table is created by a later migration than v53; until it exists the write is skipped, once-logged, and 0 is
 * returned (Postgres 42P01, undefined_table), so the daily sync still stores everything else. Any other error is thrown.
 */
export async function upsertBreakdowns(rows: BreakdownRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const unique = new Map<string, BreakdownRow>();
    for (const r of rows) unique.set(`${r.creatorId}|${r.level}|${r.metaId}|${r.day}|${r.breakdown}|${r.key}`, r);
    const all = [...unique.values()];
    try {
        for (let i = 0; i < all.length; i += INSIGHT_CHUNK) {
            const chunk = all.slice(i, i + INSIGHT_CHUNK).map((r) => ({
                creator_id: r.creatorId, level: r.level, meta_id: r.metaId, day: r.day, breakdown: r.breakdown, key: r.key, currency: r.currency,
                spend: r.spend, impressions: r.impressions, clicks: r.clicks, link_clicks: r.linkClicks, conversations_started: r.conversationsStarted,
                leads: r.leads, follows: r.follows, provisional: r.provisional,
            }));
            await withTransaction(async (tx) => {
                await tx.query(
                    `INSERT INTO ads_insights_breakdown (creator_id, level, meta_id, day, breakdown, key, currency, spend, impressions, clicks, link_clicks,
                                                         conversations_started, leads, follows, provisional, synced_at)
                     SELECT x.creator_id, x.level, x.meta_id, x.day, x.breakdown, x.key, x.currency, x.spend, x.impressions, x.clicks, x.link_clicks,
                            x.conversations_started, x.leads, x.follows, x.provisional, NOW()
                       FROM jsonb_to_recordset($1::jsonb) AS x(creator_id uuid, level text, meta_id text, day date, breakdown text, key text, currency text,
                            spend numeric, impressions bigint, clicks bigint, link_clicks bigint, conversations_started int, leads int, follows int, provisional boolean)
                     ON CONFLICT (creator_id, level, meta_id, day, breakdown, key) DO UPDATE SET
                         currency = EXCLUDED.currency, spend = EXCLUDED.spend, impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
                         link_clicks = EXCLUDED.link_clicks, conversations_started = EXCLUDED.conversations_started, leads = EXCLUDED.leads,
                         follows = EXCLUDED.follows, provisional = EXCLUDED.provisional, synced_at = NOW()`,
                    [JSON.stringify(chunk)]
                );
            });
        }
    } catch (err) {
        if ((err as { code?: unknown } | null)?.code !== '42P01') throw err;
        if (!breakdownTableMissing) log('warn', 'ads.breakdown_table_missing', { hint: 'ads_insights_breakdown does not exist yet; breakdowns are not stored.' });
        breakdownTableMissing = true;
        return 0;
    }
    return all.length;
}

/** Tests only: forget that the table was missing. */
export function resetBreakdownAvailability(): void {
    breakdownTableMissing = false;
}

// ─── Objects: reads ─────────────────────────────────────────────────────────────────────────

interface DbObject {
    id: string;
    creator_id: string;
    ad_account_id: string;
    level: ObjectLevel;
    meta_id: string | null;
    parent_id: string | null;
    name: string | null;
    origin: ObjectOrigin;
    status: string | null;
    effective_status: string | null;
    objective: string | null;
    destination_type: string | null;
    optimization_goal: string | null;
    budget_kind: 'daily' | 'lifetime' | 'none';
    budget_amount: string | number | null;
    currency: string;
    start_time: Date | string | null;
    end_time: Date | string | null;
    targeting_summary: Record<string, unknown> | null;
    review: Record<string, unknown> | null;
    app_meta: Record<string, unknown> | null;
    raw: Record<string, unknown> | null;
    synced_at: Date | string | null;
}

const OBJECT_COLUMNS = `id, creator_id, ad_account_id, level, meta_id, parent_id, name, origin, status, effective_status, objective, destination_type,
    optimization_goal, budget_kind, budget_amount, currency, start_time, end_time, targeting_summary, review, app_meta, raw, synced_at`;

export function toObjectRow(r: DbObject): ObjectRow {
    return {
        id: r.id,
        creatorId: r.creator_id,
        adAccountId: r.ad_account_id,
        level: r.level,
        metaId: r.meta_id,
        parentId: r.parent_id,
        name: r.name,
        origin: r.origin,
        status: r.status,
        effectiveStatus: r.effective_status,
        objective: r.objective,
        destinationType: r.destination_type,
        optimizationGoal: r.optimization_goal,
        budgetKind: r.budget_kind,
        budgetAmount: r.budget_amount === null || r.budget_amount === undefined ? null : Number(r.budget_amount),
        currency: r.currency,
        startTime: iso(r.start_time),
        endTime: iso(r.end_time),
        targetingSummary: obj(r.targeting_summary),
        review: obj(r.review),
        appMeta: obj(r.app_meta) ?? {},
        raw: obj(r.raw),
        syncedAt: iso(r.synced_at),
    };
}

export interface ListFilter {
    level?: ObjectLevel;
    /** Configured statuses (`ACTIVE`, `PAUSED`, `ARCHIVED`, `DELETED`). Without it, deleted rows are left out. */
    status?: string[];
    parentId?: string;
}

const LIST_LIMIT = 500;

/**
 * The rows a screen lists, newest first. Creatives are internal (an ad points at one) and are listed only when asked for by level.
 * Filters on the CONFIGURED `status`: it is what the owner set and what the tabs are named after; Meta's delivery state is shown, not filtered.
 */
export async function listObjects(creatorId: string, filter: ListFilter = {}): Promise<ObjectRow[]> {
    const where = ['creator_id = $1'];
    const params: unknown[] = [creatorId];
    if (filter.level) {
        params.push(filter.level);
        where.push(`level = $${params.length}`);
    } else {
        where.push("level <> 'creative'");
    }
    if (filter.status && filter.status.length > 0) {
        params.push(filter.status.map((s) => s.toUpperCase()));
        where.push(`status = ANY($${params.length}::text[])`);
    } else {
        where.push("status IS DISTINCT FROM 'DELETED'");
    }
    if (filter.parentId !== undefined) {
        if (!UUID.test(filter.parentId)) return [];
        params.push(filter.parentId);
        where.push(`parent_id = $${params.length}`);
    }
    const rows = await queryRows<DbObject>(
        `SELECT ${OBJECT_COLUMNS} FROM ads_objects WHERE ${where.join(' AND ')} ORDER BY COALESCE(start_time, created_at) DESC, id LIMIT ${LIST_LIMIT}`,
        params as never[]
    );
    return rows.map(toObjectRow);
}

/** One row of this tenant by the app's id (a uuid) or by Meta's id (digits): a route may be given either. */
export async function getObject(creatorId: string, id: string): Promise<ObjectRow | null> {
    const byUuid = UUID.test(id);
    if (!byUuid && !/^[0-9]{5,25}$/.test(id)) return null;
    const row = await queryOne<DbObject>(
        `SELECT ${OBJECT_COLUMNS} FROM ads_objects WHERE ${byUuid ? 'id = $2::uuid' : 'meta_id = $2'} AND creator_id = $1 LIMIT 1`,
        [creatorId, id]
    );
    return row ? toObjectRow(row) : null;
}

/** The ad sets of a campaign, or the ads of an ad set; deleted ones are left out. */
export async function childrenOf(creatorId: string, id: string): Promise<ObjectRow[]> {
    if (!UUID.test(id)) return [];
    const rows = await queryRows<DbObject>(
        `SELECT ${OBJECT_COLUMNS} FROM ads_objects WHERE creator_id = $1 AND parent_id = $2 AND status IS DISTINCT FROM 'DELETED'
          ORDER BY COALESCE(start_time, created_at) DESC, id LIMIT ${LIST_LIMIT}`,
        [creatorId, id]
    );
    return rows.map(toObjectRow);
}

/** When the tenant's stored copy was last refreshed from Meta (ISO), or null before the first sync. */
export async function lastSyncedAt(creatorId: string): Promise<string | null> {
    const row = await queryOne<{ at: Date | string | null }>('SELECT MAX(synced_at) AS at FROM ads_objects WHERE creator_id = $1', [creatorId]);
    return iso(row?.at);
}

// ─── Insights: reads ────────────────────────────────────────────────────────────────────────

interface DailySum {
    object_id: string;
    day: string;
    spend: string | null;
    impressions: string | null;
    clicks: string | null;
    link_clicks: string | null;
    conversations: string | null;
    first_replies: string | null;
    leads: string | null;
}

const emptyTotals = (): ResultTotals => ({ spend: 0, impressions: 0, reach: null, clicks: 0, linkClicks: 0, conversations: 0, firstReplies: 0, leads: 0 });

/**
 * Results of `metaIds` (all at `level`) from `fromDay` to `toDay`, both inclusive, as the ad account's days.
 *
 * Only `ad` rows carry the full numbers, so an ad set's or campaign's are the sums of its ads' rows (joined through the stored parent
 * links). Reach is the exception: it is read from the object's own row, per day in `daily`, and in `totals` only when the range is one
 * day; a range of several days has no valid total (see the file's header), so it is null rather than a sum that overstates.
 */
export async function resultsFor(creatorId: string, level: ObjectLevel, metaIds: string[], fromDay: string, toDay: string): Promise<{ daily: DailyResults[]; totals: Map<string, ResultTotals> }> {
    const totals = new Map<string, ResultTotals>(metaIds.map((id) => [id, emptyTotals()]));
    if (metaIds.length === 0 || level === 'creative') return { daily: [], totals };

    const owner = level === 'ad' ? 'i.meta_id' : level === 'adset' ? 's.meta_id' : 'c.meta_id';
    const joins =
        level === 'ad'
            ? ''
            : `JOIN ads_objects a ON a.creator_id = i.creator_id AND a.level = 'ad' AND a.meta_id = i.meta_id
               JOIN ads_objects s ON s.id = a.parent_id AND s.creator_id = i.creator_id` + (level === 'campaign' ? ' JOIN ads_objects c ON c.id = s.parent_id AND c.creator_id = i.creator_id' : '');
    const sums = await queryRows<DailySum>(
        `SELECT ${owner} AS object_id, i.day::text AS day, SUM(i.spend)::text AS spend, SUM(i.impressions)::text AS impressions,
                SUM(i.clicks)::text AS clicks, SUM(i.link_clicks)::text AS link_clicks, SUM(i.conversations_started)::text AS conversations,
                SUM(i.first_replies)::text AS first_replies, SUM(i.leads)::text AS leads
           FROM ads_insights_daily i ${joins}
          WHERE i.creator_id = $1 AND i.level = 'ad' AND ${owner} = ANY($2::text[]) AND i.day BETWEEN $3::date AND $4::date
          GROUP BY ${owner}, i.day ORDER BY i.day, ${owner}`,
        [creatorId, metaIds, fromDay, toDay]
    );
    const reachRows = await queryRows<{ meta_id: string; day: string; reach: string | null }>(
        `SELECT meta_id, day::text AS day, reach::text AS reach FROM ads_insights_daily
          WHERE creator_id = $1 AND level = $2 AND meta_id = ANY($3::text[]) AND day BETWEEN $4::date AND $5::date`,
        [creatorId, level, metaIds, fromDay, toDay]
    );
    const reachBy = new Map(reachRows.map((r) => [`${r.meta_id}|${r.day}`, n(r.reach)]));

    const daily: DailyResults[] = sums.map((r) => ({
        metaId: r.object_id,
        day: r.day,
        spend: roundMoney(n(r.spend)),
        impressions: n(r.impressions),
        reach: reachBy.get(`${r.object_id}|${r.day}`) ?? null,
        clicks: n(r.clicks),
        linkClicks: n(r.link_clicks),
        conversations: n(r.conversations),
        firstReplies: n(r.first_replies),
        leads: n(r.leads),
    }));
    for (const d of daily) {
        const t = totals.get(d.metaId) ?? emptyTotals();
        t.spend = roundMoney(t.spend + d.spend);
        t.impressions += d.impressions;
        t.clicks += d.clicks;
        t.linkClicks += d.linkClicks;
        t.conversations += d.conversations;
        t.firstReplies += d.firstReplies;
        t.leads += d.leads;
        totals.set(d.metaId, t);
    }
    if (fromDay === toDay) for (const [metaId, t] of totals) t.reach = reachBy.get(`${metaId}|${fromDay}`) ?? null;
    return { daily, totals };
}

/**
 * What the account spent today and this month, from the stored copy. Per day, the account's own row wins (Meta's number for the whole
 * account, also spend on ads we do not list); a day without one is the sum of the ads' rows. `provisionalFrom` is the earliest day in the
 * range Meta may still revise; `syncedAt` the oldest refresh of the rows used (the figure is only as fresh as that).
 */
export async function spendFromMirror(creatorId: string, adAccountId: string, todayDay: string, monthStartDay: string): Promise<{ spentToday: number; spentThisMonth: number; provisionalFrom: string | null; syncedAt: string | null }> {
    const accountRows = await queryRows<{ day: string; spend: string | null; provisional: boolean; synced_at: Date | string | null }>(
        `SELECT day::text AS day, spend::text AS spend, provisional, synced_at FROM ads_insights_daily
          WHERE creator_id = $1 AND level = 'account' AND meta_id = $2 AND day BETWEEN $3::date AND $4::date`,
        [creatorId, adAccountId, monthStartDay, todayDay]
    );
    const adRows = await queryRows<{ day: string; spend: string | null; provisional: boolean; synced_at: Date | string | null }>(
        `SELECT i.day::text AS day, SUM(i.spend)::text AS spend, BOOL_OR(i.provisional) AS provisional, MIN(i.synced_at) AS synced_at
           FROM ads_insights_daily i
           JOIN ads_objects a ON a.creator_id = i.creator_id AND a.level = 'ad' AND a.meta_id = i.meta_id AND a.ad_account_id = $2
          WHERE i.creator_id = $1 AND i.level = 'ad' AND i.day BETWEEN $3::date AND $4::date
          GROUP BY i.day`,
        [creatorId, adAccountId, monthStartDay, todayDay]
    );
    const byDay = new Map<string, { cents: number; provisional: boolean; syncedAt: string | null }>();
    for (const r of adRows) byDay.set(r.day, { cents: Math.round(n(r.spend) * 100), provisional: Boolean(r.provisional), syncedAt: iso(r.synced_at) });
    for (const r of accountRows) byDay.set(r.day, { cents: Math.round(n(r.spend) * 100), provisional: Boolean(r.provisional), syncedAt: iso(r.synced_at) });

    let month = 0;
    let provisionalFrom: string | null = null;
    let oldest: string | null = null;
    for (const [day, v] of byDay) {
        month += v.cents;
        if (v.provisional && (provisionalFrom === null || day < provisionalFrom)) provisionalFrom = day;
        if (v.syncedAt && (oldest === null || v.syncedAt < oldest)) oldest = v.syncedAt;
    }
    return { spentToday: (byDay.get(todayDay)?.cents ?? 0) / 100, spentThisMonth: month / 100, provisionalFrom, syncedAt: oldest };
}

// ─── The view ───────────────────────────────────────────────────────────────────────────────

/**
 * Why Meta is not delivering this object, in the words Meta gave: `issues_info` (`error_summary`, else `error_message`) and
 * `ad_review_feedback` (a policy code, with Meta's explanation when it is a sentence rather than a bare number). Deduplicated, at most 6.
 */
export function reviewReasons(review: Record<string, unknown> | null): string[] {
    if (!review) return [];
    const out: string[] = [];
    const issues = review['issues_info'];
    if (Array.isArray(issues)) {
        for (const i of issues) {
            const o = obj(i);
            const text = o && (typeof o['error_summary'] === 'string' ? o['error_summary'] : typeof o['error_message'] === 'string' ? o['error_message'] : null);
            if (text) out.push(text);
        }
    }
    const feedback = obj(review['ad_review_feedback']);
    if (feedback) {
        for (const group of Object.values(feedback)) {
            const g = obj(group);
            if (!g) continue;
            for (const [code, why] of Object.entries(g)) out.push(typeof why === 'string' && why.trim() !== '' && !/^\d+$/.test(why) ? why : code);
        }
    }
    return [...new Set(out)].slice(0, 6);
}

function learningOf(review: Record<string, unknown> | null): string | null {
    const status = obj(review?.['learning_stage_info'])?.['status'];
    return typeof status === 'string' && status ? status : null;
}

/** An ad's creative from the creative Meta nested under it (`raw.creative`), or a creative row's own `raw`. */
function creativeOf(row: ObjectRow): ObjectView['creative'] {
    const c = row.level === 'creative' ? row.raw : row.level === 'ad' ? obj(row.raw?.['creative']) : null;
    if (!c) return null;
    const post = typeof c['effective_instagram_media_id'] === 'string' && c['effective_instagram_media_id'] ? c['effective_instagram_media_id'] : typeof c['object_story_id'] === 'string' && c['object_story_id'] ? c['object_story_id'] : null;
    const kind = post ? 'post' : c['asset_feed_spec'] ? 'dynamic' : 'media';
    return { kind, thumbUrl: typeof c['thumbnail_url'] === 'string' ? c['thumbnail_url'] : null, ...(post ? { postId: post } : {}) };
}

/** The number a row is optimised for, so "results" means the same thing the owner chose in Ads Manager. Null when nothing was achieved. */
export function resultOf(goal: string | null, t: ResultTotals): number | null {
    const pick = (): number => {
        switch (goal) {
            case 'CONVERSATIONS': return t.conversations;
            case 'LEAD_GENERATION': case 'QUALITY_LEAD': return t.leads;
            case 'LINK_CLICKS': case 'LANDING_PAGE_VIEWS': return t.linkClicks;
            case 'REACH': return t.reach ?? 0;
            case 'IMPRESSIONS': return t.impressions;
            default: return t.conversations > 0 ? t.conversations : t.leads > 0 ? t.leads : t.linkClicks;
        }
    };
    const v = pick();
    return v > 0 ? v : null;
}

const per = (spend: number, count: number | null): number | null => (count && count > 0 ? roundMoney(spend / count) : null);

export interface ViewExtras {
    results?: ResultTotals | null;
    /** `editsLeftThisHour` of the ad set (4 minus the budget ops done in the last hour), when this row is an ad set. */
    editsLeftThisHour?: number | null;
    queuedOps?: QueuedOp[];
    /** A3: the app-side results of an ad (`resultsByAd`), when this row is an ad. */
    app?: { conversations: number; trackedClicks: number; handoffs: number } | null;
}

/** What the dashboard receives (contracts/dashboard-api.md): the stored row, plus results and queued ops the route read separately. */
export function toObjectView(row: ObjectRow, extras: ViewExtras = {}): ObjectView {
    const ended = row.status === 'ARCHIVED' || row.status === 'DELETED';
    const t = extras.results ?? null;
    const boostId = typeof row.appMeta['boost_id'] === 'string' ? (row.appMeta['boost_id'] as string) : null;
    return {
        id: row.id,
        level: row.level,
        metaId: row.metaId,
        name: row.name ?? row.metaId ?? '',
        origin: row.origin,
        status: row.status,
        effectiveStatus: row.effectiveStatus,
        effectiveLabel: effectiveLabelKey(row.effectiveStatus),
        review: { reasons: reviewReasons(row.review), learning: learningOf(row.review) },
        objective: row.objective,
        destinationType: row.destinationType,
        optimizationGoal: row.optimizationGoal,
        budget: {
            kind: row.budgetKind,
            amount: row.budgetAmount,
            currency: row.currency,
            editable: row.budgetKind !== 'none' && !ended,
            editsLeftThisHour: extras.editsLeftThisHour ?? null,
        },
        schedule: { start: row.startTime, end: row.endTime },
        targetingSummary: row.targetingSummary,
        creative: creativeOf(row),
        appMeta: boostId ? { boostId } : {},
        results: t
            ? {
                  spend: t.spend,
                  impressions: t.impressions,
                  reach: t.reach,
                  linkClicks: t.linkClicks,
                  conversations: t.conversations,
                  costPerConversation: per(t.spend, t.conversations),
                  results: resultOf(row.optimizationGoal, t),
                  costPerResult: per(t.spend, resultOf(row.optimizationGoal, t)),
                  appConversations: extras.app?.conversations ?? 0,
                  trackedClicks: extras.app?.trackedClicks ?? 0,
                  handoffs: extras.app?.handoffs ?? 0,
                  costPerTrackedClick: per(t.spend, extras.app?.trackedClicks ?? 0),
              }
            : null,
        queued: (extras.queuedOps ?? []).filter((o) => o.state === 'pending' || o.state === 'running' || o.state === 'verify'),
        parentId: row.parentId,
        syncedAt: row.syncedAt,
    };
}

// ─── Forgetting ─────────────────────────────────────────────────────────────────────────────

/**
 * Ads disconnected (the token removed, or the ad account switched): the stored copy and the results go (Platform Terms §3.d; privacy.html
 * says so), and queued changes that have not been sent are cancelled. The op history stays for its 180 days, as an audit of what was sent;
 * `ad_boosts` keeps its spend records, as v1's privacy text states. Tracked links lose their `ads_object_id` (SET NULL), not their clicks.
 */
export async function forgetStoredCopy(creatorId: string): Promise<{ objects: number; results: number }> {
    const objects = await queryCount('DELETE FROM ads_objects WHERE creator_id = $1', [creatorId]);
    const results = await queryCount('DELETE FROM ads_insights_daily WHERE creator_id = $1', [creatorId]);
    await queryCount('DELETE FROM ads_insights_breakdown WHERE creator_id = $1', [creatorId]).catch((err: unknown) => {
        if ((err as { code?: unknown } | null)?.code !== '42P01') throw err;
        return 0;
    });
    await queryCount("UPDATE ads_ops SET state = 'cancelled', finished_at = NOW() WHERE creator_id = $1 AND state = 'pending'", [creatorId]);
    return { objects, results };
}
