/**
 * The profile draft's routes (P24): the tenant's, the operator's, and the sweep a worker calls. Driven through the real routers with a plain
 * request object, against the in-memory table of `testDb.ts`, with the model and the sources as fakes (no network, no database).
 *
 * What is pinned, because each is a way a draft is started, read or advanced by somebody who should not:
 *   - the tenant's routes are for the OWNER of the tenant, and only while its onboarding is open; the tenant comes from the SESSION, never the body;
 *   - the operator's routes are for a platform admin and nobody else (404, as the rest of /api/admin), and take the tenant from the PATH;
 *   - the sweep is guarded exactly like the drain: Bearer CRON_SECRET, fail closed, header only, and it is mounted above authentication;
 *   - a tenant is told a kind and a fixed sentence about a failure, an operator the provider's words, and neither the text that was scraped;
 *   - starting is audited, with which inputs were given and never their values; advancing and reading are not.
 */
import assert from 'node:assert/strict';
import { afterEach, before, after, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../services/aiProviders/generate.js';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { AiError } from '../services/llm/errors.js';
import { setDraftSourcesFetcher } from '../services/onboarding/drafts.js';
import type { FetchOutcome } from '../services/onboarding/draftSources.js';
import { DRAFT_SCHEMAS } from '../services/onboarding/draftSchema.js';
import { installDraftWorld, uuid, type DraftWorld } from '../services/onboarding/testDb.js';
import type { FetchedBundle, SourcesStatus } from '../services/onboarding/draftTypes.js';
import { okBusiness, okVoice, STORE_CANDIDATES, STORE_SOURCES, storeSignals } from '../services/onboarding/fixtures/draftAnswers.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTenantRole, resolveTenant } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';
import apiRouter from './api.js';
import { onboardingDraftsRouter } from './onboardingDrafts.js';

interface Reply { status: number; body: any; headers: Record<string, string> }
interface CallOptions { body?: unknown; session?: Record<string, unknown>; tenantRole?: string; bearer?: string; query?: Record<string, string> }

/** Call a router as Express would, with nothing mounted above it. */
function call(router: unknown, method: string, url: string, options: CallOptions = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const headers: Record<string, string> = { host: 'app.example.test' };
        if (options.bearer) headers.authorization = options.bearer;
        const path = url.split('?')[0]!;
        const params: Record<string, string> = {};
        const adminMatch = /^\/tenants\/([^/]+)\/draft/.exec(path);
        if (adminMatch) params.id = adminMatch[1]!;
        const req = {
            method: method.toUpperCase(), url, originalUrl: url, path, body: options.body, query: options.query ?? {}, params, headers,
            session: options.session, tenantRole: options.tenantRole, socket: { remoteAddress: '203.0.113.9' },
        } as unknown as Request;
        const sent: Record<string, string> = {};
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload, headers: sent }); return this; },
            setHeader(name: string, value: string) { sent[name.toLowerCase()] = String(value); return this; },
        } as unknown as Response;
        (router as (r: Request, s: Response, n: () => void) => void)(req, res, () => resolve({ status: 0, body: { fellThrough: true }, headers: sent }));
    });
}

const TENANT = uuid(100);
const OTHER = uuid(101);
const OWNER = { userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 };
const OWNER_OF_OTHER = { userId: uuid(3), role: 'user', tenantId: OTHER, tokenVersion: 1 };
const ADMIN = { userId: uuid(1), role: 'platform_admin', tenantId: uuid(999), tokenVersion: 1 };

let world: DraftWorld;
let logs: Array<Record<string, any>>;
let aiCalls: AiGenerateArgs[];
let ai: (args: AiGenerateArgs) => Promise<AiGenerateResult>;
let restore: Array<() => void>;
const saved: Record<string, string | undefined> = {};

