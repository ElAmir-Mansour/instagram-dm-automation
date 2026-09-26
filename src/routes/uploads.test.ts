/**
 * GET /api/uploads/:id — the URL Meta and TikTok fetch — for both kinds of row.
 *
 * A Storage row is proxied from Supabase, and the claim worth pinning is that it is STREAMED:
 * the first bytes reach the client while Supabase is still sending the rest, and memory holds a
 * few chunks, never the file. A reel is 15-30MB. The 10MB test below is built so that buffering
 * cannot pass it — Supabase's side will not send its second chunk until the client has received
 * the first, so a route that waited for the whole object would wait forever.
 *
 * A legacy row must behave exactly as it always did: `res.send` of the BYTEA.
 *
 * The handler is pulled off the router and run against a Writable that stands in for the
 * response, a stubbed pool, and a fake `fetch` for Supabase. No server, no network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import { setMediaStore } from '../services/storage.js';
import { MEDIA_BUCKET, setStorageFetch } from '../services/supabaseStorage.js';
import apiRouter from './api.js';

const PROJECT = 'https://abcd1234.supabase.co';
const KEY = 'sb_secret_0123456789abcdefghijKLMNOP';
const CREATOR = '11111111-1111-4111-8111-111111111111';
const STORED = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const LEGACY = '1b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const PATH = `${CREATOR}/${STORED}.mp4`;
const OBJECT_URL = `${PROJECT}/storage/v1/object/authenticated/${MEDIA_BUCKET}/${PATH}`;

const CHUNK = 64 * 1024;
const CHUNKS = 160;
const TEN_MB = CHUNK * CHUNKS;

/** Chunk i is filled with byte i % 256, so a dropped, doubled or reordered chunk changes the hash. */
function chunk(i: number): Uint8Array {
    return new Uint8Array(CHUNK).fill(i % 256);
}
const EXPECTED_SHA = (() => {
    const hash = createHash('sha256');
    for (let i = 0; i < CHUNKS; i++) hash.update(chunk(i));
    return hash.digest('hex');
})();

/** The response, as a Writable that reads at a client's pace: one chunk per turn of the loop. */
class FakeResponse extends Writable {
    statusCode = 200;
    headers: Record<string, string> = {};
    chunks: Buffer[] = [];
    sent: unknown = undefined;
    headersSent = false;
    finished = false;
    readonly firstChunk: Promise<void>;
    private gotFirst!: () => void;

    constructor() {
        super({ highWaterMark: 16 * 1024 });
        this.firstChunk = new Promise((resolve) => { this.gotFirst = resolve; });
        this.on('finish', () => { this.finished = true; });
        // A real ServerResponse destroyed with an error does not emit it on itself.
        this.on('error', () => {});
    }

    status(code: number) { this.statusCode = code; return this; }
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); return this; }
    send(payload: unknown) { this.sent = payload; this.headersSent = true; this.end(); return this; }

    override _write(data: Buffer, _encoding: BufferEncoding, done: (err?: Error | null) => void) {
        this.headersSent = true;
        this.chunks.push(Buffer.from(data));
        if (this.chunks.length === 1) this.gotFirst();
        setImmediate(done);
    }

    body(): Buffer { return Buffer.concat(this.chunks); }
}

function handler(): (req: unknown, res: unknown) => Promise<void> {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === '/uploads/:id' && l.route.methods.get);
    assert.ok(layer, 'GET /uploads/:id must be mounted');
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle as (req: unknown, res: unknown) => Promise<void>;
}

async function serve(id: string, method = 'GET'): Promise<FakeResponse> {
    const res = new FakeResponse();
    await handler()({ method, params: { id }, headers: {} }, res);
    return res;
}

// ─── Stubs ──────────────────────────────────────────────────────────────────────────────────

interface Row { mime_type: string; storage_path: string | null; size_bytes: string | null; data: Buffer | null }
let rows: Map<string, Row>;
let settings: Map<string, { value: string; is_secret: boolean }>;
let fetched: string[];
let upstream: () => Response;
let logged: Array<{ level: string; event: string }>;

const originalQuery = pool.query;
let previousFetch: ReturnType<typeof setStorageFetch> = null;
let restoreSink: (() => void) | undefined;
let savedEnv: Record<string, string | undefined> = {};

