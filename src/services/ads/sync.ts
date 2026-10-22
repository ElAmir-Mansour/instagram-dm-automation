/**
 * The Ads Manager sync (research R4; contracts/meta-graph.md "Reads"): the only code that reads Meta to fill the stored copy
 * (`mirror.ts`). Screens read the copy, so what the sync costs is what Meta is ever asked, and it is small:
 *
 *   structure   hourly per tenant, from the drain: ONE paged `act_<id>/campaigns` with the ad sets, ads and creatives nested in it
 *   today       every 4 h, or when the owner asked for a refresh (`requestTodaySync`, at most one per 15 min): `level=ad`, today, per day
 *   28 days     once a day, from the cron: the trailing 28 days, an async report when it is more than 2 pages
 *
 * plus, with each results read, the campaign's and the account's own `reach, frequency, spend` per day: reach is not additive (a person
 * seen on two days, or by two ads, is one), so the only valid reach of a campaign or the account is what Meta computed for that level.
 * The daily job also reads the ads' results split by country and by placement (`ads_insights_breakdown`, in v53; a deploy before the
 * migration is tolerated: after the first 42P01 the rows are not stored, nor read; `upsertBreakdowns`).
 *
 * Budget. Every page costs a point and the pacer (`pacer.ts`) holds the account to 45 of Meta's 60 per 5 minutes, shared with the owner's
 * clicks and the cap guard. Before each page we ask the pacer whether the point is there; when it is not, the sync stops and the next
 * drain run continues (a sync cut short stores what it read and does not mark itself done). A throttle from Meta ends that tenant's run.
 * Nothing here ever holds a database transaction open across a Graph call: the pages are read first, then stored in short transactions.
 *
 * `syncAllAds` and `syncDailyAds` never throw: they run inside the drain and the cron, where a failing tenant must not stop the others.
 */
import { describeError, log } from '../../utils/log.js';
import { queryRows } from '../../db/query.js';
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { adsGet, adsPost, AdsGraphError, type AdsCallOptions, type GraphParams } from './graph.js';
import {
    boostIdFromName, breakdownsUnavailable, markMissing, upsertBreakdowns, upsertInsights, upsertObjects, type BreakdownKind, type BreakdownRow,
    type InsightLevel, type InsightRow, type ObjectLevel, type ParsedObject,
} from './mirror.js';
import { canSpend, POINTS, retryAtFor, status as pacerStatus, type PacerStatus } from './pacer.js';
import { readAdsSettings } from './settings.js';

// ─── Numbers and days ───────────────────────────────────────────────────────────────────────

const HOUR_MS = 3_600_000;
export const STRUCTURE_EVERY_MS = HOUR_MS;
export const TODAY_EVERY_MS = 4 * HOUR_MS;
/** The cron runs daily; a second run inside 20 h (a retry, a double fire) does not read 28 days again. */
export const DAILY_EVERY_MS = 20 * HOUR_MS;
/** A manual refresh: at most one per this long, counted from the last refresh or request. */
export const MANUAL_REFRESH_MS = 15 * 60_000;
/** An insights report not collected in this long is forgotten (Meta keeps them about a day, but its numbers moved on). */
const REPORT_MAX_AGE_MS = 6 * HOUR_MS;
/** The ad account's currency and zone change never, in practice; read again a day later all the same. */
const ACCOUNT_REFRESH_MS = 24 * HOUR_MS;
const REPORT_POLL_MS = 3_000;
/** The last this-many calendar days (today and the two before) may still be revised by Meta. */
const PROVISIONAL_DAYS = 3;
const TRAILING_DAYS = 28;
const MAX_PAGES = 40;
/** The allowed pages of a 28-day read before it becomes an async report ("more than 2 pages"). */
const SYNC_PAGES_BEFORE_ASYNC = 2;
const PAGE_LIMIT = 500;
const ATTRIBUTION_WINDOWS = ['7d_click', '1d_view'];
export const ATTRIBUTION = ATTRIBUTION_WINDOWS.join(',');
export const ADS_ENABLED_PREFIX = TENANT_SETTING_PREFIXES.adsEnabled;

const num = (v: unknown): number => {
    const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(x) ? x : 0;
};
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The calendar day (`YYYY-MM-DD`) `date` falls on in the IANA zone `tz`; UTC when the zone is not one Intl knows. */
export function dayInTz(date: Date, tz: string | null | undefined): string {
    const parts = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    try {
        return parts(tz || 'UTC');
    } catch {
        return parts('UTC');
    }
}

function shiftDay(day: string, delta: number): string {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
    const t = (s: string) => Date.parse(`${s}T00:00:00Z`);
    return Math.round((t(to) - t(from)) / 86_400_000);
}

// ─── Parsing the structure ──────────────────────────────────────────────────────────────────

const GENDERS: Record<number, string> = { 1: 'male', 2: 'female' };

/**
 * A small summary of an ad set's `targeting` for display: where (countries), who (ages, genders, languages, saved audiences) and which
 * placements (`automatic` when Meta chooses, else `<platform>` and `<platform>_<position>` for what was listed). Never the whole spec.
 */
