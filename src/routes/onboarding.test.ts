/**
 * The onboarding wizard's routes and its gate (P18): `GET /api/onboarding`, `PUT /api/onboarding/steps/:step`,
 * `POST /api/onboarding/complete`, and what `GET /api/auth/me` says so the dashboard can send an unfinished tenant to the wizard.
 *
 * Driven through the real routers' own handler stacks (guards included) against the in-memory stand-in for the wizard's tables
 * layered on the profile's (`services/wizard/testDb.ts`), whose two writes read their predicates out of the SQL: take
 * `status <> 'completed'` out of the production statement and "a second Finish changes nothing" fails here.
 *
 * What is pinned, because each is a way the wizard hurts somebody:
 *
 *   - **the owner never sees it.** His tenant is `completed` (v34 inserted a row for every tenant that existed), a tenant with no
 *     row reads as completed, a database that cannot answer gates nothing, and a platform admin is exempt;
 *   - **autosave never touches the profile**: no statement names `creator_profiles`, `studio_settings` or `growth_settings`, the
 *     version does not move, and so two saves, or a save and an admin's write, cannot 409 each other;
 *   - **Continue is the profile's own optimistic write**: when someone else wrote in between, `PATCH /api/profile` answers 409 with
 *     the version to reload, and `GET /api/onboarding` then returns the newer values;
 *   - **Finish is idempotent** and needs the six activation fields, and says which step holds the first one missing;
 *   - **only an owner writes**, and an operator or a viewer is never trapped in a wizard they cannot finish.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { defaultProfile } from '../services/profile/defaults.js';
import { patchProfile } from '../services/profile/patch.js';
import { resetProfileTableWarning } from '../services/profile/store.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import {
    ADMIN_USER, addNewcomer, installOnboardingWorld, NEW_OWNER_USER, NEWCOMER, OPERATOR_USER, OWNER, OWNER_USER, type OnboardingWorld,
} from '../services/wizard/testDb.js';
import {
    describeOnboardingBrief, firstOpenStep, nextStepAfter, onboardingGated, resumeStep, saveStep, STEP_VALUES_LIMITS,
    stepForMissingField, validateStepValues, WIZARD_STEPS,
} from '../services/onboardingWizard.js';
import { invalidateTenantCache, resolveTenant, type TenantRole } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { onboardingRouter } from './onboarding.js';
import { profileRouter } from './profile.js';

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: any }[] }; handle: any }

interface Reply { status: number; body: any }

/** A router's route as Express would run it: every handler in its stack, in order, each only if the one before called `next`. */
async function run(
    router: unknown, method: 'get' | 'put' | 'post' | 'patch', path: string,
    options: { role?: TenantRole | null; session?: Record<string, unknown>; body?: unknown; params?: Record<string, string> } = {}
): Promise<Reply> {
    const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    const reply: Reply = { status: 200, body: null };
    const res = {
        status(code: number) { reply.status = code; return this; },
        json(payload: unknown) { reply.body = payload; return this; },
    } as unknown as Response;
    const req = {
        method: method.toUpperCase(), originalUrl: path, params: options.params ?? {}, query: {}, headers: {}, body: options.body ?? {},
        session: { userId: NEW_OWNER_USER, role: 'user', tenantId: NEWCOMER, ...(options.session ?? {}) },
        tenantRole: options.role === undefined ? 'owner' : options.role ?? undefined,
    } as unknown as Request;
    for (const inner of layer!.route!.stack) {
        let advanced = false;
        await inner.handle(req, res, (() => { advanced = true; }) as NextFunction);
        if (!advanced) break;
    }
    return reply;
}

const wizard = (method: 'get' | 'put' | 'post', path: string, options: Parameters<typeof run>[3] = {}) => run(onboardingRouter, method, path, options);
const getState = (options: Parameters<typeof run>[3] = {}) => wizard('get', '/', options);
const putStep = (step: string, body: unknown, options: Parameters<typeof run>[3] = {}) => wizard('put', '/steps/:step', { ...options, body, params: { step } });
const finish = (options: Parameters<typeof run>[3] = {}) => wizard('post', '/complete', options);

let world: OnboardingWorld;
let logs: { level: string; event: string }[];
let restoreSink: (() => void) | undefined;

/** The six activation fields, as a person answering W1 and W2 would have saved them. */
const ACTIVE_PATCH = {
    identity: { display_name: { en: 'Nour Shop' }, kind: 'shop', niche: 'Linen homewares', timezone: 'Europe/London' },
    offers: [{ id: 'main', kind: 'product', name: 'Linen throw', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }],
};

