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
 *
 * Photo posts (`image`, `carousel`) follow the same lifecycle with no upload step: TikTok pulls
 * each image from our public URL, so the row goes from the init straight to PROCESSING.
 */
import { queryCount, queryRows } from '../db/query.js';
import type { ScheduledPostRow, TikTokPostOptions, TikTokPrivacyLevel } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { getMediaStore, uploadIdFromUrl } from './storage.js';
import {
    describeFailReason, fetchPublishStatus, initDirectVideoPost, initInboxVideoUpload, initPhotoPost, mapPublishState,
    MAX_PHOTO_TITLE_UTF16, mp4DurationSeconds, photoTitle, planChunks, queryCreatorInfo, tiktokHttp, uploadChunks,
    type PhotoDirectPostInfo, type TikTokCreatorInfo, type TikTokPublishStatus, type TikTokWebhookEvent,
} from './tiktok.js';
import { getPublicBaseUrl, getTikTokPostingFlags } from './appSettings.js';
import {
    imageProblem, inspectImages, isTikTokPhotoType, TIKTOK_CAROUSEL_MAX, TIKTOK_CAROUSEL_MIN,
} from './postMedia.js';
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
    'id' | 'creator_id' | 'post_type' | 'caption' | 'media_url' | 'media_urls' | 'external_publish_id'
> & { platform_options?: TikTokPostOptions | null };

/**
 * What a TikTok post is made of. Photo posts have no duet, stitch or AI-generated label in
 * TikTok's API; they have a title and optional music instead.
 */
export type TikTokMediaKind = 'video' | 'photo';

// ─── Direct Post options ────────────────────────────────────────────────────────────────

export const TIKTOK_PRIVACY_LEVELS: readonly TikTokPrivacyLevel[] = [
    'PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY',
];

/**
 * Validate the composer's Direct Post choices against TikTok's Content Sharing Guidelines.
 * Pure, so the same rules the dashboard enforces are enforced here for any caller.
 */
export function validateTikTokOptions(
    raw: unknown,
    ctx: { audited: boolean; media?: TikTokMediaKind }
): { ok: true; options: TikTokPostOptions } | { ok: false; error: string } {
    const media = ctx.media ?? 'video';
    if (!raw || typeof raw !== 'object') {
        return { ok: false, error: 'Choose the TikTok post settings (who can see it, and your consent) first.' };
    }
    const r = raw as Record<string, unknown>;
    if (r.consent !== true) {
        return {
            ok: false,
            error: media === 'photo'
                ? 'Tick "I agree to post this to my TikTok account" first.'
                : 'Tick "I agree to post this video to my TikTok account" first.',
        };
    }
    const privacy = r.privacy_level;
    if (typeof privacy !== 'string' || !(TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(privacy)) {
        return { ok: false, error: 'Choose who can see this TikTok post.' };
    }
    if (!ctx.audited && privacy !== 'SELF_ONLY') {
        return { ok: false, error: 'Until TikTok approves this app, direct posts can only be private (Only me).' };
    }
    const brandContent = r.brand_content === true;
    if (brandContent && privacy === 'SELF_ONLY') {
        return { ok: false, error: 'Branded content can’t be private — choose a wider audience or untick Branded content.' };
    }
    if (media === 'photo') {
        const title = readPhotoTitle(r.title);
        if (!title.ok) return title;
        // Duet, stitch and is_aigc are not stored at all: TikTok's photo post has none of
        // them, and a choice kept on the row would read as one that had been applied.
        return {
            ok: true,
            options: {
                mode: 'direct',
                privacy_level: privacy as TikTokPrivacyLevel,
                allow_comment: r.allow_comment === true,
                brand_organic: r.brand_organic === true,
                brand_content: brandContent,
                ...(title.title ? { title: title.title } : {}),
                // On unless switched off — TikTok's own default for a photo post.
                auto_add_music: r.auto_add_music !== false,
                consent_at: new Date().toISOString(),
            },
        };
    }
    return {
        ok: true,
        options: {
            mode: 'direct',
            privacy_level: privacy as TikTokPrivacyLevel,
            allow_comment: r.allow_comment === true,
            allow_duet: r.allow_duet === true,
            allow_stitch: r.allow_stitch === true,
            brand_organic: r.brand_organic === true,
            brand_content: brandContent,
            is_aigc: r.is_aigc === true,
            consent_at: new Date().toISOString(),
        },
    };
}

/** A photo title the creator typed, or `undefined` for "the caption's first line". */
function readPhotoTitle(raw: unknown): { ok: true; title?: string } | { ok: false; error: string } {
    if (raw === undefined || raw === null) return { ok: true };
    if (typeof raw !== 'string') return { ok: false, error: 'The TikTok title must be text.' };
    const title = raw.trim();
    if (!title) return { ok: true };
    // `.length` is UTF-16 code units, which is what TikTok counts.
    if (title.length > MAX_PHOTO_TITLE_UTF16) {
        return { ok: false, error: `The TikTok title can be at most ${MAX_PHOTO_TITLE_UTF16} characters — this one has ${title.length}.` };
    }
    return { ok: true, title };
}

/**
 * Inbox mode's options. TikTok's editor asks the creator for everything else when they open
 * the draft, so the only thing a post carries is a photo post's title.
 */
export function validateTikTokInboxOptions(
    raw: unknown,
    media: TikTokMediaKind
): { ok: true; options: TikTokPostOptions } | { ok: false; error: string } {
    if (media !== 'photo') return { ok: true, options: { mode: 'inbox' } };
    const title = readPhotoTitle(raw && typeof raw === 'object' ? (raw as Record<string, unknown>).title : undefined);
    if (!title.ok) return title;
    return { ok: true, options: title.title ? { mode: 'inbox', title: title.title } : { mode: 'inbox' } };
}

export function isDirectPost(post: { platform_options?: TikTokPostOptions | null }): boolean {
    return post.platform_options?.mode === 'direct';
}

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

/**
 * How many uploads this tenant has waiting in the TikTok inbox from the last 24 hours.
 *
 * PUBLISHING counts too: two drains running at once each saw the other's row still
 * mid-upload, left it out, and both went ahead — six drafts went up against a limit of five
 * on the first real run (2026-09-23). The row being published is excluded by id.
 */
export async function pendingInboxShares(creatorId: string, excludePostId?: string): Promise<number> {
    const rows = await queryRows<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM scheduled_posts
          WHERE creator_id = $1 AND platform = 'tiktok'
            AND COALESCE(platform_options->>'mode', 'inbox') = 'inbox'
            AND status IN ('PUBLISHING', 'PROCESSING', 'IN_INBOX')
            AND claimed_at > NOW() - INTERVAL '24 hours'
            AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [creatorId, excludePostId ?? null]
    );
    return rows[0]?.n ?? 0;
}

