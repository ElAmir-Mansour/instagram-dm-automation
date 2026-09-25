/**
 * `syncInsights(creatorId)`: one tenant's Instagram and Facebook numbers into `post_insights`
 * and `account_insights_daily` (GROWTH.md §2). Runs daily from the cron for every active tenant
 * (`syncAllTenants`), and on demand from `POST /api/growth/sync`, at most once per 10 minutes.
 *
 * Instagram:
 *   1. the account node — the follower total, which no insight gives under 100 followers;
 *   2. the media list, up to 100 posts or 90 days;
 *   3. each post's insights, batched 50 to a request, REELS and FEED with their own metric sets;
 *   4. account days: yesterday back to the last day already stored (28 on a first sync), each day
 *      one total_value request plus the follower/non-follower and surface splits.
 * Facebook: the Page node, the post list, each post's insights, and the Page's day series.
 * TikTok: nothing — the scopes do not exist yet (status.ts says so).
 *
 * Permission-aware: `debug_token` says which scopes the token has. A missing insights permission
 * is a state, recorded once per run in `growth_settings.last_sync` for the status endpoint — not
 * an error, and not a log line per post. Posts still sync with their public counts.
 *
 * Nothing here throws for a Meta failure: a platform that fails ends as `status: 'error'` with the
 * reason, and the other platform still runs. A missing v22 table does throw, so the route can say
 * which migration to run.
 */
import type { AccountDayMetrics, GrowthPlatformSync, GrowthSyncState } from '../../db/rows.js';
import { queryCount, queryOne, queryRows } from '../../db/query.js';
import { describeError, log } from '../../utils/log.js';
import { isMissingSchema } from '../health.js';
import { API_VERSION } from '../instagram.js';
import { isTokenDeathError } from '../http.js';
import { publishedPlatforms } from '../publishedIds.js';
import { getTenant } from '../tenant.js';
import { inspectToken, noteMetaFailure, type TokenInspection } from '../tokenHealth.js';
import { GROWTH_MIGRATION_HINT, GrowthError, INSIGHTS_SCOPE, num, SYNC_INTERVAL_MINUTES } from './common.js';
import { fetchInsights, graphFailure, GraphSession, isPermissionFailure, type InsightOutcome, type InsightTarget } from './graph.js';
import {
    dayBounds, daysToSync, FB_PAGE_DAY_METRICS, FB_PAGE_FIELDS, FB_POST_BASIC_FIELDS, FB_POST_FIELDS,
    FB_POST_METRICS, FB_VIDEO_POST_METRICS, FOLLOWER_METRICS_MIN, followsBreakdown, IG_ACCOUNT_FIELDS, IG_DAY_METRICS, IG_DAY_SPLITS,
    IG_MEDIA_FIELDS, igMetricsFor, mapFbInsights, mapFbPageDays, mapFbPost, mapIgDay, mapIgInsights, mapIgMedia, mapIgSplit,
    MAX_MEDIA, MAX_MEDIA_AGE_DAYS, seriesByDay, utcDay, type MappedPost,
} from './mapping.js';

// ─── Dependencies (injectable for tests) ─────────────────────────────────────────────────

export interface SyncDeps {
    /** `debug_token`. The real one prefers the app token, like the token health check. */
    inspect: (token: string) => Promise<Pick<TokenInspection, 'isValid' | 'scopes' | 'error'>>;
    now: () => Date;
}

const REAL_DEPS: SyncDeps = { inspect: inspectToken, now: () => new Date() };

// ─── Bookkeeping ─────────────────────────────────────────────────────────────────────────

/** Metric names Meta refused, by request kind — remembered so later runs don't ask again. */
type Unsupported = Record<string, string[]>;

function loadUnsupported(state: GrowthSyncState | null): Unsupported {
    // Keyed by API version: a version bump is exactly when a refused name may come back.
    return state?.unsupported?.version === API_VERSION ? { ...state.unsupported.metrics } : {};
}

function remember(unsupported: Unsupported, kind: string, names: readonly string[]): void {
    if (names.length) unsupported[kind] = [...new Set([...(unsupported[kind] ?? []), ...names])];
}

const without = (metrics: readonly string[], skip: readonly string[] | undefined): string[] =>
    metrics.filter((m) => !skip?.includes(m));

