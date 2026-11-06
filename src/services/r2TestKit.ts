/**
 * Test doubles for the Cloudflare R2 work: an in-memory database for the statements the media store, the usage counters and the copy job run, an
 * in-memory R2 (an S3 endpoint over the swappable `fetch`), and an in-memory Supabase Storage. Used by the `r2*.test.ts` files only; no network, no database.
 *
 * R2 here verifies what a real one would refuse at once and a mistake would hide: the request is SigV4-signed with the right scope and the
 * payload hash header matches the body. It does not recompute the signature (`awsSigV4.test.ts` proves that against AWS's published examples).
 */
import { createHash } from 'node:crypto';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { RESERVE_SQL } from './r2Usage.js';
import { setStorageFetch } from './supabaseStorage.js';

export const ACCOUNT = '0123456789abcdef0123456789abcdef';
export const R2_HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
export const R2_BUCKET = 'media';
export const R2_KEY_ID = 'AKIAEXAMPLE0123456789abcdef012345';
export const R2_SECRET = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY0123456789abcdef0123';
export const SUPABASE = 'https://abcd1234.supabase.co';
export const SUPABASE_KEY = 'sb_secret_0123456789abcdefghijKLMNOP';
export const CREATOR = '11111111-1111-4111-8111-111111111111';

export interface MediaRow {
    id: string; creator_id: string | null; filename: string; mime_type: string;
    data: Buffer | null; storage_path: string | null; size_bytes: string | null; is_private?: boolean;
}

export class FakeDb {
    settings = new Map<string, { value: string; is_secret: boolean }>();
    media = new Map<string, MediaRow>();
    queue = new Map<string, { attempts: number; last_error: string | null }>();
    statements: string[] = [];
    audits: Array<{ action: string; detail: any }> = [];
    /** A statement matching this throws: a database that is down. */
    failOn: RegExp | null = null;
    private original = pool.query;

    /** Plain settings, and secrets stored encrypted as the app stores them. */
    set(key: string, value: string, secret = false): void {
        this.settings.set(key, { value: secret ? encryptSecret(value) : value, is_secret: secret });
    }

    configureSupabase(): void {
        this.set('storage.supabase_url', SUPABASE);
        this.set('storage.supabase_service_key', SUPABASE_KEY, true);
    }

    configureR2(extra: { bucket?: string } = {}): void {
        this.set('storage.r2_account_id', ACCOUNT);
        this.set('storage.r2_bucket', extra.bucket ?? R2_BUCKET);
        this.set('storage.r2_access_key_id', R2_KEY_ID);
        this.set('storage.r2_secret_access_key', R2_SECRET, true);
    }

    counters(month: string): { a: number; b: number } {
        const row = this.settings.get(`storage.r2_usage.${month}`);
        return row ? JSON.parse(row.value) : { a: 0, b: 0 };
    }

    setCounters(month: string, a: number, b: number): void {
        this.settings.set(`storage.r2_usage.${month}`, { value: JSON.stringify({ a, b }), is_secret: false });
    }

    addMedia(row: Partial<MediaRow> & { id: string }): MediaRow {
        const full: MediaRow = {
            creator_id: CREATOR, filename: 'f', mime_type: 'video/mp4', data: null, storage_path: null, size_bytes: null, ...row,
        };
        this.media.set(full.id, full);
        return full;
    }

    install(): () => void {
        this.original = pool.query;
        this.statements = [];
        (pool as unknown as { query: unknown }).query = (sql: string, params: any[] = []) => this.query(sql, params);
        return () => { (pool as unknown as { query: unknown }).query = this.original; };
    }

