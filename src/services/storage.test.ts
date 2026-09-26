/**
 * The media store: Postgres BYTEA, or Supabase Storage (migration v23).
 *
 * No database and no Supabase here. The pool is an in-memory `media_uploads` / `app_settings` /
 * `media_object_deletions`, and Supabase is a fake `fetch` that answers only what each test
 * arranged and records every request — which is what lets the tests pin the things that fail
 * silently in production: which header a key travels in, where an object lands, and that a row
 * is only written once its object is.
 *
 * The URL shape is load-bearing too. Meta cURLs it during ingestion and TikTok only pulls from
 * our verified prefix, so both stores must keep handing out /api/uploads/<id> on our origin.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import {
    getMediaStore, MediaStorageUnavailableError, PostgresMediaStore, removeQueuedMediaObjects, setMediaStore,
    SupabaseStorageMediaStore, uploadIdFromSegment, uploadIdFromUrl, type MediaStore,
} from './storage.js';
import {
    MEDIA_BUCKET, objectPathFor, SERVER_USER_AGENT, setStorageFetch, storageAuthHeaders, storageKeyKind,
    storageKeyProblem, StorageApiError, SupabaseStorageClient,
} from './supabaseStorage.js';

const PROJECT = 'https://abcd1234.supabase.co';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const SECRET_KEY = 'sb_secret_0123456789abcdefghijKLMNOP';

/** An unsigned JWT with this role — enough to tell the legacy keys apart, which is all that is read. */
function jwt(role: string): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ iss: 'supabase', ref: 'abcd1234', role })}.c2lnbmF0dXJl`;
}
const SERVICE_ROLE_KEY = jwt('service_role');

// ─── Fake Supabase ──────────────────────────────────────────────────────────────────────────

interface Call { method: string; path: string; headers: Record<string, string>; body: Buffer | null }
type Answer = (call: Call) => Response | Promise<Response>;

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Supabase's own shape for a failure: HTTP 400, the real status in the body. */
const storageSays = (statusCode: string, error: string, message: string) =>
    json(400, { statusCode, error, code: error, message });

let calls: Call[] = [];
let routes: Array<{ method: string; path: string | RegExp; answer: Answer }> = [];

/** Answer `method path` (a path, or a pattern for one whose uuid the test cannot know). */
function on(method: string, path: string | RegExp, answer: Answer): void {
    routes.push({ method, path, answer });
}

async function fakeFetch(input: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers as Record<string, string>).forEach((value, name) => { headers[name] = value; });
    const body = init.body === undefined || init.body === null ? null : Buffer.from(init.body as any);
    const call: Call = { method: init.method ?? 'GET', path: decodeURIComponent(url.pathname), headers, body };
    calls.push(call);
    const route = routes.find((r) => r.method === call.method
        && (typeof r.path === 'string' ? r.path === call.path : r.path.test(call.path)));
    if (!route) throw new Error(`no answer arranged for ${call.method} ${call.path}`);
    return route.answer(call);
}

/** Any upload into this tenant's folder. */
const TENANT_UPLOAD = new RegExp(`^/storage/v1/object/${MEDIA_BUCKET}/${CREATOR}/[0-9a-f-]{36}\\.[a-z0-9]+$`);
const removedPrefixes = (call: Call) =>
    json(200, JSON.parse(call.body!.toString()).prefixes.map((name: string) => ({ name })));

const OBJECT = (path: string) => `/storage/v1/object/${MEDIA_BUCKET}/${path}`;
const AUTHED = (path: string) => `/storage/v1/object/authenticated/${MEDIA_BUCKET}/${path}`;
const BUCKET = `/storage/v1/bucket/${MEDIA_BUCKET}`;

// ─── Fake database ──────────────────────────────────────────────────────────────────────────

interface MediaRow {
    id: string; creator_id: string | null; filename: string; mime_type: string;
    data: Buffer | null; storage_path: string | null; size_bytes: string | null;
}

let media: Map<string, MediaRow>;
let settings: Map<string, { value: string; is_secret: boolean }>;
let queue: Map<string, { attempts: number; last_error: string | null }>;
let statements: string[];
let failNextInsert = false;
let nextPostgresId = 0;

async function fakeQuery(sql: string, params: any[] = []) {
    const flat = sql.replace(/\s+/g, ' ').trim();
    statements.push(flat);
    const none = { rows: [], rowCount: 0 };

    if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(flat)) {
        const row = settings.get(String(params[0]));
        return row ? { rows: [row], rowCount: 1 } : none;
    }
    if (/^SELECT mime_type, storage_path, size_bytes, /.test(flat)) {
        const row = media.get(String(params[0]));
        if (!row) return none;
        const storageFirst = /CASE WHEN storage_path IS NULL THEN data END AS data/.test(flat);
        return {
            rows: [{
                mime_type: row.mime_type, storage_path: row.storage_path, size_bytes: row.size_bytes,
                data: storageFirst && row.storage_path ? null : row.data,
            }],
            rowCount: 1,
        };
    }
    if (/^INSERT INTO media_uploads \(id, creator_id, filename, mime_type, data, storage_path, size_bytes\) VALUES \(\$1, \$2, \$3, \$4, NULL, \$5, \$6\) RETURNING id$/.test(flat)) {
        if (failNextInsert) { failNextInsert = false; throw new Error('connection reset'); }
        const [id, creator_id, filename, mime_type, storage_path, size] = params;
        media.set(id, { id, creator_id, filename, mime_type, data: null, storage_path, size_bytes: String(size) });
        return { rows: [{ id }], rowCount: 1 };
    }
    if (/^INSERT INTO media_uploads \(creator_id, filename, mime_type, data, size_bytes\)/.test(flat)) {
        const id = `00000000-0000-4000-8000-${String(++nextPostgresId).padStart(12, '0')}`;
        const [creator_id, filename, mime_type, data, size] = params;
        media.set(id, { id, creator_id, filename, mime_type, data, storage_path: null, size_bytes: String(size) });
        return { rows: [{ id }], rowCount: 1 };
    }
    if (/^SELECT id, mime_type FROM media_uploads WHERE id = ANY/.test(flat)) {
        const found = (params[0] as string[]).map((id) => media.get(id)).filter(Boolean) as MediaRow[];
        return { rows: found.map((r) => ({ id: r.id, mime_type: r.mime_type })), rowCount: found.length };
    }
    if (/^SELECT storage_path FROM media_object_deletions/.test(flat)) {
        const paths = [...queue.keys()].slice(0, Number(params[0]));
        return { rows: paths.map((storage_path) => ({ storage_path })), rowCount: paths.length };
    }
    if (/^DELETE FROM media_object_deletions WHERE storage_path = ANY/.test(flat)) {
        let n = 0;
        for (const path of params[0] as string[]) if (queue.delete(path)) n++;
        return { rows: [], rowCount: n };
    }
    if (/^UPDATE media_object_deletions SET attempts = attempts \+ 1, last_error = \$2/.test(flat)) {
        for (const path of params[0] as string[]) {
            const entry = queue.get(path);
            if (entry) { entry.attempts++; entry.last_error = String(params[1]); }
        }
        return { rows: [], rowCount: (params[0] as string[]).length };
    }
    throw new Error(`no result arranged for SQL: ${flat}`);
}

const saved = (url: string | null, key: string | null) => {
    if (url) settings.set('storage.supabase_url', { value: url, is_secret: false });
    if (key) settings.set('storage.supabase_service_key', { value: encryptSecret(key), is_secret: true });
};

const originalQuery = pool.query;
const ENV_NAMES = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TOKEN_ENCRYPTION_KEY'] as const;
let envBefore: Record<string, string | undefined> = {};
let restoreSink: (() => void) | undefined;
let previousFetch: ReturnType<typeof setStorageFetch> = null;
let previousStore: MediaStore | null = null;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    media = new Map();
    settings = new Map();
    queue = new Map();
    statements = [];
    calls = [];
    routes = [];
    failNextInsert = false;
    envBefore = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    (pool as unknown as { query: unknown }).query = fakeQuery;
    previousFetch = setStorageFetch(fakeFetch);
    previousStore = setMediaStore(null);
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    setStorageFetch(previousFetch);
    setMediaStore(previousStore);
    for (const name of ENV_NAMES) {
        if (envBefore[name] === undefined) delete process.env[name];
        else process.env[name] = envBefore[name];
    }
});

const config = (key = SECRET_KEY) => ({ url: PROJECT, key, source: { url: 'database' as const, key: 'database' as const } });

// ─── Keys ───────────────────────────────────────────────────────────────────────────────────

describe('the Storage key, by format', () => {
    it('sends a secret key in apikey ONLY — it is not a JWT, so never as a Bearer token', () => {
        assert.equal(storageKeyKind(SECRET_KEY), 'secret');
        assert.deepEqual(storageAuthHeaders(SECRET_KEY), { apikey: SECRET_KEY, 'User-Agent': SERVER_USER_AGENT });
    });

    it('sends the legacy service_role JWT in apikey and as a Bearer token', () => {
        assert.equal(storageKeyKind(SERVICE_ROLE_KEY), 'legacy_jwt');
        assert.deepEqual(storageAuthHeaders(SERVICE_ROLE_KEY), {
            apikey: SERVICE_ROLE_KEY, 'User-Agent': SERVER_USER_AGENT, Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        });
    });

    it('names itself as a server: Supabase answers 401 to a secret key from a browser User-Agent', () => {
        assert.doesNotMatch(SERVER_USER_AGENT, /mozilla|chrome|safari|applewebkit|gecko/i);
    });

    it('puts those exact headers on the wire, for each format', async () => {
        on('GET', BUCKET, () => json(200, { id: MEDIA_BUCKET, public: true }));

        await new SupabaseStorageClient({ url: PROJECT, key: SECRET_KEY }).getBucket();
        await new SupabaseStorageClient({ url: PROJECT, key: SERVICE_ROLE_KEY }).getBucket();

        const [secret, legacy] = calls;
        assert.equal(secret!.headers.apikey, SECRET_KEY);
        assert.equal(secret!.headers.authorization, undefined, 'a secret key must never be a Bearer token');
        assert.equal(secret!.headers['user-agent'], SERVER_USER_AGENT);
        assert.equal(legacy!.headers.apikey, SERVICE_ROLE_KEY);
        assert.equal(legacy!.headers.authorization, `Bearer ${SERVICE_ROLE_KEY}`);
        assert.equal(legacy!.headers['user-agent'], SERVER_USER_AGENT);
    });

    it('accepts a secret key or a service_role JWT, and names the two public keys when pasted by mistake', () => {
        assert.equal(storageKeyProblem(SECRET_KEY), null);
        assert.equal(storageKeyProblem(SERVICE_ROLE_KEY), null);
        assert.match(storageKeyProblem('sb_publishable_0123456789abcdef')!, /publishable key/);
        assert.match(storageKeyProblem(jwt('anon'))!, /anon key/);
        for (const bad of ['sb_secret_short', 'not-a-key', `${SECRET_KEY} extra`, jwt('authenticated'), 'eyJnot.a.jwt']) {
            assert.ok(storageKeyProblem(bad), bad);
        }
    });
});

describe('where an upload lives in the bucket', () => {
    const id = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';

    it('is <creatorId>/<id><ext>, one folder per tenant', () => {
        assert.equal(objectPathFor(CREATOR, id, 'image/jpeg'), `${CREATOR}/${id}.jpg`);
        assert.equal(objectPathFor(CREATOR, id, 'video/mp4'), `${CREATOR}/${id}.mp4`);
        assert.equal(objectPathFor(CREATOR, id, 'video/quicktime'), `${CREATOR}/${id}.mov`);
        assert.equal(objectPathFor(CREATOR, id, 'application/x-unknown'), `${CREATOR}/${id}`);
        assert.equal(objectPathFor(null, id, 'image/png'), `unassigned/${id}.png`);
    });

    it('refuses anything but a uuid as the file name — the path is built, never passed through', () => {
        assert.throws(() => objectPathFor(CREATOR, '../../etc/passwd', 'image/jpeg'));
        assert.equal(objectPathFor('../evil', id, 'image/jpeg'), `unassigned/${id}.jpg`);
    });
});

// ─── Choosing the store ─────────────────────────────────────────────────────────────────────

describe('getMediaStore', () => {
    it('is Postgres while nothing is configured anywhere', async () => {
        assert.ok((await getMediaStore()) instanceof PostgresMediaStore);
    });

    it('is Supabase Storage once Settings holds a URL and a key', async () => {
        saved(PROJECT, SECRET_KEY);
        const store = await getMediaStore();
        assert.ok(store instanceof SupabaseStorageMediaStore);
        assert.equal((store as SupabaseStorageMediaStore).config.key, SECRET_KEY);
    });

    it('is Supabase Storage from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY when nothing is saved', async () => {
        process.env.SUPABASE_URL = `  ${PROJECT}/  `;
        process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
        const store = await getMediaStore();
        assert.ok(store instanceof SupabaseStorageMediaStore);
        assert.equal((store as SupabaseStorageMediaStore).config.url, PROJECT);
        assert.deepEqual((store as SupabaseStorageMediaStore).config.source, { url: 'env', key: 'env' });
    });

    it('stays Postgres with only half a config — a URL with no key cannot write anything', async () => {
        saved(PROJECT, null);
        assert.ok((await getMediaStore()) instanceof PostgresMediaStore);
        settings.clear();
        process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET_KEY;
        assert.ok((await getMediaStore()) instanceof PostgresMediaStore);
    });

    it('keeps one instance while the config is unchanged, and a new one when the key changes', async () => {
        saved(PROJECT, SECRET_KEY);
        const first = await getMediaStore();
        assert.equal(await getMediaStore(), first);
        saved(null, 'sb_secret_rotated_0123456789abcdef');
        const second = await getMediaStore();
        assert.notEqual(second, first);
        assert.equal((second as SupabaseStorageMediaStore).config.key, 'sb_secret_rotated_0123456789abcdef');
    });

    it('returns a substitute set by a test, without reading any config', async () => {
        const fake: MediaStore = {
            async put() { return { id: 'x' }; },
            async get() { return null; },
            async open() { return null; },
            async mimeTypes() { return new Map(); },
            publicUrl(id, origin) { return `${origin}/api/uploads/${id}`; },
        };
        setMediaStore(fake);
        assert.equal(await getMediaStore(), fake);
        assert.deepEqual(statements, []);
    });
});

// ─── Supabase Storage ───────────────────────────────────────────────────────────────────────

describe('SupabaseStorageMediaStore.put', () => {
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const upload = (store: SupabaseStorageMediaStore) =>
        store.put({ creatorId: CREATOR, filename: 'slide.jpg', mimeType: 'image/jpeg', data: JPEG });

    it('creates the public bucket when it is missing, uploads, then writes the row with data NULL', async () => {
        on('GET', BUCKET, () => storageSays('404', 'NoSuchBucket', 'Bucket not found'));
        on('POST', '/storage/v1/bucket', () => json(200, { name: MEDIA_BUCKET }));
        on('POST', TENANT_UPLOAD, (call) => json(200, { Key: call.path }));
        const store = new SupabaseStorageMediaStore(config());

        const { id } = await upload(store);

        assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a uuid, exactly as before');
        assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [
            `GET ${BUCKET}`, 'POST /storage/v1/bucket', `POST ${OBJECT(`${CREATOR}/${id}.jpg`)}`,
        ]);
        assert.deepEqual(JSON.parse(calls[1]!.body!.toString()), { id: MEDIA_BUCKET, name: MEDIA_BUCKET, public: true });

        const sent = calls[2]!;
        assert.deepEqual(sent.body, JPEG);
        assert.equal(sent.headers['content-type'], 'image/jpeg');
        assert.equal(sent.headers['x-upsert'], 'false', 'a fresh path must never overwrite anything');
        assert.equal(sent.headers.apikey, SECRET_KEY);
        assert.equal(sent.headers.authorization, undefined);

        const row = media.get(id)!;
        assert.equal(row.data, null, 'the bytes are not in Postgres');
        assert.equal(row.storage_path, `${CREATOR}/${id}.jpg`);
        assert.equal(row.size_bytes, String(JPEG.length));
        assert.equal(row.creator_id, CREATOR);
        assert.equal(
            store.publicUrl(id, 'https://msg-response-auto.vercel.app'),
            `https://msg-response-auto.vercel.app/api/uploads/${id}`,
            'the URL Meta and TikTok get is still ours, never the bucket\'s',
        );
    });

    it('uploads with the legacy service_role key too, as a Bearer token', async () => {
        on('GET', BUCKET, () => json(200, { id: MEDIA_BUCKET, public: true }));
        on('POST', TENANT_UPLOAD, (call) => json(200, { Key: call.path }));

        await upload(new SupabaseStorageMediaStore(config(SERVICE_ROLE_KEY)));

        for (const call of calls) {
            assert.equal(call.headers.apikey, SERVICE_ROLE_KEY);
            assert.equal(call.headers.authorization, `Bearer ${SERVICE_ROLE_KEY}`);
        }
    });

    it('checks the bucket once per instance, not on every upload', async () => {
        on('GET', BUCKET, () => json(200, { id: MEDIA_BUCKET, public: true }));
        on('POST', TENANT_UPLOAD, (call) => json(200, { Key: call.path }));
        const store = new SupabaseStorageMediaStore(config());

        await upload(store);
        await upload(store);

        assert.equal(calls.filter((c) => c.path === BUCKET).length, 1);
        assert.equal(calls.filter((c) => TENANT_UPLOAD.test(c.path)).length, 2);
        assert.equal(media.size, 2);
    });

    it('writes no row when the upload is refused', async () => {
        on('GET', BUCKET, () => json(200, { id: MEDIA_BUCKET, public: true }));
        on('POST', TENANT_UPLOAD, () => storageSays('413', 'EntityTooLarge', 'The object exceeded the maximum allowed size'));

        await assert.rejects(upload(new SupabaseStorageMediaStore(config())), /maximum allowed size/);
        assert.equal(media.size, 0);
    });

    it('takes the object back out when its row cannot be written, so nothing is orphaned', async () => {
        on('GET', BUCKET, () => json(200, { id: MEDIA_BUCKET, public: true }));
        on('POST', TENANT_UPLOAD, (call) => json(200, { Key: call.path }));
        on('DELETE', `/storage/v1/object/${MEDIA_BUCKET}`, removedPrefixes);
        failNextInsert = true;

        await assert.rejects(upload(new SupabaseStorageMediaStore(config())), /connection reset/);

        const uploaded = calls.find((c) => TENANT_UPLOAD.test(c.path))!;
        const removed = calls.find((c) => c.method === 'DELETE')!;
        assert.deepEqual(JSON.parse(removed.body!.toString()), { prefixes: [uploaded.path.slice(OBJECT('').length)] });
        assert.equal(media.size, 0);
    });
});