/** A single-metric request kind whose every answer was #100: the name itself is refused. */
function rememberSingle(unsupported: Unsupported, kind: string, metric: string, outcomes: readonly InsightOutcome[]): void {
    if (outcomes.length && outcomes.every((o) => !o.ok && o.error.code === 100)) remember(unsupported, kind, [metric]);
}

function platformResult(status: GrowthPlatformSync['status']): GrowthPlatformSync {
    return { status, posts: 0, with_insights: 0, days: 0, throttled: false, error: null };
}

export async function readSyncState(creatorId: string): Promise<GrowthSyncState | null> {
    const row = await queryOne<{ last_sync: GrowthSyncState | null }>(
        'SELECT last_sync FROM growth_settings WHERE creator_id = $1', [creatorId]
    );
    return row?.last_sync ?? null;
}

async function saveSyncState(creatorId: string, state: GrowthSyncState): Promise<void> {
    await queryCount(
        `INSERT INTO growth_settings (creator_id, last_sync) VALUES ($1, $2::jsonb)
         ON CONFLICT (creator_id) DO UPDATE SET last_sync = EXCLUDED.last_sync`,
        [creatorId, JSON.stringify(state)]
    );
}

/**
 * Take this tenant's sync slot: at most one sync per `minutes`. One atomic statement on
 * `last_sync_at`, so it holds across serverless instances, where an in-memory timer would not.
 */
export async function claimSync(
    creatorId: string, minutes: number = SYNC_INTERVAL_MINUTES
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
    const claimed = await queryOne<{ last_sync_at: Date }>(
        `INSERT INTO growth_settings (creator_id, last_sync_at) VALUES ($1, NOW())
         ON CONFLICT (creator_id) DO UPDATE SET last_sync_at = NOW()
          WHERE growth_settings.last_sync_at IS NULL
             OR growth_settings.last_sync_at <= NOW() - make_interval(mins => $2::int)
         RETURNING last_sync_at`,
        [creatorId, minutes]
    );
    if (claimed) return { ok: true };
    const wait = await queryOne<{ wait: number | string | null }>(
        `SELECT CEIL(EXTRACT(EPOCH FROM (last_sync_at + make_interval(mins => $2::int) - NOW())))::int AS wait
           FROM growth_settings WHERE creator_id = $1`,
        [creatorId, minutes]
    );
    return { ok: false, retryAfterSeconds: Math.max(1, num(wait?.wait) ?? minutes * 60) };
}

// ─── Reading and writing rows ────────────────────────────────────────────────────────────

/** Published id → `scheduled_posts.id`, per platform, from `published_post_id` ("FB:… | IG:…"). */
async function loadLinks(creatorId: string): Promise<{ instagram: Map<string, string>; facebook: Map<string, string> }> {
    const rows = await queryRows<{ id: string; published_post_id: string | null }>(
        `SELECT id, published_post_id FROM scheduled_posts
          WHERE creator_id = $1 AND published_post_id IS NOT NULL AND published_post_id <> ''`,
        [creatorId]
    );
    const instagram = new Map<string, string>();
    const facebook = new Map<string, string>();
    for (const row of rows) {
        const { fb, ig } = publishedPlatforms(row.published_post_id);
        if (ig) instagram.set(ig, row.id);
        if (fb) facebook.set(fb, row.id);
    }
    return { instagram, facebook };
}

export function linkPosts(posts: MappedPost[], links: ReadonlyMap<string, string>): void {
    for (const post of posts) {
        post.scheduled_post_id = post.link_ids.map((linkId) => links.get(linkId)).find(Boolean) ?? null;
    }
}

/**
 * One statement for every post. Metrics MERGE over what is stored (`||`): a run that could read
 * only public counts keeps the reach an earlier run read, rather than erasing it.
 */