beforeEach(() => {
    resetProfileTableWarning();
    invalidateTenantCache();
    logs = [];
    const previous = setLogSink((level, line) => {
        try { logs.push({ level, event: JSON.parse(line).event }); } catch { /* not structured */ }
    });
    restoreSink = () => setLogSink(previous);
    world = installOnboardingWorld();
    addNewcomer(world, throughJsonb(defaultProfile({ lang: 'ar' })));
    world.db.routes.push([/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [{ email: 'someone@example.com' }] })]);
});

afterEach(() => {
    world.restore();
    restoreSink?.();
    invalidateTenantCache();
});

const row = () => world.onboarding.get(NEWCOMER)!;
const touchedProfile = () => world.db.statements.filter((s) => /creator_profiles|creator_profile_versions|studio_settings|growth_settings/.test(s.sql));

// ─── Mounting and guards ─────────────────────────────────────────────────────────────────────────

describe('the onboarding router: mounting and who may use it', () => {
    it('is mounted below resolveTenant, so every route acts as the session\'s tenant', () => {
        const stack = (apiRouter as unknown as { stack: Layer[] }).stack;
        const tenantAt = stack.findIndex((l) => !l.route && l.handle === resolveTenant);
        const mountAt = stack.findIndex((l) => !l.route && l.handle === onboardingRouter);
        assert.ok(tenantAt >= 0 && mountAt >= 0, 'both are mounted');
        assert.ok(mountAt > tenantAt, 'the wizard is mounted below resolveTenant');
    });

    it('lets an operator read and refuses to let one write', async () => {
        assert.equal((await getState({ role: 'operator' })).status, 200);
        assert.equal((await getState({ role: 'operator' })).body.canEdit, false);
        assert.equal((await putStep('about', { values: { name: 'x' } }, { role: 'operator' })).status, 403);
        assert.equal((await finish({ role: 'operator' })).status, 403);
        assert.deepEqual(row().steps, {}, 'nothing was written');
    });

    it('refuses a viewer everything: the setup holds the offers and the profile', async () => {
        assert.equal((await getState({ role: 'viewer' })).status, 403);
        assert.equal((await putStep('about', { values: { name: 'x' } }, { role: 'viewer' })).status, 403);
        assert.equal((await finish({ role: 'viewer' })).status, 403);
    });

    it('lets an owner read and write, and says so', async () => {
        const read = await getState({ role: 'owner' });
        assert.equal(read.status, 200);
        assert.equal(read.body.canEdit, true);
        assert.equal((await putStep('about', { values: { name: 'Nour' } })).status, 200);
    });

    it('records a platform admin\'s writes as the admin\'s, not the tenant\'s', async () => {
        const reply = await putStep('about', { values: { name: 'Nour' } }, { session: { userId: ADMIN_USER, role: 'platform_admin' } });
        assert.equal(reply.status, 200);
        assert.equal(row().filled_by, 'admin');
        const done = await putStep('about', { status: 'done' }, { session: { userId: ADMIN_USER, role: 'platform_admin' } });
        assert.equal(done.status, 200);
        assert.equal((row().steps.about as any).by, 'admin');
        assert.equal(world.events.at(-1)!.actor, 'admin');
    });
});

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

