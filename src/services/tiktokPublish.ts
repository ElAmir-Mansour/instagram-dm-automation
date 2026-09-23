/**
 * The TikTok publish lifecycle for a `scheduled_posts` row.
 *
 *   PENDING ─claim→ PUBLISHING ─init+upload→ PROCESSING ─TikTok→ IN_INBOX ─creator posts→ PUBLISHED
 *                                                          └────→ FAILED
 *
 * IN_INBOX is inbox mode's "waiting for you": the video is in the creator's TikTok inbox and
 * they finish the post in the TikTok app. TikTok reports PUBLISH_COMPLETE once they do.
 *
 * Unlike Meta, TikTok answers "published?" asynchronously: the upload returns a `publish_id`
 * and processing takes seconds to minutes. Three things move a PROCESSING row forward, in
 * order of how quickly they usually arrive:
 *
 *   1. a short inline poll right after the upload, which catches the common small-reel case;
 *   2. TikTok's `post.publish.*` webhook (`applyWebhookEvent`);
 *   3. `reconcileTikTokPosts`, run by every drain and by the daily cron — the backstop when
 *      the webhook is not configured or a delivery was missed.
 *
 * All three go through `applyStatus`, whose transitions are idempotent, so they can overlap.
 */
import { queryCount, queryRows } from '../db/query.js';
import type { ScheduledPostRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { getMediaStore } from './storage.js';
import {
    describeFailReason, fetchPublishStatus, initInboxVideoUpload, mapPublishState, planChunks,
    tiktokHttp, uploadChunks, type TikTokPublishStatus, type TikTokWebhookEvent,
} from './tiktok.js';
import {
    connectionByOpenId, deleteConnectionByOpenId, getAccessToken, noteTikTokFailure,
} from './tiktokConnections.js';

/** Video types TikTok accepts. */
export const TIKTOK_VIDEO_MIME_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

/** How long the publish call waits for TikTok before leaving the rest to the webhook/sweep. */
const INLINE_POLL_BUDGET_MS = 12_000;
const INLINE_POLL_INTERVAL_MS = 3_000;
/** A PROCESSING row TikTok has said nothing about for this long is given up on. */
const PROCESSING_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** External media larger than this is refused before it is downloaded into memory. */
const MAX_EXTERNAL_MEDIA_BYTES = 256 * 1024 * 1024;

export type TikTokPublishTarget = Pick<
    ScheduledPostRow,
    'id' | 'creator_id' | 'post_type' | 'caption' | 'media_url' | 'external_publish_id'
>;

/**
 * TikTok: "There may be at most 5 pending shares within any 24-hour period." Whether posting or
 * deleting a draft frees a slot is undocumented, so the count here is conservative — every
 * upload in the last 24h that the creator has not visibly posted yet.
 */
export const MAX_PENDING_INBOX_SHARES = 5;

/** Raised when publishing now would exceed TikTok's pending-share limit; the row is held, not failed. */
export class TikTokInboxFullError extends Error {
    constructor(pending: number) {
        super(`Waiting for TikTok: ${pending} drafts from the last 24 hours are still in your TikTok inbox (TikTok allows ${MAX_PENDING_INBOX_SHARES}). Post them in the TikTok app and this goes out on the next run.`);
        this.name = 'TikTokInboxFullError';
    }
}

/** How many uploads this tenant has waiting in the TikTok inbox from the last 24 hours. */
export async function pendingInboxShares(creatorId: string, excludePostId?: string): Promise<number> {
    const rows = await queryRows<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM scheduled_posts
          WHERE creator_id = $1 AND platform = 'tiktok'
            AND status IN ('PROCESSING', 'IN_INBOX')
            AND claimed_at > NOW() - INTERVAL '24 hours'
            AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [creatorId, excludePostId ?? null]
    );
    return rows[0]?.n ?? 0;
}

/** The `<uuid>` of one of our own `/api/uploads/<uuid>` URLs, or null. */
export function uploadIdFromUrl(url: string): string | null {
    const match = /\/api\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(url);
    return match ? match[1]!.toLowerCase() : null;
}

/**
 * The bytes to upload. Our own uploads are read straight from the media store — no HTTP round
 * trip through a route whose response Vercel caps at 4.5MB. Anything else is downloaded.
 */