export function summariseTargeting(targeting: unknown): Record<string, unknown> | null {
    const t = rec(targeting);
    if (!t) return null;
    const geo = rec(t['geo_locations']);
    const countries = arr(geo?.['countries']).filter((c): c is string => typeof c === 'string');
    const genders = arr(t['genders']).map((g) => GENDERS[num(g)]).filter((g): g is string => Boolean(g));
    const locales = arr(t['locales']).map(num).filter((x) => x > 0);
    const platforms = arr(t['publisher_platforms']).filter((p): p is string => typeof p === 'string');
    const placements: string[] = [...platforms];
    for (const platform of ['facebook', 'instagram', 'messenger', 'audience_network']) {
        for (const position of arr(t[`${platform}_positions`])) if (typeof position === 'string') placements.push(`${platform}_${position}`);
    }
    const audiences = arr(t['custom_audiences'])
        .map((a) => rec(a))
        .filter((a): a is Record<string, unknown> => a !== null)
        .map((a) => ({ id: str(a['id']), name: str(a['name']) }))
        .slice(0, 5);
    return {
        countries,
        age_min: typeof t['age_min'] === 'number' ? t['age_min'] : null,
        age_max: typeof t['age_max'] === 'number' ? t['age_max'] : null,
        genders,
        locales,
        placements: placements.length > 0 ? placements : 'automatic',
        ...(audiences.length > 0 ? { audiences } : {}),
    };
}

function reviewOf(o: Record<string, unknown>): ParsedObject['review'] {
    if (o['issues_info'] === undefined && o['ad_review_feedback'] === undefined && o['learning_stage_info'] === undefined) return null;
    return { issues_info: o['issues_info'] ?? null, ad_review_feedback: o['ad_review_feedback'] ?? null, learning_stage_info: o['learning_stage_info'] ?? null };
}

function withoutKey(o: Record<string, unknown>, key: string): Record<string, unknown> {
    const { [key]: _dropped, ...rest } = o;
    return rest;
}

function minor(v: unknown): number | null {
    const x = num(v);
    return x > 0 ? x : null;
}

function parsedBase(level: ObjectLevel, o: Record<string, unknown>, parentMetaId: string | null): ParsedObject | null {
    const metaId = str(o['id']);
    if (!metaId) return null;
    return {
        level,
        metaId,
        parentMetaId,
        creativeMetaId: null,
        name: str(o['name']),
        status: str(o['status']),
        effectiveStatus: str(o['effective_status']),
        objective: null,
        destinationType: null,
        optimizationGoal: null,
        dailyBudgetMinor: minor(o['daily_budget']),
        lifetimeBudgetMinor: minor(o['lifetime_budget']),
        startTime: str(o['start_time']),
        endTime: null,
        targetingSummary: null,
        review: reviewOf(o),
        raw: o,
    };
}

/**
 * Meta's nested answer (`campaigns{adsets{ads{creative}}}`, one object per page) as a flat list, parents before children: a campaign, then
 * its ad sets with `parentMetaId` the campaign, then each ad (`parentMetaId` its ad set) and the creative it uses as a `creative` object.
 * A creative shared by several ads appears once. Each object's `raw` is its own fields: the children nested under it are not repeated.
 */
export function parseStructure(pages: unknown[]): ParsedObject[] {
    const out: ParsedObject[] = [];
    const creatives = new Map<string, ParsedObject>();
    for (const page of pages) {
        for (const c of arr(rec(page)?.['data'])) {
            const camp = rec(c);
            if (!camp) continue;
            const campaign = parsedBase('campaign', withoutKey(camp, 'adsets'), null);
            if (!campaign) continue;
            campaign.objective = str(camp['objective']);
            campaign.endTime = str(camp['stop_time']);
            out.push(campaign);
            for (const s of arr(rec(camp['adsets'])?.['data'])) {
                const set = rec(s);
                if (!set) continue;
                const adset = parsedBase('adset', withoutKey(set, 'ads'), campaign.metaId);
                if (!adset) continue;
                adset.destinationType = str(set['destination_type']);
                adset.optimizationGoal = str(set['optimization_goal']);
                adset.endTime = str(set['end_time']);
                adset.targetingSummary = summariseTargeting(set['targeting']);
                out.push(adset);
                for (const a of arr(rec(set['ads'])?.['data'])) {
                    const adRaw = rec(a);
                    if (!adRaw) continue;
                    const ad = parsedBase('ad', adRaw, adset.metaId);
                    if (!ad) continue;
                    const creative = rec(adRaw['creative']);
                    const creativeId = str(creative?.['id']);
                    if (creative && creativeId) {
                        ad.creativeMetaId = creativeId;
                        if (!creatives.has(creativeId)) {
                            const row = parsedBase('creative', creative, null);
                            if (row) creatives.set(creativeId, row);
                        }
                    }
                    out.push(ad);
                }
            }
        }
    }
    return [...out, ...creatives.values()];
}

/**
 * Did the nested edges come whole? `adsets.limit(50)` and `ads.limit(50)` are paged like any edge, and a campaign with a 51st ad set has
 * `paging.next` inside its `adsets`. Reading those pages would cost a call per campaign, which the structure sync is built to avoid, so
 * such an answer is incomplete: it is stored, but without deletion marking (the ad sets not listed may be there, only unread).
 */
export function structureIsComplete(pages: unknown[]): boolean {
    for (const page of pages) {
        for (const c of arr(rec(page)?.['data'])) {
            const adsets = rec(rec(c)?.['adsets']);
            if (adsets && rec(adsets['paging'])?.['next']) return false;
            for (const s of arr(adsets?.['data'])) {
                const ads = rec(rec(s)?.['ads']);
                if (ads && rec(ads['paging'])?.['next']) return false;
            }
        }
    }
    return true;
}

