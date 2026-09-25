/**
 * Meta's JSON → our rows, and nothing else: no I/O, no clock.
 *
 * Every field and metric name here was verified against production on Graph API v26.0 on
 * 2026-09-25 (README.md §2). That matters more than usual: ONE invalid metric in a request fails
 * the whole call with (#100) "The value must be a valid insights metric", so a speculative name
 * costs every metric beside it. The sync still recovers from a #100 (graph.ts `fetchInsights`),
 * but these lists are the ones known to answer.
 *
 * A metric Meta did not return is left out of `metrics`, never set to 0.
 */
import type { AccountDayMetrics, PostMetrics } from '../../db/rows.js';
import { num } from './common.js';

// ─── Field and metric lists (verified, README.md §2) ─────────────────────────────────────

export const IG_ACCOUNT_FIELDS = 'username,followers_count,media_count';
export const IG_MEDIA_FIELDS = 'id,media_type,media_product_type,timestamp,like_count,comments_count,permalink,caption,thumbnail_url,media_url';

/** FEED media (IMAGE, CAROUSEL_ALBUM): all accepted in one call. */
export const IG_FEED_METRICS = ['views', 'reach', 'saved', 'shares', 'total_interactions', 'likes', 'comments', 'profile_visits', 'follows'] as const;
/** REELS media: all accepted in one call. Both watch times are milliseconds. */
export const IG_REELS_METRICS = [
    'views', 'reach', 'saved', 'shares', 'total_interactions', 'likes', 'comments', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time',
] as const;

/** Account metrics, one day per request, `period=day&metric_type=total_value`. */
export const IG_DAY_METRICS = [
    'reach', 'views', 'accounts_engaged', 'total_interactions', 'likes', 'comments', 'saves', 'shares',
    'profile_views', 'profile_links_taps', 'website_clicks',
] as const;
/** The same, split: who was reached (followers or not), and on which surface. One request each. */
export const IG_DAY_SPLITS = [
    { key: 'ig_reach_follow', metric: 'reach', breakdown: 'follow_type' },
    { key: 'ig_views_follow', metric: 'views', breakdown: 'follow_type' },
    { key: 'ig_reach_surface', metric: 'reach', breakdown: 'media_product_type' },
] as const;

export const FB_PAGE_FIELDS = 'followers_count,fan_count';
/**
 * The verified post list, plus `full_picture`, which `GET /api/posts/live` has always read from
 * the same PagePost node. `media_type` is 'album' for a carousel and 'video' for a reel.
 */
export const FB_POST_FIELDS = 'id,created_time,message,permalink_url,attachments{media_type,target{id}},full_picture';
/** The fallback if the list above is refused. */
export const FB_POST_BASIC_FIELDS = 'id,created_time,message,permalink_url';
export const FB_POST_METRICS = ['post_media_view', 'post_total_media_view_unique', 'post_clicks', 'post_reactions_by_type_total'] as const;
/** Video posts only. `post_video_avg_time_watched` is milliseconds. */
export const FB_VIDEO_POST_METRICS = [...FB_POST_METRICS, 'post_video_views', 'post_video_avg_time_watched'] as const;
/**
 * Page metrics by day (`period=day&since&until`), and the account-day key each lands in.
 * `page_follows` is a RUNNING TOTAL: its last value is the follower count, and it is never summed.
 * Rejected on v26 (#100), so absent here: `page_impressions`, `page_impressions_unique`, `page_fans`.
 */
export const FB_PAGE_DAY_METRICS: Readonly<Record<string, keyof AccountDayMetrics>> = {
    page_media_view: 'views',
    page_total_media_view_unique: 'reach',
    page_post_engagements: 'post_engagements',
    page_daily_follows_unique: 'follows',
    page_views_total: 'profile_views',
    page_follows: 'followers',
};

/** How far back the media list goes, whichever comes first. */
export const MAX_MEDIA = 100;
export const MAX_MEDIA_AGE_DAYS = 90;
/** Account days read on a first sync, and re-read on later ones (Meta's data can be 48h late). */
export const BACKFILL_DAYS = 28;
export const REFRESH_DAYS = 3;
/**
 * `follower_count`, `follows_and_unfollows`, `online_followers` and `follower_demographics`
 * return nothing (no error, no data) under this many followers.
 */
export const FOLLOWER_METRICS_MIN = 100;
export const UNDER_100_REASON = 'Instagram shares this once the account has 100+ followers.';

// ─── Small readers ───────────────────────────────────────────────────────────────────────

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const id = (v: unknown): string | null =>
    typeof v === 'string' && v ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null;

function iso(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Drops the undefined keys, so the stored JSON holds only what Meta answered. */
export function compactMetrics<T extends object>(m: T): T {
    const out = { ...m } as Record<string, unknown>;
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out as T;
}

/** The sum of an object's numeric values (`post_reactions_by_type_total`), or undefined when there is no object. */
export function sumValues(v: unknown): number | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    let total = 0;
    for (const x of Object.values(v as Record<string, unknown>)) {
        const n = num(x);
        if (n !== undefined) total += n;
    }
    return total;
}

