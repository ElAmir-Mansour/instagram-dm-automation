/**
 * Carousels through the API: what the create and edit routes accept and store, what
 * `attemptPublish` does with a carousel row, and the upload route's file extension.
 *
 * Handlers are pulled off the router's own stack and run against a stubbed pool, as the
 * edit-guard tests in api.test.ts do, and Meta is a stubbed `metaHttp` that throws on anything
 * not arranged — there are live credentials in `.env`, and nothing here may publish.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from '../services/http.js';
import { API_VERSION } from '../services/instagram.js';
import { setMediaStore, type MediaStore } from '../services/storage.js';
import apiRouter, { attemptPublish } from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const JPEG = '0b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const JPEG2 = '1b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const PNG = '2b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const WEBP = '3b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const MIMES: Record<string, string> = {
    [JPEG]: 'image/jpeg', [JPEG2]: 'image/jpeg', [PNG]: 'image/png', [WEBP]: 'image/webp',
};
const up = (id: string) => `https://msg-response-auto.vercel.app/api/uploads/${id}`;
const WHEN = '2026-10-01T09:00:00Z';

interface Statement { sql: string; params: any[] }
let statements: Statement[] = [];
let settings: Record<string, string> = {};
let connection: Record<string, unknown> | null = null;
let currentRow: Record<string, unknown> | null = null;
const originalPool = { query: pool.query, connect: pool.connect };

function respond(sql: string, params: any[]): { rows: any[]; rowCount?: number } {
    if (/FROM creators WHERE id/.test(sql)) {
        return { rows: [{ id: TENANT, page_access_token: 'tok', instagram_page_id: 'ig-1', facebook_page_id: 'page-1' }] };
    }
    if (/FROM media_uploads/.test(sql)) {
        return { rows: (params[0] as string[]).filter((id) => MIMES[id]).map((id) => ({ id, mime_type: MIMES[id] })) };
    }
    if (/FROM app_settings/.test(sql)) {
        const value = settings[params[0]];
        return { rows: value === undefined ? [] : [{ value, is_secret: false }] };
    }
    if (/FROM platform_connections/.test(sql)) return { rows: connection ? [connection] : [] };
    if (/SELECT platform, post_type/.test(sql)) return { rows: currentRow ? [currentRow] : [] };
    if (/INSERT INTO scheduled_posts/.test(sql)) {
        return { rows: [{ id: `row-${params[1]}`, platform: params[1], media_url: params[4], media_urls: params[5] }] };
    }
    if (/UPDATE scheduled_posts/.test(sql)) return { rows: [{ id: POST_ID }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
}

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    settings = {};
    connection = null;
    currentRow = null;
    const run = async (sql: string, params: any[] = []) => {
        statements.push({ sql, params });
        const r = respond(sql, params);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalPool.query;
    (pool as unknown as { connect: unknown }).connect = originalPool.connect;
});

/** The final handler for one route on the API router. */
function handlerFor(method: string, path: string) {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        headers: {} as Record<string, string>,
        sent: undefined as unknown,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        setHeader(name: string, value: string) { this.headers[name] = value; },
        send(payload: unknown) { this.sent = payload; return this; },
    };
}

async function call(method: string, path: string, req: Record<string, unknown>) {
    const res = fakeRes();
    await handlerFor(method, path)(
        { params: {}, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, ...req }, res, () => {}
    );
    return res;
}

const create = (body: Record<string, unknown>) =>
    call('post', '/posts/scheduled', { body: { scheduled_time: WHEN, ...body } });
const edit = (body: Record<string, unknown>) =>
    call('put', '/posts/scheduled/:id', { params: { id: POST_ID }, body });
const inserts = () => statements.filter((s) => /INSERT INTO scheduled_posts/.test(s.sql));
const updates = () => statements.filter((s) => /UPDATE scheduled_posts/.test(s.sql));

/** A connection that can do both modes, and the operator switch for Direct Post on. */
function tiktokConnected(directPost: boolean) {
    connection = {
        id: 'conn-1', creator_id: TENANT, status: 'active',
        scopes: ['user.info.basic', 'video.upload', 'video.publish'],
    };
    if (directPost) settings['tiktok.direct_post_enabled'] = 'true';
}

