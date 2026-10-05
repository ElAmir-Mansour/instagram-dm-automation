/**
 * YouTube: every call to Google's OAuth endpoints and the YouTube Data API v3, and the pure rules
 * around them. Tokens are stored by youtubeConnections.ts; the post lifecycle is youtubePublish.ts.
 *
 * ── What the API allows ──
 * A Short is an ordinary `videos.insert` of a vertical video of up to three minutes; there is no
 * Shorts flag. YouTube may keep an unaudited project's uploads private whatever `privacyStatus`
 * asks for; this owner's were not, so Settings → "Upload Shorts as public" decides what is asked,
 * and the privacy YouTube reports back is what the row records. One `videos.insert` costs 1,600 of
 * the default 10,000 quota units a day, and a thumbnail 50: six Shorts a day.
 *
 * ── Tokens ──
 * Google access tokens last an hour. The refresh token does not expire for an app in production
 * (it dies when the user removes access, or after six months unused) — but for an app still in
 * Testing it lasts 7 days, and Google then says so in `refresh_token_expires_in`, which is stored
 * so Settings can warn. Unlike TikTok's, a Google refresh token is not rotated by a refresh.
 */
import axios from 'axios';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';

export const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
/** Only for `channels.list?mine=true`: the name and picture of the channel Settings shows. */
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
export const YOUTUBE_SCOPES = [SCOPE_UPLOAD, SCOPE_READONLY] as const;

/** YouTube's "Education" category: every video this app uploads is a lesson clip. */
export const EDUCATION_CATEGORY_ID = '27';
export const MAX_TITLE_CHARS = 100;
export const MAX_DESCRIPTION_BYTES = 5000;
export const MAX_TAGS_CHARS = 500;
export const SHORTS_TAG = '#Shorts';

export const youtubeHttp = axios.create({ timeout: 30_000 });
/** The video PUT: a 40MB reel from a serverless function, with room to spare. */
const UPLOAD_TIMEOUT_MS = 240_000;

// ─── Errors ─────────────────────────────────────────────────────────────────────────────

/**
 * A refusal from Google, with its machine-readable reason kept: `invalid_grant` from the token
 * endpoint, or the Data API's `errors[0].reason` (`quotaExceeded`, `uploadLimitExceeded`…).
 */
export class YouTubeApiError extends Error {
    readonly reason: string;
    readonly httpStatus: number | undefined;

    constructor(message: string, reason: string, httpStatus?: number) {
        super(message);
        this.name = 'YouTubeApiError';
        this.reason = reason;
        this.httpStatus = httpStatus;
    }
}

/** The connection itself is dead, or was never allowed to do this: the owner must reconnect. */
const REAUTH_REASONS = new Set([
    'invalid_grant', 'unauthorized_client', 'authError', 'unauthorized', 'insufficientPermissions',
    'youtubeSignupRequired',
]);

export function isYouTubeReauthError(err: unknown): boolean {
    return err instanceof YouTubeApiError && (REAUTH_REASONS.has(err.reason) || err.httpStatus === 401);
}

const REASON_MESSAGES: Record<string, string> = {
    invalid_grant: 'Google refused the saved login (access was removed, or it expired) — reconnect YouTube in Settings.',
    unauthorized_client: 'Google refused this app’s client ID for that login — check the YouTube app settings, then reconnect.',
    invalid_client: 'Google refused the client ID or secret — check them in Settings → YouTube.',
    redirect_uri_mismatch: 'The redirect URI is not registered on the Google OAuth client — add the one Settings shows.',
    authError: 'The YouTube connection is no longer valid — reconnect YouTube in Settings.',
    unauthorized: 'The YouTube connection is no longer valid — reconnect YouTube in Settings.',
    insufficientPermissions: 'YouTube upload was not allowed when you connected — reconnect and tick “Manage your YouTube videos”.',
    youtubeSignupRequired: 'This Google account has no YouTube channel — create one on youtube.com, then reconnect.',
    quotaExceeded: 'The YouTube API’s daily quota is used up (about six uploads a day) — it is retried after midnight Pacific time.',
    uploadLimitExceeded: 'YouTube’s upload limit for this channel is reached for today — retry tomorrow.',
    rateLimitExceeded: 'YouTube is rate-limiting this app — it will be retried.',
    invalidTitle: 'YouTube refused the title (at most 100 characters, no < or >).',
    invalidDescription: 'YouTube refused the description (at most 5,000 bytes, no < or >).',
    invalidTags: 'YouTube refused the tags.',
    channelClosed: 'This YouTube channel is closed.',
    channelSuspended: 'This YouTube channel is suspended.',
};

