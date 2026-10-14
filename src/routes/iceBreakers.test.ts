/**
 * `/api/dm/ice-breakers` (DM plan S13): the Instagram ice breakers and persistent menu the owner edits and publishes.
 *
 * Run through each route's WHOLE stack (guard, then handler) with `pool.query` stubbed and `metaHttp` replaced by a recorder that THROWS on any
 * call a test did not arrange. That matters here more than anywhere: `.env` holds the live Page token, a publish changes the profile every
 * visitor to the account sees, and no test may be the thing that does it. What is pinned:
 *
 *   - who: the tenant's owner on every route, reads included; an operator or a viewer is refused before anything is read or sent;
 *   - nothing reaches Meta unless a button was pressed: reading the draft and saving it make NO Graph call, and a publish that has nothing
 *     to publish, or no Instagram to publish to, makes none either;
 *   - the publish is what Meta documents, sent with the TENANT's own token, once, and followed by one read-back; the stored record says when,
 *     by whom and what; the audit ledger gets a row for the attempt, also when Meta refused it, with counts and never the questions;
 *   - a draft is per tenant: another tenant's session reads and writes its own row;
 *   - the token is in no answer, no audit row and no log line.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { fingerprint } from '../services/dmSales/iceBreakers.js';
import { API_VERSION } from '../services/instagram.js';
import { metaHttp } from '../services/http.js';
import { FITNESS_EN, SHOP_EG } from '../services/profile/fixtures.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import type { CreatorProfile } from '../services/profile/types.js';
import { INSUFFICIENT_ROLE_CODE, invalidateTenantCache, resolveTenant } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { iceBreakersRouter } from './iceBreakers.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Json = any;

const URL = `https://graph.facebook.com/${API_VERSION}/me/messenger_profile`;
const TOKEN = 'EAAGtenant-one-page-token-9f3a';
const TOKEN_TWO = 'EAAGtenant-two-page-token-77c1';
const ROW_ONE = 'dm.ice_breakers.tenant-1';
const ROW_TWO = 'dm.ice_breakers.tenant-2';

function stackFor(method: string, path: string): Handle[] {
    const stack = (iceBreakersRouter as unknown as {
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

async function run(method: 'get' | 'put' | 'post' | 'delete', path: string, over: { role?: string; tenantId?: string; userId?: string; body?: unknown } = {}) {
    const res = fakeRes();
    const role = over.role ?? 'owner';
    const req = {
        session: { userId: over.userId ?? 'u-owner', role: 'user', tenantId: over.tenantId ?? 'tenant-1' },
        body: over.body ?? {}, params: {}, tenantRole: role,
    };
    for (const handle of stackFor(method, path)) {
        let passed = false;
        await handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

// ─── The world ───────────────────────────────────────────────────────────────

interface Graph { method: 'post' | 'get' | 'delete'; url: string; body: unknown; config: Json }

let settings: Record<string, string>;
let tenants: Record<string, { instagram_page_id: string | null; facebook_page_id: string | null; page_access_token: string | null }>;
let profile: CreatorProfile | null;
let platformOwner: string;
let writes:Array<{ key: string; value: string | null }>;
let audits: Array<{ action: string; targetId: unknown; detail: Json; actorEmail: unknown }>;
let graph: Graph[];
let onPost: (body: any) => Promise<any>;
let onGet: (config: any) => Promise<any>;
let onDelete: (body: any) => Promise<any>;
let logged: string[];
let queries: string[];

let originalQuery: typeof pool.query;
const originals = { post: metaHttp.post, get: metaHttp.get, delete: metaHttp.delete };
let restoreSink: (() => void) | undefined;

const okAnswer = (data: unknown) => async () => ({ data });

beforeEach(() => {
    settings = {};
    tenants = {
        'tenant-1': { instagram_page_id: 'ig-1', facebook_page_id: 'fb-1', page_access_token: TOKEN },
        'tenant-2': { instagram_page_id: 'ig-2', facebook_page_id: null, page_access_token: TOKEN_TWO },
    };
    profile = FITNESS_EN;
    platformOwner = 'tenant-2';
    writes = [];
    audits = [];
    graph = [];
    logged = [];
    queries = [];
    onPost = okAnswer({ result: 'success' });
    onGet = okAnswer({ data: [] });
    onDelete = okAnswer({ result: 'success' });

    const previous = setLogSink((_level, line) => { logged.push(line); });
    restoreSink = () => setLogSink(previous);
    invalidateTenantCache();

    originalQuery = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        queries.push(sql);
        if (/FROM app_settings WHERE key = \$1/.test(sql)) {
            const key = String(params[0]);
            return key in settings ? { rows: [{ value: settings[key], is_secret: false }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO app_settings/.test(sql)) {
            settings[String(params[0])] = String(params[1]);
            writes.push({ key: String(params[0]), value: String(params[1]) });
            return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM app_settings WHERE key = \$1/.test(sql)) {
            delete settings[String(params[0])];
            writes.push({ key: String(params[0]), value: null });
            return { rows: [], rowCount: 1 };
        }
        if (/FROM creators WHERE id = \$1/.test(sql)) {
            const row = tenants[String(params[0])];
            return row ? { rows: [{ id: params[0], ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO audit_log/.test(sql)) {
            audits.push({ actorEmail: params[1], action: String(params[2]), targetId: params[4], detail: JSON.parse(String(params[5])) });
            return { rows: [{ id: `audit-${audits.length}` }], rowCount: 1 };
        }
        if (/SELECT email FROM users WHERE id = \$1/.test(sql)) return { rows: [{ email: 'owner@example.test' }], rowCount: 1 };
        // The platform owner: the first tenant ever made. Only it may be answered in the legacy wording when a profile cannot be read.
        if (/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/.test(sql)) return { rows: [{ id: platformOwner }], rowCount: 1 };
        if (/FROM creator_profiles/.test(sql) && profile) return { rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }], rowCount: 1 };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };

    (metaHttp as any).post = (url: string, body: any, config: any) => {
        graph.push({ method: 'post', url, body, config });
        return onPost(body);
    };
    (metaHttp as any).get = (url: string, config: any) => {
        graph.push({ method: 'get', url, body: undefined, config });
        return onGet(config);
    };
    (metaHttp as any).delete = (url: string, config: any) => {
        graph.push({ method: 'delete', url, body: config?.data, config });
        return onDelete(config?.data);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).post = originals.post;
    (metaHttp as any).get = originals.get;
    (metaHttp as any).delete = originals.delete;
    restoreSink?.();
});

const DRAFT = {
    iceBreakers: [{ question: 'وش السعر؟', payload: 'TAP_PRICE' }, { question: 'أبي الرابط', payload: 'TAP_LINK' }],
    menu: [{ type: 'postback', title: 'كلّم شخصاً', payload: 'TAP_HUMAN' }],
};

/** A saved draft, as the route itself writes it, without going through a request. */
async function save(body: unknown = DRAFT, tenantId = 'tenant-1') {
    const res = await run('put', '/', { body, tenantId });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    writes = [];
    audits = [];
    return res;
}

