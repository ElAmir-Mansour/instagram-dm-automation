/**
 * A tenant with no Meta connection (v34).
 *
 * `creators.instagram_page_id` and `creators.page_access_token` are nullable from v34, so a tenant created by name has
 * neither until it connects. Every reader of those columns has to treat NULL as "not connected": skip the tenant, or say so,
 * and never send `null` (or the empty string `decryptSecret(null)` makes of it) to Meta as a bearer token, and never record
 * a red "invalid" against a connection that was never made.
 *
 * Each reader below runs against a stubbed pool whose creator row has NULL ids and a NULL token, with Meta (`metaHttp` and
 * `axios`) stubbed to throw on any call: there are live credentials in `.env`, and nothing here may reach Meta.
 * The readers that already tolerated an empty token (the Growth ones) are in `src/services/growth/*.test.ts`.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from '../services/http.js';
import { recheckTenantToken } from '../services/tokenHealth.js';
import { getCreatorByPageId, NOT_CONNECTED_MESSAGE } from '../services/tenant.js';
import apiRouter, { attemptPublish, publishDuePosts, PublishAttemptError } from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const POST_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const WHEN = '2026-10-01T09:00:00Z';

/** A tenant created by name: nothing of Meta's. */
const NO_META = { id: TENANT, instagram_page_id: null, facebook_page_id: null, page_access_token: null, is_active: true };

interface Statement { sql: string; params: any[] }
let statements: Statement[] = [];
let creatorRow: Record<string, unknown> | null = NO_META;
let dueRows: Record<string, unknown>[] = [];
let conversation: Record<string, unknown> | null = null;
let metaCalls: string[] = [];
const original = { query: pool.query, connect: pool.connect, get: metaHttp.get, post: metaHttp.post, axiosGet: axios.get };

function respond(sql: string): { rows: any[]; rowCount?: number } {
    if (/FROM creators WHERE id/.test(sql)) return { rows: creatorRow ? [{ ...creatorRow }] : [] };
    if (/FROM scheduled_posts s JOIN creators c/.test(sql)) return { rows: dueRows.map((r) => ({ ...r })) };
    if (/FROM conversations c JOIN creators cr/.test(sql)) return { rows: conversation ? [{ ...conversation }] : [] };
    if (/UPDATE scheduled_posts SET status = 'PUBLISHING'/.test(sql)) return { rows: [{ id: POST_ID }], rowCount: 1 };
    if (/UPDATE scheduled_posts/.test(sql)) return { rows: [], rowCount: 1 };
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
    creatorRow = { ...NO_META };
    dueRows = [];
    conversation = null;
    metaCalls = [];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const r = respond(flat);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    const refuse = (kind: string) => async (url: string) => { metaCalls.push(`${kind} ${url}`); throw new Error(`Meta must not be called for a tenant with no connection: ${url}`); };
    (metaHttp as any).get = refuse('get');
    (metaHttp as any).post = refuse('post');
    (axios as any).get = refuse('axios.get');
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
    (metaHttp as any).get = original.get;
    (metaHttp as any).post = original.post;
    (axios as any).get = original.axiosGet;
});