/**
 * The bytes to upload. Our own uploads are read straight from the media store (Postgres, or
 * Supabase Storage) rather than fetched back through our own route. Anything else is downloaded.
 */
async function loadMedia(mediaUrl: string): Promise<{ data: Buffer; mimeType: string }> {
    const uploadId = uploadIdFromUrl(mediaUrl);
    if (uploadId) {
        const stored = await (await getMediaStore()).get(uploadId);
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

/**
 * The privacy level a Direct Post goes out with, checked against a FRESH creator_info — the one
 * taken at scheduling time may be days old, and the creator can have changed their privacy
 * options since.
 */
function checkedPrivacy(opts: TikTokPostOptions, audited: boolean, creator: TikTokCreatorInfo): TikTokPrivacyLevel {
    const privacy = opts.privacy_level;
    if (!privacy) throw new Error('This TikTok post has no privacy choice — edit it and choose who can see it.');
    if (!audited && privacy !== 'SELF_ONLY') {
        throw new Error('Until TikTok approves this app, direct posts can only be private (Only me) — edit the post.');
    }
    if (creator.privacyLevelOptions.length > 0 && !creator.privacyLevelOptions.includes(privacy)) {
        throw new Error('That privacy choice is not available for this TikTok account any more — edit the post and choose again.');
    }
    return privacy;
}

/**
 * The Direct Post init, with every check TikTok's guidelines ask for made against a FRESH
 * creator_info — the one taken at scheduling time may be days old, and the creator can have
 * changed their privacy options or switched comments off since.
 */
async function startDirectPost(
    accessToken: string,
    post: TikTokPublishTarget,
    video: Buffer,
    plan: ReturnType<typeof planChunks>
) {
    const opts = post.platform_options ?? { mode: 'direct' };
    const [{ audited }, creator] = await Promise.all([getTikTokPostingFlags(), queryCreatorInfo(accessToken)]);

    const privacy = checkedPrivacy(opts, audited, creator);
    const seconds = mp4DurationSeconds(video);
    if (seconds !== null && creator.maxVideoPostDurationSec > 0 && seconds > creator.maxVideoPostDurationSec + 0.5) {
        throw new Error(`This video is ${Math.round(seconds)}s; your TikTok account allows up to ${creator.maxVideoPostDurationSec}s.`);
    }

    return initDirectVideoPost(accessToken, plan, {
        title: post.caption ?? '',
        privacy_level: privacy,
        // A creator who has switched an interaction off cannot have it switched back on by us.
        disable_comment: !opts.allow_comment || creator.commentDisabled,
        disable_duet: !opts.allow_duet || creator.duetDisabled,
        disable_stitch: !opts.allow_stitch || creator.stitchDisabled,
        brand_content_toggle: opts.brand_content === true,
        brand_organic_toggle: opts.brand_organic === true,
        is_aigc: opts.is_aigc === true,
    });
}

/** TikTok processed the upload and refused it. The row already carries TikTok's reason. */
export class TikTokRejectedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TikTokRejectedError';
    }
}

