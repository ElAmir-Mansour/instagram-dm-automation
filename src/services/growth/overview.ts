/**
 * `GET /api/growth/overview` and `GET /api/growth/posts` (GROWTH.md §3), read from the tables the
 * sync fills. No Meta call: the dashboard can load this as often as it likes.
 *
 * Anything unavailable is null, never 0 and never estimated. Where a KPI can come from two places,
 * the account-level number wins (it counts engagement on older posts and stories too) and
 * `kpi_sources` says which one was used.
 *
 * Definitions:
 *   interactions     total_interactions when Meta gave it, else likes + comments + saves + shares
 *   engagement_rate  interactions / reach, for a post; for a window, Σ interactions / Σ reach over the
 *                    posts that have a reach
 *   best_times       [weekday 0=Sunday][hour 0–23] in the tenant's timezone: the average views of the
 *                    tenant's own posts published in that slot (interactions when no post has views).
 *                    Instagram's `online_followers` is empty under 100 followers, so our own posts
 *                    are the source.
 */
import type { AccountDayMetrics, AccountInsightsDailyRow, PostInsightRow, PostMetrics } from '../../db/rows.js';
import { queryRows } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { isMissingSchema } from '../health.js';
import { getStudioSettings } from '../studio/settings.js';
import { clampInt } from './common.js';
import { addDays, FOLLOWER_METRICS_MIN, UNDER_100_REASON, utcDay } from './mapping.js';
import { getGrowthSettings } from './settings.js';

export const GROWTH_PLATFORMS = ['instagram', 'facebook'] as const;
export type OverviewPlatform = (typeof GROWTH_PLATFORMS)[number] | 'all';

/** The metric keys every PostInsight carries, null when unavailable, so the table's columns are stable. */
export const POST_METRIC_KEYS = [
    'views', 'reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions', 'follows', 'profile_visits', 'avg_watch_time_ms',
    'skip_rate',
] as const;

export type PostInsight = Omit<PostInsightRow, 'metrics' | 'published_at' | 'fetched_at'> & {
    published_at: string | null;
    fetched_at: string | null;
    metrics: Record<string, number | null>;
    interactions: number | null;
    engagement_rate: number | null;
};

const round = (n: number, places = 4): number => Math.round(n * 10 ** places) / 10 ** places;

/** The median skip rate of the posts that report one (reels), to one decimal; null when none do. */
function medianSkip(posts: readonly PostInsight[]): number | null {
    const v = posts.map((p) => p.metrics.skip_rate).filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return round(v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2, 1);
}
const has = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Meta's aggregate when there is one, else the sum of whatever counts exist; null when none do. */
export function interactionsOf(m: PostMetrics | null | undefined): number | null {
    if (!m) return null;
    if (has(m.total_interactions)) return m.total_interactions;
    const parts = [m.likes, m.comments, m.saved, m.shares].filter(has);
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/** interactions / reach, or null when either is unknown or reach is 0. */
export function engagementRate(m: PostMetrics | null | undefined): number | null {
    const interactions = interactionsOf(m);
    return interactions !== null && m && has(m.reach) && m.reach > 0 ? round(interactions / m.reach) : null;
}

const iso = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function toPostInsight(row: PostInsightRow): PostInsight {
    const stored = (row.metrics ?? {}) as Record<string, unknown>;
    const metrics: Record<string, number | null> = {};
    for (const key of POST_METRIC_KEYS) metrics[key] = has(stored[key]) ? (stored[key] as number) : null;
    for (const [key, value] of Object.entries(stored)) if (!(key in metrics) && has(value)) metrics[key] = value;
    return {
        ...row,
        published_at: iso(row.published_at),
        fetched_at: iso(row.fetched_at),
        metrics,
        interactions: interactionsOf(row.metrics),
        engagement_rate: engagementRate(row.metrics),
    };
}

// ─── Best times ──────────────────────────────────────────────────────────────────────────

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0 = Sunday) and hour of an instant, in `timezone`. */
export function slotOf(date: Date, timezone: string): { weekday: number; hour: number } {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
        .formatToParts(date);
    const weekday = WEEKDAYS[parts.find((p) => p.type === 'weekday')?.value ?? ''] ?? 0;
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
    return { weekday, hour };
}