function metaFailure(code: number, message: string, status = 400) {
    return Object.assign(new Error(message), { response: { status, data: { error: { code, message } } } });
}

const POST_GRAPH = () => graph.filter((g) => g.method === 'post');
const GET_GRAPH = () => graph.filter((g) => g.method === 'get');
const DELETE_GRAPH = () => graph.filter((g) => g.method === 'delete');

// ─── Who ─────────────────────────────────────────────────────────────────────

describe('/dm/ice-breakers: who may reach it', () => {
    const ROUTES: Array<['get' | 'put' | 'post' | 'delete', string]> = [['get', '/'], ['put', '/'], ['post', '/publish'], ['delete', '/publish'], ['get', '/live']];

    it('is mounted on the API router BELOW resolveTenant, so it always acts as the session\'s tenant', () => {
        const layers = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack;
        const at = layers.findIndex((l) => !l.route && l.handle === iceBreakersRouter);
        const tenantAt = layers.findIndex((l) => !l.route && l.handle === resolveTenant);
        assert.ok(at >= 0, 'the ice breakers router is mounted');
        assert.ok(tenantAt >= 0 && at > tenantAt, 'below resolveTenant');
    });

    it('carries the OWNER guard on every route, the reads too', () => {
        for (const [method, path] of ROUTES) {
            const guard = stackFor(method, path)[0] as Handle & { minimumRole?: string };
            assert.equal(guard.minimumRole, 'owner', `${method.toUpperCase()} ${path}`);
        }
        const mounted = (iceBreakersRouter as unknown as { stack: Array<{ route?: { methods: Record<string, boolean> } }> }).stack.filter((l) => l.route).length;
        assert.equal(mounted, ROUTES.length, 'a route added later has to be listed here, with its guard');
    });

    it('answers on exactly the verbs and paths the dashboard calls, and on nothing else (the router itself is driven, so Express does the matching)', async () => {
        const hit = (method: string, url: string): Promise<'refused' | 'fell through'> => new Promise((resolve) => {
            const req: any = { method, url, originalUrl: url, headers: {}, params: {}, query: {}, body: {}, session: { userId: 'u', tenantId: 'tenant-1' }, tenantRole: 'viewer' };
            const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json() { resolve(this.statusCode === 403 ? 'refused' : 'fell through'); return this; }, setHeader() {}, getHeader() {}, end() {} };
            (iceBreakersRouter as any)(req, res, () => resolve('fell through'));
        });
        for (const [method, url] of [['GET', '/'], ['PUT', '/'], ['POST', '/publish'], ['DELETE', '/publish'], ['GET', '/live']] as const) {
            assert.equal(await hit(method, url), 'refused', `${method} ${url} is a route (and the viewer was stopped at its guard)`);
        }
        for (const [method, url] of [['GET', '/publish'], ['POST', '/'], ['DELETE', '/'], ['PUT', '/publish'], ['POST', '/live'], ['GET', '/nothing']] as const) {
            assert.equal(await hit(method, url), 'fell through', `${method} ${url} is not a route`);
        }
        assert.deepEqual([writes.length, graph.length, queries.length], [0, 0, 0]);
    });

    it('refuses an operator and a viewer with 403 on every route, before anything is read, written or sent', async () => {
        for (const role of ['operator', 'viewer']) {
            for (const [method, path] of ROUTES) {
                const res = await run(method, path, { role, body: DRAFT });
                assert.equal(res.statusCode, 403, `${role} ${method.toUpperCase()} ${path}`);
                assert.equal(res.body.code, INSUFFICIENT_ROLE_CODE);
            }
        }
        assert.deepEqual([writes.length, audits.length, graph.length, queries.length], [0, 0, 0, 0]);
    });
});