describe('POST /posts/scheduled — carousels', () => {
    it('refuses a count outside 2–10 with the sentence the dashboard shows, before writing', async () => {
        const res = await create({ platform: 'instagram', post_type: 'carousel', media_urls: [up(JPEG)] });

        assert.equal(res.statusCode, 400);
        assert.equal(res.body.error, 'A carousel takes 2 to 10 images — this one has 1.');
        assert.equal(inserts().length, 0);
    });

    it('refuses a PNG slide for Instagram, and takes it for Facebook alone', async () => {
        const both = await create({ platform: 'both', post_type: 'carousel', media_urls: [up(JPEG), up(PNG)] });
        assert.equal(both.statusCode, 400);
        assert.match(both.body.error, /Instagram needs JPEG images — image 2 is PNG/);

        const facebook = await create({ platform: 'facebook', post_type: 'carousel', media_urls: [up(JPEG), up(PNG)] });
        assert.equal(facebook.statusCode, 201);
    });

    it('stores media_urls in slide order and mirrors the first into media_url', async () => {
        const slides = [up(JPEG2), up(JPEG), 'https://cdn.example/three.jpg'];
        const res = await create({ platform: 'both', post_type: 'carousel', media_urls: slides, media_url: up(JPEG) });

        assert.equal(res.statusCode, 201);
        assert.equal(inserts().length, 1);
        const params = inserts()[0]!.params;
        assert.match(inserts()[0]!.sql, /media_url, media_urls/);
        assert.equal(params[4], slides[0], 'media_url is always the first slide');
        assert.deepEqual(params[5], slides);
    });

    it('gives the TikTok sibling its own photos, and photo options without duet or stitch', async () => {
        tiktokConnected(true);
        const own = [up(WEBP), up(JPEG2)];
        const res = await create({
            platform: 'both', post_type: 'carousel', media_urls: [up(JPEG), up(JPEG2)], also_tiktok: true,
            tiktok_media_urls: own,
            tiktok_options: { consent: true, privacy_level: 'SELF_ONLY', allow_duet: true, allow_stitch: true, title: ' عنوان ' },
        });

        assert.equal(res.statusCode, 201, JSON.stringify(res.body));
        const [meta, tiktok] = inserts();
        assert.equal(meta!.params[1], 'both');
        assert.deepEqual(meta!.params[5], [up(JPEG), up(JPEG2)]);
        assert.equal(tiktok!.params[1], 'tiktok');
        assert.deepEqual(tiktok!.params[5], own);
        assert.equal(tiktok!.params[4], own[0]);
        const options = JSON.parse(tiktok!.params[9]);
        assert.equal(options.mode, 'direct');
        assert.equal(options.title, 'عنوان');
        assert.equal(options.auto_add_music, true);
        assert.equal('allow_duet' in options, false);
        assert.equal('allow_stitch' in options, false);
    });

    it('defaults the sibling to the same slides, checked by TikTok’s rules rather than Meta’s', async () => {
        tiktokConnected(false);
        const ok = await create({
            platform: 'instagram', post_type: 'carousel', media_urls: [up(JPEG), up(JPEG2)], also_tiktok: true,
        });
        assert.equal(ok.statusCode, 201);
        assert.deepEqual(inserts()[1]!.params[5], [up(JPEG), up(JPEG2)]);

        // Facebook takes a PNG; TikTok does not, so the sibling refuses what the Meta row allows.
        const png = await create({
            platform: 'facebook', post_type: 'carousel', media_urls: [up(JPEG), up(PNG)], also_tiktok: true,
        });
        assert.equal(png.statusCode, 400);
        assert.equal(png.body.error, 'TikTok photos must be JPEG or WebP — image 2 is PNG.');
    });

    it('stores a photo title in inbox mode, and refuses one over 90', async () => {
        tiktokConnected(false);
        const res = await create({
            platform: 'tiktok', post_type: 'image', media_url: up(JPEG), tiktok_options: { mode: 'inbox', title: 'عنوان' },
        });
        assert.equal(res.statusCode, 201);
        assert.deepEqual(JSON.parse(inserts()[0]!.params[9]), { mode: 'inbox', title: 'عنوان' });
        assert.equal(inserts()[0]!.params[5], null, 'a single photo keeps no list');

        const long = await create({
            platform: 'tiktok', post_type: 'image', media_url: up(JPEG), tiktok_options: { title: 'x'.repeat(91) },
        });
        assert.equal(long.statusCode, 400);
        assert.match(long.body.error, /at most 90/);
    });

    it('still schedules a video exactly as before', async () => {
        const res = await create({ platform: 'both', post_type: 'video', media_url: up(JPEG), media_urls: [up(PNG)] });
        assert.equal(res.statusCode, 201);
        assert.equal(inserts()[0]!.params[4], up(JPEG));
        assert.equal(inserts()[0]!.params[5], null);
    });
});