/** Reasons where the post itself is not at fault: the next sweep may try again. */
export const RETRYABLE_REASONS: ReadonlySet<string> = new Set(['quotaExceeded', 'rateLimitExceeded', 'backendError']);

/** Pull a Google error out of an axios failure (OAuth's `{error, error_description}` or the API's `{error: {errors}}`). */
export function toYouTubeError(context: string, err: any): YouTubeApiError | Error {
    if (err instanceof YouTubeApiError) return err;
    const data = err?.response?.data;
    const status: number | undefined = err?.response?.status;
    // OAuth endpoints: { error: "invalid_grant", error_description }
    if (typeof data?.error === 'string') {
        const reason = data.error;
        return new YouTubeApiError(`${context}: ${REASON_MESSAGES[reason] ?? data.error_description ?? reason}`, reason, status);
    }
    // Data API: { error: { code, message, errors: [{ reason, message }] } }
    const envelope = data?.error;
    if (envelope && typeof envelope === 'object') {
        const reason = String(envelope.errors?.[0]?.reason ?? envelope.status ?? 'unknown');
        return new YouTubeApiError(`${context}: ${REASON_MESSAGES[reason] ?? envelope.message ?? reason}`, reason, status);
    }
    const detail = err?.message ?? String(err);
    return new Error(`${context}: ${status ? `HTTP ${status} — ` : ''}${detail}`);
}

// ─── OAuth ──────────────────────────────────────────────────────────────────────────────

/**
 * Google's consent URL. `access_type=offline` + `prompt=consent` make Google hand over a refresh
 * token every time, reconnects included — without `prompt` a second consent returns none.
 */
export function buildAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        response_type: 'code',
        scope: YOUTUBE_SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
        state: input.state,
    });
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

export interface GoogleTokenSet {
    accessToken: string;
    /** Absent on a refresh: Google keeps the one it gave at consent. */
    refreshToken: string | null;
    scopes: string[];
    accessExpiresAt: Date;
    /** Only an app in Testing gets one (7 days); null means it does not expire. */
    refreshExpiresAt: Date | null;
}

export function parseTokenResponse(body: any, now: number): GoogleTokenSet {
    if (!body?.access_token) throw toYouTubeError('Google token', { response: { data: body } });
    const refreshIn = Number(body.refresh_token_expires_in);
    return {
        accessToken: String(body.access_token),
        refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
        scopes: String(body.scope ?? '').split(/\s+/).filter(Boolean),
        accessExpiresAt: new Date(now + Number(body.expires_in ?? 3600) * 1000),
        refreshExpiresAt: Number.isFinite(refreshIn) && refreshIn > 0 ? new Date(now + refreshIn * 1000) : null,
    };
}

