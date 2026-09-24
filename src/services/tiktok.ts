/**
 * Every TikTok API call, and the pure rules around them.
 *
 * The counterpart of `instagram.ts` for TikTok's Login Kit and Content Posting API. Nothing
 * here touches the database — connection state lives in `tiktokConnections.ts` and the
 * publish lifecycle in `tiktokPublish.ts` — so every request shape and every rule (chunk
 * planning, webhook signatures, error classification) can be tested against a stubbed client.
 *
 * ── Which posting mode, and why ──
 * Inbox ("upload") mode, scope `video.upload`: the video lands in the creator's TikTok inbox
 * and they finish the post in TikTok's editor. Direct Post (`video.publish`) is the fully
 * automatic path, but until TikTok audits an app every post is forced to SELF_ONLY on a
 * private account, and the audit guidelines reject tools that post to your own accounts. So
 * inbox mode is what a single-account deployment can actually use. Researched 2026-09-23.
 *
 * ── Why FILE_UPLOAD rather than PULL_FROM_URL ──
 * PULL_FROM_URL needs the media URL's domain or prefix verified in TikTok's portal, and would
 * have TikTok fetch through `/api/uploads/:id`, whose response Vercel caps at 4.5MB. Pushing
 * the bytes ourselves is an outbound request: no verification, no response cap.
 *
 * @see https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 * @see https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 * @see https://developers.tiktok.com/doc/oauth-user-access-token-management
 */
import axios from 'axios';
import crypto from 'crypto';
import { withRetry } from './http.js';

export const TIKTOK_AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
export const TIKTOK_API_BASE = 'https://open.tiktokapis.com';

/**
 * The scopes requested at connect time. `user.info.basic` names the account on the Settings
 * card; `video.upload` is inbox posting. `video.publish` joins this list only when the app has
 * passed TikTok's Direct Post audit — requesting a scope the app is not approved for fails the
 * whole authorisation.
 */
export const TIKTOK_SCOPES = ['user.info.basic', 'video.upload'] as const;

/**
 * The scopes to request.
 *
 *   - Direct Post off:                 user.info.basic + video.upload (inbox drafts only)
 *   - Direct Post on, app NOT audited: all three. Until TikTok approves the app a direct post is
 *     private (SELF_ONLY) and needs a private account, so the creator chooses per post between
 *     that and a draft in their inbox — which needs `video.upload`.
 *   - Direct Post on, app audited:     user.info.basic + video.publish. Posts go out public, and
 *     a scope the app no longer uses has no business being requested.
 */
export function tiktokScopes(directPostEnabled: boolean, audited = false): string[] {
    if (!directPostEnabled) return [...TIKTOK_SCOPES];
    return audited ? ['user.info.basic', 'video.publish'] : [...TIKTOK_SCOPES, 'video.publish'];
}

/**
 * Separate from `metaHttp` on purpose: a 10s timeout is right for a Graph call and wrong for
 * pushing a video, and TikTok's error envelope has nothing in common with Meta's.
 */
export const tiktokHttp = axios.create({ timeout: 30_000 });

/** Upload PUTs get far longer — a chunk can be 64MB. */
const UPLOAD_TIMEOUT_MS = 120_000;

// ─── Errors ─────────────────────────────────────────────────────────────────────────────

/**
 * A TikTok API refusal, with the machine-readable code kept.
 *
 * TikTok codes are strings (`access_token_invalid`, `rate_limit_exceeded`,
 * `spam_risk_too_many_pending_share`), unlike Meta's numbers, and a successful response
 * carries `error.code = "ok"` — so "has an error object" does not mean "failed".
 */
export class TikTokApiError extends Error {
    readonly code: string;
    readonly httpStatus: number | undefined;
    readonly logId: string | undefined;

    constructor(message: string, code: string, httpStatus?: number, logId?: string) {
        super(message);
        this.name = 'TikTokApiError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.logId = logId;
    }
}

/**
 * Codes that mean the connection itself is dead and the creator must reconnect, as opposed to
 * one request being wrong. `invalid_grant` is the OAuth endpoint's answer to a refresh token
 * that has expired or been revoked.
 */