/**
 * Wait a little for TikTok's verdict, so the person who pressed "Publish now" sees the real
 * outcome instead of "processing". Anything still processing is left to the webhook and the
 * reconcile sweep.
 */
async function settleInline(
    accessToken: string,
    postId: string,
    publishId: string,
    budgetMs: number
): Promise<ScheduledPostRow['status']> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        await sleep(INLINE_POLL_INTERVAL_MS);
        let reported: TikTokPublishStatus;
        try {
            reported = await fetchPublishStatus(accessToken, publishId);
        } catch (err) {
            // Not a failure of the post — TikTok has it. The webhook or the sweep will learn
            // the outcome.
            log('warn', 'tiktok.inline_poll_failed', { post_id: postId, ...describeError(err) });
            break;
        }
        const landed = await applyStatus(postId, reported);
        if (landed && landed !== 'PROCESSING') {
            log('info', 'tiktok.publish_settled', { post_id: postId, status: landed });
            // applyStatus has already written TikTok's reason onto the row.
            if (landed === 'FAILED') throw new TikTokRejectedError(describeFailReason(reported.failReason));
            return landed;
        }
    }
    return 'PROCESSING';
}

/**
 * The URLs TikTok will pull, in slide order, once every upload is confirmed to exist and to be
 * a JPEG or WebP — checked here as well as at scheduling, because an upload can be deleted or
 * a row edited in between, and TikTok's answer to either is a failed pull minutes later.
 *
 * Rebuilt from the upload ids on the public base URL rather than taken from the row: TikTok
 * pulls only from the URL prefix verified in its portal, so the host a row happened to be
 * saved from — a preview deployment, localhost — would be refused; and its fetcher wants a URL
 * that ends like an image.
 */
async function tiktokPhotoUrls(post: TikTokPublishTarget): Promise<string[]> {
    const listed = post.media_urls && post.media_urls.length > 0 ? post.media_urls : post.media_url ? [post.media_url] : [];
    const sources = post.post_type === 'carousel' ? listed : listed.slice(0, 1);
    if (sources.length === 0) throw new Error('TikTok needs a photo to post — edit the post and add one.');
    if (post.post_type === 'carousel' && (sources.length < TIKTOK_CAROUSEL_MIN || sources.length > TIKTOK_CAROUSEL_MAX)) {
        throw new Error(`A TikTok carousel takes ${TIKTOK_CAROUSEL_MIN} to ${TIKTOK_CAROUSEL_MAX} photos — this one has ${sources.length}. Edit the post.`);
    }

    const images = await inspectImages(sources);
    const problem = imageProblem(images, { carousel: post.post_type === 'carousel', instagram: false, tiktok: true });
    if (problem) throw new Error(problem);

    const base = await getPublicBaseUrl(null);
    if (!base) {
        throw new Error('TikTok fetches photos from this app’s public address, and none is set — add it in Settings → TikTok app.');
    }
    return images.map((image) => `${base}/api/uploads/${image.uploadId}.${image.mimeType === 'image/webp' ? 'webp' : 'jpg'}`);
}

/** A photo's Direct Post choices, re-checked against a fresh creator_info as a video's are. */
async function directPhotoInfo(accessToken: string, post: TikTokPublishTarget): Promise<PhotoDirectPostInfo> {
    const opts = post.platform_options ?? { mode: 'direct' };
    const [{ audited }, creator] = await Promise.all([getTikTokPostingFlags(), queryCreatorInfo(accessToken)]);
    return {
        privacy_level: checkedPrivacy(opts, audited, creator),
        // A creator who has switched comments off cannot have them switched back on by us.
        disable_comment: !opts.allow_comment || creator.commentDisabled,
        auto_add_music: opts.auto_add_music !== false,
        brand_content_toggle: opts.brand_content === true,
        brand_organic_toggle: opts.brand_organic === true,
    };
}

/**
 * The photo half of `publishTikTokPost`, after the checks both halves share. There is no upload
 * and no duration: TikTok pulls the images itself, so once the init has a `publish_id` the row
 * is PROCESSING and the same three writers carry it on.
 */
