/**
 * The automatic first comment on a published post (migration v61, research USE-2).
 *
 * A Meta row (`instagram`, `facebook`, `both`) can carry `first_comment`: the sources of an explainer, a link, the keyword prompt. Once the row has REALLY gone
 * live (`attemptPublish`'s PUBLISHED write, never while Instagram is still processing a reel and the row is held), `queueFirstComments` queues one
 * `post.first_comment` job per platform that has an id, and `runFirstCommentJob` posts it with the Page token the publisher used.
 *
 * Rules that make it safe:
 *   - It NEVER touches `scheduled_posts.status`. The post is already public; a comment that fails is a note on the card (`first_comment_status`) with a Retry.
 *   - It never posts twice. The dedupe key is post + platform (+ the retry number); the call goes through `withRetry({ creates: true })`, so a timeout that
 *     may have landed is not repeated; the job marks itself `sending` BEFORE the call, so a run that died after the call and is re-run by the queue's reaper
 *     does not post again: it finds `sending`, and says so on the card instead.
 *   - It never throws for what Meta answered. A failed comment is written as `failed` and the job ends; only a database error throws (and is retried: the
 *     claim is a state change, so the retry finds `sending` and fails closed, as above).
 *   - TikTok and YouTube rows carry none (the routes refuse it).
 */
import { decryptSecret } from '../config/crypto.js';
import { queryOne, queryRows } from '../db/query.js';
import type { FirstCommentEntry, FirstCommentStatus } from '../db/rows.js';
import { getJobQueue } from '../jobs/queue.js';
import type { FirstCommentPayload } from '../jobs/types.js';
import { log } from '../utils/log.js';
import { publishFirstComment } from './instagram.js';
import { publishedPlatforms } from './publishedIds.js';

/** Instagram's limit for a comment; Facebook's is far higher. */
export const FIRST_COMMENT_MAX = 2200;

export type CommentPlatform = 'instagram' | 'facebook';
export const COMMENT_PLATFORMS: readonly CommentPlatform[] = ['instagram', 'facebook'];

export function firstCommentDedupeKey(postId: string, platform: CommentPlatform, attempt: number): string {
    return attempt > 0 ? `fc:${postId}:${platform}:${attempt}` : `fc:${postId}:${platform}`;
}

export type FirstCommentCheck = { ok: true; provided: boolean; value: string | null } | { ok: false; error: string };

/**
 * A request's `first_comment`: absent means "not sent" (`provided: false`), null or blank means clear it, a string is trimmed and held to 2,200 characters.
 * Refused for a row that is not Instagram or Facebook (`platform` is the EFFECTIVE platform).
 */
export function validateFirstComment(raw: unknown, platform: unknown): FirstCommentCheck {
    if (raw === undefined) return { ok: true, provided: false, value: null };
    if (raw !== null && typeof raw !== 'string') return { ok: false, error: 'first_comment must be text.' };
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) return { ok: true, provided: true, value: null };
    if (platform !== 'instagram' && platform !== 'facebook' && platform !== 'both') {
        return { ok: false, error: 'A first comment can only go under an Instagram or Facebook post.' };
    }
    if (value.length > FIRST_COMMENT_MAX) {
        return { ok: false, error: `first_comment is ${value.length} characters; the limit is ${FIRST_COMMENT_MAX}.` };
    }
    return { ok: true, provided: true, value };
}

/** Which platforms a row of this platform comments on, given the ids it published. */
export function commentTargets(platform: unknown, ids: { fb: string | null; ig: string | null }): CommentPlatform[] {
    const out: CommentPlatform[] = [];
    if ((platform === 'instagram' || platform === 'both') && ids.ig) out.push('instagram');
    if ((platform === 'facebook' || platform === 'both') && ids.fb) out.push('facebook');
    return out;
}

function entry(status: FirstCommentEntry['status'], attempt: number, extra: { id?: string; error?: string } = {}): FirstCommentEntry {
    return { status, at: new Date().toISOString(), attempt, ...extra };
}

