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
 *
 * Illustrated explainers (v59) use it twice more. The worker's narration is an m4a (`audio/mp4`),
 * so the worker may sign that as well. And the owner's dashboard uploads a music track or a
 * character's reference picture through `signExplainerUpload`: the same signed URL, but for a
 * browser, with the types of its purpose and a 25 MB ceiling (a track is a few MB, over the 3.3 MB
 * `/api/upload` takes). The route that calls it is owner-only and is not here.
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../config/db.js';
import { log } from '../../utils/log.js';
import { getMediaStore, SupabaseStorageMediaStore } from '../storage.js';
import { clipText, isPlainObject, problemsError, StudioError } from '../studio/common.js';
import { objectPathFor, StorageApiError } from '../supabaseStorage.js';

/** A reel and its cover; an infographic's GIF (v31); and an explainer's voiced narration, an m4a (v59). */
export const SIGNED_UPLOAD_TYPES: readonly string[] = ['video/mp4', 'image/jpeg', 'image/gif', 'audio/mp4'];
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
        problems.push(`size_bytes is over the 100MB limit: this upload is ${(size / 1024 / 1024).toFixed(1)}MB`);
    }
    if (problems.length) throw problemsError(problems, 'the upload');
    return { filename: clipText(b.filename, 200) ?? 'monteur-upload', mimeType: b.mime_type as string, sizeBytes: size as number };
}

/** What a signed upload is made of, once its request is known to be good. */
interface SignedFile {
    filename: string;
    mimeType: string;
    sizeBytes: number;
}

/** The public address the URL is built on: a function (the route's), the address itself, or none. */
type PublicBase = string | null | (() => Promise<string | null>);

/**
 * Sign one file for a tenant and write its row: the one place both callers do it. 409 when media does not go to Supabase Storage (there is nothing
 * to sign against), 500 when the app has no public address, 502 when Storage says no. Signed first, then written, so a refusal leaves no row.
 */
async function signAndRecord(creatorId: string, file: SignedFile, publicBase: PublicBase) {
    const store = await getMediaStore();
    if (!(store instanceof SupabaseStorageMediaStore)) {
        throw new StudioError(409, 'Large uploads go straight to Supabase Storage, and media here is not stored there. Set it up in Settings → Media storage.');
    }
    const base = typeof publicBase === 'function' ? await publicBase() : publicBase;
    if (!base) throw new StudioError(500, 'No public address for this app: set it in Settings → TikTok app.');

    const id = randomUUID();
    const path = objectPathFor(creatorId, id, file.mimeType);
    let signed;
    try {
        signed = await store.client.createSignedUploadUrl(path, file.mimeType);
    } catch (err) {
        if (err instanceof StorageApiError) throw new StudioError(502, err.message);
        throw err;
    }
    await pool.query(
        `INSERT INTO media_uploads (id, creator_id, filename, mime_type, data, storage_path, size_bytes)
         VALUES ($1, $2, $3, $4, NULL, $5, $6)`,
        [id, creatorId, file.filename, file.mimeType, path, file.sizeBytes]
    );
    return { id, url: store.publicUrl(id, base), signed };
}

/**
 * Sign one upload for the worker's tenant. 400 for a type or size it does not take, 409 when media
 * does not go to Supabase Storage (there is nothing to sign against), 502 when Storage says no.
 */
export async function signWorkerUpload(
    creatorId: string, body: unknown, publicBase: () => Promise<string | null>
): Promise<SignedUploadAnswer> {
    const request = parseSignRequest(body);
    const { id, url, signed } = await signAndRecord(creatorId, request, publicBase);
    log('info', 'monteur.upload_signed', { media_id: id, bytes: request.sizeBytes, mime_type: request.mimeType });
    return { id, url, upload: { method: 'PUT', url: signed.url, headers: signed.headers } };
}

// ─── The owner's uploads for Explainers (v59) ───────────────────────────────────────────────────

export type ExplainerUploadPurpose = 'music' | 'reference';

/** What each purpose takes: a track of the music library, or a character's reference picture (the render and the image provider read nothing else). */
export const EXPLAINER_UPLOAD_TYPES: Readonly<Record<ExplainerUploadPurpose, readonly string[]>> = {
    music: ['audio/mpeg', 'audio/mp4', 'audio/wav'],
    reference: ['image/png', 'image/jpeg'],
};
export const MAX_EXPLAINER_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface ExplainerUploadAnswer {
    /** Where the browser PUTs the file, with its type as `Content-Type`. Signed: no key is needed, and it expires. */
    upload_url: string;
    media_id: string;
    /** `/api/uploads/<media_id>` on the public base: what the settings keep for the track or the reference. */
    url: string;
}

const isPurpose = (value: unknown): value is ExplainerUploadPurpose => value === 'music' || value === 'reference';
const ALL_EXPLAINER_TYPES: readonly string[] = [...new Set(Object.values(EXPLAINER_UPLOAD_TYPES).flat())];

/** `{ purpose, mime, size }` as the dashboard sends it, every problem reported at once. */
export function parseExplainerSignRequest(body: unknown): { purpose: ExplainerUploadPurpose; mimeType: string; sizeBytes: number } {
    const b = isPlainObject(body) ? body : {};
    const problems: string[] = [];
    const purpose = isPurpose(b.purpose) ? b.purpose : null;
    if (!purpose) problems.push('purpose must be music or reference');
    const allowed = purpose ? EXPLAINER_UPLOAD_TYPES[purpose] : ALL_EXPLAINER_TYPES;
    if (typeof b.mime !== 'string' || !allowed.includes(b.mime)) {
        problems.push(`mime must be one of ${allowed.join(', ')}${purpose ? ` for ${purpose}` : ''}`);
    }
    const size = b.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
        problems.push('size must be the file\'s size, a whole number of bytes');
    } else if (size > MAX_EXPLAINER_UPLOAD_BYTES) {
        problems.push(`size must be at most 25MB: this upload is ${(size / 1024 / 1024).toFixed(1)}MB`);
    }
    if (problems.length) throw problemsError(problems, 'the upload');
    return { purpose: purpose!, mimeType: b.mime as string, sizeBytes: size as number };
}

/**
 * Sign one upload from the owner's dashboard: a music track (`audio/mpeg`, `audio/mp4`, `audio/wav`) or a character's reference picture
 * (`image/png`, `image/jpeg`), up to 25 MB, for the owner's tenant. The browser PUTs the file to `upload_url`; the row (metadata only) is written
 * here, so `url` is an ordinary `/api/uploads/<id>` on our own domain, which the render downloads from and the image provider's references are
 * read through. 400 for a request it does not take, 409 when media does not go to Supabase Storage, 502 when Storage says no. Owner-only: the
 * route checks that, and the explainers switch, before it calls this.
 */
export async function signExplainerUpload(
    creatorId: string, body: { purpose: unknown; mime: unknown; size: unknown }, publicBase: PublicBase
): Promise<ExplainerUploadAnswer> {
    const request = parseExplainerSignRequest(body);
    const { id, url, signed } = await signAndRecord(creatorId, { filename: `explainer-${request.purpose}`, mimeType: request.mimeType, sizeBytes: request.sizeBytes }, publicBase);
    log('info', 'explainer.upload_signed', { media_id: id, purpose: request.purpose, bytes: request.sizeBytes, mime_type: request.mimeType });
    return { upload_url: signed.url, media_id: id, url };
}