// ─── The draft ───────────────────────────────────────────────────────────────

describe('GET /dm/ice-breakers', () => {
    it('is an empty draft with the editor\'s furniture when nothing was saved, and calls nobody', async () => {
        const res = await run('get', '/');

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.config, { iceBreakers: [], menu: [] });
        assert.equal(res.body.saved, false);
        assert.equal(res.body.published, null);
        assert.equal(res.body.inSync, false);
        assert.deepEqual(res.body.connected, { instagram: true });
        assert.deepEqual(res.body.limits, { iceBreakers: 4, question: 80, menuItems: 5, menuTitle: 30 });
        assert.deepEqual(res.body.taps.map((t: Json) => t.code), ['TAP_INFO', 'TAP_LEVEL', 'TAP_PRICE', 'TAP_LINK', 'TAP_SUPPORT', 'TAP_HUMAN', 'TAP_OTHER']);
        assert.equal(res.body.taps.find((t: Json) => t.code === 'TAP_PRICE').intent, 'price');
        assert.deepEqual([graph.length, writes.length, audits.length], [0, 0, 0], 'reading sends nothing and writes nothing');
    });

    it('offers suggestions from the tenant\'s own profile: the language, the register and the primary offer\'s name, and never saves them', async () => {
        const en = await run('get', '/');
        assert.equal(en.body.suggestions.kit, 'en');
        assert.deepEqual(en.body.suggestions.items[0], { question: 'What does Twelve-week plan include?', payload: 'TAP_INFO' });
        assert.equal(en.body.suggestions.items.length, 4);

        profile = SHOP_EG;
        const eg = await run('get', '/');
        assert.equal(eg.body.suggestions.kit, 'egyptian');
        assert.equal(eg.body.suggestions.items[0].question, 'إيه اللي في شمعة لافندر؟');
        assert.equal(eg.body.saved, false, 'suggestions are shown, never saved');
        assert.equal(writes.length, 0);
    });

    it('a profile that cannot be read still opens the card: the neutral Arabic suggestions for a tenant, the owner\'s own wording for the platform owner', async () => {
        profile = null;
        const tenant = await run('get', '/');
        assert.equal(tenant.statusCode, 200);
        assert.equal(tenant.body.suggestions.kit, 'msa', 'a stranger\'s card is never in the owner\'s dialect');
        assert.equal(tenant.body.suggestions.items.length, 4);
        assert.ok(logged.some((l) => l.includes('dm.ice_breakers_suggestions_unreadable')));

        platformOwner = 'tenant-1';
        invalidateTenantCache();
        const owner = await run('get', '/');
        assert.equal(owner.statusCode, 200);
        assert.equal(owner.body.suggestions.kit, 'gulf', 'the owner is answered in the legacy wording, as the DM bot answers him');
    });

    it('says Instagram is not connected for a tenant with no token, or no Instagram account', async () => {
        tenants['tenant-1'] = { instagram_page_id: 'ig-1', facebook_page_id: null, page_access_token: null };
        assert.deepEqual((await run('get', '/')).body.connected, { instagram: false });
        tenants['tenant-1'] = { instagram_page_id: null, facebook_page_id: 'fb-1', page_access_token: TOKEN };
        assert.deepEqual((await run('get', '/')).body.connected, { instagram: false });
    });

    it('a stored value nobody should have written (a sixth ice breaker, other JSON, a newer version) reads as an empty draft, and is logged', async () => {
        const six = Array.from({ length: 6 }, (_, i) => ({ question: `Question ${i}?`, payload: 'TAP_INFO' }));
        for (const stored of [JSON.stringify({ v: 1, config: { iceBreakers: six, menu: [] }, published: null }), 'not json', JSON.stringify({ v: 2, config: DRAFT }), '[]']) {
            settings[ROW_ONE] = stored;
            const res = await run('get', '/');
            assert.equal(res.statusCode, 200, stored.slice(0, 30));
            assert.deepEqual(res.body.config, { iceBreakers: [], menu: [] });
            assert.equal(res.body.saved, false);
        }
        assert.ok(logged.some((l) => l.includes('dm.ice_breakers_unreadable')));
    });
});