    async query(sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> {
        const flat = sql.replace(/\s+/g, ' ').trim();
        this.statements.push(flat);
        if (this.failOn && this.failOn.test(flat)) throw new Error('connection to the database was lost');
        const rows = (list: any[]) => ({ rows: list, rowCount: list.length });
        const none = rows([]);

        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(flat)) {
            const row = this.settings.get(String(params[0]));
            return rows(row ? [row] : []);
        }
        if (/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/.test(flat)) {
            return rows((params[0] as string[]).flatMap((k) => { const r = this.settings.get(k); return r ? [{ key: k, ...r }] : []; }));
        }
        if (/^SELECT value FROM app_settings WHERE key = \$1$/.test(flat)) {
            const row = this.settings.get(String(params[0]));
            return rows(row ? [{ value: row.value }] : []);
        }
        if (/^INSERT INTO app_settings \(key, value, is_secret, updated_at\) SELECT/.test(flat)) {
            // RESERVE_SQL, atomic: this whole branch runs without an await, as one Postgres statement does.
            if (flat !== RESERVE_SQL.replace(/\s+/g, ' ').trim()) throw new Error('the reserve statement changed: update this double');
            const [key, addA, addB, limitA, limitB] = params as [string, number, number, number, number];
            const existing = this.settings.get(key);
            if (!existing) {
                if ((addA !== 0 && addA > limitA) || (addB !== 0 && addB > limitB)) return none;
                const value = JSON.stringify({ a: addA, b: addB });
                this.settings.set(key, { value, is_secret: false });
                return rows([{ value }]);
            }
            const now = JSON.parse(existing.value) as { a: number; b: number };
            if ((addA !== 0 && now.a + addA > limitA) || (addB !== 0 && now.b + addB > limitB)) return none;
            const value = JSON.stringify({ a: now.a + addA, b: now.b + addB });
            this.settings.set(key, { value, is_secret: false });
            return rows([{ value }]);
        }
        if (/^INSERT INTO app_settings/.test(flat)) {
            this.settings.set(String(params[0]), { value: String(params[1]), is_secret: params[2] === true });
            return { rows: [], rowCount: 1 };
        }
        if (/^DELETE FROM app_settings WHERE key = \$1$/.test(flat)) {
            return { rows: [], rowCount: this.settings.delete(String(params[0])) ? 1 : 0 };
        }
        if (/^SELECT COALESCE\(SUM\(size_bytes\), 0\) AS bytes FROM media_uploads WHERE storage_path LIKE 'r2:%'$/.test(flat)) {
            const total = [...this.media.values()].filter((m) => m.storage_path?.startsWith('r2:')).reduce((n, m) => n + Number(m.size_bytes ?? 0), 0);
            return rows([{ bytes: String(total) }]);
        }
        if (/^SELECT mime_type, storage_path, size_bytes, /.test(flat)) {
            const row = this.media.get(String(params[0]));
            if (!row) return none;
            const storageFirst = /CASE WHEN storage_path IS NULL THEN data END AS data/.test(flat);
            return rows([{
                mime_type: row.mime_type, storage_path: row.storage_path, size_bytes: row.size_bytes,
                data: storageFirst && row.storage_path ? null : row.data,
                ...(/\bis_private\b/.test(flat) ? { is_private: row.is_private ?? false, creator_id: row.creator_id } : {}),
            }]);
        }
        if (/^INSERT INTO media_uploads \(id, creator_id, filename, mime_type, data, storage_path, size_bytes(, is_private)?\) VALUES/.test(flat)) {
            const [id, creator_id, filename, mime_type, storage_path, size] = params;
            this.media.set(id, { id, creator_id, filename, mime_type, data: null, storage_path, size_bytes: String(size), ...(/is_private/.test(flat) ? { is_private: true } : {}) });
            return rows([{ id }]);
        }
        if (/^INSERT INTO media_uploads \(creator_id, filename, mime_type, data, size_bytes/.test(flat)) {
            const id = `00000000-0000-4000-8000-${String(this.media.size + 1).padStart(12, '0')}`;
            const [creator_id, filename, mime_type, data, size] = params;
            this.media.set(id, { id, creator_id, filename, mime_type, data, storage_path: null, size_bytes: String(size) });
            return rows([{ id }]);
        }
        if (/^INSERT INTO audit_log/.test(flat)) {
            this.audits.push({ action: String(params[2]), detail: typeof params[5] === 'string' ? JSON.parse(params[5]) : params[5] });
            return rows([{ id: 'audit-1' }]);
        }
        if (/^SELECT id, mime_type, storage_path FROM media_uploads WHERE id = ANY\(\$1::uuid\[\]\) AND creator_id = \$2$/.test(flat)) {
            return rows((params[0] as string[]).flatMap((id) => {
                const r = this.media.get(id);
                return r && r.creator_id === params[1] ? [{ id: r.id, mime_type: r.mime_type, storage_path: r.storage_path }] : [];
            }));
        }
        if (/^SELECT id, size_bytes FROM media_uploads WHERE id = ANY\(\$1::uuid\[\]\)$/.test(flat)) {
            return rows((params[0] as string[]).flatMap((id) => { const r = this.media.get(id); return r ? [{ id: r.id, size_bytes: r.size_bytes }] : []; }));
        }
        if (/^SELECT id, mime_type FROM media_uploads WHERE id = ANY/.test(flat)) {
            return rows((params[0] as string[]).flatMap((id) => { const r = this.media.get(id); return r ? [{ id: r.id, mime_type: r.mime_type }] : []; }));
        }
        if (/FROM media_uploads/.test(flat) && /storage_files/.test(flat)) {
            const all = [...this.media.values()];
            const r2 = all.filter((m) => m.storage_path?.startsWith('r2:'));
            const sup = all.filter((m) => m.storage_path && !m.storage_path.startsWith('r2:'));
            const sum = (l: MediaRow[]) => String(l.reduce((n, m) => n + Number(m.size_bytes ?? 0), 0));
            return rows([{
                storage_files: String(sup.length), storage_bytes: sum(sup), r2_files: String(r2.length), r2_bytes: sum(r2),
                database_files: String(all.filter((m) => m.data).length), database_bytes: '0', queued: String(this.queue.size),
            }]);
        }
        if (/^SELECT count\(\*\) FILTER \(WHERE storage_path LIKE 'r2:%'\) AS in_r2/.test(flat)) {
            const all = [...this.media.values()];
            return rows([{
                in_r2: String(all.filter((m) => m.storage_path?.startsWith('r2:')).length),
                elsewhere: String(all.filter((m) => m.storage_path && !m.storage_path.startsWith('r2:')).length),
            }]);
        }
        if (/^SELECT id, storage_path, mime_type, size_bytes FROM media_uploads WHERE storage_path IS NOT NULL AND storage_path NOT LIKE 'r2:%'/.test(flat)) {
            const skip = new Set(params[0] as string[]);
            const limit = Number(/LIMIT (\d+)$/.exec(flat)![1]);
            return rows([...this.media.values()]
                .filter((m) => m.storage_path && !m.storage_path.startsWith('r2:') && !skip.has(m.id))
                .sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit)
                .map((m) => ({ id: m.id, storage_path: m.storage_path, mime_type: m.mime_type, size_bytes: m.size_bytes })));
        }
        if (/^UPDATE media_uploads SET storage_path = \$3 WHERE id = \$1 AND storage_path = \$2$/.test(flat)) {
            const row = this.media.get(String(params[0]));
            if (!row || row.storage_path !== params[1]) return { rows: [], rowCount: 0 };
            row.storage_path = String(params[2]);
            return { rows: [], rowCount: 1 };
        }
        if (/^SELECT storage_path FROM media_uploads WHERE id = \$1$/.test(flat)) {
            const row = this.media.get(String(params[0]));
            return rows(row ? [{ storage_path: row.storage_path }] : []);
        }
        if (/^SELECT storage_path FROM media_object_deletions/.test(flat)) {
            return rows([...this.queue.keys()].slice(0, Number(params[0])).map((storage_path) => ({ storage_path })));
        }
        if (/^DELETE FROM media_object_deletions WHERE storage_path = ANY/.test(flat)) {
            let n = 0;
            for (const path of params[0] as string[]) if (this.queue.delete(path)) n++;
            return { rows: [], rowCount: n };
        }
        if (/^UPDATE media_object_deletions SET attempts = attempts \+ 1, last_error = \$2/.test(flat)) {
            for (const path of params[0] as string[]) {
                const entry = this.queue.get(path);
                if (entry) { entry.attempts++; entry.last_error = String(params[1]); }
            }
            return { rows: [], rowCount: (params[0] as string[]).length };
        }
        throw new Error(`no result arranged for SQL: ${flat}`);
    }
}

