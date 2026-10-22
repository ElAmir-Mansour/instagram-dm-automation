/**
 * `/api/ads/lead-forms`, `/api/ads/leads`, `/api/ads/leads.csv` (Ads A10, T175 server half). Driven through a router with fake roles and
 * audit, against the pool stand-in (`monteur/testDb.ts`) and a Graph stub.
 *
 * Pinned:
 *   - the lock is read on every list, and a POST is 403 LOCKED_LEGAL without an active `lead_ads` sign-off (nothing written, nothing sent);
 *   - leads and the CSV are owner-only: a viewer is refused before anything is read;
 *   - the CSV export is audited with a count and the filters, and NO answer reaches the audit detail;
 *   - the CSV carries text/csv, an attachment name and no-store.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { encryptBytes } from '../config/crypto.js';
import { setLeadsGraphForTests } from '../services/ads/leads.js';
import { installFakeDb, type FakeDb } from '../services/monteur/testDb.js';
import { setLogSink } from '../utils/log.js';
import { mountLeadRoutes, type LeadsDeps } from './adsLeads.js';

const C = '11111111-1111-4111-8111-111111111111';
const FORM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

interface Reply { status: number; body: any; headers: Record<string, string> }

let db: FakeDb;
let audits: Array<Record<string, unknown>>;
let signed: boolean;
let owner: boolean;
let graphCalls: number;
let restoreSink: () => void;
let savedKey: string | undefined;

const allow: RequestHandler = (_req, _res, next) => next();
const ownerOnly: RequestHandler = (_req, res, next) => (owner ? next() : void res.status(403).json({ error: 'Forbidden.', code: 'INSUFFICIENT_TENANT_ROLE' }));

function deps(): LeadsDeps {
    return { canRead: allow, canWrite: ownerOnly, audit: async (_req, action, detail) => { audits.push({ action, ...detail }); } };
}

function call(method: string, url: string, body?: unknown, query: Record<string, string> = {}): Promise<Reply> {
    const router = Router();
    mountLeadRoutes(router, deps());
    return new Promise((resolve) => {
        const headers: Record<string, string> = {};
        const req = { method, url, originalUrl: url, body, query, params: {}, headers: {}, session: { userId: 'u1', role: 'owner', tenantId: C }, tenantId: C } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload, headers }); return this; },
            send(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload, headers }); return this; },
            setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; return this; },
        } as unknown as Response;
        router(req, res, () => resolve({ status: 0, body: null, headers }));
    });
}

const LEAD_ROW = () => ({
    id: 'l1', created_time: new Date('2026-10-22T10:00:00Z'), form_id: FORM, form_name: 'دورة', ad_meta_id: '555',
    answers_enc: encryptBytes(JSON.stringify([{ name: 'email', values: ['secret.person@example.com'] }])), consent_contact: true, handed_to: 'none',
    purged_at: null, retain_until: new Date('2027-01-20T10:00:00Z'),
});

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'e'.repeat(64);
    audits = [];
    signed = false;
    owner = true;
    graphCalls = 0;
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    setLeadsGraphForTests({ get: async () => { graphCalls++; return {}; }, create: async () => { graphCalls++; return { id: '1' }; } });
    db = installFakeDb();
    db.routes.push(
        [/FROM ads_legal_signoffs WHERE creator_id = \$1 AND scope = \$2 AND revoked_at IS NULL/, () => ({ rows: signed ? [{ id: 's', creator_id: C, scope: 'lead_ads', countries: ['EG'], recorded_by: null, recorded_at: new Date('2026-10-20T00:00:00Z'), note: 'n', revoked_at: null }] : [] })],
        [/FROM ads_lead_forms f WHERE f.creator_id = \$1 ORDER BY/, () => ({ rows: [] })],
        [/FROM ads_leads l LEFT JOIN ads_lead_forms f/, () => ({ rows: [LEAD_ROW()] })],
    );
});

afterEach(() => {
    db.restore();
    restoreSink();
    setLeadsGraphForTests(null);
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

const form = {
    name: 'دورة', questions: [{ type: 'EMAIL' }],
    thankYou: { title: 'شكراً', body: 'سنتواصل قريباً', buttonText: 'الموقع', url: 'https://example.com' },
};

describe('GET /lead-forms', () => {
    it('says locked, with no sign-off and the retention period, while locked', async () => {
        const r = await call('GET', '/lead-forms');
        assert.equal(r.status, 200);
        assert.equal(r.body.locked, true);
        assert.equal(r.body.signoff, null);
        assert.equal(r.body.retentionDays, 90);
        assert.equal(r.body.helpUrl, '#/help/ads#leads-and-privacy');
    });

    it('names the sign-off\'s countries once unlocked', async () => {
        signed = true;
        const r = await call('GET', '/lead-forms');
        assert.equal(r.body.locked, false);
        assert.deepEqual(r.body.signoff.countries, ['EG']);
    });
});

describe('POST /lead-forms', () => {
    it('is 403 LOCKED_LEGAL while locked: nothing written, nothing sent, nothing audited', async () => {
        const r = await call('POST', '/lead-forms', form);
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'LOCKED_LEGAL');
        assert.equal(graphCalls, 0);
        assert.equal(db.ran(/INSERT INTO ads_lead_forms/).length, 0);
        assert.equal(audits.length, 0);
    });

    it('refuses a restricted question with 400 and the field', async () => {
        signed = true;
        const r = await call('POST', '/lead-forms', { ...form, questions: [{ type: 'DOB' }] });
        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'RESTRICTED_QUESTION');
        assert.equal(r.body.field, 'questions[0].type');
    });

    it('is owner-only', async () => {
        owner = false;
        signed = true;
        const r = await call('POST', '/lead-forms', form);
        assert.equal(r.status, 403);
        assert.equal(db.ran(/ads_lead_forms/).length, 0);
    });
});

describe('GET /leads and /leads.csv', () => {
    it('a viewer is refused both, before anything is read', async () => {
        owner = false;
        for (const url of ['/leads', '/leads.csv']) {
            const r = await call('GET', url);
            assert.equal(r.status, 403, url);
        }
        assert.equal(db.ran(/FROM ads_leads/).length, 0);
        assert.equal(audits.length, 0);
    });

    it('the owner gets the answers decrypted, uncached', async () => {
        const r = await call('GET', '/leads');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.leads[0].answers, [{ name: 'email', values: ['secret.person@example.com'] }]);
        assert.equal(r.headers['cache-control'], 'no-store');
    });

    it('a bad filter is a 400 naming it', async () => {
        const r = await call('GET', '/leads', undefined, { formId: 'not-a-uuid' });
        assert.equal(r.status, 400);
        assert.equal(r.body.field, 'formId');
    });

    it('the CSV is audited with a count and the filters, never an answer, and downloads as an attachment', async () => {
        const r = await call('GET', '/leads.csv', undefined, { formId: FORM, from: '2026-10-01' });
        assert.equal(r.status, 200);
        assert.equal(r.headers['content-type'], 'text/csv; charset=utf-8');
        assert.match(r.headers['content-disposition']!, /^attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"$/);
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.match(String(r.body), /secret\.person@example\.com/);
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!['action'], 'ads.leads_exported');
        assert.equal(audits[0]!['count'], 1);
        assert.equal(audits[0]!['form_id'], FORM);
        assert.equal(JSON.stringify(audits).includes('secret.person'), false);
        assert.deepEqual(db.ran(/FROM ads_leads l LEFT JOIN/)[0]!.params.slice(1, 3), [FORM, new Date('2026-10-01').toISOString()]);
    });
});
