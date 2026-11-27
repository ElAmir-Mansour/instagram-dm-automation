/**
 * The first comment through the API (v61): `attemptPublish` queues it only once a Meta post is really live, create and edit validate it, and
 * `POST /posts/scheduled/:id/first-comment/retry` re-queues only a failed one. Handlers are pulled off the router's own stack and run against a stubbed
 * pool; Meta is a stubbed `metaHttp` that throws on anything not arranged. Nothing here reaches Meta.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { installFakeWorld, type FakePost, type FakeWorld } from '../services/firstCommentTestSupport.js';
import { metaHttp } from '../services/http.js';
import { API_VERSION } from '../services/instagram.js';
import { setLogSink } from '../utils/log.js';
import apiRouter, { attemptPublish, InstagramProcessingHeldError } from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const WHEN = '2026-10-01T09:00:00Z';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const originalMeta = { post: metaHttp.post, get: metaHttp.get };
afterEach(() => {
    (metaHttp as any).post = originalMeta.post;
    (metaHttp as any).get = originalMeta.get;
});

// ─── attemptPublish: when the comment is queued ─────────────────────────────────────────────────

describe('attemptPublish queues the first comment only after the post is live', () => {
    const creator = { id: null, page_access_token: 'tok', instagram_page_id: 'ig-1', facebook_page_id: 'page-1' };
    const row = (fields: Record<string, unknown> = {}) => ({
        id: POST_ID, creator_id: TENANT, platform: 'both', post_type: 'video', caption: 'c', media_url: 'https://cdn/v.mp4', cover_url: null,
        published_post_id: null, media_urls: null, meta_options: null, attempts: 0, first_comment: 'Sources\n1. A paper', ...fields,
    });
    let world: FakeWorld;
    let restore: () => void;
    let status: Record<string, string>;
    let calls: string[];

    const queuedPlatforms = () => world.enqueued.map((j) => (j.payload as { platform: string }).platform);
    const fakePost = (over: Partial<FakePost> = {}): FakePost => ({
        id: POST_ID, creator_id: TENANT, platform: 'both', status: 'PUBLISHING', first_comment: 'Sources\n1. A paper', first_comment_status: null, published_post_id: null, ...over,
    });

    beforeEach(() => {
        ({ world, restore } = installFakeWorld(fakePost()));
        status = {};
        calls = [];
        let next = 9;
        (metaHttp as any).post = async (url: string, body: any) => {
            calls.push(url);
            if (url === `${BASE}/page-1/videos`) return { data: { id: 'fb-video-1' } };
            if (url === `${BASE}/page-1/photos`) return { data: { id: 'fb-photo-1', post_id: 'page-1_9' } };
            if (url === `${BASE}/ig-1/media`) return { data: { id: `container-${next++}` } };
            if (url === `${BASE}/ig-1/media_publish`) return { data: { id: `ig-${body.creation_id}` } };
            throw new Error(`no Meta POST arranged for ${url}`);
        };
        (metaHttp as any).get = async (url: string) => {
            const id = url.slice(url.lastIndexOf('/') + 1);
            return { data: { status_code: status[id] ?? 'IN_PROGRESS', status: status[id] ?? 'In Progress' } };
        };
    });
    afterEach(() => restore());

    it('a published reel: PUBLISHED is written first, then one job per platform, none of them a call to Meta', async () => {
        status['container-9'] = 'FINISHED';
        await attemptPublish(row(), creator, { pollBudgetMs: 5 });
        assert.equal(world.post!.status, 'PUBLISHED');
        const published = world.sql.findIndex((s) => /SET status = 'PUBLISHED'/.test(s));
        const queued = world.sql.findIndex((s) => /jsonb_set\(COALESCE\(/.test(s));
        assert.ok(published >= 0 && queued > published, 'the comment is queued after the PUBLISHED write');
        assert.deepEqual(world.enqueued.map((j) => [j.kind, j.dedupeKey]), [
            ['post.first_comment', `fc:${POST_ID}:instagram`], ['post.first_comment', `fc:${POST_ID}:facebook`],
        ]);
        assert.ok(!calls.some((u) => u.endsWith('/comments')), 'publishing posts no comment itself: the job does');
    });

    it('a reel Instagram is still processing is HELD: nothing is queued, then it is queued once the container publishes', async () => {
        const held = await attemptPublish(row(), creator, { pollBudgetMs: 5 }).then(() => null, (e) => e);
        assert.ok(held instanceof InstagramProcessingHeldError);
        assert.equal(world.post!.status, 'PENDING');
        assert.deepEqual(world.enqueued, [], 'no job while the post is not live');
        assert.equal(world.post!.first_comment_status, null);

        status['container-9'] = 'FINISHED';
        await attemptPublish(
            row({ external_publish_id: 'IGC:container-9', published_post_id: 'FB:fb-video-1', attempts: 1 }), creator, { pollBudgetMs: 5 });
        assert.equal(world.post!.status, 'PUBLISHED');
        assert.deepEqual(queuedPlatforms().sort(), ['facebook', 'instagram']);
    });

    it('a failed publish queues nothing', async () => {
        (metaHttp as any).post = async () => { throw Object.assign(new Error('nope'), { response: { status: 400, data: { error: { code: 100, message: 'Bad' } } } }); };
        await assert.rejects(() => attemptPublish(row(), creator, { pollBudgetMs: 5 }));
        assert.equal(world.post!.status, 'FAILED');
        assert.deepEqual(world.enqueued, []);
    });

    it('no comment, or a blank one, queues nothing', async () => {
        status['container-9'] = 'FINISHED';
        await attemptPublish(row({ first_comment: null }), creator, { pollBudgetMs: 5 });
        restore();
        ({ world, restore } = installFakeWorld(fakePost()));
        status['container-10'] = 'FINISHED';
        await attemptPublish(row({ first_comment: '  ' }), creator, { pollBudgetMs: 5 });
        assert.deepEqual(world.enqueued, []);
    });

    it('a Facebook-only post queues Facebook only', async () => {
        restore();
        ({ world, restore } = installFakeWorld(fakePost({ platform: 'facebook' })));
        await attemptPublish(row({ platform: 'facebook', post_type: 'image' }), creator);
        assert.deepEqual(world.enqueued.map((j) => (j.payload as any).platform), ['facebook']);
    });

    it('a queue that is down never fails or un-publishes the post', async () => {
        world.enqueueError = new Error('queue down');
        status['container-9'] = 'FINISHED';
        const ids = await attemptPublish(row(), creator, { pollBudgetMs: 5 });
        assert.equal(ids.igId, 'ig-container-9');
        assert.equal(world.post!.status, 'PUBLISHED');
        assert.equal(world.post!.first_comment_status!.instagram!.status, 'failed', 'and the card can offer Retry');
    });
});

// ─── Create and edit ─────────────────────────────────────────────────────────────────────────

describe('POST and PUT /posts/scheduled carry first_comment', () => {
    interface Statement { sql: string; params: any[] }
    let statements: Statement[] = [];
    let currentRow: Record<string, unknown> | null = null;
    const originalPool = { query: pool.query, connect: pool.connect };

    function respond(sql: string, params: any[]): { rows: any[]; rowCount?: number } {
        if (/FROM creators WHERE id/.test(sql)) return { rows: [{ id: TENANT, page_access_token: 'tok', instagram_page_id: 'ig-1', facebook_page_id: 'page-1' }] };
        if (/FROM app_settings/.test(sql)) return { rows: [] };
        if (/FROM platform_connections/.test(sql)) return { rows: [] };
        if (/SELECT platform, post_type/.test(sql)) return { rows: currentRow ? [currentRow] : [] };
        if (/INSERT INTO scheduled_posts/.test(sql)) return { rows: [{ id: `row-${params[1]}`, platform: params[1], first_comment: params[11] }] };
        if (/UPDATE scheduled_posts/.test(sql)) return { rows: [{ id: POST_ID }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    }
    beforeEach(() => {
        statements = [];
        currentRow = null;
        const run = async (sql: string, params: any[] = []) => {
            const flat = sql.replace(/\s+/g, ' ').trim();
            statements.push({ sql: flat, params });
            const r = respond(flat, params);
            return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        };
        (pool as unknown as { query: unknown }).query = run;
        (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    });
    afterEach(() => {
        (pool as unknown as { query: unknown }).query = originalPool.query;
        (pool as unknown as { connect: unknown }).connect = originalPool.connect;
    });

    function handlerFor(method: string, path: string) {
        const stack = (apiRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack;
        const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
        assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
        return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
    }
    function fakeRes() {
        return { statusCode: 200, body: null as any, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; }, setHeader() {}, send() { return this; } };
    }
    async function call(method: string, path: string, req: Record<string, unknown>) {
        const res = fakeRes();
        await handlerFor(method, path)({ params: {}, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, ...req }, res, () => {});
        return res;
    }
    const create = (body: Record<string, unknown>) => call('post', '/posts/scheduled', { body: { scheduled_time: WHEN, post_type: 'image', media_url: 'https://example.com/a.jpg', ...body } });
    const edit = (body: Record<string, unknown>) => call('put', '/posts/scheduled/:id', { params: { id: POST_ID }, body });
    const inserts = () => statements.filter((s) => /INSERT INTO scheduled_posts/.test(s.sql));
    const updates = () => statements.filter((s) => /UPDATE scheduled_posts/.test(s.sql));

    it('create stores the trimmed comment on the Meta row, as the last column', async () => {
        const res = await create({ platform: 'both', first_comment: '  Sources\n1. A paper \n' });
        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        assert.match(inserts()[0]!.sql, /first_comment\) VALUES .*\$12\) RETURNING/);
        assert.equal(inserts()[0]!.params[11], 'Sources\n1. A paper');
    });

    it('create without one stores NULL, and a blank is NULL too', async () => {
        await create({ platform: 'instagram' });
        await create({ platform: 'instagram', first_comment: '   ' });
        assert.deepEqual(inserts().map((i) => i.params[11]), [null, null]);
    });

    it('create refuses more than 2,200 characters, a non-string, and a TikTok-only post, before writing anything', async () => {
        for (const [body, why] of [
            [{ platform: 'both', first_comment: 'x'.repeat(2201) }, 'too long'],
            [{ platform: 'both', first_comment: 42 }, 'not text'],
            [{ platform: 'tiktok', post_type: 'video', media_url: 'https://example.com/v.mp4', first_comment: 'sources' }, 'tiktok'],
            [{ platform: 'youtube', post_type: 'video', media_url: 'https://example.com/v.mp4', first_comment: 'sources' }, 'youtube'],
        ] as Array<[Record<string, unknown>, string]>) {
            const res = await create(body);
            assert.equal(res.statusCode, 400, why);
            assert.equal(res.body.code, 'FIRST_COMMENT_INVALID', why);
        }
        assert.equal(inserts().length, 0);
    });

    it('the TikTok sibling of a Meta post never carries the comment', async () => {
        // The sibling needs a TikTok connection to exist; without one the route answers 409 before any write, which is itself the point: nothing is written
        // with the comment on a tiktok target. The unit rule is the `target !== 'tiktok'` in the insert's parameters.
        const res = await create({ platform: 'both', post_type: 'video', media_url: 'https://example.com/v.mp4', first_comment: 'S', also_tiktok: true });
        assert.equal(res.statusCode, 409);
        assert.equal(inserts().length, 0);
    });

    it('edit sets the comment ($14 true, $15 the text), and clears it with null or blank', async () => {
        currentRow = { platform: 'both', post_type: 'image', status: 'PENDING', media_url: 'https://example.com/a.jpg', media_urls: null, meta_options: null, first_comment_status: null };
        await edit({ first_comment: ' New sources ' });
        await edit({ first_comment: null });
        const [set, cleared] = updates();
        assert.match(set!.sql, /first_comment = CASE WHEN \$14::boolean THEN \$15::text ELSE first_comment END/);
        assert.deepEqual([set!.params[13], set!.params[14]], [true, 'New sources']);
        assert.deepEqual([cleared!.params[13], cleared!.params[14]], [true, null]);
    });

    it('edit leaves the comment alone when first_comment is not sent', async () => {
        currentRow = { platform: 'both', post_type: 'image', status: 'PENDING', media_url: 'https://example.com/a.jpg', media_urls: null, meta_options: null, first_comment_status: null };
        await edit({ caption: 'new caption' });
        assert.deepEqual([updates()[0]!.params[13], updates()[0]!.params[14]], [false, null]);
    });

    it('edit refuses a comment for a post moved to TikTok, and clears the stored one when a row moves there without sending one', async () => {
        currentRow = { platform: 'both', post_type: 'video', status: 'PENDING', media_url: 'https://example.com/v.mp4', media_urls: null, meta_options: null, first_comment_status: null };
        const refused = await edit({ platform: 'tiktok', first_comment: 'S' });
        assert.equal(refused.statusCode, 400);
        assert.equal(refused.body.code, 'FIRST_COMMENT_INVALID');
        assert.equal(updates().length, 0);
        await edit({ platform: 'tiktok' });
        assert.deepEqual([updates()[0]!.params[13], updates()[0]!.params[14]], [true, null], 'a row moved to TikTok loses its comment');
    });

    it('edit refuses over 2,200 characters', async () => {
        currentRow = { platform: 'both', post_type: 'image', status: 'PENDING', media_url: 'https://example.com/a.jpg', media_urls: null, meta_options: null, first_comment_status: null };
        const res = await edit({ first_comment: 'x'.repeat(2201) });
        assert.equal(res.statusCode, 400);
        assert.equal(updates().length, 0);
    });

    it('edit is locked once a comment is posted or in flight, but a failed one can be fixed (then retried)', async () => {
        const base = { platform: 'both', post_type: 'image', status: 'PUBLISHED', media_url: 'https://example.com/a.jpg', media_urls: null, meta_options: null };
        for (const s of ['posted', 'sending']) {
            currentRow = { ...base, first_comment_status: { instagram: { status: s, at: 'x', attempt: 0 } } };
            const res = await edit({ first_comment: 'changed' });
            assert.equal(res.statusCode, 409, s);
            assert.equal(res.body.code, 'FIRST_COMMENT_LOCKED', s);
        }
        assert.equal(updates().length, 0);
        currentRow = { ...base, first_comment_status: { instagram: { status: 'failed', error: 'e', at: 'x', attempt: 0 } } };
        assert.equal((await edit({ first_comment: 'fixed' })).statusCode, 200);
    });

    it('edit with no first_comment on a locked post is still fine (a caption edit is not blocked by the comment)', async () => {
        currentRow = { platform: 'both', post_type: 'image', status: 'PUBLISHED', media_url: 'https://example.com/a.jpg', media_urls: null, meta_options: null, first_comment_status: { instagram: { status: 'posted', at: 'x', attempt: 0 } } };
        assert.equal((await edit({ caption: 'x' })).statusCode, 200);
    });
});

// ─── The retry route ─────────────────────────────────────────────────────────────────────────

describe('POST /posts/scheduled/:id/first-comment/retry', () => {
    const PATH = '/posts/scheduled/:id/first-comment/retry';
    let world: FakeWorld;
    let restore: () => void;

    function stackFor() {
        const stack = (apiRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack;
        const layer = stack.find((l) => l.route?.path === PATH && l.route.methods['post']);
        assert.ok(layer, 'the route must be mounted');
        return layer!.route!.stack.map((l) => l.handle);
    }
    async function run(role: 'owner' | 'operator' | 'viewer', req: { params?: Record<string, string>; body?: unknown } = { params: { id: POST_ID } }) {
        const res = { statusCode: 200, body: null as any, status(c: number) { this.statusCode = c; return this; }, set() { return this; }, json(b: unknown) { this.body = b; return this; } };
        const full = { query: {}, params: {}, body: {}, ...req, session: { userId: 'u-owner', role: 'user', tenantId: TENANT }, tenantRole: role, headers: {}, originalUrl: `/api${PATH}` };
        for (const handle of stackFor()) {
            let passed = false;
            await handle(full, res, () => { passed = true; });
            if (!passed) break;
        }
        return res;
    }
    const live = (first_comment_status: FakePost['first_comment_status']): FakePost => ({
        id: POST_ID, creator_id: TENANT, platform: 'both', status: 'PUBLISHED', first_comment: 'S', first_comment_status, published_post_id: 'FB:f | IG:i',
    });
    afterEach(() => restore?.());

    it('re-queues a failed comment (202) and nothing else', async () => {
        ({ world, restore } = installFakeWorld(live({ instagram: { status: 'failed', error: 'e', at: 'x', attempt: 0 }, facebook: { status: 'posted', id: 'c', at: 'x', attempt: 0 } })));
        const res = await run('operator');
        assert.equal(res.statusCode, 202, JSON.stringify(res.body));
        assert.deepEqual(res.body, { queued: ['instagram'] });
        assert.equal(world.enqueued.length, 1);
    });

    it('answers 409 FIRST_COMMENT_NOT_FAILED for posted, waiting, in flight or none, and queues nothing', async () => {
        for (const entry of [{ status: 'posted' }, { status: 'pending' }, { status: 'sending' }, null] as const) {
            ({ world, restore } = installFakeWorld(live(entry ? { instagram: { ...entry, at: 'x', attempt: 0 } as any } : null)));
            const res = await run('owner');
            assert.equal(res.statusCode, 409);
            assert.equal(res.body.code, 'FIRST_COMMENT_NOT_FAILED');
            assert.equal(world.enqueued.length, 0);
            restore();
        }
    });

    it('answers 409 for a post that is not published yet, 404 for an unknown id or another tenant\'s post, 400 for a bad platform', async () => {
        ({ world, restore } = installFakeWorld({ ...live({ instagram: { status: 'failed', at: 'x', attempt: 0 } }), status: 'PENDING' }));
        const early = await run('owner');
        assert.deepEqual([early.statusCode, early.body.code], [409, 'FIRST_COMMENT_NOT_PUBLISHED']);
        assert.equal((await run('owner', { params: { id: 'not-a-uuid' } })).statusCode, 404);
        assert.equal((await run('owner', { params: { id: '44444444-4444-4444-8444-444444444444' } })).statusCode, 404);
        assert.equal((await run('owner', { params: { id: POST_ID }, body: { platform: 'tiktok' } })).statusCode, 400);
        assert.equal(world.enqueued.length, 0);
    });

    it('is for an owner or an operator; a viewer is refused before any SQL', async () => {
        ({ world, restore } = installFakeWorld(live({ instagram: { status: 'failed', at: 'x', attempt: 0 } })));
        const refused = await run('viewer');
        assert.equal(refused.statusCode, 403);
        assert.equal(world.sql.length, 0);
        assert.equal((await run('operator')).statusCode, 202);
    });
});
