/**
 * What a customer sends on WhatsApp, saved privately (docs/specs/001-whatsapp-agent T016, research R6, analysis review H4).
 *
 * Meta keeps an inbound file for 7 days and hands it over through a URL that lives 5 minutes (`getMediaUrl`), so the job that received
 * the message downloads it at once and keeps its own copy: in the media store, as a PRIVATE upload (`media_uploads.is_private`, migration
 * v51). A private upload is never served by the public `GET /api/uploads/:id` (the store answers "no such upload" for it); only a
 * tenant-scoped read reaches it (`getMediaStore().open(id, { privateFor })`), and the erasure flow deletes it with the contact.
 *
 * This file is the one step "media id in, upload id out". Setting `messages.media_upload_id`, deciding what to do with the file (transcribe a
 * voice note, describe an image) and the authenticated route that serves it are the integration's. Nothing here knows about conversations.
 *
 * ── Rules it keeps ──
 *
 *  - The download happens inside the URL's life. A 404 on the download means the URL expired, so the URL is asked for ONCE more and the
 *    download tried once more; a second 404 is `not_found` (the media is gone, or past its 7 days).
 *  - 16 MB, for everything, in this phase. Bigger is skipped (`too_large`), from the size Meta announces before a byte is fetched, and from
 *    the download's own limit if the announcement was wrong. The Graph API allows 100 MB; this phase has no use for a file that big.
 *  - Only the types WhatsApp sends and this app can use (`SAVEABLE_TYPES`); anything else is `unsupported_type`, skipped, not stored.
 *  - Never throws for an expected outcome: the result says what happened and whether trying again could help (`retryable`), because the
 *    caller is a job that must decide between "retry" and "carry on without the file".
 *  - Never logs, returns or stores the token, or the download URL with its query (signed, and as good as the token for 5 minutes). An
 *    error's own message is scrubbed of both before it is kept, and the error object itself (whose `cause` is an axios failure holding the
 *    request's headers) is never logged.
 */
import { downloadMedia, getMediaUrl, scrubToken, MEDIA_HOST_SUFFIXES, type WhatsAppMediaInfo } from './whatsapp.js';
import { getMediaStore } from './storage.js';
import { log } from '../utils/log.js';

/** The most one saved file may weigh, in this phase. */
export const MAX_INBOUND_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * The types this phase saves, and nothing else: what WhatsApp sends for a voice note or audio file, a photo or sticker, a video and a PDF.
 * The stored MIME type is one of these, never the sender's free text. (Other documents arrive later with their own handling.)
 */
export const SAVEABLE_TYPES: ReadonlySet<string> = new Set([
    'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr',
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/3gpp',
    'application/pdf',
]);

const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/amr': '.amr',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/3gpp': '.3gp',
    'application/pdf': '.pdf',
};

export type SaveInboundMediaFailure =
    /** The ids given are not ids. Permanent. */
    | 'invalid_input'
    /** Over `MAX_INBOUND_MEDIA_BYTES`. Skipped, permanent. */
    | 'too_large'
    /** Not one of `SAVEABLE_TYPES`. Skipped, permanent. */
    | 'unsupported_type'
    /** Meta no longer has it: expired (7 days), deleted, or never this number's. Permanent. */
    | 'not_found'
    /** The WhatsApp token is dead. Permanent for this job; the connection needs attention. */
    | 'auth'
    /** Asking Meta for the URL failed in a way that may pass. */
    | 'lookup_failed'
    /** The download failed in a way that may pass. */
    | 'download_failed'
    /** Our own store refused the bytes. */
    | 'store_failed';

export type SaveInboundMediaResult =
    | { ok: true; uploadId: string; mimeType: string; bytes: number }
    | { ok: false; reason: SaveInboundMediaFailure; retryable: boolean; detail?: string };