async function loadMedia(mediaUrl: string): Promise<{ data: Buffer; mimeType: string }> {
    const uploadId = uploadIdFromUrl(mediaUrl);
    if (uploadId) {
        const stored = await getMediaStore().get(uploadId);
        if (!stored) throw new Error('The uploaded video no longer exists — upload it again.');
        return { data: stored.data, mimeType: stored.mimeType };
    }
    const res = await tiktokHttp.get(mediaUrl, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: MAX_EXTERNAL_MEDIA_BYTES,
    });
    const mimeType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    return { data: Buffer.from(res.data), mimeType };
}

/**
 * Write what TikTok reported onto the row, if it moves the row forward.
 *
 * Each target status names the states it may be reached from, which is what makes this safe to
 * call from the inline poll, the webhook and the sweep at once: a late `PROCESSING` cannot drag
 * an `IN_INBOX` row backwards, and a success can overwrite a FAILED that our side recorded
 * after, say, a timeout on a response TikTok had in fact accepted.
 */
export async function applyStatus(
    postId: string,
    reported: Pick<TikTokPublishStatus, 'status' | 'failReason' | 'postIds'>
): Promise<ScheduledPostRow['status'] | null> {
    const next = mapPublishState(reported.status);
    if (!next) return null;

    if (next === 'PROCESSING') {
        await queryCount(
            `UPDATE scheduled_posts SET status = 'PROCESSING', status_checked_at = NOW()
              WHERE id = $1 AND status IN ('PUBLISHING', 'PROCESSING')`,
            [postId]
        );
        return 'PROCESSING';
    }
    if (next === 'IN_INBOX') {
        await queryCount(
            `UPDATE scheduled_posts SET status = 'IN_INBOX', error_log = NULL, status_checked_at = NOW()
              WHERE id = $1 AND status IN ('PUBLISHING', 'PROCESSING', 'FAILED')`,
            [postId]
        );
        return 'IN_INBOX';
    }
    if (next === 'PUBLISHED') {
        const id = reported.postIds[0];
        await queryCount(
            `UPDATE scheduled_posts
                SET status = 'PUBLISHED', error_log = NULL, status_checked_at = NOW(),
                    published_post_id = COALESCE($2, published_post_id)
              WHERE id = $1 AND status IN ('PUBLISHING', 'PROCESSING', 'IN_INBOX', 'FAILED')`,
            [postId, id ? `TT:${id}` : null]
        );
        return 'PUBLISHED';
    }
    await queryCount(
        `UPDATE scheduled_posts SET status = 'FAILED', error_log = $2, status_checked_at = NOW()
          WHERE id = $1 AND status IN ('PUBLISHING', 'PROCESSING')`,
        [postId, describeFailReason(reported.failReason)]
    );
    return 'FAILED';
}

async function markFailed(postId: string, message: string): Promise<void> {
    await queryCount(
        `UPDATE scheduled_posts SET status = 'FAILED', error_log = $2 WHERE id = $1`,
        [postId, message.slice(0, 2000)]
    );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TikTok processed the upload and refused it. The row already carries TikTok's reason. */
export class TikTokRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TikTokRejectedError';
    }
}

/**
 * Publish one claimed TikTok row (status PUBLISHING). Returns the status the row ended in; on
 * failure it writes FAILED and rethrows, matching `attemptPublish` for the Meta rows.
 */