describe('GET /api/onboarding', () => {
    it('answers a brand-new tenant: invited, at the first step, with the stored profile and what is still missing', async () => {
        const { status, body } = await getState();
        assert.equal(status, 200);
        assert.equal(body.status, 'invited');
        assert.equal(body.step, 'about');
        assert.equal(body.version, 1);
        assert.equal(body.stored, true);
        assert.equal(body.canEdit, true);
        assert.equal(body.draft, null, 'the draft engine is not built: the steps are plain forms');
        assert.deepEqual(body.hints, { name: 'Nour Shop', instagramUsername: 'nourshop', websiteUrl: 'https://nour.example' });
        for (const field of ['identity.display_name', 'identity.kind', 'identity.niche', 'identity.timezone', 'offers.primary.name']) {
            assert.ok(body.missing.includes(field), `${field} is missing on a new tenant`);
        }
    });

    it('carries the registry: W4 is off until the operator switches it on, and W5 (the proof samples) is on', async () => {
        const { body } = await getState();
        assert.deepEqual(body.order.map((s: any) => [s.id, s.code, s.enabled]), [
            ['about', 'W1', true], ['voice', 'W2', true], ['brand', 'W3', true], ['connect', 'W4', false], ['proof', 'W5', true], ['done', 'W6', true],
        ]);
        assert.deepEqual(body.order.filter((s: any) => s.required).map((s: any) => s.id), ['about', 'voice'], 'the activation fields live on W1 and W2');
    });

    it('reads a tenant with no row as completed (D14), and the owner\'s tenant as completed', async () => {
        world.onboarding.delete(NEWCOMER);
        const absent = await getState();
        assert.equal(absent.body.status, 'completed');
        assert.equal(absent.body.step, 'done');
        const owner = await getState({ session: { userId: OWNER_USER, tenantId: OWNER } });
        assert.equal(owner.body.status, 'completed');
    });

    it('resumes at the step the person was on, and never past the first that is still open', async () => {
        row().status = 'in_progress';
        row().steps = { about: { status: 'done', at: '2026-10-14T09:00:00.000Z', by: 'tenant' } };
        row().current_step = 'voice';
        assert.equal((await getState()).body.step, 'voice');

        row().current_step = 'brand';
        assert.equal((await getState()).body.step, 'voice', 'W2 is required and not done: brand is out of reach');

        row().current_step = 'about';
        assert.equal((await getState()).body.step, 'about', 'going back is allowed');

        row().current_step = 'nonsense';
        assert.equal((await getState()).body.step, 'voice', 'a stored position that is not a step is ignored');
    });

    it('returns the typed-and-unconfirmed values with the step, and makes junk in the column safe', async () => {
        row().steps = {
            about: { values: { name: 'Nour' }, saved_at: '2026-10-14T09:00:00.000Z', junk: 'dropped', status: 'weird' },
            voice: 'not an object',
            alien: { status: 'done' },
        };
        const { body } = await getState();
        assert.deepEqual(body.steps.about, { values: { name: 'Nour' }, saved_at: '2026-10-14T09:00:00.000Z' });
        assert.deepEqual(body.steps.voice, {});
        assert.ok(!('alien' in body.steps), 'only the registry\'s steps are shown');
    });
});

// ─── Autosave ────────────────────────────────────────────────────────────────────────────────────

describe('PUT /api/onboarding/steps/:step: autosave', () => {
    it('keeps what was typed in the step\'s entry, and moves the tenant from invited to in progress', async () => {
        const before = row().status;
        assert.equal(before, 'invited');
        const reply = await putStep('about', { values: { name: 'Nour', kind: 'shop' } });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.status, 'in_progress');
        assert.equal(reply.body.steps.about.values.name, 'Nour');
        assert.ok(row().started_at, 'started_at is set by the first write');
        assert.equal(row().filled_by, 'tenant');
        assert.deepEqual((row().steps.about as any).values, { name: 'Nour', kind: 'shop' });
    });

    it('NEVER touches the profile: no statement names it, and its version does not move', async () => {
        await putStep('about', { values: { name: 'Nour' } });
        await putStep('about', { values: { name: 'Nour S' } });
        await putStep('voice', { values: { register: 'gulf' } });
        assert.deepEqual(touchedProfile().map((s) => s.sql), [], 'autosave writes only onboarding.steps');
        const { body } = await getState();
        assert.equal(body.version, 1);
        assert.equal(world.state.versions.length, 0, 'no history row either');
    });

    it('keeps the latest values per step, and each step on its own', async () => {
        await putStep('about', { values: { name: 'first' } });
        await putStep('voice', { values: { register: 'gulf' } });
        await putStep('about', { values: { name: 'second' } });
        assert.deepEqual((row().steps.about as any).values, { name: 'second' });
        assert.deepEqual((row().steps.voice as any).values, { register: 'gulf' });
    });

    it('records no funnel event for a keystroke', async () => {
        await putStep('about', { values: { name: 'Nour' } });
        assert.deepEqual(world.events, []);
    });

    it('is a no-op after Finish: the answer is the state as it is', async () => {
        row().status = 'completed';
        row().completed_at = new Date(1000);
        const reply = await putStep('about', { values: { name: 'late' } });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.status, 'completed');
        assert.deepEqual(row().steps, {}, 'nothing written to a finished tenant');
    });

    it('loses a race to Finish without writing: the statement itself refuses a finished tenant', async () => {
        // The read says in progress; before the write lands another request finishes the tenant.
        world.before.push({ pattern: /^UPDATE onboarding SET status = CASE WHEN status = 'invited'/, run: () => { row().status = 'completed'; row().completed_at = new Date(1000); } });
        const reply = await putStep('about', { values: { name: 'too late' } });
        assert.equal(reply.status, 200);
        assert.deepEqual(row().steps, {}, 'nothing was written to a tenant that finished in between');
        assert.equal(row().completed_at!.getTime(), 1000);
        assert.deepEqual(world.events, []);
    });

    it('never touches a tenant with no row, and does not invent one', async () => {
        world.onboarding.delete(NEWCOMER);
        const reply = await putStep('about', { values: { name: 'x' } });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.status, 'completed');
        assert.equal(world.onboarding.has(NEWCOMER), false);
    });
});

