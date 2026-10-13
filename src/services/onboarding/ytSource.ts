/**
 * Reading a creator's public YouTube channel for the draft (docs/onboarding/03 §1, "YouTube"): handle to channel to recent
 * titles and descriptions. Not pure: it talks to Google. The mapping, the failure classification and the step to sources are
 * in `ytMap.ts`.
 *
 *   - `channels.list?part=snippet,brandingSettings,contentDetails,statistics&forHandle=@h`, then `playlistItems.list` on the
 *     uploads playlist for the 15 newest. One quota unit each, whatever the parts: two units for a draft, of the 10,000 a day.
 *   - It uses an API KEY, not the OAuth app: the tenant has not connected YouTube yet at creation, so there is no token
 *     to use. The key is the setting `youtube.api_key` (`YOUTUBE_API_KEY` as the fallback). With none saved the source is
 *     SKIPPED, not failed: `not_configured`, which the draft records as "unavailable" and carries on without.
 *   - A tenant who has connected YouTube is read through `getMyChannel` instead (`fromMyChannel` in `ytMap.ts`), which
 *     already receives the description, country and language.
 *
 * The key goes in the query string (that is how the Data API takes it), so an axios error, which holds the request, holds
 * the key. Nothing here returns or logs one: a failure is reduced to Google's status and reasons and its message, and the
 * message is scrubbed of the key. No retry happens in here; `retryable` on the error says whether the caller may.
 */
import type { AxiosInstance } from 'axios';
import { describeError, log } from '../../utils/log.js';
import { getYouTubeApiKey } from '../appSettings.js';
import { youtubeHttp, YOUTUBE_API_BASE } from '../youtube.js';
import { parseYouTubeRef, type YouTubeRef } from './handles.js';
import { sourceFail, sourceOk, type SourceError, type SourceResult } from './sourceError.js';
import {
    classifyYouTubeFailure, mapChannelItem, mapPlaylistItems, MAX_VIDEOS, uploadsPlaylistId, youtubeFailureOf,
    type YouTubeChannelData,
} from './ytMap.js';

/** Per request: the draft's whole fetch phase is 25 s (03 §1), shared by every source. */
export const YOUTUBE_TIMEOUT_MS = 8_000;

export interface YouTubeSourceDeps {
    /** The HTTP client (tests). */
    http?: Pick<AxiosInstance, 'get'>;
    /** Where the key comes from (tests); by default the saved setting, then the environment. */
    getKey?: () => Promise<{ key: string } | null>;
    /** The draft's phase deadline: aborts a request still in flight. */
    signal?: AbortSignal;
}

const channelParams = (ref: YouTubeRef): Record<string, string> => {
    const base = { part: 'snippet,brandingSettings,contentDetails,statistics' };
    if (ref.kind === 'handle') return { ...base, forHandle: `@${ref.value}` };
    if (ref.kind === 'channel_id') return { ...base, id: ref.value };
    return { ...base, forUsername: ref.value };
};

/**
 * A channel's public data and its 15 newest uploads, by handle (or link, or channel id). Failures: `invalid_handle` before any
 * request; `not_configured` with no key (the source is skipped); `not_found` when no channel has that handle; `no_access` for a
 * key Google rejects (invalid, expired, restricted, or the API not enabled for its project); `quota` for the daily limit;
 * `rate_limited` and `upstream` are retryable. The videos are best effort: a channel that reads but whose uploads do not
 * is still a source, with `videosError` saying why.
 */
export async function fetchYouTubeChannel(typedRef: string, deps: YouTubeSourceDeps = {}): Promise<SourceResult<YouTubeChannelData>> {
    const ref = parseYouTubeRef(typedRef);
    if (!ref) return sourceFail('youtube', 'invalid_handle', 'That is not a YouTube handle or channel link.');

    let keyHolder: { key: string } | null;
    try {
        keyHolder = await (deps.getKey ?? getYouTubeApiKey)();
    } catch (err) {
        // The settings table could not be read: that is the platform's trouble, and it may pass.
        log('warn', 'onboarding.yt_key_unreadable', describeError(err));
        return sourceFail('youtube', 'upstream', 'The platform\'s YouTube API key could not be read.');
    }
    if (!keyHolder?.key) {
        log('info', 'onboarding.yt_source_skipped', { reason: 'no_api_key' });
        return sourceFail('youtube', 'not_configured', 'YouTube is unavailable: no API key is saved (Settings → YouTube, or YOUTUBE_API_KEY).');
    }
    const key = keyHolder.key;
    const http = deps.http ?? youtubeHttp;
    const started = Date.now();

    const get = async (path: string, params: Record<string, string | number>): Promise<{ ok: true; body: unknown } | { ok: false; error: SourceError }> => {
        try {
            const res = await http.get(`${YOUTUBE_API_BASE}/${path}`, { params: { ...params, key }, timeout: YOUTUBE_TIMEOUT_MS, signal: deps.signal });
            return { ok: true, body: res.data };
        } catch (err) {
            return { ok: false, error: classifyYouTubeFailure(youtubeFailureOf(err), [key]) };
        }
    };

    const found = await get('channels', channelParams(ref));
    if (!found.ok) return done(started, { ok: false, error: found.error });
    const channel = mapChannelItem(found.body);
    if (!channel) {
        // A handle nobody has answers 200 with no `items`.
        return done(started, sourceFail('youtube', 'not_found', 'YouTube has no channel with that handle.', { http_status: 200 }));
    }

    const playlist = uploadsPlaylistId((found.body as { items?: unknown[] }).items?.[0]);
    if (playlist) {
        const uploads = await get('playlistItems', { part: 'snippet', playlistId: playlist, maxResults: MAX_VIDEOS });
        if (uploads.ok) channel.videos = mapPlaylistItems(uploads.body);
        // A brand-new channel has an uploads playlist that does not exist yet: no videos, not a problem.
        else if (uploads.error.kind !== 'not_found') channel.videosError = uploads.error;
    }
    return done(started, sourceOk(channel));
}

/** One log line per read, with no key in it, and the result passed through. */
function done(started: number, result: SourceResult<YouTubeChannelData>): SourceResult<YouTubeChannelData> {
    try {
        const fields = { ms: Date.now() - started };
        if (result.ok) {
            log('info', 'onboarding.yt_source', { ...fields, videos: result.value.videos.length, videos_error: result.value.videosError?.kind ?? null });
        } else {
            log(result.error.kind === 'upstream' || result.error.kind === 'rate_limited' ? 'warn' : 'info', 'onboarding.yt_source_failed',
                { ...fields, kind: result.error.kind, retryable: result.error.retryable, http_status: result.error.http_status, message: result.error.message });
        }
    } catch (err) {
        log('warn', 'onboarding.yt_source_log_failed', describeError(err));
    }
    return result;
}