const ok = (via: string) => ({ state: 'ok', via, kind: null, retryable: false, message: null, ms: 7, counts: {} }) as const;
const STATUS_OK: SourcesStatus = { instagram: ok('business_discovery'), website: ok('safe_fetch'), youtube: { ...ok('api_key'), state: 'skipped', kind: 'no_input' }, typed: { ...ok('typed'), state: 'skipped', kind: 'no_input' } };
const bundle = (): FetchedBundle => ({
    version: 1, sources: STORE_SOURCES, candidates: STORE_CANDIDATES, signals: storeSignals(),
    facts: { handle: 'noor.perfumes', handleMismatch: false, igName: null, followers: 1, mediaCount: 1, siteHost: 'noor-perfumes.example', site: null, brand: null, logos: [], socialLinks: {}, youtube: null, knownUrls: [], knownEmails: [], knownPhones: [], keywordsInUse: [] },
});
const outcome = (): FetchOutcome => ({ bundle: bundle(), status: STATUS_OK, usable: STORE_SOURCES.length, anyRetryable: false });
const aiResult = (json: unknown): AiGenerateResult => ({
    json, usage: { in: 10, out: 5 }, billed: [], model: 'claude-opus-5-5', provider: 'anthropic', stopReason: 'end_turn', elapsed_ms: 5, usd: 0.1, costSource: 'table', priced: true, effort: 'high', route: 'saved', usageId: 'u',
});
const honest = async (args: AiGenerateArgs): Promise<AiGenerateResult> => aiResult(args.schema === DRAFT_SCHEMAS.voice ? okVoice() : okBusiness());

before(() => {
    for (const key of ['CRON_SECRET', 'DASHBOARD_PASSWORD', 'META_APP_SECRET']) saved[key] = process.env[key];
    process.env.CRON_SECRET = 'cron-secret-for-tests';
    process.env.DASHBOARD_PASSWORD = 'dashboard-password';
    process.env.META_APP_SECRET = 'meta-app-secret';
});
after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

beforeEach(() => {
    world = installDraftWorld();
    world.clock = Date.now();
    world.addCreator(100, { instagram_username: 'noor.perfumes', website_url: 'https://noor-perfumes.example/' });
    world.addCreator(101, { instagram_username: 'other.shop' });
    world.onboarding.set(TENANT, 'in_progress');
    world.onboarding.set(OTHER, 'invited');
    logs = [];
    setLogSink((_l, line) => { try { logs.push(JSON.parse(line)); } catch { /* */ } });
    aiCalls = [];
    ai = honest;
    restore = [];
    const prevAi = setAiCaller(async (args) => { aiCalls.push(args); return ai(args); });
    restore.push(() => setAiCaller(prevAi));
    const prevSources = setDraftSourcesFetcher(async () => outcome());
    restore.push(() => setDraftSourcesFetcher(prevSources));
});

afterEach(() => {
    for (const fn of restore) fn();
    world.restore();
    setLogSink(() => {});
});

const asOwner = { session: OWNER, tenantRole: 'owner' };
const tenantGet = (over: CallOptions = {}) => call(onboardingDraftsRouter, 'GET', '/draft', { ...asOwner, ...over });
const tenantStart = (body: unknown = {}, over: CallOptions = {}) => call(onboardingDraftsRouter, 'POST', '/draft', { ...asOwner, body, ...over });
const tenantAdvance = (over: CallOptions = {}) => call(onboardingDraftsRouter, 'POST', '/draft/advance', { ...asOwner, ...over });

// ─── The tenant's routes ────────────────────────────────────────────────────────────────────

