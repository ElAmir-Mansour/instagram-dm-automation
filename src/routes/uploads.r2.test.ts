/**
 * `GET /api/uploads/:id` and `POST /api/upload` with Cloudflare R2 (src/routes/api.ts): an R2 row is streamed from R2 (a Range as 206); when R2's reads for the month
 * are used up, or the counter cannot be read, the route answers 503 WITHOUT sending a request to R2 (and logs `media.r2_limit_reached`); an upload into a full R2 is
 * a 409 `R2_LIMIT`. Handlers are pulled off the router and run against a Writable, as uploads.test.ts does.
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { R2UsageGuard, setR2Guard, type R2Guard } from '../services/r2Usage.js';
import { CREATOR, FakeDb, FakeStores } from '../services/r2TestKit.js';
import { getMediaStore } from '../services/storage.js';
import apiRouter from './api.js';

const ID = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const NOV = new Date('2026-11-06T10:00:00Z');
const CONTENT = Buffer.from('0123456789');

class FakeResponse extends Writable {
    statusCode = 200;
    headers: Record<string, string> = {};
    chunks: Buffer[] = [];
    sent: unknown = undefined;
    jsonBody: any = undefined;
    headersSent = false;
    constructor() { super(); this.on('error', () => {}); }
    status(code: number) { this.statusCode = code; return this; }
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); return this; }
    send(payload: unknown) { this.sent = payload; this.headersSent = true; this.end(); return this; }
    json(body: unknown) { this.jsonBody = body; this.headersSent = true; this.end(); return this; }
    override _write(data: Buffer, _e: BufferEncoding, done: () => void) { this.headersSent = true; this.chunks.push(Buffer.from(data)); done(); }
    body(): Buffer { return Buffer.concat(this.chunks); }
}

function routeHandler(path: string, method: 'get' | 'post'): (req: unknown, res: unknown) => Promise<void> {
    const stack = (apiRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method} ${path} must be mounted`);
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle as (req: unknown, res: unknown) => Promise<void>;
}

let db: FakeDb;
let stores: FakeStores;
let restoreDb: () => void;
let restoreFetch: () => void;
let restoreSink: (() => void) | undefined;
let previousGuard: R2Guard | null;
let logged: string[];

before(() => {
    const previous = setLogSink((_l, line) => { try { logged.push(JSON.parse(line).event); } catch { /* not ours */ } });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    logged = [];
    db = new FakeDb();
    stores = new FakeStores();
    restoreDb = db.install();
    restoreFetch = stores.install();
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock.timers.enable({ apis: ['Date'], now: NOV });
    previousGuard = setR2Guard(new R2UsageGuard());
    db.configureSupabase();
    db.configureR2();
    stores.r2.set(`${CREATOR}/${ID}.mp4`, { data: CONTENT, contentType: 'video/mp4' });
    db.addMedia({ id: ID, storage_path: `r2:${CREATOR}/${ID}.mp4`, size_bytes: String(CONTENT.length) });
});
afterEach(() => {
    mock.timers.reset();
    setR2Guard(previousGuard);
    restoreFetch();
    restoreDb();
});

async function serve(headers: Record<string, string> = {}, method = 'GET'): Promise<FakeResponse> {
    const res = new FakeResponse();
    await routeHandler('/uploads/:id', 'get')({ method, params: { id: ID }, headers }, res);
    return res;
}

