/**
 * A switched-off module is REFUSED by the server (U3, contract §1.5 and §12.2): `requireModule` per `MODULE_API_PREFIXES`, mounted on the real API
 * router right below `resolveTenant`.
 *
 * Two halves, because a gate that is only tested in isolation is the failure `api.test.ts`'s "tenant role guards" were written against:
 *
 *   - **The mount** is read off the router's own stack: every row of `MODULE_API_PREFIXES` is a non-route layer carrying its `moduleId`, directly after
 *     `resolveTenant` and above every router and route, in the table's order; `refuseOffPlatforms` follows them.
 *   - **The behaviour** drives a request through exactly those layers (the way Express would, prefix by prefix) for a COMPANY workspace (the five
 *     modules) and for a workspace with everything on, and checks what is refused and what is not: 404 `MODULE_OFF { module }`, the two exemptions,
 *     the platform-in-a-post check, and the two gates that were already there (`ADS_DISABLED`, `EXPLAINERS_DISABLED`), which the module gate leaves alone.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import { invalidateTenantCache, resolveTenant } from './tenant.js';
import { setLogSink } from '../utils/log.js';
import { invalidateModulesCache, MODULE_API_PREFIXES, MODULE_IDS, refuseOffPlatforms, type ModuleId } from './modules.js';
import apiRouter from '../routes/api.js';
import { adsRouter } from '../routes/ads.js';
import { studioRouter } from '../routes/studio.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const EVERYTHING = '33333333-3333-4333-8333-333333333333';
const LEGACY = '44444444-4444-4444-8444-444444444444';

const COMPANY_DOC = { v: 1, on: ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'], preset: 'company', metaConnect: 'self' };

interface Layer { route?: unknown; handle: any }
const stack = (apiRouter as unknown as { stack: Layer[] }).stack;
const resolveTenantAt = stack.findIndex((layer) => !layer.route && layer.handle === resolveTenant);
const afterResolve = stack.slice(resolveTenantAt + 1);

let db: FakeDb;
let settings: Map<string, string>;
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    invalidateModulesCache();
    invalidateTenantCache();
    const previous = setLogSink(() => undefined);
    restoreSink = () => setLogSink(previous);
    settings = new Map([[`tenant.modules.${COMPANY}`, JSON.stringify(COMPANY_DOC)]]);
    db = installFakeDb({ platformTenant: OWNER });
    db.routes.push([/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, ([key]) => (settings.has(key) ? { rows: [{ value: settings.get(key), is_secret: false }] } : { rows: [] })]);
});

afterEach(() => {
    db.restore();
    restoreSink?.();
    invalidateModulesCache();
});

interface Outcome { reached: boolean; status: number; body: any }

/** A request through the module layers of the real API router, as Express walks them: a layer runs when its prefix matches, with the path relative to it. */
async function through(method: string, url: string, tenantId: string, body: Record<string, unknown> = {}): Promise<Outcome> {
    const guards = afterResolve.filter((layer) => !layer.route && typeof layer.handle?.moduleId === 'string');
    assert.equal(guards.length, MODULE_API_PREFIXES.length);
    const outcome: Outcome = { reached: false, status: 0, body: null };
    const res = {
        status(code: number) { outcome.status = code; return this; },
        json(payload: unknown) { outcome.body = payload; return this; },
    } as unknown as Response;
    const layers: Array<{ prefix: string; handle: (req: Request, res: Response, next: NextFunction) => unknown }> = [
        ...guards.map((layer, i) => ({ prefix: MODULE_API_PREFIXES[i]!.prefix, handle: layer.handle })),
        { prefix: '/posts/scheduled', handle: refuseOffPlatforms },
    ];
    for (const { prefix, handle } of layers) {
        if (url !== prefix && !url.startsWith(`${prefix}/`)) continue;
        const rest = url.slice(prefix.length) || '/';
        const req = { method, originalUrl: url, url: rest, path: rest, body, session: { userId: 'u', role: 'user', tenantId } } as unknown as Request;
        let advanced = false;
        await handle(req, res, (() => { advanced = true; }) as NextFunction);
        if (!advanced) return outcome;
    }
    outcome.reached = true;
    return outcome;
}

