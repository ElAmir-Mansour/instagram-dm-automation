/**
 * The Growth hub through its routes, and the three places it touches existing ones: the reach
 * levers on `POST`/`PUT /posts/scheduled`, `attemptPublish` publishing without a refused lever,
 * and the daily cron's growth sweep.
 *
 * Handlers are pulled off the routers' own stacks and run against a stubbed pool, like
 * carousel.test.ts; Meta is a stubbed `metaHttp` that throws on anything not arranged.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from '../services/http.js';
import { API_VERSION } from '../services/instagram.js';
import apiRouter, { attemptPublish } from './api.js';
import { growthRouter } from './growth.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const WHEN = '2026-10-01T09:00:00Z';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

type Rows = { rows: any[]; rowCount?: number };
let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
let logs: { level: string; event: string; fields: any }[] = [];
const original = { query: pool.query, connect: pool.connect, post: metaHttp.post, get: metaHttp.get };

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => {
        try {
            const parsed = JSON.parse(line);
            logs.push({ level, event: parsed.event, fields: parsed });
        } catch {
            // not a structured line
        }
    });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    routes = [];
    logs = [];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as any).query = run;
    (pool as any).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).post = async (url: string) => { throw new Error(`no Meta POST arranged for ${url}`); };
    (metaHttp as any).get = async (url: string) => { throw new Error(`no Meta GET arranged for ${url}`); };
});

afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
    (metaHttp as any).post = original.post;
    (metaHttp as any).get = original.get;
});

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: any }

function handlerFor(router: unknown, method: string, path: string): Function {
    const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.at(-1)!.handle;
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        headers: {} as Record<string, string>,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        setHeader(name: string, value: string) { this.headers[name] = value; },
        end() { return this; },
    };
}

async function call(router: unknown, method: string, path: string, req: Record<string, unknown> = {}) {
    const res = fakeRes();
    await handlerFor(router, method, path)(
        { params: {}, query: {}, headers: {}, body: {}, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, tenantRole: 'operator', ...req },
        res, () => {}
    );
    return res;
}

const writes = (pattern: RegExp) => statements.filter((s) => pattern.test(s.sql));

// ─── /api/growth ─────────────────────────────────────────────────────────────────────────

describe('growth routes', () => {
    it('are all behind the operator role: a viewer is refused', async () => {
        const guard = (growthRouter as unknown as { stack: Layer[] }).stack[0]!;
        assert.equal(guard.route, undefined, 'the first layer is middleware for every route');
        assert.equal(guard.handle.minimumRole, 'operator');
        const res = fakeRes();
        let passed = false;
        await guard.handle({ session: { userId: 'u-1', tenantId: TENANT }, tenantRole: 'viewer', originalUrl: '/api/growth/sync' }, res, () => { passed = true; });
        assert.equal(passed, false);
        assert.equal(res.statusCode, 403);
    });

    it('POST /sync inside 10 minutes: 429 with Retry-After, and nothing else happens', async () => {
        routes.push(
            [/^INSERT INTO growth_settings \(creator_id, last_sync_at\)/, () => ({ rows: [] })],
            [/^SELECT CEIL/, () => ({ rows: [{ wait: 300 }] })],
        );
        const res = await call(growthRouter, 'post', '/sync');
        assert.equal(res.statusCode, 429);
        assert.equal(res.headers['Retry-After'], '300');
        assert.equal(res.body.retryAfter, 300);
        assert.match(res.body.error, /less than 10 minutes ago/);
        assert.equal(writes(/FROM creators/).length, 0);
    });

    it('answers 503 with the migration to run when v22 is missing', async () => {
        routes.push([/growth_settings/, () => { throw Object.assign(new Error('relation "growth_settings" does not exist'), { code: '42P01' }); }]);
        const res = await call(growthRouter, 'get', '/overview', { query: { days: '28' } });
        assert.equal(res.statusCode, 503);
        assert.match(res.body.error, /migration v22/);
    });

    it('GET /settings gives the empty defaults to a tenant with no row', async () => {
        const res = await call(growthRouter, 'get', '/settings');
        assert.deepEqual(res.body, { settings: { keywords: [], hashtag_sets: [], competitors: [], audience: {} } });
    });

    it('PUT /settings saves, audits, and refuses with every problem listed', async () => {
        const saved = await call(growthRouter, 'put', '/settings', { body: { keywords: ['برومبت'], competitors: ['@Rival'] } });
        assert.equal(saved.statusCode, 200);
        assert.deepEqual(saved.body.settings.competitors, ['rival']);
        assert.equal(writes(/^INSERT INTO growth_settings \(creator_id, keywords/).length, 1);
        assert.equal(writes(/INSERT INTO audit_log/).length, 1);

        statements = [];
        const refused = await call(growthRouter, 'put', '/settings', { body: { competitors: ['bad name!'], audience: { timezone: 'Nowhere/Here' } } });
        assert.equal(refused.statusCode, 400);
        assert.equal(refused.body.problems.length, 2);
        assert.equal(writes(/^INSERT INTO growth_settings/).length, 0);
    });

    it('POST /keywords/suggest needs a topic', async () => {
        const res = await call(growthRouter, 'post', '/keywords/suggest', { body: {} });
        assert.equal(res.statusCode, 400);
    });
});

// ─── The reach levers through /posts/scheduled ───────────────────────────────────────────

describe('POST and PUT /posts/scheduled — reach levers', () => {
    beforeEach(() => {
        routes.push(
            [/FROM creators WHERE id/, () => ({ rows: [{ id: TENANT, page_access_token: 'tok', instagram_page_id: 'ig-1', facebook_page_id: 'page-1' }] })],
            [/^INSERT INTO scheduled_posts/, (p) => ({ rows: [{ id: 'row-1', platform: p[1] }] })],
            [/^SELECT platform, post_type, status, media_url, media_urls, meta_options/, () => ({
                rows: [{ platform: 'both', post_type: 'video', status: 'PENDING', media_url: 'https://cdn/v.mp4', media_urls: null, meta_options: { trial_reel: { graduation: 'MANUAL' } } }],
            })],
            [/^UPDATE scheduled_posts/, () => ({ rows: [{ id: POST_ID }] })],
        );
    });
    const create = (body: Record<string, unknown>) =>
        call(apiRouter, 'post', '/posts/scheduled', { body: { scheduled_time: WHEN, ...body } });

    it('stores alt text and collaborators on the Meta row', async () => {
        const res = await create({ platform: 'both', post_type: 'image', media_url: 'https://cdn/p.jpg', alt_text: 'A slide', collaborators: ['@Partner'] });
        assert.equal(res.statusCode, 201);
        const [insert] = writes(/^INSERT INTO scheduled_posts/);
        assert.match(insert!.sql, /platform_options, meta_options\)/);
        assert.deepEqual(JSON.parse(insert!.params[10]), { alt_text: 'A slide', collaborators: ['partner'] });
    });

    it('refuses a malformed lever before writing, and stores none when none was sent', async () => {
        const bad = await create({ platform: 'instagram', post_type: 'video', media_url: 'https://cdn/v.mp4', trial_reel: { graduation: 'LATER' } });
        assert.equal(bad.statusCode, 400);
        assert.match(bad.body.error, /MANUAL or SS_PERFORMANCE/);
        assert.equal(writes(/^INSERT INTO scheduled_posts/).length, 0);

        await create({ platform: 'instagram', post_type: 'video', media_url: 'https://cdn/v.mp4' });
        assert.equal(writes(/^INSERT INTO scheduled_posts/)[0]!.params[10], null);
    });

    it('PUT merges a lever over the stored ones, and leaves them alone when it sends none', async () => {
        await call(apiRouter, 'put', '/posts/scheduled/:id', { params: { id: POST_ID }, body: { collaborators: ['b'] } });
        const [update] = writes(/^UPDATE scheduled_posts/);
        assert.match(update!.sql, /meta_options = CASE WHEN \$12::boolean THEN \$13::jsonb ELSE meta_options END/);
        assert.equal(update!.params[11], true);
        assert.deepEqual(JSON.parse(update!.params[12]), { trial_reel: { graduation: 'MANUAL' }, collaborators: ['b'] });

        statements = [];
        await call(apiRouter, 'put', '/posts/scheduled/:id', { params: { id: POST_ID }, body: { caption: 'new' } });
        assert.equal(writes(/^UPDATE scheduled_posts/)[0]!.params[11], false);
    });
});

// ─── attemptPublish with a refused lever ─────────────────────────────────────────────────

describe('attemptPublish — a lever Instagram refuses', () => {
    const creator = { id: null, page_access_token: 'tok', instagram_page_id: 'ig-1', facebook_page_id: 'page-1' };
    const reel = (meta_options: unknown) => ({
        id: POST_ID, platform: 'instagram', post_type: 'video', caption: 'c', media_url: 'https://cdn/v.mp4',
        cover_url: null, published_post_id: null, media_urls: null, meta_options: meta_options as never,
    });

    beforeEach(() => {
        (metaHttp as any).post = async (url: string, body: any) => {
            if (url === `${BASE}/ig-1/media`) {
                if (body.trial_params) {
                    throw Object.assign(new Error('bad'), { response: { status: 400, data: { error: { code: 100, message: 'Trial reels are unavailable' } } } });
                }
                return { data: { id: 'container-1' } };
            }
            if (url === `${BASE}/ig-1/media_publish`) return { data: { id: 'ig-reel-1' } };
            throw new Error(`no Meta POST arranged for ${url}`);
        };
        (metaHttp as any).get = async () => ({ data: { status_code: 'FINISHED' } });
    });

    it('publishes without it and keeps a note on the PUBLISHED row', async () => {
        const ids = await attemptPublish(reel({ trial_reel: { graduation: 'MANUAL' } }), creator);
        assert.deepEqual(ids, { fbId: null, igId: 'ig-reel-1' });
        const done = writes(/SET status = 'PUBLISHED'/)[0]!;
        assert.equal(done.params[0], 'IG:ig-reel-1');
        assert.match(done.params[2], /^Published without the trial reel: Instagram refused it for this account — Trial reels are unavailable/);
        assert.ok(logs.some((l) => l.event === 'publish.reach_options_dropped'));
    });

    it('writes no note when nothing was refused', async () => {
        await attemptPublish(reel(null), creator);
        assert.equal(writes(/SET status = 'PUBLISHED'/)[0]!.params[2], null);
    });
});

// ─── The daily cron ──────────────────────────────────────────────────────────────────────

describe('GET /cron/publish — the growth sweep', () => {
    const previousSecret = process.env.CRON_SECRET;
    before(() => { process.env.CRON_SECRET = 'test-cron-secret'; });
    after(() => {
        if (previousSecret === undefined) delete process.env.CRON_SECRET;
        else process.env.CRON_SECRET = previousSecret;
    });
    const cron = () => call(apiRouter, 'get', '/cron/publish', { headers: { authorization: 'Bearer test-cron-secret' } });

    it('syncs every active tenant after the publish sweep', async () => {
        routes.push(
            [/^SELECT id FROM creators WHERE is_active = TRUE ORDER BY created_at$/, () => ({ rows: [{ id: TENANT }] })],
            [/^INSERT INTO growth_settings \(creator_id, last_sync_at\)/, () => ({ rows: [{ last_sync_at: new Date() }] })],
            [/FROM creators WHERE id/, () => ({ rows: [{ id: TENANT, instagram_page_id: null, facebook_page_id: null, page_access_token: '' }] })],
        );
        const res = await cron();
        assert.equal(res.statusCode, 200);
        const line = logs.find((l) => l.event === 'cron.growth_sync');
        assert.ok(line, 'the sweep reports what it did');
        assert.equal(line!.fields.tenants, 1);
        assert.equal(line!.fields.synced, 1);
        assert.equal(writes(/^INSERT INTO growth_settings \(creator_id, last_sync\)/).length, 1, 'the tenant’s sync state was saved');
    });

    it('never fails the cron: a growth sweep that breaks is a log line, and the cron still answers 200', async () => {
        routes.push([/^SELECT id FROM creators WHERE is_active = TRUE ORDER BY created_at$/, () => { throw new Error('pool exhausted'); }]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        assert.ok(logs.some((l) => l.event === 'growth.cron_list_failed'));
        assert.equal(logs.find((l) => l.event === 'cron.growth_sync')?.fields.skippedReason, 'could not list tenants');
    });
});