describe('GET /uploads/:id for an R2 row', () => {
    it('streams it from R2 under our own URL, with the stored type, and counts one Class B', async () => {
        const res = await serve();
        assert.equal(res.statusCode, 200);
        assert.equal(res.body().toString(), '0123456789');
        assert.equal(res.headers['content-type'], 'video/mp4');
        assert.equal(res.headers['content-length'], '10');
        assert.equal(res.headers['accept-ranges'], 'bytes');
        assert.equal(stores.r2Calls().length, 1);
        assert.equal(db.counters('2026-11').b, 50, 'a batch of reads was reserved');
    });

    it('answers a Range with 206 and only those bytes, asking R2 for only those bytes', async () => {
        const res = await serve({ range: 'bytes=2-5' });
        assert.equal(res.statusCode, 206);
        assert.equal(res.body().toString(), '2345');
        assert.equal(res.headers['content-range'], 'bytes 2-5/10');
        assert.equal(stores.r2Calls().at(-1)!.headers['range'], 'bytes=2-5');
    });

    it('answers HEAD from the row, asking R2 nothing and counting nothing', async () => {
        const res = await serve({}, 'HEAD');
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['content-length'], '10');
        assert.equal(stores.seen.length, 0);
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 0 });
    });

    it('is 503 when this month\'s Class B is used up, sends nothing to R2, and logs it', async () => {
        db.setCounters('2026-11', 0, 9_000_000);
        const res = await serve();
        assert.equal(res.statusCode, 503);
        assert.equal(res.sent, 'Service Unavailable');
        assert.equal(stores.seen.length, 0, 'not one request reached Cloudflare');
        assert.ok(logged.includes('media.r2_limit_reached'));
    });

    it('resets by itself on the 1st (UTC)', async () => {
        db.setCounters('2026-11', 0, 9_000_000);
        assert.equal((await serve()).statusCode, 503);
        mock.timers.reset();
        mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-01T00:00:05Z') });
        const res = await serve();
        assert.equal(res.statusCode, 200);
        assert.equal(res.body().toString(), '0123456789');
    });

    it('is 503 too when the counter cannot be read: fail closed', async () => {
        db.failOn = /^INSERT INTO app_settings \(key, value, is_secret, updated_at\) SELECT/;
        const res = await serve();
        assert.equal(res.statusCode, 503);
        assert.equal(stores.seen.length, 0);
        assert.ok(logged.includes('media.r2_counter_refused'));
    });

    it('still serves Supabase files while R2 is used up', async () => {
        const SID = '1b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
        stores.supabase.set(`media/${CREATOR}/${SID}.mp4`, { data: Buffer.from('supabase'), contentType: 'video/mp4' });
        db.addMedia({ id: SID, storage_path: `${CREATOR}/${SID}.mp4`, size_bytes: '8' });
        db.setCounters('2026-11', 900_000, 9_000_000);
        const res = new FakeResponse();
        await routeHandler('/uploads/:id', 'get')({ method: 'GET', params: { id: SID }, headers: {} }, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body().toString(), 'supabase');
    });

    it('is 503 when the row is in R2 and R2 is not set up here', async () => {
        db.settings.delete('storage.r2_account_id');
        const res = await serve();
        assert.equal(res.statusCode, 503);
        assert.ok(logged.includes('media.storage_unconfigured'));
    });
});

describe('POST /upload into R2', () => {
    const upload = async () => {
        const res = new FakeResponse();
        await routeHandler('/upload', 'post')({
            body: { filename: 'a.jpg', mime_type: 'image/jpeg', base64_data: Buffer.from('jpeg bytes').toString('base64') },
            headers: { host: 'app.example' }, get: () => 'app.example', session: { tenantId: CREATOR, role: 'owner' },
        }, res);
        return res;
    };

    it('stores in R2 when the owner chose it, and answers our own URL', async () => {
        db.set('storage.backend', 'r2');
        const store = await getMediaStore();
        assert.equal((store as any).writesTo, 'r2');
        const res = await upload();
        assert.equal(res.statusCode, 201);
        const row = db.media.get(res.jsonBody.id)!;
        assert.equal(row.storage_path, `r2:${CREATOR}/${res.jsonBody.id}.jpg`);
        assert.match(res.jsonBody.url, /\/api\/uploads\/[0-9a-f-]{36}$/);
    });

    it('is 409 R2_LIMIT, with params, when R2\'s free storage is full: nothing is written', async () => {
        db.set('storage.backend', 'r2');
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 12, class_a: 10, class_b: 10 }));
        const res = await upload();
        assert.equal(res.statusCode, 409);
        assert.equal(res.jsonBody.code, 'R2_LIMIT');
        assert.match(res.jsonBody.error, /Cloudflare R2's free storage is full/);
        assert.equal(res.jsonBody.params.kind, 'storage');
        assert.equal(stores.r2Calls().length, 0);
        assert.equal(db.media.size, 1);
    });
});