async function postToken(form: Record<string, string>, context: string): Promise<any> {
    try {
        const res = await youtubeHttp.post(GOOGLE_TOKEN_URL, new URLSearchParams(form).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        return res.data;
    } catch (err) {
        throw toYouTubeError(context, err);
    }
}

/** Trade the code for tokens. Not retried: a code is single-use. */
export async function exchangeCode(
    input: { clientId: string; clientSecret: string; code: string; redirectUri: string },
    now: () => number = Date.now
): Promise<GoogleTokenSet> {
    const body = await postToken({
        client_id: input.clientId, client_secret: input.clientSecret, code: input.code,
        grant_type: 'authorization_code', redirect_uri: input.redirectUri,
    }, 'Google token exchange');
    return parseTokenResponse(body, now());
}

export async function refreshAccessToken(
    input: { clientId: string; clientSecret: string; refreshToken: string },
    now: () => number = Date.now
): Promise<GoogleTokenSet> {
    const body = await postToken({
        client_id: input.clientId, client_secret: input.clientSecret,
        grant_type: 'refresh_token', refresh_token: input.refreshToken,
    }, 'Google token refresh');
    return parseTokenResponse(body, now());
}

/** Revoking either token removes the app from the Google account. */
export async function revokeToken(token: string): Promise<void> {
    try {
        await youtubeHttp.post(GOOGLE_REVOKE_URL, new URLSearchParams({ token }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
    } catch (err) {
        throw toYouTubeError('Google revoke', err);
    }
}

// ─── The channel ────────────────────────────────────────────────────────────────────────

export interface YouTubeChannel {
    id: string;
    title: string | null;
    /** `@handle`, when the channel has one. */
    handle: string | null;
    thumbnailUrl: string | null;
}

/** The channel the token belongs to. Throws `youtubeSignupRequired` when the account has none. */
export async function getMyChannel(accessToken: string): Promise<YouTubeChannel> {
    let data: any;
    try {
        const res = await youtubeHttp.get(`${YOUTUBE_API_BASE}/channels`, {
            params: { part: 'snippet', mine: 'true' },
            headers: { Authorization: `Bearer ${accessToken}` },
        });
        data = res.data;
    } catch (err) {
        throw toYouTubeError('YouTube channel', err);
    }
    const item = Array.isArray(data?.items) ? data.items[0] : null;
    if (!item?.id) {
        throw new YouTubeApiError(`YouTube channel: ${REASON_MESSAGES.youtubeSignupRequired}`, 'youtubeSignupRequired');
    }
    const thumbs = item.snippet?.thumbnails ?? {};
    return {
        id: String(item.id),
        title: item.snippet?.title ?? null,
        handle: item.snippet?.customUrl ?? null,
        thumbnailUrl: thumbs.default?.url ?? thumbs.medium?.url ?? null,
    };
}

// ─── Titles and descriptions ────────────────────────────────────────────────────────────

/** `<` and `>` are the two characters YouTube refuses in a title or description. */
const stripAngles = (s: string) => s.replace(/[<>]/g, '');

/** Cut to at most `max` characters (code points, as YouTube counts), on a word boundary when one is near. */
export function cutChars(text: string, max: number): string {
    const chars = [...text];
    if (chars.length <= max) return text;
    const cut = chars.slice(0, max).join('');
    const space = cut.lastIndexOf(' ');
    return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

/**
 * A Short's title: the reel's hook (or the caption's first line), without `<>`, with `#Shorts`
 * appended when it fits in YouTube's 100 characters.
 */
export function shortTitle(title: string | null | undefined, caption: string | null | undefined): string {
    const base = stripAngles((title ?? '').trim() || (caption ?? '').split('\n').map((l) => l.trim()).find(Boolean) || 'Short')
        .replace(/\s+/g, ' ').trim();
    if (/#shorts\b/i.test(base)) return cutChars(base, MAX_TITLE_CHARS);
    const withTag = `${base} ${SHORTS_TAG}`;
    return [...withTag].length <= MAX_TITLE_CHARS ? withTag : cutChars(base, MAX_TITLE_CHARS);
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
export function cutBytes(text: string, max: number): string {
    if (Buffer.byteLength(text, 'utf8') <= max) return text;
    let out = '';
    for (const ch of text) {
        if (Buffer.byteLength(out + ch, 'utf8') > max) break;
        out += ch;
    }
    return out;
}

/** The description: the caption without `<>`, `#Shorts` ensured, within 5,000 bytes. */
export function shortDescription(caption: string | null | undefined): string {
    let text = stripAngles(caption ?? '').trim();
    if (!/#shorts\b/i.test(text)) text = text ? `${text}\n\n${SHORTS_TAG}` : SHORTS_TAG;
    return cutBytes(text, MAX_DESCRIPTION_BYTES);
}

/** Hashtags in the caption, as tags (without `#`), within YouTube's 500-character budget. */
export function tagsFrom(caption: string | null | undefined): string[] {
    const found = (caption ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? [];
    const tags: string[] = [];
    let used = 0;
    for (const t of found.map((h) => h.slice(1))) {
        if (!t || tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
        const cost = t.length + (tags.length ? 1 : 0) + (t.includes(' ') ? 2 : 0);
        if (used + cost > MAX_TAGS_CHARS) break;
        tags.push(t);
        used += cost;
    }
    return tags;
}

// ─── Uploading ──────────────────────────────────────────────────────────────────────────

export type YouTubePrivacy = 'public' | 'unlisted' | 'private';

export interface VideoMetadata {
    title: string;
    description: string;
    tags: string[];
    privacy: YouTubePrivacy;
    /** BCP-47, e.g. `ar`; sets the video's and its audio's language. */
    language?: string | null;
}

export function videoResource(meta: VideoMetadata): Record<string, unknown> {
    return {
        snippet: {
            title: meta.title,
            description: meta.description,
            ...(meta.tags.length ? { tags: meta.tags } : {}),
            categoryId: EDUCATION_CATEGORY_ID,
            ...(meta.language ? { defaultLanguage: meta.language, defaultAudioLanguage: meta.language } : {}),
        },
        // Made-for-kids must be declared on every upload; these are adult lessons.
        status: { privacyStatus: meta.privacy, selfDeclaredMadeForKids: false, embeddable: true },
    };
}

/**
 * Open a resumable upload session. Returns its URL, which is good for a week: the caller stores
 * it before sending a byte, so a retry asks where the upload got to instead of starting over.
 */
export async function startResumableUpload(
    accessToken: string, meta: VideoMetadata, size: number, mimeType: string
): Promise<string> {
    try {
        const res = await youtubeHttp.post(YOUTUBE_UPLOAD_URL, videoResource(meta), {
            params: { uploadType: 'resumable', part: 'snippet,status' },
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json; charset=UTF-8',
                'X-Upload-Content-Length': String(size),
                'X-Upload-Content-Type': mimeType,
            },
        });
        const location = res.headers?.location;
        if (typeof location !== 'string' || !location.startsWith('https://')) {
            throw new Error('Google opened no upload session (no Location header).');
        }
        return location;
    } catch (err) {
        throw toYouTubeError('YouTube upload start', err);
    }
}

/** Where a session is: finished (with the video id), part-way (bytes Google holds), or gone. */
export type UploadState =
    /** `privacy`: what YouTube says the video is, which may not be what was asked. */
    | { state: 'done'; videoId: string; privacy?: string | null }
    | { state: 'partial'; received: number }
    | { state: 'gone' };

/** `Range: bytes=0-1234` → 1235 bytes held. No header means none. */
export function receivedFromRange(range: unknown): number {
    const m = typeof range === 'string' ? /bytes=0-(\d+)/.exec(range) : null;
    return m ? Number(m[1]) + 1 : 0;
}

function settle(res: { status: number; data: any; headers: any }, context: string): UploadState {
    if (res.status === 200 || res.status === 201) {
        const id = res.data?.id;
        if (typeof id !== 'string' || !id) throw new Error(`${context}: Google finished the upload but returned no video id.`);
        return { state: 'done', videoId: id, privacy: typeof res.data?.status?.privacyStatus === 'string' ? res.data.status.privacyStatus : null };
    }
    if (res.status === 308) return { state: 'partial', received: receivedFromRange(res.headers?.range) };
    if (res.status === 404 || res.status === 410) return { state: 'gone' };
    throw toYouTubeError(context, { response: res });
}

const SESSION_REQUEST = {
    // 308 is "resume incomplete" here, not a redirect, and carries no Location to follow.
    maxRedirects: 0,
    validateStatus: (s: number) => (s >= 200 && s < 300) || s === 308 || s === 404 || s === 410,
};

/** Ask a session how far it got (an empty PUT with `Content-Range: bytes *\/size`). */
export async function queryUpload(accessToken: string, sessionUrl: string, size: number): Promise<UploadState> {
    try {
        const res = await youtubeHttp.put(sessionUrl, Buffer.alloc(0), {
            ...SESSION_REQUEST,
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Length': '0', 'Content-Range': `bytes */${size}` },
        });
        return settle(res, 'YouTube upload status');
    } catch (err) {
        throw toYouTubeError('YouTube upload status', err);
    }
}

/** Send the bytes from `from` to the end. Resolves to where the session stands after. */
export async function sendBytes(
    accessToken: string, sessionUrl: string, data: Buffer, mimeType: string, from = 0
): Promise<UploadState> {
    const size = data.length;
    const body = from > 0 ? data.subarray(from) : data;
    try {
        const res = await youtubeHttp.put(sessionUrl, body, {
            ...SESSION_REQUEST,
            timeout: UPLOAD_TIMEOUT_MS,
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': mimeType,
                'Content-Length': String(body.length),
                ...(from > 0 ? { 'Content-Range': `bytes ${from}-${size - 1}/${size}` } : {}),
            },
        });
        return settle(res, 'YouTube upload');
    } catch (err) {
        throw toYouTubeError('YouTube upload', err);
    }
}

export const YOUTUBE_THUMBNAIL_URL = 'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
/** YouTube's limit for a custom thumbnail. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const THUMBNAIL_MIME_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png']);

/**
 * Set a video's thumbnail (the reel's cover). Needs a channel YouTube has verified for custom
 * thumbnails; a refusal is the caller's to note, never a reason to fail the upload it follows.
 */
export async function setThumbnail(accessToken: string, videoId: string, data: Buffer, mimeType: string): Promise<void> {
    try {
        await youtubeHttp.post(YOUTUBE_THUMBNAIL_URL, data, {
            params: { videoId, uploadType: 'media' },
            maxBodyLength: Infinity,
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeType, 'Content-Length': String(data.length) },
        });
    } catch (err) {
        throw toYouTubeError('YouTube thumbnail', err);
    }
}

/** The public link to a Short. */
export const shortUrl = (videoId: string) => `https://www.youtube.com/shorts/${encodeURIComponent(videoId)}`;