// ─── In-memory R2 and Supabase over fetch ────────────────────────────────────────────────────

export interface Seen { method: string; host: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: Buffer | null }

const xml = (status: number, body: string, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { 'content-type': 'application/xml', ...headers } });
const s3Error = (status: number, code: string, message: string) =>
    xml(status, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);

export class FakeStores {
    /** R2: key (inside the bucket) → bytes and type. */
    r2 = new Map<string, { data: Buffer; contentType: string }>();
    r2BucketExists = true;
    /** `ok`; `denied`: every call 403 AccessDenied; `signature`: 403 SignatureDoesNotMatch; `down`: no answer. */
    r2Mode: 'ok' | 'signature' | 'down' = 'ok';
    /** The bucket-level calls a least-privilege token cannot make: HeadBucket answers 403 when `headDenied`, PutBucketCors when `corsDenied`. */
    headDenied = false;
    corsDenied = false;
    cors: string | null = null;
    /** Supabase: `bucket/path` → bytes. `refuse`: every call fails like an exhausted quota. */
    supabase = new Map<string, { data: Buffer; contentType: string }>();
    supabaseMode: 'ok' | 'refuse' = 'ok';
    seen: Seen[] = [];
    private restore: ReturnType<typeof setStorageFetch> = null;

    install(): () => void {
        this.restore = setStorageFetch((input, init) => this.fetch(input, init));
        return () => { setStorageFetch(this.restore); };
    }

