/**
 * The video memory's library (docs/specs/005-muse-sees T053/T054, data-model.md `reel_analyses`): the table of what each of the owner's OWN published reels shows and
 * says, the listing of those reels from Instagram, and the queue that gets each one watched. What WATCHES a reel is `reelIndex.ts`; this is everything around it.
 *
 *   store            `reel_analyses`, one row per reel per tenant (`UNIQUE (creator_id, ig_media_id)`, migration v60). Every statement here names `creator_id`.
 *                    A success replaces the row's analysis; a failure never replaces a good one (`storeFailure`: a reel indexed yesterday and failing today keeps
 *                    yesterday's answer, which is what recall reads), and a failure is written as `status = 'failed'` with its reason in `result.error`.
 *   readers          `listLibrary` and `getLibraryRow` (the owner's library view and routes), `listOkForRecall` and `findByMediaId` (what recall and a shared reel's
 *                    lookup will read: a reel the agent was sent has `reel_video_id` or `ig_post_media_id` equal to the `ig_media_id` kept here).
 *   listing          `listPublishedReels`: the owner's `/{ig-user}/media`, paged, videos only (Reels and feed videos are `media_type: VIDEO`). No `media_url` is asked
 *                    for or kept: it is a short-lived link, read again for each reel when it is watched.
 *   queue            `queueReels` writes a `pending` row for every reel without an `ok` one and a `muse.reel_index` job for it (dedupe `reel:<id>:<yyyy-mm-dd>`: the job
 *                    key is permanent, so the day suffix lets a reel that failed be tried again tomorrow); `queueNewReelsForMemoryTenants` is the daily cron's call.
 *   youtube          `linkYouTubeSiblings`: a reel posted to YouTube in the same composer submission (`scheduled_posts.group_id`) gets its watch URL, so recall can
 *                    link it at a second (`&t=`).
 *
 * Nothing here calls a model, and nothing here keeps a media link or the media itself.
 */
import { queryCount, queryOne, queryRows } from '../../db/query.js';
import { getJobQueue } from '../../jobs/queue.js';
import { describeError, log } from '../../utils/log.js';
import { AiError } from '../llm/errors.js';
import { resolveRoute } from '../aiProviders/route.js';
import { graphFailure, GraphSession } from '../growth/graph.js';
import { isMetaUnavailable, isTokenDeathError } from '../http.js';
import { publishedPlatforms } from '../publishedIds.js';
import { getTenant } from '../tenant.js';
import { capabilityOn, readMuseSettings } from './switches.js';

// ─── The rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const REEL_STATUSES = ['pending', 'ok', 'failed'] as const;
export type ReelStatus = (typeof REEL_STATUSES)[number];

/** One `reel_analyses` row, as the code reads it: `usd` is a number (NUMERIC arrives as text) and the times are ISO strings. */
export interface LibraryRow {
    id: string;
    creator_id: string;
    ig_media_id: string | null;
    permalink: string | null;
    youtube_url: string | null;
    posted_at: string | null;
    status: ReelStatus;
    /** The analysis when `status` is `ok` (`ReelAnalysis`, reelIndex.ts), `{ error }` (and maybe `detail`) when it failed, `{}` while pending. */
    result: Record<string, unknown>;
    model: string | null;
    ms: number | null;
    usd: number | null;
    created_at: string;
    updated_at: string;
}

/** What the owner's list shows of a reel (`contracts/api.md`: `{ id, permalink, posted_at, status, summary, hook_score }`, plus what a screen needs beside them). */
export interface LibraryListItem {
    id: string;
    ig_media_id: string | null;
    permalink: string | null;
    youtube_url: string | null;
    posted_at: string | null;
    status: ReelStatus;
    summary: string | null;
    hook_score: number | null;
    /** Why a failed reel failed (`result.error`), or null. */
    error: string | null;
    model: string | null;
    usd: number | null;
    updated_at: string;
}

