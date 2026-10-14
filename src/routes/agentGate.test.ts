/**
 * The agent gate at the routes that switch an agent on (P30): the Studio's writer, the Monteur, the Growth coach and the DM bot.
 *
 * Driven through the real routers' own handler stacks against the in-memory stand-in for the wizard's and the profile's tables. What is
 * pinned, because each is a way the gate lets somebody down:
 *
 *   - **a new tenant that lacks something is refused at each switch** with `409 PROFILE_INCOMPLETE`, `agent`, `missing` and `fixStep`,
 *     and the refusal wrote nothing;
 *   - **only the switch is gated.** Saving the DM prompt on a bot that is already on or off, changing any Monteur setting but turning it
 *     ON, and turning it on when it is already on, never ask: that would be a gate on a running path;
 *   - **the owner is never gated**, at any of them, with his real gaps; neither is a tenant that predates onboarding;
 *   - **nothing that runs by itself imports the gate**: the webhook, the queue, the cron and the services never come here.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { defaultProfile } from '../services/profile/defaults.js';
import { setPlatformOwner, studioRow } from '../services/profile/testDb.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import { defaultMonteurConfig } from '../services/studio/settingsTypes.js';
import { ELAMIR_SEED_SETTINGS } from '../services/studio/testFixtures.js';
import { invalidateTenantCache, type TenantRole } from '../services/tenant.js';
import { addNewcomer, installOnboardingWorld, NEW_OWNER_USER, NEWCOMER, OWNER, OWNER_USER, type OnboardingWorld } from '../services/wizard/testDb.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { growthRouter } from './growth.js';
import { studioRouter } from './studio.js';
import type { CreatorProfile } from '../services/profile/types.js';

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: any }[] } }
interface Reply { status: number; body: any }

async function run(
    router: unknown, method: 'get' | 'put' | 'post', routePath: string,
    options: { tenant?: string; user?: string; role?: TenantRole; body?: unknown } = {}
): Promise<Reply> {
    const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === routePath && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${routePath} must be mounted`);
    const reply: Reply = { status: 200, body: null };
    const res = {
        status(code: number) { reply.status = code; return this; },
        json(payload: unknown) { reply.body = payload; return this; },
        setHeader() { return this; },
    } as unknown as Response;
    const req = {
        method: method.toUpperCase(), originalUrl: routePath, params: {}, query: {}, headers: {}, body: options.body ?? {},
        session: { userId: options.user ?? NEW_OWNER_USER, role: 'user', tenantId: options.tenant ?? NEWCOMER },
        tenantRole: options.role ?? 'owner',
    } as unknown as Request;
    for (const inner of layer!.route!.stack) {
        let advanced = false;
        await inner.handle(req, res, (() => { advanced = true; }) as NextFunction);
        if (!advanced) break;
    }
    return reply;
}

const edit = (profile: CreatorProfile, change: (p: CreatorProfile) => void): CreatorProfile => {
    const copy = structuredClone(profile);
    change(copy);
    return copy;
};

/** A tenant that has finished the wizard: the six activation fields, nothing else. */
const FINISHED: CreatorProfile = edit(defaultProfile({ lang: 'en', rules: [] }), (p) => {
    p.identity = { ...p.identity, display_name: { ar: '', en: 'Nour Shop' }, kind: 'shop', niche: 'Linen homewares', timezone: 'Europe/London' };
    p.offers = [{ id: 'main', kind: 'product', name: 'Linen throw', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }];
});

let world: OnboardingWorld;
let agents: Map<string, boolean>;
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    invalidateTenantCache();
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    world = installOnboardingWorld();
    setPlatformOwner(world.db, OWNER);
    agents = new Map();
    world.db.routes.push([/^SELECT is_active FROM ai_agents WHERE creator_id = \$1$/, ([id]) => ({ rows: agents.has(id) ? [{ is_active: agents.get(id) }] : [] })]);
    world.db.routes.push([/^INSERT INTO ai_agents /, ([id, , , , , active]) => {
        agents.set(id, active);
        return { rows: [{ creator_id: id, is_active: active }] };
    }]);
});

afterEach(() => {
    world.restore();
    restoreSink?.();
    invalidateTenantCache();
});

/** A new tenant that finished the wizard (`completed`, filled by the tenant). */
const finishedTenant = (profile: CreatorProfile = FINISHED) => addNewcomer(world, throughJsonb(profile), { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
/** A new tenant that has just been invited and has typed nothing. */
const freshTenant = () => addNewcomer(world, throughJsonb(defaultProfile({ lang: 'ar' })));

const isGate = (reply: Reply): boolean => reply.status === 409 && reply.body?.code === 'PROFILE_INCOMPLETE';
const wroteToAgentOrSettings = () => world.db.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.sql) && /ai_agents|studio_settings|studio_jobs|studio_drafts|carousel_drafts|infographics|growth_settings/.test(s.sql));