describe('PUT /api/onboarding/steps/:step: what it refuses', () => {
    it('refuses a step that does not exist, one that is switched off, and the last screen', async () => {
        for (const step of ['nope', 'connect', 'done', '__proto__', 'ABOUT']) {
            const reply = await putStep(step, { values: { a: 1 } });
            assert.equal(reply.status, 404, step);
            assert.equal(reply.body.code, 'UNKNOWN_STEP', step);
        }
        assert.deepEqual(row().steps, {});
    });

    it('refuses a body that says nothing, or says something it does not mean', async () => {
        const bad: unknown[] = [
            {}, { values: 'text' }, { values: [1] }, { values: null }, { status: 'maybe' }, { status: 'open' }, { viewed: false }, { viewed: 'yes' },
            { status: 'done', values: { a: 1 } }, { status: 'done', viewed: true }, [], 'x',
        ];
        for (const body of bad) {
            const reply = await putStep('about', body);
            assert.equal(reply.status, 400, JSON.stringify(body));
            assert.equal(reply.body.code, 'BAD_REQUEST', JSON.stringify(body));
        }
        assert.deepEqual(row().steps, {});
    });

    it('keeps an autosave a small flat form: no nesting, no odd names, no files', () => {
        assert.equal(validateStepValues({ name: 'ok', n: 3, on: true, nothing: null, tone: ['a', 'b'] }), null);
        const nested = validateStepValues({ a: { b: 1 } });
        assert.match(nested ?? '', /must be text/);
        assert.match(validateStepValues({ a: [[1]] }) ?? '', /must be text/);
        assert.match(validateStepValues({ 'not a name': 1 }) ?? '', /not a field name/);
        assert.match(validateStepValues({ '': 1 }) ?? '', /not a field name/);
        assert.match(validateStepValues(JSON.parse('{"__proto__": 1}')) ?? '', /not a field name/);
        assert.match(validateStepValues({ constructor: 1 }) ?? '', /not a field name/);
        assert.match(validateStepValues({ a: 'x'.repeat(STEP_VALUES_LIMITS.string + 1) }) ?? '', /must be text/);
        assert.match(validateStepValues({ a: Array.from({ length: STEP_VALUES_LIMITS.items + 1 }, () => 'x') }) ?? '', /must be text/);
        assert.match(validateStepValues(Object.fromEntries(Array.from({ length: STEP_VALUES_LIMITS.keys + 1 }, (_, i) => [`k${i}`, 1]))) ?? '', /at most/);
        assert.match(validateStepValues({ a: Number.POSITIVE_INFINITY }) ?? '', /must be text/);
        assert.match(validateStepValues(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'y'.repeat(1900)]))) ?? '', /larger than/);
    });

    it('refuses to skip a required step, and says why', async () => {
        for (const step of ['about', 'voice']) {
            const reply = await putStep(step, { status: 'skipped' });
            assert.equal(reply.status, 409, step);
            assert.equal(reply.body.code, 'STEP_REQUIRED', step);
        }
        assert.deepEqual(row().steps, {});
    });
});

// ─── Views and Continue ──────────────────────────────────────────────────────────────────────────

