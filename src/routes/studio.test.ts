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
import { setMediaStore, SupabaseStorageMediaStore, type MediaStore } from '../services/storage.js';
import { setAiCaller } from '../services/aiProviders/generate.js';
import { AiError } from '../services/llm/errors.js';
import { NEEDS_API_BRAIN_MESSAGE } from '../services/macBrain.js';
import { setStorageFetch } from '../services/supabaseStorage.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setGeneration } from '../services/studio/drafts.js';
import { NEEDS_AI_PROVIDER_MESSAGE } from '../services/studio/tenantAi.js';
import { hashWorkerToken, mintWorkerToken } from '../services/studio/worker.js';
import { completeJob } from '../services/studio/jobs.js';
import { CLOSING_QUESTION, validWriterOutput } from '../services/explainers/testFixtures.js';
import { explainerSettings, installWorld, type World } from '../services/explainers/testDb.js';
import { setRunDeps, setRunLauncher } from '../services/explainers/writing.js';
import { ExplainerError } from '../services/explainers/errors.js';
import { setPictureDeps } from '../services/explainers/scenes.js';
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

    it('refuses more than 3MB decoded, as UPLOAD_TOO_LARGE with the cap in params', async () => {
        const big = Buffer.concat([JPEG, Buffer.alloc(MAX_STUDIO_UPLOAD_BYTES)]);
        const r = await upload('image/jpeg', big);
        assert.equal(r.status, 413);
        assert.equal(r.body.code, 'UPLOAD_TOO_LARGE');
        assert.match(r.body.error, /^An upload is at most 3MB decoded; this one is 3\.0MB\./);
        assert.equal(r.body.message, r.body.error);
        assert.deepEqual(r.body.params, { maxMb: 3, maxBytes: MAX_STUDIO_UPLOAD_BYTES });
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

    it('unschedules a draft: its queued post goes, and the draft comes back ready', async () => {
        const META_ROW = 'c1c1c1c1-1111-4111-8111-111111111111';
        const scheduled = {
            id: DRAFT, creator_id: TENANT_A, status: 'scheduled', input: { lessonIds: [] }, carousel: null, shots: {}, campaign: null,
            render: { ig: [], tt: [], rendered_at: 'x', job_id: 'job-1' }, error: null, created_at: new Date(), updated_at: new Date(),
            schedule: { scheduled_time: '2026-10-01T10:00:00.000Z', meta_row_id: META_ROW, tiktok: 'none', tiktok_row_id: null, tiktok_public_done: false },
        };
        routes.unshift(
            [/^SELECT \* FROM carousel_drafts WHERE id = \$1 AND creator_id = \$2 FOR UPDATE$/, (p) => ({ rows: p[1] === TENANT_A ? [scheduled] : [] })],
            [/^SELECT id, platform, status, published_post_id, external_publish_id FROM scheduled_posts/, () => ({
                rows: [{ id: META_ROW, platform: 'both', status: 'PENDING', published_post_id: null, external_publish_id: null }],
            })],
            [/^DELETE FROM scheduled_posts/, () => ({ rows: [{ id: META_ROW }] })],
            [/^UPDATE carousel_drafts SET status = 'ready'/, () => ({ rows: [{ ...scheduled, status: 'ready', schedule: null }] })],
        );
        const res = await call('post', '/drafts/:id/unschedule', { params: { id: DRAFT } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.draft.status, 'ready');
        assert.equal(res.body.draft.creator_id, undefined, 'presented, not the raw row');
        assert.deepEqual(res.body.deleted, [META_ROW]);
        for (const s of statements.filter((s) => /creator_id = \$[12]/.test(s.sql))) assert.ok(s.params.includes(TENANT_A));
    });

    it('answers 409 with the reason when the draft has already gone out, and deletes nothing', async () => {
        routes.unshift(
            [/^SELECT \* FROM carousel_drafts WHERE id = \$1 AND creator_id = \$2 FOR UPDATE$/, () => ({
                rows: [{ id: DRAFT, creator_id: TENANT_A, status: 'scheduled', schedule: { meta_row_id: 'c1c1c1c1-1111-4111-8111-111111111111', tiktok_row_id: null } }],
            })],
            [/^SELECT id, platform, status, published_post_id, external_publish_id FROM scheduled_posts/, () => ({
                rows: [{ id: 'c1c1c1c1-1111-4111-8111-111111111111', platform: 'both', status: 'PUBLISHED', published_post_id: 'ig_1', external_publish_id: null }],
            })],
        );
        const res = await call('post', '/drafts/:id/unschedule', { params: { id: DRAFT } });
        assert.equal(res.statusCode, 409);
        assert.match(res.body.error, /already been published/);
        assert.ok(!statements.some((s) => /^DELETE/.test(s.sql) || /^UPDATE carousel_drafts/.test(s.sql)));
    });

    it('404s unscheduling a malformed id before it reaches Postgres', async () => {
        const res = await call('post', '/drafts/:id/unschedule', { params: { id: 'not-a-uuid' } });
        assert.equal(res.statusCode, 404);
        assert.equal(statements.length, 0);
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
            jobs: { pending: 2, claimed: 0, waiting: 0 },
            tiktok: { audited: false, queued: 0 },
        });
        for (const s of statements.filter((s) => /creator_id = \$1/.test(s.sql))) assert.equal(s.params[0], TENANT_A);
    });
});

// ─── The Monteur's worker routes (MONTEUR.md §4, §7) ────────────────────────────────────

describe('POST /worker/uploads/sign', () => {
    const PROJECT = 'https://abcd1234.supabase.co';
    const SECRET = 'sb_secret_0123456789abcdefghijKLMNOP';
    let signCalls: { method: string; url: string; headers: Record<string, string>; body: string }[] = [];
    let previousFetch: ReturnType<typeof setStorageFetch> = null;

    const supabase = () => {
        signCalls = [];
        previousFetch = setStorageFetch(async (input, init = {}) => {
            const headers: Record<string, string> = {};
            new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
            signCalls.push({ method: String(init.method), url: input, headers, body: String(init.body) });
            const path = new URL(input).pathname.replace('/storage/v1', '');
            return new Response(JSON.stringify({ url: `${path}?token=signed-token-123` }), { status: 200, headers: { 'content-type': 'application/json' } });
        });
        setMediaStore(new SupabaseStorageMediaStore({ url: PROJECT, key: SECRET, source: { url: 'database', key: 'database' } }));
    };
    afterEach(() => setStorageFetch(previousFetch));

    const sign = (body: unknown) => worker('/worker/uploads/sign', TOKEN_A, body);
    const reel = { filename: 'reel.mp4', mime_type: 'video/mp4', size_bytes: 58 * 1024 * 1024 };

    it('409s when media is not in Supabase Storage: there is nothing to sign against', async () => {
        const r = await sign(reel);
        assert.equal(r.status, 409);
        assert.match(r.body.error, /Supabase Storage/);
        assert.ok(!statements.some((s) => /INSERT INTO media_uploads/.test(s.sql)));
    });

    it('400s any type but MP4 and JPEG, and anything over 100MB, before asking Supabase', async () => {
        supabase();
        for (const body of [
            { ...reel, mime_type: 'video/quicktime' },
            { ...reel, mime_type: 'image/png' },
            { ...reel, size_bytes: 100 * 1024 * 1024 + 1 },
            { ...reel, size_bytes: 0 },
            { ...reel, size_bytes: '5000' },
        ]) {
            const r = await sign(body);
            assert.equal(r.status, 400, JSON.stringify(body));
        }
        assert.equal(signCalls.length, 0);
        assert.ok(!statements.some((s) => /INSERT INTO media_uploads/.test(s.sql)));
    });

    it('signs the path, writes the metadata-only row, and answers with our own URL and the PUT to make', async () => {
        supabase();
        const r = await sign(reel);
        assert.equal(r.status, 201);
        const { id, url, upload } = r.body;
        assert.match(id, /^[0-9a-f-]{36}$/);
        assert.equal(url, `${BASE}/api/uploads/${id}`, 'the URL Meta fetches is ours, never the bucket’s');
        assert.deepEqual(upload, {
            method: 'PUT',
            url: `${PROJECT}/storage/v1/object/upload/sign/media/${TENANT_A}/${id}.mp4?token=signed-token-123`,
            headers: { 'content-type': 'video/mp4', 'x-upsert': 'false', 'cache-control': 'max-age=31536000' },
        });
        assert.equal(signCalls.length, 1);
        assert.equal(signCalls[0]!.method, 'POST');
        assert.equal(signCalls[0]!.url, `${PROJECT}/storage/v1/object/upload/sign/media/${TENANT_A}/${id}.mp4`);
        assert.equal(signCalls[0]!.headers.apikey, SECRET);
        assert.equal(signCalls[0]!.body, '{}');

        const [row] = statements.filter((s) => /^INSERT INTO media_uploads/.test(s.sql));
        assert.match(row!.sql, /VALUES \(\$1, \$2, \$3, \$4, NULL, \$5, \$6\)/, 'no bytes in Postgres');
        assert.deepEqual(row!.params, [id, TENANT_A, 'reel.mp4', 'video/mp4', `${TENANT_A}/${id}.mp4`, reel.size_bytes]);
    });

    it('needs the worker token like every worker route', async () => {
        assert.equal((await worker('/worker/uploads/sign', null, reel)).status, 401);
    });
});

