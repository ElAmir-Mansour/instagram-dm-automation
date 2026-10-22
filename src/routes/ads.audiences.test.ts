/**
 * `/api/ads/audiences` (Ads A8, T150). Driven through a router with fake deps (context, queue, roles, audit) against the pool stand-in.
 *
 * Pinned:
 *   - a customer list is LOCKED_LEGAL without an active `customer_lists` sign-off, and the text is not even parsed then;
 *   - writes are owner-only: a refused role reaches neither the queue nor the database;
 *   - an unlocked upload queues one create and one `audience_users` op per batch on `{dep}/users` with `scrub: true`, and NO raw value
 *     of the list reaches the queue, the database, the audit ledger or the answer; opted-out and uncovered-country rows are left out;
 *   - deleting needs `confirm: true`; a lookalike needs a seed of 100 people.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { installFakeDb, type FakeDb } from '../services/monteur/testDb.js';
import { sha256Hex } from '../services/ads/hashing.js';
import type { EnqueueInput, OpView } from '../services/ads/ops.js';
import { setLogSink } from '../utils/log.js';
import { mountAudienceRoutes, type AudienceContext, type AudiencesDeps } from './adsAudiences.js';

const C = '11111111-1111-4111-8111-111111111111';
const SEED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const RAW = {
    emails: ['salma.raw@example.com', 'omar.raw@example.org'],
    phones: ['01012345678', '+966501234567', '00201099999999'],
    names: ['Karim', 'Youssef'],
};
const LIST = [
    'email,phone,first name',
    `${RAW.emails[0]},${RAW.phones[0]},${RAW.names[0]}`,
    `${RAW.emails[1]},${RAW.phones[1]},${RAW.names[1]}`,
    `,${RAW.phones[2]},`, // opted out below
    'nobody@example.net,+12025550123,', // US: outside the sign-off's countries
].join('\n');

interface Reply { status: number; body: any }

let db: FakeDb;
let enqueued: EnqueueInput[];
let audits: Array<Record<string, unknown>>;
let ran: string[][];
let signoff: Record<string, unknown> | null;
let writeAllowed: boolean;
let ctx: AudienceContext;
let restoreSink: () => void;

const allow: RequestHandler = (_req, _res, next) => next();
const ownerOnly: RequestHandler = (_req, res, next) => (writeAllowed ? next() : void res.status(403).json({ error: 'Forbidden.' }));

function deps(): AudiencesDeps {
    return {
        context: async () => ctx,
        enqueue: async (input) => {
            enqueued.push(input);
            return { id: `op-${enqueued.length}`, kind: input.kind, state: 'pending', objectKey: input.objectKey, notBefore: '2026-10-22T00:00:00Z', attempts: 0, result: null, createdAt: '2026-10-22T00:00:00Z', finishedAt: null, actorVia: 'owner' } as OpView;
        },
        runInline: (_c, ids) => { ran.push(ids); },
        latestOps: async () => new Map(),
        listVideos: async () => [],
        canRead: allow,
        canWrite: ownerOnly,
        audit: async (_req, action, detail) => { audits.push({ action, ...detail }); },
    };
}

function call(method: string, url: string, body?: unknown): Promise<Reply> {
    const router = Router();
    mountAudienceRoutes(router, async (_req, res, err) => { res.status(500).json({ error: String((err as Error)?.message ?? err) }); }, deps());
    return new Promise((resolve) => {
        const req = { method, url, originalUrl: url, body, query: {}, params: {}, headers: {}, session: { userId: 'u1', role: 'owner', tenantId: C } } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        router(req, res, () => resolve({ status: 0, body: null }));
    });
}

beforeEach(() => {
    enqueued = []; audits = []; ran = []; signoff = null; writeAllowed = true;
    ctx = { creatorId: C, adAccountId: '1234567', igUserId: '1789', igUsername: 'acct', pageId: '1056', pageName: 'Page', tosAccepted: { custom: true, lookalike: null } };
    const previous = setLogSink(() => {});
    restoreSink = () => { setLogSink(previous); };
    db = installFakeDb();
    db.routes.push(
        [/FROM ads_legal_signoffs WHERE creator_id = \$1 AND scope = \$2/, () => ({ rows: signoff ? [signoff] : [] })],
        [/^\s*SELECT 'phone'::text AS kind/, () => ({ rows: [{ kind: 'phone', value: '201099999999' }] })],
        [/^INSERT INTO ads_audiences/, ([creator, kind, name, spec, seed]) => ({ rows: [{ id: NEW_ID, creator_id: creator, meta_id: null, kind, name, spec: JSON.parse(spec), status: 'creating', size_lower: null, size_upper: null, seed_audience_id: seed, synced_at: null, created_at: new Date('2026-10-22T10:00:00Z') }] })],
        [/^SELECT .* FROM ads_audiences WHERE id = \$1 AND creator_id = \$2/, ([id]) => ({ rows: id === SEED ? [{ id: SEED, creator_id: C, meta_id: '6001', kind: 'ig_engagement', name: 's', spec: {}, status: 'ready', size_lower: '40', size_upper: '90', seed_audience_id: null, synced_at: null, created_at: new Date() }] : [] })],
        [/^\s*UPDATE ads_audiences a/, () => ({ rows: [] })],
        [/^SELECT .* FROM ads_audiences WHERE creator_id = \$1 AND status <> 'deleted' ORDER BY/, () => ({ rows: [] })],
    );
});

afterEach(() => { db.restore(); restoreSink(); });

const allRawValues = () => [...RAW.emails, ...RAW.phones, ...RAW.names, 'nobody@example.net', '+12025550123', '2025550123'];

describe('the customer-list lock', () => {
    it('is LOCKED_LEGAL without a sign-off, and the text is not read (no opt-out query, no row, no op)', async () => {
        const r = await call('POST', '/audiences/customer-list', { name: 'عملاء', columns: 'auto', text: LIST });
        assert.equal(r.status, 403);
        assert.equal(r.body.code, 'LOCKED_LEGAL');
        assert.deepEqual(r.body.needed, ['legal_signoff']);
        assert.equal(db.ran(/contact_consents|conversations/).length, 0);
        assert.equal(db.ran(/INSERT INTO ads_audiences/).length, 0);
        assert.equal(enqueued.length, 0);
    });

    it('GET shows the lock with the Help link', async () => {
        const r = await call('GET', '/audiences');
        assert.equal(r.status, 200);
        assert.equal(r.body.customerList.locked, true);
        assert.equal(r.body.customerList.helpUrl, '#/help/ads#customer-lists');
        assert.equal(r.body.tosUrl, 'https://business.facebook.com/ads/manage/customaudiences/tos/?act=1234567');
    });
});

describe('owner-only writes', () => {
    it('a refused role reaches neither the queue nor the database', async () => {
        writeAllowed = false;
        signoff = { id: 's1', creator_id: C, scope: 'customer_lists', countries: ['EG', 'SA'], recorded_by: null, recorded_at: new Date(), note: 'x', revoked_at: null };
        for (const [method, url, body] of [
            ['POST', '/audiences', { kind: 'ig_engagement', name: '', spec: { event: 'engaged', retentionDays: 30 } }],
            ['POST', '/audiences/customer-list', { text: LIST }],
            ['POST', '/audiences/opt-outs', { contact: RAW.emails[0] }],
            ['DELETE', `/audiences/${SEED}`, { confirm: true }],
        ] as const) {
            const r = await call(method, url, body);
            assert.equal(r.status, 403, `${method} ${url}`);
        }
        assert.equal(enqueued.length, 0);
        assert.equal(db.ran(/./).length, 0);
    });
});

describe('an unlocked upload', () => {
    beforeEach(() => {
        signoff = { id: 's1', creator_id: C, scope: 'customer_lists', countries: ['EG', 'SA'], recorded_by: null, recorded_at: new Date(), note: 'x', revoked_at: null };
    });

    it('queues a create and the hashed batches, leaves out the opted-out and uncovered rows, and never lets a raw value out', async () => {
        const r = await call('POST', '/audiences/customer-list', { name: 'عملاء الدورة', columns: 'auto', defaultCountry: 'EG', text: LIST });
        assert.equal(r.status, 202, JSON.stringify(r.body));
        assert.equal(r.body.rowsAccepted, 2);
        assert.equal(r.body.rowsExcludedOptOut, 1);
        assert.equal(r.body.rowsExcludedCountry, 1);

        assert.equal(enqueued.length, 2);
        const [create, users] = enqueued;
        assert.equal(create!.kind, 'audience_create');
        assert.equal(create!.payload.exec!.path, 'act_1234567/customaudiences');
        assert.equal(create!.payload.exec!.params!['subtype'], 'CUSTOM');
        assert.equal(users!.kind, 'audience_users');
        assert.equal(users!.dependsOn, 'op-1');
        assert.equal(users!.payload.exec!.path, '{dep}/users');
        assert.equal(users!.payload.scrub, true);
        const payload = JSON.parse(String(users!.payload.exec!.params!['payload']));
        assert.ok(payload.data.flat().includes(sha256Hex(RAW.emails[0]!)));
        assert.ok(payload.data.flat().includes(sha256Hex('201012345678')));
        const session = JSON.parse(String(users!.payload.exec!.params!['session']));
        assert.equal(session.batch_seq, 1);
        assert.equal(session.last_batch_flag, true);
        assert.deepEqual(ran, [['op-1', 'op-2']]);

        const everything = JSON.stringify({ enqueued, db: db.ran(/./).map((s) => s.params), audits, body: r.body });
        for (const raw of allRawValues()) assert.ok(!everything.includes(raw), `raw value leaked: ${raw}`);
        const stored = db.ran(/^INSERT INTO ads_audiences/)[0]!;
        assert.deepEqual(JSON.parse(stored.params[3]), { columns: ['EMAIL', 'PHONE', 'FN', 'COUNTRY'], rows_sent: 2, matched_estimate: null });
    });

    it('refuses a default country the sign-off does not cover, before parsing', async () => {
        const r = await call('POST', '/audiences/customer-list', { text: LIST, defaultCountry: 'US' });
        assert.equal(r.status, 400);
        assert.equal(r.body.field, 'defaultCountry');
        assert.equal(enqueued.length, 0);
    });

    it('a parse error names the field and carries no row content', async () => {
        const r = await call('POST', '/audiences/customer-list', { text: 'Karim\nYoussef', columns: ['FN'] });
        assert.equal(r.status, 400);
        assert.ok(!JSON.stringify(r.body).includes('Karim'));
    });
});

describe('engagement, lookalike and delete', () => {
    it('creates an Instagram engagement audience through the queue, never with its own name tag', async () => {
        const r = await call('POST', '/audiences', { kind: 'ig_engagement', name: 'متابعون متفاعلون', spec: { event: 'engaged', retentionDays: 30 } });
        assert.equal(r.status, 202);
        assert.equal(enqueued[0]!.kind, 'audience_create');
        assert.equal(enqueued[0]!.idempotencyKey, `audience:${NEW_ID}:create`);
        assert.equal(enqueued[0]!.payload.exec!.params!['name'], 'متابعون متفاعلون');
        assert.equal(audits[0]!['action'], 'ads.audience_created');
    });

    it('refuses a sensitive name, and refuses when the Custom Audience Terms are not accepted (with the link)', async () => {
        const bad = await call('POST', '/audiences', { kind: 'ig_engagement', name: 'مش قادر يدفع', spec: { event: 'engaged', retentionDays: 30 } });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.reason, 'sensitive_name');
        ctx.tosAccepted = { custom: false, lookalike: null };
        const tos = await call('POST', '/audiences', { kind: 'ig_engagement', name: '', spec: { event: 'engaged', retentionDays: 30 } });
        assert.equal(tos.status, 409);
        assert.equal(tos.body.code, 'TERMS_NOT_ACCEPTED');
        assert.match(tos.body.tosUrl, /customaudiences\/tos\/\?act=1234567/);
        assert.equal(enqueued.length, 0);
    });

    it('a lookalike of a seed under 100 people is SEED_TOO_SMALL', async () => {
        const r = await call('POST', '/audiences', { kind: 'lookalike', name: '', spec: { seedAudienceId: SEED, country: 'EG', ratio: 0.01 } });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'SEED_TOO_SMALL');
        assert.equal(enqueued.length, 0);
    });

    it('deleting needs confirm: true', async () => {
        const r = await call('DELETE', `/audiences/${SEED}`, {});
        assert.equal(r.status, 400);
        assert.equal(r.body.field, 'confirm');
        assert.equal(enqueued.length, 0);
    });
});

describe('opt-outs', () => {
    it('stores only the hash of the contact', async () => {
        db.routes.push([/^\s*INSERT INTO contact_consents/, () => ({ rows: [] })]);
        const r = await call('POST', '/audiences/opt-outs', { contact: RAW.emails[0] });
        assert.equal(r.status, 200);
        const insert = db.ran(/INSERT INTO contact_consents/)[0]!;
        assert.deepEqual(insert.params, [C, sha256Hex(RAW.emails[0]!)]);
        assert.ok(!JSON.stringify({ audits, db: db.ran(/./).map((s) => s.params) }).includes(RAW.emails[0]!));
    });
});
