import { metaHttp, withRetry } from './http.js';
import { log } from '../utils/log.js';

export const API_VERSION = 'v21.0';

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
    type: 'image' | 'video' | 'reel' | 'story',
    caption: string,
    mediaUrl: string | null,
    accessToken: string
) {
    if (type !== 'image' && type !== 'video' && type !== 'reel') {
        // Page stories need Facebook's two-step /photo_stories + /video_stories upload, which
        // this service does not implement. Previously 'story' fell through to /feed and
        // published the caption as a bare text status, with no media and no error.
        throw new Error(`Unsupported Facebook post_type: ${type}`);
    }

    // media_url is nullable by design — a Facebook feed post may legitimately be text only.
    let url = `${GRAPH_BASE}/${pageId}/feed`;
    let payload: any = { message: caption };

    if (mediaUrl && type === 'image') {
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

        // Step 2: Publish container
        log('info', 'publish.container_publishing', { container_id: containerId });
        const publishUrl = `${GRAPH_BASE}/${instagramId}/media_publish`;

        let publishRes;
        for (let attempt = 0; ; attempt++) {
            try {
                publishRes = await withRetry(
                    () => metaHttp.post(publishUrl, {
                        creation_id: containerId
                    }, {
                        headers: { Authorization: `Bearer ${accessToken}` }
                    }),
                    { retries: 1, baseMs: 750, label: 'ig-media-publish' }
                );
                break; // Success
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

        log('info', 'publish.instagram_success', { ig_media_id: publishRes?.data?.id });
        return publishRes?.data; // returns { id: "media_id" }
    } catch (error: any) {
        // The timeout carries the container id and last known status, which is what lets the
        // caller requeue rather than guess; flattening it into a string Error loses that.
        if (error instanceof MediaProcessingTimeoutError) throw error;

        throw metaFailure('Instagram Publish Failed', error);
    }
}