export interface SaveInboundMediaInput {
    creatorId: string;
    /** The WhatsApp phone number the message arrived on: Meta answers only for a file that belongs to it. */
    phoneNumberId: string;
    token: string;
    /** `messages[].audio.id` and its kin. */
    mediaId: string;
    /** The type the webhook announced; Meta's own answer wins when it gives one. May carry parameters (`audio/ogg; codecs=opus`). */
    mime?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `audio/ogg; codecs=opus` becomes `audio/ogg`. */
export function baseMime(mime: string | null | undefined): string {
    return String(mime ?? '').split(';')[0]!.trim().toLowerCase();
}

/** The HTTP status of an axios failure, through the `MetaApiError` that wraps it. */
function statusOf(err: unknown): number | undefined {
    const e = err as { cause?: { response?: { status?: unknown } }; response?: { status?: unknown } } | null;
    const status = e?.cause?.response?.status ?? e?.response?.status;
    return typeof status === 'number' ? status : undefined;
}

function codeOf(err: unknown): number | undefined {
    const code = (err as { metaCode?: unknown } | null)?.metaCode;
    return typeof code === 'number' ? code : undefined;
}

/** axios's refusal of a body past `maxContentLength`. */
function isTooLarge(err: unknown): boolean {
    const e = err as { message?: unknown; cause?: { message?: unknown; code?: unknown } } | null;
    return /maxContentLength/i.test(String(e?.cause?.message ?? '')) || /maxContentLength/i.test(String(e?.message ?? ''));
}

/** A URL with its query and fragment cut off: the part that names a host and a path, and nothing signed. */
function withoutQuery(url: string): string {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return '[url]';
    }
}

/**
 * Words safe to keep and return: the token taken out, and every URL reduced to host and path. An axios message names a host
 * (`getaddrinfo ENOTFOUND lookaside.fbsbx.com`) or a status; a signed query is cut either way.
 */
