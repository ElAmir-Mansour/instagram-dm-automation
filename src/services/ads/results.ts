/**
 * `GET /api/ads/results` (A6, Results history): what the Results tab and the ad rows read. Postgres only, never Meta: the ingest
 * (migration v53's `ads_insights_daily` / `ads_insights_breakdown`) already stored what Meta said, and this folds it into the shape the
 * screens draw.
 *
 * Ingest syncs only `level = 'ad'` rows for metrics (account / campaign / ad set rows exist only for their own reach). So a campaign, ad set or
 * account figure is the SUM of its ads' rows, walked up through `ads_objects.parent_id` (ad → ad set → campaign). Reach is not additive and is
 * taken only from a row at the requested level itself, else null. `results` is "the thing this ad was bought for" (`resultKindOf`), counted per
 * ad with that ad's own kind and then summed: a campaign with a conversations ad and a link-click ad adds one of each, it does not pick one.
 *
 * Meta cannot see a purchase made on another website, so there is no sales-based figure anywhere in this file or in what it returns. What the app itself knows is
 * joined in from its own tables instead (the "app joins"): the tracked links people tapped (`link_clicks`, people only), and the conversations
 * that started from an ad (`conversations.entry_source->>'ad_id'`) and were handed to a person.
 *
 *   - Days are the AD ACCOUNT's time zone (stored `day` already is). The app's own clicks are bucketed the same way, with the zone from the
 *     stored ads settings (`timezone`), or 'UTC' when none is stored or it is not a zone Postgres knows.
 *   - Money is never summed across currencies: rows keep their currency and `totals.byCurrency` has one entry per currency.
 *   - Rows of the last three days are `provisional` (Meta restates them for about 28 days); `provisionalFrom` is the earliest such day.
 *   - A database that has not had the v53 migration yet answers empty, not 500; so does a missing app-join column.
 */
import { queryRows } from '../../db/query.js';
import { isMissingSchema } from '../health.js';
import { readHealth } from './settings.js';
import { describeError, log } from '../../utils/log.js';

export const RESULT_LEVELS = ['account', 'campaign', 'adset', 'ad'] as const;
export type ResultLevel = (typeof RESULT_LEVELS)[number];
export const RESULT_BREAKDOWNS = ['country', 'placement'] as const;
export type ResultBreakdown = (typeof RESULT_BREAKDOWNS)[number];
export type ResultKind = 'conversations' | 'link_clicks' | 'leads' | 'follows';

/** An account-level answer has one object, whose id is this. */
export const ACCOUNT_ID = 'account';
export const DEFAULT_SPAN_DAYS = 28;
export const MAX_SPAN_DAYS = 400;
export const MAX_IDS = 200;

/** A bad `GET /results` query. The route answers it 400 `{ error, code: 'INVALID', field }`. */
export class ResultsQueryError extends Error {
    constructor(message: string, readonly field: string) {
        super(message);
        this.name = 'ResultsQueryError';
    }
}

export interface ResultsQuery {
    level: ResultLevel;
    ids: string[];
    from: string | null;
    to: string | null;
    breakdown: ResultBreakdown | null;
}

// ─── The query ────────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