// ─── Posts ───────────────────────────────────────────────────────────────────────────────

/** One post, ready to upsert into post_insights. */
export interface MappedPost {
    media_id: string;
    media_type: string | null;
    permalink: string | null;
    caption: string | null;
    thumbnail_url: string | null;
    published_at: string | null;
    metrics: PostMetrics;
    /** Ids a `scheduled_posts.published_post_id` may name this post by. */
    link_ids: string[];
    scheduled_post_id: string | null;
}

/** REELS for a reel (whatever its media_type says), else IMAGE / CAROUSEL_ALBUM / VIDEO. */
export function igMediaType(raw: any): string | null {
    if (raw?.media_product_type === 'REELS') return 'REELS';
    return text(raw?.media_type);
}

/** The verified metric set for this media. */
export function igMetricsFor(mediaType: string | null): readonly string[] {
    return mediaType === 'REELS' ? IG_REELS_METRICS : IG_FEED_METRICS;
}

/** An `/{ig-user}/media` item, with the public counts it carries (likes, comments). */
export function mapIgMedia(raw: any): MappedPost | null {
    const mediaId = id(raw?.id);
    if (!mediaId) return null;
    return {
        media_id: mediaId,
        media_type: igMediaType(raw),
        permalink: text(raw.permalink),
        caption: text(raw.caption),
        // An image's media_url is the image; a video's is the video, so its thumbnail_url instead.
        thumbnail_url: text(raw.thumbnail_url) ?? (raw.media_type === 'VIDEO' ? null : text(raw.media_url)),
        published_at: iso(raw.timestamp),
        metrics: compactMetrics<PostMetrics>({ likes: num(raw.like_count), comments: num(raw.comments_count) }),
        link_ids: [mediaId],
        scheduled_post_id: null,
    };
}

/**
 * `{ data: [{ name, values: [{ value }] }] }`, falling back to `total_value.value` → `{ name: value }`.
 * The value may be a number or, for some Facebook metrics, an object.
 */
export function insightValues(data: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const item of Array.isArray(data) ? data : []) {
        if (!item || typeof item.name !== 'string') continue;
        const value = item.values?.[0]?.value ?? item.total_value?.value;
        if (value !== undefined && value !== null) out[item.name] = value;
    }
    return out;
}

/** Instagram media insights, renamed to the contract's keys. */
export function mapIgInsights(data: unknown): PostMetrics {
    const v = insightValues(data);
    return compactMetrics<PostMetrics>({
        views: num(v.views),
        reach: num(v.reach),
        likes: num(v.likes),
        comments: num(v.comments),
        saved: num(v.saved),
        shares: num(v.shares),
        total_interactions: num(v.total_interactions),
        follows: num(v.follows),
        profile_visits: num(v.profile_visits),
        avg_watch_time_ms: num(v.ig_reels_avg_watch_time),
        video_view_total_time_ms: num(v.ig_reels_video_view_total_time),
    });
}

/** A Facebook attachment's type in Instagram's vocabulary, so one table holds both. */
export function fbMediaType(raw: any): string {
    const attachment = Array.isArray(raw?.attachments?.data) ? raw.attachments.data[0] : undefined;
    const type = typeof attachment?.media_type === 'string' ? attachment.media_type.toLowerCase() : '';
    if (type === 'album') return 'CAROUSEL_ALBUM';
    if (type === 'photo') return 'IMAGE';
    if (type.includes('video') || type === 'reel') return 'VIDEO';
    if (type === 'link' || type === 'share') return 'LINK';
    return 'TEXT';
}

/** A `/{page}/posts` item. Its numbers all come from insights; the list carries none. */
export function mapFbPost(raw: any): MappedPost | null {
    const postId = id(raw?.id);
    if (!postId) return null;
    const targets = (Array.isArray(raw.attachments?.data) ? raw.attachments.data : [])
        .map((a: any) => id(a?.target?.id))
        .filter((t: string | null): t is string => Boolean(t));
    return {
        media_id: postId,
        media_type: fbMediaType(raw),
        permalink: text(raw.permalink_url),
        caption: text(raw.message),
        thumbnail_url: text(raw.full_picture),
        published_at: iso(raw.created_time),
        metrics: {},
        // A photo or video post went out through /photos or /videos, which return the photo or
        // video id, and that is what `published_post_id` holds for it — not the post id.
        link_ids: [postId, ...targets],
        scheduled_post_id: null,
    };
}

/** Facebook post insights, renamed. `likes` is every reaction, summed: Facebook's counterpart of a like. */
export function mapFbInsights(data: unknown): PostMetrics {
    const v = insightValues(data);
    return compactMetrics<PostMetrics>({
        views: num(v.post_media_view),
        reach: num(v.post_total_media_view_unique),
        clicks: num(v.post_clicks),
        likes: sumValues(v.post_reactions_by_type_total),
        video_views: num(v.post_video_views),
        avg_watch_time_ms: num(v.post_video_avg_time_watched),
    });
}

