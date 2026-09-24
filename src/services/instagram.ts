import { metaHttp, withRetry } from './http.js';
import { log } from '../utils/log.js';

/** Shape of a Graph API version string. Anything else would build a URL Meta 404s. */
const VERSION_PATTERN = /^v\d+\.\d+$/;

/**
 * The default Graph API version.
 *
 * Bumped v21.0 -> v26.0 on 2026-09-21. The reason to move was not that v21.0 had stopped
 * working — it was that Meta's versioning policy does not fail loudly. Per Meta: once a
 * version is no longer usable, calls to it are "defaulted to the next oldest, usable
 * version". Nothing 404s. v21.0 reaches that point around 2027-01-21, at which point every
 * URL in this file would silently start executing as v22.0 semantics, with no error to grep
 * for and no line in any log. Doing nothing is therefore also an untested version change —
 * just one at a time nobody chooses.
 *
 * What was verified before the bump, against the live token: `debug_token`, the page node,
 * `/{page}/feed`, the IG user node and `/{ig}/media` return byte-identical response shapes
 * on v21.0 and v26.0.
 *
 * What was NOT verified, and cannot be without acting on a real account: the write paths —
 * `/{id}/media` + `/media_publish`, `/{id}/feed`, `/{id}/photos`, `/{id}/videos`,
 * `/{id}/messages` and `/{id}/likes`. Publishing a post or sending a DM to test a version
 * bump has a real recipient. Those remain unproven by us.
 */
export const DEFAULT_API_VERSION = 'v26.0';

/**
 * The Graph API version every call in this file uses.
 *
 * Overridable by `META_API_VERSION` specifically so a rollback is an environment change
 * rather than a code change, review and deploy — which matters for the write paths above,
 * since the first evidence of a problem will be a real failed publish or a real undelivered
 * DM.
 *
 * An invalid value logs loudly and falls back to the default rather than throwing. Throwing
 * at module load on Vercel turns every route into an opaque 500 (see the note in
 * src/config/env.ts), and a typo in an optional variable should not take the app down — but
 * it must not pass silently either, because an unusable version breaks every Meta call.
 */
export function resolveApiVersion(): string {
    const override = process.env.META_API_VERSION?.trim();
    if (!override) return DEFAULT_API_VERSION;
    if (!VERSION_PATTERN.test(override)) {
        log('error', 'meta.api_version_invalid', {
            value: override,
            using: DEFAULT_API_VERSION,
            hint: 'META_API_VERSION must look like v26.0',
        });
        return DEFAULT_API_VERSION;
    }
    return override;
}

export const API_VERSION = resolveApiVersion();

/**
 * A Meta failure, rewrapped for readability but not flattened.
 *
 * Every function here used to `throw new Error('... (Code: 190)')`, which reads well in
 * `interactions.error_log` and destroys everything a caller could act on: `response.data.error`
 * was gone, so `isPermanentMetaError` returned false for a dead token, and the `error_subcode`
 * that distinguishes "expired" from "password changed" from "app uninstalled" never left this
 * file. `src/webhook/errors.test.ts` documented that as a known hole.
 *
 * The message is unchanged — the dashboard renders it — and the code, subcode and original
 * error now ride along beside it.
 */
export class MetaApiError extends Error {
    readonly metaCode: number | undefined;
    readonly metaSubcode: number | undefined;

    constructor(message: string, source: any) {
        super(message, { cause: source });
        this.name = 'MetaApiError';
        const metaError = source?.response?.data?.error;
        this.metaCode = typeof metaError?.code === 'number' ? metaError.code : undefined;
        this.metaSubcode = typeof metaError?.error_subcode === 'number'
            ? metaError.error_subcode
            : undefined;
    }
}

/** `[Private Reply Failed: ... (Code: 190)]` — the shape the dashboard has always shown. */
function metaFailure(prefix: string, error: any): MetaApiError {
    const metaError = error?.response?.data?.error;
    return new MetaApiError(
        `${prefix}: ${metaError?.message || error?.message} (Code: ${metaError?.code ?? 'N/A'})`,
        error
    );
}

const GRAPH_BASE = `https://graph.facebook.com/${API_VERSION}`;

/**
 * How long to wait for Instagram to finish transcoding an uploaded video.
 *
 * This used to be 15 polls at 5s = 75s, on top of publish retries, inside a Vercel function
 * that sets no `maxDuration`. The platform kills the invocation long before that, mid-poll,
 * leaving the scheduled_posts row stuck in PUBLISHING with nothing to reap it. A tighter
 * budget means the function reaches its own timeout branch and the caller can act on it.
 */