function isDay(value: string): boolean {
    if (!DAY_PATTERN.test(value)) return false;
    const t = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function addDays(day: string, n: number): string {
    return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

const spanDays = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** One query-string value as text: Express hands an array for a repeated key, so those are joined. */
function text(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const s = Array.isArray(value) ? value.map(String).join(',') : typeof value === 'string' ? value : String(value);
    return s.trim() === '' ? null : s.trim();
}

/** Checks every field before anything is read. Throws `ResultsQueryError` naming the field. */
export function parseResultsQuery(raw: unknown): ResultsQuery {
    const q = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    const levelText = text(q['level']);
    if (levelText !== null && !(RESULT_LEVELS as readonly string[]).includes(levelText)) {
        throw new ResultsQueryError('level must be account, campaign, adset or ad.', 'level');
    }
    const level = (levelText ?? 'account') as ResultLevel;

    const idsText = text(q['ids']);
    const ids = idsText === null ? [] : [...new Set(idsText.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > MAX_IDS || ids.some((id) => !ID_PATTERN.test(id))) {
        throw new ResultsQueryError(`ids must be at most ${MAX_IDS} comma-separated ids.`, 'ids');
    }

    const from = text(q['from']);
    const to = text(q['to']);
    if (from !== null && !isDay(from)) throw new ResultsQueryError('from must be a day as YYYY-MM-DD.', 'from');
    if (to !== null && !isDay(to)) throw new ResultsQueryError('to must be a day as YYYY-MM-DD.', 'to');
    if (from !== null && to !== null) {
        if (from > to) throw new ResultsQueryError('from must not be after to.', 'from');
        if (spanDays(from, to) > MAX_SPAN_DAYS) throw new ResultsQueryError(`The range can be at most ${MAX_SPAN_DAYS} days.`, 'from');
    }

    const breakdownText = text(q['breakdown']);
    if (breakdownText !== null && !(RESULT_BREAKDOWNS as readonly string[]).includes(breakdownText)) {
        throw new ResultsQueryError('breakdown must be country or placement.', 'breakdown');
    }

    return { level, ids, from, to, breakdown: (breakdownText as ResultBreakdown | null) ?? null };
}

/** The window: what was asked, else the 28 days ending on the latest stored day (today, UTC, when nothing is stored). */
export function resolveRange(query: Pick<ResultsQuery, 'from' | 'to'>, latestDay: string | null, today: string): { from: string; to: string } {
    const to = query.to ?? (query.from === null ? latestDay ?? today : null) ?? (() => {
        // Only `from` was given: 28 days from it, but never past the latest stored day.
        const end = addDays(query.from!, DEFAULT_SPAN_DAYS - 1);
        return latestDay !== null && latestDay >= query.from! && latestDay < end ? latestDay : end;
    })();
    const from = query.from ?? addDays(to, -(DEFAULT_SPAN_DAYS - 1));
    return { from, to };
}

// ─── Result kinds ─────────────────────────────────────────────────────────────────────────────

export interface KindFields {
    optimizationGoal: string | null;
    objective: string | null;
    destinationType: string | null;
}

const upper = (v: string | null | undefined): string => (v ?? '').trim().toUpperCase();

/**
 * What this ad was bought for. The ad set's optimisation goal says it best; where the goal does not (REACH, IMPRESSIONS, a goal Meta added
 * later) the campaign objective decides, and an engagement campaign that sends to a profile is about follows rather than conversations.
 * Anything unknown is link clicks, the figure every ad has.
 */
export function resultKindOf({ optimizationGoal, objective, destinationType }: KindFields): ResultKind {
    const goal = upper(optimizationGoal);
    const obj = upper(objective);
    const destination = upper(destinationType);
    if (goal === 'CONVERSATIONS' || goal === 'REPLIES') return 'conversations';
    if (goal === 'LINK_CLICKS' || goal === 'LANDING_PAGE_VIEWS') return 'link_clicks';
    if (goal === 'LEAD_GENERATION' || goal === 'QUALITY_LEAD') return 'leads';
    if (goal === 'PROFILE_VISIT' || goal.includes('FOLLOW') || goal === 'PAGE_LIKES') return 'follows';
    const toProfile = /^(ON_PAGE|ON_PROFILE|PROFILE|INSTAGRAM_PROFILE)$/.test(destination);
    if (obj === 'OUTCOME_ENGAGEMENT') return toProfile ? 'follows' : 'conversations';
    if (obj === 'OUTCOME_LEADS') return 'leads';
    if (obj === 'OUTCOME_TRAFFIC') return 'link_clicks';
    return 'link_clicks';
}

// ─── Rows ─────────────────────────────────────────────────────────────────────────────────────

interface ObjectRow {
    id: string;
    meta_id: string | null;
    level: string;
    parent_id: string | null;
    name: string | null;
    effective_status: string | null;
    objective: string | null;
    optimization_goal: string | null;
    destination_type: string | null;
    currency: string | null;
}

interface InsightRow {
    meta_id: string;
    day: string;
    key?: string;
    currency: string | null;
    spend: unknown;
    impressions: unknown;
    reach?: unknown;
    clicks: unknown;
    link_clicks: unknown;
    conversations_started: unknown;
    first_replies?: unknown;
    leads: unknown;
    follows: unknown;
    provisional: unknown;
    synced_at: unknown;
}

interface ReachRow { meta_id: string; day: string; reach: unknown; synced_at: unknown }
interface DirectRow { day: string; app_id: string; n: unknown }
interface MetaCountRow { day: string; meta_id: string; n: unknown }

export interface ResultsInput {
    query: ResultsQuery;
    from: string;
    to: string;
    objects: readonly ObjectRow[];
    daily: readonly InsightRow[];
    ownReach: readonly ReachRow[];
    breakdownRows: readonly InsightRow[];
    direct: readonly DirectRow[];
    viaChat: readonly MetaCountRow[];
    handoffs: readonly MetaCountRow[];
}

const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const costPer = (spend: number, count: number | null): number | null => (count === null || count <= 0 ? null : round2(spend / count));
const addNullable = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);

interface AdInfo {
    meta: string;
    appId: string | null;
    name: string | null;
    status: string | null;
    adsetMeta: string | null;
    campaignMeta: string | null;
    kind: ResultKind;
    currency: string | null;
}

/** Every ad (from `ads_objects`, plus any that has rows but no object yet) with the ad set and campaign it rolls up to, and its result kind. */
function resolveAds(objects: readonly ObjectRow[], extraMetas: Iterable<string>): Map<string, AdInfo> {
    const byApp = new Map(objects.map((o) => [o.id, o]));
    const ads = new Map<string, AdInfo>();
    for (const o of objects) {
        if (o.level !== 'ad' || !o.meta_id) continue;
        const adset = o.parent_id ? byApp.get(o.parent_id) : undefined;
        const adsetOk = adset && adset.level === 'adset' ? adset : undefined;
        const campaign = adsetOk?.parent_id ? byApp.get(adsetOk.parent_id) : o.parent_id && adset?.level === 'campaign' ? adset : undefined;
        ads.set(o.meta_id, {
            meta: o.meta_id, appId: o.id, name: o.name, status: o.effective_status,
            adsetMeta: adsetOk?.meta_id ?? null, campaignMeta: campaign?.meta_id ?? null,
            kind: resultKindOf({
                optimizationGoal: adsetOk?.optimization_goal ?? o.optimization_goal,
                objective: campaign?.objective ?? adsetOk?.objective ?? o.objective,
                destinationType: adsetOk?.destination_type ?? o.destination_type ?? campaign?.destination_type ?? null,
            }),
            currency: o.currency,
        });
    }
    for (const meta of extraMetas) {
        if (!ads.has(meta)) ads.set(meta, { meta, appId: null, name: null, status: null, adsetMeta: null, campaignMeta: null, kind: 'link_clicks', currency: null });
    }
    return ads;
}

/** The id an ad's figures land on at `level`; null when its parents are not known (it cannot be placed on a campaign or ad set). */
function idAt(ad: AdInfo, level: ResultLevel): string | null {
    switch (level) {
        case 'ad': return ad.meta;
        case 'adset': return ad.adsetMeta;
        case 'campaign': return ad.campaignMeta;
        case 'account': return ACCOUNT_ID;
    }
}

interface Counts {
    spend: number;
    impressions: number;
    clicks: number;
    linkClicks: number;
    conversations: number;
    firstReplies: number;
    leads: number;
    follows: number | null;
    results: number | null;
}

const zero = (): Counts => ({ spend: 0, impressions: 0, clicks: 0, linkClicks: 0, conversations: 0, firstReplies: 0, leads: 0, follows: null, results: null });

function countsOf(r: InsightRow, kind: ResultKind): Counts {
    const c: Counts = {
        spend: num(r.spend), impressions: num(r.impressions), clicks: num(r.clicks), linkClicks: num(r.link_clicks),
        conversations: num(r.conversations_started), firstReplies: num(r.first_replies), leads: num(r.leads), follows: numOrNull(r.follows), results: null,
    };
    c.results = kind === 'conversations' ? c.conversations : kind === 'link_clicks' ? c.linkClicks : kind === 'leads' ? c.leads : c.follows;
    return c;
}

function addCounts(into: Counts, c: Counts): void {
    into.spend += c.spend;
    into.impressions += c.impressions;
    into.clicks += c.clicks;
    into.linkClicks += c.linkClicks;
    into.conversations += c.conversations;
    into.firstReplies += c.firstReplies;
    into.leads += c.leads;
    into.follows = addNullable(into.follows, c.follows);
    into.results = addNullable(into.results, c.results);
}

export interface ResultsRow {
    day: string;
    id: string;
    key: string | null;
    currency: string | null;
    spend: number;
    impressions: number;
    reach: number | null;
    clicks: number;
    linkClicks: number;
    conversations: number;
    firstReplies: number | null;
    leads: number;
    follows: number | null;
    results: number | null;
    provisional: boolean;
}

export interface ResultsObject {
    id: string;
    appId: string | null;
    level: ResultLevel;
    name: string | null;
    effectiveStatus: string | null;
    resultKind: ResultKind | 'mixed';
}

export interface AppFigures {
    trackedClicks: { direct: number; viaChat: number };
    handoffs: number;
}

export interface CostedTotals extends AppFigures {
    spend: number;
    impressions: number;
    clicks: number;
    linkClicks: number;
    conversations: number;
    leads: number;
    follows: number | null;
    results: number | null;
    costPerResult: number | null;
    costPerConversation: number | null;
    costPerLinkClick: number | null;
    costPerLead: number | null;
    costPerFollow: number | null;
    costPerTrackedClick: number | null;
}

export interface AdsResults {
    level: ResultLevel;
    from: string;
    to: string;
    breakdown: ResultBreakdown | null;
    currency: string | null;
    currencies: string[];
    syncedAt: string | null;
    provisionalFrom: string | null;
    excludesTax: true;
    objects: ResultsObject[];
    rows: ResultsRow[];
    appDaily: { day: string; id: string; trackedDirect: number; trackedViaChat: number; handoffs: number }[];
    perObject: (CostedTotals & { id: string; currency: string | null })[];
    totals: { byCurrency: Record<string, CostedTotals> };
    appJoins: AppFigures;
}

function costed(c: Counts, app: AppFigures): CostedTotals {
    const spend = round2(c.spend);
    return {
        spend, impressions: c.impressions, clicks: c.clicks, linkClicks: c.linkClicks, conversations: c.conversations, leads: c.leads,
        follows: c.follows, results: c.results, trackedClicks: { ...app.trackedClicks }, handoffs: app.handoffs,
        costPerResult: costPer(spend, c.results),
        costPerConversation: costPer(spend, c.conversations),
        costPerLinkClick: costPer(spend, c.linkClicks),
        costPerLead: costPer(spend, c.leads),
        costPerFollow: costPer(spend, c.follows),
        costPerTrackedClick: costPer(spend, app.trackedClicks.direct + app.trackedClicks.viaChat),
    };
}

const noApp = (): AppFigures => ({ trackedClicks: { direct: 0, viaChat: 0 }, handoffs: 0 });

/** Pure: the answer, from rows. */
export function buildResults(input: ResultsInput): AdsResults {
    const { query, from, to } = input;
    const level = query.level;
    // An account has one object, so there is nothing to filter by.
    const ids = level === 'account' ? [] : query.ids;
    const inRange = (day: string): boolean => day >= from && day <= to;

    const metas = new Set<string>();
    for (const r of input.daily) metas.add(r.meta_id);
    for (const r of input.breakdownRows) metas.add(r.meta_id);
    const ads = resolveAds(input.objects, metas);
    const byApp = new Map([...ads.values()].filter((a) => a.appId).map((a) => [a.appId!, a]));

    /** Where an ad's figures land at the requested level, or null when it is outside the answer. */
    const place = (meta: string): { ad: AdInfo; id: string } | null => {
        const ad = ads.get(meta);
        if (!ad) return null;
        const id = idAt(ad, level);
        if (id === null || (ids.length > 0 && !ids.includes(id))) return null;
        return { ad, id };
    };

    // The daily rows, rolled up per (day, object, currency).
    const base = new Map<string, ResultsRow & { counts: Counts }>();
    const currencies = new Set<string>();
    let syncedAt: number | null = null;
    let provisionalFrom: string | null = null;
    const noteRow = (r: InsightRow | ReachRow, provisional: boolean): void => {
        const t = r.synced_at === null || r.synced_at === undefined ? NaN : new Date(r.synced_at as string).getTime();
        if (Number.isFinite(t) && (syncedAt === null || t > syncedAt)) syncedAt = t;
        if (provisional && (provisionalFrom === null || r.day < provisionalFrom)) provisionalFrom = r.day;
    };

    for (const r of input.daily) {
        if (!inRange(r.day)) continue;
        const placed = place(r.meta_id);
        if (!placed) continue;
        const provisional = r.provisional === true;
        noteRow(r, provisional);
        if (r.currency) currencies.add(r.currency);
        const counts = countsOf(r, placed.ad.kind);
        const key = `${r.day}|${placed.id}|${r.currency ?? ''}`;
        let row = base.get(key);
        if (!row) {
            row = {
                day: r.day, id: placed.id, key: null, currency: r.currency ?? null, spend: 0, impressions: 0,
                reach: level === 'ad' ? numOrNull(r.reach) : null, clicks: 0, linkClicks: 0, conversations: 0, firstReplies: 0, leads: 0,
                follows: null, results: null, provisional: false, counts: zero(),
            };
            base.set(key, row);
        }
        addCounts(row.counts, counts);
        row.provisional = row.provisional || provisional;
    }

    // Reach at the requested level's own rows (account, campaign, ad set): not additive, so never a sum of the ads'.
    if (level !== 'ad') {
        const reach = new Map<string, number>();
        for (const r of input.ownReach) {
            if (!inRange(r.day)) continue;
            const id = level === 'account' ? ACCOUNT_ID : r.meta_id;
            if (ids.length > 0 && !ids.includes(id)) continue;
            const value = numOrNull(r.reach);
            if (value === null) continue;
            noteRow(r, false);
            const key = `${r.day}|${id}`;
            reach.set(key, Math.max(reach.get(key) ?? 0, value));
        }
        for (const row of base.values()) row.reach = reach.get(`${row.day}|${row.id}`) ?? null;
    }

    const finishRow = (r: ResultsRow & { counts: Counts }): ResultsRow => {
        const { counts, ...rest } = r;
        return {
            ...rest, spend: round2(counts.spend), impressions: counts.impressions, clicks: counts.clicks, linkClicks: counts.linkClicks,
            conversations: counts.conversations, firstReplies: counts.firstReplies, leads: counts.leads, follows: counts.follows, results: counts.results,
        };
    };
    const order = (a: ResultsRow, b: ResultsRow): number =>
        a.day.localeCompare(b.day) || a.id.localeCompare(b.id) || (a.key ?? '').localeCompare(b.key ?? '') || (a.currency ?? '').localeCompare(b.currency ?? '');
    const baseRows = [...base.values()].sort(order);

    // The app's own joins, per day per object at the requested level.
    const appByDay = new Map<string, { day: string; id: string; trackedDirect: number; trackedViaChat: number; handoffs: number }>();
    const appEntry = (day: string, id: string) => {
        const key = `${day}|${id}`;
        let e = appByDay.get(key);
        if (!e) { e = { day, id, trackedDirect: 0, trackedViaChat: 0, handoffs: 0 }; appByDay.set(key, e); }
        return e;
    };
    for (const r of input.direct) {
        const ad = byApp.get(r.app_id);
        const placed = ad && inRange(r.day) ? place(ad.meta) : null;
        if (placed) appEntry(r.day, placed.id).trackedDirect += num(r.n);
    }
    for (const r of input.viaChat) {
        const placed = inRange(r.day) ? place(r.meta_id) : null;
        if (placed) appEntry(r.day, placed.id).trackedViaChat += num(r.n);
    }
    for (const r of input.handoffs) {
        const placed = inRange(r.day) ? place(r.meta_id) : null;
        if (placed) appEntry(r.day, placed.id).handoffs += num(r.n);
    }
    const appDaily = [...appByDay.values()].sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id));
    const appJoins = noApp();
    for (const e of appDaily) {
        appJoins.trackedClicks.direct += e.trackedDirect;
        appJoins.trackedClicks.viaChat += e.trackedViaChat;
        appJoins.handoffs += e.handoffs;
    }

    // The breakdown rows replace the unbroken rows in `rows`; totals, per-object figures and the app joins stay unbroken.
    let rows: ResultsRow[] = baseRows.map(finishRow);
    if (query.breakdown) {
        const broken = new Map<string, ResultsRow & { counts: Counts }>();
        for (const r of input.breakdownRows) {
            if (!inRange(r.day) || !r.key) continue;
            const placed = place(r.meta_id);
            if (!placed) continue;
            const provisional = r.provisional === true;
            noteRow(r, provisional);
            if (r.currency) currencies.add(r.currency);
            const key = `${r.day}|${placed.id}|${r.key}|${r.currency ?? ''}`;
            let row = broken.get(key);
            if (!row) {
                row = {
                    day: r.day, id: placed.id, key: r.key, currency: r.currency ?? null, spend: 0, impressions: 0, reach: null, clicks: 0, linkClicks: 0,
                    conversations: 0, firstReplies: 0, leads: 0, follows: null, results: null, provisional: false, counts: zero(),
                };
                broken.set(key, row);
            }
            addCounts(row.counts, countsOf(r, placed.ad.kind));
            row.provisional = row.provisional || provisional;
        }
        // Meta reports no first replies per country or placement: null, not 0.
        rows = [...broken.values()].map((r) => ({ ...finishRow(r), firstReplies: null })).sort(order);
    }

    // Per object and currency. An object's app joins go on its first currency's entry, so they are counted once.
    const perKey = new Map<string, { id: string; currency: string | null; counts: Counts; app: AppFigures }>();
    for (const r of base.values()) {
        const key = `${r.id}|${r.currency ?? ''}`;
        let p = perKey.get(key);
        if (!p) { p = { id: r.id, currency: r.currency, counts: zero(), app: noApp() }; perKey.set(key, p); }
        addCounts(p.counts, r.counts);
    }
    const soleCurrency = currencies.size === 1 ? [...currencies][0]! : null;
    const adCurrencyOf = new Map<string, string | null>();
    for (const e of appDaily) {
        if (!adCurrencyOf.has(e.id)) {
            const own = [...perKey.values()].filter((p) => p.id === e.id).map((p) => p.currency).sort()[0];
            const fromObject = [...ads.values()].find((a) => idAt(a, level) === e.id && a.currency)?.currency ?? null;
            adCurrencyOf.set(e.id, own ?? fromObject ?? soleCurrency);
        }
        const currency = adCurrencyOf.get(e.id) ?? null;
        const key = `${e.id}|${currency ?? ''}`;
        let p = perKey.get(key);
        if (!p) { p = { id: e.id, currency, counts: zero(), app: noApp() }; perKey.set(key, p); }
        p.app.trackedClicks.direct += e.trackedDirect;
        p.app.trackedClicks.viaChat += e.trackedViaChat;
        p.app.handoffs += e.handoffs;
    }
    const perObject = [...perKey.values()]
        .sort((a, b) => a.id.localeCompare(b.id) || (a.currency ?? '').localeCompare(b.currency ?? ''))
        .map((p) => ({ id: p.id, currency: p.currency, ...costed(p.counts, p.app) }));

    const byCurrencyAcc = new Map<string, { counts: Counts; app: AppFigures }>();
    for (const p of perKey.values()) {
        if (p.currency === null) continue;
        let t = byCurrencyAcc.get(p.currency);
        if (!t) { t = { counts: zero(), app: noApp() }; byCurrencyAcc.set(p.currency, t); }
        addCounts(t.counts, p.counts);
        t.app.trackedClicks.direct += p.app.trackedClicks.direct;
        t.app.trackedClicks.viaChat += p.app.trackedClicks.viaChat;
        t.app.handoffs += p.app.handoffs;
    }
    const byCurrency: Record<string, CostedTotals> = {};
    for (const currency of [...byCurrencyAcc.keys()].sort()) byCurrency[currency] = costed(byCurrencyAcc.get(currency)!.counts, byCurrencyAcc.get(currency)!.app);

    // The objects the answer talks about: those with figures, and any that was asked for by id.
    const wanted = new Set<string>([...rows.map((r) => r.id), ...appDaily.map((e) => e.id), ...ids]);
    const objectByMeta = new Map(input.objects.filter((o) => o.meta_id).map((o) => [`${o.level}|${o.meta_id}`, o]));
    const objects: ResultsObject[] = [...wanted].sort().map((id) => {
        if (level === 'account') {
            const kinds = new Set([...ads.values()].filter((a) => metas.has(a.meta)).map((a) => a.kind));
            return { id, appId: null, level, name: null, effectiveStatus: null, resultKind: kinds.size === 1 ? [...kinds][0]! : kinds.size > 1 ? 'mixed' : 'link_clicks' };
        }
        if (level === 'ad') {
            const ad = ads.get(id);
            return { id, appId: ad?.appId ?? null, level, name: ad?.name ?? null, effectiveStatus: ad?.status ?? null, resultKind: ad?.kind ?? 'link_clicks' };
        }
        const o = objectByMeta.get(`${level}|${id}`);
        return {
            id, appId: o?.id ?? null, level, name: o?.name ?? null, effectiveStatus: o?.effective_status ?? null,
            resultKind: resultKindOf({ optimizationGoal: o?.optimization_goal ?? null, objective: o?.objective ?? null, destinationType: o?.destination_type ?? null }),
        };
    });

    const currencyList = [...currencies].sort();
    return {
        level, from, to, breakdown: query.breakdown,
        currency: currencyList.length === 1 ? currencyList[0]! : null,
        currencies: currencyList,
        syncedAt: syncedAt === null ? null : new Date(syncedAt).toISOString(),
        provisionalFrom,
        excludesTax: true,
        objects, rows, appDaily, perObject, totals: { byCurrency }, appJoins,
    };
}