describe('the tenant\'s routes: who may use them', () => {
    it('every one carries an owner guard, and a member who is not the owner is refused with 403', async () => {
        const stack = (onboardingDraftsRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: { minimumRole?: string } }> } }> }).stack;
        const routes = stack.filter((l) => l.route).map((l) => ({ key: `${Object.keys(l.route!.methods)[0]!.toUpperCase()} ${l.route!.path}`, guard: l.route!.stack.map((s) => s.handle.minimumRole).find(Boolean) }));
        assert.deepEqual(routes, [{ key: 'GET /draft', guard: 'owner' }, { key: 'POST /draft', guard: 'owner' }, { key: 'POST /draft/advance', guard: 'owner' }]);
        for (const role of ['operator', 'viewer']) {
            for (const [method, url] of [['GET', '/draft'], ['POST', '/draft'], ['POST', '/draft/advance']] as const) {
                const r = await call(onboardingDraftsRouter, method, url, { session: OWNER, tenantRole: role, body: {} });
                assert.equal(r.status, 403, `${role} ${method} ${url}`);
                assert.equal(r.body.code, 'INSUFFICIENT_TENANT_ROLE');
            }
        }
        assert.equal(world.drafts.length, 0, 'a refused call made nothing');
    });

    it('is mounted below resolveTenant, so every route acts as the session\'s tenant', () => {
        const stack = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack;
        const mounts = stack.filter((l) => !l.route).map((l) => l.handle);
        assert.ok(mounts.indexOf(onboardingDraftsRouter as unknown as never) > mounts.indexOf(resolveTenant), 'below resolveTenant');
        assert.ok(typeof requireTenantRole('owner') === 'function');
    });

    it('works only while the tenant\'s onboarding is open: invited and in progress, not completed, and not a tenant with no row (D14)', async () => {
        for (const status of ['invited', 'in_progress']) {
            world.onboarding.set(TENANT, status);
            assert.equal((await tenantGet()).status, 200, status);
        }
        for (const status of ['completed', null]) {
            if (status === null) world.onboarding.delete(TENANT);
            else world.onboarding.set(TENANT, status);
            for (const r of [await tenantGet(), await tenantStart(), await tenantAdvance()]) {
                assert.equal(r.status, 409);
                assert.equal(r.body.code, 'ONBOARDING_COMPLETED');
            }
        }
        assert.equal(world.drafts.length, 0);
    });

    it('takes the tenant from the session: another tenant\'s id in the body or the query changes nothing, and each reads only its own draft', async () => {
        const mine = await tenantStart({ creatorId: OTHER, creator_id: OTHER, tenantId: OTHER });
        assert.equal(world.drafts.length, 1);
        assert.equal(world.drafts[0]!.creator_id, TENANT);
        const theirs = await call(onboardingDraftsRouter, 'GET', '/draft', { session: OWNER_OF_OTHER, tenantRole: 'owner' });
        assert.equal(theirs.body.draft, null, 'the other tenant sees no draft of mine');
        const read = await tenantGet();
        assert.equal(read.body.draft.id, mine.body.draft.id);
    });

    it('answers are never cached', async () => {
        assert.equal((await tenantGet()).headers['cache-control'], 'no-store');
    });
});