const REAUTH_CODES = new Set([
    'access_token_invalid',
    'invalid_grant',
    'scope_not_authorized',
    'scope_permission_missed',
]);

export function isTikTokReauthError(err: unknown): boolean {
    return err instanceof TikTokApiError && REAUTH_CODES.has(err.code);
}

/** Plain-language versions of the codes an operator will actually meet. */
const CODE_MESSAGES: Record<string, string> = {
    access_token_invalid: 'The TikTok connection has expired or was revoked — reconnect TikTok in Settings.',
    invalid_grant: 'TikTok refused the saved login — reconnect TikTok in Settings.',
    scope_not_authorized: 'TikTok did not grant the upload permission — reconnect TikTok and allow video upload.',
    scope_permission_missed: 'TikTok did not grant the upload permission — reconnect TikTok and allow video upload.',
    rate_limit_exceeded: 'TikTok rate limit reached — it will be retried.',
    spam_risk_too_many_pending_share:
        'TikTok allows only 5 unposted inbox drafts per 24 hours. Post or delete the drafts waiting in your TikTok inbox, then retry.',
    spam_risk_too_many_posts: 'TikTok’s daily posting limit for this account has been reached. Retry tomorrow.',
    spam_risk_user_banned_from_posting: 'TikTok has blocked this account from posting.',
    reached_active_user_cap: 'This TikTok app has reached its daily active-user cap. Retry later.',
    unaudited_client_can_only_post_to_private_accounts:
        'Until TikTok approves this app, direct posts only work when your TikTok account is set to private. Switch the account to private (TikTok → Settings → Privacy), then retry.',
    privacy_level_option_mismatch:
        'That privacy choice is not available for this TikTok account any more — edit the post and choose again.',
    file_format_check_failed: 'TikTok rejected the file format — upload an MP4 (H.264).',
    invalid_file_upload: 'TikTok rejected the uploaded file.',
};

/** Pull a TikTok error out of an axios failure or a 200 whose envelope says otherwise. */
export function toTikTokError(context: string, err: any): TikTokApiError | Error {
    if (err instanceof TikTokApiError) return err;
    const data = err?.response?.data;
    const status: number | undefined = err?.response?.status;

    // v2 API envelope: { error: { code, message, log_id } }
    const envelope = data?.error;
    if (envelope && typeof envelope === 'object' && typeof envelope.code === 'string') {
        const code = envelope.code;
        const friendly = CODE_MESSAGES[code];
        return new TikTokApiError(
            `${context}: ${friendly ?? envelope.message ?? code}`, code, status, envelope.log_id
        );
    }
    // OAuth endpoints: { error: "invalid_grant", error_description, log_id }
    if (typeof envelope === 'string') {
        const friendly = CODE_MESSAGES[envelope];
        return new TikTokApiError(
            `${context}: ${friendly ?? data?.error_description ?? envelope}`, envelope, status, data?.log_id
        );
    }
    const detail = err?.message ?? String(err);
    return new Error(`${context}: ${status ? `HTTP ${status} — ` : ''}${detail}`);
}

/** Throw unless a v2 envelope says `ok`. Returns `data`. */
function unwrap<T>(context: string, body: any, httpStatus?: number): T {
    const code = body?.error?.code;
    if (code && code !== 'ok') {
        throw toTikTokError(context, { response: { data: body, status: httpStatus } });
    }
    return body?.data as T;
}

// ─── OAuth ──────────────────────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(input: {
    clientKey: string;
    redirectUri: string;
    state: string;
    scopes?: readonly string[];
}): string {
    const url = new URL(TIKTOK_AUTHORIZE_URL);
    url.searchParams.set('client_key', input.clientKey);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', (input.scopes ?? TIKTOK_SCOPES).join(','));
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('state', input.state);
    return url.toString();
}

export interface TikTokTokenSet {
    accessToken: string;
    refreshToken: string;
    openId: string;
    scopes: string[];
    accessExpiresAt: Date;
    refreshExpiresAt: Date;
}