before(() => {
    const previous = setLogSink((level, line) => {
        try { logged.push({ level, event: JSON.parse(line).event }); } catch { /* not ours */ }
    });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    rows = new Map([
        [STORED, { mime_type: 'video/mp4', storage_path: PATH, size_bytes: String(TEN_MB), data: null }],
        [LEGACY, { mime_type: 'image/jpeg', storage_path: null, size_bytes: null, data: Buffer.from('legacy jpeg bytes') }],
    ]);
    settings = new Map();
    fetched = [];
    logged = [];
    upstream = () => { throw new Error('Supabase was not expected to be asked'); };
    savedEnv = { enc: process.env.TOKEN_ENCRYPTION_KEY, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(flat)) {
            const row = settings.get(String(params[0]));
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (/^SELECT mime_type, storage_path, size_bytes, /.test(flat)) {
            const row = rows.get(String(params[0]));
            if (!row) return { rows: [], rowCount: 0 };
            const storageFirst = /CASE WHEN storage_path IS NULL THEN data END/.test(flat);
            return { rows: [{ ...row, data: storageFirst && row.storage_path ? null : row.data }], rowCount: 1 };
        }
        throw new Error(`no result arranged for SQL: ${flat}`);
    };
    previousFetch = setStorageFetch(async (input: string) => {
        fetched.push(input);
        return upstream();
    });
    setMediaStore(null);
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    setStorageFetch(previousFetch);
    for (const [name, value] of [
        ['TOKEN_ENCRYPTION_KEY', savedEnv.enc], ['SUPABASE_URL', savedEnv.url], ['SUPABASE_SERVICE_ROLE_KEY', savedEnv.key],
    ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

/** Settings → Media storage holds a project and a key, so Storage rows can be read. */
function storageConfigured(): void {
    settings.set('storage.supabase_url', { value: PROJECT, is_secret: false });
    settings.set('storage.supabase_service_key', { value: encryptSecret(KEY), is_secret: true });
}

/**
 * `work`, or a failure naming what went wrong once `ms` passes. Not unref'd: a route that
 * deadlocks leaves nothing else holding the event loop open, and the failure must still be
 * reported as this message rather than as the runner giving up on a pending promise.
 */
async function within<T>(ms: number, message: string, work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// ─── Storage rows ───────────────────────────────────────────────────────────────────────────

describe('GET /uploads/:id — a row whose bytes are in Supabase Storage', () => {
    it('streams a 10MB object through: the first bytes leave before Supabase has sent the rest', async () => {
        storageConfigured();
        let produced = 0;
        let producedWhenFirstSent = -1;
        let mostInFlight = 0;
        let res!: FakeResponse;

        upstream = () => new Response(new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (produced === 1) {
                    // Hold chunk 2 back until the client has chunk 1. A route that buffers the
                    // whole object never sends chunk 1, so this never resolves and the test
                    // times out instead of passing.
                    await res.firstChunk;
                    producedWhenFirstSent = produced;
                }
                mostInFlight = Math.max(mostInFlight, produced - res.chunks.length);
                if (produced === CHUNKS) { controller.close(); return; }
                controller.enqueue(chunk(produced++));
            },
        }, { highWaterMark: 0 }), { status: 200, headers: { 'content-length': String(TEN_MB), 'content-type': 'video/mp4' } });

        res = new FakeResponse();
        await within(5000, 'the route waited for the whole object before sending any of it',
            handler()({ method: 'GET', params: { id: STORED }, headers: {} }, res));

        assert.equal(res.statusCode, 200);
        assert.equal(res.finished, true);
        assert.equal(producedWhenFirstSent, 1, 'the client had its first chunk while Supabase had sent only one');
        assert.ok(mostInFlight <= 16, `at most ~1MB held at once, not the file (was ${mostInFlight} chunks)`);
        assert.equal(res.body().length, TEN_MB);
        assert.equal(createHash('sha256').update(res.body()).digest('hex'), EXPECTED_SHA, 'every byte, in order');

        assert.equal(res.headers['content-type'], 'video/mp4', 'the stored type');
        assert.equal(res.headers['content-length'], String(TEN_MB));
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['cache-control'], 'public, max-age=31536000');
        assert.deepEqual(fetched, [OBJECT_URL], 'read with the key, from the authenticated endpoint');
    });

    it('serves the object under `<uuid>.mp4` too — the extension is ignored, as before', async () => {
        storageConfigured();
        upstream = () => new Response(Buffer.from('mp4 bytes'), { status: 200, headers: { 'content-length': '9' } });

        const res = await serve(`${STORED}.mp4`);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body(), Buffer.from('mp4 bytes'));
        assert.equal(res.headers['content-length'], '9', 'what Supabase is actually sending wins');
    });

    it('answers HEAD from the row: the headers, no body, and nothing fetched', async () => {
        storageConfigured();
        const res = await serve(STORED, 'HEAD');

        assert.equal(res.statusCode, 200);
        assert.equal(res.writableEnded, true, 'ended, with nothing written');
        assert.equal(res.headers['content-length'], String(TEN_MB));
        assert.equal(res.headers['content-type'], 'video/mp4');
        assert.equal(res.chunks.length, 0);
        assert.deepEqual(fetched, []);
    });

    it('404s when Storage no longer has the object — and says so in the log', async () => {
        storageConfigured();
        upstream = () => new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400 });

        const res = await serve(STORED);

        assert.equal(res.statusCode, 404);
        assert.ok(logged.some((l) => l.level === 'error' && l.event === 'media.object_missing'));
    });

    it('502s, having sent nothing, when Supabase refuses the key', async () => {
        storageConfigured();
        upstream = () => new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 });

        const res = await serve(STORED);

        assert.equal(res.statusCode, 502);
        assert.equal(res.chunks.length, 0);
    });

    it('cuts the connection when Storage fails mid-file, so a short file is never passed off as whole', async () => {
        storageConfigured();
        let sent = 0;
        upstream = () => new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
                if (sent++ < 3) controller.enqueue(chunk(sent));
                else controller.error(new Error('connection reset by peer'));
            },
        }, { highWaterMark: 0 }), { status: 200, headers: { 'content-length': String(TEN_MB) } });

        const res = await serve(STORED);

        assert.ok(res.chunks.length > 0, 'part of it was already out');
        assert.equal(res.destroyed, true);
        assert.equal(res.finished, false, 'never ended as if complete');
        assert.ok(logged.some((l) => l.level === 'error' && l.event === 'media.serve_failed'));
    });

    it('treats a client going away mid-file as routine, not as a failure', async () => {
        storageConfigured();
        let res!: FakeResponse;
        let n = 0;
        upstream = () => new Response(new ReadableStream<Uint8Array>({
            async pull(controller) {
                if (n === 2) {
                    await res.firstChunk;
                    res.destroy(); // the player seeked, the fetch was cancelled
                }
                controller.enqueue(chunk(n++));
            },
        }, { highWaterMark: 0 }), { status: 200, headers: { 'content-length': String(TEN_MB) } });

        res = new FakeResponse();
        await handler()({ method: 'GET', params: { id: STORED }, headers: {} }, res);

        assert.ok(logged.some((l) => l.event === 'media.serve_aborted'));
        assert.ok(!logged.some((l) => l.event === 'media.serve_failed'));
    });

    it('503s when the row is in Storage but nothing is configured to read it with', async () => {
        const res = await serve(STORED);

        assert.equal(res.statusCode, 503);
        assert.deepEqual(fetched, []);
        assert.ok(logged.some((l) => l.event === 'media.storage_unconfigured'));
    });
});

// ─── Legacy rows ────────────────────────────────────────────────────────────────────────────

describe('GET /uploads/:id — a legacy row whose bytes are still in Postgres', () => {
    for (const configured of [false, true]) {
        it(`sends the BYTEA exactly as before${configured ? ', with Storage configured' : ''}`, async () => {
            if (configured) storageConfigured();

            const res = await serve(LEGACY);

            assert.equal(res.statusCode, 200);
            assert.deepEqual(res.sent, Buffer.from('legacy jpeg bytes'), 'through res.send, which sets Content-Length and ETag');
            assert.equal(res.headers['content-type'], 'image/jpeg');
            assert.equal(res.headers['x-content-type-options'], 'nosniff');
            assert.deepEqual(fetched, [], 'Supabase is not asked about a row it does not hold');
        });
    }

    it('still 404s an unknown id, and a malformed one before any query', async () => {
        storageConfigured();
        assert.equal((await serve('2b8a7a0e-3c1f-4f7e-9d0a-1234567890ab')).statusCode, 404);
        assert.equal((await serve('not-a-uuid.jpg')).statusCode, 404);
        assert.deepEqual(fetched, []);
    });
});