const CONTAINER_POLL_INTERVAL_MS = 2_500;
const DEFAULT_CONTAINER_POLL_BUDGET_MS = 25_000;

/** Attempts to ride out a container that exists but is not yet publishable. */
const CONTAINER_NOT_READY_RETRIES = 2;
const CONTAINER_NOT_READY_DELAY_MS = 2_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thrown when a media container is still processing once the poll budget is spent.
 *
 * Deliberately distinct from a publish failure: the container may well finish server-side a
 * moment later, so the caller needs to tell "Instagram rejected this" apart from "we stopped
 * waiting" and mark the row FAILED (or requeue it) instead of leaving it in PUBLISHING.
 * Identifiable either by `instanceof` or by the stable `code`, for callers that would rather
 * not import the class.
 */
export class MediaProcessingTimeoutError extends Error {
    readonly code = 'IG_MEDIA_PROCESSING_TIMEOUT';

    constructor(
        readonly containerId: string,
        readonly waitedMs: number,
        readonly lastStatus: string
    ) {
        super(
            `Instagram media processing timed out after ${Math.round(waitedMs / 1000)}s ` +
            `(container ${containerId}, last status: ${lastStatus || 'unknown'}).`
        );
        this.name = 'MediaProcessingTimeoutError';
    }
}

/**
 * Sends a Direct Message to a user as a Private Reply to their comment.
 *
 * - Instagram: uses /me/messages  (token resolves to the IG-linked page)
 * - Facebook:  uses /{pageId}/messages  (required for FB Page tokens per 2025 Meta docs)
 *
 * Limit: 1 private reply per comment, must be sent within 7 days.
 * @see https://developers.facebook.com/docs/messenger-platform/instagram/features/private-replies
 */
export async function sendPrivateReply(
    commentId: string,
    message: string,
    accessToken: string,
    pageId?: string            // Pass Facebook Page ID for FB comments; omit for Instagram
) {
    // Facebook requires /{page-id}/messages; Instagram works with /me/messages
    const endpoint = pageId ? pageId : 'me';
    const url = `${GRAPH_BASE}/${endpoint}/messages`;

    try {
        const response = await withRetry(
            () => metaHttp.post(url, {
                recipient: { comment_id: commentId },
                message: { text: message },
                messaging_type: 'RESPONSE'
            }, {
                headers: { Authorization: `Bearer ${accessToken}` }
            }),
            { label: `sendPrivateReply[${endpoint}]` }
        );
        return response.data;
    } catch (error: any) {
        throw metaFailure(`Private Reply Failed [${endpoint}]`, error);
    }
}

/**
 * Posts a public comment reply visible to everyone on the post.
 *
 * - Instagram: POST /{comment-id}/replies
 * - Facebook:  POST /{comment-id}/comments
 *
 * @see https://developers.facebook.com/docs/instagram-api/reference/ig-comment/replies
 * @see https://developers.facebook.com/docs/graph-api/reference/comment#Creating
 */
export async function sendPublicReply(
    commentId: string,
    message: string,
    accessToken: string,
    isFacebook = false         // Facebook uses /comments edge; Instagram uses /replies
) {
    const edge = isFacebook ? 'comments' : 'replies';
    const url = `${GRAPH_BASE}/${commentId}/${edge}`;

    try {
        const response = await withRetry(
            () => metaHttp.post(url, {
                message: message
            }, {
                headers: { Authorization: `Bearer ${accessToken}` }
            }),
            { label: `sendPublicReply[${edge}]` }
        );
        return response.data;
    } catch (error: any) {
        throw metaFailure('Public Reply Failed', error);
    }
}

/**
 * Sends a standard Direct Message (DM) to an Instagram User ID (IGSID).
 * Supports text, quick replies, and templates (carousels).
 *
 * @see https://developers.facebook.com/docs/messenger-platform/instagram/reference/send-api
 */
export async function sendDirectMessage(
    recipientId: string,
    messagePayload: any,
    accessToken: string,
    pageId?: string            // Pass Facebook Page ID for FB DMs; omit for Instagram
) {
    const endpoint = pageId ? pageId : 'me';
    const url = `${GRAPH_BASE}/${endpoint}/messages`;

    try {
        // Retrying a send is not strictly idempotent, but withRetry only fires on 5xx / 429 /
        // transport faults, where the send most likely never landed. A duplicate DM is a far
        // smaller harm than the interaction being marked FAILED on one transient blip.
        const response = await withRetry(
            () => metaHttp.post(url, {
                recipient: { id: recipientId },
                message: messagePayload,
                // Messenger requires a messaging_type; without it the send is evaluated
                // outside the standard messaging window and is rejected once that window
                // matters. sendPrivateReply has always set this — this one never did.
                messaging_type: 'RESPONSE'
            }, {
                headers: { Authorization: `Bearer ${accessToken}` }
            }),
            { label: `sendDirectMessage[${endpoint}]` }
        );
        return response.data;
    } catch (error: any) {
        throw metaFailure('DM Send Failed', error);
    }
}