describe('the Studio\'s writer', () => {
    it('refuses a tenant that has not told us who it is, at each of its three entry points, and writes nothing', async () => {
        freshTenant();
        for (const [routePath, body] of [['/drafts', { topic: 'x' }], ['/plan', { count: 3 }], ['/infographics', { topic: 'x' }]] as const) {
            const reply = await run(studioRouter, 'post', routePath, { body });
            assert.equal(reply.status, 409, routePath);
            assert.equal(reply.body.code, 'PROFILE_INCOMPLETE');
            assert.equal(reply.body.agent, 'studio');
            assert.ok(reply.body.missing.includes('identity.niche'));
            assert.equal(reply.body.fixStep, 'about');
        }
        assert.deepEqual(wroteToAgentOrSettings(), []);
    });

    it('lets through a tenant that has finished the wizard: the writer needs no more than the six fields', async () => {
        finishedTenant();
        for (const [routePath, body] of [['/drafts', { topic: 'x' }], ['/plan', { count: 3 }], ['/infographics', { topic: 'x' }]] as const) {
            assert.equal(isGate(await run(studioRouter, 'post', routePath, { body })), false, routePath);
        }
    });
});

describe('the Monteur', () => {
    it('refuses to run for a tenant that has no presenter, naming it and sending the person to the sheet', async () => {
        finishedTenant();
        const reply = await run(studioRouter, 'post', '/monteur/run');
        assert.equal(reply.status, 409);
        assert.equal(reply.body.agent, 'monteur');
        assert.deepEqual(reply.body.missing, ['presenter']);
        assert.equal(reply.body.fixStep, 'ask');
    });

    it('refuses to be switched ON without one, and says the same', async () => {
        finishedTenant();
        const reply = await run(studioRouter, 'put', '/settings', { body: { monteur: { enabled: true } } });
        assert.equal(reply.status, 409);
        assert.equal(reply.body.agent, 'monteur');
        assert.deepEqual(reply.body.missing, ['presenter']);
        assert.deepEqual(wroteToAgentOrSettings(), []);
    });

    it('is switched on without a fuss once there is a presenter', async () => {
        finishedTenant(edit(FINISHED, (p) => { p.presenter = { name: 'Nour', pronouns: 'she', on_camera: 'face' }; }));
        assert.equal(isGate(await run(studioRouter, 'put', '/settings', { body: { monteur: { enabled: true } } })), false);
        assert.equal(isGate(await run(studioRouter, 'post', '/monteur/run')), false);
    });

    it('is gated only on the switch: any other setting, turning it OFF, and turning it on when it is on already, never ask', async () => {
        finishedTenant();
        for (const body of [
            { schedule: { timezone: 'Europe/London' } }, { monteur: { enabled: false } }, { monteur: { run_at: '08:00' } },
            { monteur: { enabled: 'true' } }, { monteur: 'on' }, { brand: { name: 'x' } },
        ]) {
            assert.equal(isGate(await run(studioRouter, 'put', '/settings', { body })), false, JSON.stringify(body));
        }
        // Already on: the tenant was let in before, and saving it again is not switching it on.
        world.state.studio.set(NEWCOMER, studioRow({ ...ELAMIR_SEED_SETTINGS, monteur: { ...defaultMonteurConfig(), enabled: true } }));
        assert.equal(isGate(await run(studioRouter, 'put', '/settings', { body: { monteur: { enabled: true } } })), false);
    });
});

describe('the Growth coach', () => {
    it('refuses a tenant that has not said who the content is for', async () => {
        finishedTenant();
        const reply = await run(growthRouter, 'post', '/coach');
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'PROFILE_INCOMPLETE');
        assert.equal(reply.body.agent, 'coach');
        assert.deepEqual(reply.body.missing, ['audience.description']);
        assert.equal(reply.body.fixStep, 'ask');
    });

    it('lets one through that has', async () => {
        finishedTenant(edit(FINISHED, (p) => { p.audience.description = 'Parents with an hour a day'; }));
        assert.equal(isGate(await run(growthRouter, 'post', '/coach')), false);
    });
});

