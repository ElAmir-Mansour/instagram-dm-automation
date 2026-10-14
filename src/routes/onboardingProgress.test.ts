/**
 * The two routes the Overview card and the Operations card read (P30, P31):
 *
 *   `GET /api/profile/progress`            the completeness meter and the next three actions, for the session's tenant
 *   `GET /api/admin/onboarding/funnel`     the invite-to-finished funnel, platform admin only
 *
 * What is pinned:
 *   - the owner's card is his real state over what his setup holds, with nothing to nag about, and a new tenant's is not;
 *   - the card is for an operator or an owner, says whether this session may carry its actions out, and is a viewer's no;
 *   - it carries ids, paths and numbers: nothing the tenant typed;
 *   - the funnel is for a platform admin and nobody else (404, not 403), takes 30 or 90 days, and is read-only and uncached.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { CONNECTIONS_SQL } from '../services/profile/progress.js';
import { defaultProfile } from '../services/profile/defaults.js';
import { setPlatformOwner, studioRow } from '../services/profile/testDb.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import { ELAMIR_SEED_SETTINGS } from '../services/studio/testFixtures.js';
import { invalidateTenantCache, type TenantRole } from '../services/tenant.js';
import { FUNNEL_EVENTS_SQL, FUNNEL_STEP_TIMES_SQL } from '../services/onboardingFunnel.js';
import { addNewcomer, ADMIN_USER, installOnboardingWorld, NEW_OWNER_USER, NEWCOMER, OWNER, OWNER_USER, type OnboardingWorld } from '../services/wizard/testDb.js';
import { setLogSink } from '../utils/log.js';
import type { CreatorProfile } from '../services/profile/types.js';
import adminRouter from './admin.js';
import { profileRouter } from './profile.js';

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: any }[] } }
interface Reply { status: number; body: any; headers: Record<string, string> }

async function progress(options: { tenant?: string; user?: string; role?: TenantRole | null } = {}): Promise<Reply> {
    const layer = (profileRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === '/progress' && l.route.methods.get);
    assert.ok(layer, 'GET /progress must be mounted');
    const reply: Reply = { status: 200, body: null, headers: {} };
    const res = {
        status(code: number) { reply.status = code; return this; },
        json(payload: unknown) { reply.body = payload; return this; },
    } as unknown as Response;
    const req = {
        method: 'GET', originalUrl: '/progress', params: {}, query: {}, headers: {}, body: {},
        session: { userId: options.user ?? NEW_OWNER_USER, role: 'user', tenantId: options.tenant ?? NEWCOMER },
        tenantRole: options.role === undefined ? 'owner' : options.role ?? undefined,
    } as unknown as Request;
    for (const inner of layer!.route!.stack) {
        let advanced = false;
        await inner.handle(req, res, (() => { advanced = true; }) as NextFunction);
        if (!advanced) break;
    }
    return reply;
}

function admin(url: string, session: Record<string, unknown> | null, query: Record<string, unknown> = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const sent: Record<string, string> = {};
        const req = { method: 'GET', url, originalUrl: url, body: {}, query, params: {}, headers: {}, session: session ?? undefined } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload, headers: sent }); return this; },
            setHeader(name: string, value: string) { sent[name.toLowerCase()] = String(value); return this; },
            set(name: string, value: string) { sent[name.toLowerCase()] = String(value); return this; },
        } as unknown as Response;
        (adminRouter as unknown as (r: Request, s: Response, n: () => void) => void)(req, res, () => resolve({ status: 0, body: { fellThrough: true }, headers: sent }));
    });
}

const flat = (sql: string): RegExp => new RegExp(`^${sql.replace(/\s+/g, ' ').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

const edit = (profile: CreatorProfile, change: (p: CreatorProfile) => void): CreatorProfile => {
    const copy = structuredClone(profile);
    change(copy);
    return copy;
};
const FINISHED: CreatorProfile = edit(defaultProfile({ lang: 'en', rules: [] }), (p) => {
    p.identity = { ...p.identity, display_name: { ar: '', en: 'Nour Shop' }, kind: 'shop', niche: 'Linen homewares', timezone: 'Europe/London' };
    p.offers = [{ id: 'main', kind: 'product', name: 'Linen throw', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }];
});

let world: OnboardingWorld;
let connections: Map<string, { meta: boolean; tiktok: boolean; youtube: boolean; dm: boolean }>;
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    invalidateTenantCache();
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    world = installOnboardingWorld();
    setPlatformOwner(world.db, OWNER);
    connections = new Map();
    world.db.routes.push([flat(CONNECTIONS_SQL), ([id]) => ({ rows: [connections.get(id) ?? { meta: false, tiktok: false, youtube: false, dm: false }] })]);
});
afterEach(() => {
    world.restore();
    restoreSink?.();
    invalidateTenantCache();
});

describe('GET /api/profile/progress', () => {
    it('is mounted on the profile router, below resolveTenant, for an operator or an owner', async () => {
        addNewcomer(world, throughJsonb(FINISHED), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        for (const role of ['owner', 'operator'] as const) assert.equal((await progress({ role })).status, 200, role);
        assert.equal((await progress({ role: 'viewer' })).status, 403, 'it holds the shape of how the account is run');
    });

    it('says whether this session may carry the actions out: the sheets write the profile, which is the owner\'s', async () => {
        addNewcomer(world, throughJsonb(FINISHED), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        assert.equal((await progress({ role: 'owner' })).body.canEdit, true);
        assert.equal((await progress({ role: 'operator' })).body.canEdit, false);
    });

    it('describes a new tenant that has finished the wizard: its percent, what is missing and three things to do', async () => {
        addNewcomer(world, throughJsonb(FINISHED), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        const { status, body } = await progress();
        assert.equal(status, 200);
        assert.equal(body.percent, 46);
        assert.equal(body.complete, false);
        assert.equal(body.legacy, false);
        assert.equal(body.dm, false);
        assert.deepEqual(body.connections, { meta: false, tiktok: false, youtube: false });
        assert.deepEqual(body.actions.map((a: any) => a.id), ['connect_meta', 'voice_samples', 'presenter']);
        assert.deepEqual(body.actions[1].link, { kind: 'ask', fields: ['voice.samples'] });
        assert.deepEqual(body.missing.map((m: any) => m.field), ['voice_samples', 'portrait', 'presenter', 'audience']);
    });

    it('reads what is connected, and whether the DM bot is on, and counts the hand-off rule only while it is', async () => {
        addNewcomer(world, throughJsonb(FINISHED), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        connections.set(NEWCOMER, { meta: true, tiktok: true, youtube: false, dm: true });
        const { body } = await progress();
        assert.deepEqual(body.connections, { meta: true, tiktok: true, youtube: false });
        assert.equal(body.dm, true);
        assert.deepEqual(body.actions.map((a: any) => a.id), ['voice_samples', 'dm_handoff', 'presenter']);
        assert.equal(body.percent, 41, '35 of 86');
    });

    it('describes the owner as he is: over what his setup holds, never nagged, and still told what is really undone', async () => {
        world.state.studio.set(OWNER, studioRow(ELAMIR_SEED_SETTINGS));
        connections.set(OWNER, { meta: true, tiktok: true, youtube: true, dm: true });
        const { body } = await progress({ tenant: OWNER, user: OWNER_USER });
        assert.equal(body.legacy, true);
        assert.equal(body.dm, true, 'his DM bot is on (it is, in production)');
        assert.equal(body.percent, 71, 'the fixture has no portrait: 25 of 35');
        assert.deepEqual(body.actions.map((a: any) => a.id), ['portrait']);
        assert.deepEqual(body.missing.map((m: any) => m.field), ['portrait']);
        for (const id of ['finish_setup', 'voice_samples', 'dm_handoff', 'presenter', 'audience']) assert.equal(body.actions.some((a: any) => a.id === id), false, id);
    });

    it('describes the owner as legacy even when his onboarding row says otherwise: he is the owner', async () => {
        world.state.studio.set(OWNER, studioRow(ELAMIR_SEED_SETTINGS));
        world.onboarding.set(OWNER, { status: 'invited', current_step: null, steps: {}, filled_by: null, started_at: null, completed_at: null });
        connections.set(OWNER, { meta: true, tiktok: true, youtube: true, dm: true });
        assert.equal((await progress({ tenant: OWNER, user: OWNER_USER })).body.legacy, true);
    });

    it('treats a tenant that predates onboarding like him: no row, or a completed row nobody filled in', async () => {
        addNewcomer(world, throughJsonb(defaultProfile({ lang: 'ar' })), { status: 'completed', filled_by: null, completed_at: new Date(0) });
        assert.equal((await progress()).body.legacy, true);
        world.onboarding.delete(NEWCOMER);
        assert.equal((await progress()).body.legacy, true);
    });

    it('does not treat a tenant that went through the wizard as legacy, whoever filled it in', async () => {
        for (const filled_by of ['tenant', 'admin']) {
            addNewcomer(world, throughJsonb(FINISHED), { status: 'completed', filled_by, completed_at: new Date() });
            assert.equal((await progress()).body.legacy, false, filled_by);
        }
    });

    it('carries ids, paths and numbers and nothing the tenant typed', async () => {
        addNewcomer(world, throughJsonb(edit(FINISHED, (p) => { p.identity.niche = 'My secret niche'; p.audience.description = 'Private audience text'; })), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        const text = JSON.stringify((await progress()).body);
        for (const secret of ['secret', 'Private', 'Nour', 'Linen']) assert.equal(text.includes(secret), false, secret);
        assert.deepEqual(Object.keys((await progress()).body).sort(), ['actions', 'canEdit', 'complete', 'connections', 'dm', 'legacy', 'missing', 'percent']);
    });

    it('only reads: not one statement of it writes', async () => {
        addNewcomer(world, throughJsonb(FINISHED), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        await progress();
        assert.deepEqual(world.db.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql)), []);
    });

    it('answers a failure with a 500 the dashboard answers by leaving the card out, never a half-built card', async () => {
        addNewcomer(world, throughJsonb(FINISHED), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        world.db.failOn = /FROM creators c WHERE c\.id = \$1/;
        const reply = await progress();
        assert.equal(reply.status, 500);
        assert.deepEqual(Object.keys(reply.body), ['error']);
    });
});

describe('GET /api/admin/onboarding/funnel', () => {
    const ADMIN = { userId: ADMIN_USER, role: 'platform_admin', tenantId: OWNER, tokenVersion: 0 };
    const TENANT_OWNER = { userId: NEW_OWNER_USER, role: 'user', tenantId: NEWCOMER, tokenVersion: 0 };
    const NOW = Date.now();

    beforeEach(() => {
        world.db.routes.push([flat(FUNNEL_EVENTS_SQL), () => ({ rows: [
            { creator_id: 'a', event: 'invite_created', step: null, first_at: new Date(NOW - 86_400_000), last_at: new Date(NOW - 86_400_000), n: 1 },
            { creator_id: 'a', event: 'invite_opened', step: null, first_at: new Date(NOW - 86_400_000 + 60_000), last_at: new Date(NOW - 86_400_000 + 60_000), n: 1 },
        ] })]);
        world.db.routes.push([flat(FUNNEL_STEP_TIMES_SQL), () => ({ rows: [] })]);
    });

    it('is for a platform admin: every other session is answered 404, and no query runs', async () => {
        for (const session of [TENANT_OWNER, { ...TENANT_OWNER, role: 'viewer' }, null]) {
            const reply = await admin('/onboarding/funnel', session);
            assert.equal(reply.status, 404);
            assert.deepEqual(reply.body, { error: 'Not found.' });
        }
        assert.deepEqual(world.db.statements, []);
    });

    it('answers the last 30 days by default, or 90 when asked, uncached', async () => {
        const thirty = await admin('/onboarding/funnel', ADMIN);
        assert.equal(thirty.status, 200);
        assert.equal(thirty.body.days, 30);
        assert.equal(thirty.headers['cache-control'], 'no-store');
        const ninety = await admin('/onboarding/funnel', ADMIN, { days: '90' });
        assert.equal(ninety.body.days, 90);
        assert.deepEqual(thirty.body.stages.map((s: any) => [s.id, s.reached]).slice(0, 3), [['invited', 1], ['opened', 1], ['accepted', 0]]);
        assert.equal(thirty.body.medians.invite_to_open_ms, 60_000);
    });

    it('refuses any other window, and a list or an object where one number belongs', async () => {
        for (const days of ['7', '0', '3650', 'abc', ['30', '90'], { a: '1' }]) {
            const reply = await admin('/onboarding/funnel', ADMIN, { days });
            assert.equal(reply.status, 400, JSON.stringify(days));
            assert.deepEqual(reply.body, { error: 'days must be 30 or 90.' });
        }
    });

    it('is read-only, and holds no tenant\'s id', async () => {
        const reply = await admin('/onboarding/funnel', ADMIN);
        assert.equal(JSON.stringify(reply.body).includes('"a"'), false);
        assert.deepEqual(world.db.statements.filter((s) => !/^SELECT /.test(s.sql)), []);
    });

    it('is mounted below the admin router\'s own platform-admin gate, and gated again by its own', () => {
        const source = readFileSync(new URL('./admin.ts', import.meta.url), 'utf8');
        const gate = source.indexOf('router.use(requirePlatformAdmin);');
        const mount = source.indexOf("router.use('/onboarding', onboardingFunnelRouter);");
        assert.ok(gate > 0 && mount > gate, 'nothing of the funnel is reachable above the gate');
        assert.match(readFileSync(new URL('./adminOnboarding.ts', import.meta.url), 'utf8'), /req\.session\?\.role !== 'platform_admin'/, 'and the sub-router checks the role itself');
    });
});