// ─── Reading ──────────────────────────────────────────────────────────────────────────────────

/** A time zone name Postgres and ICU both know, else null. */
function validZone(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: value.trim() });
        return value.trim();
    } catch {
        return null;
    }
}

/**
 * The ad account's time zone, from the stored copy of the last account check (`ads.health` → `account.timezone`, a name like
 * `Africa/Cairo`, the same zone the sync dates Meta's rows by); 'UTC' when none is stored or it is not a zone. The app's own clicks are
 * bucketed by it so they land on the same days as Meta's rows.
 */
export async function readAccountTimezone(creatorId: string): Promise<string> {
    try {
        return validZone((await readHealth(creatorId)).account?.timezone) ?? 'UTC';
    } catch (err) {
        if (!isMissingSchema(err)) log('warn', 'ads.results_timezone_unreadable', describeError(err));
        return 'UTC';
    }
}

const INSIGHT_COLUMNS = `meta_id, to_char(day, 'YYYY-MM-DD') AS day, currency, spend::float8 AS spend, impressions::float8 AS impressions,
    clicks::float8 AS clicks, link_clicks::float8 AS link_clicks, conversations_started::float8 AS conversations_started, leads::float8 AS leads,
    follows::float8 AS follows, provisional, synced_at`;

async function latestStoredDay(creatorId: string): Promise<string | null> {
    const rows = await queryRows<{ latest: string | null }>(
        `SELECT to_char(MAX(day), 'YYYY-MM-DD') AS latest FROM ads_insights_daily WHERE creator_id = $1 AND level = 'ad'`,
        [creatorId]
    );
    return rows[0]?.latest ?? null;
}

