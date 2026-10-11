/**
 * Mirror a Facebook video to Instagram: the rules (pure), the endpoint against a stubbed pool, and
 * the Growth posts list marking each Facebook video. Nothing here publishes: the handler never
 * touches Meta, and the stubbed `metaHttp` throws if it ever did.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { chooseMirrorTime, DEFAULT_MIRROR_DELAY_MS, mirrorBlocker } from '../services/growth/mirror.js';
import { metaHttp } from '../services/http.js';
import { setMediaStore, type MediaStore } from '../services/storage.js';
import { growthRouter } from './growth.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SOURCE = '22222222-2222-4222-8222-222222222222';
const UPLOAD = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
const MEDIA = `https://msg-response-auto.vercel.app/api/uploads/${UPLOAD}.mp4`;

const source = (over: Record<string, unknown> = {}) => ({
    id: SOURCE, platform: 'facebook', post_type: 'video', status: 'PUBLISHED', media_url: MEDIA,
    cover_url: 'https://msg-response-auto.vercel.app/api/uploads/55555555-5555-4555-8555-555555555555.jpg',
    published_post_id: 'FB:123', group_id: null, caption: 'اكتب «برومبت» وأرسله لك', ...over,
});

describe('mirrorBlocker', () => {
    const rules: [string, Record<string, unknown>, { platform: string }[], boolean, string | null][] = [
        ['an eligible Facebook video', {}, [], true, null],
        ['a TikTok sibling does not count as Instagram', {}, [{ platform: 'tiktok' }, { platform: 'youtube' }], true, null],
        ['not a video', { post_type: 'carousel' }, [], true, 'not_video'],
        ['a both row already goes to Instagram', { platform: 'both', published_post_id: 'FB:1 | IG:2' }, [], true, 'already_instagram'],
        ['an instagram row', { platform: 'instagram' }, [], true, 'already_instagram'],
        ['not published yet', { status: 'PENDING', published_post_id: null }, [], true, 'not_published'],
        ['failed', { status: 'FAILED' }, [], true, 'not_published'],
        ['published but no Facebook id', { published_post_id: null }, [], true, 'not_published'],
        ['an Instagram sibling, whatever its state', {}, [{ platform: 'instagram' }], true, 'has_instagram'],
        ['a both sibling', {}, [{ platform: 'both' }], true, 'has_instagram'],
        ['media is an outside URL', { media_url: 'https://cdn.example.com/v.mp4' }, [], false, 'no_media'],
        ['media row is gone', {}, [], false, 'no_media'],
        ['no media at all', { media_url: null }, [], false, 'no_media'],
        ['no cover: Instagram would use frame 0', { cover_url: null }, [], true, 'no_cover'],
    ];
    for (const [name, over, sibs, exists, expected] of rules) {
        it(name, () => assert.equal(mirrorBlocker(source(over) as never, sibs as never, exists), expected));
    }
});

describe('chooseMirrorTime', () => {
    const now = new Date('2026-10-11T10:00:00Z');
    it('defaults to an hour from now', () => {
        assert.equal(chooseMirrorTime(undefined, now).getTime(), now.getTime() + DEFAULT_MIRROR_DELAY_MS);
        assert.equal(chooseMirrorTime('', now).getTime(), now.getTime() + DEFAULT_MIRROR_DELAY_MS);
    });
    it('takes the operator’s time, refuses garbage and the past', () => {
        assert.equal(chooseMirrorTime('2026-10-12T18:00:00Z', now).toISOString(), '2026-10-12T18:00:00.000Z');
        assert.throws(() => chooseMirrorTime('soon', now), /not a valid date/);
        assert.throws(() => chooseMirrorTime('2026-10-11T08:00:00Z', now), /in the past/);
    });
});

// ─── The endpoint ───────────────────────────────────────────────────────────────────────

type Rows = { rows: any[] };
let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
let existing = new Set<string>();
const original = { query: pool.query, connect: pool.connect, post: metaHttp.post };
let previousStore: MediaStore | null = null;

beforeEach(() => {
    statements = [];
    routes = [];
    existing = new Set([UPLOAD]);
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rows.length };
    };
    (pool as any).query = run;
    (pool as any).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).post = async () => { throw new Error('the mirror must never publish'); };
    previousStore = setMediaStore({
        async put() { return { id: 'x' }; },
        async get() { return null; },
        async open() { return null; },
        async mimeTypes(ids: readonly string[]) { return new Map(ids.filter((i) => existing.has(i)).map((i) => [i, 'video/mp4'])); },
        publicUrl: (id: string, origin: string) => `${origin}/api/uploads/${id}`,
    } as MediaStore);
});
afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
    (metaHttp as any).post = original.post;
    setMediaStore(previousStore);
});

function handler(path: string): Function {
    const layer = (growthRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post);
    assert.ok(layer, `POST ${path} must be mounted`);
    return layer.route.stack.at(-1).handle;
}

async function mirror(id: string, body: Record<string, unknown> = {}) {
    const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; }, setHeader() {} };
    await handler('/posts/:id/mirror-to-instagram')({ params: { id }, query: {}, headers: {}, body, session: { userId: 'u', tenantId: TENANT }, tenantRole: 'operator' }, res);
    return res;
}
const arrange = (row: Record<string, unknown> | null, siblings: { platform: string }[] = []) => {
    routes.push(
        [/FROM scheduled_posts WHERE id = \$1 AND creator_id = \$2 FOR UPDATE/, () => ({ rows: row ? [row] : [] })],
        [/FROM scheduled_posts WHERE creator_id = \$1 AND group_id = \$2/, () => ({ rows: siblings })],
        [/^INSERT INTO scheduled_posts/, (p) => ({ rows: [{ id: 'new-row', platform: p[0] }] })],
    );
};
const inserts = () => statements.filter((s) => /^INSERT INTO scheduled_posts/.test(s.sql));

describe('POST /api/growth/posts/:id/mirror-to-instagram', () => {
    it('is mounted behind the operator role and tenant-scoped (creator_id in the lookup)', async () => {
        const guard = (growthRouter as any).stack[0];
        assert.equal(guard.handle.minimumRole, 'operator');
        arrange(source());
        await mirror(SOURCE);
        const lookup = statements.find((s) => /FOR UPDATE/.test(s.sql))!;
        assert.deepEqual(lookup.params, [SOURCE, TENANT]);
    });

    it('creates one PENDING Instagram video row with the same media, cover and caption; never publishes', async () => {
        const row = source();
        arrange(row);
        const res = await mirror(SOURCE, { scheduled_time: '2099-01-01T12:00:00Z' });
        assert.equal(res.statusCode, 201);
        assert.equal(inserts().length, 1);
        const [insert] = inserts();
        assert.match(insert!.sql, /VALUES \(\$1, 'instagram', 'video', \$2, \$3, NULL, \$4, 'PENDING', \$5, \$6, NULL, NULL\)/);
        const [creator, caption, media, when, cover, group] = insert!.params;
        assert.equal(creator, TENANT);
        assert.equal(caption, row.caption, 'the caption, with its comment-keyword ask, is carried unchanged');
        assert.equal(media, MEDIA);
        assert.equal(cover, row.cover_url);
        assert.equal((when as Date).toISOString(), '2099-01-01T12:00:00.000Z');
        assert.match(String(group), /^[0-9a-f-]{36}$/);
        // The source had no group: it gets the new one, so the two rows are tied.
        const tie = statements.find((s) => /^UPDATE scheduled_posts SET group_id/.test(s.sql));
        assert.deepEqual(tie!.params, [group, SOURCE]);
        assert.equal(statements.some((s) => /status = 'PUBLISHING'/.test(s.sql)), false, 'no claim, no publish');
        assert.ok(statements.some((s) => /pg_advisory_xact_lock/.test(s.sql)), 'under the tenant publishing lock');
        assert.equal(statements.at(-1)!.sql, 'COMMIT');
    });

    it('reuses the source’s group_id and defaults to an hour out', async () => {
        arrange(source({ group_id: GROUP }), [{ platform: 'tiktok' }]);
        const before = Date.now();
        const res = await mirror(SOURCE);
        assert.equal(res.statusCode, 201);
        const [insert] = inserts();
        assert.equal(insert!.params[5], GROUP);
        assert.equal(statements.some((s) => /^UPDATE scheduled_posts SET group_id/.test(s.sql)), false);
        const when = (insert!.params[3] as Date).getTime();
        assert.ok(when >= before + DEFAULT_MIRROR_DELAY_MS - 1000 && when <= Date.now() + DEFAULT_MIRROR_DELAY_MS + 1000);
    });

    const refused: [string, Record<string, unknown> | null, { platform: string }[], number, RegExp][] = [
        ['a duplicate: an Instagram sibling already exists', source({ group_id: GROUP }), [{ platform: 'instagram' }], 409, /already has an Instagram post/],
        ['a both row', source({ platform: 'both' }), [], 409, /already goes to Instagram/],
        ['media we do not hold', source({ media_url: 'https://cdn.example.com/v.mp4' }), [], 409, /no longer in the media library/],
        ['no cover', source({ cover_url: null }), [], 409, /no cover image/],
        ['not published', source({ status: 'PENDING', published_post_id: null }), [], 409, /not published on Facebook/],
        ['a photo', source({ post_type: 'image' }), [], 400, /Only a Facebook video/],
        ['someone else’s or missing row', null, [], 404, /No such post/],
    ];
    for (const [name, row, sibs, status, message] of refused) {
        it(`refuses ${name}, writing nothing`, async () => {
            arrange(row, sibs);
            const res = await mirror(SOURCE);
            assert.equal(res.statusCode, status);
            assert.match(res.body.error, message);
            assert.equal(inserts().length, 0);
            assert.equal(statements.at(-1)!.sql, 'ROLLBACK');
        });
    }

    it('refuses a media upload that was deleted', async () => {
        existing.clear();
        arrange(source());
        const res = await mirror(SOURCE);
        assert.equal(res.statusCode, 409);
        assert.equal(inserts().length, 0);
    });

    it('refuses a past or invalid time and a malformed id before touching the database', async () => {
        arrange(source());
        assert.equal((await mirror(SOURCE, { scheduled_time: '2000-01-01T00:00:00Z' })).statusCode, 400);
        assert.equal((await mirror(SOURCE, { scheduled_time: 'nope' })).statusCode, 400);
        assert.equal((await mirror('not-a-uuid')).statusCode, 404);
        assert.equal(statements.length, 0);
    });
});