interface RawRow {
    id: string;
    creator_id: string;
    ig_media_id: string | null;
    permalink: string | null;
    youtube_url: string | null;
    posted_at: Date | string | null;
    status: string;
    result: unknown;
    model: string | null;
    ms: number | null;
    usd: string | number | null;
    created_at: Date | string;
    updated_at: Date | string;
}

const iso = (v: Date | string | null): string | null => {
    if (v === null || v === undefined) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const isStatus = (v: unknown): v is ReelStatus => typeof v === 'string' && (REEL_STATUSES as readonly string[]).includes(v);

function toRow(raw: RawRow): LibraryRow {
    return {
        id: raw.id,
        creator_id: raw.creator_id,
        ig_media_id: raw.ig_media_id,
        permalink: raw.permalink,
        youtube_url: raw.youtube_url,
        posted_at: iso(raw.posted_at),
        status: isStatus(raw.status) ? raw.status : 'failed',
        result: raw.result && typeof raw.result === 'object' && !Array.isArray(raw.result) ? (raw.result as Record<string, unknown>) : {},
        model: raw.model,
        ms: raw.ms === null || raw.ms === undefined ? null : Number(raw.ms),
        usd: num(raw.usd),
        created_at: iso(raw.created_at) ?? '',
        updated_at: iso(raw.updated_at) ?? '',
    };
}

const COLUMNS = 'id, creator_id, ig_media_id, permalink, youtube_url, posted_at, status, result, model, ms, usd, created_at, updated_at';

/** A row's id as the route takes it: a uuid. Anything else cannot match a row, and Postgres would raise on the literal. */
export const isRowId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** A Meta media id as it is put in a Graph path and a dedupe key: letters, digits, `_` and `-`. */
export const isMediaId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);

// ─── Readers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The owner's list, newest reel first: only the few fields a list needs, read out of the JSON in SQL so a library of hundreds is not sent whole. */
export async function listLibrary(creatorId: string): Promise<LibraryListItem[]> {
    const rows = await queryRows<{
        id: string; ig_media_id: string | null; permalink: string | null; youtube_url: string | null; posted_at: Date | string | null; status: string;
        summary: string | null; hook_score: string | null; error: string | null; model: string | null; usd: string | number | null; updated_at: Date | string;
    }>(
        `SELECT id, ig_media_id, permalink, youtube_url, posted_at, status,
                result->>'summary' AS summary, result->>'hook_score' AS hook_score, result->>'error' AS error,
                model, usd, updated_at
           FROM reel_analyses
          WHERE creator_id = $1
          ORDER BY posted_at DESC NULLS LAST, created_at DESC`,
        [creatorId]
    );
    return rows.map((r) => ({
        id: r.id,
        ig_media_id: r.ig_media_id,
        permalink: r.permalink,
        youtube_url: r.youtube_url,
        posted_at: iso(r.posted_at),
        status: isStatus(r.status) ? r.status : 'failed',
        summary: r.summary,
        hook_score: num(r.hook_score),
        error: r.error,
        model: r.model,
        usd: num(r.usd),
        updated_at: iso(r.updated_at) ?? '',
    }));
}

/** One of the tenant's rows, or null. Never another tenant's: the statement names both. */
export async function getLibraryRow(creatorId: string, id: string): Promise<LibraryRow | null> {
    if (!isRowId(id)) return null;
    const raw = await queryOne<RawRow>(`SELECT ${COLUMNS} FROM reel_analyses WHERE creator_id = $1 AND id = $2`, [creatorId, id]);
    return raw ? toRow(raw) : null;
}

/** The row for a reel the agent was sent (`reel_video_id` / `ig_post_media_id` = `ig_media_id`), or null when it has none. */
export async function findByMediaId(creatorId: string, igMediaId: string): Promise<LibraryRow | null> {
    if (!isMediaId(igMediaId)) return null;
    const raw = await queryOne<RawRow>(`SELECT ${COLUMNS} FROM reel_analyses WHERE creator_id = $1 AND ig_media_id = $2`, [creatorId, igMediaId]);
    return raw ? toRow(raw) : null;
}