describe('the tenant\'s routes: start, read, advance', () => {
    it('GET with no draft says so', async () => {
        assert.deepEqual((await tenantGet()).body, { draft: null });
    });

    it('POST starts a draft from the handle and site the operator typed, and answers 201 with the view', async () => {
        const r = await tenantStart();
        assert.equal(r.status, 201);
        assert.equal(r.body.reused, false);
        assert.equal(r.body.draft.status, 'queued');
        assert.deepEqual(r.body.draft.inputs, { instagram: 'noor.perfumes', website: 'https://noor-perfumes.example/', youtube: null, hasAbout: false, via: 'discovery' });
        assert.equal(world.drafts[0]!.origin, 'wizard');
        assert.equal(world.drafts[0]!.requested_by, OWNER.userId);
        assert.equal(aiCalls.length, 0, 'starting asks nothing of the model');
    });

    it('what the tenant types wins over the row, and a second start with the same inputs finds the first (200, reused)', async () => {
        const a = await tenantStart({ instagram: '@Noor.Perfumes', website: 'noor-perfumes.example', youtube: '@noortv', about: 'متجر عطور' });
        assert.equal(a.status, 201);
        assert.deepEqual([a.body.draft.inputs.youtube, a.body.draft.inputs.hasAbout], ['@noortv', true]);
        const b = await tenantStart({ instagram: 'noor.perfumes', website: 'https://noor-perfumes.example/', youtube: 'youtube.com/@noortv', about: 'متجر عطور' });
        assert.deepEqual([b.status, b.body.reused, b.body.draft.id], [200, true, a.body.draft.id]);
        assert.equal(world.drafts.length, 1);
    });

    it('new inputs replace the draft in flight', async () => {
        const a = await tenantStart();
        const b = await tenantStart({ website: 'https://different.example/' });
        assert.deepEqual([b.status, b.body.superseded], [201, 1]);
        assert.equal(world.drafts.find((d) => d.id === a.body.draft.id)!.status, 'superseded');
        assert.equal((await tenantGet()).body.draft.id, b.body.draft.id);
    });

    it('a tenant with its own Instagram connection is read through it: via own_token', async () => {
        world.creators.get(TENANT)!.instagram_page_id = '17841400000000009';
        world.creators.get(TENANT)!.page_access_token = 'enc:v1:whatever';
        assert.equal((await tenantStart()).body.draft.inputs.via, 'own_token');
    });

    it('refuses an input that cannot be what its field says, naming the field, and makes nothing', async () => {
        for (const [body, field] of [[{ instagram: 'two words' }, 'instagram'], [{ website: 'http://localhost/' }, 'website'], [{ youtube: '???' }, 'youtube'], [{ about: 7 }, 'about']] as const) {
            const r = await tenantStart(body);
            assert.deepEqual([r.status, r.body.code, r.body.field], [400, 'INVALID_INPUT', field]);
        }
        assert.equal(world.drafts.length, 0);
    });

    it('refuses to start with nothing to read: the operator typed nothing and the tenant has not either', async () => {
        world.creators.set(TENANT, { ...world.creators.get(TENANT)!, instagram_username: null, website_url: null });
        const r = await tenantStart({});
        assert.deepEqual([r.status, r.body.code], [400, 'NO_INPUTS']);
    });

    it('a tenant that does not exist is a 404, not a draft', async () => {
        const r = await tenantStart({}, { session: { ...OWNER, tenantId: uuid(404) } });
        assert.equal(r.status, 404);
        assert.equal(world.drafts.length, 0);
    });

    it('the sixth new draft of the day is a 429 with the limit', async () => {
        for (let i = 0; i < 5; i++) assert.equal((await tenantStart({ instagram: `h${i}` })).status, 201);
        const r = await tenantStart({ instagram: 'h99' });
        assert.deepEqual([r.status, r.body.code, r.body.limit], [429, 'DRAFT_LIMIT', 5]);
    });

    it('advance with nothing to advance is a 404: the tenant\'s door never starts a draft by itself', async () => {
        const r = await tenantAdvance();
        assert.deepEqual([r.status, r.body.code], [404, 'NO_DRAFT']);
        assert.equal(world.drafts.length, 0);
    });

    it('advance does the work and answers with the draft as it stands, and what it did', async () => {
        await tenantStart();
        const r = await tenantAdvance();
        assert.equal(r.status, 200);
        assert.equal(r.body.draft.status, 'ready');
        assert.equal(r.body.advance.outcome, 'worked');
        assert.deepEqual(r.body.advance.steps.map((s: any) => s.step), ['fetch', 'draft']);
        assert.ok(typeof r.body.advance.elapsed_ms === 'number');
        assert.ok(r.body.draft.draft.touched.length > 0);
        assert.equal(aiCalls.length, 2);
        assert.deepEqual((await tenantGet()).body.draft.status, 'ready');
    });

    it('advance on a draft somebody is working on does nothing and says it is busy', async () => {
        const started = await tenantStart();
        const row = world.drafts.find((d) => d.id === started.body.draft.id)!;
        row.lease_owner = 'someone'; row.lease_until = new Date(world.clock + 200_000); row.status = 'drafting';
        const r = await tenantAdvance();
        assert.equal(r.body.advance.outcome, 'busy');
        assert.equal(r.body.draft.working, true);
        assert.equal(aiCalls.length, 0);
    });

    it('the poll says when advance would do something: after a lease runs out', async () => {
        const started = await tenantStart();
        assert.equal((await tenantGet()).body.draft.advanceable, true);
        const row = world.drafts.find((d) => d.id === started.body.draft.id)!;
        row.lease_owner = 'someone'; row.lease_until = new Date(Date.now() + 200_000);
        assert.equal((await tenantGet()).body.draft.advanceable, false);
        row.lease_until = new Date(Date.now() - 1_000);
        assert.equal((await tenantGet()).body.draft.advanceable, true);
    });
});