/**
 * Automatically likes a comment.
 *
 * - Instagram & Facebook: POST /{comment-id}/likes
 *
 * @see https://developers.facebook.com/docs/instagram-api/reference/ig-comment/likes
 */
export async function likeComment(
    commentId: string,
    accessToken: string
) {
    const url = `${GRAPH_BASE}/${commentId}/likes`;

    try {
        const response = await withRetry(
            () => metaHttp.post(url, {}, {
                headers: { Authorization: `Bearer ${accessToken}` }
            }),
            { label: 'likeComment' }
        );
        return response.data;
    } catch (error: any) {
        throw metaFailure('Comment Auto-Like Failed', error);
    }
}

/**
 * Publishes a post to a Facebook Page feed.
 * Supports image, video/reel, and text-only feed posts.
 *
 * Throws on a post_type Facebook cannot take through these edges rather than degrading to a
 * text status, because a degraded publish still returns a post id and is recorded as a success.
 */
export async function publishFacebookPost(
    pageId: string,
    type: 'image' | 'video' | 'reel' | 'story' | 'feed',
    caption: string,
    mediaUrl: string | null,
    accessToken: string
) {
    if (type !== 'image' && type !== 'video' && type !== 'reel' && type !== 'feed') {
        // Page stories need Facebook's two-step /photo_stories + /video_stories upload, which
        // this service does not implement. Previously 'story' fell through to /feed and
        // published the caption as a bare text status, with no media and no error.
        throw new Error(`Unsupported Facebook post_type: ${type}`);
    }

    // media_url is nullable by design — a Facebook feed post may legitimately be text only.
    let url = `${GRAPH_BASE}/${pageId}/feed`;
    let payload: any = { message: caption };

    if (type === 'feed') {
        // The dashboard's "text / link" type. It was offered in the composer but rejected
        // here as unsupported, so every text post scheduled from the dashboard failed at
        // publish time. A URL on a feed post is a link to share, not an asset to upload.
        if (mediaUrl) payload.link = mediaUrl;
    } else if (mediaUrl && type === 'image') {
        url = `${GRAPH_BASE}/${pageId}/photos`;
        payload = { url: mediaUrl, caption: caption };
    } else if (mediaUrl) {
        // 'reel' and 'video' are the same asset as far as Facebook is concerned; both publish
        // through /videos. Only 'video' was handled before, so a reel scheduled for both
        // platforms went out as a caption-only status on Facebook.
        url = `${GRAPH_BASE}/${pageId}/videos`;
        payload = { file_url: mediaUrl, description: caption };
    }

    try {
        const response = await withRetry(
            () => metaHttp.post(url, payload, {
                headers: { Authorization: `Bearer ${accessToken}` }
            }),
            { label: `publishFacebookPost[${type}]` }
        );
        return response.data; // returns { id: "post_id" }
    } catch (error: any) {
        throw metaFailure('Facebook Publish Failed', error);
    }
}

/**
 * Publishes several photos as one Facebook Page feed post.
 *
 * Each photo is uploaded with `published: false` — otherwise every slide appears on the Page as
 * a post of its own — and `/feed` then attaches them all by id, with the caption on the feed
 * post only. An empty list throws rather than falling through to a text-only status, which
 * would come back with a post id and be recorded as a success.
 */
export async function publishFacebookCarousel(
    pageId: string,
    caption: string,
    imageUrls: readonly string[],
    accessToken: string
) {
    if (imageUrls.length === 0) {
        throw new Error('Facebook Publish Failed: this carousel has no images.');
    }
    const headers = { Authorization: `Bearer ${accessToken}` };

    try {
        const attached: { media_fbid: string }[] = [];
        for (const [index, url] of imageUrls.entries()) {
            // A retry after a 5xx can leave an unpublished photo behind. It is never shown, so
            // that is a better outcome than a carousel missing a slide.
            const photoRes = await withRetry(
                () => metaHttp.post(`${GRAPH_BASE}/${pageId}/photos`, { url, published: false }, { headers }),
                { label: `publishFacebookCarousel[photo ${index + 1}/${imageUrls.length}]` }
            );
            attached.push({ media_fbid: photoRes.data.id });
        }

        const response = await withRetry(
            () => metaHttp.post(`${GRAPH_BASE}/${pageId}/feed`, { message: caption, attached_media: attached }, { headers }),
            { label: 'publishFacebookCarousel[feed]' }
        );
        return response.data; // returns { id: "post_id" }
    } catch (error: any) {
        throw metaFailure('Facebook Publish Failed', error);
    }
}

