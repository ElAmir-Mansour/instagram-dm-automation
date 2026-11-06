/**
 * Cloudflare R2, over its S3-compatible API. The one place this app talks to it, and the ONE place a request to it is sent (`send`), which counts
 * the request against R2's free tier first (`r2Usage.ts`): nothing here can reach Cloudflare without a reserved operation.
 *
 *   endpoint   `https://<account id>.r2.cloudflarestorage.com`, path-style `/<bucket>/<key>`, region `auto`, service `s3`
 *   signing    SigV4 (`awsSigV4.ts`); a presigned upload for browsers and the Mac worker, `Authorization` headers for the server's own calls
 *   buckets    private always. Every byte is served through this app's own `/api/uploads/<id>`, so no public bucket and no `r2.dev` URL is needed
 *   errors     `StorageApiError` like Supabase's: `status` from HTTP, `code` from the S3 XML `<Code>`, status 0 = unreachable
 *
 * Operation classes (https://developers.cloudflare.com/r2/pricing/): Class A = PutObject, CreateBucket, PutBucketCors, ListObjectsV2, presigned
 * upload (counted when signed); Class B = GetObject, HeadObject, HeadBucket, GetBucketCors. DeleteObject(s) is free and not counted.
 *
 * Paths given to this client are KEYS (no `r2:` prefix: the store strips it).
 *
 * `fetch` is the same swappable one as Supabase's (`setStorageFetch`), so a test answers for both. Nothing here logs a request: the key is in its headers.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { encodePath, hashPayload, presignQuery, signHeaders, uriEncode } from './awsSigV4.js';
import { r2Guard, type R2Guard } from './r2Usage.js';
import type { R2Config } from './appSettings.js';
import {
    MAX_REMOVE_PER_REQUEST, SIGNED_UPLOAD_TTL_MS, SERVER_USER_AGENT, StorageApiError, storageFetchOverride,
    type BucketInfo, type ObjectStorageClient, type ObjectStream, type SignedUpload, type StorageFetch,
} from './supabaseStorage.js';

export const R2_REGION = 'auto';
const JSON_TIMEOUT_MS = 10_000;
const TRANSFER_TIMEOUT_MS = 120_000;
const FIRST_BYTE_TIMEOUT_MS = 15_000;

/**
 * The CORS policy to paste in Cloudflare (R2 → the bucket → Settings → CORS Policy) when the token may not set it itself. Needed ONLY for the browser's
 * direct upload of ad media; the server's own uploads and the Mac worker send no Origin and need no CORS.
 */
export function r2CorsPolicy(origin: string): string {
    return JSON.stringify([{ AllowedOrigins: [origin], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }], null, 2);
}

export function r2Host(accountId: string): string {
    return `${accountId.toLowerCase()}.r2.cloudflarestorage.com`;
}

const xmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const xmlUnescape = (value: string): string => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string): string | null => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
    return m ? xmlUnescape(m[1]!) : null;
};

const HINTS: Readonly<Record<string, string>> = {
    SignatureDoesNotMatch: ' Check the Secret Access Key and the Account ID.',
    InvalidAccessKeyId: ' Check the Access Key ID.',
    AccessDenied: ' The API token may not have access to this bucket: use "Object Read & Write" on it.',
};

async function errorFrom(response: Response, action: string): Promise<StorageApiError> {
    let xml = '';
    try {
        xml = await response.text();
    } catch {
        // no body: the HTTP status is all there is
    }
    const code = tag(xml, 'Code');
    const said = tag(xml, 'Message') ?? `HTTP ${response.status}`;
    return new StorageApiError(response.status, code, `Cloudflare R2 refused to ${action}: ${said}.${code ? (HINTS[code] ?? '') : ''}`.replace(/\.\./g, '.'));
}

function unreachable(err: unknown, action: string): StorageApiError {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const why = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'it did not answer in time'
        : (e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'no answer');
    return new StorageApiError(0, null, `Could not reach Cloudflare R2 to ${action}: ${why}`);
}