async function upsertPosts(creatorId: string, platform: 'instagram' | 'facebook', posts: readonly MappedPost[]): Promise<number> {
    if (!posts.length) return 0;
    const rows = posts.map((p) => ({
        media_id: p.media_id, scheduled_post_id: p.scheduled_post_id, media_type: p.media_type, permalink: p.permalink,
        caption: p.caption, thumbnail_url: p.thumbnail_url, published_at: p.published_at, metrics: p.metrics,
    }));
    return queryCount(
        `INSERT INTO post_insights
             (creator_id, platform, media_id, scheduled_post_id, media_type, permalink, caption, thumbnail_url, published_at, metrics, fetched_at)
         SELECT $1, $2, r.media_id, r.scheduled_post_id, r.media_type, r.permalink, r.caption, r.thumbnail_url, r.published_at,
                COALESCE(r.metrics, '{}'::jsonb), NOW()
           FROM jsonb_to_recordset($3::jsonb) AS r(
                media_id text, scheduled_post_id uuid, media_type text, permalink text, caption text,
                thumbnail_url text, published_at timestamptz, metrics jsonb)
         ON CONFLICT (creator_id, platform, media_id) DO UPDATE
            SET scheduled_post_id = COALESCE(EXCLUDED.scheduled_post_id, post_insights.scheduled_post_id),
                media_type = COALESCE(EXCLUDED.media_type, post_insights.media_type),
                permalink = COALESCE(EXCLUDED.permalink, post_insights.permalink),
                caption = EXCLUDED.caption,
                thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, post_insights.thumbnail_url),
                published_at = COALESCE(EXCLUDED.published_at, post_insights.published_at),
                metrics = post_insights.metrics || EXCLUDED.metrics,
                fetched_at = NOW()`,
        [creatorId, platform, JSON.stringify(rows)]
    );
}

async function upsertDays(creatorId: string, platform: 'instagram' | 'facebook', days: ReadonlyMap<string, AccountDayMetrics>): Promise<number> {
    const rows = [...days].filter(([, metrics]) => Object.keys(metrics).length).map(([day, metrics]) => ({ day, metrics }));
    if (!rows.length) return 0;
    return queryCount(
        `INSERT INTO account_insights_daily (creator_id, platform, day, metrics)
         SELECT $1, $2, r.day, r.metrics FROM jsonb_to_recordset($3::jsonb) AS r(day date, metrics jsonb)
         ON CONFLICT (creator_id, platform, day) DO UPDATE
            SET metrics = account_insights_daily.metrics || EXCLUDED.metrics`,
        [creatorId, platform, JSON.stringify(rows)]
    );
}

/** The newest day with insight numbers (not just a follower count), so later runs read only what is new. */
async function lastInsightDay(creatorId: string, platform: 'instagram' | 'facebook'): Promise<string | null> {
    const row = await queryOne<{ day: string | null }>(
        `SELECT to_char(max(day), 'YYYY-MM-DD') AS day FROM account_insights_daily
          WHERE creator_id = $1 AND platform = $2 AND (metrics ? 'reach' OR metrics ? 'views')`,
        [creatorId, platform]
    );
    return row?.day ?? null;
}

function mergeDay(days: Map<string, AccountDayMetrics>, day: string, metrics: AccountDayMetrics): void {
    if (Object.keys(metrics).length) days.set(day, { ...(days.get(day) ?? {}), ...metrics });
}

/**
 * A paged list, newest first, until `max` items or one older than `oldest`. Pages by the
 * `after` cursor with the same request, and stops when Meta gives no `paging.next`.
 */
async function listPages(
    graph: GraphSession, path: string, params: Record<string, string | number>, stop: { max: number; oldest: number; timeKey: string }
): Promise<any[]> {
    const items: any[] = [];
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
        const body = await graph.get(path, after ? { ...params, after } : params);
        for (const item of Array.isArray(body?.data) ? body.data : []) {
            const t = Date.parse(item?.[stop.timeKey]);
            if (Number.isFinite(t) && t < stop.oldest) return items;
            items.push(item);
            if (items.length >= stop.max) return items;
        }
        after = typeof body?.paging?.cursors?.after === 'string' ? body.paging.cursors.after : undefined;
        if (!body?.paging?.next || !after) break;
    }
    return items;
}

// ─── Instagram ───────────────────────────────────────────────────────────────────────────

interface PlatformCtx {
    creatorId: string;
    graph: GraphSession;
    /** Whether the token has the insights scope; null when `debug_token` couldn't say. */
    insights: boolean | null;
    today: string;
    now: Date;
    unsupported: Unsupported;
    links: ReadonlyMap<string, string>;
}