    r2Calls(): Seen[] { return this.seen.filter((c) => c.host === R2_HOST); }
    supabaseCalls(): Seen[] { return this.seen.filter((c) => c.host !== R2_HOST); }

    async fetch(input: string, init: RequestInit = {}): Promise<Response> {
        const url = new URL(input);
        const headers: Record<string, string> = {};
        new Headers(init.headers as Record<string, string>).forEach((value, name) => { headers[name] = value; });
        const body = init.body === undefined || init.body === null ? null : Buffer.from(init.body as any);
        const query: Record<string, string> = {};
        url.searchParams.forEach((v, k) => { query[k] = v; });
        const call: Seen = { method: init.method ?? 'GET', host: url.host, path: decodeURIComponent(url.pathname), query, headers, body };
        this.seen.push(call);
        return url.host === R2_HOST ? this.r2Answer(call) : this.supabaseAnswer(call);
    }

    private r2Answer(call: Seen): Response {
        if (this.r2Mode === 'down') throw new TypeError('fetch failed');
        const auth = call.headers['authorization'] ?? '';
        if (!new RegExp(`^AWS4-HMAC-SHA256 Credential=${R2_KEY_ID}/\\d{8}/auto/s3/aws4_request,SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*,Signature=[0-9a-f]{64}$`).test(auth)) {
            return s3Error(403, 'InvalidAccessKeyId', 'the request was not signed as SigV4 for region auto, service s3');
        }
        const payload = call.headers['x-amz-content-sha256'];
        if (payload !== createHash('sha256').update(call.body ?? '').digest('hex')) return s3Error(400, 'XAmzContentSHA256Mismatch', 'the payload hash does not match the body');
        if (this.r2Mode === 'signature') return s3Error(403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided');

        const prefix = `/${R2_BUCKET}`;
        if (call.path !== prefix && !call.path.startsWith(`${prefix}/`)) return s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist');
        const key = call.path === prefix ? null : call.path.slice(prefix.length + 1);

        if (key === null) {
            if (call.method === 'HEAD') return this.headDenied ? new Response(null, { status: 403 }) : new Response(null, { status: this.r2BucketExists ? 200 : 404 });
            if (!this.r2BucketExists) return s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist');
            if (call.method === 'GET' && 'cors' in call.query) {
                return this.cors === null ? s3Error(404, 'NoSuchCORSConfiguration', 'The CORS configuration does not exist') : xml(200, this.cors);
            }
            if (call.method === 'PUT' && 'cors' in call.query) {
                if (this.corsDenied) return s3Error(403, 'AccessDenied', 'Access Denied');
                this.cors = call.body!.toString();
                return xml(200, '');
            }
            if (call.method === 'GET' && call.query['list-type'] === '2') return xml(200, '<ListBucketResult></ListBucketResult>');
            if (call.method === 'POST' && 'delete' in call.query) {
                for (const m of call.body!.toString().matchAll(/<Key>([\s\S]*?)<\/Key>/g)) this.r2.delete(m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
                return xml(200, '<DeleteResult></DeleteResult>');
            }
            return s3Error(400, 'NotImplemented', 'not arranged');
        }
        if (call.method === 'PUT') {
            this.r2.set(key, { data: call.body ?? Buffer.alloc(0), contentType: call.headers['content-type'] ?? 'application/octet-stream' });
            return xml(200, '', { etag: '"x"' });
        }
        const object = this.r2.get(key);
        if (!object) return call.method === 'HEAD' ? new Response(null, { status: 404 }) : s3Error(404, 'NoSuchKey', 'The specified key does not exist.');
        if (call.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(object.data.length), 'content-type': object.contentType } });
        const range = /^bytes=(\d+)-(\d+)$/.exec(call.headers['range'] ?? '');
        if (range) {
            const slice = object.data.subarray(Number(range[1]), Number(range[2]) + 1);
            return new Response(slice, { status: 206, headers: { 'content-length': String(slice.length), 'content-type': object.contentType, 'content-range': `bytes ${range[1]}-${range[2]}/${object.data.length}` } });
        }
        return new Response(object.data, { status: 200, headers: { 'content-length': String(object.data.length), 'content-type': object.contentType } });
    }