describe('POST /worker/claim — the Monteur’s daily run', () => {
    it('queues the day’s scan before claiming, so the same claim can hand it out', async () => {
        settingsRow = { schedule: { timezone: 'UTC', slots: ['12:00'] }, monteur: { enabled: true, folder: '/Volumes/Clips', run_at: '00:00' } };
        routes.unshift(
            [/^SELECT id FROM studio_jobs WHERE creator_id = \$1 AND kind = 'monteur_scan'/, () => ({ rows: [] })],
            [/^INSERT INTO studio_jobs/, (p) => {
                jobs.push({ id: JOB_A, creator_id: p[0], kind: p[1], status: 'pending', payload: JSON.parse(p[2]), attempts: 0 });
                return { rows: [{ id: JOB_A, kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] };
            }],
        );
        const r = await worker('/worker/claim', TOKEN_A);
        assert.equal(r.status, 200);
        assert.equal(r.body.job.kind, 'monteur_scan');
        assert.equal(r.body.job.payload.folder, '/Volumes/Clips');
    });

    it('still claims when the daily run breaks — before migration v24, say', async () => {
        routes.unshift([/FROM studio_settings/, () => {
            throw Object.assign(new Error('column "monteur" does not exist'), { code: '42703' });
        }]);
        jobs = [job(JOB_A, TENANT_A)];
        const r = await worker('/worker/claim', TOKEN_A);
        assert.equal(r.status, 200);
        assert.equal(r.body.job.id, JOB_A);
    });
});

describe('POST /worker/claim — the fast lane', () => {
    it('claims only the kinds asked for', async () => {
        jobs = [job(JOB_A, TENANT_A)];
        routes.unshift([/^WITH picked AS/, (p) => {
            const found = jobs.find((j) => j.creator_id === p[0] && j.status === 'pending' && (!p[3] || (p[3] as string[]).includes(j.kind)));
            if (!found) return { rows: [] };
            found.status = 'claimed';
            return { rows: [{ id: found.id, kind: found.kind, payload: found.payload, attempts: 1 }] };
        }]);
        assert.equal((await worker('/worker/claim', TOKEN_A, { name: 'Mac', kinds: ['pick_folder'] })).status, 204, 'a scan is not a folder pick');
        const claims = statements.filter((s) => /^WITH picked AS/.test(s.sql));
        assert.deepEqual(claims.at(-1)!.params[3], ['pick_folder']);
        assert.equal((await worker('/worker/claim', TOKEN_A, { name: 'Mac' })).status, 200);
    });

    it('400s a kind it does not know, claiming nothing', async () => {
        const r = await worker('/worker/claim', TOKEN_A, { kinds: ['render_everything'] });
        assert.equal(r.status, 400);
        assert.match(r.body.error, /^kinds must be a list of job kinds/);
        assert.ok(!statements.some((s) => /^WITH picked AS/.test(s.sql)));
    });
});

describe('the Mac is the owner’s (G1), over the routes', () => {
    /** The owner: `getPlatformOwnerId`'s statement. Tenant B is the owner here, so tenant A (the session's and the worker's) is someone else. */
    const OWNER_SQL = /^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/;
    const thinkJob = (creatorId: string): FakeJob => ({
        id: JOB_A, creator_id: creatorId, kind: 'monteur_think', status: 'pending', payload: { request: 'source/x/a1/monteur.pick', try: 1 }, attempts: 0,
    });
    beforeEach(() => {
        invalidateTenantCache();
        routes.unshift([OWNER_SQL, () => ({ rows: [{ id: TENANT_B }] })]);
    });
    afterEach(() => invalidateTenantCache());

    /** The layer, answering as the real one does with no key saved: `no_provider`. Records what it was asked, and puts itself back. */
    async function withNoProvider(run: (asked: string[]) => Promise<void>): Promise<void> {
        const asked: string[] = [];
        const previous = setAiCaller(async (args) => {
            asked.push(`${args.purpose}:${args.creatorId}`);
            throw new AiError({ kind: 'no_provider', provider: '', model: '', message: 'No AI provider is ready: save an API key for one in Operations → AI providers.' });
        });
        try {
            await run(asked);
        } finally {
            setAiCaller(previous);
        }
    }

    it('POST /infographics for a tenant the Mac is not for goes to the AI providers layer: with no provider ready it is 409 { error, code: NEEDS_AI_PROVIDER }, writing nothing', async () => {
        await withNoProvider(async (asked) => {
            const res = await call('post', '/infographics', { body: { topic: 'RAG vs CAG vs KAG' } });
            assert.equal(res.statusCode, 409);
            // The shared envelope (src/services/errorCodes.ts): `error` is the string it always was, beside `message`, `code` and `params`.
            assert.deepEqual(res.body, { error: NEEDS_AI_PROVIDER_MESSAGE, message: NEEDS_AI_PROVIDER_MESSAGE, code: 'NEEDS_AI_PROVIDER', params: {} });
            assert.match(res.body.error, /Nothing was sent to the Mac/);
            assert.deepEqual(asked, [`tenant_infographic:${TENANT_A}`], 'the layer was asked, for this tenant, for this purpose');
            assert.ok(!statements.some((s) => /^INSERT INTO (infographics|studio_jobs)/.test(s.sql)), 'no row, and no job for the Mac or the worker');
        });
    });

    it('POST /infographics/:id/render with rewrite is the layer’s too (409 NEEDS_AI_PROVIDER, nothing queued), and a render alone is not', async () => {
        const id = '22222222-2222-4222-8222-222222222222';
        const row = { id, creator_id: TENANT_A, topic: 'RAG', notes: null, language: 'en', theme: 'dark', pair_theme: null, status: 'ready', spec: { columns: [] }, caption: 'c', review: null,
            render: null, schedule: null, job_id: null, error: null, created_at: new Date(), updated_at: new Date(), job_status: null, job_progress: null };
        routes.unshift(
            [/^SELECT i\.id, i\.topic/, () => ({ rows: [row] })],
            [/^SELECT \* FROM infographics WHERE id = \$1 AND creator_id = \$2 FOR UPDATE/, () => ({ rows: [row] })],
            [/^INSERT INTO studio_jobs/, (p) => ({ rows: [{ id: 'job-new', kind: p[1], status: 'pending', payload: JSON.parse(p[2]) }] })],
        );
        await withNoProvider(async (asked) => {
            const rewrite = await call('post', '/infographics/:id/render', { params: { id }, body: { rewrite: true } });
            assert.equal(rewrite.statusCode, 409);
            assert.equal(rewrite.body.code, 'NEEDS_AI_PROVIDER');
            assert.deepEqual(asked, [`tenant_infographic:${TENANT_A}`]);
            assert.equal(statements.filter((s) => /^INSERT INTO studio_jobs/.test(s.sql)).length, 0);
        });
    });

    it('the Studio settings answer a tenant switching the Monteur onto the Mac with 400 { error, code }', async () => {
        const res = await call('put', '/settings', { body: { monteur: { brain: 'claude_mac' } } });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body, { error: NEEDS_API_BRAIN_MESSAGE, message: NEEDS_API_BRAIN_MESSAGE, code: 'NEEDS_API_BRAIN', params: {} });
        assert.ok(!statements.some((s) => /^INSERT INTO studio_settings/.test(s.sql)));
    });

    it('a refusal without a code (any other StudioError) still carries none', async () => {
        const res = await call('post', '/monteur/clips/:id/rerender', { params: { id: 'nope' } });
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { error: 'No such clip.' });
    });

    it('POST /worker/claim fails a pending think of a tenant that is not on the list instead of handing it out: 204, job failed with the reason', async () => {
        jobs = [thinkJob(TENANT_A)];
        const r = await worker('/worker/claim', TOKEN_A);
        assert.equal(r.status, 204);
        const [failed] = statements.filter((s) => /^UPDATE studio_jobs SET status = 'failed', error = \$2, progress = NULL/.test(s.sql));
        assert.deepEqual(failed!.params, [JOB_A, NEEDS_API_BRAIN_MESSAGE]);
    });

    it('POST /worker/claim hands a tenant the list adds its think, and the owner his own', async () => {
        routes.unshift([/FROM app_settings/, (p) => ({
            rows: p[0] === 'studio.mac_brain_tenants' ? [{ value: JSON.stringify([TENANT_A]), is_secret: false }] : [],
        })]);
        jobs = [thinkJob(TENANT_A)];
        const r = await worker('/worker/claim', TOKEN_A);
        assert.equal(r.status, 200, 'tenant A is listed; tenant B is the owner');
        assert.equal(r.body.job.kind, 'monteur_think');
    });

    it('POST /worker/claim hands the owner’s think to his worker, with nothing configured', async () => {
        routes.unshift([OWNER_SQL, () => ({ rows: [{ id: TENANT_A }] })]);
        jobs = [thinkJob(TENANT_A)];
        const r = await worker('/worker/claim', TOKEN_A);
        assert.equal(r.status, 200);
        assert.equal(r.body.job.kind, 'monteur_think');
        assert.ok(!statements.some((s) => /^UPDATE studio_jobs SET status = 'failed', error = \$2, progress = NULL/.test(s.sql)));
    });
});