// ─── Parsing the results ────────────────────────────────────────────────────────────────────

/**
 * One action's count. With `action_attribution_windows` Meta puts each window's count beside `value`; when `value` is absent the windows
 * are added (each conversion is in one window of the pair at most: 7-day click or 1-day view).
 */
function actionCount(a: Record<string, unknown>): number {
    if (a['value'] !== undefined) return num(a['value']);
    return ATTRIBUTION_WINDOWS.reduce((sum, w) => sum + num(a[w]), 0);
}

/** The count of the first of `types` the row reports; 0 when none. (`lead` already includes on-Meta leads: the types are alternatives, not parts.) */
function firstAction(actions: unknown[], types: string[]): number | null {
    for (const type of types) {
        const a = actions.map(rec).find((x) => x && x['action_type'] === type);
        if (a) return actionCount(a);
    }
    return null;
}

export interface InsightOptions {
    creatorId: string;
    currency: string;
    /** The ad account's IANA zone. */
    tz: string;
    /** "Now": the last 3 days of it, in the account's zone, are provisional. */
    today: Date;
    level: InsightLevel;
    /** The ad account's id: the object of an `account` row. */
    accountId?: string;
}

/**
 * Meta's insights rows (`time_increment=1`) as stored rows. `day` is `date_start`: Meta already reports it in the ad account's zone, so
 * it is never converted. Spend is in major units of the account currency, as Meta sends it. A row Meta sent without the id of its level
 * or without a day is dropped. `follows` is null unless Meta reported one.
 */
export function parseInsightRows(rows: unknown[], o: InsightOptions): InsightRow[] {
    const todayDay = dayInTz(o.today, o.tz);
    const out: InsightRow[] = [];
    for (const raw of rows) {
        const r = rec(raw);
        if (!r) continue;
        const metaId = o.level === 'account' ? (o.accountId ?? str(r['account_id'])) : str(r[`${o.level}_id`]);
        const day = str(r['date_start']);
        if (!metaId || !day) continue;
        const actions = arr(r['actions']);
        const videos = arr(r['video_play_actions']).map(rec).filter((a): a is Record<string, unknown> => a !== null);
        const videoViews = videos.find((a) => a['action_type'] === 'video_view') ?? videos[0];
        out.push({
            creatorId: o.creatorId,
            level: o.level,
            metaId,
            day,
            currency: o.currency,
            spend: Math.round(num(r['spend']) * 100) / 100,
            impressions: num(r['impressions']),
            reach: num(r['reach']),
            clicks: num(r['clicks']),
            linkClicks: num(r['inline_link_clicks']),
            conversationsStarted: firstAction(actions, ['onsite_conversion.messaging_conversation_started_7d']) ?? 0,
            firstReplies: firstAction(actions, ['onsite_conversion.messaging_first_reply']) ?? 0,
            leads: firstAction(actions, ['lead', 'onsite_conversion.lead_grouped']) ?? 0,
            follows: firstAction(actions, ['follow', 'onsite_conversion.follow']),
            videoViews: videoViews ? actionCount(videoViews) : 0,
            actions: actions.length > 0 ? actions : null,
            attribution: ATTRIBUTION,
            provisional: daysBetween(day, todayDay) < PROVISIONAL_DAYS,
        });
    }
    return out;
}

export interface BreakdownOptions {
    creatorId: string;
    currency: string;
    tz: string;
    today: Date;
    level: 'campaign' | 'adset' | 'ad';
    breakdown: BreakdownKind;
}

/**
 * Insights rows read with `breakdowns=country` or `breakdowns=publisher_platform,platform_position` (and `time_increment=1`) as stored
 * rows. The key is the ISO country code, or `<publisher_platform>:<platform_position>` (`instagram:instagram_reels`). Rows without the
 * object's id, the day or the key are dropped. Reach is not read: it cannot be split and summed again.
 */
export function parseBreakdownRows(rows: unknown[], o: BreakdownOptions): BreakdownRow[] {
    const todayDay = dayInTz(o.today, o.tz);
    const out: BreakdownRow[] = [];
    for (const raw of rows) {
        const r = rec(raw);
        if (!r) continue;
        const metaId = str(r[`${o.level}_id`]);
        const day = str(r['date_start']);
        const platform = str(r['publisher_platform']);
        const position = str(r['platform_position']);
        const key = o.breakdown === 'country' ? str(r['country']) : platform && position ? `${platform}:${position}` : null;
        if (!metaId || !day || !key) continue;
        const actions = arr(r['actions']);
        out.push({
            creatorId: o.creatorId,
            level: o.level,
            metaId,
            day,
            breakdown: o.breakdown,
            key,
            currency: o.currency,
            spend: Math.round(num(r['spend']) * 100) / 100,
            impressions: num(r['impressions']),
            clicks: num(r['clicks']),
            linkClicks: num(r['inline_link_clicks']),
            conversationsStarted: firstAction(actions, ['onsite_conversion.messaging_conversation_started_7d']) ?? 0,
            leads: firstAction(actions, ['lead', 'onsite_conversion.lead_grouped']) ?? 0,
            follows: firstAction(actions, ['follow', 'onsite_conversion.follow']),
            provisional: daysBetween(day, todayDay) < PROVISIONAL_DAYS,
        });
    }
    return out;
}

// ─── Dependencies, state ────────────────────────────────────────────────────────────────────

