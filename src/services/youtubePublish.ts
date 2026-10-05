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
 * title (otherwise the caption's first line); `privacy` applies only while Settings → YouTube →
 * "Upload Shorts as public" is on; with it off, every upload is private. The row's `cover_url`
 * becomes the video's thumbnail.
 */
import { queryCount } from '../db/query.js';
import type { ScheduledPostRow } from '../db/rows.js';
import { describeError, log } from '../utils/log.js';
import { youtubeUploadsPublic } from './appSettings.js';
import { getMediaStore, uploadIdFromUrl } from './storage.js';
import {
    MAX_THUMBNAIL_BYTES, queryUpload, SCOPE_UPLOAD, sendBytes, setThumbnail, shortDescription, shortTitle, startResumableUpload,
    tagsFrom, THUMBNAIL_MIME_TYPES, youtubeHttp, type UploadState, type VideoMetadata, type YouTubePrivacy,
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

/** The privacy an upload asks for: the row's choice (public by default) with public uploads on; private with it off. */
export function uploadPrivacy(options: YouTubePostOptions, publicOn: boolean): YouTubePrivacy {
    return publicOn ? (options.privacy ?? 'public') : 'private';
}

/**
 * The note a PUBLISHED row keeps about its visibility: null when it went out public. `actual` is
 * what YouTube reported, which wins over what was asked.
 */
export function privacyNote(asked: YouTubePrivacy, actual: string | null | undefined, publicOn: boolean): string | null {
    const is = actual || asked;
    if (is === 'public') return null;
    if (asked === 'public') return `YouTube kept this upload ${is} — make it public in YouTube Studio.`;
    return publicOn ? `Uploaded to YouTube as ${is}.` : `Uploaded to YouTube as ${is} (Settings → YouTube → "Upload Shorts as public" is off).`;
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
> & { platform_options?: unknown; cover_url?: string | null };

/** Our uploads straight from the media store; anything else downloaded, within a size cap. */
async function loadMedia(mediaUrl: string): Promise<{ data: Buffer; mimeType: string }> {
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

/** Set the cover as the thumbnail. Returns a note when it could not be, null when it was (or there is no cover). */
async function applyThumbnail(accessToken: string, videoId: string, coverUrl: string | null): Promise<string | null> {
    if (!coverUrl) return null;
    try {
        const cover = await loadMedia(coverUrl);
        if (!THUMBNAIL_MIME_TYPES.has(cover.mimeType)) return `Thumbnail not set: the cover is ${cover.mimeType || 'of unknown type'}, not JPEG or PNG.`;
        if (cover.data.length > MAX_THUMBNAIL_BYTES) return 'Thumbnail not set: the cover is over YouTube\'s 2 MB limit.';
        await setThumbnail(accessToken, videoId, cover.data, cover.mimeType);
        return null;
    } catch (err) {
        log('warn', 'youtube.thumbnail_failed', { video_id: videoId, ...describeError(err) });
        return `Thumbnail not set: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
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

        const video = await loadMedia(post.media_url);
        if (!YOUTUBE_VIDEO_MIME_TYPES.has(video.mimeType)) {
            throw new Error(`YouTube takes MP4, MOV or WebM here — this file is ${video.mimeType || 'of unknown type'}.`);
        }
        const publicOn = await youtubeUploadsPublic();
        const options = youtubeOptions(post.platform_options);
        const privacy = uploadPrivacy(options, publicOn);

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
        const actual = (state as { privacy?: string | null }).privacy ?? null;
        // The cover as the thumbnail. A refusal (a channel not verified for custom thumbnails, say)
        // is noted on the row; the Short is up either way.
        const thumbnail = await applyThumbnail(accessToken, videoId, post.cover_url ?? null);
        const notes = [privacyNote(privacy, actual, publicOn), thumbnail].filter(Boolean).join(' ');
        await queryCount(
            `UPDATE scheduled_posts
                SET status = 'PUBLISHED', published_post_id = $2, external_publish_id = NULL, error_log = $3
              WHERE id = $1`,
            [post.id, VIDEO_ID_PREFIX + videoId, notes || null]
        );
        log('info', 'youtube.published', { post_id: post.id, video_id: videoId, asked: privacy, privacy: actual, thumbnail: thumbnail ?? 'set' });
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