describe('what a tenant is told, and what an operator is', () => {
    beforeEach(() => { ai = async () => { throw new AiError({ kind: 'auth', provider: 'anthropic', model: 'claude-opus-5-5', message: 'The provider rejected the credential ending 7Qz.' }); }; });

    it('a tenant gets the kind and a fixed sentence; an operator gets the provider\'s words and the cost', async () => {
        const started = await tenantStart();
        const advanced = await tenantAdvance();
        assert.deepEqual(advanced.body.draft.error, { kind: 'auth', message: 'The assistant could not be reached with the key that is set up. You can fill this in yourself.' });
        assert.equal(JSON.stringify(advanced.body).includes('rejected the credential'), false);
        assert.equal('usage' in advanced.body.draft, false);

        const admin = await call(adminRouter, 'GET', `/tenants/${TENANT}/draft`, { session: ADMIN });
        assert.equal(admin.status, 200);
        assert.equal(admin.body.draft.id, started.body.draft.id);
        assert.equal(admin.body.draft.error.message, 'The provider rejected the credential ending 7Qz.');
        assert.ok(Array.isArray(admin.body.draft.usage.steps));
    });

    it('neither is ever handed the text that was read, or the lists only the checker uses', async () => {
        await tenantStart();
        ai = honest;
        const advanced = await tenantAdvance();
        const admin = await call(adminRouter, 'GET', `/tenants/${TENANT}/draft`, { session: ADMIN });
        for (const body of [advanced.body, admin.body]) {
            const text = JSON.stringify(body);
            assert.equal(text.includes('متجر نور للعطور 🌹'), false, 'no source text');
            assert.equal(text.includes('knownUrls') || text.includes('keywordsInUse'), false);
        }
        assert.ok(advanced.body.draft.sources.every((s: any) => Object.keys(s).sort().join() === 'id,kind'));
    });

    it('no AI key is a state the wizard can name', async () => {
        ai = async () => { throw new AiError({ kind: 'no_provider', provider: '', model: '', message: 'No AI provider has a key.' }); };
        await tenantStart();
        const r = await tenantAdvance();
        assert.equal(r.body.draft.status, 'failed');
        assert.equal(r.body.draft.needsAiKey, true);
        assert.equal(r.body.draft.draft, null);
        assert.equal(r.body.draft.advanceable, false);
    });
});

describe('the audit trail', () => {
    it('records a start with which inputs were given and never their values; a reuse, a read and an advance are not recorded', async () => {
        await tenantStart({ about: 'private words about my shop', youtube: '@noortv' });
        await tenantStart({ about: 'private words about my shop', youtube: '@noortv' });
        await tenantGet();
        await tenantAdvance();
        const starts = world.audits.filter((a) => a.action === AUDIT_ACTIONS.onboardingDraftStart);
        assert.equal(world.audits.length, 1);
        assert.equal(starts.length, 1);
        assert.deepEqual(starts[0]!.detail, {
            draft_id: world.drafts[0]!.id, origin: 'wizard', superseded: 0, forced: false, instagram: true, website: true, youtube: true, about: true, via: 'discovery',
        });
        assert.equal(starts[0]!.target_id, TENANT);
        assert.equal(JSON.stringify(world.audits).includes('private words'), false);
        assert.equal(JSON.stringify(world.audits).includes('noortv'), false);
    });
});

describe('failures', () => {
    it('a database without the onboarding migration says which migration', async () => {
        world.failOn(/profile_drafts/, Object.assign(new Error('relation "profile_drafts" does not exist'), { code: '42P01' }), 5);
        const r = await tenantGet();
        assert.equal(r.status, 500);
        assert.equal(r.body.migrationPending, true);
        assert.match(r.body.error, /migration v34/);
    });

    it('anything else is a logged 500 that does not say what went wrong', async () => {
        world.failOn(/profile_drafts/, new Error('password authentication failed for user "postgres" at db.supabase.example'), 5);
        const r = await tenantGet();
        assert.equal(r.status, 500);
        assert.deepEqual(r.body, { error: 'Failed to read the draft.' });
        assert.ok(logs.some((l) => l.event === 'onboarding.draft_read_failed'));
    });
});

// ─── The operator's routes ──────────────────────────────────────────────────────────────────