    private supabaseAnswer(call: Seen): Response {
        if (this.supabaseMode === 'refuse') {
            return new Response(JSON.stringify({ statusCode: '402', error: 'exceed_cached_egress_quota', message: 'Egress quota exceeded' }), { status: 402, headers: { 'content-type': 'application/json' } });
        }
        const m = /^\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/.exec(call.path);
        if (call.method === 'GET' && m) {
            const object = this.supabase.get(`${m[1]}/${m[2]}`);
            if (!object) return new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400 });
            return new Response(object.data, { status: 200, headers: { 'content-length': String(object.data.length), 'content-type': object.contentType } });
        }
        if (call.method === 'POST' && m) {
            this.supabase.set(`${m[1]}/${m[2]}`, { data: call.body ?? Buffer.alloc(0), contentType: call.headers['content-type'] ?? '' });
            return new Response(JSON.stringify({ Key: `${m[1]}/${m[2]}` }), { status: 200 });
        }
        const b = /^\/storage\/v1\/bucket\/([^/]+)$/.exec(call.path);
        if (call.method === 'GET' && b) return new Response(JSON.stringify({ id: b[1], public: !b[1]!.includes('private') }), { status: 200 });
        const del = /^\/storage\/v1\/object\/([^/]+)$/.exec(call.path);
        if (call.method === 'DELETE' && del) {
            const prefixes = JSON.parse(call.body!.toString()).prefixes as string[];
            for (const p of prefixes) this.supabase.delete(`${del[1]}/${p}`);
            return new Response(JSON.stringify(prefixes.map((name) => ({ name }))), { status: 200 });
        }
        return new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'not arranged' }), { status: 400 });
    }
}

/** A guard that counts what it is asked and refuses when told to: R2 client tests that are not about the limits. */
export class RecordingGuard {
    calls: Array<{ cls: 'A' | 'B'; n: number }> = [];
    refuse: Error | null = null;
    async reserve(cls: 'A' | 'B', n = 1): Promise<void> {
        if (this.refuse) throw this.refuse;
        this.calls.push({ cls, n });
    }
    count(cls: 'A' | 'B'): number { return this.calls.filter((c) => c.cls === cls).reduce((s, c) => s + c.n, 0); }
}