/** The outside world of a sync, replaceable in a test: the Graph calls, the clock, the pacer's state. */
export interface SyncDeps {
    get(path: string, params: Record<string, string>, token: string, opts: AdsCallOptions): Promise<{ data: any }>;
    post(path: string, params: GraphParams, token: string, opts: AdsCallOptions): Promise<{ data: any }>;
    now(): Date;
    sleep(ms: number): Promise<void>;
    pacer(adAccountId: string): Promise<PacerStatus | null>;
}

export const defaultDeps: SyncDeps = {
    get: (path, params, token, opts) => adsGet(path, params, token, opts),
    post: (path, params, token, opts) => adsPost(path, params, token, opts),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pacer: (adAccountId) => pacerStatus(adAccountId),
};

/** Per tenant, in `app_settings` `ads.sync.<creator id>`. Times are ISO strings. */
export interface SyncState {
    structureAt: string | null;
    todayAt: string | null;
    dailyAt: string | null;
    /** A manual refresh asked for and not yet served: it is pending while this is later than `todayAt`. */
    todayRequestedAt: string | null;
    /** The async insights report of the 28 days that was started and not collected, to resume. */
    pendingReportRunId: string | null;
    pendingReportAt?: string | null;
    /** The ad account's currency and zone, so a sync does not spend a point on them every time. */
    account?: { currency: string; tz: string; at: string } | null;
}

const EMPTY_STATE: SyncState = { structureAt: null, todayAt: null, dailyAt: null, todayRequestedAt: null, pendingReportRunId: null };

export async function readSyncState(creatorId: string): Promise<SyncState> {
    const raw = await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSync, creatorId));
    if (!raw) return { ...EMPTY_STATE };
    try {
        const parsed = rec(JSON.parse(raw));
        return parsed ? ({ ...EMPTY_STATE, ...parsed } as SyncState) : { ...EMPTY_STATE };
    } catch {
        return { ...EMPTY_STATE };
    }
}

/** Read again right before writing, so two syncs of one tenant (the drain and the cron) each change only their own keys. */
async function patchSyncState(creatorId: string, patch: Partial<SyncState>): Promise<void> {
    const current = await readSyncState(creatorId);
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSync, creatorId), JSON.stringify({ ...current, ...patch }), null);
}

const ms = (iso: string | null | undefined): number => {
    const t = Date.parse(iso ?? '');
    return Number.isNaN(t) ? 0 : t;
};

// ─── One tenant's run ───────────────────────────────────────────────────────────────────────

export type SyncSkip = 'not_configured' | 'pacer' | 'throttle' | 'deadline' | 'account_unreadable';

export interface SyncResult {
    /** At least one Graph page was read and stored. */
    ran: boolean;
    /** Everything that was due was read: the sync finished, and its time is recorded. */
    complete: boolean;
    skipped?: SyncSkip;
    /** When to try again, when Meta or the pacer named a time. */
    retryAt?: Date;
    /** Structure: objects stored; results: rows stored. */
    stored: number;
    /** Structure: rows newly marked DELETED. */
    deleted: number;
    /** A 28-day report was started and is waiting at Meta (its id is in the sync state). */
    reportPending?: boolean;
}

interface Ctx {
    creatorId: string;
    adAccountId: string;
    token: string;
    currency: string;
    tz: string;
    deadline: number;
    deps: SyncDeps;
    callOpts: (label: string, points?: number) => AdsCallOptions;
}

type Prepared = { ok: true; ctx: Ctx; state: SyncState } | { ok: false; skipped: SyncSkip; retryAt?: Date };

/** Is a call of `points` allowed now, by the clock and by the pacer? The pacer row is read afresh every time: other callers spend from it. */
async function mayCall(ctx: Pick<Ctx, 'adAccountId' | 'deps' | 'deadline'>, points: number): Promise<{ ok: true } | { ok: false; skipped: SyncSkip; retryAt?: Date }> {
    const now = ctx.deps.now();
    if (now.getTime() >= ctx.deadline) return { ok: false, skipped: 'deadline' };
    const state = await ctx.deps.pacer(ctx.adAccountId);
    if (state && !canSpend(state, points, now)) return { ok: false, skipped: 'pacer', retryAt: retryAtFor(state, now) };
    return { ok: true };
}

/** The tenant's settings, the pacer's answer and the account's currency and zone: everything a sync needs before its first page. */
async function prepare(creatorId: string, deadline: number, deps: SyncDeps, opts: { refreshAccount?: boolean } = {}): Promise<Prepared> {
    const { settings, token } = await readAdsSettings(creatorId);
    const adAccountId = settings.adAccountId?.replace(/^act_/, '') ?? null;
    if (!adAccountId || !token) return { ok: false, skipped: 'not_configured' };
    const callOpts = (label: string, points?: number): AdsCallOptions => ({ label, creatorId, adAccountId, ...(points !== undefined ? { points } : {}) });
    const base = { creatorId, adAccountId, token, deadline, deps, callOpts };
    const state = await readSyncState(creatorId);

    const known = state.account && state.account.currency && state.account.tz ? state.account : null;
    const fresh = known !== null && deps.now().getTime() - ms(known.at) < ACCOUNT_REFRESH_MS && !opts.refreshAccount;
    if (fresh && known) return { ok: true, ctx: { ...base, currency: known.currency, tz: known.tz }, state };

    const gate = await mayCall(base, POINTS.read);
    if (!gate.ok) {
        if (known) return { ok: true, ctx: { ...base, currency: known.currency, tz: known.tz }, state };
        return { ok: false, skipped: gate.skipped, ...(gate.retryAt ? { retryAt: gate.retryAt } : {}) };
    }
    try {
        const res = await deps.get(`act_${adAccountId}`, { fields: 'currency,timezone_name' }, token, callOpts('ads sync account'));
        const currency = str(res.data?.currency);
        const tz = str(res.data?.timezone_name) ?? 'UTC';
        if (!currency) throw new Error('Meta did not name the ad account\'s currency.');
        const account = { currency, tz, at: deps.now().toISOString() };
        await patchSyncState(creatorId, { account });
        return { ok: true, ctx: { ...base, currency, tz }, state: { ...state, account } };
    } catch (err) {
        if (err instanceof AdsGraphError && err.klass === 'throttle') return { ok: false, skipped: 'throttle', ...(err.retryAt ? { retryAt: err.retryAt } : {}) };
        if (known) return { ok: true, ctx: { ...base, currency: known.currency, tz: known.tz }, state };
        log('warn', 'ads.sync_account_unreadable', { creator_id: creatorId, ...describeError(err) });
        return { ok: false, skipped: 'account_unreadable' };
    }
}