describe('PUT /dm/ice-breakers', () => {
    it('saves the draft under the TENANT\'s own key, audits the write with counts and a fingerprint (never the questions), and calls nobody', async () => {
        const res = await run('put', '/', { body: DRAFT });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.config, DRAFT);
        assert.equal(res.body.saved, true);
        assert.equal(res.body.inSync, false, 'saved, not published');
        assert.deepEqual(writes.map((w) => w.key), [ROW_ONE]);
        assert.deepEqual(JSON.parse(writes[0]!.value!), { v: 1, config: DRAFT, published: null });
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'dm.ice_breakers_write');
        assert.equal(audits[0]!.targetId, 'tenant-1');
        assert.deepEqual(audits[0]!.detail, { ice_breakers: 2, menu_items: 1, fingerprint: fingerprint(res.body.config) });
        assert.ok(!JSON.stringify(audits[0]).includes('وش السعر'), 'the questions are not in the ledger');
        assert.equal(graph.length, 0, 'saving a draft sends nothing to Instagram');
    });

    it('a fifth ice breaker is a 400 that names the list, and writes and audits nothing', async () => {
        const five = Array.from({ length: 5 }, (_, i) => ({ question: `Question ${i}?`, payload: 'TAP_INFO' }));
        const res = await run('put', '/', { body: { iceBreakers: five } });

        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'ICE_BREAKERS_INVALID');
        assert.deepEqual(res.body.problems.map((p: Json) => [p.field, p.code]), [['iceBreakers', 'TOO_MANY']]);
        assert.match(res.body.error, /At most 4/);
        assert.deepEqual([writes.length, audits.length, graph.length], [0, 0, 0]);
    });

    it('a question over the cap, an unknown payload and a bad menu link are each a 400 on their own field', async () => {
        const res = await run('put', '/', { body: {
            iceBreakers: [{ question: 'x'.repeat(81), payload: 'TAP_INFO' }, { question: 'Fine?', payload: 'NOPE' }],
            menu: [{ type: 'web_url', title: 'Site', url: 'http://not-https.test' }],
        } });
        assert.equal(res.statusCode, 400);
        assert.deepEqual(res.body.problems.map((p: Json) => `${p.field}:${p.code}`), [
            'iceBreakers[0].question:QUESTION_TOO_LONG', 'iceBreakers[1].payload:PAYLOAD_UNKNOWN', 'menu[0].url:URL_INVALID',
        ]);
        assert.equal(writes.length, 0);
    });

    it('keeps the record of the last publish when the draft changes, so the screen can say it is newer', async () => {
        await save();
        await run('post', '/publish');
        const before = JSON.parse(settings[ROW_ONE]!).published;
        assert.ok(before, 'a publish was recorded');

        const res = await run('put', '/', { body: { iceBreakers: [{ question: 'A different question?', payload: 'TAP_INFO' }], menu: [] } });
        assert.deepEqual(JSON.parse(settings[ROW_ONE]!).published, before);
        assert.equal(res.body.inSync, false);
        assert.deepEqual(res.body.published, before);
    });

    it('keys of the body that are not ours are ignored: a body naming another platform, a token or a locale changes nothing that is stored', async () => {
        const res = await run('put', '/', { body: { ...DRAFT, platform: 'facebook', access_token: 'EAAGstolen', locale: 'en_GB', ice_breakers: [] } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(JSON.parse(settings[ROW_ONE]!), { v: 1, config: DRAFT, published: null });
    });
});