describe('PUT /api/onboarding/steps/:step: viewing and Continue', () => {
    it('remembers the step on screen, and counts a view only when the position changes', async () => {
        await putStep('about', { viewed: true });
        await putStep('about', { viewed: true });
        assert.equal(row().current_step, 'about');
        assert.deepEqual(world.events.map((e) => [e.event, e.step]), [['step_viewed', 'about']], 'a reload is not a second view');
        await putStep('voice', { viewed: true });
        assert.equal(row().current_step, 'voice');
        assert.deepEqual(world.events.map((e) => [e.event, e.step]), [['step_viewed', 'about'], ['step_viewed', 'voice']]);
    });

    it('Continue replaces the entry (the draft values go) and moves on to the next step that is switched on', async () => {
        await putStep('about', { values: { name: 'draft' } });
        const reply = await putStep('about', { status: 'done' });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.step, 'voice');
        const entry = row().steps.about as any;
        assert.equal(entry.status, 'done');
        assert.equal(entry.by, 'tenant');
        assert.ok(Date.parse(entry.at) > 0);
        assert.ok(!('values' in entry), 'confirming replaces the unconfirmed copy');
        assert.equal(row().current_step, 'voice');
    });

    it('skips past the step that is switched off: after Brand comes the proof samples, and after them the last screen', async () => {
        await putStep('about', { status: 'done' });
        await putStep('voice', { status: 'done' });
        const reply = await putStep('brand', { status: 'skipped' });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.step, 'proof', 'connect is switched off, proof is on');
        assert.equal((row().steps.brand as any).status, 'skipped');
        assert.equal(nextStepAfter('brand'), 'proof');
        const proof = await putStep('proof', { status: 'skipped' });
        assert.equal(proof.body.step, 'done');
        assert.equal(nextStepAfter('proof'), 'done');
    });

    it('records enums and numbers only, never what was typed', async () => {
        await putStep('about', { viewed: true });
        await putStep('about', { values: { name: 'My Secret Brand Name', niche: 'private words' } });
        await putStep('about', { status: 'done' });
        await putStep('voice', { viewed: true });
        await putStep('brand', { status: 'skipped' });
        const text = JSON.stringify(world.events);
        assert.ok(!text.includes('My Secret Brand Name') && !text.includes('private words'), 'no field value in the funnel');
        assert.deepEqual(world.events.map((e) => e.event), ['step_viewed', 'step_completed', 'step_viewed', 'step_skipped']);
        for (const event of world.events) for (const value of Object.values(event.props)) assert.ok(typeof value === 'number' || typeof value === 'string');
    });

    it('measures the time on a step from the last view, bounded', async () => {
        const t0 = Date.parse('2026-10-14T09:00:00.000Z');
        const actor = { userId: NEW_OWNER_USER, by: 'tenant' as const };
        await saveStep(NEWCOMER, 'about', { viewed: true }, actor, t0);
        await saveStep(NEWCOMER, 'about', { status: 'done' }, actor, t0 + 42_000);
        assert.deepEqual(world.events.at(-1)!.props, { ms_on_step: 42_000 });
        await saveStep(NEWCOMER, 'voice', { viewed: true }, actor, t0);
        await saveStep(NEWCOMER, 'voice', { status: 'done' }, actor, t0 + 9 * 60 * 60 * 1000);
        assert.equal(world.events.at(-1)!.props.ms_on_step, 60 * 60 * 1000, 'a step left open overnight is not a nine-hour step');
    });

    it('does not fail a request because the funnel could not be written', async () => {
        world.db.failOn = /^INSERT INTO onboarding_events/;
        const reply = await putStep('about', { viewed: true });
        assert.equal(reply.status, 200);
        assert.equal(row().current_step, 'about');
        assert.ok(logs.some((l) => l.event === 'onboarding.event_failed'));
    });
});

// ─── The 409 path ────────────────────────────────────────────────────────────────────────────────

describe('when the profile moves while the wizard is open (an admin filling in for the tenant)', () => {
    it('answers a stale Continue with 409 and the version to reload, and the next read carries the newer values', async () => {
        const first = await getState();
        assert.equal(first.body.version, 1);

        // The tenant is typing: autosave never conflicts with anything.
        assert.equal((await putStep('about', { values: { niche: 'mine' } })).status, 200);

        // Meanwhile somebody else (an admin) saves the profile: version 2.
        await patchProfile(NEWCOMER, { version: 1, patch: { identity: { niche: 'written by the admin' } } }, { userId: ADMIN_USER });

        // The tenant's Continue is written against version 1.
        const stale = await run(profileRouter, 'patch', '/', { body: { version: 1, patch: { identity: { niche: 'mine' } } } });
        assert.equal(stale.status, 409);
        assert.equal(stale.body.code, 'PROFILE_VERSION_CONFLICT');
        assert.equal(stale.body.currentVersion, 2);

        // The page reloads that step: the newer values, at the newer version, and the typed draft is still there to compare.
        const reloaded = await getState();
        assert.equal(reloaded.body.version, 2);
        assert.equal(reloaded.body.profile.identity.niche, 'written by the admin');
        assert.deepEqual(reloaded.body.steps.about.values, { niche: 'mine' });

        // And Continue at the new version goes through.
        const retry = await run(profileRouter, 'patch', '/', { body: { version: 2, patch: { identity: { niche: 'confirmed' } } } });
        assert.equal(retry.status, 200);
        assert.equal(retry.body.version, 3);
        assert.equal((await putStep('about', { status: 'done' })).status, 200);
    });
});

