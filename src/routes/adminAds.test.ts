/**
 * Phase A11, managed clients (tasks T188, T192): the platform admin's overview `GET /api/admin/ads/tenants` and the client's
 * share-spend switch. Driven through the real routers (the admin gate included) against a fake pool.
 *
 *   - the overview lists health and cap use as a percentage for every tenant
 *   - spend (and the monthly cap, which with the percentage IS the spend) only when the tenant shares it
 *   - platform admin only (everyone else gets the admin router's 404)
 *   - the switch: any member reads it, only the owner changes it, the change is audited
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response, Router } from 'express';
import { pool } from '../config/db.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { accountDays, capUsePercent } from '../services/ads/tenantsOverview.js';
import adminRouter from './admin.js';
import { adsShareSpendRouter } from './adsShareSpend.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const SHARES = '22222222-2222-4222-8222-222222222222';
const PRIVATE = '33333333-3333-4333-8333-333333333333';
const IDLE = '44444444-4444-4444-8444-444444444444';

const health = (over: Record<string, unknown> = {}) => JSON.stringify({
    account: { name: 'Acc', currency: 'SAR', timezone: 'Asia/Dubai', timezoneOffsetHours: 3, status: 1, statusLabel: 'active', hasPaymentMethod: true },
    token: { health: 'ok', checkedAt: '2026-10-22T08:00:00.000Z', scopes: [], missingScopes: [] },
    checkedAt: '2026-10-22T08:00:00.000Z',
    ...over,
});
const settings = (acc: string, daily: number, cap: number) => JSON.stringify({ adAccountId: acc, maxDailyBudget: daily, monthlyCap: cap, tokenSource: 'pasted' });

let settingsRows: Array<{ key: string; value: string | null; is_secret: boolean }>;
let statements: Array<{ sql: string; params: any[] }>;
let signoffTable: boolean;

function installPool(): () => void {
    const original = pool.query;
    (pool as any).query = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        if (/^SELECT id, name FROM creators ORDER BY name/.test(flat)) {
            return { rows: [{ id: OWNER, name: 'Owner' }, { id: SHARES, name: 'Sharing client' }, { id: PRIVATE, name: 'Private client' }, { id: IDLE, name: 'Idle' }] };
        }
        if (/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1/.test(flat)) return { rows: [{ id: OWNER }] };
        if (/FROM app_settings WHERE key LIKE 'ads\.%'/.test(flat)) return { rows: settingsRows };
        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1/.test(flat)) {
            const row = settingsRows.find((r) => r.key === params[0]);
            return { rows: row ? [{ value: row.value, is_secret: false }] : [] };
        }
        if (/^INSERT INTO app_settings/.test(flat)) {
            settingsRows = settingsRows.filter((r) => r.key !== params[0]).concat({ key: params[0], value: params[1], is_secret: false });
            return { rows: [], rowCount: 1 };
        }
        if (/^DELETE FROM app_settings WHERE key = \$1/.test(flat)) {
            settingsRows = settingsRows.filter((r) => r.key !== params[0]);
            return { rows: [], rowCount: 1 };
        }
        if (/FROM ads_alerts/.test(flat)) {
            return { rows: [{ creator_id: PRIVATE, kind: 'token_dead', count: 2, last_at: new Date('2026-10-21T10:00:00Z') }, { creator_id: PRIVATE, kind: 'payment', count: 1, last_at: new Date('2026-10-20T10:00:00Z') }] };
        }
        if (/to_regclass\('public\.ads_legal_signoffs'\)/.test(flat)) return { rows: [{ present: signoffTable }] };
        if (/FROM ads_legal_signoffs/.test(flat)) {
            return { rows: [{ id: 's-1', creator_id: SHARES, scope: 'customer_lists', countries: ['SA'], note: 'ok', recorded_at: new Date('2026-10-01T00:00:00Z') }] };
        }
        if (/FROM unnest\(.*ads_insights_daily/.test(flat)) {
            return { rows: [{ creator_id: SHARES, month: '250.00', today: '12.50' }, { creator_id: PRIVATE, month: '900.00', today: '40.00' }] };
        }
        if (/^INSERT INTO audit_log/.test(flat)) return { rows: [{ id: 'audit-1' }], rowCount: 1 };
        if (/FROM memberships|FROM users/.test(flat)) return { rows: [] };
        throw new Error(`unexpected SQL: ${flat}`);
    };
    return () => { (pool as any).query = original; };
}

interface Reply { status: number; body: any; fellThrough?: boolean }

function call(router: Router, method: string, url: string, opts: { session?: unknown; body?: unknown; tenantRole?: string } = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const req = {
            method, url, originalUrl: url, body: opts.body ?? {}, query: {}, params: {}, headers: {}, session: opts.session, tenantRole: opts.tenantRole,
        } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(body: unknown) { resolve({ status: (this as any).statusCode, body }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        router(req, res, () => resolve({ status: 0, body: null, fellThrough: true }));
    });
}

const ADMIN = { userId: null, role: 'platform_admin', tenantId: OWNER, tokenVersion: 0 };
const NOT_ADMIN = { userId: 'u-1', role: 'user', tenantId: SHARES, tokenVersion: 1 };

describe('GET /api/admin/ads/tenants', () => {
    let restore: () => void;
    beforeEach(() => {
        statements = [];
        signoffTable = false;
        invalidateTenantCache();
        settingsRows = [
            { key: `ads.enabled.${OWNER}`, value: 'true', is_secret: false },
            { key: `ads.settings.${OWNER}`, value: settings('509787248064459', 100, 3000), is_secret: false },
            { key: `ads.token.${OWNER}`, value: null, is_secret: true },
            { key: `ads.health.${OWNER}`, value: health(), is_secret: false },

            { key: `ads.enabled.${SHARES}`, value: 'true', is_secret: false },
            { key: `ads.ceiling.${SHARES}`, value: JSON.stringify({ maxDailyBudget: 50, monthlyCap: 1500 }), is_secret: false },
            { key: `ads.settings.${SHARES}`, value: settings('700000000000001', 40, 1000), is_secret: false },
            { key: `ads.token.${SHARES}`, value: null, is_secret: true },
            { key: `ads.health.${SHARES}`, value: health(), is_secret: false },
            { key: `ads.share_spend.${SHARES}`, value: 'true', is_secret: false },

            { key: `ads.enabled.${PRIVATE}`, value: 'true', is_secret: false },
            { key: `ads.ceiling.${PRIVATE}`, value: JSON.stringify({ maxDailyBudget: 50, monthlyCap: 1500 }), is_secret: false },
            { key: `ads.settings.${PRIVATE}`, value: settings('700000000000002', 45, 1200), is_secret: false },
            { key: `ads.token.${PRIVATE}`, value: null, is_secret: true },
            { key: `ads.health.${PRIVATE}`, value: health({ token: { health: 'dead', checkedAt: null, scopes: [], missingScopes: [] }, account: { currency: 'USD', timezoneOffsetHours: 0, statusLabel: 'unsettled', hasPaymentMethod: false } }), is_secret: false },
        ];
        restore = installPool();
    });
    afterEach(() => restore());

    const rows = async () => {
        const reply = await call(adminRouter, 'GET', '/ads/tenants', { session: ADMIN });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        return new Map((reply.body.tenants as any[]).map((t) => [t.tenantId, t]));
    };

    it('is for the platform admin only: everyone else gets the 404 every admin route gives', async () => {
        for (const session of [NOT_ADMIN, undefined]) {
            const reply = await call(adminRouter, 'GET', '/ads/tenants', { session });
            assert.equal(reply.status, 404);
            assert.deepEqual(reply.body, { error: 'Not found.' });
        }
        assert.equal(statements.length, 0, 'nothing is read for a refused caller');
    });

    it('lists every tenant with its switch, ceiling, health and cap use as a percentage', async () => {
        const t = await rows();
        assert.equal(t.size, 4);
        const shares = t.get(SHARES);
        assert.equal(shares.enabled, true);
        assert.equal(shares.configured, true);
        assert.deepEqual(shares.ceiling, { maxDailyBudget: 50, monthlyCap: 1500 });
        assert.equal(shares.tokenHealth, 'ok');
        assert.equal(shares.accountStatus, 'active');
        assert.equal(shares.paymentMethod, true);
        assert.equal(shares.capUsePct, 25);

        const priv = t.get(PRIVATE);
        assert.equal(priv.capUsePct, 75, 'the percentage shows even when spend is not shared');
        assert.equal(priv.tokenHealth, 'dead');
        assert.equal(priv.accountStatus, 'unsettled');
        assert.equal(priv.paymentMethod, false);

        const idle = t.get(IDLE);
        assert.equal(idle.enabled, false);
        assert.equal(idle.configured, false);
        assert.equal(idle.tokenHealth, 'none');
        assert.equal(idle.capUsePct, null, 'unknown, not zero');

        assert.equal(t.get(OWNER).isPlatformOwner, true);
        assert.equal(shares.isPlatformOwner, false);
    });

    it('lists the open alerts of the last 7 days per tenant', async () => {
        const t = await rows();
        assert.deepEqual(t.get(PRIVATE).openAlerts.map((a: any) => [a.kind, a.count]), [['token_dead', 2], ['payment', 1]]);
        assert.deepEqual(t.get(SHARES).openAlerts, []);
        const alertSql = statements.find((s) => /FROM ads_alerts/.test(s.sql))!;
        assert.equal(alertSql.params[0], 7);
    });

    it('shows spend only for a tenant that shares it, and then no monthly cap anywhere for the others', async () => {
        const t = await rows();
        assert.deepEqual(t.get(SHARES).spend, { currency: 'SAR', spentThisMonth: 250, spentToday: 12.5, monthlyCap: 1000, maxDailyBudget: 40 });
        for (const id of [PRIVATE, IDLE, OWNER]) {
            const row = t.get(id);
            assert.equal('spend' in row, false, id);
            assert.equal(row.shareSpend, false);
            // The ceiling is the admin's own number; the tenant's own cap (which with the percentage gives the spend) must not appear.
            const text = JSON.stringify(row);
            if (id === PRIVATE) {
                assert.equal(text.includes('1200'), false, 'the private monthly cap');
                assert.equal(text.includes('900'), false, 'the private spend');
            }
        }
    });

    it('never reads a token value: secret rows are selected as NULL', async () => {
        await rows();
        const sql = statements.find((s) => /FROM app_settings WHERE key LIKE/.test(s.sql))!.sql;
        assert.match(sql, /CASE WHEN is_secret THEN NULL ELSE value END/);
    });

    it("reads spend in each account's own month and time zone", async () => {
        await rows();
        const q = statements.find((s) => /ads_insights_daily/.test(s.sql))!;
        const [ids, accounts, todays, starts] = q.params as [string[], string[], string[], string[]];
        assert.deepEqual(ids, [OWNER, SHARES, PRIVATE]);
        assert.deepEqual(accounts, ['509787248064459', '700000000000001', '700000000000002']);
        assert.equal(todays.length, 3);
        assert.ok(starts.every((d) => d.endsWith('-01')));
    });

    it('says sign-offs are not there yet until A8 adds the table, then lists the live ones', async () => {
        assert.equal((await rows()).get(SHARES).signoffs, null);
        signoffTable = true;
        const t = await rows();
        assert.deepEqual(t.get(SHARES).signoffs, [{ id: 's-1', scope: 'customer_lists', countries: ['SA'], note: 'ok', recordedAt: '2026-10-01T00:00:00.000Z' }]);
        assert.deepEqual(t.get(PRIVATE).signoffs, []);
    });
});

describe('the overview math', () => {
    it('rounds cap use to a whole percentage and keeps unknown as null', () => {
        assert.equal(capUsePercent(250, 1000), 25);
        assert.equal(capUsePercent(1001, 1000), 100);
        assert.equal(capUsePercent(1500, 1000), 150);
        assert.equal(capUsePercent(0, 1000), 0);
        assert.equal(capUsePercent(null, 1000), null);
        assert.equal(capUsePercent(10, null), null);
        assert.equal(capUsePercent(10, 0), null);
    });

    it("counts the month in the ad account's time zone", () => {
        // 22:30 UTC on 31 Oct is already 1 Nov in Riyadh (+3).
        assert.deepEqual(accountDays(new Date('2026-10-31T22:30:00Z'), 3), { today: '2026-11-01', monthStart: '2026-11-01' });
        assert.deepEqual(accountDays(new Date('2026-10-31T22:30:00Z'), 0), { today: '2026-10-31', monthStart: '2026-10-01' });
        assert.deepEqual(accountDays(new Date('2026-11-01T03:00:00Z'), -8), { today: '2026-10-31', monthStart: '2026-10-01' });
    });
});

describe('/api/ads/settings/share-spend', () => {
    let restore: () => void;
    const session = (tenantId: string) => ({ userId: 'u-9', role: 'user', tenantId, tokenVersion: 1 });
    beforeEach(() => {
        statements = [];
        invalidateTenantCache();
        settingsRows = [{ key: `ads.ceiling.${SHARES}`, value: JSON.stringify({ maxDailyBudget: 50, monthlyCap: 1500 }), is_secret: false }];
        restore = installPool();
    });
    afterEach(() => restore());

    it('is off by default and shows a managed client its ceiling', async () => {
        const reply = await call(adsShareSpendRouter, 'GET', '/settings/share-spend', { session: session(SHARES), tenantRole: 'viewer' });
        assert.deepEqual(reply.body, { shareSpend: false, ceiling: { maxDailyBudget: 50, monthlyCap: 1500 }, managed: true });
    });

    it("tells the platform owner's own tenant it is not managed", async () => {
        const reply = await call(adsShareSpendRouter, 'GET', '/settings/share-spend', { session: session(OWNER), tenantRole: 'owner' });
        assert.deepEqual(reply.body, { shareSpend: false, ceiling: null, managed: false });
    });

    it('lets the owner turn it on and off, audited each time', async () => {
        const on = await call(adsShareSpendRouter, 'POST', '/settings/share-spend', { session: session(SHARES), tenantRole: 'owner', body: { on: true } });
        assert.equal(on.status, 200);
        assert.equal(on.body.shareSpend, true);
        assert.ok(settingsRows.some((r) => r.key === `ads.share_spend.${SHARES}` && r.value === 'true'));
        const off = await call(adsShareSpendRouter, 'POST', '/settings/share-spend', { session: session(SHARES), tenantRole: 'owner', body: { on: false } });
        assert.equal(off.body.shareSpend, false);
        assert.equal(settingsRows.some((r) => r.key === `ads.share_spend.${SHARES}`), false, 'off deletes the row');
        const audits = statements.filter((s) => s.sql.startsWith('INSERT INTO audit_log'));
        assert.deepEqual(audits.map((a) => [a.params[2], a.params[4], JSON.parse(a.params[5]).on]), [
            ['ads.share_spend_changed', SHARES, true],
            ['ads.share_spend_changed', SHARES, false],
        ]);
    });

    it('refuses a member who is not the owner, and a body that is not a boolean', async () => {
        const viewer = await call(adsShareSpendRouter, 'POST', '/settings/share-spend', { session: session(SHARES), tenantRole: 'viewer', body: { on: true } });
        assert.equal(viewer.status, 403);
        const bad = await call(adsShareSpendRouter, 'POST', '/settings/share-spend', { session: session(SHARES), tenantRole: 'owner', body: { on: 'yes' } });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.code, 'INVALID');
        assert.equal(settingsRows.some((r) => r.key.startsWith('ads.share_spend.')), false);
    });
});