describe('a draft is the tenant\'s own', () => {
    it('another tenant\'s session reads its own row and writes its own: one never sees or overwrites the other\'s', async () => {
        await run('put', '/', { body: DRAFT, tenantId: 'tenant-1' });
        await run('put', '/', { body: { iceBreakers: [{ question: 'Is it for me?', payload: 'TAP_LEVEL' }] }, tenantId: 'tenant-2' });

        assert.deepEqual(Object.keys(settings).sort(), [ROW_ONE, ROW_TWO]);
        assert.deepEqual((await run('get', '/', { tenantId: 'tenant-1' })).body.config, DRAFT);
        assert.equal((await run('get', '/', { tenantId: 'tenant-2' })).body.config.iceBreakers[0].question, 'Is it for me?');
        assert.deepEqual((await run('get', '/', { tenantId: 'tenant-3' })).body.config, { iceBreakers: [], menu: [] }, 'a tenant that never saved has nothing');
    });

    it('a publish uses the session tenant\'s own Page token, and no other', async () => {
        await save(DRAFT, 'tenant-1');
        await save(DRAFT, 'tenant-2');
        await run('post', '/publish', { tenantId: 'tenant-2', userId: 'u-two' });

        assert.ok(graph.length > 0);
        for (const g of graph) assert.equal(g.config.headers.Authorization, `Bearer ${TOKEN_TWO}`);
        assert.equal(JSON.parse(settings[ROW_ONE]!).published, null, 'tenant one was not touched');
        assert.ok(JSON.parse(settings[ROW_TWO]!).published, 'tenant two was');
    });
});