describe('SupabaseStorageMediaStore reads', () => {
    const ID = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
    const LEGACY = '1b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
    const PATH = `${CREATOR}/${ID}.mp4`;
    const VIDEO = Buffer.from('not really a video, but bytes all the same');

    beforeEach(() => {
        media.set(ID, { id: ID, creator_id: CREATOR, filename: 'reel.mp4', mime_type: 'video/mp4', data: null, storage_path: PATH, size_bytes: String(VIDEO.length) });
        media.set(LEGACY, { id: LEGACY, creator_id: CREATOR, filename: 'old.jpg', mime_type: 'image/jpeg', data: Buffer.from('legacy bytes'), storage_path: null, size_bytes: null });
    });

    it('get() downloads a Storage row with the key, from the authenticated endpoint', async () => {
        on('GET', AUTHED(PATH), () => new Response(VIDEO, { status: 200, headers: { 'content-length': String(VIDEO.length) } }));
        const stored = await new SupabaseStorageMediaStore(config()).get(ID);

        assert.deepEqual(stored, { id: ID, mimeType: 'video/mp4', data: VIDEO });
        assert.equal(calls[0]!.headers.apikey, SECRET_KEY);
    });

    it('serves a legacy row from its BYTEA, without asking Supabase anything', async () => {
        const store = new SupabaseStorageMediaStore(config());
        assert.deepEqual(await store.get(LEGACY), { id: LEGACY, mimeType: 'image/jpeg', data: Buffer.from('legacy bytes') });
        assert.deepEqual(await store.open(LEGACY), { kind: 'bytes', id: LEGACY, mimeType: 'image/jpeg', data: Buffer.from('legacy bytes') });
        assert.deepEqual(calls, []);
    });

    it('open() hands back a stream and the length Supabase is sending', async () => {
        on('GET', AUTHED(PATH), (call) => {
            assert.equal(call.headers['accept-encoding'], 'identity', 'a compressed transfer would make Content-Length a lie');
            return new Response(VIDEO, { status: 200, headers: { 'content-length': String(VIDEO.length) } });
        });
        const content = await new SupabaseStorageMediaStore(config()).open(ID);

        assert.equal(content?.kind, 'stream');
        if (content?.kind !== 'stream') return;
        assert.equal(content.size, VIDEO.length);
        assert.equal(content.mimeType, 'video/mp4');
        const received: Buffer[] = [];
        for await (const chunk of content.body!) received.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(received), VIDEO);
    });

    it('answers a HEAD from the row alone: no object is fetched just to count its bytes', async () => {
        const content = await new SupabaseStorageMediaStore(config()).open(ID, { headOnly: true });
        assert.deepEqual(content, { kind: 'stream', id: ID, mimeType: 'video/mp4', size: VIDEO.length, body: null });
        assert.deepEqual(calls, []);
    });

    it('treats Supabase\'s 400-with-statusCode-404 as "no such object", not as a failure', async () => {
        on('GET', AUTHED(PATH), () => storageSays('404', 'not_found', 'Object not found'));
        const store = new SupabaseStorageMediaStore(config());
        assert.equal(await store.open(ID), null);
        assert.equal(await store.get(ID), null);
    });

    it('surfaces a refused key as an error, never as a missing file', async () => {
        on('GET', AUTHED(PATH), () => json(401, { message: 'Invalid API key' }));
        const err = await new SupabaseStorageMediaStore(config()).open(ID).then(() => null, (e) => e);
        assert.ok(err instanceof StorageApiError);
        assert.equal(err.refused, true);
    });

    it('is null for an id with no row', async () => {
        assert.equal(await new SupabaseStorageMediaStore(config()).open('2b8a7a0e-3c1f-4f7e-9d0a-1234567890ab'), null);
    });
});

