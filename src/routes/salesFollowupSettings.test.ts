/**
 * GET/POST /api/settings/sales-followup: the operator's follow-up delay (`dm.sales.followup_minutes`, DM plan S9).
 *
 * Run through the route's WHOLE stack (guard, then handler) with `pool.query` stubbed, as `siteSettings.test.ts` does, because the guard is the
 * point: one value for the whole deployment, so a tenant owner gets the 404 a stranger would, and only a platform admin writes it. What is pinned:
 * a number in range is saved as typed, empty goes back to the default (the row is deleted, so four hours answers again), a typo is a 400 that
 * names the range and writes nothing, and 0 (follow-ups off) is a real value, not "unset".
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

const PATH = '/settings/sales-followup';
const KEY = 'dm.sales.followup_minutes';

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
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

async function run(method: 'get' | 'post', session: Record<string, unknown>, body: Record<string, unknown> = {}) {
    const res = fakeRes();
    const handles = stackFor(method, PATH);
    assert.equal(handles.length, method === 'post' ? 3 : 2, 'the platform-admin guard (and, to write, the owner guard), then the handler');
    const req = { session, body, params: {}, tenantRole: session.role === 'platform_admin' ? 'owner' : 'operator' };
    for (const handle of handles) {
        let passed = false;
        await handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

const ADMIN = { userId: 'u-admin', role: 'platform_admin', tenantId: 't-1' };
const OWNER = { userId: 'u-owner', role: 'user', tenantId: 't-1' };

let restoreSink: (() => void) | undefined;
let originalQuery: typeof pool.query;
let saved: Record<string, string>;
let writes: Array<{ key: string; value: string | null }>;

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    originalQuery = pool.query;
    saved = {};
    writes = [];
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        if (/^\s*SELECT\b[\s\S]*FROM app_settings WHERE key = \$1/.test(sql)) {
            const key = String(params[0]);
            return key in saved ? { rows: [{ value: saved[key], is_secret: false }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO app_settings/.test(sql)) {
            saved[String(params[0])] = String(params[1]);
            writes.push({ key: String(params[0]), value: String(params[1]) });
            return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM app_settings WHERE key = \$1/.test(sql)) {
            delete saved[String(params[0])];
            writes.push({ key: String(params[0]), value: null });
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    restoreSink?.();
});

describe('/settings/sales-followup: who may see and change it', () => {
    it('404s a tenant owner on both verbs, touching nothing', async () => {
        for (const method of ['get', 'post'] as const) {
            const res = await run(method, OWNER, { minutes: 10 });
            assert.equal(res.statusCode, 404, method);
        }
        assert.equal(writes.length, 0);
    });

    it('checks the platform-admin guard FIRST, so an operator gets the same 404, not a 403, and the write carries the owner guard api.test.ts requires', async () => {
        const res = await run('post', { userId: 'u-op', role: 'user', tenantId: 't-1' }, { minutes: 10 });
        assert.equal(res.statusCode, 404);
        const guards = stackFor('post', PATH) as Array<{ minimumRole?: string }>;
        assert.equal(guards[0]!.minimumRole, undefined);
        assert.equal(guards[1]!.minimumRole, 'owner');
    });

    it('404s a session with no role at all', async () => {
        assert.equal((await run('get', {})).statusCode, 404);
    });
});

describe('GET /settings/sales-followup', () => {
    it('is four hours when nothing is saved, with the range the screen shows', async () => {
        const res = await run('get', ADMIN);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { minutes: 240, defaultMinutes: 240, min: 0, max: 1320 });
    });

    it('is the saved number, and 0 is a number', async () => {
        saved[KEY] = '10';
        assert.equal((await run('get', ADMIN)).body.minutes, 10);
        saved[KEY] = '0';
        assert.equal((await run('get', ADMIN)).body.minutes, 0);
    });

    it('answers a saved value it cannot read with the default, as the job does', async () => {
        saved[KEY] = 'four hours';
        assert.equal((await run('get', ADMIN)).body.minutes, 240);
    });
});

describe('POST /settings/sales-followup', () => {
    it('saves a number in range, and answers with the new state', async () => {
        const res = await run('post', ADMIN, { minutes: 10 });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(writes, [{ key: KEY, value: '10' }]);
        assert.equal(res.body.minutes, 10);
        assert.equal((await run('post', ADMIN, { minutes: '90' })).body.minutes, 90, 'text from a form works too');
    });

    it('saves 0: follow-ups off is a value, not "unset"', async () => {
        const res = await run('post', ADMIN, { minutes: 0 });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(writes, [{ key: KEY, value: '0' }]);
        assert.equal(res.body.minutes, 0);
    });

    it('goes back to the default when sent empty or null: the row is removed', async () => {
        saved[KEY] = '10';
        for (const minutes of ['', '  ', null]) {
            saved[KEY] = '10';
            writes.length = 0;
            const res = await run('post', ADMIN, { minutes });
            assert.equal(res.statusCode, 200, JSON.stringify(minutes));
            assert.deepEqual(writes, [{ key: KEY, value: null }]);
            assert.equal(res.body.minutes, 240);
        }
    });

    it('refuses anything that is not a whole number of minutes in range with a 400 that names the range and the field, writing nothing', async () => {
        for (const minutes of ['soon', 1321, -1, 2.5, '4 hours', 99999, true, [], {}]) {
            const res = await run('post', ADMIN, { minutes: minutes as any });
            assert.equal(res.statusCode, 400, JSON.stringify(minutes));
            assert.match(String(res.body.error), /whole number of minutes, 0 to 1320/);
            assert.equal(res.body.field, 'minutes');
        }
        assert.equal(writes.length, 0);
    });

    it('400s a body with no `minutes` rather than pretending to have saved', async () => {
        const res = await run('post', ADMIN, {});
        assert.equal(res.statusCode, 400);
        assert.equal(writes.length, 0);
    });
});