describe('the DM bot', () => {
    const save = (body: Record<string, unknown> = {}, tenant = NEWCOMER) => run(apiRouter, 'post', '/settings/ai', { tenant, body: { system_prompt: 'You are the shop\'s assistant.', ...body } });

    it('refuses to be switched on without a hand-off rule, and says who has to be told and where', async () => {
        finishedTenant();
        agents.set(NEWCOMER, false);
        const reply = await save({ is_active: true });
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'PROFILE_INCOMPLETE');
        assert.equal(reply.body.agent, 'dm');
        assert.deepEqual(reply.body.missing, ['dm.handoff']);
        assert.equal(reply.body.fixStep, 'ask');
        assert.equal(agents.get(NEWCOMER), false, 'the switch did not move');
        assert.equal(world.db.statements.some((s) => /^INSERT INTO ai_agents/.test(s.sql)), false, 'and nothing was written');
    });

    it('treats a first save with no agent row as the switch, because the screen shows the bot on by default', async () => {
        finishedTenant();
        assert.equal((await save({ is_active: true })).status, 409);
        assert.equal((await save({})).status, 409, 'an omitted is_active is on, as the route has always read it');
    });

    it('switches on once the rule is there', async () => {
        finishedTenant(edit(FINISHED, (p) => { p.dm.handoff = { when: 'A refund', message: 'A person will reply.' }; }));
        agents.set(NEWCOMER, false);
        const reply = await save({ is_active: true });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(agents.get(NEWCOMER), true);
    });

    it('never asks when the bot stays off, or when it is on already and only its prompt changes', async () => {
        finishedTenant();
        agents.set(NEWCOMER, false);
        assert.equal((await save({ is_active: false })).status, 200, 'saving a draft of the prompt while it is off');
        agents.set(NEWCOMER, true);
        assert.equal(isGate(await save({ is_active: true })), false, 'on already: this is a save, not a switch');
        assert.equal((await save({ is_active: false })).status, 200, 'turning it off is always allowed');
    });

    it('lets the save through when the agent\'s row cannot be read: the gate is never the reason a tenant cannot work', async () => {
        finishedTenant();
        world.db.failOn = /FROM ai_agents/;
        const reply = await save({ is_active: true });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(agents.get(NEWCOMER), true);
    });

    it('still validates the request first: no prompt is a 400, gate or not', async () => {
        freshTenant();
        const reply = await run(apiRouter, 'post', '/settings/ai', { body: { is_active: true } });
        assert.equal(reply.status, 400);
    });
});

describe('the owner is never gated, at any of them', () => {
    const asOwner = { tenant: OWNER, user: OWNER_USER };

    it('with his real gaps: no niche, no presenter\'s name, no audience, no hand-off rule', async () => {
        world.state.studio.set(OWNER, studioRow(ELAMIR_SEED_SETTINGS));
        agents.set(OWNER, false);
        const replies = [
            await run(studioRouter, 'post', '/drafts', { ...asOwner, body: { topic: 'x' } }),
            await run(studioRouter, 'post', '/plan', { ...asOwner, body: { count: 3 } }),
            await run(studioRouter, 'post', '/infographics', { ...asOwner, body: { topic: 'x' } }),
            await run(studioRouter, 'post', '/monteur/run', asOwner),
            await run(studioRouter, 'put', '/settings', { ...asOwner, body: { monteur: { enabled: true } } }),
            await run(growthRouter, 'post', '/coach', asOwner),
            await run(apiRouter, 'post', '/settings/ai', { ...asOwner, body: { system_prompt: 'x', is_active: true } }),
        ];
        for (const reply of replies) assert.equal(isGate(reply), false, JSON.stringify(reply.body));
        assert.equal(agents.get(OWNER), true, 'his DM bot switched on, with no hand-off rule, exactly as before');
    });

    it('even with an onboarding row that says he has not started, and a profile as blank as a new tenant\'s', async () => {
        world.onboarding.set(OWNER, { status: 'invited', current_step: null, steps: {}, filled_by: null, started_at: null, completed_at: null });
        world.state.profiles.set(OWNER, { profile: throughJsonb(defaultProfile({ lang: 'ar' })), version: 1, activated_at: null, updated_by: null });
        agents.set(OWNER, false);
        assert.equal(isGate(await run(growthRouter, 'post', '/coach', asOwner)), false);
        assert.equal(isGate(await run(studioRouter, 'post', '/drafts', { ...asOwner, body: { topic: 'x' } })), false);
        assert.equal(isGate(await run(apiRouter, 'post', '/settings/ai', { ...asOwner, body: { system_prompt: 'x', is_active: true } })), false);
    });
});

describe('a tenant that predates onboarding is never gated either', () => {
    it('one v34 inserted as completed with nobody having filled it in', async () => {
        addNewcomer(world, throughJsonb(defaultProfile({ lang: 'ar' })), { status: 'completed', filled_by: null, completed_at: new Date(0) });
        agents.set(NEWCOMER, false);
        assert.equal(isGate(await run(growthRouter, 'post', '/coach')), false);
        assert.equal(isGate(await run(studioRouter, 'post', '/monteur/run')), false);
        assert.equal(isGate(await run(apiRouter, 'post', '/settings/ai', { body: { system_prompt: 'x', is_active: true } })), false);
    });
});

describe('where the gate is called from', () => {
    const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
    });

    it('is only ever a switch-on route: the webhook, the queue, the cron and the services never call it', () => {
        const callers = files(SRC)
            .filter((file) => /\bassert(?:AgentReady|DmSwitchOn)\s*\(/.test(readFileSync(file, 'utf8')))
            .map((file) => path.relative(SRC, file))
            .sort();
        assert.deepEqual(callers, ['routes/api.ts', 'routes/growth.ts', 'routes/studio.ts', 'services/profile/agentGate.ts']);
    });
});