describe('GET /infographics/next-slot (the Schedule dialog’s preview, UX US1 IG-01)', () => {
    const stack = () => (studioRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;

    it('is mounted BEFORE /infographics/:id, which would otherwise read "next-slot" as an id', () => {
        const paths = stack().filter((l) => l.route && l.route.methods.get).map((l) => l.route!.path);
        const slot = paths.indexOf('/infographics/next-slot');
        const byId = paths.indexOf('/infographics/:id');
        assert.ok(slot !== -1, 'mounted');
        assert.ok(byId !== -1 && slot < byId, `next-slot (${slot}) must come before :id (${byId})`);
    });

    it('answers the next free slot and the tenant’s zone, and writes nothing', async () => {
        settingsRow = { schedule: { timezone: 'Asia/Riyadh', slots: ['13:00'] }, monteur: { post_at: ['19:00'] } };
        const res = await call('get', '/infographics/next-slot');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.timezone, 'Asia/Riyadh');
        assert.match(res.body.next_slot, /^\d{4}-\d\d-\d\dT16:00:00\.000Z$/, '19:00 in Riyadh is 16:00Z');
        assert.ok(!statements.some((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql)), 'a read');
    });

    it('a slot a pending post holds is skipped, as Schedule would skip it', async () => {
        settingsRow = { schedule: { timezone: 'UTC', slots: ['12:00'] }, monteur: { post_at: ['12:00'] } };
        const first = await call('get', '/infographics/next-slot');
        const taken = new Date(first.body.next_slot);
        routes.unshift([/^SELECT p\.scheduled_time FROM scheduled_posts p/, () => ({ rows: [{ scheduled_time: taken }] })]);
        const second = await call('get', '/infographics/next-slot');
        assert.equal(Date.parse(second.body.next_slot) - taken.getTime(), 24 * 3600 * 1000, 'the next day at the same time');
    });
});

describe('the Monteur’s operator routes', () => {
    it('are all mounted', () => {
        for (const [method, path] of [
            ['get', '/monteur'], ['post', '/monteur/run'], ['post', '/monteur/pick-folder'], ['post', '/monteur/sources/:id/retry'],
            ['patch', '/monteur/clips/:id'], ['post', '/monteur/clips/:id/approve'], ['post', '/monteur/clips/:id/reject'],
            ['post', '/monteur/clips/:id/rerender'], ['post', '/monteur/lessons/refresh'],
        ] as const) {
            assert.ok(handlerFor(method, path), `${method} ${path}`);
        }
    });

    it('404s a malformed clip id before it reaches Postgres', async () => {
        const res = await call('post', '/monteur/clips/:id/rerender', { params: { id: 'nope' } });
        assert.equal(res.statusCode, 404);
        assert.equal(statements.length, 0);
    });
});

// ─── Refusals carry stable codes (src/services/errorCodes.ts, UX F1: ST-08, IG-02) ───────────────────────────
//
// What was an English sentence in an Arabic screen is now a sentence AND a code: `error` is unchanged (every client reads it),
// `code` and `params` are what the dashboard translates, and `problems` stays a top-level field where the editors read it.

describe('the Studio and the Monteur refuse with a code', () => {
    const ID = '22222222-2222-4222-8222-222222222222';
    const SPEC = { columns: [{ name: 'RAG' }, { name: 'CAG' }, { name: 'KAG' }], title: ['RAG', 'CAG', 'KAG'] };
    const infographicRow = (over: Record<string, unknown> = {}) => ({
        id: ID, creator_id: TENANT_A, topic: 'RAG', notes: null, language: 'en', theme: 'dark', pair_theme: null, status: 'ready', spec: SPEC,
        caption: 'RAG and CAG are the two I use.', review: null, render: { mp4_url: `${BASE}/api/uploads/a`, cover_url: `${BASE}/api/uploads/b`, gif_url: null },
        schedule: null, job_id: null, error: null, created_at: new Date(), updated_at: new Date(), ...over,
    });
    const arrange = (row: Record<string, unknown>) => routes.unshift(
        [/^SELECT \* FROM infographics WHERE id = \$1 AND creator_id = \$2 FOR UPDATE/, () => ({ rows: [row] })],
    );
    const schedule = (body: Record<string, unknown> = {}) => call('post', '/infographics/:id/schedule', { params: { id: ID }, body });

    it('a caption that leaves a column out is CAPTION_MISSING_COLUMNS, naming the columns, with the list still in `problems`', async () => {
        arrange(infographicRow());
        const res = await schedule();

        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'CAPTION_MISSING_COLUMNS');
        assert.equal(res.body.error, 'The caption doesn\'t mention «KAG»: it must talk about what the infographic shows.');
        assert.equal(res.body.message, res.body.error);
        assert.deepEqual(res.body.params, { columns: ['KAG'], list: '«KAG»' });
        assert.deepEqual(res.body.problems, [res.body.error], 'the editors read `problems` off the top level');
        assert.ok(!statements.some((s) => /^INSERT INTO scheduled_posts/.test(s.sql)), 'nothing was scheduled');
    });

    it('an empty caption is CAPTION_EMPTY, and one that is both too long and incomplete is the owner’s rule first, with both sets of params', async () => {
        arrange(infographicRow({ caption: '  ' }));
        const empty = await schedule();
        assert.equal(empty.body.code, 'CAPTION_EMPTY');

        routes = queueRoutes();
        arrange(infographicRow({ caption: `RAG ${'x'.repeat(2300)}` }));
        const both = await schedule();
        assert.equal(both.statusCode, 409);
        assert.equal(both.body.code, 'CAPTION_MISSING_COLUMNS');
        assert.deepEqual(both.body.params, { length: 2304, max: 2200, columns: ['CAG', 'KAG'], list: '«CAG», «KAG»' });
        assert.equal(both.body.problems.length, 2);
    });

    it('an infographic that is not ready, or is scheduled already, says which, and keeps its words', async () => {
        arrange(infographicRow({ status: 'rendering', render: null }));
        const rendering = await schedule();
        assert.equal(rendering.statusCode, 409);
        assert.equal(rendering.body.code, 'INFOGRAPHIC_NOT_READY');
        assert.equal(rendering.body.error, 'This infographic is rendering; only a ready one can be scheduled.');
        assert.deepEqual(rendering.body.params, { status: 'rendering' });

        routes = queueRoutes();
        arrange(infographicRow({ status: 'scheduled' }));
        const again = await schedule();
        assert.equal(again.body.code, 'INFOGRAPHIC_SCHEDULED');
        assert.equal(again.body.error, 'This infographic is already scheduled.');
    });

    it('a time that is not a date is INVALID_SCHEDULE_TIME, a 400, before the row is read', async () => {
        const res = await schedule({ scheduled_time: 'tomorrow-ish' });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'INVALID_SCHEDULE_TIME');
        assert.match(res.body.error, /^scheduled_time must be a date and time/);
        assert.ok(!statements.some((s) => /FROM infographics WHERE id/.test(s.sql)));
    });

    it('editing the caption of an infographic Claude is still writing is INFOGRAPHIC_WRITING', async () => {
        arrange(infographicRow({ status: 'writing', spec: null, render: null }));
        const res = await call('patch', '/infographics/:id', { params: { id: ID }, body: { caption: 'x' } });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'INFOGRAPHIC_WRITING');
        assert.equal(res.body.error, 'Claude is still writing this infographic.');
    });

    it('a clip that is already scheduled is REEL_SCHEDULED on edit and on reject', async () => {
        routes.unshift([/^SELECT id, creator_id, source_id, rank, status.* FROM clip_drafts WHERE id = \$1 AND creator_id = \$2 FOR UPDATE/, () => ({
            rows: [{ id: ID, creator_id: TENANT_A, source_id: 'src-1', status: 'scheduled', title: 'T', copy: { keyword: 'دفتر', variants: [], caption: 'x', tiktok_caption: 'y' }, render: null }],
        })]);
        const edit = await call('patch', '/monteur/clips/:id', { params: { id: ID }, body: { title: 'New title' } });
        assert.equal(edit.statusCode, 409);
        assert.equal(edit.body.code, 'REEL_SCHEDULED');
        assert.equal(edit.body.error, 'This reel is scheduled: edit its post in Posts instead.');

        const reject = await call('post', '/monteur/clips/:id/reject', { params: { id: ID } });
        assert.equal(reject.body.code, 'REEL_SCHEDULED');
        assert.equal(reject.body.error, 'This reel is scheduled: delete its post in Posts instead.');
    });

    it('a draft that is scheduled is DRAFT_SCHEDULED when it is edited', async () => {
        routes.unshift([/^SELECT \* FROM carousel_drafts WHERE id = \$1/, () => ({
            rows: [{ id: DRAFT, creator_id: TENANT_A, status: 'scheduled', input: { lessonIds: [] }, carousel: null, shots: {}, campaign: null, updated_at: new Date() }],
        })]);
        const res = await call('patch', '/drafts/:id', { params: { id: DRAFT }, body: { carousel: {} } });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'DRAFT_SCHEDULED');
        assert.equal(res.body.error, 'This draft is scheduled, so it can no longer be changed. Unschedule it first to edit it.');
    });

    it('a refusal nobody has coded yet is still a plain { error }: the dashboard falls back to the sentence', async () => {
        const res = await call('post', '/monteur/clips/:id/rerender', { params: { id: 'nope' } });
        assert.equal(res.body.code, undefined);
        assert.equal(res.body.params, undefined);
    });
});