/** Write one platform's entry. With `onlyFrom`, only when the entry is in that state now (an atomic compare-and-set); returns whether it wrote. */
async function writeEntry(
    postId: string, platform: CommentPlatform, next: FirstCommentEntry, onlyFrom?: FirstCommentEntry['status'] | 'absent',
): Promise<boolean> {
    const guard = onlyFrom === undefined ? ''
        : onlyFrom === 'absent' ? ' AND (first_comment_status IS NULL OR first_comment_status -> $2::text IS NULL)'
            : ` AND first_comment_status -> $2::text ->> 'status' = '${onlyFrom}'`;
    const rows = await queryRows<{ id: string }>(
        `UPDATE scheduled_posts
            SET first_comment_status = jsonb_set(COALESCE(first_comment_status, '{}'::jsonb), ARRAY[$2::text], $3::jsonb)
          WHERE id = $1${guard}
      RETURNING id`,
        [postId, platform, JSON.stringify(next)]
    );
    return rows.length > 0;
}

/**
 * After `attemptPublish` wrote PUBLISHED: queue the comment for each platform that is live. Never throws: the post is public and must stay PUBLISHED
 * whatever happens here. A platform that already has an entry (an earlier attempt, a republish) is left alone: Retry is the way to run it again.
 */
export async function queueFirstComments(
    post: { id: string; creator_id: string | null; platform: unknown; first_comment?: string | null },
    ids: { fbId: string | null; igId: string | null },
): Promise<void> {
    try {
        if (!post.first_comment?.trim() || !post.creator_id) return;
        for (const platform of commentTargets(post.platform, { fb: ids.fbId, ig: ids.igId })) {
            if (!(await writeEntry(post.id, platform, entry('pending', 0), 'absent'))) continue;
            try {
                await getJobQueue().enqueue({
                    kind: 'post.first_comment',
                    payload: { postId: post.id, creatorId: post.creator_id, platform, attempt: 0 },
                    dedupeKey: firstCommentDedupeKey(post.id, platform, 0),
                    creatorId: post.creator_id,
                });
            } catch (err) {
                await writeEntry(post.id, platform, entry('failed', 0, { error: 'The comment could not be queued. Press Retry.' })).catch(() => undefined);
                throw err;
            }
        }
    } catch (err: any) {
        log('error', 'first_comment.queue_failed', { post_id: post.id, error_message: String(err?.message ?? err).slice(0, 200) });
    }
}

/** What the card shows for a Meta Error: short, without Meta's code boilerplate. */
function reasonOf(err: any): string {
    const message = String(err?.message ?? err ?? 'Unknown error').replace(/\s+/g, ' ').trim();
    return message.slice(0, 300) || 'Unknown error';
}

/**
 * The `post.first_comment` job. See the file's header for what it guarantees. Returns normally for every outcome Meta can cause.
 */