describe('PostgresMediaStore', () => {
    it('keeps writing BYTEA, and records the size', async () => {
        const { id } = await new PostgresMediaStore().put({
            creatorId: CREATOR, filename: 'a.png', mimeType: 'image/png', data: Buffer.from('png!'),
        });
        const row = media.get(id)!;
        assert.deepEqual(row.data, Buffer.from('png!'));
        assert.equal(row.size_bytes, '4');
        assert.equal(row.storage_path, null);
        assert.deepEqual(calls, []);
    });

    it('refuses to pretend a Storage row is missing when Storage is not configured', async () => {
        const ID = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
        media.set(ID, { id: ID, creator_id: CREATOR, filename: 'r.mp4', mime_type: 'video/mp4', data: null, storage_path: `${CREATOR}/${ID}.mp4`, size_bytes: '10' });
        const store = new PostgresMediaStore();
        await assert.rejects(store.open(ID), MediaStorageUnavailableError);
        await assert.rejects(store.get(ID), MediaStorageUnavailableError);
    });

    it('still serves a row part way through the backfill from the bytes it has', async () => {
        const ID = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
        media.set(ID, { id: ID, creator_id: CREATOR, filename: 'r.jpg', mime_type: 'image/jpeg', data: Buffer.from('both'), storage_path: `${CREATOR}/${ID}.jpg`, size_bytes: '4' });
        assert.deepEqual(await new PostgresMediaStore().open(ID), { kind: 'bytes', id: ID, mimeType: 'image/jpeg', data: Buffer.from('both') });
    });

    it('builds the URL /api/uploads/:id against the origin it is given', () => {
        const store = new PostgresMediaStore();
        assert.equal(store.publicUrl('abc-123', 'https://msg-response-auto.vercel.app'), 'https://msg-response-auto.vercel.app/api/uploads/abc-123');
        assert.equal(store.publicUrl('id', 'http://localhost:3000'), 'http://localhost:3000/api/uploads/id');
    });
});