interface PlatformOutcome {
    result: GrowthPlatformSync;
    followers: number | null;
}

/** Every insights request of a run came back refused for permission: the scope is missing. */
const allDenied = (outcomes: readonly InsightOutcome[]): boolean =>
    outcomes.length > 0 && outcomes.every((o) => !o.ok && isPermissionFailure(o.error));

async function syncInstagram(igId: string, ctx: PlatformCtx): Promise<PlatformOutcome> {
    const result = platformResult(ctx.insights === false ? 'missing_permission' : 'ok');
    const { graph } = ctx;

    let followers: number | null = null;
    let media: MappedPost[];
    try {
        const account = await graph.get(igId, { fields: IG_ACCOUNT_FIELDS });
        followers = num(account?.followers_count) ?? null;
        const raw = await listPages(graph, `${igId}/media`, { fields: IG_MEDIA_FIELDS, limit: 50 }, {
            max: MAX_MEDIA, oldest: ctx.now.getTime() - MAX_MEDIA_AGE_DAYS * 86_400_000, timeKey: 'timestamp',
        });
        media = raw.map(mapIgMedia).filter((m): m is MappedPost => m !== null);
    } catch (err) {
        // The token can't read the account at all, so nothing below would work either.
        await noteMetaFailure(ctx.creatorId, err);
        return { result: { ...result, status: 'error', error: graphFailure(err).message }, followers };
    }

    // Per-post insights, one request per post, the two media families apart so a refused name is
    // remembered against the right one.
    let denied = false;
    if (ctx.insights !== false && media.length) {
        for (const kind of ['ig_feed', 'ig_reels'] as const) {
            const group = media.filter((m) => (m.media_type === 'REELS') === (kind === 'ig_reels'));
            if (!group.length || graph.throttled) continue;
            const metrics = without(igMetricsFor(kind === 'ig_reels' ? 'REELS' : 'IMAGE'), ctx.unsupported[kind]);
            if (!metrics.length) continue;
            const { outcomes, unsupported } = await fetchInsights(graph, group.map((m) => ({ id: m.media_id, metrics })));
            remember(ctx.unsupported, kind, unsupported);
            if (allDenied(outcomes)) denied = true;
            outcomes.forEach((o, i) => {
                if (!o.ok) return;
                const post = group[i]!;
                post.metrics = { ...post.metrics, ...mapIgInsights(o.data) };
                result.with_insights++;
            });
        }
    }
    if (denied && result.with_insights === 0) result.status = 'missing_permission';

    linkPosts(media, ctx.links);
    result.posts = await upsertPosts(ctx.creatorId, 'instagram', media);

    // Account days. Today gets the follower total; insight days end yesterday.
    const days = new Map<string, AccountDayMetrics>();
    if (followers !== null) mergeDay(days, ctx.today, { followers });
    if (ctx.insights !== false && result.status !== 'missing_permission' && !graph.throttled) {
        const list = daysToSync(await lastInsightDay(ctx.creatorId, 'instagram'), ctx.today);
        if (list.length) await readInstagramDays(igId, list, followers, days, ctx);
    }
    result.days = await upsertDays(ctx.creatorId, 'instagram', days);
    result.throttled = graph.throttled;
    return { result, followers };
}

