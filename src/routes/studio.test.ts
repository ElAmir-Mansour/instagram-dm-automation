/**
 * The Studio routes. The worker router runs in a real Express app on an ephemeral port, as
 * tiktok.test.ts does for TikTok's callback, because what matters there is exactly what a fake
 * `res` gets subtly wrong: headers, 204s, and which requests fall through to the next router.
 * The operator routes are handlers pulled off the router, as carousel.test.ts does. The pool
 * answers by SQL; no database, no model, no Meta or TikTok call.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { setMediaStore, type MediaStore } from '../services/storage.js';
import { setGeneration } from '../services/studio/drafts.js';
import { hashWorkerToken, mintWorkerToken } from '../services/studio/worker.js';
import { MAX_STUDIO_UPLOAD_BYTES, sniffImageType, studioRouter, studioWorkerRouter } from './studio.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const JOB_A = 'a5555555-5555-4555-8555-555555555555';
const JOB_B = 'b5555555-5555-4555-8555-555555555555';
const DRAFT = '77777777-7777-4777-8777-777777777777';
const UPLOADED = 'e1111111-1111-4111-8111-111111111111';
const BASE = 'https://msg-response-auto.vercel.app';

const TOKEN_A = mintWorkerToken();
const TOKEN_B = mintWorkerToken();
const WORKERS: Record<string, { id: string; creator_id: string; name: string }> = {
    [hashWorkerToken(TOKEN_A)]: { id: 'worker-a', creator_id: TENANT_A, name: 'Mac A' },
    [hashWorkerToken(TOKEN_B)]: { id: 'worker-b', creator_id: TENANT_B, name: 'Mac B' },
};

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

interface FakeJob { id: string; creator_id: string; kind: string; status: string; payload: unknown; attempts: number }
type Rows = { rows: any[]; rowCount?: number };

let server: Server;
let base: string;
let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
let jobs: FakeJob[] = [];
let settingsRow: Record<string, unknown> | null = null;
let stored: { creatorId: string; mimeType: string; bytes: number }[] = [];
const original = { query: pool.query, connect: pool.connect };
let previousStore: MediaStore | null = null;
let restoreSink: (() => void) | undefined;

/**
 * A jobs table that honours the claim's tenant parameter, so "worker A cannot claim tenant B's
 * job" is observed rather than asserted about SQL alone.
 */
function queueRoutes(): [RegExp, (params: any[]) => Rows][] {
    return [
        [/^UPDATE studio_workers w SET last_seen_at/, (p) => ({ rows: WORKERS[p[0]] ? [WORKERS[p[0]]] : [] })],
        [/^WITH picked AS/, (p) => {
            const job = jobs.find((j) => j.creator_id === p[0] && j.status === 'pending');
            if (!job) return { rows: [] };
            job.status = 'claimed';
            job.attempts += 1;
            return { rows: [{ id: job.id, kind: job.kind, payload: job.payload, attempts: job.attempts }] };
        }],
        [/^SELECT id, creator_id, kind, status, payload FROM studio_jobs/, (p) => ({
            rows: jobs.filter((j) => j.id === p[0] && j.creator_id === p[1]),
        })],
        [/^UPDATE studio_jobs SET status = 'done'/, (p) => {
            const job = jobs.find((j) => j.id === p[0]);
            if (job) job.status = 'done';
            return { rows: [], rowCount: job ? 1 : 0 };
        }],
        [/FROM app_settings/, (p) => ({ rows: p[0] === 'app.public_base_url' ? [{ value: BASE, is_secret: false }] : [] })],
        [/FROM studio_settings/, () => ({ rows: settingsRow ? [settingsRow] : [] })],
    ];
}