describe('the mount', () => {
    it('puts one non-route layer per MODULE_API_PREFIXES row directly below resolveTenant, in the table\'s order, each carrying its module id', () => {
        assert.ok(resolveTenantAt >= 0, 'resolveTenant is mounted');
        const rows = MODULE_API_PREFIXES;
        const mounted = afterResolve.slice(0, rows.length);
        assert.deepEqual(mounted.map((l) => l.route === undefined), rows.map(() => true), 'no route among them');
        assert.deepEqual(mounted.map((l) => l.handle.moduleId), rows.map((r) => r.module));
        assert.equal(afterResolve[rows.length]!.handle, refuseOffPlatforms, 'then the platform check for the Scheduler\'s posts');
    });

    it('is above every router and route a module owns (nothing below resolveTenant comes before the gates)', () => {
        const gateEnd = MODULE_API_PREFIXES.length + 1;
        assert.ok(afterResolve.slice(0, gateEnd).every((l) => !l.route));
        assert.equal(afterResolve.slice(gateEnd).some((l) => typeof l.handle?.moduleId === 'string'), false, 'no gate hides further down');
    });

    it('names only real, doc-stored modules: `ads` and `explainers` keep their own gates', () => {
        for (const row of MODULE_API_PREFIXES) {
            assert.ok((MODULE_IDS as readonly string[]).includes(row.module), row.module);
            assert.notEqual(row.module, 'ads');
            assert.notEqual(row.module, 'explainers');
            assert.notEqual(row.module, 'knowledge');
            assert.match(row.prefix, /^\/[a-z-]+(\/[a-z-]+)*$/, row.prefix);
        }
    });

    it('lists the ten the contract lists, and the Studio\'s time-zone read as its one exemption', () => {
        assert.deepEqual(
            [...new Set(MODULE_API_PREFIXES.map((r) => r.module))].sort(),
            ['dm_assistant', 'growth', 'inbox', 'keyword_replies', 'muse', 'scheduler', 'studio', 'tiktok', 'whatsapp', 'youtube'],
        );
        assert.deepEqual(MODULE_API_PREFIXES.find((r) => r.prefix === '/studio')!.exceptGet, ['/settings']);
        assert.deepEqual(MODULE_API_PREFIXES.filter((r) => r.exceptGet).map((r) => r.prefix), ['/studio']);
    });
});

describe('a company workspace: the modules it has not are refused (404 MODULE_OFF)', () => {
    const REFUSED: Array<[string, string, ModuleId, Record<string, unknown>?]> = [
        ['GET', '/studio/status', 'studio'],
        ['GET', '/studio/drafts', 'studio'],
        ['POST', '/studio/monteur/run', 'studio'],
        ['GET', '/growth/overview', 'growth'],
        ['GET', '/growth/status', 'growth'],
        ['GET', '/tiktok/connection', 'tiktok'],
        ['GET', '/youtube/connection', 'youtube'],
        ['GET', '/whatsapp/connection', 'whatsapp'],
        ['POST', '/settings/ai/muse', 'muse'],
        ['GET', '/settings/ai/muse/library', 'muse'],
    ];
    for (const [method, url, module, body] of REFUSED) {
        it(`${method} ${url} → 404 MODULE_OFF { module: '${module}' }`, async () => {
            const out = await through(method, url, COMPANY, body);
            assert.equal(out.reached, false);
            assert.equal(out.status, 404);
            assert.equal(out.body.code, 'MODULE_OFF');
            assert.deepEqual(out.body.params, { module });
            assert.equal(out.body.error, 'This is not part of this workspace.');
            assert.equal(out.body.message, out.body.error);
        });
    }

    it('GET /dm/funnel and the DM assistant\'s routes are refused when dm_assistant is off, and reached when it is on', async () => {
        settings.set(`tenant.modules.${COMPANY}`, JSON.stringify({ ...COMPANY_DOC, on: ['inbox', 'results'] }));
        for (const url of ['/dm/funnel', '/settings/ai', '/settings/ai/test', '/settings/sales-followup', '/settings/sales-variants', '/dm/ice-breakers', '/dm/ice-breakers/live']) {
            const out = await through('GET', url, COMPANY);
            assert.equal(out.status, 404, url);
            assert.deepEqual(out.body.params, { module: 'dm_assistant' }, url);
        }
        invalidateModulesCache();
        settings.set(`tenant.modules.${COMPANY}`, JSON.stringify(COMPANY_DOC));
        for (const url of ['/dm/funnel', '/settings/ai', '/settings/sales-followup', '/dm/ice-breakers']) assert.equal((await through('GET', url, COMPANY)).reached, true, url);
    });

    it('refuses each module\'s own routes when only that module is off: campaigns, conversations and the scheduler follow their own switch', async () => {
        const table: Array<[string, string, ModuleId]> = [
            ['GET', '/campaigns', 'keyword_replies'], ['POST', '/campaigns/try', 'keyword_replies'], ['GET', '/conversations', 'inbox'],
            ['GET', '/conversations/abc/messages', 'inbox'], ['GET', '/posts/scheduled', 'scheduler'], ['POST', '/posts/scheduled/abc/publish-now', 'scheduler'],
        ];
        for (const [method, url, module] of table) {
            invalidateModulesCache();
            settings.set(`tenant.modules.${COMPANY}`, JSON.stringify({ ...COMPANY_DOC, on: COMPANY_DOC.on.filter((id) => id !== module && !(module === 'inbox' && id === 'dm_assistant')) }));
            const off = await through(method, url, COMPANY);
            assert.equal(off.status, 404, `${method} ${url}`);
            assert.deepEqual(off.body.params, { module }, `${method} ${url}`);
            invalidateModulesCache();
            settings.set(`tenant.modules.${COMPANY}`, JSON.stringify(COMPANY_DOC));
            assert.equal((await through(method, url, COMPANY)).reached, true, `${method} ${url} with it on`);
        }
    });

    it('lets what the company has through to its routers', async () => {
        for (const [method, url] of [['GET', '/campaigns'], ['GET', '/conversations'], ['GET', '/posts/scheduled'], ['GET', '/settings/ai'], ['GET', '/dm/funnel']] as const) {
            assert.equal((await through(method, url, COMPANY)).reached, true, `${method} ${url}`);
        }
    });
});