interface PagesRead {
    pages: any[];
    /** The edge has a next page that was not read, because `maxPages` was reached. */
    more: boolean;
    stopped?: SyncSkip;
    retryAt?: Date;
}

/**
 * Read a paged edge: follow `paging.next` by its `after` cursor (the `next` URL itself carries a token and is never called), each page
 * only when the clock and the pacer allow. Stops, with what it has, on the deadline, an empty budget or a throttle.
 */
async function readPages(ctx: Ctx, path: string, params: Record<string, string>, label: string, maxPages = MAX_PAGES): Promise<PagesRead> {
    const pages: any[] = [];
    let after: string | null = null;
    for (;;) {
        if (pages.length >= maxPages) return { pages, more: true };
        const gate = await mayCall(ctx, POINTS.read);
        if (!gate.ok) return { pages, more: true, stopped: gate.skipped, ...(gate.retryAt ? { retryAt: gate.retryAt } : {}) };
        let page: any;
        try {
            page = (await ctx.deps.get(path, after ? { ...params, after } : params, ctx.token, ctx.callOpts(label))).data;
        } catch (err) {
            if (err instanceof AdsGraphError && err.klass === 'throttle') return { pages, more: true, stopped: 'throttle', ...(err.retryAt ? { retryAt: err.retryAt } : {}) };
            throw err;
        }
        pages.push(page);
        const paging = rec(page?.paging);
        const cursor = str(rec(paging?.['cursors'])?.['after']);
        if (!paging?.['next'] || !cursor || cursor === after) return { pages, more: false };
        after = cursor;
    }
}

const rowsOf = (pages: any[]): unknown[] => pages.flatMap((p) => arr(rec(p)?.['data']));

// ─── The structure sync ─────────────────────────────────────────────────────────────────────

/** Meta's fields for the structure (contracts/meta-graph.md "Reads"): the campaign with its ad sets and ads and each ad's creative nested in. */
export const STRUCTURE_FIELDS =
    'id,name,objective,status,effective_status,daily_budget,lifetime_budget,special_ad_categories,start_time,stop_time,advantage_state_info,' +
    'adsets.limit(50){id,name,status,effective_status,daily_budget,lifetime_budget,destination_type,optimization_goal,targeting,start_time,end_time,' +
    'learning_stage_info,promoted_object,ads.limit(50){id,name,status,effective_status,issues_info,ad_review_feedback,' +
    'creative{id,object_story_id,effective_instagram_media_id,thumbnail_url,asset_feed_spec}}}';

export interface SyncOptions {
    /** Epoch ms after which no more pages are read. Without it the sync reads everything it is allowed to. */
    deadline?: number;
}

/**
 * Read the whole ad account's structure once and store it. The pages are read first (no transaction open), then stored in short ones;
 * deletion marking runs only when every page was read AND no nested edge was cut off (`structureIsComplete`: an ad set list that was
 * paged would otherwise count the unread ones as missing). A sync stopped by the budget, the clock or a throttle stores what it read,
 * marks nothing deleted and does not record itself as done, so the next drain continues.
 */
export async function syncStructure(creatorId: string, opts: SyncOptions = {}, deps: SyncDeps = defaultDeps): Promise<SyncResult> {
    const prepared = await prepare(creatorId, opts.deadline ?? Number.POSITIVE_INFINITY, deps);
    if (!prepared.ok) return { ran: false, complete: false, skipped: prepared.skipped, ...(prepared.retryAt ? { retryAt: prepared.retryAt } : {}), stored: 0, deleted: 0 };
    const { ctx } = prepared;

    const read = await readPages(ctx, `act_${ctx.adAccountId}/campaigns`, { fields: STRUCTURE_FIELDS, limit: '25' }, 'ads sync structure');
    if (read.pages.length === 0) return { ran: false, complete: false, skipped: read.stopped ?? 'pacer', ...(read.retryAt ? { retryAt: read.retryAt } : {}), stored: 0, deleted: 0 };

    const syncedAt = ctx.deps.now();
    const parsed = parseStructure(read.pages);
    await upsertObjects(creatorId, ctx.adAccountId, ctx.currency, parsed, syncedAt);

    const everyPage = !read.more && !read.stopped;
    let deleted = 0;
    if (everyPage && structureIsComplete(read.pages)) {
        // Creatives are left out: one no ad uses any more is not listed by the nested read, which is not the same as deleted.
        const seen = new Set(parsed.map((o) => o.metaId));
        deleted = await markMissing(creatorId, ctx.adAccountId, seen, ['campaign', 'adset', 'ad']);
    }
    if (everyPage) await patchSyncState(creatorId, { structureAt: syncedAt.toISOString() });
    log('info', 'ads.sync_structure', { creator_id: creatorId, objects: parsed.length, pages: read.pages.length, complete: everyPage, deleted });
    return { ran: true, complete: everyPage, ...(read.stopped ? { skipped: read.stopped } : {}), ...(read.retryAt ? { retryAt: read.retryAt } : {}), stored: parsed.length, deleted };
}