export async function publishTikTokPost(post: TikTokPublishTarget): Promise<ScheduledPostRow['status']> {
    let connectionId: string | null = null;
    try {
        if (!post.creator_id) throw new Error('This post has no account.');
        if (post.post_type !== 'video') {
            throw new Error('TikTok posts must be videos — photo posts are not supported yet.');
        }
        if (!post.media_url) throw new Error('TikTok needs a video to upload.');

        const pending = await pendingInboxShares(post.creator_id, post.id);
        if (pending >= MAX_PENDING_INBOX_SHARES && !post.external_publish_id) {
            throw new TikTokInboxFullError(pending);
        }

        const { accessToken, connection } = await getAccessToken(post.creator_id);
        connectionId = connection.id;

        const media = await loadMedia(post.media_url);
        if (!TIKTOK_VIDEO_MIME_TYPES.has(media.mimeType)) {
            throw new Error(`TikTok accepts MP4, MOV or WebM video — this file is ${media.mimeType || 'of unknown type'}.`);
        }
        const plan = planChunks(media.data.length);

        // A retry of a row that already reached TikTok. Ask before uploading again: an upload
        // that finished before the invocation died is already in the creator's inbox, and a
        // second one would be a duplicate draft counted against TikTok's five-a-day limit.
        if (post.external_publish_id) {
            try {
                const previous = await fetchPublishStatus(accessToken, post.external_publish_id);
                const uploadFinished = previous.status !== 'PROCESSING_UPLOAD'
                    || (previous.uploadedBytes ?? 0) >= plan.videoSize;
                if (previous.status !== 'FAILED' && uploadFinished) {
                    const landed = await applyStatus(post.id, previous);
                    log('info', 'tiktok.publish_resumed', { post_id: post.id, status: landed });
                    if (landed) return landed;
                }
            } catch (err) {
                log('warn', 'tiktok.publish_resume_check_failed', { post_id: post.id, ...describeError(err) });
            }
        }

        const init = await initInboxVideoUpload(accessToken, plan, post.caption);
        // Written before a single byte goes up, so a crash from here on is resumable rather
        // than a second upload.
        await queryCount(
            `UPDATE scheduled_posts SET external_publish_id = $2 WHERE id = $1`,
            [post.id, init.publishId]
        );
        log('info', 'tiktok.upload_started', {
            post_id: post.id, publish_id: init.publishId, bytes: plan.videoSize,
            chunks: plan.totalChunkCount, caption_sent: init.captionSent,
        });

        await uploadChunks(init.uploadUrl, media.data, media.mimeType, plan);
        await queryCount(
            `UPDATE scheduled_posts SET status = 'PROCESSING', error_log = NULL, status_checked_at = NOW()
              WHERE id = $1 AND status = 'PUBLISHING'`,
            [post.id]
        );
        log('info', 'tiktok.upload_done', { post_id: post.id, publish_id: init.publishId });

        // Most small reels are in the inbox within seconds; waiting a little here means the
        // person who pressed "Publish now" sees the real outcome instead of "processing".
        const deadline = Date.now() + INLINE_POLL_BUDGET_MS;
        while (Date.now() < deadline) {
            await sleep(INLINE_POLL_INTERVAL_MS);
            let reported: TikTokPublishStatus;
            try {
                reported = await fetchPublishStatus(accessToken, init.publishId);
            } catch (err) {
                // Not a failure of the post — the upload is done. The webhook or the sweep
                // will learn the outcome.
                log('warn', 'tiktok.inline_poll_failed', { post_id: post.id, ...describeError(err) });
                break;
            }
            const landed = await applyStatus(post.id, reported);
            if (landed && landed !== 'PROCESSING') {
                log('info', 'tiktok.publish_settled', { post_id: post.id, status: landed });
                // applyStatus has already written TikTok's reason onto the row.
                if (landed === 'FAILED') throw new TikTokRejectedError(describeFailReason(reported.failReason));
                return landed;
            }
        }
        return 'PROCESSING';
    } catch (err: any) {
        if (err instanceof TikTokInboxFullError) {
            // Held, not failed: put the claim back so the next sweep tries again once a draft
            // has been posted. The note says why it has not gone out.
            await queryCount(
                `UPDATE scheduled_posts SET status = 'PENDING', error_log = $2
                  WHERE id = $1 AND status = 'PUBLISHING'`,
                [post.id, err.message]
            );
            throw err;
        }
        await noteTikTokFailure(connectionId, err);
        // A FAILED written by applyStatus already carries TikTok's own reason; only write when
        // the row is still ours to describe.
        await queryCount(
            `UPDATE scheduled_posts SET status = 'FAILED', error_log = $2
              WHERE id = $1 AND status IN ('PUBLISHING', 'PROCESSING', 'PENDING')`,
            [post.id, String(err?.message ?? err).slice(0, 2000)]
        );
        throw err;
    }
}

/**
 * Ask TikTok about rows it has not finished with — uploads still processing, and inbox drafts
 * the creator may since have posted. Run by every drain and the daily cron. Bounded (TikTok
 * allows 30 status calls a minute per token) and cannot throw.
 */
