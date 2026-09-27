/**
 * GET/POST /api/settings/site — the public site's contact channels and Eid expiry.
 *
 * Run through the route's WHOLE stack (guard, then handler) with `pool.query` stubbed, because
 * the guard is the point: these values print on the public site for everyone, so a tenant
 * owner must get the same 404 a stranger would, and only a platform admin may write them.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { DEFAULT_CONTACT_EMAIL } from '../services/appSettings.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

/** Every handler mounted on `method path`, in order, guard first. */
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

/**
 * Run every guard in order and, if all pass, the handler. `tenantRole` is what resolveTenant
 * would have set: a platform admin always acts as owner.
 */
async function run(method: 'get' | 'post', session: Record<string, unknown>, body: Record<string, unknown> = {}) {
    const res = fakeRes();
    const handles = stackFor(method, '/settings/site');
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
        // SELECT only: the DELETE below also contains `FROM app_settings WHERE key = $1`.
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
    for (const k of ['SITE_WHATSAPP_NUMBER', 'SITE_CONTACT_EMAIL', 'SITE_EID_COUPONS_EXPIRE']) delete process.env[k];
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    restoreSink?.();
});

describe('/settings/site — who may see and change it', () => {
    it('404s a tenant owner on both verbs, touching nothing', async () => {
        for (const method of ['get', 'post'] as const) {
            const res = await run(method, OWNER, { contactEmail: 'x@example.com' });
            assert.equal(res.statusCode, 404, method);
        }
        assert.equal(writes.length, 0);
    });

    it('checks the platform-admin guard FIRST, so an operator gets the same 404, not a 403', async () => {
        const res = await run('post', { userId: 'u-op', role: 'user', tenantId: 't-1' }, { contactEmail: 'x@example.com' });
        assert.equal(res.statusCode, 404);
        const guards = stackFor('post', '/settings/site') as Array<{ minimumRole?: string }>;
        assert.equal(guards[0]!.minimumRole, undefined, 'requirePlatformAdmin runs first');
        assert.equal(guards[1]!.minimumRole, 'owner', 'then canAdminister, which api.test.ts requires of every write');
    });

    it('404s a session with no role at all', async () => {
        const res = await run('get', {});
        assert.equal(res.statusCode, 404);
    });
});

describe('GET /settings/site', () => {
    it('reports each value with its source and the wa.me link the pages will print', async () => {
        saved['site.whatsapp_number'] = '966501234567';
        process.env.SITE_CONTACT_EMAIL = 'env@example.com';
        const res = await run('get', ADMIN);

        assert.equal(res.statusCode, 200);
        assert.equal(res.body.whatsappNumber, '966501234567');
        assert.equal(res.body.contactEmail, 'env@example.com');
        assert.equal(res.body.eidCouponsExpire, null);
        assert.deepEqual(res.body.source, { whatsappNumber: 'database', contactEmail: 'env', eidCouponsExpire: null });
        assert.ok(String(res.body.whatsappUrl).startsWith('https://wa.me/966501234567?text='));
    });
});

describe('POST /settings/site', () => {
    it('saves each value normalised, and answers with the new state', async () => {
        const res = await run('post', ADMIN, {
            whatsappNumber: '+966 50 123 4567', contactEmail: ' Hello@Example.com ', eidCouponsExpire: '2026-04-05',
        });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(writes, [
            { key: 'site.whatsapp_number', value: '966501234567' },
            { key: 'site.contact_email', value: 'Hello@Example.com' },
            { key: 'site.eid_coupons_expire', value: '2026-04-05' },
        ]);
        assert.equal(res.body.whatsappNumber, '966501234567');
        assert.equal(res.body.source.contactEmail, 'database');
    });

    it('leaves out a field that was not sent, and clears one sent empty', async () => {
        saved['site.whatsapp_number'] = '966501234567';
        saved['site.contact_email'] = 'old@example.com';
        const res = await run('post', ADMIN, { contactEmail: '' });

        assert.equal(res.statusCode, 200);
        assert.deepEqual(writes, [{ key: 'site.contact_email', value: null }]);
        assert.equal(res.body.whatsappNumber, '966501234567', 'untouched');
        // Cleared, so the pages fall back — to the default address, never to no address.
        assert.equal(res.body.contactEmail, DEFAULT_CONTACT_EMAIL);
        assert.equal(res.body.source.contactEmail, 'default');
    });

    it('writes nothing at all when a later field is refused, so nothing is half-saved', async () => {
        const res = await run('post', ADMIN, { whatsappNumber: '966501234567', contactEmail: 'not an email' });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.field, 'contactEmail', 'names the input to mark');
        assert.equal(writes.length, 0);
    });

    it('refuses a bad value with a plain 400 and writes nothing', async () => {
        for (const [body, needle] of [
            [{ whatsappNumber: '0501234567' }, /WhatsApp number/],
            [{ whatsappNumber: '+966' }, /WhatsApp number/],
            [{ contactEmail: 'not an email' }, /email/],
            [{ eidCouponsExpire: '05/04/2026' }, /YYYY-MM-DD/],
            [{ eidCouponsExpire: '2026-02-30' }, /YYYY-MM-DD/],
        ] as const) {
            const res = await run('post', ADMIN, body as Record<string, unknown>);
            assert.equal(res.statusCode, 400, JSON.stringify(body));
            assert.match(String(res.body.error), needle);
            assert.equal(res.body.field, Object.keys(body)[0]);
        }
        assert.equal(writes.length, 0);
    });

    it('400s an empty body rather than pretending to have saved', async () => {
        const res = await run('post', ADMIN, {});
        assert.equal(res.statusCode, 400);
        assert.equal(writes.length, 0);
    });
});