function parseTokenResponse(body: any, now: number): TikTokTokenSet {
    if (!body?.access_token || !body?.refresh_token || !body?.open_id) {
        throw toTikTokError('TikTok token exchange', { response: { data: body } });
    }
    return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        openId: body.open_id,
        scopes: String(body.scope ?? '').split(',').map((s: string) => s.trim()).filter(Boolean),
        accessExpiresAt: new Date(now + Number(body.expires_in ?? 0) * 1000),
        refreshExpiresAt: new Date(now + Number(body.refresh_expires_in ?? 0) * 1000),
    };
}

async function postForm(path: string, form: Record<string, string>, context: string): Promise<any> {
    try {
        const res = await tiktokHttp.post(`${TIKTOK_API_BASE}${path}`, new URLSearchParams(form).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        // The token endpoint answers some refusals with HTTP 200 and an `error` string.
        if (typeof res.data?.error === 'string' && res.data.error) {
            throw toTikTokError(context, { response: { data: res.data, status: res.status } });
        }
        return res.data;
    } catch (err) {
        throw toTikTokError(context, err);
    }
}

/**
 * Trade the authorisation code for tokens. Deliberately NOT retried: a code is single-use, so a
 * retry after a timeout that actually succeeded server-side can only ever fail.
 */
export async function exchangeCode(
    input: { clientKey: string; clientSecret: string; code: string; redirectUri: string },
    now: () => number = Date.now
): Promise<TikTokTokenSet> {
    const body = await postForm('/v2/oauth/token/', {
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        code: input.code,
        grant_type: 'authorization_code',
        redirect_uri: input.redirectUri,
    }, 'TikTok token exchange');
    return parseTokenResponse(body, now());
}

/**
 * Refresh. Also NOT retried, and for a sharper reason: TikTok may rotate the refresh token on
 * every refresh, so a retry after a response lost in transit would present the old one — and
 * the connection would be dead. The caller holds a claim on the row for exactly this reason.
 */
export async function refreshTokens(
    input: { clientKey: string; clientSecret: string; refreshToken: string },
    now: () => number = Date.now
): Promise<TikTokTokenSet> {
    const body = await postForm('/v2/oauth/token/', {
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
    }, 'TikTok token refresh');
    return parseTokenResponse(body, now());
}

/** Tell TikTok to drop our access. Best-effort from the caller's side — see `disconnect`. */
export async function revokeToken(input: { clientKey: string; clientSecret: string; token: string }): Promise<void> {
    await postForm('/v2/oauth/revoke/', {
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        token: input.token,
    }, 'TikTok revoke');
}

export interface TikTokProfile {
    openId: string;
    displayName: string | null;
    avatarUrl: string | null;
}

export async function getUserInfo(accessToken: string): Promise<TikTokProfile> {
    try {
        const res = await withRetry(
            () => tiktokHttp.get(`${TIKTOK_API_BASE}/v2/user/info/`, {
                params: { fields: 'open_id,avatar_url,display_name' },
                headers: { Authorization: `Bearer ${accessToken}` },
            }),
            { label: 'tiktok.user_info' }
        );
        const data = unwrap<{ user?: any }>('TikTok user info', res.data, res.status);
        const user = data?.user ?? {};
        return {
            openId: String(user.open_id ?? ''),
            displayName: typeof user.display_name === 'string' ? user.display_name : null,
            avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null,
        };
    } catch (err) {
        throw toTikTokError('TikTok user info', err);
    }
}

// ─── Upload ─────────────────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
/** Below this TikTok requires a single chunk; it is also the minimum chunk size. */
export const MIN_CHUNK_BYTES = 5 * MB;
/** Largest chunk TikTok accepts (the final chunk may be up to 128MB). */
export const MAX_CHUNK_BYTES = 64 * MB;
/** The size used when a file has to be split. */
export const SPLIT_CHUNK_BYTES = 32 * MB;
/** TikTok's ceiling for a video file. */
export const MAX_VIDEO_BYTES = 4 * 1024 * MB;

export interface ChunkPlan {
    videoSize: number;
    chunkSize: number;
    totalChunkCount: number;
    /** Inclusive byte ranges, in upload order. The last one absorbs the remainder. */
    ranges: { start: number; end: number }[];
}

/**
 * How TikTok wants a file cut.
 *
 * Its rules: a file of 64MB or less may go up whole (and under 5MB it must); otherwise chunks of
 * 5–64MB, `total_chunk_count = floor(video_size / chunk_size)`, and the trailing remainder rides
 * on the final chunk — which is why the final chunk may reach 128MB. With 32MB chunks the final
 * one is always 32–64MB, well inside that.
 */
export function planChunks(videoSize: number): ChunkPlan {
    if (!Number.isInteger(videoSize) || videoSize <= 0) {
        throw new Error('Cannot upload an empty video.');
    }
    if (videoSize > MAX_VIDEO_BYTES) {
        throw new Error('TikTok accepts videos up to 4GB.');
    }
    if (videoSize <= MAX_CHUNK_BYTES) {
        return { videoSize, chunkSize: videoSize, totalChunkCount: 1, ranges: [{ start: 0, end: videoSize - 1 }] };
    }
    const chunkSize = SPLIT_CHUNK_BYTES;
    const totalChunkCount = Math.floor(videoSize / chunkSize);
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < totalChunkCount; i++) {
        const start = i * chunkSize;
        const end = i === totalChunkCount - 1 ? videoSize - 1 : start + chunkSize - 1;
        ranges.push({ start, end });
    }
    return { videoSize, chunkSize, totalChunkCount, ranges };
}

