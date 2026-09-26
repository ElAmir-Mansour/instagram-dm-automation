/**
 * Supabase Storage, over its REST API. The one place this app talks to it.
 *
 * Endpoints, from the Storage API's own spec (https://supabase.github.io/storage/, served under
 * `<project url>/storage/v1`):
 *
 *   GET    /bucket/{id}                          the bucket, or 404
 *   POST   /bucket                               create it: { id, name, public }
 *   POST   /object/{bucket}/{path}               upload the body; x-upsert, content-type, cache-control
 *   GET    /object/authenticated/{bucket}/{path} download with the key
 *   DELETE /object/{bucket}                      { prefixes: [...] }, at most 1000 per request
 *
 * **Keys.** Supabase has two formats and retires the older one by the end of 2026
 * (https://supabase.com/docs/guides/getting-started/api-keys):
 *
 *   - a secret key, `sb_secret_…`. It is not a JWT, so it goes in `apikey` ONLY. Sent as a
 *     Bearer token it would be verified as a JWT and refused.
 *   - the legacy `service_role` key, a JWT (`eyJ…`): `apikey` and `Authorization: Bearer`.
 *
 * The format is told by its prefix. Supabase answers 401 to a secret key sent with a browser
 * User-Agent, so every request names itself as a server.
 *
 * **Errors.** The Storage API answers most failures with HTTP 400 and puts the real status in
 * the body: `{ statusCode: "404", error: "not_found", message: "Object not found" }`.
 * `StorageApiError.status` reads the body's statusCode first, so a missing object is a 404
 * here whichever way it arrived.
 *
 * `fetch` is swappable (`setStorageFetch`) so tests answer for Supabase. Nothing here logs a
 * request: the key is in its headers.
 */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/** The bucket every tenant's media goes into, under a folder per creator. */
export const MEDIA_BUCKET = 'media';

/** Any non-browser string will do. This one says who is calling. */
export const SERVER_USER_AGENT = 'autoreply-pro-server/1.0 (media storage)';

/** Supabase's cap on one bulk delete. */
export const MAX_REMOVE_PER_REQUEST = 1000;

const JSON_TIMEOUT_MS = 10_000;
/** A whole upload or download: a 30MB reel between two data centres, with room to spare. */
const TRANSFER_TIMEOUT_MS = 120_000;
/** A stream only has to START within this. Once the body flows, the route's duration bounds it. */
const FIRST_BYTE_TIMEOUT_MS = 15_000;

export type StorageFetch = (input: string, init?: RequestInit) => Promise<Response>;

let fetchOverride: StorageFetch | null = null;

/** Override `fetch` for every client made after this — tests only. Returns the previous override. */
export function setStorageFetch(next: StorageFetch | null): StorageFetch | null {
    const previous = fetchOverride;
    fetchOverride = next;
    return previous;
}

export type StorageKeyKind = 'secret' | 'legacy_jwt' | 'unknown';

/** Which kind of key this is, by its prefix. */
export function storageKeyKind(key: string): StorageKeyKind {
    if (key.startsWith('sb_secret_')) return 'secret';
    if (key.startsWith('eyJ')) return 'legacy_jwt';
    return 'unknown';
}

/**
 * The headers that carry the key. `apikey` always; `Authorization: Bearer` only for the legacy
 * JWT, because the new secret key is not a JWT and must never be presented as one.
 */
export function storageAuthHeaders(key: string): Record<string, string> {
    const headers: Record<string, string> = { apikey: key, 'User-Agent': SERVER_USER_AGENT };
    if (storageKeyKind(key) === 'legacy_jwt') headers.Authorization = `Bearer ${key}`;
    return headers;
}

/** The `role` claim of a JWT, read without verifying it. Null when it is not a readable JWT. */
function jwtRole(jwt: string): string | null {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
        return typeof payload?.role === 'string' ? payload.role : null;
    } catch {
        return null;
    }
}

/**
 * Why this cannot be the Storage key, or null when it can. Loose on purpose: Supabase's answer
 * is the real check. This only stops the pastes that are plainly the wrong key, above all the
 * two public ones, which Supabase would accept and then refuse every upload with an RLS error.
 */
export function storageKeyProblem(key: string): string | null {
    if (/\s/.test(key)) return 'That key has a space in it. Copy it again, in one piece.';
    if (key.startsWith('sb_publishable_')) {
        return 'That is the publishable key. Media storage needs a secret key (sb_secret_…): Project Settings → API Keys → Secret keys.';
    }
    const kind = storageKeyKind(key);
    if (kind === 'secret') return key.length >= 20 ? null : 'That secret key is too short. Copy it again.';
    if (kind === 'legacy_jwt') {
        const role = jwtRole(key);
        if (role === 'service_role') return null;
        if (role === 'anon') {
            return 'That is the anon key. Media storage needs a secret key (sb_secret_…), or the legacy service_role key.';
        }
        return 'That does not look like a service_role key.';
    }
    return 'That does not look like a Supabase secret key (sb_secret_…) or service_role key.';
}