// ─── Finish ──────────────────────────────────────────────────────────────────────────────────────

describe('POST /api/onboarding/complete', () => {
    it('refuses while an activation field is empty, naming it and the step that owns it', async () => {
        const reply = await finish();
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'ONBOARDING_INCOMPLETE');
        assert.ok(reply.body.missing.includes('identity.kind'));
        assert.equal(reply.body.fixStep, 'about');
        assert.equal(row().status, 'invited', 'nothing changed');
        assert.deepEqual(world.events, []);
    });

    it('says which step holds a missing field: the language is the voice step\'s, everything else the first\'s', () => {
        assert.equal(stepForMissingField('language.register'), 'voice');
        assert.equal(stepForMissingField('language.primary'), 'voice');
        for (const field of ['identity.display_name', 'identity.kind', 'identity.niche', 'identity.timezone', 'offers.primary.name', 'offers.primary.url']) {
            assert.equal(stepForMissingField(field), 'about', field);
        }
    });

    it('finishes once the six fields are in, records it once, and says the tenant is done', async () => {
        await patchProfile(NEWCOMER, { version: 1, patch: ACTIVE_PATCH }, { userId: NEW_OWNER_USER });
        await putStep('about', { viewed: true });
        const reply = await finish();
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body, { status: 'completed', alreadyCompleted: false, step: 'done', campaign: { created: false, reason: 'no_keyword' } });
        assert.equal(row().status, 'completed');
        assert.equal(row().current_step, 'done');
        assert.ok(row().completed_at);
        const completed = world.events.filter((e) => e.event === 'wizard_completed');
        assert.equal(completed.length, 1);
        assert.equal(completed[0]!.props.by, 'tenant');
        assert.equal(typeof completed[0]!.props.total_ms, 'number');
    });

    it('is idempotent: a second Finish answers the same, changes nothing and records nothing', async () => {
        await patchProfile(NEWCOMER, { version: 1, patch: ACTIVE_PATCH }, { userId: NEW_OWNER_USER });
        await finish();
        const stamp = row().completed_at!.getTime();
        const events = world.events.length;
        const again = await finish();
        assert.equal(again.status, 200);
        assert.deepEqual(again.body, { status: 'completed', alreadyCompleted: true, step: 'done' });
        assert.equal(row().completed_at!.getTime(), stamp, 'completed_at is the first Finish\'s');
        assert.equal(world.events.length, events, 'no second wizard_completed');
    });

    it('loses a race to another Finish without writing: the second does not move completed_at or count twice', async () => {
        await patchProfile(NEWCOMER, { version: 1, patch: ACTIVE_PATCH }, { userId: NEW_OWNER_USER });
        // Both read "in progress"; the other request's Finish lands first.
        world.before.push({ pattern: /^UPDATE onboarding SET status = 'completed'/, run: () => { row().status = 'completed'; row().completed_at = new Date(2000); row().current_step = 'done'; } });
        const reply = await finish();
        assert.deepEqual(reply.body, { status: 'completed', alreadyCompleted: true, step: 'done' });
        assert.equal(row().completed_at!.getTime(), 2000, 'the first Finish\'s time stands');
        assert.deepEqual(world.events.filter((e) => e.event === 'wizard_completed'), [], 'and only the request that finished it counts it');
    });

    it('answers a finished tenant without asking for the six fields: a profile edited later cannot un-finish it', async () => {
        row().status = 'completed';
        row().completed_at = new Date(5000);
        const reply = await finish();
        assert.equal(reply.status, 200);
        assert.equal(reply.body.alreadyCompleted, true);
        assert.equal(row().completed_at!.getTime(), 5000);
    });

    it('never creates or changes anything for the owner\'s tenant or a tenant with no row', async () => {
        const owner = await finish({ session: { userId: OWNER_USER, tenantId: OWNER } });
        assert.equal(owner.status, 200);
        assert.equal(owner.body.alreadyCompleted, true);
        assert.equal(world.onboarding.get(OWNER)!.completed_at!.getTime(), 0, 'his completed row is untouched');

        world.onboarding.delete(NEWCOMER);
        const none = await finish();
        assert.equal(none.body.alreadyCompleted, true);
        assert.equal(world.onboarding.has(NEWCOMER), false);
    });

    it('records an admin\'s Finish as the admin\'s', async () => {
        await patchProfile(NEWCOMER, { version: 1, patch: ACTIVE_PATCH }, { userId: ADMIN_USER });
        await finish({ session: { userId: ADMIN_USER, role: 'platform_admin' } });
        assert.equal(row().filled_by, 'admin');
        assert.equal(world.events.find((e) => e.event === 'wizard_completed')!.props.by, 'admin');
    });

    it('does not write the profile: Finish only reads it', async () => {
        await patchProfile(NEWCOMER, { version: 1, patch: ACTIVE_PATCH }, { userId: NEW_OWNER_USER });
        world.db.statements.length = 0;
        await finish();
        const writes = world.db.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql) && !/onboarding/.test(s.sql));
        assert.deepEqual(writes.map((w) => w.sql), []);
    });
});

