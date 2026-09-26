/**
 * `POST /api/studio/worker/uploads/sign` (MONTEUR.md §4): a rendered reel is tens of megabytes,
 * over Vercel's 4.5MB request cap and the worker's 3MB `/worker/upload`, so the worker puts the
 * bytes straight into Supabase Storage through a signed URL instead.
 *
 * The row is written here, metadata only (`data` NULL, `storage_path`, `size_bytes`), so the URL
 * the worker reports back is an ordinary `/api/uploads/<id>` on this app's own domain: the one Meta
 * cURLs and TikTok's verified prefix covers. `completeJob` accepts it only as this tenant's upload.
 *
 * Signed first, then written: a refused signature leaves no row. A worker that signs and then
 * never uploads leaves a row with no object behind it, which nothing names; the media retention
 * sweep collects it like any other unreferenced upload.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../config/db.js';
import { log } from '../../utils/log.js';
import { getMediaStore, SupabaseStorageMediaStore } from '../storage.js';
import { clipText, isPlainObject, problemsError, StudioError } from '../studio/common.js';
import { objectPathFor, StorageApiError } from '../supabaseStorage.js';

export const SIGNED_UPLOAD_TYPES: readonly string[] = ['video/mp4', 'image/jpeg'];
export const MAX_SIGNED_UPLOAD_BYTES = 100 * 1024 * 1024;

export interface SignedUploadAnswer {
    id: string;
    /** `/api/uploads/<id>` on the public base: what the worker reports in its job result. */
    url: string;
    upload: { method: 'PUT'; url: string; headers: Record<string, string> };
}

export function parseSignRequest(body: unknown): { filename: string; mimeType: string; sizeBytes: number } {
    const b = isPlainObject(body) ? body : {};
    const problems: string[] = [];
    if (typeof b.mime_type !== 'string' || !SIGNED_UPLOAD_TYPES.includes(b.mime_type)) {
        problems.push(`mime_type must be one of ${SIGNED_UPLOAD_TYPES.join(', ')}`);
    }
    const size = b.size_bytes;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
        problems.push('size_bytes must be the file\'s size, a whole number of bytes');
    } else if (size > MAX_SIGNED_UPLOAD_BYTES) {
        problems.push(`An upload is at most 100MB; this one is ${(size / 1024 / 1024).toFixed(1)}MB`);
    }
    if (problems.length) throw problemsError(problems, 'the upload');
    return { filename: clipText(b.filename, 200) ?? 'monteur-upload', mimeType: b.mime_type as string, sizeBytes: size as number };
}

/**
 * Sign one upload for the worker's tenant. 400 for a type or size it does not take, 409 when media
 * does not go to Supabase Storage (there is nothing to sign against), 502 when Storage says no.
 */
export async function signWorkerUpload(
    creatorId: string, body: unknown, publicBase: () => Promise<string | null>
): Promise<SignedUploadAnswer> {
    const request = parseSignRequest(body);
    const store = await getMediaStore();
    if (!(store instanceof SupabaseStorageMediaStore)) {
        throw new StudioError(409, 'Large uploads go straight to Supabase Storage, and media here is not stored there. Set it up in Settings → Media storage.');
    }
    const base = await publicBase();
    if (!base) throw new StudioError(500, 'No public address for this app: set it in Settings → TikTok app.');

    const id = randomUUID();
    const path = objectPathFor(creatorId, id, request.mimeType);
    let signed;
    try {
        signed = await store.client.createSignedUploadUrl(path, request.mimeType);
    } catch (err) {
        if (err instanceof StorageApiError) throw new StudioError(502, err.message);
        throw err;
    }
    await pool.query(
        `INSERT INTO media_uploads (id, creator_id, filename, mime_type, data, storage_path, size_bytes)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [id, creatorId, request.filename, request.mimeType, path, request.sizeBytes]
    );
    log('info', 'monteur.upload_signed', { media_id: id, bytes: request.sizeBytes, mime_type: request.mimeType });
    return { id, url: store.publicUrl(id, base), upload: { method: 'PUT', url: signed.url, headers: signed.headers } };
}
