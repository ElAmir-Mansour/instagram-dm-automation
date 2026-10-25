/**
 * Archive a scheduled post, and what the publish sweep does about an archived one (UX US1: audit PO-14, FR-003, tasks T034 and T036).
 *
 * `POST` and `DELETE /api/posts/scheduled/:id/archive` set and clear `scheduled_posts.archived_at` (v45): the owner's way to put away a post
 * that is neither a problem nor an upcoming post (a failed one parked for next year, a held TikTok draft he has stopped wanting), which
 * until now sat in "Needs attention" on Posts and on Today for good. `publishDuePosts` must then leave the row alone, while the reconcile
 * sweeps (TikTok, Instagram) still settle a row already in flight.
 *
 * This is the POSTS half of T034. The conversations half ("Mark handled", and a new inbound message clearing `handled_at`) is
 * `handled.test.ts`; the two live in their own files so they merge beside each other.
 *
 * Run through each route's WHOLE stack (role guard, then handler) with `pool.query` stubbed, like `handled.test.ts`: the guard and the
 * tenant filter are the point. A small fake of the table stands in for Postgres where a test is about WHICH rows a statement touches, so
 * that deleting the `archived_at` test from a statement changes what the fake does, and the test fails (a regex over the SQL text alone
 * would pass for a statement that no longer filters but still mentions the column).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { reconcileTikTokPosts } from '../services/tiktokPublish.js';
import { setLogSink } from '../utils/log.js';
import apiRouter, { publishDuePosts } from './api.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Json = any;

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const POST = '33333333-3333-4333-8333-333333333333';
const PATH = '/posts/scheduled/:id/archive';

function stackFor(method: string, path: string): Handle[] {
    const stack = (apiRouter as unknown as {
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
        set() { return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

interface Sent { sql: string; params: unknown[] }
type Answer = (sql: string, params: unknown[]) => { rows: Json[]; rowCount?: number } | Error | undefined;

let restoreSink: (() => void) | undefined;
let originalQuery: typeof pool.query;
let sent: Sent[];
let logged: Array<{ level: string; event: string; [k: string]: unknown }>;
let answer: Answer;

beforeEach(() => {
    const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => setLogSink(previous);
    originalQuery = pool.query;
    sent = [];
    logged = [];
    answer = () => undefined;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const out = answer(sql, params);
        if (out instanceof Error) throw out;
        if (out) return { rowCount: out.rows.length, ...out };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    restoreSink?.();
});

const OWNER = { userId: 'u-owner', role: 'user', tenantId: TENANT };

async function run(method: string, path: string, role: 'owner' | 'operator' | 'viewer', req: { params?: Record<string, string>; body?: unknown } = {}) {
    const res = fakeRes();
    const full = { query: {}, params: {}, body: {}, ...req, session: OWNER, tenantRole: role, headers: {}, originalUrl: `/api${path}` };
    for (const handle of stackFor(method, path)) {
        let passed = false;
        await handle(full, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

const writes = () => sent.filter((s) => /UPDATE scheduled_posts/.test(s.sql));

/** A scheduled_posts table of one or two rows, answering the archive statements the way Postgres would. */
interface Row { id: string; creator_id: string; status: string; error_log: string | null; archived_at: Date | null }
function fakeTable(rows: Row[]): void {
    answer = (sql, params) => {
        const archive = /^\s*UPDATE scheduled_posts SET archived_at = COALESCE\(archived_at, NOW\(\)\)/.test(sql);
        const unarchive = /^\s*UPDATE scheduled_posts SET archived_at = NULL/.test(sql);
        if (!archive && !unarchive) return undefined;
        // `WHERE id = $1 AND creator_id = $2`: both must hold, or the row is not touched. A statement that drops the tenant test
        // is run as it is written: the fake does not add the filter back.
        const scoped = /creator_id = \$2/.test(sql);
        const hit = rows.filter((r) => r.id === params[0] && (!scoped || r.creator_id === params[1]));
        for (const r of hit) r.archived_at = archive ? (r.archived_at ?? new Date('2026-10-19T12:00:00.000Z')) : null;
        return { rows: hit.map((r) => ({ ...r })) };
    };
}