const emptyJoins = { direct: [] as DirectRow[], viaChat: [] as MetaCountRow[], handoffs: [] as MetaCountRow[] };

/**
 * The app's own joins for these ads over the window: tracked-link clicks (people only, not previews) direct to an ad's object and through the
 * conversation that came from the ad, and hand-offs of those conversations. A link that already points at an ad is not also counted through its
 * conversation, so one click is one count. The window's edges are the account's midnights.
 */
async function readAppJoins(creatorId: string, zone: string, from: string, to: string, appIds: string[], metas: string[]): Promise<typeof emptyJoins> {
    const start = `($3::date)::timestamp AT TIME ZONE $2`;
    const end = `(($4::date) + 1)::timestamp AT TIME ZONE $2`;
    try {
        const [direct, viaChat, handoffs] = await Promise.all([
            appIds.length === 0 ? [] : queryRows<DirectRow>(
                `SELECT to_char((lc.clicked_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, tl.ads_object_id::text AS app_id, COUNT(*)::int AS n
                   FROM link_clicks lc JOIN tracked_links tl ON tl.code = lc.code
                  WHERE tl.creator_id = $1 AND lc.is_prefetch = false AND tl.ads_object_id = ANY($5::uuid[])
                    AND lc.clicked_at >= ${start} AND lc.clicked_at < ${end}
                  GROUP BY 1, 2`,
                [creatorId, zone, from, to, appIds]
            ),
            metas.length === 0 ? [] : queryRows<MetaCountRow>(
                `SELECT to_char((lc.clicked_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, c.entry_source->>'ad_id' AS meta_id, COUNT(*)::int AS n
                   FROM link_clicks lc JOIN tracked_links tl ON tl.code = lc.code JOIN conversations c ON c.id = tl.conversation_id
                  WHERE tl.creator_id = $1 AND c.creator_id = $1 AND lc.is_prefetch = false AND tl.ads_object_id IS NULL
                    AND c.entry_source->>'ad_id' = ANY($5::text[])
                    AND lc.clicked_at >= ${start} AND lc.clicked_at < ${end}
                  GROUP BY 1, 2`,
                [creatorId, zone, from, to, metas]
            ),
            metas.length === 0 ? [] : queryRows<MetaCountRow>(
                `SELECT to_char((c.handoff_at AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS day, c.entry_source->>'ad_id' AS meta_id, COUNT(*)::int AS n
                   FROM conversations c
                  WHERE c.creator_id = $1 AND c.entry_source->>'ad_id' = ANY($5::text[])
                    AND c.handoff_at >= ${start} AND c.handoff_at < ${end}
                  GROUP BY 1, 2`,
                [creatorId, zone, from, to, metas]
            ),
        ]);
        return { direct, viaChat, handoffs };
    } catch (err) {
        // The v53 column or A3's entry source not there yet: the app's own figures are zero, Meta's still show.
        if (isMissingSchema(err)) return { ...emptyJoins };
        throw err;
    }
}