const EXTENSIONS: Readonly<Record<string, string>> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `<creatorId>/<id><ext>` — where an upload lives in the bucket.
 *
 * A folder per creator, so a tenant's media can be found, sized and removed as a unit. The
 * extension is only for a human reading the bucket: the route serves the stored mime type,
 * and the URL Meta and TikTok hold is still /api/uploads/<id>.
 */
export function objectPathFor(creatorId: string | null, id: string, mimeType: string): string {
    if (!UUID.test(id)) throw new Error(`Not an upload id: ${JSON.stringify(id)}`);
    const folder = creatorId && UUID.test(creatorId) ? creatorId.toLowerCase() : 'unassigned';
    return `${folder}/${id.toLowerCase()}${EXTENSIONS[mimeType] ?? ''}`;
}

/** Supabase said no, or could not be reached (`status` 0). */
export class StorageApiError extends Error {
    constructor(
        /** The status Supabase meant: the body's `statusCode` when it sent one, else the HTTP status. 0 = unreachable. */
        readonly status: number,
        /** Supabase's error code, e.g. `NoSuchBucket`, `InvalidJWT`. */
        readonly code: string | null,
        message: string,
    ) {
        super(message);
        this.name = 'StorageApiError';
    }

    get notFound(): boolean {
        return this.status === 404 || this.code === 'NoSuchBucket' || this.code === 'NoSuchKey';
    }

    get conflict(): boolean {
        return this.status === 409 || this.code === 'BucketAlreadyExists' || this.code === 'ResourceAlreadyExists';
    }

    /** The key was refused: wrong key, wrong project, or not privileged enough. */
    get refused(): boolean {
        return this.status === 401 || this.status === 403 || this.code === 'InvalidJWT' || this.code === 'AccessDenied';
    }

    get unreachable(): boolean {
        return this.status === 0;
    }
}

async function errorFrom(response: Response, action: string): Promise<StorageApiError> {
    let body: any = null;
    try {
        body = JSON.parse(await response.text());
    } catch {
        // Not JSON — a gateway page, or nothing at all. The HTTP status is all there is.
    }
    const claimed = Number.parseInt(String(body?.statusCode ?? ''), 10);
    const status = Number.isFinite(claimed) && claimed >= 100 ? claimed : response.status;
    const code = typeof body?.code === 'string' ? body.code : (typeof body?.error === 'string' ? body.error : null);
    const said = typeof body?.message === 'string' ? body.message : `HTTP ${response.status}`;
    return new StorageApiError(status, code, `Supabase Storage refused to ${action}: ${said}`);
}

function unreachable(err: unknown, action: string): StorageApiError {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'it did not answer in time'
        : (e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'no answer');
    return new StorageApiError(0, null, `Could not reach Supabase Storage to ${action}: ${why}`);
}

export interface StorageClientOptions {
    /** The project's origin, `https://abcd1234.supabase.co`. */
    url: string;
    key: string;
    bucket?: string;
    fetchImpl?: StorageFetch;
}

export interface BucketInfo {
    id: string;
    public: boolean;
}

export interface ObjectStream {
    body: Readable;
    /** The object's length when Supabase sent it unencoded, else null. */
    length: number | null;
}

export class SupabaseStorageClient {
    readonly bucket: string;
    private readonly base: string;
    private readonly key: string;
    private readonly fetchImpl: StorageFetch | null;

    constructor(options: StorageClientOptions) {
        this.base = `${options.url.replace(/\/+$/, '')}/storage/v1`;
        this.key = options.key;
        this.bucket = options.bucket ?? MEDIA_BUCKET;
        this.fetchImpl = options.fetchImpl ?? null;
    }

    private objectUrl(prefix: string, path: string): string {
        const encoded = path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
        return `${this.base}${prefix}/${encodeURIComponent(this.bucket)}/${encoded}`;
    }

    private async send(url: string, init: RequestInit, action: string): Promise<Response> {
        // Resolved per request, not at construction, so a client kept for the life of an
        // instance still sees a test's override.
        const send = this.fetchImpl ?? fetchOverride ?? fetch;
        try {
            return await send(url, init);
        } catch (err) {
            throw unreachable(err, action);
        }
    }

    private headers(extra: Record<string, string> = {}): Record<string, string> {
        return { ...storageAuthHeaders(this.key), ...extra };
    }