/**
 * Poll a container until Instagram reports it FINISHED. Throws on ERROR / EXPIRED, and
 * {@link MediaProcessingTimeoutError} once `pollBudgetMs` is spent.
 */
async function waitForContainer(containerId: string, accessToken: string, pollBudgetMs: number): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + pollBudgetMs;
    let status = 'IN_PROGRESS';
    let statusDetail = '';

    while (Date.now() < deadline) {
        // A transient blip on a status check should not abandon an upload that is
        // already in flight; the deadline above is what ultimately bounds this.
        const statusRes = await withRetry(
            () => metaHttp.get(`${GRAPH_BASE}/${containerId}`, {
                params: { fields: 'status_code,status', access_token: accessToken }
            }),
            { retries: 1, baseMs: 500, label: 'ig-container-status' }
        );
        status = statusRes.data.status_code;
        statusDetail = statusRes.data.status || '';
        const msLeft = Math.max(0, deadline - Date.now());
        log('debug', 'publish.container_status', {
            container_id: containerId, status, detail: statusDetail, ms_left: msLeft,
        });

        if (status === 'ERROR' || status === 'EXPIRED') {
            throw new Error(`Instagram media processing failed with status: ${status}. Detail: ${statusDetail}`);
        }

        if (status === 'FINISHED') {
            break;
        }

        if (msLeft <= 0) break;
        await sleep(Math.min(CONTAINER_POLL_INTERVAL_MS, msLeft));
    }

    if (status !== 'FINISHED') {
        throw new MediaProcessingTimeoutError(containerId, Date.now() - startedAt, statusDetail);
    }
}

/** `media_publish` a finished container, riding out the not-ready race. */
async function publishContainer(instagramId: string, containerId: string, accessToken: string) {
    log('info', 'publish.container_publishing', { container_id: containerId });
    const publishUrl = `${GRAPH_BASE}/${instagramId}/media_publish`;

    for (let attempt = 0; ; attempt++) {
        try {
            return await withRetry(
                () => metaHttp.post(publishUrl, {
                    creation_id: containerId
                }, {
                    headers: { Authorization: `Bearer ${accessToken}` }
                }),
                { retries: 1, baseMs: 750, label: 'ig-media-publish' }
            );
        } catch (publishError: any) {
            const metaCode = publishError.response?.data?.error?.code;

            // Code 9007 "Media ID is not available" and a bare 100 both mean the container
            // exists but is not publishable yet — a race the status poll cannot close for
            // images, which skip it entirely. withRetry rightly refuses to retry a 400, so
            // this specific case is ridden out here and the two budgets compose.
            if ((metaCode === 9007 || metaCode === 100) && attempt < CONTAINER_NOT_READY_RETRIES) {
                log('warn', 'publish.container_not_ready', {
                    container_id: containerId, meta_code: metaCode,
                    delay_ms: CONTAINER_NOT_READY_DELAY_MS,
                });
                await sleep(CONTAINER_NOT_READY_DELAY_MS);
                continue;
            }
            throw publishError; // Throw other errors like Auth issues immediately
        }
    }
}

/**
 * Publishes a post to an Instagram Business account.
 * Handles the 2-step media container lifecycle (create container, check status, publish).
 *
 * Throws {@link MediaProcessingTimeoutError} if the container has not finished processing
 * within the poll budget, so the caller can distinguish a stalled upload from a rejection.
 */