describe('what is NOT gated, by design', () => {
    it('GET /studio/settings stays open (the Scheduler reads the workspace time zone from it), but its write and every other Studio route are gated', async () => {
        assert.equal((await through('GET', '/studio/settings', COMPANY)).reached, true);
        assert.equal((await through('GET', '/studio/settings/', COMPANY)).reached, true, 'a trailing slash is the same route');
        assert.equal((await through('PUT', '/studio/settings', COMPANY)).status, 404, 'only the READ is exempt');
        assert.equal((await through('GET', '/studio/settings/extra', COMPANY)).status, 404);
        assert.equal((await through('GET', '/studio/status', COMPANY)).status, 404);
    });

    it('GET /posts/live stays open: the Keyword replies post picker reads it, with or without the Scheduler', async () => {
        settings.set(`tenant.modules.${COMPANY}`, JSON.stringify({ ...COMPANY_DOC, on: ['keyword_replies'] }));
        assert.equal((await through('GET', '/posts/live', COMPANY)).reached, true);
        assert.equal((await through('GET', '/posts/scheduled', COMPANY)).status, 404);
    });

    it('leaves every route no module owns alone: stats, interactions, uploads, the profile, Meta, onboarding, attention and tenant health', async () => {
        settings.set(`tenant.modules.${COMPANY}`, JSON.stringify({ ...COMPANY_DOC, on: [] }));
        for (const url of ['/stats', '/stats/campaigns', '/interactions', '/upload', '/uploads/abc', '/profile', '/profile/progress', '/meta/connection', '/onboarding',
            '/attention', '/health/tenant', '/settings/webhook-token', '/settings/token/status', '/settings/notify', '/auth/me']) {
            assert.equal((await through('GET', url, COMPANY)).reached, true, url);
        }
    });

    it('does not mistake a longer path for a prefix: `/campaignsX` and `/studios` are nobody\'s', async () => {
        assert.equal((await through('GET', '/campaignsX', COMPANY)).reached, true);
        assert.equal((await through('GET', '/studios', COMPANY)).reached, true);
        assert.equal((await through('GET', '/settings/ai-providers', COMPANY)).reached, true);
    });
});