describe('PUT /posts/scheduled/:id — carousels', () => {
    const carousel = (platform: string, slides: string[]) =>
        ({ platform, post_type: 'carousel', status: 'PENDING', media_url: slides[0], media_urls: slides });

    it('checks a new list against the row’s platform, and re-mirrors media_url', async () => {
        currentRow = carousel('both', [up(JPEG), up(JPEG2)]);
        const res = await edit({ media_urls: [up(JPEG2), up(JPEG)] });

        assert.equal(res.statusCode, 200);
        const params = updates()[0]!.params;
        assert.equal(params[3], up(JPEG2));
        assert.equal(params[9], true);
        assert.deepEqual(params[10], [up(JPEG2), up(JPEG)]);

        const png = await edit({ media_urls: [up(JPEG), up(PNG)] });
        assert.equal(png.statusCode, 400);
        assert.match(png.body.error, /Instagram needs JPEG/);
    });

    it('re-checks the stored slides when the platform moves to Instagram', async () => {
        // The two-step edit: a PNG carousel is fine on Facebook, and must not become one on
        // `both` just because the PUT did not resend the slides.
        currentRow = carousel('facebook', [up(JPEG), up(PNG)]);
        const res = await edit({ platform: 'both' });

        assert.equal(res.statusCode, 400);
        assert.match(res.body.error, /image 2 is PNG/);
        assert.equal(updates().length, 0);
    });

    it('leaves the media alone on a caption-only edit', async () => {
        currentRow = carousel('both', [up(JPEG), up(JPEG2)]);
        const res = await edit({ caption: 'جديد' });

        assert.equal(res.statusCode, 200);
        assert.equal(updates()[0]!.params[9], false, 'media_urls is not rewritten');
        assert.ok(!statements.some((s) => /FROM media_uploads/.test(s.sql)), 'and nothing is looked up');
    });

    it('drops the list when a carousel stops being one', async () => {
        currentRow = carousel('facebook', [up(JPEG), up(JPEG2)]);
        const res = await edit({ post_type: 'image' });

        assert.equal(res.statusCode, 200);
        assert.equal(updates()[0]!.params[9], true);
        assert.equal(updates()[0]!.params[10], null);
    });
});