// ─── The results sync ───────────────────────────────────────────────────────────────────────

const AD_FIELDS = 'ad_id,adset_id,campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,video_play_actions';

const BREAKDOWN_FIELDS = 'ad_id,spend,impressions,clicks,inline_link_clicks,actions';
const BREAKDOWNS: Record<BreakdownKind, string> = { country: 'country', placement: 'publisher_platform,platform_position' };

function insightParams(ctx: Ctx, range: 'today' | '28d', level: string, fields: string, breakdowns?: string): Record<string, string> {
    const params: Record<string, string> = { level, time_increment: '1', fields, limit: String(PAGE_LIMIT) };
    if (breakdowns) params['breakdowns'] = breakdowns;
    if (level === 'ad') params['action_attribution_windows'] = JSON.stringify(ATTRIBUTION_WINDOWS);
    if (range === 'today') params['date_preset'] = 'today';
    else {
        const until = dayInTz(ctx.deps.now(), ctx.tz);
        params['time_range'] = JSON.stringify({ since: shiftDay(until, -(TRAILING_DAYS - 1)), until });
    }
    return params;
}

interface ReportRead {
    rows: unknown[];
    /** Finished, rows are all of them. */
    done: boolean;
    pending: boolean;
    skipped?: SyncSkip;
    retryAt?: Date;
}

/**
 * Collect an async insights report: poll its status until Meta says it completed, then read its rows. When the deadline comes first, or
 * the pacer has no point for the next poll, the run id stays in the sync state and the next run resumes it instead of starting another.
 */
async function collectReport(ctx: Ctx, runId: string): Promise<ReportRead> {
    for (;;) {
        const gate = await mayCall(ctx, POINTS.read);
        if (!gate.ok) return { rows: [], done: false, pending: true, skipped: gate.skipped, ...(gate.retryAt ? { retryAt: gate.retryAt } : {}) };
        let state: any;
        try {
            state = (await ctx.deps.get(runId, { fields: 'async_status,async_percent_completion' }, ctx.token, ctx.callOpts('ads sync report status'))).data;
        } catch (err) {
            if (err instanceof AdsGraphError && err.klass === 'throttle') return { rows: [], done: false, pending: true, skipped: 'throttle', ...(err.retryAt ? { retryAt: err.retryAt } : {}) };
            // The run is gone (expired, or never was): forget it, and the next run starts a new one.
            await patchSyncState(ctx.creatorId, { pendingReportRunId: null, pendingReportAt: null });
            throw err;
        }
        const status = str(state?.async_status);
        if (status === 'Job Completed') break;
        if (status === 'Job Failed' || status === 'Job Skipped') {
            await patchSyncState(ctx.creatorId, { pendingReportRunId: null, pendingReportAt: null });
            return { rows: [], done: false, pending: false };
        }
        if (ctx.deps.now().getTime() + REPORT_POLL_MS >= ctx.deadline) return { rows: [], done: false, pending: true, skipped: 'deadline' };
        await ctx.deps.sleep(REPORT_POLL_MS);
    }
    const read = await readPages(ctx, `${runId}/insights`, { limit: String(PAGE_LIMIT) }, 'ads sync report rows');
    if (read.more) return { rows: rowsOf(read.pages), done: false, pending: true, ...(read.stopped ? { skipped: read.stopped } : {}), ...(read.retryAt ? { retryAt: read.retryAt } : {}) };
    return { rows: rowsOf(read.pages), done: true, pending: false };
}

/**
 * The ad-level rows of the trailing 28 days. The first 2 pages are read directly and stored; when there are more than 2 (a long account,
 * many ads: 28 rows per ad), the same query is run as an async report and collected, which is how Meta wants large ranges read.
 * A report started and not collected by the deadline is remembered and resumed by the next run.
 */