async function readInstagramDays(
    igId: string, list: readonly string[], followers: number | null, days: Map<string, AccountDayMetrics>, ctx: PlatformCtx
): Promise<void> {
    const { graph } = ctx;
    const window = (day: string): string => {
        const { since, until } = dayBounds(day);
        return `since=${since}&until=${until}`;
    };

    // One total_value request per day for the whole verified set.
    const dayMetrics = without(IG_DAY_METRICS, ctx.unsupported.ig_day);
    if (dayMetrics.length) {
        const { outcomes, unsupported } = await fetchInsights(graph, list.map((day): InsightTarget => ({
            id: igId, metrics: dayMetrics, params: `period=day&metric_type=total_value&${window(day)}`,
        })));
        remember(ctx.unsupported, 'ig_day', unsupported);
        outcomes.forEach((o, i) => { if (o.ok) mergeDay(days, list[i]!, mapIgDay(o.data)); });
    }

    // Who was reached, and where: the follower/non-follower split is the one that shows whether
    // the account is growing beyond its followers (GROWTH.md §3; README.md §2).
    for (const split of IG_DAY_SPLITS) {
        if (graph.throttled) break;
        if (ctx.unsupported[split.key]?.includes(split.metric)) continue;
        const { outcomes } = await fetchInsights(graph, list.map((day): InsightTarget => ({
            id: igId, metrics: [split.metric],
            params: `period=day&metric_type=total_value&breakdown=${split.breakdown}&${window(day)}`,
        })));
        rememberSingle(ctx.unsupported, split.key, split.metric, outcomes);
        outcomes.forEach((o, i) => { if (o.ok) mergeDay(days, list[i]!, mapIgSplit(split.key, o.data)); });
    }

    // Follows, unfollows and new followers exist only from 100 followers: below that, Instagram
    // answers with nothing, so they are not asked for (the overview says why they are empty).
    if (followers === null || followers < FOLLOWER_METRICS_MIN || graph.throttled) return;
    const follows = await fetchInsights(graph, list.map((day): InsightTarget => ({
        id: igId, metrics: ['follows_and_unfollows'],
        params: `period=day&metric_type=total_value&breakdown=follow_type&${window(day)}`,
    })));
    follows.outcomes.forEach((o, i) => { if (o.ok) mergeDay(days, list[i]!, followsBreakdown(o.data)); });

    const first = dayBounds(list[0]!).since;
    const until = dayBounds(ctx.today).since;
    const series = await fetchInsights(graph, [{ id: igId, metrics: ['follower_count'], params: `period=day&since=${first}&until=${until}` }]);
    const answer = series.outcomes[0];
    if (answer?.ok) for (const [day, value] of seriesByDay(answer.data, 'follower_count')) mergeDay(days, day, { new_followers: value });
}

// ─── Facebook ────────────────────────────────────────────────────────────────────────────

async function syncFacebook(pageId: string, ctx: PlatformCtx): Promise<PlatformOutcome> {
    const result = platformResult(ctx.insights === false ? 'missing_permission' : 'ok');
    const { graph } = ctx;

    let followers: number | null = null;
    let posts: MappedPost[];
    try {
        const page = await graph.get(pageId, { fields: FB_PAGE_FIELDS });
        followers = num(page?.followers_count) ?? num(page?.fan_count) ?? null;
        const stop = { max: MAX_MEDIA, oldest: ctx.now.getTime() - MAX_MEDIA_AGE_DAYS * 86_400_000, timeKey: 'created_time' };
        let raw: any[];
        try {
            raw = await listPages(graph, `${pageId}/posts`, { fields: FB_POST_FIELDS, limit: 50 }, stop);
        } catch (err) {
            // A refused field is not a dead Page: try the minimal list before giving up.
            if (isTokenDeathError(err) || graphFailure(err).status === null) throw err;
            log('warn', 'growth.fb_post_fields_refused', { creator_id: ctx.creatorId, reason: graphFailure(err).message });
            raw = await listPages(graph, `${pageId}/posts`, { fields: FB_POST_BASIC_FIELDS, limit: 50 }, stop);
        }
        posts = raw.map(mapFbPost).filter((p): p is MappedPost => p !== null);
    } catch (err) {
        await noteMetaFailure(ctx.creatorId, err);
        return { result: { ...result, status: 'error', error: graphFailure(err).message }, followers };
    }

    let denied = false;
    if (ctx.insights !== false && posts.length) {
        for (const kind of ['fb_post', 'fb_video'] as const) {
            const group = posts.filter((p) => (p.media_type === 'VIDEO') === (kind === 'fb_video'));
            if (!group.length || graph.throttled) continue;
            const metrics = without(kind === 'fb_video' ? FB_VIDEO_POST_METRICS : FB_POST_METRICS, ctx.unsupported[kind]);
            if (!metrics.length) continue;
            const { outcomes, unsupported } = await fetchInsights(graph, group.map((p) => ({ id: p.media_id, metrics })));
            remember(ctx.unsupported, kind, unsupported);
            if (allDenied(outcomes)) denied = true;
            outcomes.forEach((o, i) => {
                if (!o.ok) return;
                const post = group[i]!;
                post.metrics = { ...post.metrics, ...mapFbInsights(o.data) };
                result.with_insights++;
            });
        }
    }
    if (denied && result.with_insights === 0) result.status = 'missing_permission';

    linkPosts(posts, ctx.links);
    result.posts = await upsertPosts(ctx.creatorId, 'facebook', posts);

    const days = new Map<string, AccountDayMetrics>();
    if (ctx.insights !== false && result.status !== 'missing_permission' && !graph.throttled) {
        const list = daysToSync(await lastInsightDay(ctx.creatorId, 'facebook'), ctx.today);
        const metrics = without(Object.keys(FB_PAGE_DAY_METRICS), ctx.unsupported.fb_page_day);
        if (list.length && metrics.length) {
            const since = dayBounds(list[0]!).since;
            const until = dayBounds(ctx.today).since;
            const { outcomes, unsupported } = await fetchInsights(graph, [{ id: pageId, metrics, params: `period=day&since=${since}&until=${until}` }]);
            remember(ctx.unsupported, 'fb_page_day', unsupported);
            const answer = outcomes[0];
            if (answer?.ok) for (const [day, metricsOfDay] of mapFbPageDays(answer.data)) mergeDay(days, day, metricsOfDay);
        }
    }
    // Today's follower total, as for Instagram. Past days carry `page_follows` for theirs.
    if (followers !== null) mergeDay(days, ctx.today, { followers });
    result.days = await upsertDays(ctx.creatorId, 'facebook', days);
    result.throttled = graph.throttled;
    return { result, followers };
}