// ─── The pure parts ──────────────────────────────────────────────────────────────────────────────

describe('where the wizard opens', () => {
    const done = { status: 'done' as const };

    it('finds the first step that still has to be dealt with', () => {
        assert.equal(firstOpenStep({}), 'about');
        assert.equal(firstOpenStep({ about: done }), 'voice');
        assert.equal(firstOpenStep({ about: done, voice: done }), 'brand');
        assert.equal(firstOpenStep({ about: done, voice: done, brand: { status: 'skipped' } }), 'proof', 'the proof samples are a step, and optional');
        assert.equal(firstOpenStep({ about: done, voice: done, brand: { status: 'skipped' }, proof: { status: 'skipped' } }), 'done');
        assert.equal(firstOpenStep({ about: done, voice: done, brand: done, proof: done }), 'done', 'connect is switched off: it never holds anyone back');
    });

    it('resumes at the saved step, bounded by the first open one, and at the end once completed', () => {
        assert.equal(resumeStep(null), 'done');
        assert.equal(resumeStep({ status: 'completed', current_step: 'about', steps: {} }), 'done');
        assert.equal(resumeStep({ status: 'invited', current_step: null, steps: {} }), 'about');
        assert.equal(resumeStep({ status: 'in_progress', current_step: 'brand', steps: { about: done, voice: done } }), 'brand');
        assert.equal(resumeStep({ status: 'in_progress', current_step: 'done', steps: { about: done } }), 'voice');
        assert.equal(resumeStep({ status: 'in_progress', current_step: 'connect', steps: { about: done, voice: done } }), 'brand', 'a step that is switched off is not a place to resume');
    });

    it('lists every step of the plan, in the plan\'s order', () => {
        assert.deepEqual(WIZARD_STEPS.map((s) => s.code), ['W1', 'W2', 'W3', 'W4', 'W5', 'W6']);
    });
});

// ─── The gate ────────────────────────────────────────────────────────────────────────────────────

describe('the navigate gate: who is sent to #/welcome', () => {
    const cases: Array<[string, Parameters<typeof onboardingGated>[0], boolean]> = [
        ['an owner whose tenant has not started', { status: 'invited', sessionRole: 'user', tenantRole: 'owner' }, true],
        ['an owner whose tenant is in progress', { status: 'in_progress', sessionRole: 'user', tenantRole: 'owner' }, true],
        ['an owner whose tenant is completed', { status: 'completed', sessionRole: 'user', tenantRole: 'owner' }, false],
        ['a tenant with no row at all', { status: null, sessionRole: 'user', tenantRole: 'owner' }, false],
        ['a platform admin, tenant unfinished', { status: 'in_progress', sessionRole: 'platform_admin', tenantRole: 'owner' }, false],
        ['a platform admin, tenant not started', { status: 'invited', sessionRole: 'platform_admin', tenantRole: 'owner' }, false],
        ['an operator of an unfinished tenant', { status: 'in_progress', sessionRole: 'user', tenantRole: 'operator' }, false],
        ['a viewer of an unfinished tenant', { status: 'invited', sessionRole: 'user', tenantRole: 'viewer' }, false],
        ['a session whose role in the tenant is unknown', { status: 'invited', sessionRole: 'user', tenantRole: null }, false],
    ];
    for (const [label, input, expected] of cases) {
        it(`${expected ? 'gates' : 'does not gate'} ${label}`, () => {
            assert.equal(onboardingGated(input), expected);
        });
    }
});

/** `GET /api/auth/me`'s own handler, run for a session. */
async function me(session: Record<string, unknown>): Promise<Reply> {
    const layer = (apiRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === '/auth/me' && l.route.methods.get);
    assert.ok(layer, 'GET /auth/me is mounted');
    const reply: Reply = { status: 200, body: null };
    const res = { status(code: number) { reply.status = code; return this; }, json(payload: unknown) { reply.body = payload; return this; } } as unknown as Response;
    await layer!.route!.stack.at(-1)!.handle({ session, headers: {}, query: {}, params: {}, body: {} } as unknown as Request, res, () => {});
    return reply;
}