// ─── Publish ─────────────────────────────────────────────────────────────────

describe('POST /dm/ice-breakers/publish', () => {
    it('sends the SAVED draft as one POST in the shape Meta documents, then reads back, records the publish and audits it', async () => {
        await save();
        onGet = okAnswer({ data: [{ ice_breakers: [{ call_to_actions: [{ question: 'وش السعر؟', payload: 'TAP_PRICE' }], locale: 'default' }] }] });

        const res = await run('post', '/publish');

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(POST_GRAPH().length, 1, 'ONE write');
        assert.equal(DELETE_GRAPH().length, 0);
        const sent = POST_GRAPH()[0]!;
        assert.equal(sent.url, URL);
        assert.deepEqual(sent.config.params, { platform: 'instagram' });
        assert.deepEqual(sent.body, {
            platform: 'instagram',
            ice_breakers: [{
                call_to_actions: [{ question: 'وش السعر؟', payload: 'TAP_PRICE' }, { question: 'أبي الرابط', payload: 'TAP_LINK' }],
                locale: 'default',
            }],
            persistent_menu: [{ locale: 'default', call_to_actions: [{ type: 'postback', title: 'كلّم شخصاً', payload: 'TAP_HUMAN' }] }],
        });
        assert.equal(sent.config.headers.Authorization, `Bearer ${TOKEN}`);

        // The read-back, right after: what Instagram holds, from Instagram.
        assert.equal(GET_GRAPH().length, 1);
        assert.deepEqual(GET_GRAPH()[0]!.config.params, { platform: 'instagram', fields: 'ice_breakers,persistent_menu' });
        assert.equal(res.body.live.iceBreakers[0].items[0].question, 'وش السعر؟');
        assert.equal(res.body.liveError, null);

        assert.deepEqual(res.body.result, { set: ['ice_breakers', 'persistent_menu'], removed: [] });
        assert.equal(res.body.inSync, true);
        assert.deepEqual({ ...res.body.published, at: 'T' }, { at: 'T', by: 'u-owner', iceBreakers: 2, menu: 1, hash: fingerprint(DRAFT as any) });
        assert.ok(Number.isFinite(Date.parse(res.body.published.at)));

        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'dm.ice_breakers_publish');
        assert.equal(audits[0]!.actorEmail, 'owner@example.test');
        assert.deepEqual(audits[0]!.detail, {
            ice_breakers: 2, menu_items: 1, fingerprint: fingerprint(DRAFT as any), set: ['ice_breakers', 'persistent_menu'], removed: [], result_status: 'ok',
        });
    });

    it('a read-back that fails does not fail the publish: it landed, and the answer says the read-back did not', async () => {
        await save();
        onGet = async () => { throw metaFailure(1, 'Temporarily unavailable', 400); };

        const res = await run('post', '/publish');

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.live, null);
        assert.match(res.body.liveError, /Instagram profile read failed/);
        assert.equal(res.body.inSync, true);
    });

    it('with an ice breaker draft and no menu, the body has no persistent_menu', async () => {
        await save({ iceBreakers: DRAFT.iceBreakers, menu: [] });
        await run('post', '/publish');
        assert.deepEqual(Object.keys(POST_GRAPH()[0]!.body as object).sort(), ['ice_breakers', 'platform']);
    });

    it('after the menu is emptied and the owner presses again: the ice breakers are set and the menu he published is removed, in that order', async () => {
        await save();
        await run('post', '/publish');
        graph = [];
        await save({ iceBreakers: DRAFT.iceBreakers, menu: [] });

        const res = await run('post', '/publish');

        assert.equal(res.statusCode, 200);
        assert.deepEqual(graph.filter((g) => g.method !== 'get').map((g) => g.method), ['post', 'delete']);
        assert.deepEqual(DELETE_GRAPH()[0]!.body, { fields: ['persistent_menu'] });
        assert.deepEqual(res.body.result, { set: ['ice_breakers'], removed: ['persistent_menu'] });
        assert.equal(JSON.parse(settings[ROW_ONE]!).published.menu, 0);
        assert.deepEqual(audits[0]!.detail['removed'], ['persistent_menu']);
    });

    it('an empty draft with nothing published is a 400 that sends nothing and audits nothing', async () => {
        const res = await run('post', '/publish');
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'NOTHING_TO_PUBLISH');
        assert.deepEqual([graph.length, audits.length, writes.length], [0, 0, 0]);
    });

    it('a tenant with no token, and one with no Instagram account, are each a 409 that sends nothing', async () => {
        await save();
        tenants['tenant-1'] = { instagram_page_id: 'ig-1', facebook_page_id: null, page_access_token: null };
        const a = await run('post', '/publish');
        assert.deepEqual([a.statusCode, a.body.code], [409, 'META_NOT_CONNECTED']);

        tenants['tenant-1'] = { instagram_page_id: null, facebook_page_id: 'fb-1', page_access_token: TOKEN };
        const b = await run('post', '/publish');
        assert.deepEqual([b.statusCode, b.body.code], [409, 'INSTAGRAM_NOT_CONNECTED']);
        assert.equal(graph.length, 0);
    });

    it('Meta refusing it is a 502 with Meta\'s own words and code; nothing is recorded as published; the attempt IS in the ledger', async () => {
        await save();
        onPost = async () => { throw metaFailure(10, 'Application does not have permission for this action'); };

        const res = await run('post', '/publish');

        assert.equal(res.statusCode, 502);
        assert.equal(res.body.code, 'META_ERROR');
        assert.equal(res.body.metaCode, 10);
        assert.match(res.body.error, /does not have permission/);
        assert.equal(JSON.parse(settings[ROW_ONE]!).published, null, 'not published');
        assert.equal(writes.length, 0, 'the draft row was not rewritten');
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'dm.ice_breakers_publish');
        assert.equal(audits[0]!.detail['result_status'], 'failed');
        assert.equal(audits[0]!.detail['meta_code'], 10);
        assert.equal(GET_GRAPH().length, 0, 'no read-back after a refusal');
    });

    it('a POST that landed and a DELETE that did not leaves a record that says out of sync, and the answer is the failure', async () => {
        await save();
        await run('post', '/publish');
        await save({ iceBreakers: DRAFT.iceBreakers, menu: [] });
        onDelete = async () => { throw metaFailure(100, 'Unsupported delete request'); };

        const res = await run('post', '/publish');

        assert.equal(res.statusCode, 502);
        const stored = JSON.parse(settings[ROW_ONE]!);
        assert.equal(stored.published.hash, '', 'marked out of sync');
        assert.equal(stored.published.menu, 1, 'the menu is still there, and the record says so');
        const got = await run('get', '/');
        assert.equal(got.body.inSync, false);
    });

    it('is not a thing a GET, a PUT or a deploy does: only these two routes and /live reach Meta', async () => {
        await save();
        await run('get', '/');
        await run('put', '/', { body: DRAFT });
        assert.equal(graph.length, 0);
    });
});