/** Every reel that was watched and understood, newest first: the library recall reads whole. `failed` and `pending` rows are not in it. */
export async function listOkForRecall(creatorId: string): Promise<LibraryRow[]> {
    const rows = await queryRows<RawRow>(
        `SELECT ${COLUMNS} FROM reel_analyses
          WHERE creator_id = $1 AND status = 'ok'
          ORDER BY posted_at DESC NULLS LAST, created_at DESC`,
        [creatorId]
    );
    return rows.map(toRow);
}

// ─── Writers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PendingReel {
    igMediaId: string;
    permalink: string | null;
    postedAt: string | null;
}

/**
 * A `pending` row for each reel that has no `ok` one: a new row, or a `failed` one set back to pending so the library says it is queued again. A row that is `ok`
 * is left exactly as it is (its analysis stays valid while a fresh one is made). One statement for the whole list. Returns how many rows it wrote.
 */
export async function upsertPending(creatorId: string, reels: readonly PendingReel[]): Promise<number> {
    if (reels.length === 0) return 0;
    const rows = reels.map((r) => ({ ig_media_id: r.igMediaId, permalink: r.permalink, posted_at: r.postedAt }));
    return queryCount(
        `INSERT INTO reel_analyses (creator_id, ig_media_id, permalink, posted_at, status)
         SELECT $1::uuid, r.ig_media_id, r.permalink, r.posted_at, 'pending'
           FROM jsonb_to_recordset($2::jsonb) AS r(ig_media_id text, permalink text, posted_at timestamptz)
         ON CONFLICT (creator_id, ig_media_id) WHERE ig_media_id IS NOT NULL
         DO UPDATE SET status = 'pending',
                       permalink = COALESCE(EXCLUDED.permalink, reel_analyses.permalink),
                       posted_at = COALESCE(EXCLUDED.posted_at, reel_analyses.posted_at),
                       updated_at = NOW()
                 WHERE reel_analyses.status <> 'ok'`,
        [creatorId, JSON.stringify(rows)]
    );
}

export interface StoredAnalysis {
    permalink: string | null;
    postedAt: string | null;
    youtubeUrl: string | null;
    /** The `ReelAnalysis` (reelIndex.ts), already cleaned. */
    result: unknown;
    model: string;
    ms: number;
    usd: number;
}

/** A reel watched and understood: the row is `ok` with this analysis, whatever it held before. Returns the row's id. */
export async function storeAnalysis(creatorId: string, igMediaId: string, a: StoredAnalysis): Promise<string | null> {
    const row = await queryOne<{ id: string }>(
        `INSERT INTO reel_analyses (creator_id, ig_media_id, permalink, youtube_url, posted_at, status, result, model, ms, usd)
         VALUES ($1::uuid, $2, $3, $4, $5::timestamptz, 'ok', $6::jsonb, $7, $8, $9)
         ON CONFLICT (creator_id, ig_media_id) WHERE ig_media_id IS NOT NULL
         DO UPDATE SET permalink = COALESCE(EXCLUDED.permalink, reel_analyses.permalink),
                       youtube_url = COALESCE(EXCLUDED.youtube_url, reel_analyses.youtube_url),
                       posted_at = COALESCE(EXCLUDED.posted_at, reel_analyses.posted_at),
                       status = 'ok', result = EXCLUDED.result, model = EXCLUDED.model, ms = EXCLUDED.ms, usd = EXCLUDED.usd, updated_at = NOW()
         RETURNING id`,
        [creatorId, igMediaId, a.permalink, a.youtubeUrl, a.postedAt, JSON.stringify(a.result), a.model, Math.round(a.ms), a.usd]
    );
    return row?.id ?? null;
}