export async function reconcileTikTokPosts(limit = 10): Promise<{ checked: number; settled: number; gaveUp: number }> {
    const result = { checked: 0, settled: 0, gaveUp: 0 };
    let rows: Pick<ScheduledPostRow, 'id' | 'creator_id' | 'external_publish_id' | 'claimed_at' | 'status'>[];
    try {
        // PROCESSING rows are asked about every 30s. IN_INBOX rows are waiting on a person, so
        // every 10 minutes is plenty — and only for a week, after which a draft that was never
        // posted is simply left as IN_INBOX rather than polled forever.
        rows = await queryRows(
            `SELECT id, creator_id, external_publish_id, claimed_at, status
               FROM scheduled_posts
              WHERE platform = 'tiktok'
                AND (
                      (status = 'PROCESSING'
                       AND (status_checked_at IS NULL OR status_checked_at < NOW() - INTERVAL '30 seconds'))
                   OR (status = 'IN_INBOX'
                       AND claimed_at > NOW() - INTERVAL '7 days'
                       AND (status_checked_at IS NULL OR status_checked_at < NOW() - INTERVAL '10 minutes'))
                )
              ORDER BY status_checked_at NULLS FIRST
              LIMIT $1`,
            [limit]
        );
    } catch (err) {
        log('error', 'tiktok.reconcile_query_failed', describeError(err));
        return result;
    }

    for (const row of rows) {
        try {
            const claimedAt = row.claimed_at ? new Date(row.claimed_at).getTime() : 0;
            if (!row.external_publish_id || !row.creator_id) {
                await markFailed(row.id, 'TikTok upload has no publish id — schedule it again.');
                result.gaveUp++;
                continue;
            }
            if (row.status === 'PROCESSING' && claimedAt && Date.now() - claimedAt > PROCESSING_GIVE_UP_MS) {
                await markFailed(row.id, 'TikTok did not confirm this upload within 24 hours. Check your TikTok inbox; if it is not there, retry.');
                result.gaveUp++;
                continue;
            }
            const { accessToken } = await getAccessToken(row.creator_id);
            const reported = await fetchPublishStatus(accessToken, row.external_publish_id);
            result.checked++;
            const landed = await applyStatus(row.id, reported);
            if (landed && landed !== row.status) result.settled++;
            // An IN_INBOX row TikTok still reports as in the inbox: stamp it so it waits its
            // ten minutes. applyStatus only stamps rows it moves.
            if (landed === 'IN_INBOX' && row.status === 'IN_INBOX') {
                await queryCount(`UPDATE scheduled_posts SET status_checked_at = NOW() WHERE id = $1`, [row.id]);
            }
        } catch (err) {
            // Stamp it anyway so one broken row cannot monopolise every sweep.
            await queryCount(`UPDATE scheduled_posts SET status_checked_at = NOW() WHERE id = $1`, [row.id])
                .catch(() => undefined);
            log('warn', 'tiktok.reconcile_row_failed', { post_id: row.id, ...describeError(err) });
        }
    }
    if (rows.length > 0) log('info', 'tiktok.reconciled', { ...result });
    return result;
}

/** Webhook event names → the TikTok status they imply. */
const EVENT_STATES: Record<string, string> = {
    'post.publish.inbox_delivered': 'SEND_TO_USER_INBOX',
    'post.publish.complete': 'PUBLISH_COMPLETE',
    'post.publish.publicly_available': 'PUBLISH_COMPLETE',
    'post.publish.failed': 'FAILED',
};

/**
 * Apply one verified webhook event. Returns what it did, for the log line. Unknown events are
 * acknowledged and ignored — TikTok retries anything that is not a 200 for 72 hours.
 */
export async function applyWebhookEvent(event: TikTokWebhookEvent): Promise<string> {
    if (event.event === 'authorization.removed') {
        if (!event.openId) return 'ignored:no_open_id';
        const removed = await deleteConnectionByOpenId(event.openId);
        return removed > 0 ? 'connection_deleted' : 'ignored:unknown_account';
    }

    const state = EVENT_STATES[event.event];
    if (!state) return `ignored:${event.event}`;

    const publishId = typeof event.content.publish_id === 'string' ? event.content.publish_id : null;
    if (!publishId) return 'ignored:no_publish_id';

    // Confirm the event is about an account and a post we know, and that they belong together.
    const connection = event.openId ? await connectionByOpenId(event.openId) : null;
    const posts = await queryRows<Pick<ScheduledPostRow, 'id' | 'creator_id'>>(
        `SELECT id, creator_id FROM scheduled_posts WHERE external_publish_id = $1`,
        [publishId]
    );
    const post = posts[0];
    if (!post) return 'ignored:unknown_publish_id';
    if (connection && connection.creator_id !== post.creator_id) return 'ignored:account_mismatch';

    const postId = typeof event.content.post_id === 'string' || typeof event.content.post_id === 'number'
        ? String(event.content.post_id) : null;
    const landed = await applyStatus(post.id, {
        status: state,
        failReason: typeof event.content.reason === 'string' ? event.content.reason : null,
        postIds: postId ? [postId] : [],
    });
    return `post_${String(landed ?? 'unchanged').toLowerCase()}`;
}

// Exported for tests.
export const _internals = { loadMedia };