async function publishPhotoPost(
    accessToken: string,
    post: TikTokPublishTarget,
    direct: boolean,
    inlinePollBudgetMs: number
): Promise<ScheduledPostRow['status']> {
    // A retry of a row that already reached TikTok. Unless TikTok refused it, the post or the
    // draft exists, and a second init would duplicate it.
    if (post.external_publish_id) {
        try {
            const previous = await fetchPublishStatus(accessToken, post.external_publish_id);
            if (previous.status !== 'FAILED') {
                const landed = await applyStatus(post.id, previous);
                log('info', 'tiktok.publish_resumed', { post_id: post.id, status: landed });
                if (landed) return landed;
            }
        } catch (err) {
            log('warn', 'tiktok.publish_resume_check_failed', { post_id: post.id, ...describeError(err) });
        }
    }

    const photoUrls = await tiktokPhotoUrls(post);
    const text = {
        title: photoTitle(post.caption, post.platform_options?.title),
        description: post.caption ?? '',
    };
    const init = await initPhotoPost(
        accessToken, photoUrls, text, direct ? await directPhotoInfo(accessToken, post) : undefined
    );
    // Written before anything else, so a crash from here on resumes instead of posting twice.
    await queryCount(
        `UPDATE scheduled_posts SET external_publish_id = $2 WHERE id = $1`,
        [post.id, init.publishId]
    );
    log('info', 'tiktok.photo_post_started', {
        post_id: post.id, publish_id: init.publishId, photos: photoUrls.length, mode: direct ? 'direct' : 'inbox',
    });
    await queryCount(
        `UPDATE scheduled_posts SET status = 'PROCESSING', error_log = NULL, status_checked_at = NOW()
          WHERE id = $1 AND status = 'PUBLISHING'`,
        [post.id]
    );
    return settleInline(accessToken, post.id, init.publishId, inlinePollBudgetMs);
}

/**
 * Publish one claimed TikTok row (status PUBLISHING). Returns the status the row ended in; on
 * failure it writes FAILED and rethrows, matching `attemptPublish` for the Meta rows.
 */
export async function publishTikTokPost(
    post: TikTokPublishTarget,
    /** How long to wait for TikTok's verdict before leaving it to the webhook and the sweep. */
    inlinePollBudgetMs: number = INLINE_POLL_BUDGET_MS
): Promise<ScheduledPostRow['status']> {
    let connectionId: string | null = null;
    try {
        if (!post.creator_id) throw new Error('This post has no account.');
        const photo = isTikTokPhotoType(post.post_type);
        if (!photo && post.post_type !== 'video') {
            throw new Error('TikTok posts must be a video, a photo or a carousel of photos.');
        }
        if (!photo && !post.media_url) throw new Error('TikTok needs a video to upload.');

        const direct = isDirectPost(post);
        if (!direct) {
            const pending = await pendingInboxShares(post.creator_id, post.id);
            if (pending >= MAX_PENDING_INBOX_SHARES && !post.external_publish_id) {
                throw new TikTokInboxFullError(pending);
            }
        }

        const { accessToken, connection } = await getAccessToken(post.creator_id);
        connectionId = connection.id;
        // Checked here rather than left to TikTok: its answer is scope_not_authorized, which would
        // mark the whole connection invalid — blocking the other mode, which still works.
        if (direct && !(connection.scopes ?? []).includes('video.publish')) {
            throw new Error('This post is set to post directly, but TikTok has not granted direct posting — reconnect TikTok in Settings.');
        }
        if (!direct && !(connection.scopes ?? []).includes('video.upload')) {
            throw new Error('This post is set to go to your TikTok drafts, but TikTok has not granted uploading — reconnect TikTok in Settings, or edit the post to post directly.');
        }

        if (photo) return await publishPhotoPost(accessToken, post, direct, inlinePollBudgetMs);

        const media = await loadMedia(post.media_url!);
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

        const init = direct
            ? { ...(await startDirectPost(accessToken, post, media.data, plan)), captionSent: true }
            : await initInboxVideoUpload(accessToken, plan, post.caption);
        // Written before a single byte goes up, so a crash from here on is resumable rather
        // than a second upload.
        await queryCount(
            `UPDATE scheduled_posts SET external_publish_id = $2 WHERE id = $1`,
            [post.id, init.publishId]
        );
        log('info', 'tiktok.upload_started', {
            post_id: post.id, publish_id: init.publishId, bytes: plan.videoSize,
            chunks: plan.totalChunkCount, caption_sent: init.captionSent, mode: direct ? 'direct' : 'inbox',
        });

        await uploadChunks(init.uploadUrl, media.data, media.mimeType, plan);
        await queryCount(
            `UPDATE scheduled_posts SET status = 'PROCESSING', error_log = NULL, status_checked_at = NOW()
              WHERE id = $1 AND status = 'PUBLISHING'`,
            [post.id]
        );
        log('info', 'tiktok.upload_done', { post_id: post.id, publish_id: init.publishId });

        // Most small reels are in the inbox within seconds.
        return await settleInline(accessToken, post.id, init.publishId, inlinePollBudgetMs);
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
