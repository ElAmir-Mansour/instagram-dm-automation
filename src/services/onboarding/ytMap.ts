/**
 * What YouTube's answer means to the draft engine (docs/onboarding/03 §1, "YouTube"). Pure: the calls are in
 * `ytSource.ts`; this is the field mapping, the failure classification and the step from a channel to the sources a
 * draft is made from.
 *
 * Two roads give the same `YouTubeChannelData`:
 *   - Not connected: public data, `channels.list?forHandle=` and the uploads playlist, read with the platform's API key.
 *   - Connected: `getMyChannel` already receives the channel's description, country and default language and used to
 *     drop them; `fromMyChannel` keeps them. No video list is read on this road (it would cost quota for little).
 *
 * The channel's picture and thumbnails are never kept (the owner's rule on images).
 */
import type { DraftSource } from './fence.js';
import { sourceError, type SourceError } from './sourceError.js';
import { truncateChars } from './textClean.js';

export interface YouTubeVideo {
    id: string;
    title: string;
    description: string;
    publishedAt: string | null;
}

export interface YouTubeChannelData {
    via: 'api_key' | 'connected';
    id: string;
    title: string;
    /** `@handle`, as YouTube spells it, when the channel has one. */
    handle: string | null;
    description: string;
    /** The channel owner's own keywords, space-separated, as YouTube stores them. */
    keywords: string;
    /** Two-letter country code, when the channel set one. */
    country: string | null;
    defaultLanguage: string | null;
    /** `null` when the channel hides it. */
    subscribers: number | null;
    videoCount: number | null;
    /** Newest first, at most `MAX_VIDEOS`. */
    videos: YouTubeVideo[];
    /** Why the recent videos could not be read, when the channel could (the channel is still a source). */
    videosError: SourceError | null;
}

/** Recent titles read (03 §1: 15, one quota unit for the call). */
export const MAX_VIDEOS = 15;
/** A video's description is a promotion block more often than writing; keep the start of it. */
export const VIDEO_DESCRIPTION_CHARS = 1000;
/** YouTube's placeholders for a video the owner has hidden or removed from a playlist. */
const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set(['private video', 'deleted video']);

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => {
    const s = str(v).trim();
    return s ? s : null;
};
const count = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
    return Number.isFinite(n) ? n : null;
};

/** A channel id as YouTube writes it (`UC` and 22 characters). */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

/** The uploads playlist of a channel: what the API says, or the channel id with `UC` swapped for `UU`, which is how YouTube names it. */
export function uploadsPlaylistId(channel: unknown): string | null {
    if (!isObj(channel)) return null;
    const related = isObj(channel.contentDetails) && isObj(channel.contentDetails.relatedPlaylists) ? channel.contentDetails.relatedPlaylists : null;
    const given = strOrNull(related?.uploads);
    if (given) return given;
    const id = str(channel.id);
    return CHANNEL_ID.test(id) ? `UU${id.slice(2)}` : null;
}

/** The first item of a `channels.list` answer as channel data (without videos), or null when the answer holds no channel. */
export function mapChannelItem(body: unknown): YouTubeChannelData | null {
    const item = isObj(body) && Array.isArray(body.items) ? body.items[0] : undefined;
    if (!isObj(item) || !strOrNull(item.id)) return null;
    const snippet = isObj(item.snippet) ? item.snippet : {};
    const branding = isObj(item.brandingSettings) && isObj(item.brandingSettings.channel) ? item.brandingSettings.channel : {};
    const stats = isObj(item.statistics) ? item.statistics : {};
    const handle = strOrNull(snippet.customUrl);
    return {
        via: 'api_key',
        id: str(item.id),
        title: str(snippet.title).trim(),
        handle: handle ? (handle.startsWith('@') ? handle : `@${handle}`) : null,
        description: str(snippet.description).trim() || str(branding.description).trim(),
        keywords: str(branding.keywords).trim(),
        country: strOrNull(snippet.country) ?? strOrNull(branding.country),
        defaultLanguage: strOrNull(snippet.defaultLanguage) ?? strOrNull(branding.defaultLanguage),
        subscribers: stats.hiddenSubscriberCount === true ? null : count(stats.subscriberCount),
        videoCount: count(stats.videoCount),
        videos: [],
        videosError: null,
    };
}

/** A `playlistItems.list` answer as videos, newest first: placeholders for private or deleted videos and items with no id dropped, at most `MAX_VIDEOS`. */
export function mapPlaylistItems(body: unknown): YouTubeVideo[] {
    const items = isObj(body) && Array.isArray(body.items) ? body.items : [];
    const videos: YouTubeVideo[] = [];
    for (const item of items) {
        const snippet = isObj(item) && isObj(item.snippet) ? item.snippet : null;
        if (!snippet) continue;
        const title = str(snippet.title).trim();
        const id = isObj(snippet.resourceId) ? str(snippet.resourceId.videoId) : '';
        if (!id || !title || PLACEHOLDER_TITLES.has(title.toLowerCase())) continue;
        videos.push({ id, title, description: str(snippet.description).trim(), publishedAt: strOrNull(snippet.publishedAt) });
        if (videos.length >= MAX_VIDEOS) break;
    }
    return videos;
}

