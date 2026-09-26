/**
 * The admin router's gate and its validation.
 *
 * Driven by calling the router directly with a plain request object, so there is no server and
 * no database. That bounds what can be covered here to the decisions made *before* any SQL
 * runs — which is deliberately where the entire security surface lives:
 *
 *   - the role gate, which must 404 (not 403) for everyone who is not a platform_admin, on
 *     every route, because confirming this surface exists is itself a disclosure;
 *   - every validation refusal, including the one that matters most: there is no request body
 *     that erases a person without a preview token.
 *
 * The SQL these routes run was verified separately, against a throwaway local Postgres with
 * all fifteen migrations applied. The lockout guard, the page-id rules and the erasure token
 * are unit-tested in src/services/{adminGuards,erasure}.test.ts.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { setStorageFetch } from '../services/supabaseStorage.js';
import adminRouter from './admin.js';

interface Reply {
    status: number;
    body: any;
    /** True when no route matched and the request fell out of the router. */
    fellThrough?: boolean;
}

type Session = { userId: string | null; role: string; tenantId: string | null; tokenVersion: number };

const ADMIN: Session = { userId: null, role: 'platform_admin', tenantId: 't-1', tokenVersion: 0 };
const NOT_ADMIN: Session = { userId: 'u-1', role: 'user', tenantId: 't-1', tokenVersion: 1 };

const UUID = '11111111-1111-4111-8111-111111111111';

/** Call the router as Express would, with nothing mounted above it. */
function call(
    method: string,
    url: string,
    opts: { session?: Session; body?: unknown; query?: Record<string, unknown> } = {}
): Promise<Reply> {
    return new Promise((resolve) => {
        const req = {
            method: method.toUpperCase(),
            url,
            originalUrl: url,
            body: opts.body ?? {},
            // Express populates this at the application level, not in a bare router.
            query: opts.query ?? {},
            params: {},
            headers: {},
            session: opts.session,
        } as unknown as Request;

        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(body: unknown) { resolve({ status: (this as any).statusCode, body }); return this; },
            setHeader() { return this; },
        } as unknown as Response;

        adminRouter(req, res, () => resolve({ status: 0, body: null, fellThrough: true }));
    });
}

/** Every route this router serves, with an input that is valid enough to reach the handler. */
const ROUTES: Array<[string, string, Record<string, unknown>?]> = [
    ['GET', '/ops'],
    ['GET', '/tenants'],
    ['POST', '/tenants'],
    ['GET', `/tenants/${UUID}`],
    ['PATCH', `/tenants/${UUID}`],
    ['POST', `/tenants/${UUID}/recheck-token`],
    ['GET', '/users'],
    ['POST', '/users'],
    ['PATCH', `/users/${UUID}`],
    ['POST', `/users/${UUID}/password`],
    ['POST', `/users/${UUID}/revoke`],
    ['POST', `/users/${UUID}/memberships`],
    ['DELETE', `/users/${UUID}/memberships/${UUID}`],
    ['GET', '/jobs'],
    ['POST', `/jobs/${UUID}/retry`],
    ['POST', `/jobs/${UUID}/cancel`],
    ['GET', '/erasure/preview', { handle: 'someone' }],
    ['POST', '/erasure'],
    ['GET', '/audit'],
    ['GET', '/gemini-key'],
    ['PUT', '/gemini-key'],
    ['DELETE', '/gemini-key'],
    ['GET', '/media-storage'],
    ['PUT', '/media-storage'],
    ['DELETE', '/media-storage'],
];