/** The empty answer: no rows, no objects, nothing summed. */
function emptyAnswer(query: ResultsQuery, from: string, to: string): AdsResults {
    return buildResults({ query, from, to, objects: [], daily: [], ownReach: [], breakdownRows: [], ...emptyJoins });
}

/**
 * The answer for `GET /api/ads/results`. `rawQuery` is the request's query string as parsed by Express; a bad field throws `ResultsQueryError`
 * before anything is read. Tables that do not exist yet answer empty.
 */
export async function getAdsResults(creatorId: string, rawQuery: unknown, now: Date = new Date()): Promise<AdsResults> {
    const query = parseResultsQuery(rawQuery);
    const zone = await readAccountTimezone(creatorId);
    const today = now.toISOString().slice(0, 10);

    let range: { from: string; to: string } = { from: query.from ?? '', to: query.to ?? '' };
    try {
        if (query.from === null || query.to === null) {
            range = resolveRange(query, await latestStoredDay(creatorId), today);
        }
        const { from, to } = range;
        const level = query.level;
        const adIds = level === 'ad' && query.ids.length > 0 ? query.ids : null;

        const [objects, daily, ownReach, breakdownRows] = await Promise.all([
            queryRows<ObjectRow>(
                `SELECT id::text AS id, meta_id, level, parent_id::text AS parent_id, name, effective_status, objective, optimization_goal, destination_type, currency
                   FROM ads_objects WHERE creator_id = $1 AND level IN ('campaign', 'adset', 'ad')`,
                [creatorId]
            ),
            queryRows<InsightRow>(
                `SELECT ${INSIGHT_COLUMNS}, reach::float8 AS reach, first_replies::float8 AS first_replies
                   FROM ads_insights_daily WHERE creator_id = $1 AND level = 'ad' AND day BETWEEN $2::date AND $3::date${adIds ? ' AND meta_id = ANY($4::text[])' : ''}
                  ORDER BY day, meta_id`,
                adIds ? [creatorId, from, to, adIds] : [creatorId, from, to]
            ),
            level === 'ad' ? [] : queryRows<ReachRow>(
                `SELECT meta_id, to_char(day, 'YYYY-MM-DD') AS day, reach::float8 AS reach, synced_at
                   FROM ads_insights_daily WHERE creator_id = $1 AND level = $2 AND day BETWEEN $3::date AND $4::date
                  ORDER BY day, meta_id`,
                [creatorId, level, from, to]
            ),
            query.breakdown === null ? [] : queryRows<InsightRow>(
                `SELECT ${INSIGHT_COLUMNS}, key FROM ads_insights_breakdown
                  WHERE creator_id = $1 AND level = 'ad' AND breakdown = $2 AND day BETWEEN $3::date AND $4::date${adIds ? ' AND meta_id = ANY($5::text[])' : ''}
                  ORDER BY day, meta_id, key`,
                adIds ? [creatorId, query.breakdown, from, to, adIds] : [creatorId, query.breakdown, from, to]
            ),
        ]);

        // Which ads the answer covers decides which app figures to read.
        const metas = new Set([...daily.map((r) => r.meta_id), ...breakdownRows.map((r) => r.meta_id)]);
        const ads = resolveAds(objects, metas);
        const ids = level === 'account' ? [] : query.ids;
        const scoped = [...ads.values()].filter((a) => {
            const id = idAt(a, level);
            return id !== null && (ids.length === 0 || ids.includes(id));
        });
        const joins = await readAppJoins(creatorId, zone, from, to, scoped.flatMap((a) => (a.appId ? [a.appId] : [])), scoped.map((a) => a.meta));

        return buildResults({ query, from, to, objects, daily, ownReach, breakdownRows, ...joins });
    } catch (err) {
        if (!isMissingSchema(err)) throw err;
        log('info', 'ads.results_tables_missing', { creator_id: creatorId });
        return emptyAnswer(query, range.from || addDays(today, -(DEFAULT_SPAN_DAYS - 1)), range.to || today);
    }
}