export function safeDetail(err: unknown, token: string): string {
    const raw = String((err as { message?: unknown } | null)?.message ?? 'unknown error');
    return scrubToken(raw, token).replace(/https?:\/\/[^\s"'<>)]+/gi, (url) => withoutQuery(url)).slice(0, 240);
}

const failed = (reason: SaveInboundMediaFailure, retryable: boolean, detail?: string): SaveInboundMediaResult =>
    ({ ok: false, reason, retryable, ...(detail ? { detail } : {}) });

/**
 * Download one inbound file and store it privately. See the header for the rules. The ids and counts in the log lines are all it says: no
 * token, no URL, no file name from the sender, no content.
 */
export async function saveInboundMedia(input: SaveInboundMediaInput): Promise<SaveInboundMediaResult> {
    const { creatorId, phoneNumberId, token, mediaId } = input;
    if (!UUID.test(String(creatorId)) || !/^\d{1,32}$/.test(String(phoneNumberId)) || !MEDIA_ID.test(String(mediaId)) || typeof token !== 'string' || !token) {
        return failed('invalid_input', false);
    }

    // 1. The URL, valid for about five minutes from now.
    let info: WhatsAppMediaInfo;
    try {
        info = await getMediaUrl(mediaId, token, phoneNumberId);
    } catch (err) {
        return lookupFailure(err, token, mediaId);
    }

    // 2. What it is, and how big, before a byte is fetched.
    const mime = baseMime(info.mimeType) || baseMime(input.mime);
    if (!SAVEABLE_TYPES.has(mime)) {
        log('info', 'whatsapp.media_skipped', { media_id: mediaId, reason: 'unsupported_type', mime_type: mime || null });
        return failed('unsupported_type', false, mime || undefined);
    }
    if (info.fileSize !== null && info.fileSize > MAX_INBOUND_MEDIA_BYTES) {
        log('info', 'whatsapp.media_skipped', { media_id: mediaId, reason: 'too_large', bytes: info.fileSize });
        return failed('too_large', false);
    }

    // 3. The bytes. A 404 is an expired URL: ask for a fresh one once, and try once more.
    let data: Buffer;
    try {
        data = await download(info, token, mediaId, phoneNumberId);
    } catch (err) {
        return downloadFailure(err, token, mediaId);
    }
    if (data.length > MAX_INBOUND_MEDIA_BYTES) return failed('too_large', false);
    if (data.length === 0) return failed('download_failed', true, 'Meta sent an empty file.');

    // 4. Our own copy, private.
    try {
        const store = await getMediaStore();
        const { id } = await store.put({
            creatorId,
            filename: `whatsapp-${mediaId}${FILE_EXTENSIONS[mime] ?? ''}`,
            mimeType: mime,
            data,
            private: true,
        });
        log('info', 'whatsapp.media_saved', { media_id: mediaId, upload_id: id, mime_type: mime, bytes: data.length });
        return { ok: true, uploadId: id, mimeType: mime, bytes: data.length };
    } catch (err) {
        log('error', 'whatsapp.media_store_failed', { media_id: mediaId, message: safeDetail(err, token) });
        return failed('store_failed', true, safeDetail(err, token));
    }
}

/** One download, and on a 404 one fresh URL and one more download. */
async function download(first: WhatsAppMediaInfo, token: string, mediaId: string, phoneNumberId: string): Promise<Buffer> {
    try {
        return (await downloadMedia(first.url, token, { maxBytes: MAX_INBOUND_MEDIA_BYTES })).data;
    } catch (err) {
        if (statusOf(err) !== 404) throw err;
        log('info', 'whatsapp.media_url_expired', { media_id: mediaId });
    }
    const fresh = await getMediaUrl(mediaId, token, phoneNumberId);
    return (await downloadMedia(fresh.url, token, { maxBytes: MAX_INBOUND_MEDIA_BYTES })).data;
}

function lookupFailure(err: unknown, token: string, mediaId: string): SaveInboundMediaResult {
    const status = statusOf(err);
    const code = codeOf(err);
    const detail = safeDetail(err, token);
    if (code === 190) {
        log('warn', 'whatsapp.media_failed', { media_id: mediaId, stage: 'lookup', reason: 'auth', status, meta_code: code });
        return failed('auth', false, detail);
    }
    if (status === 404 || code === 100) {
        log('info', 'whatsapp.media_failed', { media_id: mediaId, stage: 'lookup', reason: 'not_found', status, meta_code: code });
        return failed('not_found', false, detail);
    }
    log('warn', 'whatsapp.media_failed', { media_id: mediaId, stage: 'lookup', reason: 'lookup_failed', status, meta_code: code });
    return failed('lookup_failed', true, detail);
}

function downloadFailure(err: unknown, token: string, mediaId: string): SaveInboundMediaResult {
    if (isTooLarge(err)) {
        log('info', 'whatsapp.media_skipped', { media_id: mediaId, reason: 'too_large' });
        return failed('too_large', false);
    }
    const status = statusOf(err);
    const detail = safeDetail(err, token);
    // A refusal to send the token to a host nobody listed (`isMetaMediaUrl`) is a TypeError from whatsapp.ts: permanent, and worth a loud line.
    if (err instanceof TypeError) {
        log('error', 'whatsapp.media_failed', { media_id: mediaId, stage: 'download', reason: 'untrusted_host', allowed: MEDIA_HOST_SUFFIXES.join(',') });
        return failed('download_failed', false, detail);
    }
    const code = codeOf(err);
    if (status === 404 || code === 100) {
        log('info', 'whatsapp.media_failed', { media_id: mediaId, stage: 'download', reason: 'not_found', status, meta_code: code });
        return failed('not_found', false, detail);
    }
    if (status === 401 || status === 403 || code === 190) {
        log('warn', 'whatsapp.media_failed', { media_id: mediaId, stage: 'download', reason: 'auth', status, meta_code: code });
        return failed('auth', false, detail);
    }
    log('warn', 'whatsapp.media_failed', { media_id: mediaId, stage: 'download', reason: 'download_failed', status, meta_code: code });
    return failed('download_failed', true, detail);
}
