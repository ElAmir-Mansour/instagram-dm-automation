/**
 * The platform admin's ads switch and ceiling (tasks T019a): `POST /api/admin/ads/tenants/:id/enabled` and `/ceiling`. No managed client
 * can be switched on without a ceiling, a tenant owner's limits may not exceed it (routes/ads.test.ts covers OVER_CEILING), the platform
 * owner's own tenant needs none, and both are platform admin only.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from '../services/monteur/testDb.js';
import adminRouter from './admin.js';

const OWNER_TENANT = '99999999-9999-4999-8999-999999999999';
const CLIENT = '11111111-1111-4111-8111-111111111111';

async function call(method: string, url: string, opts: { role?: string; body?: unknown } = {}): Promise<{ statusCode: number; body: any }> {
    return new Promise((resolve, reject) => {
        const res = {
            statusCode: 200,
            body: undefined as any,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: unknown) { this.body = payload; resolve(this); return this; },
            setHeader() {},
            getHeader() { return undefined; },
        };
        const req = { method, url, originalUrl: `/api/admin${url}`, baseUrl: '', headers: {}, params: {}, query: {}, body: opts.body ?? {}, session: { userId: 'u-admin', role: opts.role ?? 'platform_admin', tenantId: OWNER_TENANT } };
        (adminRouter as any)(req, res, (err?: unknown) => (err ? reject(err) : resolve({ statusCode: 404, body: { error: 'no route' } })));
    });
}

describe('/api/admin/ads/tenants/:id', () => {
    let db: FakeDb;
    let settings: Map<string, string>;
    let audits: any[][];

    beforeEach(() => {
        db = installFakeDb({ platformTenant: OWNER_TENANT });
        settings = new Map();
        audits = [];
        db.routes.push(
            [/^SELECT id FROM creators WHERE id = \$1$/, (p) => ({ rows: [OWNER_TENANT, CLIENT].includes(p[0]) ? [{ id: p[0] }] : [] })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: settings.has(p[0]) ? [{ value: settings.get(p[0]), is_secret: false }] : [] })],
            [/^INSERT INTO app_settings/, (p) => { settings.set(p[0], p[1]); return { rows: [] }; }],
            [/^DELETE FROM app_settings WHERE key = \$1/, (p) => { settings.delete(p[0]); return { rows: [] }; }],
            [/^SELECT email FROM users/, () => ({ rows: [{ email: 'admin@example.com' }] })],
            [/^INSERT INTO audit_log/, (p) => { audits.push(p); return { rows: [{ id: 'a' }] }; }],
        );
    });
    afterEach(() => db.restore());

    it('refuses to switch a managed client on before it has a ceiling', async () => {
        const res = await call('POST', `/ads/tenants/${CLIENT}/enabled`, { body: { enabled: true } });
        assert.deepEqual({ status: res.statusCode, code: res.body.code }, { status: 409, code: 'CEILING_REQUIRED' });
        assert.equal(settings.has(`ads.enabled.${CLIENT}`), false);
    });

    it('sets a ceiling, then switches the client on, and audits both', async () => {
        const c = await call('POST', `/ads/tenants/${CLIENT}/ceiling`, { body: { maxDailyBudget: 20, monthlyCap: 300 } });
        assert.equal(c.statusCode, 200);
        assert.deepEqual(c.body.ceiling, { maxDailyBudget: 20, monthlyCap: 300 });
        const e = await call('POST', `/ads/tenants/${CLIENT}/enabled`, { body: { enabled: true } });
        assert.deepEqual({ status: e.statusCode, body: e.body }, { status: 200, body: { enabled: true } });
        assert.equal(settings.get(`ads.enabled.${CLIENT}`), 'true');
        assert.deepEqual(audits.map((a) => a[2]), ['ads.ceiling_changed', 'ads.enabled_changed']);
    });

    it('the platform owner\'s own tenant needs no ceiling', async () => {
        const res = await call('POST', `/ads/tenants/${OWNER_TENANT}/enabled`, { body: { enabled: true } });
        assert.equal(res.statusCode, 200);
    });

    it('switching off removes the switch (every ads route then answers 404)', async () => {
        settings.set(`ads.enabled.${CLIENT}`, 'true');
        const res = await call('POST', `/ads/tenants/${CLIENT}/enabled`, { body: { enabled: false } });
        assert.equal(res.statusCode, 200);
        assert.equal(settings.has(`ads.enabled.${CLIENT}`), false);
    });

    it('refuses a bad ceiling, a bad switch and an unknown tenant', async () => {
        for (const body of [{ maxDailyBudget: 0, monthlyCap: 10 }, { maxDailyBudget: 50, monthlyCap: 10 }, { maxDailyBudget: 'x' }, {}]) {
            const res = await call('POST', `/ads/tenants/${CLIENT}/ceiling`, { body });
            assert.equal(res.statusCode, 400, JSON.stringify(body));
        }
        assert.equal((await call('POST', `/ads/tenants/${CLIENT}/enabled`, { body: { enabled: 'yes' } })).statusCode, 400);
        assert.equal((await call('POST', '/ads/tenants/22222222-2222-4222-8222-222222222222/enabled', { body: { enabled: true } })).statusCode, 404);
        assert.equal((await call('POST', '/ads/tenants/not-a-uuid/ceiling', { body: { maxDailyBudget: 1, monthlyCap: 2 } })).statusCode, 404);
    });

    it('is the platform admin\'s only', async () => {
        const res = await call('POST', `/ads/tenants/${CLIENT}/ceiling`, { role: 'user', body: { maxDailyBudget: 20, monthlyCap: 300 } });
        assert.ok(res.statusCode === 403 || res.statusCode === 404, String(res.statusCode));
        assert.equal(settings.size, 0);
    });
});