export interface UploadInit {
    publishId: string;
    uploadUrl: string;
}

/** TikTok's caption ceiling, in UTF-16 code units — which is what `String.length` counts. */
export const MAX_TITLE_UTF16 = 2200;

/** Codes that mean "your request body is wrong" — the ones worth one retry without `post_info`. */
const INVALID_PARAM_CODES = new Set(['invalid_params', 'invalid_param']);

/**
 * Start an inbox upload. NOT retried on failure: a 5xx here may still have created a pending
 * share, and TikTok allows only five of those per 24h — a blind retry spends that budget on
 * duplicates.
 *
 * The caption: TikTok documents only `source_info` for this endpoint, so officially an inbox
 * video carries no caption and the creator types it in TikTok's editor. Postiz sends
 * `post_info.title` anyway and reports TikTok pre-fills it. That is undocumented, so it is sent
 * and — if TikTok rejects the body as invalid, which creates nothing — the call is repeated once
 * without it. The dashboard keeps its copy-caption button either way.
 */
export async function initInboxVideoUpload(
    accessToken: string,
    plan: ChunkPlan,
    caption?: string | null
): Promise<UploadInit & { captionSent: boolean }> {
    const sourceInfo = {
        source: 'FILE_UPLOAD',
        video_size: plan.videoSize,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount,
    };
    const title = caption ? caption.slice(0, MAX_TITLE_UTF16) : '';
    const attempt = async (withTitle: boolean) => {
        const res = await tiktokHttp.post(
            `${TIKTOK_API_BASE}/v2/post/publish/inbox/video/init/`,
            withTitle ? { post_info: { title }, source_info: sourceInfo } : { source_info: sourceInfo },
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
        );
        const data = unwrap<{ publish_id?: string; upload_url?: string }>('TikTok upload init', res.data, res.status);
        if (!data?.publish_id || !data?.upload_url) {
            throw new Error('TikTok upload init: the response had no publish_id or upload_url.');
        }
        return { publishId: data.publish_id, uploadUrl: data.upload_url, captionSent: withTitle };
    };

    try {
        if (!title) return await attempt(false);
        try {
            return await attempt(true);
        } catch (err) {
            const parsed = toTikTokError('TikTok upload init', err);
            if (parsed instanceof TikTokApiError && INVALID_PARAM_CODES.has(parsed.code)) {
                return await attempt(false);
            }
            throw parsed;
        }
    } catch (err) {
        throw toTikTokError('TikTok upload init', err);
    }
}