    /** The bucket, or null when it does not exist. */
    async getBucket(): Promise<BucketInfo | null> {
        const response = await this.send(`${this.base}/bucket/${encodeURIComponent(this.bucket)}`, {
            method: 'GET',
            headers: this.headers(),
            signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
        }, 'read the bucket');
        if (!response.ok) {
            const err = await errorFrom(response, 'read the bucket');
            if (err.notFound) return null;
            throw err;
        }
        const body = await response.json().catch(() => ({})) as { id?: unknown; public?: unknown };
        return { id: typeof body.id === 'string' ? body.id : this.bucket, public: body.public === true };
    }

    /**
     * Create the bucket, public. Public because the objects are exactly as public as the
     * /api/uploads/<id> URLs that serve them — anyone holding the id could already fetch them —
     * and it keeps a public URL available. The app itself always reads with the key.
     */
    async createBucket(): Promise<void> {
        const response = await this.send(`${this.base}/bucket`, {
            method: 'POST',
            headers: this.headers({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ id: this.bucket, name: this.bucket, public: true }),
            signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
        }, 'create the bucket');
        if (response.ok) return;
        const err = await errorFrom(response, 'create the bucket');
        // Someone else created it between our read and this write. That is the outcome we wanted.
        if (err.conflict) return;
        throw err;
    }

    /** Make sure the bucket exists. Returns what was found, and whether this call created it. */
    async ensureBucket(): Promise<{ created: boolean; public: boolean }> {
        const existing = await this.getBucket();
        if (existing) return { created: false, public: existing.public };
        await this.createBucket();
        return { created: true, public: true };
    }

    /**
     * Upload bytes to `path`. `upsert: false` refuses to overwrite: a path names one upload, and
     * finding something already there is a bug worth an error rather than a silent replace.
     */
    async upload(path: string, data: Buffer, contentType: string, options: { upsert?: boolean } = {}): Promise<void> {
        const response = await this.send(this.objectUrl('/object', path), {
            method: 'POST',
            headers: this.headers({
                'Content-Type': contentType,
                // Each path is a fresh uuid, so the bytes behind it never change.
                'Cache-Control': 'max-age=31536000',
                'x-upsert': options.upsert ? 'true' : 'false',
            }),
            body: data,
            signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        }, 'upload the file');
        if (!response.ok) throw await errorFrom(response, 'upload the file');
        await response.body?.cancel().catch(() => undefined);
    }

    /** The whole object, or null when it does not exist. For the few callers that need all of it. */
    async download(path: string): Promise<Buffer | null> {
        const response = await this.send(this.objectUrl('/object/authenticated', path), {
            method: 'GET',
            headers: this.headers({ 'Accept-Encoding': 'identity' }),
            signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        }, 'download the file');
        if (!response.ok) {
            const err = await errorFrom(response, 'download the file');
            if (err.notFound) return null;
            throw err;
        }
        return Buffer.from(await response.arrayBuffer());
    }

    /**
     * The object as a stream, or null when it does not exist.
     *
     * Only the wait for the first byte is timed. A timeout on the whole fetch would cut off a
     * slow client halfway through a video; once the body flows, the route's own duration is the
     * bound. `identity` because a compressed transfer would make Content-Length describe bytes
     * the client never sees.
     */
    async openStream(path: string): Promise<ObjectStream | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('first byte timeout')), FIRST_BYTE_TIMEOUT_MS);
        let response: Response;
        try {
            response = await this.send(this.objectUrl('/object/authenticated', path), {
                method: 'GET',
                headers: this.headers({ 'Accept-Encoding': 'identity' }),
                signal: controller.signal,
            }, 'read the file');
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            const err = await errorFrom(response, 'read the file');
            if (err.notFound) return null;
            throw err;
        }
        if (!response.body) throw new StorageApiError(502, null, 'Supabase Storage sent the file with no body.');

        const encoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
        const declared = Number(response.headers.get('content-length'));
        const length = encoding === 'identity' && response.headers.has('content-length')
            && Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
        return { body: Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), length };
    }

    /**
     * Delete these objects. A path that is already gone is not an error — Supabase just leaves it
     * out of the list it returns — so a retried delete is harmless. Returns how many Supabase
     * reported deleting.
     */
    async remove(paths: readonly string[]): Promise<number> {
        let removed = 0;
        for (let i = 0; i < paths.length; i += MAX_REMOVE_PER_REQUEST) {
            const chunk = paths.slice(i, i + MAX_REMOVE_PER_REQUEST);
            const response = await this.send(`${this.base}/object/${encodeURIComponent(this.bucket)}`, {
                method: 'DELETE',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ prefixes: chunk }),
                signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
            }, 'delete files');
            if (!response.ok) throw await errorFrom(response, 'delete files');
            const body = await response.json().catch(() => []);
            removed += Array.isArray(body) ? body.length : 0;
        }
        return removed;
    }
}