export async function publishInstagramPost(
    instagramId: string,
    type: 'image' | 'video' | 'reel' | 'story',
    caption: string,
    mediaUrl: string,
    accessToken: string,
    /**
     * Public URL of an image to use as the reel's cover. Instagram defaults a
     * reel's thumbnail to frame 0 of the video, which renders as a black tile
     * in the profile grid whenever a video fades in from black.
     */
    coverUrl?: string | null,
    /**
     * Overall wall-clock budget for the container status poll. Defaults low enough to finish
     * inside a serverless invocation; raise it from a long-running worker.
     */
    pollBudgetMs: number = DEFAULT_CONTAINER_POLL_BUDGET_MS
) {
    const createUrl = `${GRAPH_BASE}/${instagramId}/media`;
    let createPayload: any = {};

    if (type === 'image') {
        createPayload = { image_url: mediaUrl, caption: caption };
    } else if (type === 'video' || type === 'reel') {
        createPayload = { media_type: 'REELS', video_url: mediaUrl, caption: caption };
        if (coverUrl) {
            // cover_url wins over thumb_offset when both are sent, so only one is set.
            createPayload.cover_url = coverUrl;
        } else {
            // 1.5s in: past any fade-in, still early enough to be on the hook.
            createPayload.thumb_offset = 1500;
        }
        // Without this a reel only appears in the Reels tab, not the main feed.
        createPayload.share_to_feed = true;
    } else if (type === 'story') {
        const isVideo = mediaUrl.match(/\.(mp4|mov|avi|wmv)/i);
        if (isVideo) {
            createPayload = { media_type: 'STORIES', video_url: mediaUrl };
        } else {
            createPayload = { media_type: 'STORIES', image_url: mediaUrl };
        }
    }

    try {
        // Step 1: Create media container
        log('info', 'publish.container_creating', { post_type: type });
        const createRes = await withRetry(
            () => metaHttp.post(createUrl, createPayload, {
                headers: { Authorization: `Bearer ${accessToken}` }
            }),
            { label: `ig-create-container[${type}]` }
        );
        const containerId = createRes.data.id;
        log('info', 'publish.container_created', { container_id: containerId });

        if (type !== 'image') {
            // Check and poll status for video, reel, story to make sure processing is complete
            await waitForContainer(containerId, accessToken, pollBudgetMs);
        }

        // Step 2: Publish container
        const publishRes = await publishContainer(instagramId, containerId, accessToken);

        log('info', 'publish.instagram_success', { ig_media_id: publishRes?.data?.id });
        return publishRes?.data; // returns { id: "media_id" }
    } catch (error: any) {
        // The timeout carries the container id and last known status, which is what lets the
        // caller requeue rather than guess; flattening it into a string Error loses that.
        if (error instanceof MediaProcessingTimeoutError) throw error;

        throw metaFailure('Instagram Publish Failed', error);
    }
}

/**
 * Publishes an image carousel to an Instagram Business account.
 *
 * Three steps rather than two: one child container per image (`is_carousel_item`, no caption —
 * Instagram takes the caption from the parent), then the CAROUSEL parent naming the children
 * as a comma-separated string, then the same status poll and `media_publish` as a single post.
 *
 * Instagram takes JPEG only, 2–10 images, and crops every slide to the first one's aspect
 * ratio. Throws {@link MediaProcessingTimeoutError} if the parent is still processing when the
 * poll budget runs out, exactly as a reel does.
 */
export async function publishInstagramCarousel(
    instagramId: string,
    caption: string,
    imageUrls: readonly string[],
    accessToken: string,
    pollBudgetMs: number = DEFAULT_CONTAINER_POLL_BUDGET_MS
) {
    if (imageUrls.length < 2 || imageUrls.length > 10) {
        throw new Error(`Instagram Publish Failed: a carousel takes 2 to 10 images — this one has ${imageUrls.length}.`);
    }
    const createUrl = `${GRAPH_BASE}/${instagramId}/media`;
    const headers = { Authorization: `Bearer ${accessToken}` };

    try {
        log('info', 'publish.container_creating', { post_type: 'carousel', items: imageUrls.length });
        const children: string[] = [];
        for (const [index, imageUrl] of imageUrls.entries()) {
            // A retried child is at worst an orphan container, which expires unpublished.
            const childRes = await withRetry(
                () => metaHttp.post(createUrl, { image_url: imageUrl, is_carousel_item: true }, { headers }),
                { label: `ig-create-carousel-item[${index + 1}/${imageUrls.length}]` }
            );
            children.push(childRes.data.id);
        }

        const parentRes = await withRetry(
            () => metaHttp.post(createUrl, {
                media_type: 'CAROUSEL', children: children.join(','), caption,
            }, { headers }),
            { label: 'ig-create-container[carousel]' }
        );
        const containerId = parentRes.data.id;
        log('info', 'publish.container_created', { container_id: containerId, children: children.length });

        await waitForContainer(containerId, accessToken, pollBudgetMs);
        const publishRes = await publishContainer(instagramId, containerId, accessToken);

        log('info', 'publish.instagram_success', { ig_media_id: publishRes?.data?.id });
        return publishRes?.data; // returns { id: "media_id" }
    } catch (error: any) {
        if (error instanceof MediaProcessingTimeoutError) throw error;

        throw metaFailure('Instagram Publish Failed', error);
    }
}