// ─── One tenant, and every tenant ────────────────────────────────────────────────────────

async function guarded(platform: string, creatorId: string, run: () => Promise<PlatformOutcome>): Promise<PlatformOutcome> {
    try {
        return await run();
    } catch (err) {
        if (isMissingSchema(err)) throw err;
        log('warn', 'growth.platform_sync_failed', { creator_id: creatorId, platform, ...describeError(err) });
        return { result: { ...platformResult('error'), error: err instanceof Error ? err.message.slice(0, 300) : String(err) }, followers: null };
    }
}

export async function syncInsights(creatorId: string, deps: Partial<SyncDeps> = {}): Promise<GrowthSyncState> {
    const d: SyncDeps = { ...REAL_DEPS, ...deps };
    const now = d.now();
    const creator = await getTenant(creatorId, ['id', 'instagram_page_id', 'facebook_page_id', 'page_access_token']);
    if (!creator) throw new GrowthError(404, 'No such tenant.');
    const unsupported = loadUnsupported(await readSyncState(creatorId));

    const token = creator.page_access_token || '';
    let scopes: string[] | null = null;
    let tokenProblem: string | null = token ? null : 'No access token is stored for this tenant.';
    if (token) {
        try {
            const inspection = await d.inspect(token);
            if (inspection.isValid) scopes = inspection.scopes;
            else tokenProblem = inspection.error ?? 'Meta reports the access token as not valid.';
        } catch (err) {
            // Not knowing the scopes is not a reason to skip the sync: Meta's answers will say.
            log('warn', 'growth.scope_check_failed', { creator_id: creatorId, ...describeError(err) });
        }
    }

    const notConnected = (hasId: boolean): GrowthPlatformSync =>
        ({ ...platformResult('not_connected'), error: hasId ? tokenProblem : null });
    let instagram: PlatformOutcome = { result: notConnected(Boolean(creator.instagram_page_id)), followers: null };
    let facebook: PlatformOutcome = { result: notConnected(Boolean(creator.facebook_page_id)), followers: null };

    if (!tokenProblem) {
        const graph = new GraphSession(token);
        const links = await loadLinks(creatorId);
        const allows = (scope: string): boolean | null => (scopes === null ? null : scopes.includes(scope));
        const base = { creatorId, graph, today: utcDay(now), now, unsupported };
        if (creator.instagram_page_id) {
            const igId = creator.instagram_page_id;
            instagram = await guarded('instagram', creatorId, () => syncInstagram(igId, {
                ...base, insights: allows(INSIGHTS_SCOPE.instagram), links: links.instagram,
            }));
        }
        if (creator.facebook_page_id) {
            const pageId = creator.facebook_page_id;
            facebook = await guarded('facebook', creatorId, () => syncFacebook(pageId, {
                ...base, insights: allows(INSIGHTS_SCOPE.facebook), links: links.facebook,
            }));
        }
    }

    const missing: string[] = [];
    for (const [platform, outcome] of [['instagram', instagram], ['facebook', facebook]] as const) {
        const scope = INSIGHTS_SCOPE[platform];
        if (outcome.result.status === 'missing_permission' || (scopes !== null && outcome.result.status !== 'not_connected' && !scopes.includes(scope))) {
            missing.push(scope);
        }
    }

    const state: GrowthSyncState = {
        finished_at: d.now().toISOString(),
        instagram: instagram.result,
        facebook: facebook.result,
        scopes,
        missing,
        unsupported: { version: API_VERSION, metrics: unsupported },
        followers: { instagram: instagram.followers, facebook: facebook.followers },
    };
    await saveSyncState(creatorId, state);

    const summary = (r: GrowthPlatformSync) => ({ status: r.status, posts: r.posts, with_insights: r.with_insights, days: r.days, throttled: r.throttled });
    log('info', 'growth.synced', {
        creator_id: creatorId, instagram: summary(state.instagram), facebook: summary(state.facebook), missing,
    });
    return state;
}