async function readAds28d(ctx: Ctx, state: SyncState, store: (rows: unknown[]) => Promise<void>): Promise<Pick<ReportRead, 'done' | 'pending' | 'skipped' | 'retryAt'>> {
    const params = insightParams(ctx, '28d', 'ad', AD_FIELDS);
    const path = `act_${ctx.adAccountId}/insights`;

    let runId = state.pendingReportRunId && ctx.deps.now().getTime() - ms(state.pendingReportAt) < REPORT_MAX_AGE_MS ? state.pendingReportRunId : null;
    if (!runId) {
        const first = await readPages(ctx, path, params, 'ads sync insights 28d', SYNC_PAGES_BEFORE_ASYNC);
        await store(rowsOf(first.pages));
        if (!first.more) return { done: true, pending: false };
        if (first.stopped) return { done: false, pending: false, skipped: first.stopped, ...(first.retryAt ? { retryAt: first.retryAt } : {}) };

        // More than 2 pages: ask for the report. An async job is one write-priced call.
        const gate = await mayCall(ctx, POINTS.write);
        if (!gate.ok) return { done: false, pending: false, skipped: gate.skipped, ...(gate.retryAt ? { retryAt: gate.retryAt } : {}) };
        const { limit: _limit, ...reportParams } = params;
        let started: any;
        try {
            started = (await ctx.deps.post(path, reportParams, ctx.token, ctx.callOpts('ads sync insights report'))).data;
        } catch (err) {
            if (err instanceof AdsGraphError && err.klass === 'throttle') return { done: false, pending: false, skipped: 'throttle', ...(err.retryAt ? { retryAt: err.retryAt } : {}) };
            throw err;
        }
        runId = str(started?.report_run_id);
        if (!runId) throw new Error('Meta started no insights report (no report_run_id).');
        await patchSyncState(ctx.creatorId, { pendingReportRunId: runId, pendingReportAt: ctx.deps.now().toISOString() });
    }

    const report = await collectReport(ctx, runId);
    if (report.rows.length > 0) await store(report.rows);
    if (report.done) await patchSyncState(ctx.creatorId, { pendingReportRunId: null, pendingReportAt: null });
    return { done: report.done, pending: report.pending, ...(report.skipped ? { skipped: report.skipped } : {}), ...(report.retryAt ? { retryAt: report.retryAt } : {}) };
}

/**
 * Today's results (every 4 h) or the trailing 28 days (daily). Ad rows come first; then the campaign's and the account's own
 * `reach, frequency, spend` per day, stored as `campaign` and `account` rows: reach cannot be summed from the ads, and the account row
 * is what `spendFromMirror` prefers for what the account spent. The days are Meta's `date_start`, the ad account's calendar days.
 * The daily job also reads the ads' breakdowns by country and by placement into `ads_insights_breakdown` (read by A6).
 */
export async function syncInsights(creatorId: string, range: 'today' | '28d', opts: SyncOptions = {}, deps: SyncDeps = defaultDeps): Promise<SyncResult> {
    const prepared = await prepare(creatorId, opts.deadline ?? Number.POSITIVE_INFINITY, deps, { refreshAccount: range === '28d' });
    if (!prepared.ok) return { ran: false, complete: false, skipped: prepared.skipped, ...(prepared.retryAt ? { retryAt: prepared.retryAt } : {}), stored: 0, deleted: 0 };
    const { ctx, state } = prepared;
    const now = deps.now();
    let stored = 0;
    let ran = false;
    const store = (level: InsightLevel) => async (rows: unknown[]): Promise<void> => {
        const parsed = parseInsightRows(rows, { creatorId, currency: ctx.currency, tz: ctx.tz, today: now, level, accountId: ctx.adAccountId });
        stored += await upsertInsights(parsed);
        if (rows.length > 0) ran = true;
    };
    const result = (extra: Partial<SyncResult>): SyncResult => ({ ran, complete: false, stored, deleted: 0, ...extra });
    const path = `act_${ctx.adAccountId}/insights`;

    // 1. The ads.
    if (range === 'today') {
        const read = await readPages(ctx, path, insightParams(ctx, 'today', 'ad', AD_FIELDS), 'ads sync insights today');
        await store('ad')(rowsOf(read.pages));
        if (read.pages.length > 0) ran = true;
        if (read.more || read.stopped) return result({ skipped: read.stopped ?? 'pacer', ...(read.retryAt ? { retryAt: read.retryAt } : {}) });
    } else {
        const r = await readAds28d(ctx, state, store('ad'));
        ran = ran || r.done || r.pending;
        if (!r.done) return result({ ...(r.skipped ? { skipped: r.skipped } : {}), ...(r.retryAt ? { retryAt: r.retryAt } : {}), ...(r.pending ? { reportPending: true } : {}) });
    }

    // 2. Reach, frequency and spend at the campaign's and the account's own level.
    for (const level of ['campaign', 'account'] as const) {
        const fields = level === 'campaign' ? 'campaign_id,reach,frequency,spend' : 'reach,frequency,spend';
        const read = await readPages(ctx, path, insightParams(ctx, range, level, fields), `ads sync reach ${level}`);
        await store(level)(rowsOf(read.pages));
        if (read.pages.length > 0) ran = true;
        if (read.more || read.stopped) return result({ skipped: read.stopped ?? 'pacer', ...(read.retryAt ? { retryAt: read.retryAt } : {}) });
    }

    // 3. The 28 days' ads split by country and by placement. Once the table is known to be missing nothing is read for it.
    if (range === '28d') {
        for (const breakdown of ['country', 'placement'] as const) {
            if (breakdownsUnavailable()) break;
            const read = await readPages(ctx, path, insightParams(ctx, '28d', 'ad', BREAKDOWN_FIELDS, BREAKDOWNS[breakdown]), `ads sync breakdown ${breakdown}`);
            stored += await upsertBreakdowns(parseBreakdownRows(rowsOf(read.pages), { creatorId, currency: ctx.currency, tz: ctx.tz, today: now, level: 'ad', breakdown }));
            if (read.pages.length > 0) ran = true;
            if (read.more || read.stopped) return result({ skipped: read.stopped ?? 'pacer', ...(read.retryAt ? { retryAt: read.retryAt } : {}) });
        }
    }

    await patchSyncState(creatorId, range === 'today' ? { todayAt: now.toISOString() } : { dailyAt: now.toISOString() });
    log('info', 'ads.sync_insights', { creator_id: creatorId, range, rows: stored });
    return result({ complete: true });
}

