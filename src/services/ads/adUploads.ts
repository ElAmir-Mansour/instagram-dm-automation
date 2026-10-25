/**
 * Signed direct uploads for ad media (A5): the builder's pictures and videos go from the browser straight into Supabase Storage through a
 * signed URL, because a video is tens of megabytes and Vercel's request cap is 4.5 MB. The same pattern as the Monteur's worker uploads
 * (`monteur/uploads.ts`, which this file does not change).
 *
 * The `media_uploads` row is PUBLIC and metadata only: Meta fetches the file by cURLing `/api/uploads/<id>` on this app's own domain, so the
 * row is an ordinary one (not `is_private`), with `data` NULL and the bytes in Storage. Signed first, then written: a refused signature
 * leaves no row. A signature nobody uploads to leaves a row with no object behind it, which the media retention sweep collects.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../config/db.js';
import { queryOne } from '../../db/query.js';
import { log } from '../../utils/log.js';
import { AdsError } from '../adBoosts.js';
import { getMediaStore, SupabaseStorageMediaStore } from '../storage.js';
import { clipText } from '../studio/common.js';
import { objectPathFor, StorageApiError } from '../supabaseStorage.js';

const MB = 1024 * 1024;

/** Pictures an ad takes, and the most we sign for one. */
export const AD_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png'];
export const AD_IMAGE_MAX_BYTES = 30 * MB;
/**
 * Videos an ad takes. 50 MB is Supabase's free-tier per-file limit: a bigger signed upload would be refused by Storage after the person
 * waited for it to travel, so it is refused here, up front, in words.
 */
export const AD_VIDEO_TYPES: readonly string[] = ['video/mp4', 'video/quicktime'];
export const AD_VIDEO_MAX_BYTES = 50 * MB;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SignAdUploadAnswer {
    mediaId: string;
    /** `/api/uploads/<id>` on the public base: the address Meta fetches the file from. */
    url: string;
    upload: { method: 'PUT'; url: string; headers: Record<string, string> };
    /** ISO time the signed URL stops working (Storage signs for two hours). */
    expiresAt: string;
}

function invalid(message: string, field: string): AdsError {
    return new AdsError(400, 'INVALID', message, field);
}

function mb(bytes: number): string {
    return `${Math.round(bytes / MB)} MB`;
}

/** Check `{ filename, mime, size }`: a type and a size an ad can use. */
export function parseAdUploadRequest(body: unknown): { filename: string; mime: string; size: number } {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const mime = typeof b['mime'] === 'string' ? b['mime'] : '';
    const isImage = AD_IMAGE_TYPES.includes(mime);
    const isVideo = AD_VIDEO_TYPES.includes(mime);
    if (!isImage && !isVideo) {
        throw invalid('Ads take JPEG or PNG pictures and MP4 or QuickTime (MOV) videos.', 'mime');
    }
    const size = b['size'];
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
        throw invalid('Send the file\'s size as a whole number of bytes.', 'size');
    }
    const limit = isImage ? AD_IMAGE_MAX_BYTES : AD_VIDEO_MAX_BYTES;
    if (size > limit) {
        throw invalid(`${isImage ? 'A picture' : 'A video'} can be at most ${mb(limit)}: this one is ${(size / MB).toFixed(1)} MB.`, 'size');
    }
    return { filename: clipText(b['filename'], 200) ?? 'ad-upload', mime, size };
}

/**
 * Sign one upload for the tenant. 400 for a type or size an ad cannot use, 409 when media here is not on Supabase Storage (there is nothing
 * to sign against), 502 when Storage says no.
 */
export async function signAdUpload(creatorId: string, body: unknown, publicBase: string): Promise<SignAdUploadAnswer> {
    const request = parseAdUploadRequest(body);
    const store = await getMediaStore();
    if (!(store instanceof SupabaseStorageMediaStore)) {
        throw new AdsError(409, 'INVALID', 'Uploading ad media needs Supabase Storage, and media here is not stored there. Set it up in Settings → Media storage.');
    }
    const id = randomUUID();
    const path = objectPathFor(creatorId, id, request.mime);
    let signed;
    try {
        signed = await store.client.createSignedUploadUrl(path, request.mime);
    } catch (err) {
        if (err instanceof StorageApiError) throw new AdsError(502, 'STORAGE_ERROR', `Storage refused the upload: ${err.message}`);
        throw err;
    }
    await pool.query(
        `INSERT INTO media_uploads (id, creator_id, filename, mime_type, data, storage_path, size_bytes)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [id, creatorId, request.filename, request.mime, path, request.size]
    );
    log('info', 'ads.upload_signed', { media_id: id, bytes: request.size, mime_type: request.mime });
    return { mediaId: id, url: store.publicUrl(id, publicBase), upload: { method: 'PUT', url: signed.url, headers: signed.headers }, expiresAt: signed.expiresAt };
}

/**
 * The tenant's own upload: its type and size, or 404 `NOT_FOUND`. Another tenant's media answers the same as one that does not exist.
 * A customer's private file is never ad media.
 */
export async function assertOwnMedia(creatorId: string, mediaId: string): Promise<{ mime: string; size: number }> {
    if (typeof mediaId !== 'string' || !UUID.test(mediaId)) throw new AdsError(404, 'NOT_FOUND', 'No such upload.', 'mediaId');
    const row = await queryOne<{ mime_type: string; size_bytes: string | number | null }>(
        'SELECT mime_type, size_bytes FROM media_uploads WHERE id = $1 AND creator_id = $2 AND NOT is_private',
        [mediaId, creatorId]
    );
    if (!row) throw new AdsError(404, 'NOT_FOUND', 'No such upload.', 'mediaId');
    return { mime: row.mime_type, size: Number(row.size_bytes ?? 0) };
}