export interface R2ClientOptions extends R2Config {
    fetchImpl?: StorageFetch;
    /** Counts every request before it is sent. Defaults to the database-backed guard every instance shares. */
    guard?: R2Guard;
    /** The clock, for signing. */
    now?: () => Date;
}

/** A browser's direct upload needs the bucket to allow the app's origin (`ensureCors`). */
export interface CorsOutcome { changed: boolean }

export class R2StorageClient implements ObjectStorageClient {
    readonly bucket: string;
    private readonly host: string;
    private readonly creds: { accessKeyId: string; secretAccessKey: string };
    private readonly fetchImpl: StorageFetch | null;
    private readonly guardOption: R2Guard | null;
    private readonly now: () => Date;

    constructor(options: R2ClientOptions) {
        this.host = r2Host(options.accountId);
        this.bucket = options.bucket;
        this.creds = { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey };
        this.fetchImpl = options.fetchImpl ?? null;
        this.guardOption = options.guard ?? null;
        this.now = options.now ?? (() => new Date());
    }

    private get guard(): R2Guard {
        return this.guardOption ?? r2Guard();
    }

    /** `/<bucket>` or `/<bucket>/<key>`, unencoded. */
    private pathOf(key?: string): string {
        return key === undefined ? `/${this.bucket}` : `/${this.bucket}/${key}`;
    }

    private urlOf(path: string, query: Readonly<Record<string, string>> = {}): string {
        const qs = Object.entries(query).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&');
        return `https://${this.host}${encodePath(path)}${qs ? `?${qs}` : ''}`;
    }

    /**
     * THE send. Counts the operation first (throws `R2LimitError` / `R2CounterError` without sending), signs, and sends; a connection that gave no answer
     * is a `StorageApiError` with status 0. `cls` null is for the free deletes only.
     */
    private async send(
        cls: 'A' | 'B' | null, action: string, method: string, key: string | undefined,
        options: { query?: Record<string, string>; body?: Buffer | string; headers?: Record<string, string>; signal: AbortSignal; bodyHash?: string },
    ): Promise<Response> {
        if (cls) await this.guard.reserve(cls);
        const path = this.pathOf(key);
        const query = options.query ?? {};
        const body = options.body;
        const payloadHash = options.bodyHash ?? hashPayload(body ?? '');
        const headers = signHeaders({
            ...this.creds, region: R2_REGION, service: 's3', method, path, query, now: this.now(), payloadHash,
            headers: { host: this.host },
        });
        // `host` was signed; fetch sets the same one from the URL, and is not told it twice.
        const { host: _signedHost, ...wire } = headers;
        const send = this.fetchImpl ?? storageFetchOverride() ?? fetch;
        try {
            return await send(this.urlOf(path, query), {
                method,
                headers: { ...wire, ...(options.headers ?? {}), 'user-agent': SERVER_USER_AGENT },
                body: body as RequestInit['body'],
                signal: options.signal,
            });
        } catch (err) {
            throw unreachable(err, action);
        }
    }