export async function runFirstCommentJob(payload: FirstCommentPayload): Promise<void> {
    const { postId, creatorId, platform, attempt } = payload;
    const logBase = { post_id: postId, platform, attempt };

    // The claim: pending -> sending, only on a row that is really PUBLISHED. Whoever finds anything else must not call Meta.
    const claimed = await queryOne<{ first_comment: string | null; published_post_id: string | null }>(
        `UPDATE scheduled_posts
            SET first_comment_status = jsonb_set(first_comment_status, ARRAY[$2::text], $4::jsonb)
          WHERE id = $1 AND creator_id = $3 AND status = 'PUBLISHED'
            AND first_comment_status -> $2::text ->> 'status' = 'pending'
      RETURNING first_comment, published_post_id`,
        [postId, platform, creatorId, JSON.stringify(entry('sending', attempt))]
    );

    if (!claimed) {
        const row = await queryOne<{ status: string; first_comment_status: FirstCommentStatus | null }>(
            'SELECT status, first_comment_status FROM scheduled_posts WHERE id = $1 AND creator_id = $2', [postId, creatorId]
        );
        const current = row?.first_comment_status?.[platform];
        if (row && current?.status === 'sending') {
            // An earlier run of this job called Meta (or was about to) and never wrote the result. It may have posted: do not post again.
            await writeEntry(postId, platform, entry('failed', attempt, {
                error: 'The earlier attempt did not finish, so the comment may already be under the post. Check the post, then press Retry only if it is missing.',
            }), 'sending');
            log('warn', 'first_comment.interrupted', logBase);
            return;
        }
        log('info', 'first_comment.skipped', { ...logBase, post_status: row?.status ?? null, entry_status: current?.status ?? null });
        return;
    }

    const text = claimed.first_comment?.trim() ?? '';
    if (!text) {
        // The owner cleared the text after the post went out: nothing to say.
        await queryRows(`UPDATE scheduled_posts SET first_comment_status = first_comment_status - $2::text WHERE id = $1 RETURNING id`, [postId, platform]);
        log('info', 'first_comment.cleared_before_send', logBase);
        return;
    }

    const ids = publishedPlatforms(claimed.published_post_id);
    const objectId = platform === 'instagram' ? ids.ig : ids.fb;
    if (!objectId) {
        await writeEntry(postId, platform, entry('failed', attempt, { error: `The post has no ${platform === 'instagram' ? 'Instagram' : 'Facebook'} id to comment under.` }));
        log('warn', 'first_comment.no_target', logBase);
        return;
    }

    const creator = await queryOne<{ page_access_token: string | null }>('SELECT page_access_token FROM creators WHERE id = $1', [creatorId]);
    if (!creator?.page_access_token) {
        await writeEntry(postId, platform, entry('failed', attempt, { error: 'Meta is not connected for this account.' }));
        log('warn', 'first_comment.not_connected', logBase);
        return;
    }

    let result: { id: string | null };
    try {
        result = await publishFirstComment(platform, objectId, text, decryptSecret(creator.page_access_token));
    } catch (err: any) {
        await writeEntry(postId, platform, entry('failed', attempt, { error: reasonOf(err) }));
        log('warn', 'first_comment.failed', { ...logBase, meta_code: err?.metaCode ?? null, error_message: reasonOf(err) });
        return;
    }
    await writeEntry(postId, platform, entry('posted', attempt, result.id ? { id: result.id } : {}));
    log('info', 'first_comment.posted', { ...logBase, comment_id: result.id });
}

export type RetryOutcome =
    | { ok: true; queued: CommentPlatform[] }
    | { ok: false; code: 'NOT_FOUND' | 'NOT_PUBLISHED' | 'NOT_FAILED'; message: string };

/**
 * Retry a failed first comment: only a platform whose status is `failed` (with `only`, just that one). Moves it back to pending with the next attempt number,
 * which makes a new dedupe key, and queues it. A comment that is posted, waiting or in flight is never queued again.
 */
export async function retryFirstComment(creatorId: string, postId: string, only?: CommentPlatform): Promise<RetryOutcome> {
    const row = await queryOne<{ status: string; first_comment_status: FirstCommentStatus | null }>(
        'SELECT status, first_comment_status FROM scheduled_posts WHERE id = $1 AND creator_id = $2', [postId, creatorId]
    );
    if (!row) return { ok: false, code: 'NOT_FOUND', message: 'Scheduled post not found.' };
    if (row.status !== 'PUBLISHED') return { ok: false, code: 'NOT_PUBLISHED', message: 'The first comment goes out once the post is published.' };
    const failed = COMMENT_PLATFORMS.filter((p) => (only ? p === only : true) && row.first_comment_status?.[p]?.status === 'failed');
    if (failed.length === 0) return { ok: false, code: 'NOT_FAILED', message: 'There is no failed first comment to retry.' };

    const queued: CommentPlatform[] = [];
    for (const platform of failed) {
        const attempt = (row.first_comment_status?.[platform]?.attempt ?? 0) + 1;
        // Compare-and-set: two clicks queue it once.
        if (!(await writeEntry(postId, platform, entry('pending', attempt), 'failed'))) continue;
        try {
            await getJobQueue().enqueue({
                kind: 'post.first_comment',
                payload: { postId, creatorId, platform, attempt },
                dedupeKey: firstCommentDedupeKey(postId, platform, attempt),
                creatorId,
            });
            queued.push(platform);
        } catch (err: any) {
            await writeEntry(postId, platform, entry('failed', attempt, { error: 'The comment could not be queued. Press Retry.' })).catch(() => undefined);
            log('error', 'first_comment.retry_queue_failed', { post_id: postId, platform, error_message: String(err?.message ?? err).slice(0, 200) });
        }
    }
    if (queued.length === 0) return { ok: false, code: 'NOT_FAILED', message: 'There is no failed first comment to retry.' };
    return { ok: true, queued };
}