// ─── Remove, read ────────────────────────────────────────────────────────────

describe('DELETE /dm/ice-breakers/publish', () => {
    it('is one DELETE naming both properties in the body, then a read-back; the record of a publish goes and the draft stays; the ledger has it', async () => {
        await save();
        await run('post', '/publish');
        graph = [];
        audits = [];

        const res = await run('delete', '/publish');

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(DELETE_GRAPH().length, 1);
        assert.equal(POST_GRAPH().length, 0);
        assert.equal(DELETE_GRAPH()[0]!.url, URL);
        assert.deepEqual(DELETE_GRAPH()[0]!.config.params, { platform: 'instagram' });
        assert.deepEqual(DELETE_GRAPH()[0]!.body, { fields: ['ice_breakers', 'persistent_menu'] });
        assert.equal(DELETE_GRAPH()[0]!.config.headers.Authorization, `Bearer ${TOKEN}`);
        assert.equal(GET_GRAPH().length, 1, 'read back');

        assert.deepEqual(res.body.result, { set: [], removed: ['ice_breakers', 'persistent_menu'] });
        assert.equal(res.body.published, null);
        assert.deepEqual(res.body.config, DRAFT, 'the draft is kept');
        assert.deepEqual(audits.map((a) => a.action), ['dm.ice_breakers_remove']);
        assert.deepEqual(audits[0]!.detail, { removed: ['ice_breakers', 'persistent_menu'], result_status: 'ok' });
    });

    it('a refusal from Meta is a 502, and the record of the publish stays as it was', async () => {
        await save();
        await run('post', '/publish');
        const before = JSON.parse(settings[ROW_ONE]!).published;
        audits = [];
        onDelete = async () => { throw metaFailure(190, 'Invalid OAuth access token', 401); };

        const res = await run('delete', '/publish');

        assert.equal(res.statusCode, 502);
        assert.equal(res.body.metaCode, 190);
        assert.deepEqual(JSON.parse(settings[ROW_ONE]!).published, before);
        assert.equal(audits[0]!.detail['result_status'], 'failed');
    });

    it('with no Instagram connected, sends nothing', async () => {
        tenants['tenant-1'] = { instagram_page_id: null, facebook_page_id: 'fb-1', page_access_token: TOKEN };
        const res = await run('delete', '/publish');
        assert.equal(res.statusCode, 409);
        assert.equal(graph.length, 0);
    });
});