    /**
     * The bucket, or null when it does not exist. HeadBucket (Class B); a token limited to one bucket's objects may be refused that, so a 403 is
     * answered by listing one key instead (Class A), which an "Object Read" token is allowed.
     */
    async getBucket(): Promise<BucketInfo | null> {
        const head = await this.send('B', 'read the bucket', 'HEAD', undefined, { signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
        if (head.ok) return { id: this.bucket, public: false };
        if (head.status === 404) return null;
        if (head.status !== 403) throw await errorFrom(head, 'read the bucket');
        const list = await this.send('A', 'read the bucket', 'GET', undefined, {
            query: { 'list-type': '2', 'max-keys': '1' }, signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
        });
        if (list.ok) {
            await list.body?.cancel().catch(() => undefined);
            return { id: this.bucket, public: false };
        }
        const err = await errorFrom(list, 'read the bucket');
        if (err.code === 'NoSuchBucket' || err.status === 404) return null;
        throw err;
    }

    /**
     * HeadBucket is enough. The owner's token is least-privilege ("Object Read & Write" on the one bucket), which cannot create buckets, so a missing
     * bucket is NOT created: it is a clear instruction to create it in Cloudflare first (`NoSuchBucket`, 404). `created` is always false.
     */
    async ensureBucket(): Promise<{ created: boolean; public: boolean }> {
        const existing = await this.getBucket();
        if (!existing) {
            throw new StorageApiError(404, 'NoSuchBucket', `Create the bucket '${this.bucket}' in Cloudflare first (R2 → Create bucket), then save again.`);
        }
        return { created: false, public: false };
    }

    /**
     * Best effort: make sure the browser may PUT to this bucket from `origins` (the app's public origin) and read it. Reads the CORS rules first
     * (Class B) and leaves them alone when they already allow every origin for PUT; otherwise PutBucketCors (Class A) REPLACES them with one rule for
     * these origins. A least-privilege token may not do this (AccessDenied / 403): the caller keeps going and shows `r2CorsPolicy` to set by hand.
     */
    async ensureCors(origins: readonly string[]): Promise<CorsOutcome> {
        const wanted = [...new Set(origins)];
        const current = await this.send('B', 'read the CORS rules', 'GET', undefined, { query: { cors: '' }, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
        if (current.ok) {
            const xml = await current.text();
            const rules = xml.split('<CORSRule>').slice(1);
            const covers = (origin: string) => rules.some((rule) => {
                const allowed = [...rule.matchAll(/<AllowedOrigin>([\s\S]*?)<\/AllowedOrigin>/g)].map((m) => xmlUnescape(m[1]!));
                const methods = [...rule.matchAll(/<AllowedMethod>([\s\S]*?)<\/AllowedMethod>/g)].map((m) => m[1]);
                return (allowed.includes(origin) || allowed.includes('*')) && methods.includes('PUT');
            });
            if (wanted.every(covers)) return { changed: false };
        } else {
            const err = await errorFrom(current, 'read the CORS rules');
            if (err.code !== 'NoSuchCORSConfiguration' && err.status !== 404) throw err;
        }
        const body = '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule>'
            + wanted.map((o) => `<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`).join('')
            + '<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>'
            + '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>'
            + '</CORSRule></CORSConfiguration>';
        const put = await this.send('A', 'set the CORS rules', 'PUT', undefined, {
            query: { cors: '' }, body, headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(body).digest('base64') },
            signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
        });
        if (!put.ok) throw await errorFrom(put, 'set the CORS rules');
        await put.body?.cancel().catch(() => undefined);
        return { changed: true };
    }

    /** PutObject (Class A). A path names one upload: nothing overwrites it on purpose, so `upsert` is accepted and ignored. */
    async upload(path: string, data: Buffer, contentType: string): Promise<void> {
        const response = await this.send('A', 'upload the file', 'PUT', path, {
            body: data,
            headers: { 'content-type': contentType, 'cache-control': 'max-age=31536000' },
            signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
        });
        if (!response.ok) throw await errorFrom(response, 'upload the file');
        await response.body?.cancel().catch(() => undefined);
    }

    /**
     * A presigned PUT, valid 2 hours (SigV4 query-string authentication): `url` carries its own signature, so the holder needs no key. Counted as ONE Class A
     * now, when it is signed, because the PUT is made by the browser or the worker and this app never sees it. Only `host` is signed, so a plain
     * PUT with a `content-type` header works. Nothing is sent to Cloudflare here.
     */
    async createSignedUploadUrl(path: string, contentType: string): Promise<SignedUpload> {
        await this.guard.reserve('A');
        const now = this.now();
        const full = this.pathOf(path);
        const query = presignQuery({
            ...this.creds, region: R2_REGION, service: 's3', method: 'PUT', path: full, host: this.host, now,
            expiresSeconds: SIGNED_UPLOAD_TTL_MS / 1000,
        });
        return {
            url: `https://${this.host}${encodePath(full)}?${query}`,
            headers: { 'content-type': contentType },
            expiresAt: new Date(now.getTime() + SIGNED_UPLOAD_TTL_MS).toISOString(),
        };
    }

    /** HeadObject (Class B): what is stored at `path`, or null when nothing is. */
    async headObject(path: string): Promise<{ size: number | null; contentType: string | null } | null> {
        const response = await this.send('B', 'check the file', 'HEAD', path, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(JSON_TIMEOUT_MS) });
        if (response.status === 404) return null;
        if (!response.ok) throw await errorFrom(response, 'check the file');
        const size = Number(response.headers.get('content-length'));
        const type = response.headers.get('content-type');
        return {
            size: response.headers.has('content-length') && Number.isSafeInteger(size) && size >= 0 ? size : null,
            contentType: type ? type.split(';')[0]!.trim().toLowerCase() : null,
        };
    }

    /** GetObject (Class B): the whole object, or null when it does not exist. */
    async download(path: string): Promise<Buffer | null> {
        const response = await this.send('B', 'download the file', 'GET', path, { headers: { 'accept-encoding': 'identity' }, signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
        if (!response.ok) {
            const err = await errorFrom(response, 'download the file');
            if (err.notFound) return null;
            throw err;
        }
        return Buffer.from(await response.arrayBuffer());
    }

    /** GetObject (Class B), as a stream; with `range` (inclusive) only those bytes. Only the wait for the first byte is timed. */
    async openStream(path: string, range?: { start: number; end: number }): Promise<ObjectStream | null> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('first byte timeout')), FIRST_BYTE_TIMEOUT_MS);
        let response: Response;
        try {
            response = await this.send('B', 'read the file', 'GET', path, {
                headers: range ? { 'accept-encoding': 'identity', range: `bytes=${range.start}-${range.end}` } : { 'accept-encoding': 'identity' },
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            const err = await errorFrom(response, 'read the file');
            if (err.notFound) return null;
            throw err;
        }
        if (!response.body) throw new StorageApiError(502, null, 'Cloudflare R2 sent the file with no body.');
        const encoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
        const declared = Number(response.headers.get('content-length'));
        const length = encoding === 'identity' && response.headers.has('content-length') && Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
        const partial = range !== undefined && response.status === 206;
        return { body: Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), length, partial };
    }

    /**
     * DeleteObjects, up to 1000 keys a request (free: not counted, never refused by the limits). A key that is already gone is not an error, so a
     * retried delete is harmless. Returns how many keys were asked for and not reported as failed.
     */
    async remove(paths: readonly string[]): Promise<number> {
        let removed = 0;
        for (let i = 0; i < paths.length; i += MAX_REMOVE_PER_REQUEST) {
            const chunk = paths.slice(i, i + MAX_REMOVE_PER_REQUEST);
            const body = `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${chunk.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')}</Delete>`;
            const response = await this.send(null, 'delete files', 'POST', undefined, {
                query: { delete: '' }, body,
                headers: { 'content-type': 'application/xml', 'content-md5': createHash('md5').update(body).digest('base64') },
                signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
            });
            if (!response.ok) throw await errorFrom(response, 'delete files');
            const xml = await response.text().catch(() => '');
            const failures = [...xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].map((m) => ({ code: tag(m[1]!, 'Code'), message: tag(m[1]!, 'Message') })).filter((f) => f.code !== 'NoSuchKey');
            if (failures.length > 0) {
                throw new StorageApiError(500, failures[0]!.code, `Cloudflare R2 refused to delete ${failures.length} file(s): ${failures[0]!.message ?? failures[0]!.code}`);
            }
            removed += chunk.length;
        }
        return removed;
    }
}