describe('a post for a platform the workspace does not have', () => {
    it('POST /posts/scheduled for TikTok is 404 MODULE_OFF tiktok, and so is a post that only ALSO goes to TikTok', async () => {
        for (const body of [{ platform: 'tiktok' }, { platform: 'both', also_tiktok: true }, { platform: 'instagram', also_tiktok: true }]) {
            const out = await through('POST', '/posts/scheduled', COMPANY, body);
            assert.equal(out.status, 404, JSON.stringify(body));
            assert.deepEqual(out.body.params, { module: 'tiktok' }, JSON.stringify(body));
            assert.equal(out.body.code, 'MODULE_OFF');
        }
    });

    it('POST for YouTube is 404 MODULE_OFF youtube, and an edit (PUT /posts/scheduled/:id) is checked the same way', async () => {
        const post = await through('POST', '/posts/scheduled', COMPANY, { platform: 'youtube' });
        assert.deepEqual(post.body.params, { module: 'youtube' });
        const put = await through('PUT', '/posts/scheduled/abc', COMPANY, { platform: 'tiktok' });
        assert.equal(put.status, 404);
        assert.deepEqual(put.body.params, { module: 'tiktok' });
    });

    it('lets an Instagram or Facebook post through, and never reads the body of anything that is not a create or an edit', async () => {
        for (const body of [{ platform: 'instagram' }, { platform: 'facebook', also_tiktok: false }, { platform: 'both' }, {}]) {
            assert.equal((await through('POST', '/posts/scheduled', COMPANY, body)).reached, true, JSON.stringify(body));
        }
        for (const [method, url] of [['POST', '/posts/scheduled/abc/publish-now'], ['POST', '/posts/scheduled/abc/archive'], ['DELETE', '/posts/scheduled/abc'], ['GET', '/posts/scheduled']] as const) {
            assert.equal((await through(method, url, COMPANY, { platform: 'tiktok' })).reached, true, `${method} ${url}`);
        }
    });

    it('lets a TikTok post through once TikTok is on', async () => {
        settings.set(`tenant.modules.${COMPANY}`, JSON.stringify({ ...COMPANY_DOC, on: [...COMPANY_DOC.on, 'tiktok'] }));
        invalidateModulesCache();
        assert.equal((await through('POST', '/posts/scheduled', COMPANY, { platform: 'tiktok' })).reached, true);
        assert.equal((await through('POST', '/posts/scheduled', COMPANY, { platform: 'youtube' })).status, 404, 'YouTube is still off');
    });
});

describe('with every module on, or no document at all, every module route reaches its router', () => {
    it('a workspace with no document (legacy) and one whose document lists everything', async () => {
        settings.set(`tenant.modules.${EVERYTHING}`, JSON.stringify({ ...COMPANY_DOC, on: MODULE_IDS.filter((id) => id !== 'knowledge' && id !== 'ads' && id !== 'explainers') }));
        for (const tenant of [LEGACY, EVERYTHING, OWNER]) {
            for (const row of MODULE_API_PREFIXES) {
                const out = await through('GET', `${row.prefix}/anything`, tenant);
                // The Studio's exemption is for `/settings`; everything else is reached because the module is on.
                assert.equal(out.reached, true, `${row.prefix} for ${tenant}`);
            }
            assert.equal((await through('POST', '/posts/scheduled', tenant, { platform: 'tiktok', also_tiktok: true })).reached, true);
        }
    });

    it('is the owner\'s case too: his workspace is never narrowed, whatever his document says', async () => {
        settings.set(`tenant.modules.${OWNER}`, JSON.stringify({ ...COMPANY_DOC, on: [] }));
        for (const row of MODULE_API_PREFIXES) assert.equal((await through('GET', `${row.prefix}/anything`, OWNER)).reached, true, row.prefix);
    });
});

describe('the gates that were already there are left as they are', () => {
    /** Runs a router with a plain request, the way the stack above does. */
    function callRouter(router: unknown, method: string, url: string, tenantId: string): Promise<Outcome> {
        return new Promise((resolve) => {
            const outcome: Outcome = { reached: false, status: 0, body: null };
            const res = {
                statusCode: 200,
                status(code: number) { outcome.status = code; return this; },
                json(payload: unknown) { outcome.body = payload; resolve(outcome); return this; },
                setHeader() { return this; },
            } as unknown as Response;
            const req = { method, url, originalUrl: url, path: url, query: {}, params: {}, headers: {}, body: {}, session: { userId: 'u', role: 'user', tenantId }, tenantRole: 'owner' } as unknown as Request;
            (router as (req: Request, res: Response, next: NextFunction) => void)(req, res, () => { outcome.reached = true; resolve(outcome); });
        });
    }

    it('/ads/overview is 404 ADS_DISABLED for a workspace without the Ads switch, and the module gate does not stand in front of it', async () => {
        assert.equal((await through('GET', '/ads/overview', COMPANY)).reached, true, 'no module gate for /ads');
        const out = await callRouter(adsRouter, 'GET', '/overview', COMPANY);
        assert.equal(out.status, 404);
        assert.equal(out.body.code, 'ADS_DISABLED');
    });

    it('/studio/explainers is 404 EXPLAINERS_DISABLED, and the Studio gate lets it through to its own answer (not MODULE_OFF studio)', async () => {
        assert.equal((await through('GET', '/studio/explainers', COMPANY)).reached, true, 'the Studio gate lets /explainers through');
        assert.equal((await through('GET', '/studio/explainers/allowance', COMPANY)).reached, true);
        const out = await callRouter(studioRouter, 'GET', '/explainers', COMPANY);
        assert.equal(out.status, 404);
        assert.equal(out.body.code, 'EXPLAINERS_DISABLED');
    });
});