const failedRow = (over: Partial<Row> = {}): Row => ({
    id: POST, creator_id: TENANT, status: 'FAILED', error_log: 'Replaced by the reel.', archived_at: null, ...over,
});

// ─── POST and DELETE /posts/scheduled/:id/archive ──────────────────────────────────────────────

describe('POST /posts/scheduled/:id/archive', () => {
    it('stamps the post for the SESSION\'s tenant and answers the row, archived', async () => {
        fakeTable([failedRow()]);
        const res = await run('post', PATH, 'operator', { params: { id: POST } });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(writes().length, 1);
        assert.match(writes()[0]!.sql, /^UPDATE scheduled_posts SET archived_at = COALESCE\(archived_at, NOW\(\)\) WHERE id = \$1 AND creator_id = \$2/);
        assert.deepEqual(writes()[0]!.params, [POST, TENANT], 'this post, this tenant, and nobody else');
        assert.equal(res.body.id, POST);
        assert.ok(res.body.archived_at instanceof Date || typeof res.body.archived_at === 'string', 'the row carries its stamp');
        assert.equal(res.body.status, 'FAILED', 'archiving a row does not change its status');
        assert.equal(res.body.error_log, 'Replaced by the reel.', 'nor its error: Unarchive puts the row back exactly as it was');
    });

    it('writes nothing but archived_at: status, error_log and the publish ids are never in the SET', async () => {
        fakeTable([failedRow()]);
        await run('post', PATH, 'operator', { params: { id: POST } });
        const set = /SET (.*) WHERE/.exec(writes()[0]!.sql)![1]!;
        assert.doesNotMatch(set, /status|error_log|published_post_id|external_publish_id|claimed_at|attempts/);
    });

    it('is idempotent: an archived post keeps its ORIGINAL stamp when archived again', async () => {
        const first = new Date('2026-10-01T08:00:00.000Z');
        fakeTable([failedRow({ archived_at: first })]);
        const res = await run('post', PATH, 'owner', { params: { id: POST } });
        assert.equal(res.statusCode, 200);
        assert.equal(new Date(res.body.archived_at).toISOString(), first.toISOString(), 'COALESCE keeps the first stamp');
    });

    it('works on any status (the server does not second-guess the button)', async () => {
        for (const status of ['PENDING', 'FAILED', 'PUBLISHED', 'IN_INBOX']) {
            fakeTable([failedRow({ status })]);
            const res = await run('post', PATH, 'owner', { params: { id: POST } });
            assert.equal(res.statusCode, 200, status);
            assert.equal(res.body.status, status, status);
        }
    });

    it('is the owner\'s and an operator\'s, and a viewer\'s is refused before any SQL', async () => {
        fakeTable([failedRow()]);
        for (const role of ['owner', 'operator'] as const) {
            sent.length = 0;
            assert.equal((await run('post', PATH, role, { params: { id: POST } })).statusCode, 200, role);
        }
        sent.length = 0;
        const refused = await run('post', PATH, 'viewer', { params: { id: POST } });
        assert.equal(refused.statusCode, 403);
        assert.equal(sent.length, 0, 'nothing was read or written');
        const refusedUndo = await run('delete', PATH, 'viewer', { params: { id: POST } });
        assert.equal(refusedUndo.statusCode, 403);
        assert.equal(sent.length, 0);
    });

    it('is a 404 that changes nothing for an id that is not a post, and for another tenant\'s post', async () => {
        const theirs = failedRow({ creator_id: OTHER_TENANT });
        fakeTable([theirs]);

        const notUuid = await run('post', PATH, 'owner', { params: { id: 'not-a-uuid' } });
        assert.equal(notUuid.statusCode, 404);
        assert.equal(sent.length, 0, 'a malformed id is refused before the database');

        const foreign = await run('post', PATH, 'owner', { params: { id: POST } });
        assert.equal(foreign.statusCode, 404, 'not 403: another tenant\'s id is not a hint that it exists');
        assert.deepEqual(writes()[0]!.params, [POST, TENANT], 'the session\'s tenant is in the filter, not one the client names');
        assert.equal(theirs.archived_at, null, 'and the other tenant\'s row was not touched');
    });

    it('logs the change, with the ids and the status and nothing the owner wrote', async () => {
        fakeTable([failedRow()]);
        await run('post', PATH, 'owner', { params: { id: POST } });
        const line = logged.find((e) => e.event === 'posts.archived');
        assert.ok(line, 'an archived post leaves a log line');
        assert.deepEqual({ post_id: line!.post_id, creator_id: line!.creator_id, status: line!.status }, { post_id: POST, creator_id: TENANT, status: 'FAILED' });
    });

    it('on a database without v45 says so, with the migration to run, instead of a bare 500', async () => {
        answer = () => Object.assign(new Error('column "archived_at" of relation "scheduled_posts" does not exist'), { code: '42703' });
        const res = await run('post', PATH, 'owner', { params: { id: POST } });
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.migrationPending, true);
        assert.match(res.body.error, /migration v45/);
    });

    it('any other failure is a 500', async () => {
        answer = () => Object.assign(new Error('connection terminated'), { code: '57P01' });
        const res = await run('post', PATH, 'owner', { params: { id: POST } });
        assert.equal(res.statusCode, 500);
        assert.match(res.body.error, /archive/i);
    });
});