export interface StoredFailure {
    permalink: string | null;
    postedAt: string | null;
    /** `{ error, detail? }`: the reason code, and a short note of which providers failed how (never a message, a key or a link). */
    result: { error: string; detail?: string };
    model: string | null;
    ms: number | null;
    usd: number | null;
}

/**
 * A reel that could not be watched: the row is `failed` with the reason in `result.error`. **Never over a good analysis:** a row that is already `ok` is left as it is
 * (recall reads it, and a refresh that failed must not take it away), which the answer says (`kept_ok`).
 */
export async function storeFailure(creatorId: string, igMediaId: string, f: StoredFailure): Promise<'stored' | 'kept_ok'> {
    const row = await queryOne<{ id: string }>(
        `INSERT INTO reel_analyses (creator_id, ig_media_id, permalink, posted_at, status, result, model, ms, usd)
         VALUES ($1::uuid, $2, $3, $4::timestamptz, 'failed', $5::jsonb, $6, $7, $8)
         ON CONFLICT (creator_id, ig_media_id) WHERE ig_media_id IS NOT NULL
         DO UPDATE SET status = 'failed', result = EXCLUDED.result, model = EXCLUDED.model, ms = EXCLUDED.ms, usd = EXCLUDED.usd,
                       permalink = COALESCE(EXCLUDED.permalink, reel_analyses.permalink),
                       posted_at = COALESCE(EXCLUDED.posted_at, reel_analyses.posted_at),
                       updated_at = NOW()
                 WHERE reel_analyses.status <> 'ok'
         RETURNING id`,
        [creatorId, igMediaId, f.permalink, f.postedAt, JSON.stringify(f.result), f.model, f.ms === null ? null : Math.round(f.ms), f.usd]
    );
    return row ? 'stored' : 'kept_ok';
}

// ─── The YouTube sibling ─────────────────────────────────────────────────────────────────────────────────────────────────

/** `scheduled_posts.published_post_id` of a YouTube row: `YT:<video id>`. */
const YOUTUBE_ID = /^YT:([A-Za-z0-9_-]{6,20})$/;

/** The watch address of a YouTube video, which takes `&t=` in seconds (a Short's `/shorts/` address does not reliably). */
export const youtubeWatchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;

/**
 * Instagram media id → the watch URL of the YouTube copy of the same post, for a tenant. Posts made together share a `group_id` (`scheduled_posts`, v18): the Meta row
 * (`instagram` or `both`) holds `IG:<media id>` in `published_post_id` (`publishedPlatforms`), its YouTube sibling `YT:<video id>` once it is up. A group with several
 * YouTube rows is read newest first, so the latest upload wins. Only a PUBLISHED YouTube row counts.
 */
export async function youtubeLinksFor(creatorId: string): Promise<Map<string, string>> {
    const rows = await queryRows<{ group_id: string; platform: string; status: string; published_post_id: string | null }>(
        `SELECT group_id, platform, status, published_post_id
           FROM scheduled_posts
          WHERE creator_id = $1 AND group_id IS NOT NULL AND published_post_id IS NOT NULL AND published_post_id <> ''
            AND platform IN ('instagram', 'both', 'youtube')
          ORDER BY scheduled_time DESC`,
        [creatorId]
    );
    const youtubeOf = new Map<string, string>();
    const igOf = new Map<string, string[]>();
    for (const row of rows) {
        if (row.platform === 'youtube') {
            const id = row.status === 'PUBLISHED' ? YOUTUBE_ID.exec(row.published_post_id ?? '')?.[1] : undefined;
            if (id && !youtubeOf.has(row.group_id)) youtubeOf.set(row.group_id, id);
        } else {
            const { ig } = publishedPlatforms(row.published_post_id);
            if (ig) igOf.set(row.group_id, [...(igOf.get(row.group_id) ?? []), ig]);
        }
    }
    const out = new Map<string, string>();
    for (const [group, videoId] of youtubeOf) for (const igId of igOf.get(group) ?? []) if (!out.has(igId)) out.set(igId, youtubeWatchUrl(videoId));
    return out;
}