before(async () => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    const app = express();
    app.use(express.json({ limit: '15mb' }));
    app.use('/api/studio', studioWorkerRouter);
    // Stands in for everything api.ts mounts after the worker router.
    app.use((_req, res) => { res.status(418).json({ fellThrough: true }); });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    restoreSink?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    statements = [];
    jobs = [];
    settingsRow = null;
    stored = [];
    routes = queueRoutes();
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    previousStore = setMediaStore({
        async put(input) {
            stored.push({ creatorId: input.creatorId, mimeType: input.mimeType, bytes: input.data.length });
            return { id: UPLOADED };
        },
        async get() { return null; },
        async open() { return null; },
        async mimeTypes() { return new Map(); },
        publicUrl: (id, origin) => `${origin}/api/uploads/${id}`,
    });
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
    setMediaStore(previousStore);
    setGeneration(null);
});

async function worker(path: string, token: string | null, body: unknown = {}) {
    const res = await fetch(`${base}/api/studio${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

const job = (id: string, creatorId: string): FakeJob => ({
    id, creator_id: creatorId, kind: 'scan_library', status: 'pending', payload: { root: '/r' }, attempts: 0,
});

// ─── Worker auth ────────────────────────────────────────────────────────────────────────

describe('worker routes — the token', () => {
    it('refuses a call with no token, before any query', async () => {
        const r = await worker('/worker/claim', null, { name: 'Mac' });
        assert.equal(r.status, 401);
        assert.match(r.body.error, /Authorization: Bearer/);
        assert.equal(statements.length, 0);
    });

    it('refuses a token no live worker holds', async () => {
        const wrong = mintWorkerToken();
        const r = await worker('/worker/claim', wrong);
        assert.equal(r.status, 401);
        assert.match(r.body.error, /not valid, or it was revoked/);
        assert.deepEqual(statements.map((s) => s.params), [[hashWorkerToken(wrong)]], 'looked up by hash, then nothing else');
    });

    it('lets the right token claim: 204 when there is nothing, 200 with the job when there is', async () => {
        assert.equal((await worker('/worker/claim', TOKEN_A)).status, 204);

        jobs = [job(JOB_A, TENANT_A)];
        const r = await worker('/worker/claim', TOKEN_A, { name: 'Mac A' });
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, { job: { id: JOB_A, kind: 'scan_library', payload: { root: '/r' } } });
    });

    it('records every call against the worker that made it', async () => {
        jobs = [{ ...job(JOB_A, TENANT_A), status: 'claimed' }];
        routes.unshift([/^UPDATE studio_jobs SET progress/, () => ({ rows: [], rowCount: 1 })]);
        assert.equal((await worker(`/worker/jobs/${JOB_A}/progress`, TOKEN_A, { progress: 'frame 3/8' })).status, 204);
        const touched = statements.filter((s) => /^UPDATE studio_workers w SET last_seen_at/.test(s.sql));
        assert.deepEqual(touched.map((s) => s.params[0]), [hashWorkerToken(TOKEN_A)]);
    });

    it('leaves /workers — the operator’s list — to the session routers behind it', async () => {
        const res = await fetch(`${base}/api/studio/workers`);
        assert.equal(res.status, 418, 'fell through: /worker matches whole segments only');
        assert.equal(statements.length, 0);
    });

    it('answers 503 with the migration to run when the Studio tables do not exist yet', async () => {
        routes.unshift([/^UPDATE studio_workers/, () => {
            throw Object.assign(new Error('relation "studio_workers" does not exist'), { code: '42P01' });
        }]);
        const r = await worker('/worker/claim', TOKEN_A);
        assert.equal(r.status, 503);
        assert.match(r.body.error, /migration v21/);
    });
});

describe('worker routes — one tenant each', () => {
    it('never hands worker A a job of tenant B, however old', async () => {
        jobs = [job(JOB_B, TENANT_B), job(JOB_A, TENANT_A)];
        const r = await worker('/worker/claim', TOKEN_A);
        assert.equal(r.body.job.id, JOB_A);
        assert.equal(jobs.find((j) => j.id === JOB_B)!.status, 'pending', 'B’s job is untouched');

        // A has nothing left; B's job is still B's alone.
        assert.equal((await worker('/worker/claim', TOKEN_A)).status, 204);
        assert.equal((await worker('/worker/claim', TOKEN_B)).body.job.id, JOB_B);

        const claims = statements.filter((s) => /^WITH picked AS/.test(s.sql));
        assert.deepEqual(claims.map((c) => c.params[0]), [TENANT_A, TENANT_A, TENANT_B]);
    });

    it('404s worker A completing or failing tenant B’s job, and changes nothing', async () => {
        jobs = [{ ...job(JOB_B, TENANT_B), status: 'claimed' }];
        assert.equal((await worker(`/worker/jobs/${JOB_B}/complete`, TOKEN_A, { result: { lessons: [] } })).status, 404);
        assert.equal((await worker(`/worker/jobs/${JOB_B}/fail`, TOKEN_A, { error: 'x' })).status, 404);
        assert.equal(jobs[0]!.status, 'claimed');
        assert.ok(!statements.some((s) => /^(INSERT|DELETE)|^UPDATE (course_lessons|carousel_drafts|studio_jobs SET status)/.test(s.sql)));
    });

    it('applies worker A’s result to tenant A only', async () => {
        jobs = [{ ...job(JOB_A, TENANT_A), status: 'claimed' }];
        const r = await worker(`/worker/jobs/${JOB_A}/complete`, TOKEN_A, {
            result: { lessons: [{ lesson_no: '1.1', title: 'Intro', video_path: '/r/1.mp4', section_no: 1 }] },
        });
        assert.equal(r.status, 204);
        const [upsert] = statements.filter((s) => /^INSERT INTO course_lessons/.test(s.sql));
        assert.equal(upsert!.params[0], TENANT_A);
        assert.equal(jobs[0]!.status, 'done');
    });
});

describe('POST /worker/upload', () => {
    const upload = (mime: string, data: Buffer) => worker('/worker/upload', TOKEN_A, {
        filename: 'slide-1.jpg', mime_type: mime, base64_data: data.toString('base64'),
    });

    it('stores an image as the worker’s tenant and answers with an absolute URL on the public base', async () => {
        const r = await upload('image/jpeg', JPEG);
        assert.equal(r.status, 201);
        assert.deepEqual(r.body, { id: UPLOADED, url: `${BASE}/api/uploads/${UPLOADED}` });
        assert.deepEqual(stored, [{ creatorId: TENANT_A, mimeType: 'image/jpeg', bytes: JPEG.length }]);
    });

    it('refuses a type it does not store', async () => {
        assert.equal((await upload('video/mp4', JPEG)).status, 400);
        assert.equal(stored.length, 0);
    });

    it('refuses bytes that are not the type they claim — Instagram would, hours later', async () => {
        const r = await upload('image/jpeg', PNG);
        assert.equal(r.status, 400);
        assert.match(r.body.error, /image\/png, not image\/jpeg/);
        assert.equal(stored.length, 0);
    });

    it('refuses more than 3MB decoded', async () => {
        const big = Buffer.concat([JPEG, Buffer.alloc(MAX_STUDIO_UPLOAD_BYTES)]);
        assert.equal((await upload('image/jpeg', big)).status, 413);
        assert.equal(stored.length, 0);
    });
});

describe('sniffImageType', () => {
    it('reads JPEG, PNG and WebP from their first bytes, and nothing else', () => {
        assert.equal(sniffImageType(JPEG), 'image/jpeg');
        assert.equal(sniffImageType(PNG), 'image/png');
        assert.equal(sniffImageType(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
        assert.equal(sniffImageType(Buffer.from('GIF89a')), null);
    });
});

// ─── Operator routes ────────────────────────────────────────────────────────────────────

function handlerFor(method: string, path: string) {
    const stack = (studioRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
}

async function call(method: string, path: string, req: Record<string, unknown> = {}) {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        end() { return this; },
    };
    await handlerFor(method, path)(
        { params: {}, query: {}, body: {}, session: { userId: 'u-1', role: 'user', tenantId: TENANT_A }, ...req }, res, () => {}
    );
    return res;
}

describe('operator routes', () => {
    it('answers a draft edit that breaks the rules with 400 { error, problems }', async () => {
        const carousel = {
            id: 'X', accent: '#22C7F0', keyword: 'دفتر', slides: [{ kind: 'cover', title: 'a' }, { kind: 'cta' }],
            captions: { instagram: 'دفتر', tiktokTitle: 't', tiktok: 'x' },
        };
        routes.unshift([/^SELECT \* FROM carousel_drafts WHERE id = \$1/, () => ({
            rows: [{ id: DRAFT, creator_id: TENANT_A, status: 'ready', input: { lessonIds: [] }, carousel, shots: {}, campaign: null, updated_at: new Date() }],
        })]);
        setGeneration({ validateCarousel: () => ['slide 1: title is 45 characters; the limit is 34'] });

        const res = await call('patch', '/drafts/:id', { params: { id: DRAFT }, body: { carousel } });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, {
            error: 'slide 1: title is 45 characters; the limit is 34',
            problems: ['slide 1: title is 45 characters; the limit is 34'],
        });
    });

    it('404s a malformed id before it reaches Postgres', async () => {
        const res = await call('patch', '/drafts/:id', { params: { id: 'not-a-uuid' }, body: { carousel: {} } });
        assert.equal(res.statusCode, 404);
        assert.equal(statements.length, 0);
    });

    it('gives the tenant’s own posting times, in its own timezone', async () => {
        settingsRow = { schedule: { timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] } };
        const res = await call('get', '/slots', { query: { count: '3' } });
        assert.equal(res.body.slots.length, 3);
        for (const slot of res.body.slots) assert.match(slot, /T(10|18):00:00\.000Z$/);
    });

    it('refuses a scan until the library folder is set', async () => {
        const res = await call('post', '/scan');
        assert.equal(res.statusCode, 400);
        assert.match(res.body.error, /library folder/);
        assert.ok(!statements.some((s) => /INSERT INTO studio_jobs/.test(s.sql)));
    });

    it('queues a scan of the tenant’s folder', async () => {
        settingsRow = { library: { root: '/Volumes/Course' } };
        routes.unshift([/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: JOB_A, kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })]);
        const res = await call('post', '/scan');
        assert.deepEqual(res.body.job.payload, { root: '/Volumes/Course' });
        const [insert] = statements.filter((s) => /^INSERT INTO studio_jobs/.test(s.sql));
        assert.deepEqual(insert!.params.slice(0, 2), [TENANT_A, 'scan_library']);
    });

    it('creates a worker, shows its token once, and keeps the token out of the audit log', async () => {
        routes.unshift(
            [/COUNT\(\*\)::int AS n FROM studio_workers/, () => ({ rows: [{ n: 0 }] })],
            [/^INSERT INTO studio_workers/, (p) => ({ rows: [{ id: 'worker-new', name: p[1], last_seen_at: null, created_at: new Date() }] })],
            [/^INSERT INTO audit_log/, () => ({ rows: [{ id: 'audit-1' }] })],
        );
        const res = await call('post', '/workers', { body: { name: 'Mac Studio' } });
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.worker.name, 'Mac Studio');
        assert.match(res.body.token, /^sws_/);

        const [audit] = statements.filter((s) => /^INSERT INTO audit_log/.test(s.sql));
        assert.equal(audit!.params[2], 'studio.worker_create');
        assert.ok(!JSON.stringify(audit!.params).includes(res.body.token));
    });

    it('reports the status card from the tenant’s own rows', async () => {
        routes.unshift(
            [/FROM course_lessons WHERE creator_id = \$1 GROUP BY status/, () => ({ rows: [{ status: 'indexed', n: 30 }, { status: 'new', n: 4 }] })],
            [/FROM studio_jobs WHERE creator_id = \$1 AND status IN/, () => ({ rows: [{ status: 'pending', n: 2 }] })],
        );
        const res = await call('get', '/status');
        assert.deepEqual(res.body, {
            worker: { online: false, lastSeen: null, name: null },
            lessons: { total: 34, indexed: 30, indexing: 0, failed: 0 },
            jobs: { pending: 2, claimed: 0 },
            tiktok: { audited: false, queued: 0 },
        });
        for (const s of statements.filter((s) => /creator_id = \$1/.test(s.sql))) assert.equal(s.params[0], TENANT_A);
    });
});