describe('GET /api/auth/me carries the gate', () => {
    beforeEach(() => {
        world.memberships.push({ user_id: OWNER_USER, creator_id: OWNER, role: 'owner' });
        world.memberships.push({ user_id: OPERATOR_USER, creator_id: NEWCOMER, role: 'operator' });
        world.memberships.push({ user_id: OPERATOR_USER, creator_id: OWNER, role: 'operator' });
    });

    it('sends the owner of an unfinished tenant to the wizard', async () => {
        const { body } = await me({ userId: NEW_OWNER_USER, role: 'user', tenantId: NEWCOMER });
        assert.deepEqual(body.onboarding, { status: 'invited', step: 'about', gated: true });
    });

    it('NEVER gates the owner: his tenant is completed', async () => {
        const { body } = await me({ userId: OWNER_USER, role: 'user', tenantId: OWNER });
        assert.deepEqual(body.onboarding, { status: 'completed', step: 'done', gated: false });
    });

    it('never gates the owner\'s operators either, whether or not they are signed into his tenant', async () => {
        const inOwners = await me({ userId: OPERATOR_USER, role: 'user', tenantId: OWNER });
        assert.equal(inOwners.body.onboarding.gated, false);
        const inNewcomers = await me({ userId: OPERATOR_USER, role: 'user', tenantId: NEWCOMER });
        assert.equal(inNewcomers.body.onboarding.gated, false, 'an operator cannot finish the wizard, so it is not theirs to be held by');
    });

    it('never gates a platform admin, however unfinished the tenant they are acting as', async () => {
        for (const tenantId of [NEWCOMER, OWNER]) {
            const { body } = await me({ userId: ADMIN_USER, role: 'platform_admin', tenantId });
            assert.equal(body.onboarding.gated, false, tenantId);
        }
        assert.equal((await me({ userId: ADMIN_USER, role: 'platform_admin', tenantId: NEWCOMER })).body.onboarding.status, 'invited');
    });

    it('reads a tenant with no row as completed, and a database that cannot answer as unknown (the dashboard then gates nothing)', async () => {
        world.onboarding.delete(NEWCOMER);
        assert.deepEqual((await me({ userId: NEW_OWNER_USER, role: 'user', tenantId: NEWCOMER })).body.onboarding, { status: 'completed', step: 'done', gated: false });

        world.onboarding.set(NEWCOMER, { status: 'invited', current_step: null, steps: {}, filled_by: null, started_at: null, completed_at: null });
        world.noOnboardingTable = true;
        const unreadable = await me({ userId: NEW_OWNER_USER, role: 'user', tenantId: NEWCOMER });
        assert.equal(unreadable.status, 200, 'identity still answers');
        assert.equal(unreadable.body.onboarding, null);
        assert.ok(logs.some((l) => l.event === 'onboarding.brief_unreadable'));
    });

    it('answers null while there is no tenant to describe', async () => {
        world.creators.clear();
        world.memberships.length = 0;
        const { body } = await me({ userId: ADMIN_USER, role: 'platform_admin', tenantId: null });
        assert.equal(body.onboarding, null);
    });

    it('the brief is the same answer the wizard\'s own read gives', async () => {
        const brief = await describeOnboardingBrief(NEWCOMER, { sessionRole: 'user', tenantRole: 'owner' });
        const read = await getState();
        assert.equal(brief!.status, read.body.status);
        assert.equal(brief!.step, read.body.step);
    });
});

describe('the owner is completed in the database, not only in the code', () => {
    const sql = readFileSync(new URL('../config/migration_v34_onboarding.sql', import.meta.url), 'utf8');

    it('migration v34 inserts a completed row for every creator that exists, and never turns a started tenant back', () => {
        assert.match(sql, /INSERT INTO onboarding \(creator_id, status, started_at, completed_at\)\s+SELECT id, 'completed', created_at, created_at FROM creators\s+ON CONFLICT \(creator_id\) DO NOTHING;/);
    });

    it('the completion statement only ever applies to a row that is not completed already', () => {
        const source = readFileSync(new URL('../services/onboardingWizard.ts', import.meta.url), 'utf8');
        assert.equal((source.match(/WHERE creator_id = \$1 AND status <> 'completed'/g) ?? []).length, 2, 'the step write and Finish both carry the guard');
    });
});

