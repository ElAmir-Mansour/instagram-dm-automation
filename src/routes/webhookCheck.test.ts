/**
 * POST /api/settings/webhook-token/check — the handshake Meta performs, performed by us.
 * (A POST: it sends a request out with the tenant's secret, so it is an action, not a read.)
 *
 * The route makes one outbound GET to the app's own public base URL. `metaHttp.get` is
 * stubbed so no request leaves the process, and every branch the dashboard translates
 * (`reason`) is pinned — along with the one rule that matters most: the response never
 * carries the verify token, whatever happened.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'my_webhook_secret_2026';
const BASE = 'https://msg-response-auto.vercel.app';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

function stackFor(method: string, path: string): Handle[] {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}

type Answer = { status: number; data: unknown } | Error;

let restoreSink: (() => void) | undefined;
let originalQuery: typeof pool.query;
let originalGet: typeof metaHttp.get;
let stored: { token: string | null; baseUrl: string | null };
let calls: Array<{ url: string; config: any }>;
let answer: (challenge: string) => Answer;

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    originalQuery = pool.query;
    originalGet = metaHttp.get;
    stored = { token: TOKEN, baseUrl: BASE };
    calls = [];
    answer = (challenge) => ({ status: 200, data: challenge });
    invalidateTenantCache();
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        if (/SELECT webhook_verify_token FROM creators WHERE id = \$1/.test(sql)) {
            return { rows: [{ webhook_verify_token: stored.token }], rowCount: 1 };
        }
        if (/FROM app_settings WHERE key = \$1/.test(sql)) {
            if (params[0] === 'app.public_base_url' && stored.baseUrl) {
                return { rows: [{ value: stored.baseUrl, is_secret: false }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    (metaHttp as any).get = async (url: string, config: any) => {
        calls.push({ url, config });
        const a = answer(config.params['hub.challenge']);
        if (a instanceof Error) throw a;
        return a;
    };
    delete process.env.PUBLIC_BASE_URL;
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originalGet;
    invalidateTenantCache();
    restoreSink?.();
});

async function check() {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
    const handles = stackFor('post', '/settings/webhook-token/check');
    const req = {
        session: { userId: 'u-1', role: 'user', tenantId: TENANT },
        headers: { 'x-forwarded-proto': 'https' },
        protocol: 'https',
        get: (name: string) => (name.toLowerCase() === 'host' ? 'preview-deploy.vercel.app' : undefined),
        params: {}, body: {},
    };
    await handles[handles.length - 1]!(req, res, () => {});
    return res;
}

describe('POST /settings/webhook-token/check', () => {
    it('is owner-gated: a guard runs before the handler', () => {
        const handles = stackFor('post', '/settings/webhook-token/check') as Array<{ minimumRole?: string }>;
        assert.equal(handles.length, 2);
        assert.equal(handles[0]!.minimumRole, 'owner');
    });

    it('performs Meta\'s handshake against the PUBLIC base URL with a fresh challenge', async () => {
        const res = await check();

        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, `${BASE}/webhook`, 'the saved public address, not the request host');
        const params = calls[0]!.config.params;
        assert.equal(params['hub.mode'], 'subscribe');
        assert.equal(params['hub.verify_token'], TOKEN);
        assert.match(params['hub.challenge'], /^[0-9a-f]{24}$/);
        assert.equal(calls[0]!.config.timeout, 10_000);
        assert.deepEqual(res.body, {
            ok: true, reason: 'ok', status: 200, url: `${BASE}/webhook`,
            detail: 'The deployment answered the challenge with this token.',
        });
    });

    it('uses a different challenge every time', async () => {
        await check();
        await check();
        assert.notEqual(calls[0]!.config.params['hub.challenge'], calls[1]!.config.params['hub.challenge']);
    });

    it('reports a 403 as the deployment holding a different token', async () => {
        answer = () => ({ status: 403, data: 'Forbidden' });
        const res = await check();
        assert.equal(res.body.ok, false);
        assert.equal(res.body.reason, 'rejected');
        assert.equal(res.body.status, 403);
    });

    it('reports a 200 that is not the challenge as something else answering that address', async () => {
        answer = () => ({ status: 200, data: '<html>parked domain</html>' });
        const res = await check();
        assert.equal(res.body.reason, 'mismatch');
    });

    it('reports any other status as unexpected, with the number', async () => {
        answer = () => ({ status: 503, data: '' });
        const res = await check();
        assert.equal(res.body.reason, 'unexpected');
        assert.equal(res.body.status, 503);
        assert.match(res.body.detail, /503/);
    });

    it('reports a network failure as unreachable, as a 200 with ok:false rather than a 500', async () => {
        answer = () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
        const res = await check();
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.reason, 'unreachable');
        assert.match(res.body.detail, /ECONNABORTED/);
    });

    it('says so without calling out when no token is saved', async () => {
        stored.token = null;
        const res = await check();
        assert.equal(calls.length, 0);
        assert.equal(res.body.reason, 'no_token');
    });

    it('falls back to the request origin when no public base URL is saved', async () => {
        stored.baseUrl = null;
        const res = await check();
        assert.equal(calls[0]!.url, 'https://preview-deploy.vercel.app/webhook');
        assert.equal(res.body.ok, true);
    });

    it('never puts the token in the response, whichever branch answers', async () => {
        for (const a of [
            () => ({ status: 200, data: 'x' }),
            () => ({ status: 403, data: TOKEN }),
            () => new Error(`bad request with ${TOKEN}`),
        ] as Array<() => Answer>) {
            answer = a;
            const res = await check();
            assert.equal(JSON.stringify(res.body).includes(TOKEN), false, res.body.reason);
        }
    });
});