export interface BestTimes {
    grid: number[][];
    counts: number[][];
    metric: 'views' | 'interactions' | null;
    posts: number;
}

const emptyGrid = (): number[][] => Array.from({ length: 7 }, () => Array<number>(24).fill(0));

/**
 * The 7×24 heatmap from the tenant's own posts. A cell is the average of the posts published in
 * that slot; `counts` says how many, so an empty slot can be told apart from a slot that got 0.
 */
export function bestTimes(posts: readonly PostInsight[], timezone: string): BestTimes {
    const withViews = posts.filter((p) => p.published_at && has(p.metrics.views));
    const metric: BestTimes['metric'] = withViews.length ? 'views'
        : posts.some((p) => p.published_at && p.interactions !== null) ? 'interactions' : null;
    const grid = emptyGrid();
    const counts = emptyGrid();
    if (!metric) return { grid, counts, metric, posts: 0 };
    const sums = emptyGrid();
    let used = 0;
    for (const p of posts) {
        const score = metric === 'views' ? p.metrics.views : p.interactions;
        if (!p.published_at || !has(score)) continue;
        const { weekday, hour } = slotOf(new Date(p.published_at), timezone);
        sums[weekday]![hour]! += score;
        counts[weekday]![hour]! += 1;
        used++;
    }
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const n = counts[d]![h]!;
            grid[d]![h] = n ? round(sums[d]![h]! / n, 1) : 0;
        }
    }
    return { grid, counts, metric, posts: used };
}

// ─── Aggregates ──────────────────────────────────────────────────────────────────────────