/** PUT every chunk, in order — TikTok requires sequential chunks. */
export async function uploadChunks(
    uploadUrl: string,
    data: Buffer,
    mimeType: string,
    plan: ChunkPlan
): Promise<void> {
    if (data.length !== plan.videoSize) {
        throw new Error(`Upload plan is for ${plan.videoSize} bytes but the file is ${data.length}.`);
    }
    for (const [index, range] of plan.ranges.entries()) {
        const body = data.subarray(range.start, range.end + 1);
        try {
            // A re-PUT of the same range is safe, unlike the init above.
            await withRetry(
                () => tiktokHttp.put(uploadUrl, body, {
                    headers: {
                        'Content-Type': mimeType,
                        'Content-Length': String(body.length),
                        'Content-Range': `bytes ${range.start}-${range.end}/${plan.videoSize}`,
                    },
                    timeout: UPLOAD_TIMEOUT_MS,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                }),
                { label: `tiktok.upload_chunk[${index + 1}/${plan.totalChunkCount}]`, retries: 2 }
            );
        } catch (err) {
            throw toTikTokError(`TikTok upload (chunk ${index + 1} of ${plan.totalChunkCount})`, err);
        }
    }
}

// ─── Direct Post ────────────────────────────────────────────────────────────────────────

export interface TikTokCreatorInfo {
    nickname: string;
    username: string;
    avatarUrl: string | null;
    /** What this creator may choose between. TikTok rejects anything else with privacy_level_option_mismatch. */
    privacyLevelOptions: string[];
    commentDisabled: boolean;
    duetDisabled: boolean;
    stitchDisabled: boolean;
    maxVideoPostDurationSec: number;
}

/**
 * `creator_info/query` — who is posting and what they may choose. TikTok's guidelines require
 * calling this before every Direct Post and building the composer from it (nickname shown, the
 * privacy options offered, interaction toggles disabled where the creator has disabled them).
 */
export async function queryCreatorInfo(accessToken: string): Promise<TikTokCreatorInfo> {
    try {
        const res = await withRetry(
            () => tiktokHttp.post(`${TIKTOK_API_BASE}/v2/post/publish/creator_info/query/`, {}, {
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
            }),
            { label: 'tiktok.creator_info' }
        );
        const d = unwrap<any>('TikTok creator info', res.data, res.status) ?? {};
        return {
            nickname: String(d.creator_nickname ?? ''),
            username: String(d.creator_username ?? ''),
            avatarUrl: typeof d.creator_avatar_url === 'string' ? d.creator_avatar_url : null,
            privacyLevelOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options.map(String) : [],
            commentDisabled: d.comment_disabled === true,
            duetDisabled: d.duet_disabled === true,
            stitchDisabled: d.stitch_disabled === true,
            maxVideoPostDurationSec: Number(d.max_video_post_duration_sec ?? 0),
        };
    } catch (err) {
        throw toTikTokError('TikTok creator info', err);
    }
}

export interface DirectPostInfo {
    title: string;
    privacy_level: string;
    disable_comment: boolean;
    disable_duet: boolean;
    disable_stitch: boolean;
    brand_content_toggle: boolean;
    brand_organic_toggle: boolean;
    is_aigc: boolean;
}

/**
 * Start a Direct Post. NOT retried, for the same reason as the inbox init: a 5xx may still have
 * created the post, and a retry would publish it twice on a live profile.
 */
export async function initDirectVideoPost(
    accessToken: string,
    plan: ChunkPlan,
    postInfo: DirectPostInfo
): Promise<UploadInit> {
    try {
        const res = await tiktokHttp.post(
            `${TIKTOK_API_BASE}/v2/post/publish/video/init/`,
            {
                post_info: { ...postInfo, title: postInfo.title.slice(0, MAX_TITLE_UTF16) },
                source_info: {
                    source: 'FILE_UPLOAD',
                    video_size: plan.videoSize,
                    chunk_size: plan.chunkSize,
                    total_chunk_count: plan.totalChunkCount,
                },
            },
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
        );
        const data = unwrap<{ publish_id?: string; upload_url?: string }>('TikTok post init', res.data, res.status);
        if (!data?.publish_id || !data?.upload_url) {
            throw new Error('TikTok post init: the response had no publish_id or upload_url.');
        }
        return { publishId: data.publish_id, uploadUrl: data.upload_url };
    } catch (err) {
        throw toTikTokError('TikTok post init', err);
    }
}