describe('GET /dm/ice-breakers/live', () => {
    it('is one GET for both properties and answers what Instagram holds, normalised', async () => {
        onGet = okAnswer({ data: [{ persistent_menu: [{ locale: 'default', call_to_actions: [{ type: 'postback', title: 'Talk', payload: 'TAP_HUMAN' }] }] }] });

        const res = await run('get', '/live');

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.live.menu, [{ locale: 'default', items: [{ type: 'postback', title: 'Talk', payload: 'TAP_HUMAN' }] }]);
        assert.equal(graph.length, 1);
        assert.deepEqual(GET_GRAPH()[0]!.config.params, { platform: 'instagram', fields: 'ice_breakers,persistent_menu' });
    });

    it('Meta refusing the read is a 502 in Meta\'s words', async () => {
        onGet = async () => { throw metaFailure(190, 'Invalid OAuth access token', 401); };
        const res = await run('get', '/live');
        assert.equal(res.statusCode, 502);
        assert.equal(res.body.metaCode, 190);
    });
});

// ─── The token ───────────────────────────────────────────────────────────────

describe('the Page token', () => {
    it('is in no answer, no audit row, no stored value and no log line, through a publish, a refusal, a removal and a read', async () => {
        await save();
        const answers: unknown[] = [];
        answers.push((await run('post', '/publish')).body);
        answers.push((await run('get', '/live')).body);
        answers.push((await run('delete', '/publish')).body);
        onPost = async () => { throw metaFailure(10, 'No permission'); };
        answers.push((await run('post', '/publish')).body);

        assert.ok(logged.some((l) => l.includes('dm.ice_breakers_published')) && audits.length >= 3, 'the log and the ledger were really captured, so the check below is not vacuous');
        const everything = JSON.stringify([answers, audits, writes, settings, logged]);
        assert.ok(!everything.includes(TOKEN), 'the token leaked');
        assert.ok(!everything.includes('EAAG'), 'no token-shaped string at all');
    });
});