// ─── Illustrated explainers (v59, src/services/explainers/): the routes of contracts/http-api.md ─────────────────────────────────────────────

describe('Explainers routes', () => {
    const EXPLAINER_ID = '22222222-2222-4222-8222-222222222222';
    const ENABLED = `explainers.enabled.${TENANT_A}`;
    const KARIM = { key: 'karim', name: 'Karim', description: 'a curious young man', ref_media_id: null, ref_url: null, approved_at: null };
    const upload = (n: number) => `${BASE}/api/uploads/${String(n).padStart(2, '0').repeat(4)}-1111-4111-8111-111111111111`;
    const uploadId = (n: number) => `${String(n).padStart(2, '0').repeat(4)}-1111-4111-8111-111111111111`;

    let world: World;
    let exServer: Server;
    let exBase: string;
    let role: 'owner' | 'operator' | 'viewer' = 'operator';
    let launched: Promise<void>[] = [];
    let restoreRun: (() => void) | undefined;

    before(async () => {
        const app = express();
        app.use(express.json({ limit: '15mb' }));
        // Mounted ABOVE the session stand-in, as api.ts mounts it: the worker carries a token and no session.
        app.use('/api/studio', studioWorkerRouter);
        app.use((req, _res, next) => {
            req.session = { userId: 'u-1', role: 'user', tenantId: TENANT_A } as never;
            req.tenantRole = role;
            next();
        });
        app.use('/api/studio', studioRouter);
        await new Promise<void>((resolve) => { exServer = app.listen(0, '127.0.0.1', () => resolve()); });
        exBase = `http://127.0.0.1:${(exServer.address() as AddressInfo).port}`;
    });
    after(async () => {
        await new Promise<void>((resolve) => exServer.close(() => resolve()));
    });
    beforeEach(() => {
        role = 'operator';
        world = installWorld({ tenant: TENANT_A });
        // The routes read the real clock (the lazy check asks how old a Gemini run's heartbeat is), so the database's NOW() is the real now too.
        world.now = new Date();
        world.settingsRow = explainerSettings({ characters: [KARIM] });
        world.db.routes.unshift([/^UPDATE studio_workers w SET last_seen_at/, (p) => ({ rows: WORKERS[p[0]] ? [WORKERS[p[0]]] : [] })]);
        launched = [];
        const previous = setRunLauncher((work) => { launched.push(work); });
        const previousDeps = setRunDeps({ write: async () => { throw new Error('no Gemini in this test'); } });
        restoreRun = () => { setRunLauncher(previous); setRunDeps(previousDeps); };
    });
    afterEach(() => {
        world.restore();
        restoreRun?.();
        setPictureDeps(null);
    });

    const on = () => world.appSettings.set(ENABLED, 'true');
    async function api(method: string, path: string, body?: unknown) {
        const res = await fetch(`${exBase}/api/studio${path}`, {
            method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await res.text();
        return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    }
    const explainerStatements = () => world.db.statements.filter((s) => /\bexplainers?\b|studio_jobs/.test(s.sql) && !/app_settings/.test(s.sql));

    describe('the switch', () => {
        const ROUTES: [string, string, unknown?][] = [
            ['GET', '/explainers'], ['POST', '/explainers', { topic: 'Why AI answers with confidence' }], ['GET', `/explainers/${EXPLAINER_ID}`], ['PATCH', `/explainers/${EXPLAINER_ID}`, { subtitles: false }],
            ['POST', `/explainers/${EXPLAINER_ID}/rewrite`, { note: 'shorter' }], ['POST', `/explainers/${EXPLAINER_ID}/approve`, { version: 1 }], ['POST', `/explainers/${EXPLAINER_ID}/revoice`],
            ['POST', `/explainers/${EXPLAINER_ID}/draw`], ['POST', `/explainers/${EXPLAINER_ID}/approve-pictures`], ['POST', `/explainers/${EXPLAINER_ID}/render`],
            ['POST', `/explainers/${EXPLAINER_ID}/schedule`, { when: 'now' }], ['POST', `/explainers/${EXPLAINER_ID}/retry`], ['DELETE', `/explainers/${EXPLAINER_ID}`],
            ['GET', '/explainers/allowance'], ['POST', '/explainers/characters/candidates', { description: 'a curious young man' }],
            ['POST', '/explainers/uploads/sign', { purpose: 'music', mime: 'audio/mpeg', size: 1000 }],
            ['POST', `/explainers/${EXPLAINER_ID}/scenes/0/draw`, { note: 'smiling' }], ['POST', `/explainers/${EXPLAINER_ID}/scenes/0/pick`, { index: 0 }],
        ];

        it('every dashboard route answers 404 EXPLAINERS_DISABLED while it is off, with the shared envelope, and does not touch the explainers’ tables', async () => {
            // The owner: the upload signer is owner-only, and that guard is the router's, so it runs before the switch is read.
            role = 'owner';
            for (const [method, path, body] of ROUTES) {
                const res = await api(method, path, body);
                assert.equal(res.status, 404, `${method} ${path}`);
                assert.equal(res.body.code, 'EXPLAINERS_DISABLED', `${method} ${path}`);
                assert.equal(res.body.error, 'Explainers are not switched on for this account.');
                assert.equal(res.body.message, res.body.error);
                assert.deepEqual(res.body.params, {});
            }
            assert.deepEqual(explainerStatements().map((s) => s.sql), [], 'nothing of the feature was read or written');
            assert.equal(world.jobs.length, 0);
        });

        it('is read for this tenant: another tenant’s switch does not turn it on, and only the value "true" does', async () => {
            world.appSettings.set(`explainers.enabled.${'77777777-7777-4777-8777-777777777777'}`, 'true');
            assert.equal((await api('GET', '/explainers')).status, 404);
            for (const value of ['yes', 'TRUE', '1', 'on', '{"enabled":true}']) {
                world.appSettings.set(ENABLED, value);
                assert.equal((await api('GET', '/explainers')).status, 404, value);
            }
            world.appSettings.set(ENABLED, 'true');
            assert.equal((await api('GET', '/explainers')).status, 200);
        });

        it('the switch comes before everything else: a malformed id is a 404 for the switch first, and a body that would be refused is not read', async () => {
            const res = await api('GET', '/explainers/not-an-id');
            assert.equal(res.body.code, 'EXPLAINERS_DISABLED');
            assert.equal((await api('POST', '/explainers', { topic: '' })).body.code, 'EXPLAINERS_DISABLED');
        });

        it('a read the database cannot answer is a failure, not "not available": the switch’s error is not turned into a 404', async () => {
            world.db.routes.unshift([/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, () => { throw new Error('connection terminated'); }]);
            const res = await api('GET', '/explainers');
            assert.equal(res.status, 500);
            assert.equal(res.body.error, 'Failed to list the explainers.');
        });
    });

    describe('the role', () => {
        it('needs the operator role: a viewer is refused with 403 before the switch is read, an operator and an owner are let in', async () => {
            on();
            role = 'viewer';
            const refused = await api('GET', '/explainers');
            assert.equal(refused.status, 403);
            assert.equal(refused.body.code, 'INSUFFICIENT_TENANT_ROLE');
            assert.equal((await api('POST', '/explainers', { topic: 'Why AI answers with confidence' })).status, 403);
            assert.equal(world.explainers.size, 0);
            assert.ok(!world.db.statements.some((s) => /app_settings/.test(s.sql)), 'the guard is the router’s: it ran first');
            role = 'operator';
            assert.equal((await api('GET', '/explainers')).status, 200);
            role = 'owner';
            assert.equal((await api('GET', '/explainers')).status, 200);
        });
    });

    describe('the shapes', () => {
        beforeEach(on);

        it('POST /explainers is 201 with the explainer, queues the Mac’s job, and leaves an audit row that holds no word of the topic', async () => {
            const res = await api('POST', '/explainers', { topic: 'Why AI answers with confidence', language: 'en', notes: 'a private note', source_links: ['https://arxiv.org/abs/2005.11401'] });
            assert.equal(res.status, 201);
            assert.equal(res.body.status, 'writing');
            assert.equal(res.body.topic, 'Why AI answers with confidence');
            assert.equal(res.body.job.status, 'pending');
            assert.equal(world.jobsOf('explainer_write').length, 1);
            assert.equal(world.audit.length, 1);
            assert.deepEqual(world.audit[0], {
                actor_email: null, action: 'explainer.created', target_type: 'explainer', target_id: res.body.id, detail: { language: 'en', length_tier: 'short', sound_mode: 'sfx' },
            });
            assert.ok(!JSON.stringify(world.audit).includes('Why AI answers'));
            assert.ok(!JSON.stringify(world.audit).includes('a private note'));
        });

        it('GET /explainers is { items }, newest first', async () => {
            await api('POST', '/explainers', { topic: 'The first explainer topic' });
            const res = await api('GET', '/explainers');
            assert.equal(res.status, 200);
            assert.deepEqual(Object.keys(res.body), ['items']);
            assert.equal(res.body.items.length, 1);
            assert.equal(res.body.items[0].topic, 'The first explainer topic');
        });

        it('a refused body is the shared envelope with the list of problems at the top level', async () => {
            const res = await api('POST', '/explainers', { topic: 'ab', language: 'fr' });
            assert.equal(res.status, 400);
            assert.equal(typeof res.body.error, 'string');
            assert.equal(res.body.problems.length, 2);
        });

        it('a malformed id and one that is not there are the same 404 EXPLAINER_NOT_FOUND, in the shared envelope', async () => {
            for (const id of ['not-an-id', '33333333-3333-4333-8333-333333333333']) {
                const res = await api('GET', `/explainers/${id}`);
                assert.equal(res.status, 404, id);
                assert.deepEqual(res.body, { error: 'No such explainer.', message: 'No such explainer.', code: 'EXPLAINER_NOT_FOUND', params: {} });
            }
            assert.equal((await api('DELETE', '/explainers/not-an-id')).body.code, 'EXPLAINER_NOT_FOUND');
        });

        it('a script that breaks a rule is 422 EXPLAINER_DRAFT_REFUSED, with every finding, the sentences, and how many, and nothing is stored', async () => {
            const out = validWriterOutput(12);
            world.addExplainer({ id: EXPLAINER_ID, status: 'draft', title: out.title, draft_version: 1, language: 'en', draft: { writer: 'claude_mac', captions: out.captions, first_comment: out.first_comment, replies: out.replies, sources: out.sources, est_seconds: 70, warnings: [] } });
            world.addScenes(12, (i) => ({ narration: out.scenes[i]!.narration, spoken: out.scenes[i]!.spoken, label: out.scenes[i]!.label, brief: out.scenes[i]!.brief, characters: out.scenes[i]!.characters }), EXPLAINER_ID);
            const scenes = world.sceneRows(EXPLAINER_ID).map((s) => ({ narration: s.narration, spoken: s.spoken, label: s.label, brief: s.brief, characters: s.characters, continues: s.continues }));
            scenes[11]!.narration = 'Type 1 if you agree';
            scenes[11]!.spoken = 'Type 1 if you agree';
            const res = await api('PATCH', `/explainers/${EXPLAINER_ID}`, { scenes });
            assert.equal(res.status, 422);
            assert.equal(res.body.code, 'EXPLAINER_DRAFT_REFUSED');
            assert.deepEqual(res.body.params, { found: 2 });
            assert.deepEqual(res.body.findings.map((f: { code: string }) => f.code), ['closing_question', 'engagement_bait']);
            assert.equal(res.body.problems.length, 2);
            assert.equal(res.body.error, '2 problems with this script.');
            assert.equal(world.sceneRows(EXPLAINER_ID)[11]!.narration, CLOSING_QUESTION);
        });

        it('a move the status machine does not allow is 409 EXPLAINER_BAD_STATE', async () => {
            world.addExplainer({ id: EXPLAINER_ID, status: 'writing' });
            const res = await api('POST', `/explainers/${EXPLAINER_ID}/approve`, { version: 0 });
            assert.equal(res.status, 409);
            assert.equal(res.body.code, 'EXPLAINER_BAD_STATE');
            assert.deepEqual(res.body.params, { status: 'writing', to: 'be approved' });
        });

        it('approving a script that changed since it was read is 409 CHANGED_MEANWHILE', async () => {
            const out = validWriterOutput(12);
            world.addExplainer({ id: EXPLAINER_ID, status: 'draft', title: out.title, draft_version: 4, draft: { writer: 'claude_mac', captions: out.captions, first_comment: '', replies: [], sources: out.sources, est_seconds: 70, warnings: [] } });
            world.addScenes(12, undefined, EXPLAINER_ID);
            const res = await api('POST', `/explainers/${EXPLAINER_ID}/approve`, { version: 3 });
            assert.equal(res.status, 409);
            assert.equal(res.body.code, 'CHANGED_MEANWHILE');
        });

        it('a time that is not one is 400 INVALID_SCHEDULE_TIME', async () => {
            world.addExplainer({ id: EXPLAINER_ID, status: 'ready' });
            const res = await api('POST', `/explainers/${EXPLAINER_ID}/schedule`, { when: 'tomorrow-ish' });
            assert.equal(res.status, 400);
            assert.equal(res.body.code, 'INVALID_SCHEDULE_TIME');
        });
    });

    describe('the whole way, through the routes: create, draft, approve, voice, draw, approve the pictures, render, schedule, delete', () => {
        beforeEach(on);

        it('walks an explainer from a topic to its posts, with the worker’s results landing between the owner’s steps, and leaves the audit trail of the gates', async () => {
            // 1. A topic.
            const created = await api('POST', '/explainers', { topic: 'Why AI answers with confidence', language: 'en', sound_mode: 'sfx' });
            assert.equal(created.status, 201);
            const id = created.body.id as string;
            const claim = (kind: string) => { const job = world.jobsOf(kind as never).at(-1)!; job.status = 'claimed'; return job; };

            // 2. The Mac writes it (the worker's `complete`): a draft.
            const write = claim('explainer_write');
            assert.equal(await completeJob(TENANT_A, write.id, { written: validWriterOutput(12), model: 'claude-opus-5-5', research_rounds: 3 }), 'applied');
            let view = (await api('GET', `/explainers/${id}`)).body;
            assert.equal(view.status, 'draft');
            assert.equal(view.scenes.length, 12);
            assert.equal(view.draft.writer, 'claude_mac');
            assert.deepEqual(view.problems, []);

            // 3. The owner edits a label and approves the script he read.
            const scenes = view.scenes.map((sc: any) => ({ narration: sc.narration, spoken: sc.spoken, label: sc.label, brief: sc.brief, characters: sc.characters, continues: sc.continues }));
            scenes[0].label = 'edited';
            view = (await api('PATCH', `/explainers/${id}`, { scenes })).body;
            assert.equal(view.scenes[0].label, 'edited');
            assert.equal(view.draft_version, 1, 'a label never needs a new voice');
            view = (await api('POST', `/explainers/${id}/approve`, { version: view.draft_version })).body;
            assert.equal(view.status, 'voicing');

            // 4. The Mac voices it.
            const voice = claim('explainer_voice');
            for (const n of [1, 2, 3, 4]) world.uploads.set(uploadId(n), { id: uploadId(n), creator_id: TENANT_A, mime_type: n === 1 ? 'audio/mp4' : n === 4 ? 'image/jpeg' : 'video/mp4', storage_path: null });
            await completeJob(TENANT_A, voice.id, {
                audio: { url: upload(1), duration: 72, voice: 'Sadaltager', fallback: false }, version: 1, words: {},
                scenes: Array.from({ length: 12 }, (_, i) => ({ position: i, start: i * 6, end: i * 6 + 6 })),
            });
            view = (await api('GET', `/explainers/${id}`)).body;
            assert.equal(view.status, 'drawing');
            assert.equal(view.audio.version, 1);
            assert.equal(view.audio_stale, false);

            // 5. The Mac's loop draws one scene per call of draw-next (the pictures service writes each picture, here a stand-in that does), and the call that finds
            //    nothing left moves the explainer to review. The worker's own `complete` then ends its job, and the job stops being the explainer's.
            const draw = claim('explainer_draw');
            setPictureDeps({
                drawNext: async ({ explainerId }) => {
                    const scene = world.sceneRows(explainerId).find((sc) => sc.draw_status === 'pending');
                    if (!scene) return { state: 'done' };
                    Object.assign(scene, { draw_status: 'done', picture: { media_id: uploadId(20 + scene.position), url: `/api/uploads/${uploadId(20 + scene.position)}`, seed: scene.position, provider: 'cloudflare', model: 'flux', prompt_hash: 'h', at: '2026-10-25T09:00:00Z' } });
                    return { state: 'drawn', position: scene.position, remaining: world.sceneRows(explainerId).filter((sc) => sc.draw_status === 'pending').length };
                },
            });
            const answers: string[] = [];
            for (let step = 0; step < 20; step++) {
                const res = await fetch(`${exBase}/api/studio/worker/explainers/${id}/draw-next`, {
                    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN_A}` }, body: JSON.stringify({ job_id: draw.id }),
                });
                assert.equal(res.status, 200);
                const answer = await res.json() as { state: string };
                answers.push(answer.state);
                if (answer.state === 'done') break;
            }
            assert.deepEqual(answers, [...Array.from({ length: 12 }, () => 'drawn'), 'done']);
            view = (await api('GET', `/explainers/${id}`)).body;
            assert.equal(view.status, 'review', 'the last step moved it, before the worker said anything');
            assert.equal(view.job.status, 'claimed', 'the job is still the worker’s until it completes it');
            assert.equal(await completeJob(TENANT_A, draw.id, { state: 'done' }), 'applied');
            view = (await api('GET', `/explainers/${id}`)).body;
            assert.equal(view.status, 'review');
            assert.equal(view.job, null, 'its result cleared the job');

            // 6. The owner approves the pictures: the render is queued.
            view = (await api('POST', `/explainers/${id}/approve-pictures`)).body;
            assert.equal(view.status, 'rendering');
            const render = claim('explainer_render');
            await completeJob(TENANT_A, render.id, { vertical_url: upload(2), horizontal_url: upload(3), cover_url: upload(4), duration: 72, version: 1, sound_mode: 'sfx' });
            view = (await api('GET', `/explainers/${id}`)).body;
            assert.equal(view.status, 'ready');
            assert.equal(view.render.vertical_url, upload(2));
            assert.equal(view.render_stale, false);

            // 7. Schedule: now.
            view = (await api('POST', `/explainers/${id}/schedule`, { when: 'now' })).body;
            assert.equal(view.status, 'scheduled');
            assert.deepEqual(world.posts.map((p) => p.platform), ['both', 'tiktok'], 'the neutral brand posts to Instagram and Facebook; TikTok is always an inbox draft');
            assert.equal(view.schedule.row_ids.length, 2);

            // 8. The trail the gates leave.
            assert.deepEqual(world.audit.map((a) => a.action), ['explainer.created', 'explainer.approved', 'explainer.pictures_approved', 'explainer.scheduled']);
            assert.deepEqual(world.audit[1]!.detail, { version: 1, scenes: 12 });
            assert.deepEqual(world.audit[3]!.detail.platforms, ['both', 'tiktok']);
            assert.ok(!JSON.stringify(world.audit).includes('Why AI answers'), 'no word of the topic, ever');

            // 9. Deleted: the files of the render stay with the posts that name them.
            world.keptUploads.add(uploadId(2));
            const deleted = await api('DELETE', `/explainers/${id}`);
            assert.equal(deleted.status, 204);
            assert.equal(world.explainers.size, 0);
            assert.equal(world.audit.at(-1)!.action, 'explainer.deleted');
        });
    });

    describe('the picture routes', () => {
        beforeEach(on);
        const ALLOWANCE = { provider: 'cloudflare', day: '2026-10-25', used_units: 220, pictures: 2, cap: 80, est_left: 78, paused_until: null };
        const PICTURE = (n: number) => ({ media_id: uploadId(n), url: `/api/uploads/${uploadId(n)}`, seed: n, provider: 'cloudflare', model: 'flux', prompt_hash: 'h', at: '2026-10-25T09:00:00Z' });
        const reviewing = () => {
            world.addExplainer({ id: EXPLAINER_ID, status: 'review' });
            world.addScenes(3, (i) => ({ picture: PICTURE(10 + i), pictures: [PICTURE(30 + i)], draw_status: 'done' }), EXPLAINER_ID);
        };
        const workerCall = (path: string, body: unknown, token: string | null = TOKEN_A) => fetch(`${exBase}/api/studio${path}`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
        });

        describe('GET /explainers/allowance', () => {
            it('is what the pictures service says, and is not read as an explainer whose id is "allowance"', async () => {
                setPictureDeps({ allowanceStatus: async () => ALLOWANCE });
                const res = await api('GET', '/explainers/allowance');
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, ALLOWANCE);
                assert.deepEqual(explainerStatements().map((s) => s.sql), [], 'no explainer was looked up');
            });

            it('is null when no image provider is set up, as a 200: there is nothing to count, and nothing went wrong', async () => {
                setPictureDeps({ allowanceStatus: async () => null });
                const res = await api('GET', '/explainers/allowance');
                assert.equal(res.status, 200);
                assert.equal(res.body, null);
            });
        });

        describe('GET /explainers/:id carries the allowance', () => {
            it('as `allowance`, from the pictures service', async () => {
                reviewing();
                setPictureDeps({ allowanceStatus: async () => ALLOWANCE });
                const res = await api('GET', `/explainers/${EXPLAINER_ID}`);
                assert.equal(res.status, 200);
                assert.deepEqual(res.body.allowance, ALLOWANCE);
            });

            it('as null when the pictures service cannot say: reading an explainer never fails because the allowance could not be read', async () => {
                reviewing();
                setPictureDeps({ allowanceStatus: async () => { throw new Error('connection terminated'); } });
                const res = await api('GET', `/explainers/${EXPLAINER_ID}`);
                assert.equal(res.status, 200);
                assert.equal(res.body.allowance, null);
                assert.equal(res.body.status, 'review');
            });
        });

        describe('POST /explainers/:id/scenes/:position/draw', () => {
            it('is `{ scene, allowance }`, with the owner’s note handed to the pictures service', async () => {
                reviewing();
                const asked: unknown[] = [];
                setPictureDeps({ drawScene: async (args) => { asked.push(args); return { scene: world.sceneRows(EXPLAINER_ID)[args.position]!, allowance: ALLOWANCE }; } });
                const res = await api('POST', `/explainers/${EXPLAINER_ID}/scenes/1/draw`, { note: 'he is holding a book, smiling' });
                assert.equal(res.status, 200);
                assert.deepEqual(Object.keys(res.body).sort(), ['allowance', 'scene']);
                assert.equal(res.body.scene.position, 1);
                assert.equal('creator_id' in res.body.scene, false);
                assert.deepEqual(res.body.allowance, ALLOWANCE);
                assert.deepEqual(asked, [{ creatorId: TENANT_A, explainerId: EXPLAINER_ID, position: 1, note: 'he is holding a book, smiling' }]);
            });

            it('a paused allowance is 429 EXPLAINER_ALLOWANCE_PAUSED with `retryAt` in the body and Retry-After in the headers', async () => {
                reviewing();
                const retryAt = new Date(Date.now() + 3 * 3_600_000).toISOString();
                setPictureDeps({ drawScene: async () => { throw new ExplainerError('EXPLAINER_ALLOWANCE_PAUSED', 'Drawing is paused until the allowance resets.', { retryAt }); } });
                const res = await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/draw`, {});
                assert.equal(res.status, 429);
                assert.equal(res.body.code, 'EXPLAINER_ALLOWANCE_PAUSED');
                assert.equal(res.body.retryAt, retryAt);
                assert.deepEqual(res.body.params, { retryAt });
                assert.equal(res.body.error, 'Drawing is paused until the allowance resets.');
                assert.ok(Number(res.headers.get('retry-after')) >= 10_000, `Retry-After is seconds until then (${res.headers.get('retry-after')})`);
            });

            it('a refused picture is 422 EXPLAINER_PROMPT_REFUSED in the shared envelope, and a provider that failed is 502', async () => {
                reviewing();
                setPictureDeps({ drawScene: async () => { throw new ExplainerError('EXPLAINER_PROMPT_REFUSED', 'The redraw note names a woman.'); } });
                const refused = await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/draw`, { note: 'x' });
                assert.equal(refused.status, 422);
                assert.deepEqual(refused.body, { error: 'The redraw note names a woman.', message: 'The redraw note names a woman.', code: 'EXPLAINER_PROMPT_REFUSED', params: {} });
                setPictureDeps({ drawScene: async () => { throw new ExplainerError('EXPLAINER_PROVIDER_ERROR', 'The image provider is busy: try again in a few minutes.'); } });
                assert.equal((await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/draw`, {})).status, 502);
            });

            it('is 409 EXPLAINER_BAD_STATE before the narration is voiced, and the pictures service is not asked', async () => {
                world.addExplainer({ id: EXPLAINER_ID, status: 'draft' });
                let called = 0;
                setPictureDeps({ drawScene: async () => { called++; throw new Error('not expected'); } });
                const res = await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/draw`, {});
                assert.equal(res.status, 409);
                assert.equal(res.body.code, 'EXPLAINER_BAD_STATE');
                assert.deepEqual(res.body.params, { status: 'draft', to: 'drawn' });
                assert.equal(called, 0);
            });

            it('is 404 for an explainer that is not there, a scene that cannot be, and 400 for a note that is not text', async () => {
                reviewing();
                setPictureDeps({ drawScene: async () => { throw new Error('not expected'); } });
                assert.equal((await api('POST', `/explainers/33333333-3333-4333-8333-333333333333/scenes/0/draw`, {})).body.code, 'EXPLAINER_NOT_FOUND');
                assert.equal((await api('POST', `/explainers/${EXPLAINER_ID}/scenes/-1/draw`, {})).body.code, 'EXPLAINER_NOT_FOUND');
                assert.equal((await api('POST', `/explainers/${EXPLAINER_ID}/scenes/first/draw`, {})).body.code, 'EXPLAINER_NOT_FOUND');
                assert.equal((await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/draw`, { note: 5 })).status, 400);
            });
        });

        describe('POST /explainers/:id/scenes/:position/pick', () => {
            it('is `{ scene }`, with the index handed to the pictures service', async () => {
                reviewing();
                const asked: unknown[] = [];
                setPictureDeps({ pickPicture: async (args) => { asked.push(args); return { scene: world.sceneRows(EXPLAINER_ID)[args.position]! }; } });
                const res = await api('POST', `/explainers/${EXPLAINER_ID}/scenes/2/pick`, { index: 0 });
                assert.equal(res.status, 200);
                assert.deepEqual(Object.keys(res.body), ['scene']);
                assert.equal(res.body.scene.position, 2);
                assert.deepEqual(asked, [{ creatorId: TENANT_A, explainerId: EXPLAINER_ID, position: 2, index: 0 }]);
            });

            it('is 400 for an index that is not a whole number, and 409 while the explainer is rendering', async () => {
                reviewing();
                setPictureDeps({ pickPicture: async () => { throw new Error('not expected'); } });
                assert.equal((await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/pick`, { index: 'first' })).status, 400);
                assert.equal((await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/pick`, {})).status, 400);
                world.explainer(EXPLAINER_ID).status = 'rendering';
                const res = await api('POST', `/explainers/${EXPLAINER_ID}/scenes/0/pick`, { index: 0 });
                assert.equal(res.status, 409);
                assert.equal(res.body.code, 'EXPLAINER_BAD_STATE');
            });
        });

        describe('POST /explainers/characters/candidates', () => {
            it('is `{ candidates }` for the tenant’s own look', async () => {
                const asked: unknown[] = [];
                setPictureDeps({ drawCandidates: async (args) => { asked.push(args); return { candidates: [{ media_id: uploadId(1), url: `/api/uploads/${uploadId(1)}` }] }; } });
                const res = await api('POST', '/explainers/characters/candidates', { description: 'a curious young man in a green sweater' });
                assert.equal(res.status, 200);
                assert.deepEqual(res.body, { candidates: [{ media_id: uploadId(1), url: `/api/uploads/${uploadId(1)}` }] });
                assert.deepEqual(asked, [{ creatorId: TENANT_A, description: 'a curious young man in a green sweater' }]);
            });

            it('a refused description is 422 and a paused allowance is 429 with `retryAt`; a description that is not text is 400', async () => {
                setPictureDeps({ drawCandidates: async () => { throw new ExplainerError('EXPLAINER_PROMPT_REFUSED', 'The character description names a woman.'); } });
                assert.equal((await api('POST', '/explainers/characters/candidates', { description: 'x' })).status, 422);
                const retryAt = new Date(Date.now() + 3_600_000).toISOString();
                setPictureDeps({ drawCandidates: async () => { throw new ExplainerError('EXPLAINER_ALLOWANCE_PAUSED', 'Drawing is paused.', { retryAt }); } });
                const paused = await api('POST', '/explainers/characters/candidates', { description: 'x' });
                assert.equal(paused.status, 429);
                assert.equal(paused.body.retryAt, retryAt);
                assert.equal((await api('POST', '/explainers/characters/candidates', { description: 5 })).status, 400);
            });
        });

        describe('POST /explainers/uploads/sign', () => {
            let previousStore: MediaStore | null;
            let previousFetch: ReturnType<typeof setStorageFetch> = null;
            let signed: string[];
            beforeEach(() => {
                signed = [];
                previousFetch = setStorageFetch(async (input) => {
                    signed.push(input);
                    return new Response(JSON.stringify({ url: `${new URL(input).pathname.replace('/storage/v1', '')}?token=signed-token-123` }), { status: 200, headers: { 'content-type': 'application/json' } });
                });
                previousStore = setMediaStore(new SupabaseStorageMediaStore({ url: 'https://abcd1234.supabase.co', key: 'sb_secret_0123456789abcdefghijKLMNOP', source: { url: 'database', key: 'database' } }));
                world.db.routes.unshift([/^INSERT INTO media_uploads/, () => ({ rows: [], rowCount: 1 })]);
            });
            afterEach(() => {
                setStorageFetch(previousFetch);
                setMediaStore(previousStore);
            });

            it('is owner only: an operator, who may do everything else here, is refused with 403 before anything is signed or written', async () => {
                role = 'operator';
                const res = await api('POST', '/explainers/uploads/sign', { purpose: 'music', mime: 'audio/mpeg', size: 3_000_000 });
                assert.equal(res.status, 403);
                assert.equal(res.body.code, 'INSUFFICIENT_TENANT_ROLE');
                assert.deepEqual(signed, []);
                assert.equal(world.ran(/^INSERT INTO media_uploads/).length, 0);
            });

            it('signs a track for the owner: 201 with the URL to PUT to, and the address the settings keep, on the public base', async () => {
                role = 'owner';
                const res = await api('POST', '/explainers/uploads/sign', { purpose: 'music', mime: 'audio/mpeg', size: 3_000_000 });
                assert.equal(res.status, 201);
                assert.deepEqual(Object.keys(res.body).sort(), ['media_id', 'upload_url', 'url']);
                assert.match(res.body.upload_url, /token=signed-token-123/);
                assert.equal(res.body.url, `${BASE}/api/uploads/${res.body.media_id}`);
                assert.equal(world.ran(/^INSERT INTO media_uploads/).length, 1);
                assert.equal(world.ran(/^INSERT INTO media_uploads/)[0]!.params[0], res.body.media_id);
                assert.equal(world.ran(/^INSERT INTO media_uploads/)[0]!.params[1], TENANT_A);
            });

            it('refuses a type the purpose does not take and a file over 25MB with every problem at once, and signs nothing', async () => {
                role = 'owner';
                const res = await api('POST', '/explainers/uploads/sign', { purpose: 'reference', mime: 'audio/mpeg', size: 30 * 1024 * 1024 });
                assert.equal(res.status, 400);
                assert.equal(res.body.problems.length, 2);
                assert.deepEqual(signed, []);
                assert.equal((await api('POST', '/explainers/uploads/sign', {})).status, 400);
                assert.equal((await api('POST', '/explainers/uploads/sign')).status, 400);
            });
        });

        describe('POST /api/studio/worker/explainers/:id/draw-next', () => {
            const drawing = () => {
                const job = world.addJob({ kind: 'explainer_draw', status: 'claimed', payload: { explainer_id: EXPLAINER_ID } });
                world.addExplainer({ id: EXPLAINER_ID, status: 'drawing', job_id: job.id });
                world.addScenes(3, undefined, EXPLAINER_ID);
                return job;
            };

            it('needs the worker’s bearer token: without one, or with another tenant’s, it never reaches the explainer', async () => {
                const job = drawing();
                let called = 0;
                setPictureDeps({ drawNext: async () => { called++; return { state: 'done' }; } });
                assert.equal((await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: job.id }, null)).status, 401);
                assert.equal((await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: job.id }, 'not-a-token')).status, 401);
                // Worker B belongs to another tenant: the explainer is not its tenant's, so it does not exist for it.
                const other = await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: job.id }, TOKEN_B);
                assert.equal(other.status, 404);
                assert.equal((await other.json() as { code: string }).code, 'EXPLAINER_NOT_FOUND');
                assert.equal(called, 0);
            });

            it('draws one step and answers what the pictures service answered', async () => {
                const job = drawing();
                setPictureDeps({ drawNext: async () => ({ state: 'drawn', position: 0, remaining: 2 }) });
                const res = await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: job.id });
                assert.equal(res.status, 200);
                assert.deepEqual(await res.json(), { state: 'drawn', position: 0, remaining: 2 });
                setPictureDeps({ drawNext: async () => ({ state: 'paused', until: '2026-10-26T00:05:00.000Z' }) });
                assert.deepEqual(await (await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: job.id })).json(), { state: 'paused', until: '2026-10-26T00:05:00.000Z' });
            });

            it('is 409 unless the job is the explainer’s own current drawing job, in the shared envelope, and the allowance is not touched', async () => {
                drawing();
                let called = 0;
                setPictureDeps({ drawNext: async () => { called++; return { state: 'done' }; } });
                const stale = await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: '77777777-7777-4777-8777-777777777777' });
                assert.equal(stale.status, 409);
                const body = await stale.json() as { code: string; params: unknown; error: string; message: string };
                assert.equal(body.code, 'EXPLAINER_BAD_STATE');
                assert.deepEqual(body.params, { status: 'drawing', to: 'draw' });
                assert.equal(body.message, body.error);
                assert.equal((await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, {})).status, 400);
                assert.equal(called, 0);
            });

            it('the last step moves the explainer to review, and the owner reads it so', async () => {
                const job = drawing();
                setPictureDeps({ drawNext: async () => ({ state: 'done' }) });
                assert.deepEqual(await (await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: job.id })).json(), { state: 'done' });
                const view = (await api('GET', `/explainers/${EXPLAINER_ID}`)).body;
                assert.equal(view.status, 'review');
            });

            it('works with the switch off: a drawing already under way is finished, and nothing new can be started (every dashboard route is 404)', async () => {
                const job = drawing();
                world.appSettings.delete(ENABLED);
                setPictureDeps({ drawNext: async () => ({ state: 'drawn', position: 1, remaining: 1 }) });
                assert.equal((await workerCall(`/worker/explainers/${EXPLAINER_ID}/draw-next`, { job_id: job.id })).status, 200);
                assert.equal((await api('POST', `/explainers/${EXPLAINER_ID}/draw`)).status, 404);
            });
        });
    });

    describe('POST /worker/jobs/:id/fail: a write that failed because the Mac is signed out', () => {
        beforeEach(on);
        const SIGNED_OUT = 'claude answered with an error: Failed to authenticate: OAuth session expired and could not be refreshed';

        it('is answered at once: the failure is recorded as any is, and then Gemini takes the work over, and a run starts', async () => {
            // Gemini is "writing" until the test lets it go: a run that fails at once would already be the next failure by the time it is read.
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            setRunDeps({ write: async () => { await gate; throw new Error('stop: this test only looks at the takeover'); } });
            const created = await api('POST', '/explainers', { topic: 'Why AI answers with confidence', language: 'en' });
            const mac = world.jobsOf('explainer_write')[0]!;
            mac.status = 'claimed';
            const res = await fetch(`${exBase}/api/studio/worker/jobs/${mac.id}/fail`, {
                method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN_A}` }, body: JSON.stringify({ error: SIGNED_OUT }),
            });
            assert.equal(res.status, 204);
            const view = (await api('GET', `/explainers/${created.body.id}`)).body;
            assert.equal(view.status, 'writing', 'Gemini is writing it now');
            assert.match(view.error, /Claude on the Mac is signed out, so Gemini is writing it/);
            const gemini = world.jobsOf('explainer_write').find((j) => j.payload.writer === 'gemini')!;
            assert.equal(gemini.status, 'claimed');
            assert.equal(view.job.status, 'claimed');
            assert.equal(launched.length, 1, 'one run, started after the response to the worker’s report was decided');
            release();
            await launched[0];
        });

        it('with the fallback off the failure stays what it is, with its reason, and nothing runs', async () => {
            world.settingsRow = explainerSettings({ characters: [KARIM], writer_fallback: false });
            const created = await api('POST', '/explainers', { topic: 'Why AI answers with confidence', language: 'en' });
            const mac = world.jobsOf('explainer_write')[0]!;
            mac.status = 'claimed';
            await fetch(`${exBase}/api/studio/worker/jobs/${mac.id}/fail`, {
                method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN_A}` }, body: JSON.stringify({ error: SIGNED_OUT }),
            });
            const view = (await api('GET', `/explainers/${created.body.id}`)).body;
            assert.equal(view.status, 'failed');
            assert.equal(view.failed_step, 'write');
            assert.equal(view.error, SIGNED_OUT);
            assert.equal(launched.length, 0);
        });
    });
});