// ─── A manual refresh ───────────────────────────────────────────────────────────────────────

/**
 * The owner asked for fresh numbers. At most one refresh per 15 minutes, counted from the last today-sync or the last request: within
 * that, `{ queued: false, retryAt }`. Otherwise the request is recorded and the next drain run reads today's results ahead of the 4 h
 * schedule; `notBefore` is when that can happen (now: the drain runs every minute).
 */
export async function requestTodaySync(creatorId: string, now: Date = new Date()): Promise<{ queued: true; notBefore: string } | { queued: false; retryAt: string }> {
    const state = await readSyncState(creatorId);
    const last = Math.max(ms(state.todayAt), ms(state.todayRequestedAt));
    if (last > 0 && now.getTime() - last < MANUAL_REFRESH_MS) return { queued: false, retryAt: new Date(last + MANUAL_REFRESH_MS).toISOString() };
    await patchSyncState(creatorId, { todayRequestedAt: now.toISOString() });
    return { queued: true, notBefore: now.toISOString() };
}

// ─── The drain and the cron ─────────────────────────────────────────────────────────────────

/** Tenants the platform admin switched ads on for (`ads.enabled.<tenant>` = 'true'). */
async function enabledTenants(): Promise<string[]> {
    const rows = await queryRows<{ key: string }>("SELECT key FROM app_settings WHERE key LIKE 'ads.enabled.%' AND value = 'true'");
    return rows.map((r) => r.key.slice(ADS_ENABLED_PREFIX.length)).filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id));
}

export interface SyncSummary {
    tenants: number;
    structure: number;
    today: number;
    daily: number;
    skipped: number;
    failed: number;
}

const emptySummary = (): SyncSummary => ({ tenants: 0, structure: 0, today: 0, daily: 0, skipped: 0, failed: 0 });

const structureDue = (s: SyncState, now: number): boolean => now - ms(s.structureAt) >= STRUCTURE_EVERY_MS;
const todayDue = (s: SyncState, now: number): boolean => ms(s.todayRequestedAt) > ms(s.todayAt) || now - ms(s.todayAt) >= TODAY_EVERY_MS;
const dailyDue = (s: SyncState, now: number): boolean => now - ms(s.dailyAt) >= DAILY_EVERY_MS;

/**
 * The drain's share (`GET /api/jobs/drain`): for each tenant with ads on and a token, the structure when the last one is an hour old,
 * today's results when the last are 4 h old or a refresh was asked for, and a 28-day report that is still waiting at Meta. A tenant
 * whose budget is spent or whose token is refused is skipped until the next run; the whole run stops before `deadline` (epoch ms).
 * The tenant that waited longest goes first, so a short run cannot starve the last of a long list.
 */
export async function syncAllAds(deadline: number, deps: SyncDeps = defaultDeps): Promise<SyncSummary> {
    return runTenants(deadline, deps, async (creatorId, state, summary) => {
        const now = deps.now().getTime();
        if (structureDue(state, now)) {
            const r = await syncStructure(creatorId, { deadline }, deps);
            if (r.complete) summary.structure++;
            if (r.skipped === 'not_configured' || r.skipped === 'pacer' || r.skipped === 'throttle' || r.skipped === 'account_unreadable') return void summary.skipped++;
        }
        if (deps.now().getTime() >= deadline) return;
        if (todayDue(state, now)) {
            const r = await syncInsights(creatorId, 'today', { deadline }, deps);
            if (r.complete) summary.today++;
            else if (r.skipped) return void summary.skipped++;
        }
        if (state.pendingReportRunId && deps.now().getTime() < deadline) {
            const r = await syncInsights(creatorId, '28d', { deadline }, deps);
            if (r.complete) summary.daily++;
        }
    });
}

/** The cron's share: the trailing 28 days (and each level's reach) of every tenant that has not had them in the last 20 hours. */
export async function syncDailyAds(deadline: number, deps: SyncDeps = defaultDeps): Promise<SyncSummary> {
    return runTenants(deadline, deps, async (creatorId, state, summary) => {
        if (!dailyDue(state, deps.now().getTime()) && !state.pendingReportRunId) return;
        const r = await syncInsights(creatorId, '28d', { deadline }, deps);
        if (r.complete) summary.daily++;
        else if (r.skipped) summary.skipped++;
    });
}

async function runTenants(deadline: number, deps: SyncDeps, one: (creatorId: string, state: SyncState, summary: SyncSummary) => Promise<void>): Promise<SyncSummary> {
    const summary = emptySummary();
    try {
        const ids = await enabledTenants();
        const entries = await Promise.all(ids.map(async (id) => ({ id, state: await readSyncState(id) })));
        entries.sort((a, b) => ms(a.state.structureAt) - ms(b.state.structureAt));
        for (const { id, state } of entries) {
            if (deps.now().getTime() >= deadline) break;
            summary.tenants++;
            try {
                await one(id, state, summary);
            } catch (err) {
                summary.failed++;
                log('warn', 'ads.sync_tenant_failed', { creator_id: id, ...describeError(err) });
            }
        }
    } catch (err) {
        summary.failed++;
        log('error', 'ads.sync_failed', describeError(err));
    }
    return summary;
}

export { boostIdFromName };