describe('attemptPublish — carousel rows', () => {
    const BASE = `https://graph.facebook.com/${API_VERSION}`;
    const creator = { id: null, page_access_token: 'tok', instagram_page_id: 'ig-1', facebook_page_id: 'page-1' };
    const slides = [up(JPEG), up(JPEG2)];
    let meta: { method: string; url: string; body?: any }[] = [];
    let failInstagram = false;
    const originalMeta = { post: metaHttp.post, get: metaHttp.get };

    beforeEach(() => {
        meta = [];
        failInstagram = false;
        let n = 0;
        (metaHttp as any).post = async (url: string, body: any) => {
            meta.push({ method: 'post', url, body });
            if (url === `${BASE}/page-1/photos`) return { data: { id: `photo-${++n}` } };
            if (url === `${BASE}/page-1/feed`) return { data: { id: 'page-1_post-1' } };
            if (url === `${BASE}/ig-1/media`) {
                if (failInstagram) {
                    throw Object.assign(new Error('bad'), { response: { status: 400, data: { error: { code: 36003, message: 'bad media' } } } });
                }
                return { data: { id: body.is_carousel_item ? `child-${++n}` : 'parent-1' } };
            }
            if (url === `${BASE}/ig-1/media_publish`) return { data: { id: 'ig-carousel-1' } };
            throw new Error(`no Meta POST arranged for ${url}`);
        };
        (metaHttp as any).get = async (url: string) => {
            meta.push({ method: 'get', url });
            if (url === `${BASE}/parent-1`) return { data: { status_code: 'FINISHED' } };
            throw new Error(`no Meta GET arranged for ${url}`);
        };
    });
    afterEach(() => {
        (metaHttp as any).post = originalMeta.post;
        (metaHttp as any).get = originalMeta.get;
    });

    const row = (overrides: Record<string, unknown> = {}) => ({
        id: POST_ID, platform: 'both', post_type: 'carousel', caption: 'وصف', media_url: slides[0]!,
        media_urls: slides, cover_url: null, published_post_id: null, ...overrides,
    });

    it('publishes Facebook’s multi-photo post first, then the Instagram CAROUSEL', async () => {
        const ids = await attemptPublish(row(), creator);

        assert.deepEqual(ids, { fbId: 'page-1_post-1', igId: 'ig-carousel-1' });
        assert.deepEqual(meta.map((c) => c.url.replace(BASE, '')), [
            '/page-1/photos', '/page-1/photos', '/page-1/feed',
            '/ig-1/media', '/ig-1/media', '/ig-1/media', '/parent-1', '/ig-1/media_publish',
        ]);
        const done = updates().find((s) => /SET status = 'PUBLISHED'/.test(s.sql));
        assert.equal(done?.params[0], 'FB:page-1_post-1 | IG:ig-carousel-1');
    });

    it('keeps the Facebook id when Instagram fails, and skips Facebook on the retry', async () => {
        failInstagram = true;
        const err = await attemptPublish(row(), creator).then(() => null, (e) => e);

        assert.ok(err);
        const failed = updates().find((s) => /SET status = 'FAILED'/.test(s.sql));
        assert.match(String(failed?.params[0]), /^Partially published \(FB:page-1_post-1\)/);
        assert.equal(failed?.params[1], 'FB:page-1_post-1');

        meta = [];
        failInstagram = false;
        await attemptPublish(row({ published_post_id: 'FB:page-1_post-1' }), creator);
        assert.ok(!meta.some((c) => c.url.includes('/page-1/')), 'Facebook is already live — never posted twice');
    });

    it('fails closed on a carousel row that has lost its list', async () => {
        const err = await attemptPublish(row({ media_urls: null }), creator).then(() => null, (e) => e);

        assert.match(String(err?.message), /This carousel has no images/);
        assert.equal(meta.length, 0, 'not published as its first slide alone');
        assert.ok(!updates().some((s) => /SET status = 'PUBLISHED'/.test(s.sql)));
    });
});

describe('GET /uploads/:id — with a file extension', () => {
    let fetched: string[] = [];
    let previousStore: MediaStore | null = null;

    beforeEach(() => {
        fetched = [];
        previousStore = setMediaStore({
            async put() { throw new Error('not in these tests'); },
            async get() { throw new Error('the route streams through open(), never get()'); },
            async open(id) {
                fetched.push(id);
                return MIMES[id] ? { kind: 'bytes' as const, id, mimeType: MIMES[id]!, data: Buffer.from('bytes') } : null;
            },
            async mimeTypes() { return new Map(); },
            publicUrl(id, origin) { return `${origin}/api/uploads/${id}`; },
        });
    });
    afterEach(() => { setMediaStore(previousStore); });

    const serve = (id: string) => call('get', '/uploads/:id', { params: { id } });

    it('serves `<uuid>.jpg` as the stored upload — the URL TikTok is given', async () => {
        for (const ext of ['', '.jpg', '.jpeg', '.webp', '.png', '.mp4']) {
            const res = await serve(`${JPEG}${ext}`);
            assert.equal(res.statusCode, 200, ext);
            assert.equal(res.headers['Content-Type'], 'image/jpeg', 'the stored type, whatever the extension says');
            assert.deepEqual(res.sent, Buffer.from('bytes'));
        }
        assert.deepEqual([...new Set(fetched)], [JPEG]);
    });

    it('still 404s an unknown extension or a malformed id, before touching the store', async () => {
        for (const id of [`${JPEG}.html`, `${JPEG}.jpg.exe`, 'not-a-uuid.jpg']) {
            const res = await serve(id);
            assert.equal(res.statusCode, 404, id);
        }
        assert.deepEqual(fetched, []);
    });
});