/**
 * Sets `youtube_url` on the tenant's rows that have a YouTube sibling and do not say so yet (or say another address): a cheap read and a few updates, and no model.
 * A row that already has the right one is not touched. Returns how many rows changed.
 */
export async function linkYouTubeSiblings(creatorId: string): Promise<number> {
    const links = await youtubeLinksFor(creatorId);
    let changed = 0;
    for (const [igMediaId, url] of links) {
        changed += await queryCount(
            `UPDATE reel_analyses SET youtube_url = $3, updated_at = NOW()
              WHERE creator_id = $1 AND ig_media_id = $2 AND youtube_url IS DISTINCT FROM $3`,
            [creatorId, igMediaId, url]
        );
    }
    return changed;
}

// ─── Listing the owner's reels ───────────────────────────────────────────────────────────────────────────────────────────

/** A published video of the owner's, as the listing gives it. No `media_url`: that is read fresh for each reel when it is watched. */
export interface PublishedReel {
    igMediaId: string;
    permalink: string | null;
    postedAt: string | null;
    /** `REELS` for a reel, `FEED` and the rest for a video posted to the grid. */
    productType: string | null;
}

/** Fields the list asks for. Not `media_url` (short-lived, never stored) and not the caption (not needed, and not sent anywhere). */
export const REEL_LIST_FIELDS = 'id,media_type,media_product_type,permalink,timestamp';
const PAGE_SIZE = 50;
/** Six pages: the 300 newest posts of any kind. The owner has about seventy reels; a longer history is cut, and the answer says so. */
export const MAX_LIST_PAGES = 6;

type GraphReader = Pick<GraphSession, 'get'>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The owner's published videos, newest first, from `/{ig-user}/media` through `GraphSession` (the token rides in a header, never in the query). Reels and videos only:
 * an image and a carousel have nothing to watch. Throws what the Graph call throws; `graphProblem` says what it was.
 */
export async function listPublishedReels(graph: GraphReader, igUserId: string): Promise<{ reels: PublishedReel[]; truncated: boolean }> {
    const reels: PublishedReel[] = [];
    let after: string | undefined;
    let more = false;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const body: any = await graph.get(`${igUserId}/media`, { fields: REEL_LIST_FIELDS, limit: PAGE_SIZE, ...(after ? { after } : {}) });
        for (const item of Array.isArray(body?.data) ? body.data : []) {
            if (item?.media_type !== 'VIDEO' || !isMediaId(item?.id)) continue;
            const stamp = typeof item.timestamp === 'string' ? new Date(item.timestamp) : null;
            reels.push({
                igMediaId: item.id,
                permalink: text(item.permalink),
                postedAt: stamp && !Number.isNaN(stamp.getTime()) ? stamp.toISOString() : null,
                productType: text(item.media_product_type),
            });
        }
        after = typeof body?.paging?.cursors?.after === 'string' ? body.paging.cursors.after : undefined;
        more = Boolean(body?.paging?.next && after);
        if (!more) break;
    }
    return { reels, truncated: more };
}

/** What a failed Graph call means for the owner's reels: the reason code, and whether asking again later may help. */
export type GraphProblem = { reason: 'graph_auth' | 'graph_unavailable' | 'not_found' | 'graph_failed'; retryable: boolean };

/** A Graph failure as a reason code. A dead credential and a missing media are final; Meta being unreachable or throttling is not. Never carries the message, which may name a link. */
export function graphProblem(err: unknown): GraphProblem {
    if (isTokenDeathError(err as any)) return { reason: 'graph_auth', retryable: false };
    if (isMetaUnavailable(err as any)) return { reason: 'graph_unavailable', retryable: true };
    const f = graphFailure(err);
    // 100 is "unsupported get request" or "object does not exist", 21 a media that was removed; a plain 404 is the same thing said by HTTP.
    if (f.status === 404 || f.code === 100 || f.code === 21) return { reason: 'not_found', retryable: false };
    return { reason: 'graph_failed', retryable: false };
}