/** The final handler for one route on the API router. */
function handlerFor(method: string, route: string) {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === route && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${route} must be mounted`);
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        setHeader() {},
        send() { return this; },
    };
}

async function call(method: string, route: string, req: Record<string, unknown>) {
    const res = fakeRes();
    await handlerFor(method, route)({ params: {}, body: {}, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, ...req }, res, () => {});
    return res;
}

const writesTo = (table: string) => statements.filter((s) => new RegExp(`^(UPDATE|INSERT INTO) ${table}\\b`).test(s.sql));

// ─── The webhook ────────────────────────────────────────────────────────────────────────

describe('getCreatorByPageId: the webhook never resolves a tenant with no token', () => {
    it('asks for tokens that are there, so a tenant with a page id and no token (which the database forbids, and a database without v34 cannot say) is not routable', async () => {
        await getCreatorByPageId('17841400000000000');
        const query = statements.find((s) => /FROM creators/.test(s.sql));
        assert.ok(query, 'it queried');
        assert.match(query!.sql, /WHERE is_active = true AND page_access_token IS NOT NULL AND \(instagram_page_id = ANY\(\$1::text\[\]\) OR facebook_page_id = ANY\(\$1::text\[\]\)\)/);
    });

    it('answers null when no connected tenant matches, and asks nothing for no ids', async () => {
        assert.equal(await getCreatorByPageId('17841400000000000'), null);
        statements = [];
        assert.equal(await getCreatorByPageId(undefined), null);
        assert.deepEqual(statements, []);
    });
});

// ─── Token health ───────────────────────────────────────────────────────────────────────

describe('recheckTenantToken: a NULL token is "not connected", not a token that went bad', () => {
    it('answers no_token with the sentence, writes nothing and asks Meta nothing', async () => {
        const result = await recheckTenantToken(TENANT);
        assert.ok(result);
        assert.equal(result!.status, 'no_token');
        assert.equal(result!.error, NOT_CONNECTED_MESSAGE);
        assert.equal(result!.tokenLastCheckedAt, null);
        assert.deepEqual(writesTo('creators'), [], 'the status stays what it was (unknown): no red "invalid" for a tenant that never had a token');
        assert.deepEqual(metaCalls, []);
    });

    it('still records an EMPTY token as invalid, as it always did: that one was stored and lost', async () => {
        creatorRow = { ...NO_META, page_access_token: '' };
        const result = await recheckTenantToken(TENANT);
        assert.equal(result!.status, 'no_token');
        assert.equal(writesTo('creators').length, 1);
        assert.equal(writesTo('creators')[0]!.params[1], 'invalid');
    });
});

// ─── The publish path ───────────────────────────────────────────────────────────────────

describe('attemptPublish fails closed for a tenant with no token', () => {
    const creator = { id: TENANT, page_access_token: null, instagram_page_id: null, facebook_page_id: null };
    const row = (platform: string) => ({
        id: POST_ID, platform, post_type: 'image', caption: 'x', media_url: 'https://example.com/a.jpg', cover_url: null, published_post_id: null,
    });

    for (const platform of ['instagram', 'facebook', 'both']) {
        it(`${platform}: the row is FAILED with the "not connected" sentence, Meta is not called, and the token is not marked dead`, async () => {
            const err = await attemptPublish(row(platform), creator).then(() => null, (e) => e);
            assert.ok(err instanceof PublishAttemptError);
            assert.equal(err.message, NOT_CONNECTED_MESSAGE);
            assert.equal(err.code, 'META_NOT_CONNECTED');
            const failed = writesTo('scheduled_posts').find((s) => /SET status = 'FAILED'/.test(s.sql));
            assert.equal(failed?.params[0], NOT_CONNECTED_MESSAGE);
            assert.equal(failed?.params[1], null, 'nothing went live');
            assert.deepEqual(metaCalls, []);
            assert.deepEqual(writesTo('creators'), [], 'a connection that was never made is not a dead token');
        });
    }

    it('a token that is there goes on to Meta as before (the guard is on null, not on the tenant)', async () => {
        await attemptPublish(row('facebook'), { ...creator, page_access_token: 'plain-token', facebook_page_id: 'page-1' }).catch(() => undefined);
        assert.ok(metaCalls.length > 0, 'it reached Meta');
    });
});

describe('the publish sweep: a due Meta post of a tenant with no connection is failed, once, and nothing reaches Meta', () => {
    it('claims it, fails it with the sentence, and goes on', async () => {
        dueRows = [{
            id: POST_ID, creator_id: TENANT, platform: 'instagram', post_type: 'image', caption: 'x', media_url: 'https://example.com/a.jpg',
            cover_url: null, published_post_id: null, status: 'PENDING', page_access_token: null, instagram_page_id: null, facebook_page_id: null, is_active: true,
        }];
        const out = await publishDuePosts();
        assert.deepEqual([out.due, out.claimed, out.published], [1, 1, []]);
        const failed = writesTo('scheduled_posts').find((s) => /SET status = 'FAILED'/.test(s.sql));
        assert.equal(failed?.params[0], NOT_CONNECTED_MESSAGE);
        assert.deepEqual(metaCalls, []);
    });
});

describe('POST /posts/scheduled: a Meta post for a tenant with no connection is a 409 before anything is written', () => {
    for (const platform of ['instagram', 'facebook', 'both']) {
        it(`${platform}`, async () => {
            const res = await call('post', '/posts/scheduled', {
                body: { platform, post_type: 'image', media_url: 'https://example.com/a.jpg', scheduled_time: WHEN, caption: 'x' },
            });
            assert.equal(res.statusCode, 409);
            assert.equal(res.body.code, 'META_NOT_CONNECTED');
            assert.equal(res.body.error, NOT_CONNECTED_MESSAGE);
            assert.deepEqual(writesTo('scheduled_posts'), []);
        });
    }

    it('a connected tenant is not refused by it', async () => {
        creatorRow = { ...NO_META, instagram_page_id: 'ig-1', page_access_token: 'tok' };
        const res = await call('post', '/posts/scheduled', {
            body: { platform: 'instagram', post_type: 'image', media_url: 'https://example.com/a.jpg', scheduled_time: WHEN, caption: 'x' },
        });
        assert.notEqual(res.body?.code, 'META_NOT_CONNECTED');
    });
});

// ─── The Settings token routes and the inbox ────────────────────────────────────────────

describe('GET /settings/token/status for a tenant with no token', () => {
    it('says not_connected, asks Meta nothing, and records no "invalid"', async () => {
        const res = await call('get', '/settings/token/status', {});
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.status, 'not_connected');
        assert.equal(res.body.message, NOT_CONNECTED_MESSAGE);
        assert.equal(res.body.instagramPageId, null);
        assert.deepEqual(metaCalls, []);
        assert.deepEqual(writesTo('creators'), []);
    });
});

describe('POST /settings/token/extend for a tenant with no token', () => {
    const previous = { id: process.env.META_APP_ID, secret: process.env.META_APP_SECRET };
    before(() => { process.env.META_APP_ID = 'app-id'; process.env.META_APP_SECRET = 'app-secret'; });
    after(() => {
        for (const [key, value] of [['META_APP_ID', previous.id], ['META_APP_SECRET', previous.secret]] as const) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('is a 409 and exchanges nothing: there is no token to extend', async () => {
        const res = await call('post', '/settings/token/extend', {});
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'META_NOT_CONNECTED');
        assert.deepEqual(metaCalls, []);
        assert.deepEqual(writesTo('creators'), []);
    });
});

describe('POST /conversations/:id/messages for a thread whose tenant has no token', () => {
    it('is a 409 and sends nothing', async () => {
        conversation = { id: CONVERSATION, creator_id: TENANT, instagram_user_id: 'user-1', platform: 'instagram', page_access_token: null, facebook_page_id: null };
        const res = await call('post', '/conversations/:id/messages', { params: { id: CONVERSATION }, body: { text: 'hello' } });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'META_NOT_CONNECTED');
        assert.deepEqual(metaCalls, []);
        assert.deepEqual(writesTo('messages'), [], 'no outbound message was recorded for something that was not sent');
    });
});

// ─── TikTok and YouTube ─────────────────────────────────────────────────────────────────

describe('TikTok and YouTube never read the Meta columns, so a tenant with none loses nothing there', () => {
    const SERVICES = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'services');
    const files = [...readdirSync(SERVICES).filter((f) => /^(tiktok|youtube)[A-Za-z]*\.ts$/.test(f) && !f.endsWith('.test.ts')), '../routes/tiktok.ts', '../routes/youtube.ts'];

    it('finds the TikTok and YouTube sources, so an empty answer means "none read them" and not "found nothing"', () => {
        assert.ok(files.length >= 8, `found ${files.length}: ${files.join(', ')}`);
    });

    for (const file of files) {
        it(`${path.basename(file)} does not read instagram_page_id, facebook_page_id or page_access_token`, () => {
            const source = readFileSync(path.join(SERVICES, file), 'utf8');
            // Prose may name them (tiktokConnections.ts explains why tenant.ts is the only reader); code may not.
            const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            assert.doesNotMatch(code, /instagram_page_id|facebook_page_id|page_access_token/);
        });
    }
});