describe('the platform_admin gate', () => {
    it('404s every route for a non-admin session', async () => {
        for (const [method, url, query] of ROUTES) {
            const reply = await call(method, url, { session: NOT_ADMIN, query });

            assert.equal(reply.status, 404, `${method} ${url}`);
            assert.deepEqual(reply.body, { error: 'Not found.' }, `${method} ${url}`);
        }
    });

    it('404s every route when there is no session at all', async () => {
        // requireAuth runs above this router in api.ts, so this should be unreachable — which
        // is exactly why it is asserted: a guard that depends on a caller is one refactor away
        // from being no guard.
        for (const [method, url, query] of ROUTES) {
            const reply = await call(method, url, { query });
            assert.equal(reply.status, 404, `${method} ${url}`);
        }
    });

    it('gives a non-admin the same answer for a route that does not exist', async () => {
        // The disclosure this prevents: if a real route answered 403 and a made-up one 404,
        // the difference would map the surface.
        const real = await call('GET', '/ops', { session: NOT_ADMIN });
        const invented = await call('GET', '/there-is-no-such-endpoint', { session: NOT_ADMIN });

        assert.deepEqual(real, invented);
    });

    it('does not 404 an admin on those same routes', async () => {
        // The gate must not be so broad that it hides the surface from its own audience. Only
        // the routes that refuse before touching SQL can be checked without a database.
        const reply = await call('POST', '/tenants', { session: ADMIN, body: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /instagram_page_id is required/);
    });
});

describe('tenant validation', () => {
    it('requires a page id and a token to create one', async () => {
        assert.match((await call('POST', '/tenants', { session: ADMIN, body: {} })).body.error,
            /instagram_page_id is required/);

        assert.match((await call('POST', '/tenants', {
            session: ADMIN, body: { instagram_page_id: '17841400000000000' },
        })).body.error, /page_access_token is required/);
    });

    it('rejects a page id that is not a Meta page id', async () => {
        const reply = await call('POST', '/tenants', {
            session: ADMIN,
            body: { instagram_page_id: 'https://instagram.com/someone', page_access_token: 'x' },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /not a valid Meta page id/);
    });

    it('404s a tenant id that is not a uuid, rather than querying for it', async () => {
        for (const [method, url] of [
            ['GET', '/tenants/not-a-uuid'],
            ['PATCH', '/tenants/not-a-uuid'],
            ['POST', '/tenants/not-a-uuid/recheck-token'],
        ] as const) {
            const reply = await call(method, url, { session: ADMIN, body: { name: 'x' } });
            assert.equal(reply.status, 404, `${method} ${url}`);
        }
    });

    it('refuses an empty PATCH rather than reporting a no-op as success', async () => {
        const reply = await call('PATCH', `/tenants/${UUID}`, { session: ADMIN, body: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Nothing to update/);
        // The message must list what IS accepted, which is the whole point of widening it.
        assert.match(reply.body.error, /instagram_page_id/);
        assert.match(reply.body.error, /webhook_verify_token/);
    });

    it('refuses to blank the page id every webhook is routed by', async () => {
        const reply = await call('PATCH', `/tenants/${UUID}`, {
            session: ADMIN, body: { instagram_page_id: null },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /every webhook/);
    });

    it('validates the verify token the same way the settings route does', async () => {
        const reply = await call('PATCH', `/tenants/${UUID}`, {
            session: ADMIN, body: { webhook_verify_token: 'short' },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /at least 8 characters/);
    });
});

describe('user validation', () => {
    it('requires a valid email and a long enough password', async () => {
        assert.match((await call('POST', '/users', { session: ADMIN, body: { email: 'nope' } })).body.error,
            /valid email/);

        assert.match((await call('POST', '/users', {
            session: ADMIN, body: { email: 'a@b.co', password: 'short' },
        })).body.error, /at least 12 characters/);
    });

    it('rejects a role that is not one of the two the schema means', async () => {
        const reply = await call('PATCH', `/users/${UUID}`, { session: ADMIN, body: { role: 'admin' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /'user' or 'platform_admin'/);
    });

    it('rejects a non-boolean is_active rather than coercing it', async () => {
        // `is_active: "false"` is truthy. Coercing it would switch an account ON when the
        // caller meant off.
        const reply = await call('PATCH', `/users/${UUID}`, { session: ADMIN, body: { is_active: 'false' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /must be a boolean/);
    });

    it('refuses an empty user PATCH', async () => {
        const reply = await call('PATCH', `/users/${UUID}`, { session: ADMIN, body: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Nothing to update/);
    });

    it('404s a membership revoke whose ids are not uuids', async () => {
        const reply = await call('DELETE', '/users/nope/memberships/also-nope', { session: ADMIN });

        assert.equal(reply.status, 404);
    });
});

describe('membership role validation', () => {
    it('refuses a role outside the vocabulary', async () => {
        // `role` used to be stored verbatim, because nothing read it. It is an authorization
        // decision now, and `normalizeTenantRole` resolves anything it does not recognise to
        // `owner` — so a typo would silently grant everything to the person an operator was
        // deliberately restricting. Failing open is right for existing data and wrong for a
        // value somebody is typing right now.
        // `'viewer '` is deliberately absent: surrounding whitespace is trimmed, the same
        // leniency every other string field here applies to a pasted value. Case is NOT,
        // because 'Owner' is a different string and guessing at intent is how a restriction
        // becomes a grant.
        for (const role of ['member', 'admin', 'Owner', 'read-only', 42, {}]) {
            const reply = await call('POST', `/users/${UUID}/memberships`, {
                session: ADMIN, body: { creator_id: UUID, role },
            });

            assert.equal(reply.status, 400, `role ${JSON.stringify(role)}`);
            assert.match(reply.body.error, /owner, operator, viewer/);
        }
    });

    it('still defaults to owner when no role is named', async () => {
        // The grant call that existed before roles meant anything sent no role at all, and it
        // must keep granting exactly what it granted then. Reaching SQL — which this suite has
        // no database for — is the pass condition: the refusals above all answer before it.
        const reply = await call('POST', `/users/${UUID}/memberships`, {
            session: ADMIN, body: { creator_id: UUID },
        });

        assert.notEqual(reply.status, 400, 'an unspecified role is not a validation failure');
    });
});

describe('job validation', () => {
    it('rejects an unknown status filter and lists the real ones', async () => {
        const reply = await call('GET', '/jobs', { session: ADMIN, query: { status: 'broken' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /pending, running, done, failed, cancelled/);
    });

    it('404s a job id that is not a uuid', async () => {
        for (const url of [`/jobs/nope/retry`, `/jobs/nope/cancel`]) {
            assert.equal((await call('POST', url, { session: ADMIN })).status, 404, url);
        }
    });
});

describe('erasure', () => {
    it('cannot be triggered without a preview token', async () => {
        // The invariant this whole design exists for: POST accepts a token and nothing else,
        // so no combination of body fields spells "delete this handle" in one request.
        for (const body of [
            {},
            { handle: 'someone' },
            { handle: 'someone', confirm: true },
            { token: null },
            { token: '' },
            { token: 'made-up' },
            { token: { forged: true } },
        ]) {
            const reply = await call('POST', '/erasure', { session: ADMIN, body });

            assert.equal(reply.status, 400, JSON.stringify(body));
            assert.equal(reply.body.code, 'INVALID_TOKEN', JSON.stringify(body));
            // And the message has to say what to do instead.
            assert.match(reply.body.error, /preview/i, JSON.stringify(body));
        }
    });

    it('requires a handle to preview, and says what a handle is', async () => {
        const reply = await call('GET', '/erasure/preview', { session: ADMIN, query: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /username or the numeric user id/);
    });

    it('refuses an absurdly long handle before it becomes a query', async () => {
        const reply = await call('GET', '/erasure/preview', {
            session: ADMIN, query: { handle: 'x'.repeat(300) },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /longer than 255/);
    });
});

describe('audit', () => {
    it('rejects an unknown action filter rather than answering "nothing happened"', async () => {
        // An empty list in response to a typo reads as "no privileged actions have occurred",
        // which is the opposite of what an auditor needs to hear.
        const reply = await call('GET', '/audit', { session: ADMIN, query: { action: 'tenant.updated' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Unknown action filter/);
    });
});

/**
 * PUT/DELETE /gemini-key — the one key every tenant's DM replies and the Studio run on.
 *
 * Unlike the rest of this file these reach SQL, so the pool is stubbed with a small in-memory
 * `app_settings` and Google is stubbed at axios. What is pinned is the promise the Operations
 * screen makes: a key is never written unless Google accepted it and ran the DM bot's models,
 * it is stored encrypted, and neither the response nor the audit row ever carries it.
 */
describe('the Gemini key', () => {
    const KEY = 'AIza.fake.pasted-on-operations.test';
    let store: Map<string, { value: string; is_secret: boolean }>;
    let statements: Array<{ sql: string; params: unknown[] }>;
    let probed: Array<{ url: string; key: unknown }>;
    let agentModels: Array<string | null>;
    let google: { list: () => unknown; model: () => unknown };
    const restore: Array<() => void> = [];

    const googleSays = (status: number, message: string) => () => {
        throw Object.assign(new Error(`Request failed with status code ${status}`), {
            response: { status, data: { error: { code: status, message } } },
        });
    };

    beforeEach(() => {
        store = new Map();
        statements = [];
        probed = [];
        agentModels = ['gemini-2.5-flash'];
        google = { list: () => ({ status: 200, data: {} }), model: () => ({ status: 200, data: {} }) };

        const originalQuery = pool.query;
        const originalGet = axios.get;
        const originalPost = axios.post;
        const originalEnv = { gemini: process.env.GEMINI_API_KEY, enc: process.env.TOKEN_ENCRYPTION_KEY };
        const previousSink = setLogSink(() => {});
        process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
        process.env.GEMINI_API_KEY = 'AIza-the-environment-one';

        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            if (/SELECT DISTINCT model FROM ai_agents/.test(sql)) return { rows: agentModels.map((model) => ({ model })), rowCount: agentModels.length };
            if (/SELECT value, is_secret FROM app_settings/.test(sql)) {
                const row = store.get(String(params[0]));
                return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }
            if (/INSERT INTO app_settings/.test(sql)) {
                store.set(String(params[0]), { value: String(params[1]), is_secret: params[2] === true });
                return { rows: [], rowCount: 1 };
            }
            if (/DELETE FROM app_settings/.test(sql)) {
                const had = store.delete(String(params[0]));
                return { rows: [], rowCount: had ? 1 : 0 };
            }
            if (/INSERT INTO audit_log/.test(sql)) return { rows: [{ id: 'audit-1' }], rowCount: 1 };
            throw new Error(`no result arranged for SQL: ${sql}`);
        };
        (axios as any).get = async (url: string, config: any) => {
            probed.push({ url, key: config?.headers?.['x-goog-api-key'] });
            return google.list();
        };
        (axios as any).post = async (url: string, _body: unknown, config: any) => {
            probed.push({ url, key: config?.headers?.['x-goog-api-key'] });
            return google.model();
        };

        restore.push(() => {
            (pool as unknown as { query: unknown }).query = originalQuery;
            (axios as any).get = originalGet;
            (axios as any).post = originalPost;
            setLogSink(previousSink);
            for (const [name, value] of [['GEMINI_API_KEY', originalEnv.gemini], ['TOKEN_ENCRYPTION_KEY', originalEnv.enc]] as const) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        });
    });

    afterEach(() => { while (restore.length) restore.pop()!(); });

    const auditRows = () => statements.filter((st) => /INSERT INTO audit_log/.test(st.sql));

    it('refuses a blank or plainly malformed paste before asking Google anything', async () => {
        for (const apiKey of [undefined, '', '   ', 'short', 'AIza has a space in it 0123456789', 42]) {
            const reply = await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey } });
            assert.equal(reply.status, 400, JSON.stringify(apiKey));
        }
        assert.deepEqual(probed, []);
        assert.equal(store.size, 0);
    });

    it('saves a key Google accepts, encrypted, and answers with a masked hint only', async () => {
        const reply = await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey: `  ${KEY}\n` } });

        assert.equal(reply.status, 200);
        const stored = store.get('gemini.api_key');
        assert.ok(stored, 'the key must be written');
        assert.equal(stored!.is_secret, true);
        assert.match(stored!.value, /^enc:v1:/, 'stored encrypted, like the Meta page token');
        assert.ok(!stored!.value.includes(KEY));

        assert.equal(reply.body.source, 'database');
        assert.equal(reply.body.envFallback, true);
        assert.ok(!JSON.stringify(reply.body).includes(KEY), 'the response must never carry the key');
        assert.ok(reply.body.preview.startsWith('AIz'));
    });

    it('tries the new key, in a header, on the models the DM bot answers with', async () => {
        // The default, plus every agent's model as it resolves: a retired one resolves to the
        // default, so it costs no extra request.
        agentModels = ['gemini-3.8-flash', 'gemini-1.5-flash', null];
        const reply = await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey: KEY } });

        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body.checkedModels, ['gemini-2.5-flash', 'gemini-3.8-flash']);
        assert.deepEqual(
            probed.map((p) => p.url.replace('https://generativelanguage.googleapis.com/v1beta', '')),
            ['/models?pageSize=1', '/models/gemini-2.5-flash:generateContent', '/models/gemini-3.8-flash:generateContent'],
        );
        assert.ok(probed.every((p) => p.key === KEY && !p.url.includes(KEY)));
    });

    it('writes nothing when Google refuses the key or cannot run the DM bot\'s model', async () => {
        for (const refusal of [
            { list: googleSays(400, 'API key not valid. Please pass a valid API key.'), model: () => ({}) },
            { list: () => ({}), model: googleSays(404, 'models/gemini-2.5-flash is not found for API version v1beta.') },
        ]) {
            google = refusal;
            const reply = await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey: KEY } });

            assert.equal(reply.status, 400);
            assert.match(reply.body.error, /API key not valid|cannot run gemini-2\.5-flash/);
        }
        assert.equal(store.size, 0, 'the key in use must keep answering');
        assert.deepEqual(auditRows(), []);
    });

    it('answers 502, and writes nothing, when Google cannot be asked', async () => {
        google.list = googleSays(503, 'The service is currently unavailable.');
        const reply = await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey: KEY } });

        assert.equal(reply.status, 502);
        assert.equal(store.size, 0);
    });

    it('saves a key whose quota is spent for today, and says so', async () => {
        google.model = googleSays(429, 'You exceeded your current quota.');
        const reply = await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey: KEY } });

        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body.quotaSpent, ['gemini-2.5-flash']);
        assert.ok(store.has('gemini.api_key'));
    });

    it('audits the save and the removal as facts, never as the key', async () => {
        await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey: KEY } });
        const removed = await call('DELETE', '/gemini-key', { session: ADMIN });

        assert.equal(removed.status, 200);
        assert.deepEqual(removed.body, { source: 'env', preview: null, envFallback: true });
        assert.equal(store.size, 0);

        const rows = auditRows();
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((row) => row.params[2]), ['settings.gemini_key_write', 'settings.gemini_key_write']);
        for (const row of rows) assert.ok(!JSON.stringify(row.params).includes(KEY));
        assert.match(String(rows[0]!.params[5]), /"change":"saved"/);
        assert.match(String(rows[1]!.params[5]), /"change":"removed"/);
    });

    it('reports which key is answering without sending either one', async () => {
        const before = await call('GET', '/gemini-key', { session: ADMIN });
        assert.deepEqual(before.body, { source: 'env', preview: null, envFallback: true });

        await call('PUT', '/gemini-key', { session: ADMIN, body: { apiKey: KEY } });
        const after = await call('GET', '/gemini-key', { session: ADMIN });
        assert.equal(after.body.source, 'database');
        assert.ok(!JSON.stringify(after.body).includes(KEY));
        assert.ok(!JSON.stringify(after.body).includes('environment-one'));
    });
});