// ─── Removing the objects of deleted rows ───────────────────────────────────────────────────

describe('removeQueuedMediaObjects', () => {
    const A = `${CREATOR}/aaaaaaaa-0000-4000-8000-000000000001.mp4`;
    const B = `${CREATOR}/aaaaaaaa-0000-4000-8000-000000000002.jpg`;

    beforeEach(() => {
        queue.set(A, { attempts: 0, last_error: null });
        queue.set(B, { attempts: 0, last_error: null });
    });

    it('removes queued objects from the bucket, then — only then — clears them from the queue', async () => {
        saved(PROJECT, SECRET_KEY);
        on('DELETE', `/storage/v1/object/${MEDIA_BUCKET}`, (call) => {
            assert.equal(queue.size, 2, 'nothing leaves the queue before Supabase has answered');
            return removedPrefixes(call);
        });

        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 2, failed: 0, skipped: false });
        assert.deepEqual(JSON.parse(calls[0]!.body!.toString()), { prefixes: [A, B] });
        assert.equal(queue.size, 0);
    });

    it('keeps every entry, counts the attempt and says why, when Supabase refuses', async () => {
        saved(PROJECT, SECRET_KEY);
        on('DELETE', `/storage/v1/object/${MEDIA_BUCKET}`, () => json(503, { message: 'upstream unavailable' }));

        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 0, failed: 2, skipped: false });
        assert.equal(queue.size, 2);
        assert.equal(queue.get(A)!.attempts, 1);
        assert.match(queue.get(A)!.last_error!, /upstream unavailable/);
    });

    it('waits, touching nothing, while there is no Storage config to remove them with', async () => {
        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 0, failed: 0, skipped: true, reason: 'unconfigured', waiting: 2 });
        assert.deepEqual(calls, []);
        assert.equal(queue.size, 2);
    });

    it('asks Supabase nothing when the queue is empty', async () => {
        queue.clear();
        saved(PROJECT, SECRET_KEY);
        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 0, failed: 0, skipped: false });
        assert.deepEqual(calls, []);
    });

    it('never throws — before migration v23 the queue does not exist', async () => {
        (pool as unknown as { query: unknown }).query = async () => {
            throw Object.assign(new Error('relation "media_object_deletions" does not exist'), { code: '42P01' });
        };
        assert.deepEqual(await removeQueuedMediaObjects(), { removed: 0, failed: 0, skipped: true, reason: 'error' });
    });
});