// ─── The queue ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The UTC day, `YYYY-MM-DD`: what a dedupe key ends in. */
const dayOf = (now: Date): string => now.toISOString().slice(0, 10);

/** The dedupe key of the daily job for a reel: one a day, so a failed reel is tried again tomorrow and never twice in a day. */
export const reelJobKey = (igMediaId: string, now: Date): string => `reel:${igMediaId}:${dayOf(now)}`;

/**
 * The dedupe key of a re-index the owner asked for. The daily key is taken the moment the reel was queued or watched today, so it could not be used: a press after
 * an analysis that looked wrong would do nothing. This one is per minute, which still turns a double click into one job.
 */
export const reelRedoKey = (igMediaId: string, now: Date): string => `reel:${igMediaId}:${dayOf(now)}:redo:${now.toISOString().slice(11, 16).replace(':', '')}`;

/** Jobs of a reel are tried up to this many times by the runner (a failure that may pass: Meta or the model unavailable). */
export const REEL_JOB_ATTEMPTS = 3;

/** Whether a route can answer the reel indexer (`reel_index`, the providers layer). Only "no provider" is a no: any other failure is thrown. */
export async function reelRouteReady(creatorId: string): Promise<boolean> {
    try {
        await resolveRoute('reel_index', creatorId);
        return true;
    } catch (err) {
        if (err instanceof AiError && err.kind === 'no_provider') return false;
        throw err;
    }
}

export type QueueResult =
    | { ok: true; listed: number; queued: number; kept: number; deduped: number; truncated: boolean }
    | { ok: false; reason: 'not_connected' | GraphProblem['reason'] };

export interface QueueOptions {
    now?: () => Date;
    /** For a test, or a caller that has the Graph already. */
    graph?: GraphReader;
}

/**
 * Gets every published reel without an `ok` row watched: lists the owner's videos, writes a `pending` row for each, and queues one `muse.reel_index` job per reel
 * (a reel already `ok` is `kept`; one whose job for today exists is `deduped`). What runs the jobs is the drain, one reel each.
 *
 * Does not look at the `memory` switch or the route: the caller does (the route answers 409 for them, the daily run skips the tenant). A Graph failure is a result,
 * never a throw, so a caller can say it; a database failure is thrown.
 */
export async function queueReels(creatorId: string, opts: QueueOptions = {}): Promise<QueueResult> {
    const now = (opts.now ?? (() => new Date()))();
    const tenant = await getTenant(creatorId, ['id', 'instagram_page_id', 'page_access_token']);
    if (!tenant?.page_access_token || !tenant.instagram_page_id) return { ok: false, reason: 'not_connected' };

    let listed: { reels: PublishedReel[]; truncated: boolean };
    try {
        listed = await listPublishedReels(opts.graph ?? new GraphSession(tenant.page_access_token), tenant.instagram_page_id);
    } catch (err) {
        const problem = graphProblem(err);
        log('warn', 'muse.reel_list_failed', { creator_id: creatorId, reason: problem.reason, ...describeError(err) });
        return { ok: false, reason: problem.reason };
    }

    const existing = new Map((await queryRows<{ ig_media_id: string; status: string }>(
        `SELECT ig_media_id, status FROM reel_analyses WHERE creator_id = $1 AND ig_media_id IS NOT NULL`, [creatorId]
    )).map((r) => [r.ig_media_id, r.status]));
    const todo = listed.reels.filter((r) => existing.get(r.igMediaId) !== 'ok');
    const kept = listed.reels.length - todo.length;

    await upsertPending(creatorId, todo);
    let queued = 0;
    let deduped = 0;
    for (const reel of todo) {
        const id = await getJobQueue().enqueue({
            kind: 'muse.reel_index', payload: { creatorId, igMediaId: reel.igMediaId }, dedupeKey: reelJobKey(reel.igMediaId, now), creatorId, maxAttempts: REEL_JOB_ATTEMPTS,
        });
        if (id) queued++;
        else deduped++;
    }
    // A reel posted to YouTube too gets its link now, with no model call: the sibling may have been published after the reel was watched.
    await linkYouTubeSiblings(creatorId).catch((err) => log('warn', 'muse.reel_youtube_link_failed', { creator_id: creatorId, ...describeError(err) }));
    log('info', 'muse.reel_queue', { creator_id: creatorId, listed: listed.reels.length, queued, kept, deduped, truncated: listed.truncated });
    return { ok: true, listed: listed.reels.length, queued, kept, deduped, truncated: listed.truncated };
}

