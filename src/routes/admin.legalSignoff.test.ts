/**
 * `/api/admin/ads/tenants/:id/legal-signoff`: the platform admin unlocks customer lists and lead ads for a tenant (Ads A8, v56).
 *
 * Pinned: a non-admin gets the same 404 as every admin route (it learns nothing); an unknown or malformed tenant is 404; a bad body
 * is a 400 `{ error, code: 'INVALID', field }` and writes nothing; a good one is stored for the tenant in the PATH with the admin as
 * recorder and audited without the note's text; revoking is scoped to the tenant, audited once, and a second revoke is `{ revoked: false }`
 * with no second audit row.
 *
 * Driven through the router with a plain request object against the pool stand-in (`monteur/testDb.ts`), as adminCreateTenant.test.ts does.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { installFakeDb, type FakeDb } from '../services/monteur/testDb.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN_USER = '99999999-9999-4999-8999-999999999999';
const ADMIN = { userId: ADMIN_USER, role: 'platform_admin', tenantId: OTHER, tokenVersion: 0 };
const OWNER = { userId: ADMIN_USER, role: 'owner', tenantId: TENANT, tokenVersion: 0 };

interface Reply { status: number; body: any }

function call(method: string, url: string, body: unknown, session: typeof ADMIN | null = ADMIN): Promise<Reply> {
    return new Promise((resolve) => {
        const req = { method: method.toUpperCase(), url, originalUrl: url, body, query: {}, params: {}, headers: {}, session: session ?? undefined } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        adminRouter(req, res, () => resolve({ status: 0, body: null }));
    });
}

const base = (id = TENANT) => `/ads/tenants/${id}/legal-signoff`;
const good = { scope: 'customer_lists', countries: ['eg', 'sa'], note: 'Counsel opinion, filed under Legal/2026-10' };

let db: FakeDb;
let tenants: Set<string>;
let rows: Array<Record<string, any>>;
let audits: Array<{ action: string; targetId: string | null; detail: Record<string, any> }>;
let restoreSink: (() => void) | undefined;
let nextId: number;

beforeEach(() => {
    tenants = new Set([TENANT, OTHER]);
    rows = [];
    audits = [];
    nextId = 1;
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    db = installFakeDb();
    db.routes.push(
        [/^SELECT id FROM creators WHERE id = \$1$/, ([id]) => ({ rows: tenants.has(id) ? [{ id }] : [] })],
        [/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [{ email: 'operator@example.com' }] })],
        [/^INSERT INTO audit_log /, ([, , action, , targetId, detail]) => {
            audits.push({ action, targetId, detail: JSON.parse(detail) });
            return { rows: [{ id: 'audit-1' }] };
        }],
        [/^INSERT INTO ads_legal_signoffs /, ([creator, scope, countries, by, note]) => {
            const row = {
                id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, creator_id: creator, scope, countries, recorded_by: by,
                recorded_at: new Date('2026-10-22T10:00:00Z'), note, revoked_at: null,
            };
            rows.push(row);
            return { rows: [row] };
        }],
        [/^UPDATE ads_legal_signoffs SET revoked_at = NOW\(\)/, ([id, creator]) => {
            const hit = rows.filter((r) => r.id === id && r.creator_id === creator && r.revoked_at === null);
            for (const r of hit) r.revoked_at = new Date('2026-10-25T00:00:00Z');
            return { rows: [], rowCount: hit.length };
        }],
        [/^SELECT .* FROM ads_legal_signoffs WHERE creator_id = \$1 ORDER BY/, ([creator]) => ({ rows: rows.filter((r) => r.creator_id === creator) })],
    );
});

afterEach(() => {
    db.restore();
    restoreSink?.();
});

describe('who may call it', () => {
    it('answers 404 to a tenant owner and to no session, for every method, and touches nothing', async () => {
        for (const session of [OWNER, null]) {
            for (const [method, url, body] of [['GET', base(), undefined], ['POST', base(), good], ['DELETE', `${base()}/${TENANT}`, undefined]] as const) {
                const reply = await call(method, url, body, session as any);
                assert.equal(reply.status, 404, `${method} as ${session?.role ?? 'nobody'}`);
                assert.deepEqual(reply.body, { error: 'Not found.' });
            }
        }
        assert.equal(db.ran(/ads_legal_signoffs/).length, 0);
        assert.equal(audits.length, 0);
    });

    it('answers 404 for a tenant that does not exist or an id that is not a uuid, on all three routes', async () => {
        const missing = '33333333-3333-4333-8333-333333333333';
        for (const id of [missing, 'nope']) {
            assert.equal((await call('POST', base(id), good)).status, 404);
            assert.equal((await call('GET', base(id), undefined)).status, 404);
            assert.equal((await call('DELETE', `${base(id)}/${TENANT}`, undefined)).status, 404);
        }
        assert.equal(rows.length, 0);
        assert.equal(audits.length, 0);
    });
});

describe('POST: recording a sign-off', () => {
    it('stores it for the tenant in the path, recorded by the admin, countries upper-cased', async () => {
        const reply = await call('POST', base(), good);
        assert.equal(reply.status, 201);
        assert.equal(reply.body.signoff.creatorId, TENANT);
        assert.equal(reply.body.signoff.scope, 'customer_lists');
        assert.deepEqual(reply.body.signoff.countries, ['EG', 'SA']);
        assert.equal(reply.body.signoff.recordedBy, ADMIN_USER);
        assert.equal(reply.body.signoff.revokedAt, null);
        assert.deepEqual(rows.map((r) => r.creator_id), [TENANT]);
    });

    it('ignores a tenant id smuggled in the body', async () => {
        await call('POST', base(), { ...good, creator_id: OTHER, creatorId: OTHER, recorded_by: OTHER });
        assert.deepEqual(rows.map((r) => [r.creator_id, r.recorded_by]), [[TENANT, ADMIN_USER]]);
    });

    it('audits the scope, countries and id, but never the note', async () => {
        const reply = await call('POST', base(), good);
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, AUDIT_ACTIONS.adsLegalSignoff);
        assert.equal(audits[0]!.action, 'ads.legal_signoff');
        assert.equal(audits[0]!.targetId, TENANT);
        assert.deepEqual(audits[0]!.detail, { change: 'recorded', signoff_id: reply.body.signoff.id, scope: 'customer_lists', countries: ['EG', 'SA'] });
        assert.ok(!JSON.stringify(audits[0]).includes('Counsel opinion'));
    });

    it('refuses a bad body with 400 { error, code: INVALID, field } and writes nothing', async () => {
        const cases: Array<[unknown, string]> = [
            [{ ...good, scope: 'everything' }, 'scope'],
            [{ ...good, countries: [] }, 'countries'],
            [{ ...good, countries: ['EGY'] }, 'countries'],
            [{ ...good, note: '   ' }, 'note'],
            [{ ...good, note: 'x'.repeat(501) }, 'note'],
            [undefined, 'body'],
        ];
        for (const [body, field] of cases) {
            const reply = await call('POST', base(), body);
            assert.equal(reply.status, 400, JSON.stringify(body));
            assert.equal(reply.body.code, 'INVALID');
            assert.equal(reply.body.field, field);
            assert.equal(typeof reply.body.error, 'string');
        }
        assert.equal(rows.length, 0);
        assert.equal(audits.length, 0);
    });
});

describe('GET: the history', () => {
    it('lists the tenant\'s sign-offs, including revoked ones, and nobody else\'s', async () => {
        const made = await call('POST', base(), good);
        await call('POST', base(OTHER), { ...good, scope: 'lead_ads' });
        await call('DELETE', `${base()}/${made.body.signoff.id}`, undefined);
        const reply = await call('GET', base(), undefined);
        assert.equal(reply.status, 200);
        assert.equal(reply.body.signoffs.length, 1);
        assert.equal(reply.body.signoffs[0].creatorId, TENANT);
        assert.match(reply.body.signoffs[0].revokedAt, /^2026-10-25T/);
        // Revoked rows are included: the statement must not filter on revoked_at.
        assert.ok(!/revoked_at IS NULL/.test(db.ran(/^SELECT .* FROM ads_legal_signoffs/)[0]!.sql));
    });
});

describe('DELETE: revoking', () => {
    it('revokes, answers { revoked: true } and audits once', async () => {
        const made = await call('POST', base(), good);
        audits = [];
        const reply = await call('DELETE', `${base()}/${made.body.signoff.id}`, undefined);
        assert.deepEqual(reply, { status: 200, body: { revoked: true } });
        assert.equal(rows[0]!.revoked_at instanceof Date, true);
        assert.deepEqual(audits.map((a) => [a.action, a.targetId, a.detail]), [['ads.legal_signoff', TENANT, { change: 'revoked', signoff_id: made.body.signoff.id }]]);
    });

    it('answers { revoked: false } and writes no audit row the second time, for an unknown id, and for another tenant\'s row', async () => {
        const mine = await call('POST', base(), good);
        const theirs = await call('POST', base(OTHER), good);
        await call('DELETE', `${base()}/${mine.body.signoff.id}`, undefined);
        audits = [];
        for (const sid of [mine.body.signoff.id, '33333333-3333-4333-8333-333333333333', 'not-a-uuid', theirs.body.signoff.id]) {
            const reply = await call('DELETE', `${base()}/${sid}`, undefined);
            assert.deepEqual(reply, { status: 200, body: { revoked: false } }, sid);
        }
        assert.equal(audits.length, 0);
        assert.equal(rows.find((r) => r.id === theirs.body.signoff.id)!.revoked_at, null, 'the other tenant keeps its sign-off');
    });
});