/** Σ over the rows that have the value, or null when none do. */
function sumOf<T>(rows: readonly T[], pick: (row: T) => unknown): number | null {
    const values = rows.map(pick).filter(has);
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

function meanOf<T>(rows: readonly T[], pick: (row: T) => unknown, places = 1): number | null {
    const values = rows.map(pick).filter(has);
    return values.length ? round(values.reduce((a, b) => a + b, 0) / values.length, places) : null;
}

export interface OverviewInput {
    /** Posts from the lookback (at least 90 days), newest first. */
    posts: readonly PostInsight[];
    /** Account days inside the window. */
    days: readonly Pick<AccountInsightsDailyRow, 'platform' | 'day' | 'metrics'>[];
    /** The newest follower total per platform, whenever it was recorded. */
    latestFollowers: Readonly<Record<string, number | undefined>>;
    windowDays: number;
    today: string;
    timezone: string;
    platforms: readonly string[];
}

export interface Overview {
    days: number;
    platform: OverviewPlatform;
    timezone: string;
    kpis: {
        followers: number | null;
        followers_delta: number | null;
        reach: number | null;
        views: number | null;
        engagement_rate: number | null;
        saves: number | null;
        shares: number | null;
        profile_visits: number | null;
        interactions: number | null;
        posts: number;
        /** Share of reach from accounts that don't follow (Instagram's follow_type split), 0–1. */
        non_follower_reach_share: number | null;
        /** Median `skip_rate` over the window's reels: % of views gone within 3 seconds, 0–100. */
        skip_rate: number | null;
    };
    kpi_sources: Record<'reach' | 'views' | 'saves' | 'shares' | 'profile_visits', 'account' | 'posts' | null>;
    /** Instagram's follower / non-follower split over the window. */
    audience_split: {
        reach: { followers: number | null; non_followers: number | null };
        views: { followers: number | null; non_followers: number | null };
    } | null;
    /** Instagram reach by surface over the window: REEL, POST, CAROUSEL_CONTAINER, STORY. */
    reach_by_surface: Record<string, number> | null;
    trend: { day: string; reach: number | null; views: number | null; followers: number | null }[];
    best_times: number[][];
    best_times_meta: { source: 'own_posts'; metric: BestTimes['metric']; posts: number; counts: number[][]; timezone: string };
    top_posts: PostInsight[];
    by_type: {
        type: string; posts: number; avg_views: number | null; avg_engagement: number | null;
        avg_reach: number | null; avg_interactions: number | null; avg_watch_time_ms: number | null;
        avg_skip_rate: number | null;
    }[];
    by_platform: { platform: string; posts: number; followers: number | null; views: number | null; reach: number | null; avg_views: number | null }[];
    /** Why a number is empty, by key, e.g. `follows`: "Instagram shares this once…". */
    notes: Record<string, string>;
}

/** Pure: everything the overview says, from rows. */
export function buildOverview(input: OverviewInput, platform: OverviewPlatform): Overview {
    const start = addDays(input.today, -(input.windowDays - 1));
    const inWindow = input.posts.filter((p) => p.published_at && p.published_at.slice(0, 10) >= start);
    const days = input.days.filter((d) => d.day >= start && d.day <= input.today);
    const dayMetric = (key: keyof AccountDayMetrics) => sumOf(days, (d) => d.metrics?.[key]);

    // Followers: the newest total per platform; the delta against the oldest total in the window.
    let followers: number | null = null;
    let delta: number | null = null;
    let deltaKnown = true;
    for (const p of input.platforms) {
        const latest = input.latestFollowers[p];
        if (!has(latest)) continue;
        followers = (followers ?? 0) + latest;
        const oldest = days.filter((d) => d.platform === p && has(d.metrics?.followers)).sort((a, b) => a.day.localeCompare(b.day))[0];
        if (oldest && oldest.day < input.today) delta = (delta ?? 0) + (latest - (oldest.metrics.followers as number));
        else deltaKnown = false;
    }
    if (!deltaKnown) delta = null;

    const withReach = inWindow.filter((p) => has(p.metrics.reach) && (p.metrics.reach as number) > 0 && p.interactions !== null);
    const reachSum = sumOf(withReach, (p) => p.metrics.reach);
    const engagement = reachSum ? round((sumOf(withReach, (p) => p.interactions) ?? 0) / reachSum) : null;

    const either = (account: number | null, posts: number | null) =>
        (account !== null ? { value: account, source: 'account' as const } : posts !== null ? { value: posts, source: 'posts' as const } : { value: null, source: null });
    const reach = either(dayMetric('reach'), sumOf(inWindow, (p) => p.metrics.reach));
    const views = either(dayMetric('views'), sumOf(inWindow, (p) => p.metrics.views));
    const saves = either(dayMetric('saves'), sumOf(inWindow, (p) => p.metrics.saved));
    const shares = either(dayMetric('shares'), sumOf(inWindow, (p) => p.metrics.shares));
    const visits = either(dayMetric('profile_views'), sumOf(inWindow, (p) => p.metrics.profile_visits));

    const ig = days.filter((d) => d.platform === 'instagram');
    const split = {
        reach: { followers: sumOf(ig, (d) => d.metrics?.reach_followers), non_followers: sumOf(ig, (d) => d.metrics?.reach_non_followers) },
        views: { followers: sumOf(ig, (d) => d.metrics?.views_followers), non_followers: sumOf(ig, (d) => d.metrics?.views_non_followers) },
    };
    const splitKnown = [split.reach.followers, split.reach.non_followers, split.views.followers, split.views.non_followers].some((v) => v !== null);
    const splitTotal = (split.reach.followers ?? 0) + (split.reach.non_followers ?? 0);
    const surface: Record<string, number> = {};
    for (const d of ig) for (const [k, v] of Object.entries(d.metrics?.reach_by_surface ?? {})) if (has(v)) surface[k] = (surface[k] ?? 0) + v;

    // One point per day, so the chart has no gaps to invent.
    const trend: Overview['trend'] = [];
    for (let day = start; day <= input.today; day = addDays(day, 1)) {
        const rows = days.filter((d) => d.day === day);
        const followerPlatforms = input.platforms.filter((p) => days.some((d) => d.platform === p && has(d.metrics?.followers)));
        const followerRows = rows.filter((d) => has(d.metrics?.followers));
        trend.push({
            day,
            reach: sumOf(rows, (d) => d.metrics?.reach),
            views: sumOf(rows, (d) => d.metrics?.views),
            // Summed only when every platform that records followers has that day, or the line would jump.
            followers: followerRows.length && followerRows.length === followerPlatforms.length ? sumOf(followerRows, (d) => d.metrics?.followers) : null,
        });
    }

    const best = bestTimes(input.posts, input.timezone);
    const score = (p: PostInsight): number => (best.metric === 'interactions' ? p.interactions : p.metrics.views) ?? -1;
    const top = [...inWindow].sort((a, b) => score(b) - score(a) || (b.engagement_rate ?? -1) - (a.engagement_rate ?? -1)).slice(0, 5);

    const types = [...new Set(inWindow.map((p) => p.media_type ?? 'UNKNOWN'))];
    const byType = types.map((type) => {
        const group = inWindow.filter((p) => (p.media_type ?? 'UNKNOWN') === type);
        return {
            type,
            posts: group.length,
            avg_views: meanOf(group, (p) => p.metrics.views),
            avg_engagement: meanOf(group, (p) => p.engagement_rate, 4),
            avg_reach: meanOf(group, (p) => p.metrics.reach),
            avg_interactions: meanOf(group, (p) => p.interactions),
            avg_watch_time_ms: meanOf(group, (p) => p.metrics.avg_watch_time_ms, 0),
            avg_skip_rate: meanOf(group, (p) => p.metrics.skip_rate, 1),
        };
    }).sort((a, b) => b.posts - a.posts);

    const byPlatform = input.platforms.map((p) => {
        const posts = inWindow.filter((x) => x.platform === p);
        const own = days.filter((d) => d.platform === p);
        return {
            platform: p,
            posts: posts.length,
            followers: has(input.latestFollowers[p]) ? (input.latestFollowers[p] as number) : null,
            views: sumOf(own, (d) => d.metrics?.views),
            reach: sumOf(own, (d) => d.metrics?.reach),
            avg_views: meanOf(posts, (x) => x.metrics.views),
        };
    });

    const notes: Record<string, string> = {};
    const igFollowers = input.latestFollowers.instagram;
    if (input.platforms.includes('instagram') && has(igFollowers) && igFollowers < FOLLOWER_METRICS_MIN) {
        notes.follows = UNDER_100_REASON;
        notes.unfollows = UNDER_100_REASON;
        notes.new_followers = UNDER_100_REASON;
        notes.online_followers = `${UNDER_100_REASON} The best times below come from your own posts instead.`;
    }
    if (best.metric) {
        notes.best_times = `Average ${best.metric} of your own ${best.posts} post${best.posts === 1 ? '' : 's'}, by the weekday and hour they went out (${input.timezone}).`;
    }
    if (!splitKnown && input.platforms.includes('instagram')) {
        notes.audience_split = 'No follower / non-follower split yet: it needs instagram_manage_insights and a sync.';
    }

    return {
        days: input.windowDays,
        platform,
        timezone: input.timezone,
        kpis: {
            followers,
            followers_delta: delta,
            reach: reach.value,
            views: views.value,
            engagement_rate: engagement,
            saves: saves.value,
            shares: shares.value,
            profile_visits: visits.value,
            interactions: sumOf(inWindow, (p) => p.interactions),
            posts: inWindow.length,
            non_follower_reach_share: splitTotal > 0 ? round((split.reach.non_followers ?? 0) / splitTotal) : null,
            skip_rate: medianSkip(inWindow),
        },
        kpi_sources: { reach: reach.source, views: views.source, saves: saves.source, shares: shares.source, profile_visits: visits.source },
        audience_split: splitKnown ? split : null,
        reach_by_surface: Object.keys(surface).length ? surface : null,
        trend,
        best_times: best.grid,
        best_times_meta: { source: 'own_posts', metric: best.metric, posts: best.posts, counts: best.counts, timezone: input.timezone },
        top_posts: top,
        by_type: byType,
        by_platform: byPlatform,
        notes,
    };
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────

export function parsePlatform(raw: unknown): OverviewPlatform {
    return raw === 'instagram' || raw === 'facebook' ? raw : 'all';
}

const platformsOf = (p: OverviewPlatform): string[] => (p === 'all' ? [...GROWTH_PLATFORMS] : [p]);

/** The tenant's timezone for the heatmap: the Growth audience's, else the Studio's, else UTC. */
export async function tenantTimezone(creatorId: string, audienceTimezone?: string): Promise<string> {
    if (audienceTimezone) return audienceTimezone;
    try {
        const tz = (await getStudioSettings(creatorId)).schedule?.timezone;
        if (typeof tz === 'string' && tz) return tz;
    } catch (err) {
        if (!isMissingSchema(err)) log('warn', 'growth.timezone_unreadable', describeError(err));
    }
    return 'UTC';
}

async function readPosts(creatorId: string, platforms: readonly string[], lookbackDays: number): Promise<PostInsight[]> {
    const rows = await queryRows<PostInsightRow>(
        `SELECT id, creator_id, platform, media_id, scheduled_post_id, media_type, permalink, caption, thumbnail_url,
                published_at, metrics, fetched_at
           FROM post_insights
          WHERE creator_id = $1 AND platform = ANY($2::text[])
            AND published_at >= NOW() - make_interval(days => $3::int)
          ORDER BY published_at DESC
          LIMIT 500`,
        [creatorId, [...platforms], lookbackDays]
    );
    return rows.map(toPostInsight);
}

export async function getOverview(creatorId: string, query: { days?: unknown; platform?: unknown }, now: Date = new Date()): Promise<Overview> {
    const windowDays = clampInt(query.days, 1, 365, 28);
    const platform = parsePlatform(query.platform);
    const platforms = platformsOf(platform);
    const today = utcDay(now);
    const settings = await getGrowthSettings(creatorId);

    const [posts, days, latest, timezone] = await Promise.all([
        readPosts(creatorId, platforms, Math.max(windowDays, 90)),
        queryRows<Pick<AccountInsightsDailyRow, 'platform' | 'day' | 'metrics'>>(
            `SELECT platform, to_char(day, 'YYYY-MM-DD') AS day, metrics FROM account_insights_daily
              WHERE creator_id = $1 AND platform = ANY($2::text[]) AND day >= $3::date
              ORDER BY day`,
            [creatorId, platforms, addDays(today, -(windowDays - 1))]
        ),
        queryRows<{ platform: string; followers: number | string | null }>(
            `SELECT DISTINCT ON (platform) platform, (metrics->>'followers')::float8 AS followers
               FROM account_insights_daily
              WHERE creator_id = $1 AND platform = ANY($2::text[]) AND metrics ? 'followers'
              ORDER BY platform, day DESC`,
            [creatorId, platforms]
        ),
        tenantTimezone(creatorId, settings.audience.timezone),
    ]);

    const latestFollowers: Record<string, number | undefined> = {};
    for (const row of latest) {
        const n = Number(row.followers);
        if (Number.isFinite(n)) latestFollowers[row.platform] = n;
    }
    return buildOverview({ posts, days, latestFollowers, windowDays, today, timezone, platforms }, platform);
}

export const POST_SORTS = [
    'published_at', 'views', 'reach', 'likes', 'comments', 'saved', 'shares', 'engagement_rate', 'interactions', 'avg_watch_time_ms',
    'skip_rate',
] as const;

/** Sorted descending, unknowns last. */
export function sortPosts(posts: PostInsight[], sort: string): PostInsight[] {
    const key = (POST_SORTS as readonly string[]).includes(sort) ? sort : 'published_at';
    const value = (p: PostInsight): number | null => {
        if (key === 'published_at') return p.published_at ? Date.parse(p.published_at) : null;
        if (key === 'engagement_rate') return p.engagement_rate;
        if (key === 'interactions') return p.interactions;
        return p.metrics[key] ?? null;
    };
    return [...posts].sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        return vb - va;
    });
}

export async function listPostInsights(
    creatorId: string, query: { days?: unknown; sort?: unknown; platform?: unknown; type?: unknown }
): Promise<{ posts: PostInsight[] }> {
    const days = clampInt(query.days, 1, 365, 90);
    const platforms = platformsOf(parsePlatform(query.platform));
    let posts = await readPosts(creatorId, platforms, days);
    if (typeof query.type === 'string' && query.type.trim()) {
        const type = query.type.trim().toUpperCase();
        posts = posts.filter((p) => (p.media_type ?? '').toUpperCase() === type);
    }
    return { posts: sortPosts(posts, typeof query.sort === 'string' ? query.sort : 'published_at').slice(0, 200) };
}