/**
 * A video's length in seconds, from the MP4 `mvhd` box — or null if it cannot be read.
 *
 * TikTok limits duration per creator (`max_video_post_duration_sec`) and rejects a longer upload
 * only after it has been uploaded and processed. Reading the header first turns that into an
 * immediate, readable refusal. MP4/MOV only; anything else returns null and TikTok decides.
 */
export function mp4DurationSeconds(buf: Buffer): number | null {
    const at = buf.indexOf('mvhd', 0, 'latin1');
    if (at < 4) return null;
    const version = buf[at + 4];
    try {
        if (version === 0) {
            const timescale = buf.readUInt32BE(at + 16);
            const duration = buf.readUInt32BE(at + 20);
            return timescale > 0 ? duration / timescale : null;
        }
        if (version === 1) {
            const timescale = buf.readUInt32BE(at + 24);
            const duration = Number(buf.readBigUInt64BE(at + 28));
            return timescale > 0 ? duration / timescale : null;
        }
    } catch {
        return null;
    }
    return null;
}

// ─── Status ─────────────────────────────────────────────────────────────────────────────

export type TikTokPublishState =
    | 'PROCESSING_UPLOAD'
    | 'PROCESSING_DOWNLOAD'
    | 'SEND_TO_USER_INBOX'
    | 'PUBLISH_COMPLETE'
    | 'FAILED';

export interface TikTokPublishStatus {
    status: TikTokPublishState | string;
    failReason: string | null;
    /** Only public, moderated posts get one. TikTok spells the field `publicaly_available_post_id`. */
    postIds: string[];
    uploadedBytes: number | null;
}

/**
 * Parse TikTok JSON without rounding its post ids.
 *
 * TikTok sends post ids as int64 JSON *numbers* (`"publicaly_available_post_id": [7300…]`), and
 * `JSON.parse` turns anything past 2^53 into the nearest double — a different, wrong id, which
 * would link the dashboard to somebody else's video. The id fields are quoted before parsing.
 */
export function parseJsonKeepingIds(raw: unknown): any {
    if (typeof raw !== 'string') return raw;
    const quoted = raw.replace(
        /("(?:publicaly_available_post_id|post_id|video_id)"\s*:\s*)(\[[^\]]*\]|-?\d+)/g,
        (_match, key: string, value: string) => key + value.replace(/-?\d{16,}/g, (digits) => `"${digits}"`)
    );
    return JSON.parse(quoted);
}

export async function fetchPublishStatus(accessToken: string, publishId: string): Promise<TikTokPublishStatus> {
    try {
        const res = await withRetry(
            () => tiktokHttp.post(
                `${TIKTOK_API_BASE}/v2/post/publish/status/fetch/`,
                { publish_id: publishId },
                {
                    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
                    // Raw text, so the post ids can be parsed without losing precision.
                    transformResponse: [(body: unknown) => body],
                }
            ),
            { label: 'tiktok.status_fetch' }
        );
        const data = unwrap<any>('TikTok status', parseJsonKeepingIds(res.data), res.status) ?? {};
        const ids = Array.isArray(data.publicaly_available_post_id) ? data.publicaly_available_post_id : [];
        return {
            status: String(data.status ?? ''),
            failReason: typeof data.fail_reason === 'string' && data.fail_reason ? data.fail_reason : null,
            postIds: ids.map((id: unknown) => String(id)),
            uploadedBytes: typeof data.uploaded_bytes === 'number' ? data.uploaded_bytes : null,
        };
    } catch (err) {
        throw toTikTokError('TikTok status', err);
    }
}