/** What `POST /api/growth/sync` answers. */
export interface SyncResponse {
    synced: { instagram: GrowthPlatformSync; facebook: GrowthPlatformSync };
    lastSync: string;
}

/** The on-demand sync: the 10-minute slot first, then the sync. A 429 carries `retryAfter` (seconds). */
export async function runSync(creatorId: string, deps: Partial<SyncDeps> = {}): Promise<SyncResponse> {
    const claim = await claimSync(creatorId);
    if (!claim.ok) {
        const minutes = Math.ceil(claim.retryAfterSeconds / 60);
        throw new GrowthError(429, `Insights were synced less than ${SYNC_INTERVAL_MINUTES} minutes ago. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, {
            retryAfter: claim.retryAfterSeconds,
        });
    }
    const state = await syncInsights(creatorId, deps);
    return { synced: { instagram: state.instagram, facebook: state.facebook }, lastSync: state.finished_at };
}

export interface CronGrowthResult {
    tenants: number;
    synced: number;
    skipped: number;
    failed: number;
    /** Why nothing ran at all, when that is the case. */
    skippedReason?: string;
}

/**
 * The daily cron's sweep: every active tenant, one at a time, inside `budgetMs`. Cannot throw.
 * A tenant synced in the last 10 minutes (someone pressed Sync) is skipped, not synced twice.
 */
export async function syncAllTenants(opts: { budgetMs?: number; deps?: Partial<SyncDeps> } = {}): Promise<CronGrowthResult> {
    const started = Date.now();
    const budget = opts.budgetMs ?? 90_000;
    const out: CronGrowthResult = { tenants: 0, synced: 0, skipped: 0, failed: 0 };
    let tenants: { id: string }[];
    try {
        tenants = await queryRows<{ id: string }>('SELECT id FROM creators WHERE is_active = TRUE ORDER BY created_at');
    } catch (err) {
        log('error', 'growth.cron_list_failed', describeError(err));
        return { ...out, skippedReason: 'could not list tenants' };
    }
    out.tenants = tenants.length;
    for (const [i, tenant] of tenants.entries()) {
        if (Date.now() - started > budget) {
            out.skipped += tenants.length - i;
            log('warn', 'growth.cron_budget_spent', { left: tenants.length - i, budget_ms: budget });
            break;
        }
        try {
            const claim = await claimSync(tenant.id);
            if (!claim.ok) {
                out.skipped++;
                continue;
            }
            await syncInsights(tenant.id, opts.deps);
            out.synced++;
        } catch (err) {
            if (isMissingSchema(err)) {
                log('warn', 'growth.cron_schema_missing', { hint: GROWTH_MIGRATION_HINT });
                return { ...out, skippedReason: 'migration v22 is not applied' };
            }
            out.failed++;
            log('warn', 'growth.cron_tenant_failed', { creator_id: tenant.id, ...describeError(err) });
        }
    }
    return out;
}