/** The pieces of `getMyChannel`'s result the draft reads (a structural type: this module imports nothing that talks to Google). */
export interface MyChannelLike {
    id: string;
    title: string | null;
    handle: string | null;
    description?: string | null;
    country?: string | null;
    defaultLanguage?: string | null;
}

/** The connected road: what `getMyChannel` returned, as channel data. */
export function fromMyChannel(channel: MyChannelLike): YouTubeChannelData {
    const handle = channel.handle?.trim() || null;
    return {
        via: 'connected',
        id: channel.id,
        title: (channel.title ?? '').trim(),
        handle: handle ? (handle.startsWith('@') ? handle : `@${handle}`) : null,
        description: (channel.description ?? '').trim(),
        keywords: '',
        country: channel.country?.trim() || null,
        defaultLanguage: channel.defaultLanguage?.trim() || null,
        subscribers: null,
        videoCount: null,
        videos: [],
        videosError: null,
    };
}

// ─── Failures ───────────────────────────────────────────────────────────────────────────

/** A failed YouTube call, reduced to what the draft decides on. */
export interface YouTubeFailure {
    /** HTTP status, or null when there was no response (a timeout, a reset). */
    status: number | null;
    /** Google's reasons: `errors[].reason` of the Data API and `details[].reason` of the newer envelope. */
    reasons: string[];
    message: string;
}

/** What a failed axios call to Google said. Reads only the response body, status and message: never the request, which holds the key. */
export function youtubeFailureOf(err: unknown): YouTubeFailure {
    const e = err as { response?: { status?: unknown; data?: unknown }; message?: unknown } | null;
    const data = isObj(e?.response?.data) ? (e!.response!.data as Loose) : {};
    const envelope = isObj(data.error) ? data.error : {};
    const reasons: string[] = [];
    for (const list of [envelope.errors, envelope.details]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) if (isObj(entry) && typeof entry.reason === 'string') reasons.push(entry.reason);
    }
    if (typeof data.error === 'string') reasons.push(data.error);
    if (typeof envelope.status === 'string') reasons.push(envelope.status);
    const status = typeof e?.response?.status === 'number' ? e.response.status : null;
    const message = str(envelope.message) || str(data.error_description) || str(e?.message) || 'YouTube request failed';
    return { status, reasons, message };
}

const QUOTA = new Set(['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg']);
const RATE = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RESOURCE_EXHAUSTED']);
const KEY_REJECTED = new Set([
    'keyInvalid', 'keyExpired', 'API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED',
    'ipRefererBlocked', 'accessNotConfigured', 'SERVICE_DISABLED', 'forbidden', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'authError',
]);
const NOT_FOUND = new Set(['channelNotFound', 'playlistNotFound', 'videoNotFound', 'notFound']);

/** A failed YouTube read, as a source error. `secrets` (the API key) are removed from the message. */
export function classifyYouTubeFailure(failure: YouTubeFailure, secrets: readonly (string | null | undefined)[] = []): SourceError {
    const { status, reasons } = failure;
    const has = (set: ReadonlySet<string>): boolean => reasons.some((r) => set.has(r));
    const make = (kind: Parameters<typeof sourceError>[1], message: string): SourceError => sourceError('youtube', kind, message, { http_status: status, secrets });
    const said = failure.message;

    if (has(QUOTA)) return make('quota', `YouTube's daily quota for the platform's API key is used up: ${said}`);
    if (status === 429 || has(RATE)) return make('rate_limited', `YouTube is rate-limiting the platform's API key: ${said}`);
    if (has(KEY_REJECTED) || status === 401) return make('no_access', `YouTube did not accept the platform's API key (or its API is not enabled for it): ${said}`);
    if (has(NOT_FOUND) || status === 404) return make('not_found', `YouTube has no such channel or playlist: ${said}`);
    if (status !== null && status >= 500) return make('upstream', `YouTube failed (HTTP ${status}): ${said}`);
    if (reasons.includes('backendError')) return make('upstream', `YouTube had a temporary problem: ${said}`);
    if (status !== null && status >= 400) return make('bad_request', `YouTube refused the request: ${said}`);
    return make('upstream', `YouTube did not answer: ${said}`);
}

// ─── From a channel to the draft's sources ──────────────────────────────────────────────

/**
 * The sources a channel gives a draft: `yt_about` (the title, the description and the owner's keywords) and, for each recent
 * video, `ytt<n>` (its title) and `ytd<n>` (the start of its description, when it has one worth reading: a few words long).
 * Not cleaned here: `prepareSources` does that for the whole list.
 */
export function youtubeSources(channel: YouTubeChannelData): DraftSource[] {
    const sources: DraftSource[] = [];
    const about = [channel.title, channel.description, channel.keywords].filter((s) => s.trim());
    if (about.length > 0) sources.push({ id: 'yt_about', kind: 'yt_description', text: about.join('\n') });
    channel.videos.forEach((video, i) => {
        const n = i + 1;
        sources.push({ id: `ytt${n}`, kind: 'yt_title', text: video.title });
        const description = truncateChars(video.description.trim(), VIDEO_DESCRIPTION_CHARS);
        if (description.split(/\s+/).length >= 4) sources.push({ id: `ytd${n}`, kind: 'yt_description', text: description });
    });
    return sources;
}