describe('DELETE /posts/scheduled/:id/archive', () => {
    it('clears the stamp, scoped to the tenant, and answers the row as not archived', async () => {
        const row = failedRow({ archived_at: new Date('2026-10-19T12:00:00.000Z') });
        fakeTable([row]);
        const res = await run('delete', PATH, 'operator', { params: { id: POST } });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.match(writes()[0]!.sql, /^UPDATE scheduled_posts SET archived_at = NULL WHERE id = \$1 AND creator_id = \$2/);
        assert.deepEqual(writes()[0]!.params, [POST, TENANT]);
        assert.equal(res.body.archived_at, null);
        assert.equal(res.body.status, 'FAILED', 'the row is back exactly as it was');
        assert.equal(res.body.error_log, 'Replaced by the reel.');
        assert.ok(logged.some((e) => e.event === 'posts.unarchived'));
    });

    it('is harmless on a post that is not archived', async () => {
        fakeTable([failedRow()]);
        const res = await run('delete', PATH, 'owner', { params: { id: POST } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.archived_at, null);
    });

    it('is a 404 for a post that is not this tenant\'s, and leaves it archived', async () => {
        const theirs = failedRow({ creator_id: OTHER_TENANT, archived_at: new Date('2026-10-19T12:00:00.000Z') });
        fakeTable([theirs]);
        const res = await run('delete', PATH, 'owner', { params: { id: POST } });
        assert.equal(res.statusCode, 404);
        assert.notEqual(theirs.archived_at, null);
    });
});

describe('GET /posts/scheduled carries archived_at, so the page can tell the groups apart', () => {
    it('reads every column of the tenant\'s rows (SELECT *), and the archived stamp reaches the client', async () => {
        const rows = [
            { id: 'a', status: 'FAILED', archived_at: '2026-10-19T12:00:00.000Z' },
            { id: 'b', status: 'PENDING', archived_at: null },
        ];
        answer = (sql) => (/FROM scheduled_posts WHERE creator_id = \$1/.test(sql) ? { rows } : undefined);
        const res = await run('get', '/posts/scheduled', 'viewer');
        assert.equal(res.statusCode, 200);
        assert.match(sent[0]!.sql, /^SELECT \* FROM scheduled_posts WHERE creator_id = \$1/,
            'a column list here would drop archived_at, and every archived post would come back into Needs attention');
        assert.deepEqual(sent[0]!.params, [TENANT]);
        assert.deepEqual(res.body.map((r: Json) => [r.id, r.archived_at]), [['a', '2026-10-19T12:00:00.000Z'], ['b', null]]);
    });
});

// ─── The publish sweep ─────────────────────────────────────────────────────────────────────────

/**
 * `publishDuePosts` over a fake `scheduled_posts` that honours the statements' own `archived_at IS NULL` tests: the SELECT that finds
 * due rows and the UPDATE that claims one. A statement that stops testing it hands the archived row to the publisher in this fake, as
 * it would in Postgres.
 */
describe('publishDuePosts skips an archived post', () => {
    const originalGet = metaHttp.get;
    const originalPost = metaHttp.post;
    let metaCalls: string[];
    beforeEach(() => {
        metaCalls = [];
        (metaHttp as any).get = async (url: string) => { metaCalls.push(`GET ${url}`); throw new Error('no Graph call may be made'); };
        (metaHttp as any).post = async (url: string) => { metaCalls.push(`POST ${url}`); throw new Error('no Graph call may be made'); };
    });
    afterEach(() => {
        (metaHttp as any).get = originalGet;
        (metaHttp as any).post = originalPost;
    });

    const ARCHIVED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const LIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const due = (id: string, archivedAt: Date | null) => ({
        id, creator_id: TENANT, platform: 'instagram', post_type: 'image', caption: 'x', media_url: 'https://example.com/a.jpg', cover_url: null,
        published_post_id: null, status: 'PENDING', archived_at: archivedAt,
        // No token: a claimed row fails closed ("not connected") without a Graph call, so the sweep can be run for real.
        page_access_token: null, instagram_page_id: null, facebook_page_id: null, is_active: true,
    });

    /**
     * `archivedAfterSelect`: ids archived by the owner AFTER the sweep read them and BEFORE it claims them (the race the claim's own test
     * closes). The select answers them as due; the claim then finds them archived.
     */
    function fakeSweep(rows: ReturnType<typeof due>[], archivedAfterSelect: string[] = []): void {
        const state = new Map(rows.map((r) => [r.id, { ...r }]));
        answer = (sql, params) => {
            if (/FROM scheduled_posts s\b/.test(sql)) {
                const honoursArchive = /s\.archived_at IS NULL/.test(sql);
                const picked = [...state.values()]
                    .filter((r) => r.status === 'PENDING' && (!honoursArchive || r.archived_at === null))
                    .map((r) => ({ ...r }));
                // The owner presses Archive after the sweep has read its rows and before it claims them.
                for (const id of archivedAfterSelect) state.get(id)!.archived_at = new Date();
                return { rows: picked };
            }
            if (/^\s*UPDATE scheduled_posts\s+SET status = 'PUBLISHING'/.test(sql)) {
                const row = state.get(String(params[0]));
                const honoursArchive = /archived_at IS NULL/.test(sql);
                const claimable = !!row && row.status === 'PENDING' && (!honoursArchive || row.archived_at === null);
                if (claimable) row!.status = 'PUBLISHING';
                return { rows: claimable ? [{ id: row!.id }] : [], rowCount: claimable ? 1 : 0 };
            }
            if (/UPDATE scheduled_posts/.test(sql)) return { rows: [], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        };
    }

    const claims = () => sent.filter((s) => /SET status = 'PUBLISHING'/.test(s.sql));

    it('never selects, claims or publishes it, while an unarchived post due at the same time still goes through', async () => {
        fakeSweep([due(ARCHIVED, new Date('2026-10-19T09:00:00.000Z')), due(LIVE, null)]);
        const out = await publishDuePosts();

        assert.equal(out.due, 1, 'only the unarchived post is due');
        assert.equal(out.claimed, 1);
        assert.deepEqual(claims().map((c) => c.params[0]), [LIVE], 'the archived post was never claimed');
        assert.deepEqual(metaCalls, [], 'and nothing reached Meta');
        // The unarchived one WAS run: it fails closed (no connection) instead of being skipped.
        assert.ok(sent.some((s) => /SET status = 'FAILED'/.test(s.sql)), 'the live post went on to the publisher');
    });

    it('with only an archived post due, the sweep claims nothing and says "none due"', async () => {
        fakeSweep([due(ARCHIVED, new Date('2026-10-19T09:00:00.000Z'))]);
        const out = await publishDuePosts();
        assert.deepEqual([out.due, out.claimed, out.published], [0, 0, []]);
        assert.deepEqual(claims(), []);
        assert.ok(logged.some((e) => e.event === 'cron.publish_none_due'));
    });

    it('does not publish a post archived between the sweep\'s read and its claim (the claim tests it too)', async () => {
        fakeSweep([due(ARCHIVED, null)], [ARCHIVED]);
        const out = await publishDuePosts();

        assert.equal(out.due, 1, 'the SELECT saw it as due: it was not archived yet');
        assert.equal(claims().length, 1, 'the sweep tried to claim it');
        assert.equal(out.claimed, 0, 'but the claim found it archived and matched no row');
        assert.deepEqual(metaCalls, []);
        assert.ok(logged.some((e) => e.event === 'cron.publish_already_claimed'));
        assert.ok(!sent.some((s) => /SET status = 'FAILED'/.test(s.sql)), 'and it was not failed either: it is left as the owner put it');
    });

    it('both statements carry the archived test (so the fake above is testing what ships)', () => {
        const source = readFileSync('src/routes/api.ts', 'utf8');
        const sweep = source.slice(source.indexOf('export async function publishDuePosts'));
        const select = sweep.slice(sweep.indexOf('SELECT s.*'), sweep.indexOf('ORDER BY s.scheduled_time ASC'));
        assert.match(select, /s\.archived_at IS NULL/);
        const claim = sweep.slice(sweep.indexOf("SET status = 'PUBLISHING'"), sweep.indexOf('RETURNING id'));
        assert.match(claim, /archived_at IS NULL/);
    });
});

describe('the reconcile sweeps still run on an archived post already in flight', () => {
    it('reconcileTikTokPosts asks for rows with no archived_at filter and settles an archived one', async () => {
        // A TikTok row that is PROCESSING and archived: the owner put it away while TikTok was still ingesting it. TikTok's answer still has
        // to land, or the row would sit PROCESSING for ever. This one has no publish id, which the sweep settles without calling TikTok.
        const archivedRow = { id: POST, creator_id: TENANT, external_publish_id: null, claimed_at: new Date(), status: 'PROCESSING', archived_at: new Date() };
        answer = (sql) => {
            if (/FROM scheduled_posts\s+WHERE platform = 'tiktok'/.test(sql)) return { rows: [archivedRow] };
            if (/UPDATE scheduled_posts SET status = 'FAILED'/.test(sql)) return { rows: [], rowCount: 1 };
            return undefined;
        };
        const out = await reconcileTikTokPosts(10);

        const select = sent.find((s) => /FROM scheduled_posts WHERE platform = 'tiktok'/.test(s.sql));
        assert.ok(select, 'the reconcile query ran');
        assert.doesNotMatch(select!.sql, /archived_at/, 'an archived row is still reconciled');
        assert.equal(out.gaveUp, 1, 'the archived row was settled');
        assert.ok(sent.some((s) => /UPDATE scheduled_posts SET status = 'FAILED'/.test(s.sql) && s.params[0] === POST));
    });

    it('no reconcile or retry code outside the publish sweep and the attention counts mentions archived_at', () => {
        // The v45 rules: the publish sweep skips archived rows and the attention counts exclude them; nothing else changes behaviour.
        for (const file of ['src/services/tiktokPublish.ts', 'src/services/youtubePublish.ts', 'src/services/youtubeVisibility.ts', 'src/services/growth/sync.ts']) {
            assert.doesNotMatch(readFileSync(file, 'utf8'), /archived_at/, `${file} must keep reconciling archived rows`);
        }
    });
});