describe('the operator\'s routes', () => {
    const adminGet = (id = TENANT, over: CallOptions = {}) => call(adminRouter, 'GET', `/tenants/${id}/draft`, { session: ADMIN, ...over });
    const adminStart = (body: unknown = {}, id = TENANT, over: CallOptions = {}) => call(adminRouter, 'POST', `/tenants/${id}/draft`, { session: ADMIN, body, ...over });
    const adminAdvance = (body: unknown = {}, id = TENANT, over: CallOptions = {}) => call(adminRouter, 'POST', `/tenants/${id}/draft/advance`, { session: ADMIN, body, ...over });

    it('are for a platform admin and nobody else: a member, an owner, a user with no tenant all get the same 404 as the rest of /api/admin', async () => {
        for (const session of [OWNER, { ...OWNER, role: 'user' }, undefined]) {
            for (const [method, url] of [['GET', `/tenants/${TENANT}/draft`], ['POST', `/tenants/${TENANT}/draft`], ['POST', `/tenants/${TENANT}/draft/advance`]] as const) {
                const r = await call(adminRouter, method, url, { session, body: {} });
                assert.equal(r.status, 404, `${method} ${url}`);
            }
        }
        assert.equal(world.drafts.length, 0);
        assert.equal(aiCalls.length, 0);
    });

    it('take the tenant from the path: a body that names another changes nothing; an id that is not a tenant is a 404', async () => {
        await adminStart({ creatorId: OTHER, creator_id: OTHER });
        assert.deepEqual(world.drafts.map((d) => d.creator_id), [TENANT]);
        for (const id of ['not-a-uuid', uuid(404)]) {
            for (const r of [await adminGet(id), await adminStart({}, id), await adminAdvance({}, id)]) assert.equal(r.status, 404, id);
        }
        assert.equal(world.drafts.length, 1);
    });

    it('start: what the operator typed at creation, the admin\'s view, and the draft is origin admin_create, then redraft', async () => {
        const first = await adminStart();
        assert.equal(first.status, 201);
        assert.ok('usage' in first.body.draft, 'an operator\'s view carries the steps and the cost');
        assert.equal(world.drafts[0]!.origin, 'admin_create');
        const second = await adminStart({ website: 'https://different.example/' });
        assert.equal(second.status, 201);
        assert.equal(world.drafts.at(-1)!.origin, 'redraft');
        assert.equal(world.drafts[0]!.status, 'superseded');
    });

    it('start is not gated on onboarding: a re-draft of a tenant that has finished is the operator\'s call', async () => {
        world.onboarding.set(TENANT, 'completed');
        assert.equal((await adminStart()).status, 201);
        assert.equal((await adminGet()).status, 200);
    });

    it('`force` makes a new draft although a fresh finished one answers the inputs; without it the finished one is returned', async () => {
        const a = await adminStart();
        await adminAdvance();
        const reused = await adminStart();
        assert.deepEqual([reused.status, reused.body.reused, reused.body.draft.id], [200, true, a.body.draft.id]);
        const forced = await adminStart({ force: true });
        assert.deepEqual([forced.status, forced.body.reused], [201, false]);
        assert.equal(world.audits.at(-1)!.detail.forced, true);
        // a tenant cannot force: the flag is the operator's.
        world.onboarding.set(TENANT, 'in_progress');
        const viaTenant = await tenantStart({ force: true });
        assert.equal(viaTenant.body.reused, true);
    });

    it('advance on a tenant with no draft STARTS one from what was typed and then advances it: what the Tenants screen fires after creating a tenant', async () => {
        const r = await adminAdvance();
        assert.equal(r.status, 200);
        assert.equal(r.body.draft.status, 'ready');
        assert.equal(r.body.advance.outcome, 'worked');
        assert.equal(world.drafts.length, 1);
        assert.equal(world.drafts[0]!.origin, 'admin_create');
        assert.equal(world.audits.filter((a) => a.action === AUDIT_ACTIONS.onboardingDraftStart).length, 1);
    });

    it('advance with no draft and nothing typed is a 400, not a draft of nothing', async () => {
        world.creators.set(OTHER, { ...world.creators.get(OTHER)!, instagram_username: null, website_url: null });
        const r = await adminAdvance({}, OTHER);
        assert.deepEqual([r.status, r.body.code], [400, 'NO_INPUTS']);
        assert.equal(world.drafts.length, 0);
    });

    it('advance twice is one draft: the second finds it finished and does nothing', async () => {
        await adminAdvance();
        const again = await adminAdvance();
        assert.equal(again.body.advance.outcome, 'terminal');
        assert.equal(aiCalls.length, 2);
        assert.equal(world.drafts.length, 1);
    });

    it('advance on a draft that was replaced works on the replacement, never the old one', async () => {
        await adminStart();
        const b = await adminStart({ website: 'https://different.example/' });
        const r = await adminAdvance();
        assert.equal(r.body.draft.id, b.body.draft.id);
    });
});

