/**
 * `/api/settings/ai/muse/library` (T054, contracts/api.md "Video memory"): the owner's own reels, as the agent remembers them, and the two buttons that get them watched.
 *
 * Run through each route's WHOLE stack (guard, then handler) with the video memory's in-memory world (`perception/reelTestWorld.ts`): the settings and the cap, the
 * library table, Instagram's media list and the job queue, none of it real. What is pinned:
 *
 *   - **who**: the tenant's owner on every route, reads included; an operator or a viewer is refused with 403 before anything is read; and the router is mounted on the API
 *     router BELOW `resolveTenant`, once;
 *   - **a press queues, it does not watch**: no model call, no download, and the jobs carry ids only; a second press the same day queues nothing (the day's dedupe key);
 *   - **what it refuses, and why**: the memory switch off (409 `MUSE_MEMORY_OFF`), no model routed (409), no Meta connection (409), a dead credential (409, never 401),
 *     Instagram down (502); each before a job is written;
 *   - **a tenant sees only its own library**: a row of another tenant is a 404, a list never holds it, and a re-index of it queues nothing;
 *   - **the library is readable with the switch off**: what was indexed stays viewable.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { INSUFFICIENT_ROLE_CODE, invalidateTenantCache, resolveTenant } from '../services/tenant.js';
import { configure, graphError, installWorld, OTHER_TENANT, PAGE_TOKEN, TENANT, type World } from '../services/perception/reelTestWorld.js';
import { storeAnalysis, storeFailure, upsertPending } from '../services/perception/reelLibrary.js';
import apiRouter from './api.js';
import { museLibraryRouter } from './museLibrary.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Json = any;

function stackFor(method: string, path: string): Handle[] {
    const stack = (museLibraryRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as Json,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

async function run(method: 'get' | 'post', path: string, over: { role?: string; tenantId?: string; params?: Record<string, string> } = {}) {
    const res = fakeRes();
    const req = {
        session: { userId: 'u-owner', role: 'user', tenantId: over.tenantId ?? TENANT },
        body: {}, params: over.params ?? {}, tenantRole: over.role ?? 'owner',
    };
    for (const handle of stackFor(method, path)) {
        let passed = false;
        await handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

let world: World;
let savedKey: string | undefined;
beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    invalidateTenantCache();
    world = installWorld();
    configure(world, { route: 'baseten' });
});
afterEach(() => {
    world.restore();
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

const media = (id: string) => ({ id, media_type: 'VIDEO', media_product_type: 'REELS', permalink: `https://www.instagram.com/reel/${id}/`, timestamp: '2026-10-20T12:00:00+0000' });
const analysis = { summary: 'A reel about APIs', topics: ['api'], seen_on_screen: [], narration: 'n', key_moments: [{ second: 3, what: 'w' }], hook_first_3s: 'h', hook_score: 8, caption_ar: 'c', cover_second: 1, cover_reason: 'r' };
const addOk = (id: string, tenant = TENANT, over: Partial<{ postedAt: string }> = {}) =>
    storeAnalysis(tenant, id, { permalink: `https://www.instagram.com/reel/${id}/`, postedAt: over.postedAt ?? '2026-10-20T12:00:00.000Z', youtubeUrl: null, result: analysis, model: 'muse-spark-1.3', ms: 1000, usd: 0.02 });
const printed = () => JSON.stringify([world.logs, world.queue.enqueued, world.reel.statements]);

const ROUTES: Array<['get' | 'post', string]> = [['get', '/'], ['get', '/:id'], ['post', '/index'], ['post', '/:id/index']];

describe('/settings/ai/muse/library: who may reach it', () => {
    it('is mounted on the API router BELOW resolveTenant, once, so it always acts as the session\'s tenant', () => {
        const layers = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown; matchers?: unknown }> }).stack;
        const mounts = layers.filter((l) => !l.route && l.handle === museLibraryRouter);
        assert.equal(mounts.length, 1, 'one mount');
        assert.ok(layers.indexOf(mounts[0]!) > layers.findIndex((l) => !l.route && l.handle === resolveTenant), 'below resolveTenant');
    });

    it('carries the owner guard on every route it has, reads included', () => {
        const stack = (museLibraryRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { minimumRole?: string } }> } }> }).stack;
        const routes = stack.filter((l) => l.route).map((l) => ({ key: `${Object.keys(l.route!.methods)[0]!.toUpperCase()} ${l.route!.path}`, guard: l.route!.stack.map((s) => s.handle.minimumRole).find(Boolean) }));
        assert.deepEqual(routes.map((r) => r.key).sort(), ['GET /', 'GET /:id', 'POST /:id/index', 'POST /index']);
        for (const r of routes) assert.equal(r.guard, 'owner', r.key);
    });

    it('refuses an operator and a viewer on every route with 403 before anything is read, written or asked of Instagram', async () => {
        await addOk('9001');
        const id = world.reel.reels[0]!.id;
        world.reel.statements.length = 0;
        for (const role of ['operator', 'viewer']) {
            for (const [method, path] of ROUTES) {
                const res = await run(method, path, { role, params: { id } });
                assert.equal(res.statusCode, 403, `${role} ${method} ${path}`);
                assert.equal(res.body.code, INSUFFICIENT_ROLE_CODE);
                assert.equal(res.body.requiredRole, 'owner');
            }
        }
        assert.equal(world.reel.statements.length, 0, 'no statement ran');
        assert.equal(world.graph.calls.length, 0);
        assert.equal(world.queue.enqueued.length, 0);
    });

    it('lets the owner through on every route', async () => {
        await addOk('9001');
        const id = world.reel.reels[0]!.id;
        world.graph.pages.push({ data: [media('9001')] });
        for (const [method, path] of ROUTES) {
            const res = await run(method, path, { params: { id } });
            assert.ok([200, 202].includes(res.statusCode), `${method} ${path}: ${res.statusCode} ${JSON.stringify(res.body)}`);
        }
    });
});

describe('GET /: the list', () => {
    it('is the contract\'s array, newest reel first, with what a screen needs beside the summary and the hook score', async () => {
        await addOk('9001', TENANT, { postedAt: '2026-10-01T00:00:00.000Z' });
        await addOk('9002', TENANT, { postedAt: '2026-10-10T00:00:00.000Z' });
        await upsertPending(TENANT, [{ igMediaId: '9003', permalink: 'https://www.instagram.com/reel/9003/', postedAt: '2026-10-05T00:00:00.000Z' }]);
        await storeFailure(TENANT, '9004', { permalink: null, postedAt: '2026-09-01T00:00:00.000Z', result: { error: 'too_large' }, model: null, ms: null, usd: null });
        const res = await run('get', '/');
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body));
        assert.deepEqual(res.body.map((r: Json) => [r.ig_media_id, r.status, r.summary, r.hook_score, r.error]), [
            ['9002', 'ok', 'A reel about APIs', 8, null], ['9003', 'pending', null, null, null], ['9001', 'ok', 'A reel about APIs', 8, null], ['9004', 'failed', null, null, 'too_large'],
        ]);
        for (const field of ['id', 'permalink', 'posted_at', 'status', 'summary', 'hook_score']) assert.ok(field in res.body[0], field);
        assert.equal(res.body[0].permalink, 'https://www.instagram.com/reel/9002/');
        assert.equal(res.body[0].posted_at, '2026-10-10T00:00:00.000Z');
    });

    it('is empty for a tenant with no library, never another tenant\'s, and works with the memory switch off: what was indexed stays viewable', async () => {
        await addOk('9001', OTHER_TENANT);
        assert.deepEqual((await run('get', '/')).body, []);
        await addOk('9002');
        world.ai.settings.delete(`muse.switches.${TENANT}`);
        const res = await run('get', '/');
        assert.deepEqual(res.body.map((r: Json) => r.ig_media_id), ['9002']);
        assert.equal(world.graph.calls.length, 0, 'a read asks Instagram nothing');
    });

    it('answers a generic 500, with the cause in the log and nothing of the database in the body, when the table cannot be read', async () => {
        world.reel.failOn(/FROM reel_analyses/, new Error('relation "reel_analyses" does not exist (secret detail)'), 1);
        const res = await run('get', '/');
        assert.equal(res.statusCode, 500);
        assert.deepEqual(Object.keys(res.body), ['error']);
        assert.ok(!JSON.stringify(res.body).includes('secret detail'));
        assert.equal(world.logs.filter((l) => l.event === 'muse.library_list_failed').length, 1);
    });
});

describe('GET /:id: the full result', () => {
    it('is the analysis exactly as stored, for the tenant\'s own reel', async () => {
        const id = (await addOk('9001'))!;
        const res = await run('get', '/:id', { params: { id } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, analysis);
    });

    it('is { error, detail } for a reel that could not be watched, and {} while it is queued', async () => {
        await storeFailure(TENANT, '9004', { permalink: null, postedAt: null, result: { error: 'provider_error', detail: 'baseten:server:503 | meta:server:503' }, model: null, ms: null, usd: null });
        await upsertPending(TENANT, [{ igMediaId: '9005', permalink: null, postedAt: null }]);
        const [failed, pending] = world.reel.reels.map((r) => r.id);
        assert.deepEqual((await run('get', '/:id', { params: { id: failed! } })).body, { error: 'provider_error', detail: 'baseten:server:503 | meta:server:503' });
        assert.deepEqual((await run('get', '/:id', { params: { id: pending! } })).body, {});
    });

    it('is a 404 for another tenant\'s row, an unknown id and a malformed one, with the same body for all three', async () => {
        const theirs = (await addOk('9001', OTHER_TENANT))!;
        const bodies = [];
        for (const id of [theirs, '00000000-0000-4000-8000-0000000000ff', 'not-a-uuid', "1' OR '1'='1"]) {
            const res = await run('get', '/:id', { params: { id } });
            assert.equal(res.statusCode, 404, id);
            bodies.push(res.body);
        }
        assert.deepEqual(new Set(bodies.map((b) => JSON.stringify(b))).size, 1);
        assert.equal(bodies[0].code, 'REEL_NOT_FOUND');
    });
});

describe('POST /index: index all my reels', () => {
    it('queues a pending row and one job for every reel without an ok row, answers 202 with the counts, and watches nothing', async () => {
        await addOk('9001');
        world.graph.pages.push({ data: [media('9001'), media('9002'), media('9003')] });
        const res = await run('post', '/index');
        assert.equal(res.statusCode, 202);
        assert.deepEqual(res.body, { queued: 2, already_indexed: 1, deduped: 0, listed: 3, truncated: false });
        assert.deepEqual(world.queue.enqueued.map((j) => [j.kind, (j.payload as { igMediaId: string }).igMediaId, j.maxAttempts]), [['muse.reel_index', '9002', 3], ['muse.reel_index', '9003', 3]]);
        assert.deepEqual(world.reel.reels.map((r) => [r.ig_media_id, r.status]), [['9001', 'ok'], ['9002', 'pending'], ['9003', 'pending']]);
        assert.equal(world.providers.calls.length, 0, 'no model was called');
        assert.equal(world.downloads.urls.length, 0, 'nothing was downloaded');
        assert.deepEqual(world.graph.calls.map((c) => c.path), [`${world.reel.creators.get(TENANT)!.instagram_page_id}/media`], 'one read of the media list, and nothing per reel');
        assert.ok(!printed().includes(PAGE_TOKEN) && !JSON.stringify(res.body).includes(PAGE_TOKEN));
        assert.deepEqual(world.logs.filter((l) => l.event === 'muse.library_index_requested').map((l) => [l['scope'], l['queued'], l['already_indexed'], l['user_id']]), [['all', 2, 1, 'u-owner']]);
    });

    it('queues nothing on a second press the same day: the day\'s dedupe key is taken, whatever state the first jobs are in', async () => {
        world.graph.pages.push({ data: [media('9001'), media('9002')] }, { data: [media('9001'), media('9002')] });
        assert.equal((await run('post', '/index')).body.queued, 2);
        const again = await run('post', '/index');
        assert.equal(again.statusCode, 202);
        assert.deepEqual(again.body, { queued: 0, already_indexed: 0, deduped: 2, listed: 2, truncated: false });
        assert.equal(world.queue.enqueued.length, 2);
    });

    it('is a 409 MUSE_MEMORY_OFF with the switch off, which is every tenant\'s default, before Instagram is asked or a job written', async () => {
        world.ai.settings.delete(`muse.switches.${TENANT}`);
        const res = await run('post', '/index');
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'MUSE_MEMORY_OFF');
        assert.equal(world.graph.calls.length, 0);
        assert.equal(world.queue.enqueued.length, 0);
        assert.equal(world.reel.reels.length, 0);
        // Another capability being on does not open it.
        world.ai.setSetting(`muse.switches.${TENANT}`, JSON.stringify({ dm_media: true, voice: true, memory: false }));
        assert.equal((await run('post', '/index')).body.code, 'MUSE_MEMORY_OFF');
    });

    it('is a 409 AI_NOT_CONFIGURED when no model is routed to watch reels yet, rather than queueing jobs that would all do nothing', async () => {
        world.ai.settings.delete('ai.providers.baseten.api_key');
        world.ai.settings.delete('ai.providers.meta.api_key');
        const res = await run('post', '/index');
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'AI_NOT_CONFIGURED');
        assert.equal(world.queue.enqueued.length, 0);
        assert.equal(world.graph.calls.length, 0);
    });

    it('says what is wrong with Instagram in words the owner can act on, and never answers 401 or 403, which the dashboard reads as "signed out"', async () => {
        world.reel.creators.get(TENANT)!.page_access_token = null;
        let res = await run('post', '/index');
        assert.deepEqual([res.statusCode, res.body.code], [409, 'META_NOT_CONNECTED']);
        world.reel.creators.get(TENANT)!.page_access_token = PAGE_TOKEN;
        for (const [err, status, code] of [[graphError(400, 190, 463), 409, 'TOKEN_INVALID'], [graphError(500, 1), 502, 'META_UNAVAILABLE'], [graphError(403, 200), 502, 'META_ERROR']] as const) {
            world.graph.pages.push(err);
            res = await run('post', '/index');
            assert.deepEqual([res.statusCode, res.body.code], [status, code]);
            assert.ok(![401, 403].includes(res.statusCode));
            assert.ok(!JSON.stringify(res.body).includes(PAGE_TOKEN));
        }
        assert.equal(world.queue.enqueued.length, 0);
        assert.equal(world.reel.reels.length, 0);
    });

    it('answers a generic 500 and logs the cause when the database fails', async () => {
        world.graph.pages.push({ data: [media('9001')] });
        world.reel.failOn(/^SELECT ig_media_id, status FROM reel_analyses/, new Error('connection terminated (secret detail)'), 1);
        const res = await run('post', '/index');
        assert.equal(res.statusCode, 500);
        assert.ok(!JSON.stringify(res.body).includes('secret detail'));
        assert.equal(world.logs.filter((l) => l.event === 'muse.library_index_failed').length, 1);
    });
});

describe('POST /:id/index: re-index one reel', () => {
    it('queues one job for the reel whatever its state, answers 202, and leaves an ok row ok until the new analysis replaces it', async () => {
        const id = (await addOk('9001'))!;
        const res = await run('post', '/:id/index', { params: { id } });
        assert.equal(res.statusCode, 202);
        assert.deepEqual(res.body, { queued: true });
        assert.deepEqual(world.queue.enqueued.map((j) => [j.kind, JSON.stringify(j.payload), j.maxAttempts]), [['muse.reel_index', JSON.stringify({ creatorId: TENANT, igMediaId: '9001' }), 3]]);
        assert.match(world.queue.enqueued[0]!.dedupeKey!, /^reel:9001:\d{4}-\d{2}-\d{2}:redo:\d{4}$/, 'its own key, not the day\'s');
        assert.equal(world.reel.reels[0]!.status, 'ok', 'the analysis it has is still what recall reads');
        assert.equal(world.providers.calls.length, 0);
        assert.equal(world.graph.calls.length, 0, 'the reel is read from Instagram by the job, not by the press');
    });

    it('is not swallowed by an analysis made today: a day\'s job exists for the reel and the re-index is still queued', async () => {
        const id = (await addOk('9001'))!;
        world.queue.jobs.set(`reel:9001:${new Date().toISOString().slice(0, 10)}`, 'job-0');
        assert.equal((await run('post', '/:id/index', { params: { id } })).body.queued, true);
        assert.equal(world.queue.enqueued.length, 1);
    });

    it('turns a failed reel back into queued, and a double click in the same minute into one job', async () => {
        await storeFailure(TENANT, '9004', { permalink: 'https://www.instagram.com/reel/9004/', postedAt: null, result: { error: 'timeout' }, model: null, ms: null, usd: null });
        const id = world.reel.reels[0]!.id;
        const first = await run('post', '/:id/index', { params: { id } });
        assert.deepEqual(first.body, { queued: true });
        assert.equal(world.reel.reels[0]!.status, 'pending');
        const second = await run('post', '/:id/index', { params: { id } });
        assert.equal(second.statusCode, 202);
        assert.deepEqual(second.body, { queued: false });
        assert.equal(world.queue.enqueued.length, 1);
    });

    it('is a 404 for another tenant\'s reel, an unknown id and a malformed one, and queues nothing for any', async () => {
        const theirs = (await addOk('9001', OTHER_TENANT))!;
        for (const id of [theirs, '00000000-0000-4000-8000-0000000000ff', 'nope']) {
            const res = await run('post', '/:id/index', { params: { id } });
            assert.equal(res.statusCode, 404, id);
            assert.equal(res.body.code, 'REEL_NOT_FOUND');
        }
        assert.equal(world.queue.enqueued.length, 0);
    });

    it('is a 409 for a row with no Instagram id, which cannot be watched again', async () => {
        world.reel.reels.push({
            id: '00000000-0000-4000-8000-0000000000aa', creator_id: TENANT, ig_media_id: null, permalink: 'https://www.instagram.com/reel/XYZ/', youtube_url: null, posted_at: null,
            status: 'failed', result: { error: 'not_found' }, model: null, ms: null, usd: null, created_at: new Date(), updated_at: new Date(),
        });
        const res = await run('post', '/:id/index', { params: { id: '00000000-0000-4000-8000-0000000000aa' } });
        assert.deepEqual([res.statusCode, res.body.code], [409, 'NO_MEDIA_ID']);
        assert.equal(world.queue.enqueued.length, 0);
    });

    it('is refused with the switch off and with no model routed, as the bulk press is, and queues nothing', async () => {
        const id = (await addOk('9001'))!;
        world.ai.settings.delete(`muse.switches.${TENANT}`);
        assert.deepEqual([(await run('post', '/:id/index', { params: { id } })).statusCode, (await run('post', '/:id/index', { params: { id } })).body.code], [409, 'MUSE_MEMORY_OFF']);
        configure(world, { route: 'baseten' });
        world.ai.settings.delete('ai.providers.baseten.api_key');
        world.ai.settings.delete('ai.providers.meta.api_key');
        assert.equal((await run('post', '/:id/index', { params: { id } })).body.code, 'AI_NOT_CONFIGURED');
        assert.equal(world.queue.enqueued.length, 0);
    });
});