/** Queues one reel for a fresh analysis, `ok` or not: the owner's "re-index" button. False when the same press was already queued this minute. */
export async function queueOneReel(creatorId: string, igMediaId: string, opts: { now?: () => Date } = {}): Promise<boolean> {
    const now = (opts.now ?? (() => new Date()))();
    const id = await getJobQueue().enqueue({
        kind: 'muse.reel_index', payload: { creatorId, igMediaId }, dedupeKey: reelRedoKey(igMediaId, now), creatorId, maxAttempts: REEL_JOB_ATTEMPTS,
    });
    return id !== null;
}

export interface CronQueueResult {
    /** Active tenants with a Meta connection that were looked at. */
    tenants: number;
    /** Of them, the ones with the `memory` switch on. */
    memoryOn: number;
    queued: number;
    kept: number;
    /** A tenant skipped for a reason it could do nothing about today: no route that can answer, or Meta did not answer. */
    skipped: number;
    failed: number;
}

/**
 * The daily cron's call (`/api/cron/publish`): for every active tenant with Meta connected AND the `memory` switch on, queue the reels that have no `ok` row (the ones
 * published since the last run, and any that failed or were never reached). A tenant with the switch off costs one settings read and nothing else. One tenant's failure
 * is logged and the next is tried; the whole call stops for time at `budgetMs`. Never throws for a tenant; throws only when the tenants cannot be listed.
 */
export async function queueNewReelsForMemoryTenants(opts: { budgetMs?: number; now?: () => Date } = {}): Promise<CronQueueResult> {
    const started = Date.now();
    const budget = opts.budgetMs ?? 60_000;
    const out: CronQueueResult = { tenants: 0, memoryOn: 0, queued: 0, kept: 0, skipped: 0, failed: 0 };
    const tenants = await queryRows<{ id: string }>(`SELECT id FROM creators WHERE is_active = TRUE AND page_access_token IS NOT NULL ORDER BY created_at`);
    out.tenants = tenants.length;
    for (const tenant of tenants) {
        if (Date.now() - started > budget) {
            log('warn', 'muse.reel_queue_budget_spent', { budget_ms: budget });
            break;
        }
        try {
            if (!capabilityOn(await readMuseSettings(tenant.id), 'memory')) continue;
            out.memoryOn++;
            if (!(await reelRouteReady(tenant.id))) {
                out.skipped++;
                log('warn', 'muse.reel_queue_skipped', { creator_id: tenant.id, reason: 'no_key' });
                continue;
            }
            const result = await queueReels(tenant.id, opts.now ? { now: opts.now } : {});
            if (result.ok) {
                out.queued += result.queued;
                out.kept += result.kept;
            } else {
                out.skipped++;
            }
        } catch (err) {
            out.failed++;
            log('warn', 'muse.reel_queue_tenant_failed', { creator_id: tenant.id, ...describeError(err) });
        }
    }
    return out;
}