// ─── The sweep ──────────────────────────────────────────────────────────────────────────────

describe('POST /api/onboarding/drafts/sweep', () => {
    const sweep = (over: CallOptions = {}) => call(apiRouter, 'POST', '/onboarding/drafts/sweep', over);
    const secret = 'Bearer cron-secret-for-tests';

    it('is guarded like the drain: no header, a wrong one, the wrong scheme and a query-string token are all 401 and work on nothing', async () => {
        await call(onboardingDraftsRouter, 'POST', '/draft', { ...asOwner, body: {} });
        for (const over of [{}, { bearer: 'Bearer nope' }, { bearer: 'cron-secret-for-tests' }, { bearer: 'Basic cron-secret-for-tests' }, { query: { token: 'cron-secret-for-tests' } }, { session: ADMIN }]) {
            const r = await sweep(over);
            assert.equal(r.status, 401, JSON.stringify(over));
        }
        assert.equal(world.drafts[0]!.status, 'queued');
        assert.ok(logs.some((l) => l.event === 'cron.unauthorized' && l.route === '/api/onboarding/drafts/sweep'));
    });

    it('fails closed when CRON_SECRET is not set', async () => {
        const previous = process.env.CRON_SECRET;
        delete process.env.CRON_SECRET;
        try {
            const r = await sweep({ bearer: 'Bearer ' });
            assert.equal(r.status, 500);
            assert.match(r.body.error, /CRON_SECRET not configured/);
        } finally {
            process.env.CRON_SECRET = previous;
        }
    });

    it('with the secret it advances what is due and says what it did', async () => {
        await call(onboardingDraftsRouter, 'POST', '/draft', { ...asOwner, body: {} });
        const r = await sweep({ bearer: secret });
        assert.equal(r.status, 200);
        assert.deepEqual([r.body.considered, r.body.advanced, r.body.finished], [1, 1, 1]);
        assert.equal(world.drafts[0]!.status, 'ready');
        assert.ok(typeof r.body.elapsed_ms === 'number');
    });

    it('with nothing due it is cheap and says so', async () => {
        const r = await sweep({ bearer: secret });
        assert.deepEqual([r.status, r.body.considered, r.body.advanced], [200, 0, 0]);
    });

    it('is a POST: a GET is not a sweep (a link prefetcher must not start spending) and falls through to authentication', async () => {
        const r = await call(apiRouter, 'GET', '/onboarding/drafts/sweep', { bearer: secret });
        assert.notEqual(r.status, 200);
        assert.equal(world.drafts.length, 0);
    });

    it('is mounted above authentication, with the other routes a scheduler calls, and is a route of its own beside the drain', () => {
        const stack = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: { path: string; methods: Record<string, boolean> } }> }).stack;
        const at = stack.findIndex((l) => l.route?.path === '/onboarding/drafts/sweep' && l.route.methods.post);
        const auth = stack.findIndex((l) => !l.route && l.handle === requireAuth);
        const drain = stack.findIndex((l) => l.route?.path === '/jobs/drain');
        assert.ok(at >= 0 && auth >= 0 && drain >= 0);
        assert.ok(at < auth, 'the worker has no session: it is above requireAuth');
        assert.notEqual(at, drain, 'it is not part of the drain, which a draft\'s minutes would hold up');
    });
});