/** Human wording for `fail_reason`, which is what lands in `scheduled_posts.error_log`. */
const FAIL_REASONS: Record<string, string> = {
    file_format_check_failed: 'TikTok rejected the file format — use an MP4 (H.264).',
    duration_check_failed: 'The video is longer (or shorter) than TikTok allows for this account.',
    frame_rate_check_failed: 'TikTok needs a frame rate between 23 and 60 fps.',
    picture_size_check_failed: 'TikTok needs a resolution between 360 and 4096 pixels on each side.',
    internal: 'TikTok had an internal error — retry the post.',
    video_pull_failed: 'TikTok could not fetch the video.',
    photo_pull_failed: 'TikTok could not fetch the photos.',
    publish_cancelled: 'The TikTok upload was cancelled.',
    auth_removed: 'The TikTok connection was removed — reconnect TikTok in Settings.',
    spam_risk_too_many_posts: 'TikTok’s daily posting limit for this account has been reached.',
    spam_risk_user_banned_from_posting: 'TikTok has blocked this account from posting.',
    spam_risk_text: 'TikTok flagged the text of this post.',
    spam_risk: 'TikTok flagged this post as spam risk.',
};

export function describeFailReason(reason: string | null): string {
    if (!reason) return 'TikTok reported a failure without a reason.';
    return FAIL_REASONS[reason] ?? `TikTok reported: ${reason}`;
}

/**
 * Map TikTok's lifecycle onto `scheduled_posts.status`.
 *
 * For an inbox upload `SEND_TO_USER_INBOX` means "waiting for the creator", and TikTok moves it
 * on to `PUBLISH_COMPLETE` once they tap the notification and post — so IN_INBOX is not terminal:
 * the reconcile sweep and the `post.publish.complete` webhook both carry it to PUBLISHED. A
 * post id only ever arrives for public, moderated posts.
 */
export function mapPublishState(status: string): 'PROCESSING' | 'IN_INBOX' | 'PUBLISHED' | 'FAILED' | null {
    switch (status) {
        case 'PROCESSING_UPLOAD':
        case 'PROCESSING_DOWNLOAD':
            return 'PROCESSING';
        case 'SEND_TO_USER_INBOX':
            return 'IN_INBOX';
        case 'PUBLISH_COMPLETE':
            return 'PUBLISHED';
        case 'FAILED':
            return 'FAILED';
        default:
            return null;
    }
}

// ─── Webhooks ───────────────────────────────────────────────────────────────────────────

/**
 * Verify `Tiktok-Signature: t=<unix seconds>,s=<hex>` — HMAC-SHA256 of `"<t>.<raw body>"` keyed
 * with the app's client secret.
 *
 * No freshness window is enforced. TikTok retries a delivery for up to 72 hours and does not
 * document whether a retry is re-signed, so a tight window could reject every retry of an event
 * we missed. What a replay could do is re-apply a status TikTok already sent, and every write
 * that consumes these events is an idempotent state transition.
 *
 * @see https://developers.tiktok.com/doc/webhooks-verification
 */
export function verifyTikTokSignature(
    header: string | undefined,
    rawBody: Buffer | string | undefined,
    clientSecret: string
): boolean {
    if (!header || rawBody === undefined || !clientSecret) return false;
    const parts = Object.fromEntries(
        header.split(',').map((kv) => {
            const i = kv.indexOf('=');
            return i === -1 ? [kv.trim(), ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
        })
    );
    const t = parts['t'];
    const s = parts['s'];
    if (!t || !s || !/^[0-9a-f]+$/i.test(s)) return false;

    const payload = Buffer.concat([
        Buffer.from(`${t}.`, 'utf8'),
        Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8'),
    ]);
    const expected = crypto.createHmac('sha256', clientSecret).update(payload).digest();
    const given = Buffer.from(s, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

export interface TikTokWebhookEvent {
    event: string;
    openId: string | null;
    createTime: number | null;
    /** `content` arrives as a JSON string; parsed here, `{}` when absent or malformed. */
    content: Record<string, any>;
}

export function parseWebhookEvent(body: any): TikTokWebhookEvent | null {
    if (!body || typeof body !== 'object' || typeof body.event !== 'string') return null;
    let content: Record<string, any> = {};
    if (typeof body.content === 'string') {
        try {
            const parsed = parseJsonKeepingIds(body.content);
            if (parsed && typeof parsed === 'object') content = parsed;
        } catch {
            content = {};
        }
    } else if (body.content && typeof body.content === 'object') {
        content = body.content;
    }
    return {
        event: body.event,
        openId: typeof body.user_openid === 'string' ? body.user_openid : null,
        createTime: typeof body.create_time === 'number' ? body.create_time : null,
        content,
    };
}