// ─── Account days ────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` in UTC. */
export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export function addDays(day: string, n: number): string {
    return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
}

/** A UTC day's bounds as UNIX seconds, the form `since`/`until` take. */
export function dayBounds(day: string): { since: number; until: number } {
    const since = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
    return { since, until: since + 86_400 };
}

/**
 * The days to read account insights for, oldest first, ending yesterday (today is still
 * happening). A first sync backfills `BACKFILL_DAYS`; a later one re-reads the last
 * `REFRESH_DAYS` it already has, because Meta may revise them for 48 hours.
 */
export function daysToSync(lastInsightDay: string | null, today: string): string[] {
    const earliest = addDays(today, -BACKFILL_DAYS);
    const fromLast = lastInsightDay ? addDays(lastInsightDay, -(REFRESH_DAYS - 1)) : earliest;
    let day = fromLast > earliest ? fromLast : earliest;
    const yesterday = addDays(today, -1);
    const out: string[] = [];
    while (day <= yesterday) {
        out.push(day);
        day = addDays(day, 1);
    }
    return out;
}

/** Instagram's per-day totals, renamed. The names already match the contract's keys. */
export function mapIgDay(data: unknown): AccountDayMetrics {
    const v = insightValues(data);
    const out: Record<string, number | undefined> = {};
    for (const name of IG_DAY_METRICS) out[name] = num(v[name]);
    return compactMetrics(out) as AccountDayMetrics;
}

/** `total_value.breakdowns[0].results[]` as dimension value → value, for one metric. */
export function breakdownValues(data: unknown, metric: string): Record<string, number> {
    const item = (Array.isArray(data) ? data : []).find((d: any) => d?.name === metric);
    const results = item?.total_value?.breakdowns?.[0]?.results;
    const out: Record<string, number> = {};
    for (const r of Array.isArray(results) ? results : []) {
        const key = Array.isArray(r?.dimension_values) ? r.dimension_values[0] : undefined;
        const n = num(r?.value);
        if (typeof key === 'string' && n !== undefined) out[key] = (out[key] ?? 0) + n;
    }
    return out;
}

/** One `IG_DAY_SPLITS` answer, as the account-day keys it fills. */
export function mapIgSplit(key: (typeof IG_DAY_SPLITS)[number]['key'], data: unknown): AccountDayMetrics {
    if (key === 'ig_reach_surface') {
        const bySurface = breakdownValues(data, 'reach');
        return Object.keys(bySurface).length ? { reach_by_surface: bySurface } : {};
    }
    const metric = key === 'ig_reach_follow' ? 'reach' : 'views';
    const split = breakdownValues(data, metric);
    return compactMetrics<AccountDayMetrics>({
        [`${metric}_followers`]: split.FOLLOWER,
        [`${metric}_non_followers`]: split.NON_FOLLOWER,
    } as AccountDayMetrics);
}

/** `follows_and_unfollows` with `breakdown=follow_type`: FOLLOWER followed, NON_FOLLOWER unfollowed. */
export function followsBreakdown(data: unknown): Pick<AccountDayMetrics, 'follows' | 'unfollows'> {
    const split = breakdownValues(data, 'follows_and_unfollows');
    return compactMetrics({ follows: split.FOLLOWER, unfollows: split.NON_FOLLOWER });
}

/**
 * The day a time-series value belongs to. Meta stamps each value with the END of its day — for
 * Instagram and Facebook, midnight Pacific (`…T07:00:00+0000`) — so the day is the one that
 * ended then; stepping back 12 hours lands in it whichever midnight Meta used.
 */
export function dayOfEndTime(endTime: unknown): string | null {
    if (typeof endTime !== 'string') return null;
    const t = Date.parse(endTime);
    return Number.isFinite(t) ? utcDay(new Date(t - 12 * 3_600_000)) : null;
}

/** A `time_series` metric as day → value. */
export function seriesByDay(data: unknown, name: string): Map<string, number> {
    const out = new Map<string, number>();
    const item = (Array.isArray(data) ? data : []).find((d: any) => d?.name === name);
    for (const v of Array.isArray(item?.values) ? item.values : []) {
        const day = dayOfEndTime(v?.end_time);
        const n = num(v?.value);
        if (day && n !== undefined) out.set(day, n);
    }
    return out;
}

/**
 * Facebook's Page series → account days. Each metric's value lands on its own day, except
 * `page_follows`: a running total, so it is the follower count on that day as it stands, and
 * nothing downstream ever adds it up.
 */
export function mapFbPageDays(data: unknown): Map<string, AccountDayMetrics> {
    const days = new Map<string, AccountDayMetrics>();
    for (const [metric, key] of Object.entries(FB_PAGE_DAY_METRICS)) {
        for (const [day, value] of seriesByDay(data, metric)) {
            days.set(day, { ...(days.get(day) ?? {}), [key]: value });
        }
    }
    return days;
}