/**
 * GET/PUT/DELETE /media-storage — the Supabase project every tenant's uploads go to.
 *
 * Reaches SQL, so the pool is an in-memory `app_settings` plus the usage query, and Supabase is
 * a fake `fetch`. What is pinned is what Settings promises: nothing is saved until Supabase has
 * accepted the key (and the bucket exists), the key is stored encrypted, the key travels in the
 * header its format needs, and neither a response nor an audit row ever carries it.
 */
describe('media storage config', () => {
    const PROJECT = 'https://abcd1234.supabase.co';
    const SECRET = 'sb_secret_pasted-in-settings-0123456789';
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const legacy = (role: string) => `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ role })}.c2ln`;

    let store: Map<string, { value: string; is_secret: boolean }>;
    let statements: Array<{ sql: string; params: unknown[] }>;
    let supabase: Array<{ method: string; path: string; headers: Record<string, string>; body: string | null }>;
    let bucket: 'exists' | 'missing' | 'refused' | 'down';
    let storedFiles: number;
    const restore: Array<() => void> = [];

    beforeEach(() => {
        store = new Map();
        statements = [];
        supabase = [];
        bucket = 'missing';
        storedFiles = 0;

        const originalQuery = pool.query;
        const originalEnv = {
            enc: process.env.TOKEN_ENCRYPTION_KEY, url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY,
        };
        const previousSink = setLogSink(() => {});
        process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;

        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql, params });
            if (/SELECT value, is_secret FROM app_settings/.test(sql)) {
                const row = store.get(String(params[0]));
                return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
            }
            if (/INSERT INTO app_settings/.test(sql)) {
                store.set(String(params[0]), { value: String(params[1]), is_secret: params[2] === true });
                return { rows: [], rowCount: 1 };
            }
            if (/DELETE FROM app_settings/.test(sql)) {
                const had = store.delete(String(params[0]));
                return { rows: [], rowCount: had ? 1 : 0 };
            }
            if (/FROM media_uploads/.test(sql) && /storage_files/.test(sql)) {
                return {
                    rows: [{ storage_files: String(storedFiles), storage_bytes: String(storedFiles * 1000), database_files: '2', database_bytes: '5000', queued: '0' }],
                    rowCount: 1,
                };
            }
            if (/INSERT INTO audit_log/.test(sql)) return { rows: [{ id: 'audit-1' }], rowCount: 1 };
            throw new Error(`no result arranged for SQL: ${sql}`);
        };

        const previousFetch = setStorageFetch(async (input, init = {}) => {
            const headers: Record<string, string> = {};
            new Headers(init.headers as Record<string, string>).forEach((value, name) => { headers[name] = value; });
            const path = new URL(input).pathname;
            supabase.push({ method: init.method ?? 'GET', path, headers, body: init.body ? String(init.body) : null });
            if (bucket === 'down') throw new TypeError('fetch failed');
            if (bucket === 'refused') return new Response(JSON.stringify({ message: 'Invalid API key' }), { status: 401 });
            if (init.method === 'POST' && path === '/storage/v1/bucket') {
                bucket = 'exists';
                return new Response(JSON.stringify({ name: 'media' }), { status: 200 });
            }
            if (path === '/storage/v1/bucket/media') {
                return bucket === 'exists'
                    ? new Response(JSON.stringify({ id: 'media', public: true }), { status: 200 })
                    : new Response(JSON.stringify({ statusCode: '404', error: 'NoSuchBucket', code: 'NoSuchBucket', message: 'Bucket not found' }), { status: 400 });
            }
            throw new Error(`no Supabase answer arranged for ${init.method} ${path}`);
        });

        restore.push(() => {
            (pool as unknown as { query: unknown }).query = originalQuery;
            setStorageFetch(previousFetch);
            setLogSink(previousSink);
            for (const [name, value] of [
                ['TOKEN_ENCRYPTION_KEY', originalEnv.enc], ['SUPABASE_URL', originalEnv.url], ['SUPABASE_SERVICE_ROLE_KEY', originalEnv.key],
            ] as const) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        });
    });

    afterEach(() => { while (restore.length) restore.pop()!(); });

    const auditRows = () => statements.filter((st) => /INSERT INTO audit_log/.test(st.sql));

    it('refuses a bad URL or a plainly wrong key before asking Supabase anything', async () => {
        for (const body of [
            { key: SECRET },
            { url: 'abcd1234.supabase.co', key: SECRET },
            { url: 'http://abcd1234.supabase.co', key: SECRET },
            { url: PROJECT, key: 'sb_publishable_0123456789abcdef' },
            { url: PROJECT, key: legacy('anon') },
            { url: PROJECT, key: 'not a key' },
        ]) {
            const reply = await call('PUT', '/media-storage', { session: ADMIN, body });
            assert.equal(reply.status, 400, JSON.stringify(body));
        }
        assert.deepEqual(supabase, []);
        assert.equal(store.size, 0);
    });

    it('asks Supabase first, creates the public bucket, then saves the key encrypted', async () => {
        const reply = await call('PUT', '/media-storage', { session: ADMIN, body: { url: `${PROJECT}/rest/v1/`, key: ` ${SECRET} ` } });

        assert.equal(reply.status, 200);
        // Read, create, then the card's own live status read of the bucket it now has.
        assert.deepEqual(supabase.map((c) => `${c.method} ${c.path}`), [
            'GET /storage/v1/bucket/media', 'POST /storage/v1/bucket', 'GET /storage/v1/bucket/media',
        ]);
        assert.equal(reply.body.connection.bucketExists, true);
        assert.deepEqual(JSON.parse(supabase[1]!.body!), { id: 'media', name: 'media', public: true });
        for (const c of supabase) {
            assert.equal(c.headers.apikey, SECRET);
            assert.equal(c.headers.authorization, undefined, 'a secret key is never a Bearer token');
        }

        assert.equal(store.get('storage.supabase_url')!.value, PROJECT, 'saved as the bare origin');
        const key = store.get('storage.supabase_service_key')!;
        assert.equal(key.is_secret, true);
        assert.match(key.value, /^enc:v1:/);
        assert.ok(!key.value.includes(SECRET));

        assert.ok(!JSON.stringify(reply.body).includes(SECRET), 'the response never carries the key');
        assert.equal(reply.body.backend, 'supabase');
        assert.equal(reply.body.key.kind, 'secret');

        const [row] = auditRows();
        assert.ok(row);
        assert.equal(row!.params[2], 'settings.media_storage_write');
        assert.ok(!JSON.stringify(row!.params).includes(SECRET));
        assert.match(String(row!.params[5]), /"fields":\["url","credential"\]/);
        assert.match(String(row!.params[5]), /"bucket_created":true/);
    });

    it('sends the legacy service_role key as a Bearer token too', async () => {
        bucket = 'exists';
        const key = legacy('service_role');
        const reply = await call('PUT', '/media-storage', { session: ADMIN, body: { url: PROJECT, key } });

        assert.equal(reply.status, 200);
        assert.equal(supabase[0]!.headers.apikey, key);
        assert.equal(supabase[0]!.headers.authorization, `Bearer ${key}`);
        assert.equal(reply.body.key.kind, 'legacy_jwt');
    });

    it('saves nothing when Supabase refuses the key (400) or cannot be reached (502)', async () => {
        for (const [state, status] of [['refused', 400], ['down', 502]] as const) {
            bucket = state;
            const reply = await call('PUT', '/media-storage', { session: ADMIN, body: { url: PROJECT, key: SECRET } });
            assert.equal(reply.status, status, state);
        }
        assert.equal(store.size, 0);
        assert.deepEqual(auditRows(), []);
    });

    it('keeps the saved key when the form leaves it blank', async () => {
        bucket = 'exists';
        await call('PUT', '/media-storage', { session: ADMIN, body: { url: PROJECT, key: SECRET } });
        const savedKey = store.get('storage.supabase_service_key')!.value;
        supabase = [];

        const reply = await call('PUT', '/media-storage', { session: ADMIN, body: { url: 'https://efgh5678.supabase.co' } });

        assert.equal(reply.status, 200);
        assert.equal(supabase[0]!.headers.apikey, SECRET, 'checked with the saved key');
        assert.equal(store.get('storage.supabase_service_key')!.value, savedKey, 'and left as it was');
        assert.equal(store.get('storage.supabase_url')!.value, 'https://efgh5678.supabase.co');
    });

    it('reports status without the key, and the environment fallback as present only', async () => {
        process.env.SUPABASE_URL = PROJECT;
        process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
        bucket = 'exists';

        const reply = await call('GET', '/media-storage', { session: ADMIN });

        assert.equal(reply.status, 200);
        assert.equal(reply.body.backend, 'supabase');
        assert.deepEqual(reply.body.env, { url: true, key: true });
        assert.equal(reply.body.key.source, 'env');
        assert.equal(reply.body.key.preview, null, 'an env key is never previewed');
        assert.equal(reply.body.connection.ok, true);
        assert.ok(!JSON.stringify(reply.body).includes(SECRET));
    });

    it('will not remove the config while Storage holds files nothing else could read', async () => {
        bucket = 'exists';
        await call('PUT', '/media-storage', { session: ADMIN, body: { url: PROJECT, key: SECRET } });
        storedFiles = 4;

        const refused = await call('DELETE', '/media-storage', { session: ADMIN });
        assert.equal(refused.status, 409);
        assert.match(refused.body.error, /4 file\(s\) are in Supabase Storage/);
        assert.ok(store.has('storage.supabase_service_key'));

        storedFiles = 0;
        const removed = await call('DELETE', '/media-storage', { session: ADMIN });
        assert.equal(removed.status, 200);
        assert.equal(store.size, 0);
        assert.equal(removed.body.backend, 'postgres');
    });
});
