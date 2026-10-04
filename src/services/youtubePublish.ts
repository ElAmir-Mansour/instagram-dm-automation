/**
 * Publishing a `scheduled_posts` row with `platform = 'youtube'`: one Short.
 *
 *   PENDING ─claim→ PUBLISHING ─upload→ PUBLISHED (`YT:<video id>`)
 *                                  └──→ FAILED
 *
 * Synchronous, unlike TikTok: Google answers the upload with the video's id, and YouTube's own
 * processing afterwards needs nothing from us.
 *
 * The upload is resumable, and its session URL is written to `external_publish_id` (`YTU:…`)
 * before the first byte goes up. A retry — the next sweep after a timeout, or "Publish now" on a
 * FAILED card — asks Google where that session got to first: an upload that finished before the
 * invocation died comes back as its video id instead of a second, duplicate Short.
 *
 * `platform_options` on a YouTube row: `{ title?, privacy?, language? }`. `title` is the Short's
 * title (otherwise the caption's first line); `privacy` applies only once the API audit has passed
 * (Settings → YouTube); before it, every upload is private, because YouTube would lock it so anyway.
 */
import { queryCount } from '../db/query.js';
import type { ScheduledPostRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { isYouTubeAudited } from './appSettings.js';
import { getMediaStore, uploadIdFromUrl } from './storage.js';
import {
    queryUpload, SCOPE_UPLOAD, sendBytes, shortDescription, shortTitle, startResumableUpload, tagsFrom,
    youtubeHttp, type UploadState, type VideoMetadata, type YouTubePrivacy,
} from './youtube.js';
import { getAccessToken, noteYouTubeFailure } from './youtubeConnections.js';

export const YOUTUBE_VIDEO_MIME_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
/** `external_publish_id` while an upload session is open. */
export const UPLOAD_SESSION_PREFIX = 'YTU:';
/** `published_post_id` once it is up. */
export const VIDEO_ID_PREFIX = 'YT:';
const MAX_EXTERNAL_MEDIA_BYTES = 256 * 1024 * 1024;

/** What a YouTube row carries in `platform_options`. */
export interface YouTubePostOptions {
    title?: string;
    privacy?: YouTubePrivacy;
    language?: string;
}

const PRIVACIES: readonly YouTubePrivacy[] = ['public', 'unlisted', 'private'];

/** Read `platform_options` defensively: it is JSON, and a TikTok row's shape is different. */
export function youtubeOptions(raw: unknown): YouTubePostOptions {
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    return {
        ...(typeof r.title === 'string' && r.title.trim() ? { title: r.title.trim() } : {}),
        ...(typeof r.privacy === 'string' && (PRIVACIES as readonly string[]).includes(r.privacy) ? { privacy: r.privacy as YouTubePrivacy } : {}),
        ...(typeof r.language === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(r.language) ? { language: r.language } : {}),
    };
}

/** The privacy an upload asks for: private until the audit has passed, whatever the row says. */
export function uploadPrivacy(options: YouTubePostOptions, audited: boolean): YouTubePrivacy {
    return audited ? (options.privacy ?? 'public') : 'private';
}

/** The note a PUBLISHED row keeps when the Short went up private. Null when it is public. */
export function privacyNote(privacy: YouTubePrivacy, audited: boolean): string | null {
    if (privacy === 'public') return null;
    return audited
        ? `Uploaded to YouTube as ${privacy}.`
        : 'Uploaded to YouTube as private: YouTube keeps uploads from this app private until it passes the YouTube API audit (Settings → YouTube).';
}

export function metadataFor(
    post: Pick<ScheduledPostRow, 'caption'>, options: YouTubePostOptions, privacy: YouTubePrivacy
): VideoMetadata {
    return {
        title: shortTitle(options.title, post.caption),
        description: shortDescription(post.caption),
        tags: tagsFrom(post.caption),
        privacy,
        language: options.language ?? null,
    };
}

export type YouTubePublishTarget = Pick<
    ScheduledPostRow, 'id' | 'creator_id' | 'post_type' | 'caption' | 'media_url' | 'external_publish_id'
> & { platform_options?: unknown };

/** Our uploads straight from the media store; anything else downloaded, within a size cap. */
async function loadVideo(mediaUrl: string): Promise<{ data: Buffer; mimeType: string }> {
    const uploadId = uploadIdFromUrl(mediaUrl);
    if (uploadId) {
        const stored = await (await getMediaStore()).get(uploadId);
        if (!stored) throw new Error('The uploaded video no longer exists — upload it again.');
        return { data: stored.data, mimeType: stored.mimeType };
    }
    const res = await youtubeHttp.get(mediaUrl, {
        responseType: 'arraybuffer', timeout: 60_000, maxContentLength: MAX_EXTERNAL_MEDIA_BYTES,
    });
    const mimeType = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    return { data: Buffer.from(res.data), mimeType };
}

/**
 * Upload one claimed row. Returns 'PUBLISHED'; on failure writes FAILED (keeping an open session,
 * so a retry resumes it) and throws.
 */
export async function publishYouTubePost(post: YouTubePublishTarget): Promise<ScheduledPostRow['status']> {
    let connectionId: string | null = null;
    try {
        if (!post.creator_id) throw new Error('This post has no account.');
        if (post.post_type !== 'video') throw new Error('YouTube posts must be a video (a Short).');
        if (!post.media_url) throw new Error('YouTube needs a video to upload.');

        const { accessToken, connection } = await getAccessToken(post.creator_id);
        connectionId = connection.id;
        if (!(connection.scopes ?? []).includes(SCOPE_UPLOAD)) {
            throw new Error('Google did not grant YouTube upload — reconnect YouTube in Settings and tick “Manage your YouTube videos”.');
        }

        const video = await loadVideo(post.media_url);
        if (!YOUTUBE_VIDEO_MIME_TYPES.has(video.mimeType)) {
            throw new Error(`YouTube takes MP4, MOV or WebM here — this file is ${video.mimeType || 'of unknown type'}.`);
        }
        const audited = await isYouTubeAudited();
        const options = youtubeOptions(post.platform_options);
        const privacy = uploadPrivacy(options, audited);

        // A session an earlier attempt opened: ask before sending anything.
        let state: UploadState | null = null;
        let session = post.external_publish_id?.startsWith(UPLOAD_SESSION_PREFIX)
            ? post.external_publish_id.slice(UPLOAD_SESSION_PREFIX.length) : null;
        if (session) {
            state = await queryUpload(accessToken, session, video.data.length);
            log('info', 'youtube.upload_resume_check', { post_id: post.id, state: state.state });
            if (state.state === 'gone') session = null;
        }
        if (!session) {
            session = await startResumableUpload(accessToken, metadataFor(post, options, privacy), video.data.length, video.mimeType);
            // Before the first byte, so a crash from here on resumes instead of uploading twice.
            await queryCount(`UPDATE scheduled_posts SET external_publish_id = $2 WHERE id = $1`, [post.id, UPLOAD_SESSION_PREFIX + session]);
            state = { state: 'partial', received: 0 };
            log('info', 'youtube.upload_started', { post_id: post.id, bytes: video.data.length, privacy });
        }

        // One retry from wherever Google says it got to, then give up until the next attempt.
        for (let i = 0; i < 2 && state!.state === 'partial'; i++) {
            const from = (state as { received: number }).received;
            state = await sendBytes(accessToken, session, video.data, video.mimeType, from);
        }
        if (state!.state !== 'done') {
            throw new Error('The YouTube upload did not finish — retry it, and it resumes where it stopped.');
        }

        const videoId = state!.videoId;
        await queryCount(
            `UPDATE scheduled_posts
                SET status = 'PUBLISHED', published_post_id = $2, external_publish_id = NULL, error_log = $3
              WHERE id = $1`,
            [post.id, VIDEO_ID_PREFIX + videoId, privacyNote(privacy, audited)]
        );
        log('info', 'youtube.published', { post_id: post.id, video_id: videoId, privacy });
        return 'PUBLISHED';
    } catch (err: any) {
        await noteYouTubeFailure(connectionId, err);
        log('error', 'youtube.publish_failed', { post_id: post.id, ...describeError(err) });
        await queryCount(
            `UPDATE scheduled_posts SET status = 'FAILED', error_log = $2
              WHERE id = $1 AND status IN ('PUBLISHING', 'PENDING')`,
            [post.id, String(err?.message ?? err).slice(0, 2000)]
        );
        throw err;
    }
}