// ─── Our URLs ───────────────────────────────────────────────────────────────────────────────

describe('our upload URLs, with and without an extension', () => {
    const id = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';

    it('reads the id out of the route segment, extension or not', () => {
        // TikTok's photo fetcher is sent `<uuid>.jpg`, and Express 5 hands the route the whole
        // segment — without this the extension turned every photo fetch into a 404.
        assert.equal(uploadIdFromSegment(id), id);
        for (const ext of ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'JPG']) {
            assert.equal(uploadIdFromSegment(`${id}.${ext}`), id, ext);
        }
        assert.equal(uploadIdFromSegment(id.toUpperCase()), id);
    });

    it('still refuses anything that is not a bare uuid plus a known extension', () => {
        // Postgres answers a malformed uuid literal with 22P02, which surfaced as a 500.
        for (const bad of [`${id}.html`, `${id}.jpg.jpg`, `${id}x`, 'not-a-uuid.jpg', '', `../${id}`]) {
            assert.equal(uploadIdFromSegment(bad), null, bad);
        }
        assert.equal(uploadIdFromSegment(undefined), null);
    });

    it('recognises our upload URLs on any host, extension or not', () => {
        assert.equal(uploadIdFromUrl(`https://msg-response-auto.vercel.app/api/uploads/${id}.jpg`), id);
        assert.equal(uploadIdFromUrl(`https://preview-abc.vercel.app/api/uploads/${id}.webp?v=2`), id);
        assert.equal(uploadIdFromUrl(`http://localhost:3000/api/uploads/${id}`), id);
        assert.equal(uploadIdFromUrl(`https://cdn.example/api/uploads/${id}.gif`), null);
        assert.equal(uploadIdFromUrl('https://cdn.example/photo.jpg'), null);
    });
});
