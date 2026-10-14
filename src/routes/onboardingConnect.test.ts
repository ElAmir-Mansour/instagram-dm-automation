/**
 * Wizard step W4, "connect your accounts", is on ONLY when the operator has switched "Connect with Facebook" on (P28).
 *
 * The registry (`WIZARD_STEPS`) lists `connect` as disabled, as it has since P18. What raises it is the setting `meta.login_enabled`
 * (default off), read where it can matter. What is pinned, because each is a way the wizard hurts somebody:
 *
 *   - **Off is exactly today's wizard.** With the setting off, absent, `false`, or unreadable, `connect` is left out of the order, the
 *     progress count, `firstOpenStep` and `resumeStep`; Continue on W3 leads to the last screen; and a write to the step is the 404 it
 *     always was. A setting that cannot be read fails CLOSED.
 *   - **On adds one optional step after W3**, and it never blocks anybody: it can be skipped, it can be left unsettled and the
 *     wizard still finishes, and a step that is switched off again is not a place to resume.
 *   - **A finished tenant is never sent to it**, and the dashboard's session read (`/auth/me`) does not even ask for the setting
 *     for one: the owner's tenant is completed, and nothing about this changes for him.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { APP_SETTING_KEYS } from '../services/appSettings.js';
import { defaultProfile } from '../services/profile/defaults.js';
import { patchProfile } from '../services/profile/patch.js';
import { resetProfileTableWarning } from '../services/profile/store.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import {
    addNewcomer, installOnboardingWorld, NEW_OWNER_USER, NEWCOMER, OWNER, type OnboardingWorld,
} from '../services/wizard/testDb.js';
import {
    describeOnboardingBrief, describeWizard, firstOpenStep, nextStepAfter, NO_FLAGS, readWizardFlags, resumeStep, saveStep, stepsFor,
    WIZARD_STEPS, type StepEntry,
} from '../services/onboardingWizard.js';
import { invalidateTenantCache, type TenantRole } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import { onboardingRouter } from './onboarding.js';

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: any }[] }; handle: any }
interface Reply { status: number; body: any }

async function run(
    method: 'get' | 'put' | 'post', path: string,
    options: { role?: TenantRole | null; body?: unknown; params?: Record<string, string> } = {}
): Promise<Reply> {
    const layer = (onboardingRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    const reply: Reply = { status: 200, body: null };
    const res = {
        status(code: number) { reply.status = code; return this; },
        json(payload: unknown) { reply.body = payload; return this; },
    } as unknown as Response;
    const req = {
        method: method.toUpperCase(), originalUrl: path, params: options.params ?? {}, query: {}, headers: {}, body: options.body ?? {},
        session: { userId: NEW_OWNER_USER, role: 'user', tenantId: NEWCOMER },
        tenantRole: options.role === undefined ? 'owner' : options.role ?? undefined,
    } as unknown as Request;
    for (const inner of layer!.route!.stack) {
        let advanced = false;
        await inner.handle(req, res, (() => { advanced = true; }) as NextFunction);
        if (!advanced) break;
    }
    return reply;
}

const getState = () => run('get', '/');
const putStep = (step: string, body: unknown) => run('put', '/steps/:step', { body, params: { step } });
const finish = () => run('post', '/complete');

let world: OnboardingWorld;
let restoreSink: (() => void) | undefined;

const ACTIVE_PATCH = {
    identity: { display_name: { en: 'Nour Shop' }, kind: 'shop', niche: 'Linen homewares', timezone: 'Europe/London' },
    offers: [{ id: 'main', kind: 'product', name: 'Linen throw', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }],
};

const on = (): void => { world.settings.set(APP_SETTING_KEYS.metaLoginEnabled, 'true'); };
const row = () => world.onboarding.get(NEWCOMER)!;
const done = { status: 'done' } as const satisfies StepEntry;
const orderOf = (order: Array<{ id: string; enabled: boolean }>): string[] => order.filter((s) => s.enabled).map((s) => s.id);

beforeEach(() => {
    resetProfileTableWarning();
    invalidateTenantCache();
    const previous = setLogSink(() => undefined);
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

// ─── The registry ────────────────────────────────────────────────────────────────────────────────

describe('the registry with the flags applied', () => {
    it('is the registry itself with no flag, and raises only `connect` with one', () => {
        assert.deepEqual(stepsFor(), WIZARD_STEPS.map((s) => ({ ...s })));
        assert.deepEqual(stepsFor(NO_FLAGS), WIZARD_STEPS.map((s) => ({ ...s })));
        const raised = stepsFor({ connect: true });
        assert.deepEqual(orderOf(raised), ['about', 'voice', 'brand', 'connect', 'done']);
        assert.deepEqual(
            raised.filter((s, i) => s.enabled !== WIZARD_STEPS[i]!.enabled).map((s) => s.id), ['connect'],
            'nothing else moves: the proof step stays off until its own PR'
        );
        assert.equal(raised.find((s) => s.id === 'connect')!.required, false, 'and it is optional');
    });

    it('does not change the registry it was given', () => {
        stepsFor({ connect: true });
        assert.equal(WIZARD_STEPS.find((s) => s.id === 'connect')!.enabled, false);
    });

    it('puts W4 after W3 for Continue, and settles on it before the last screen', () => {
        assert.equal(nextStepAfter('brand'), 'done');
        assert.equal(nextStepAfter('brand', { connect: true }), 'connect');
        assert.equal(nextStepAfter('connect', { connect: true }), 'done');
    });

    it('holds nobody back with it off, and holds exactly the unsettled W4 open with it on', () => {
        const steps = { about: done, voice: done, brand: done };
        assert.equal(firstOpenStep(steps), 'done');
        assert.equal(firstOpenStep(steps, { connect: true }), 'connect');
        assert.equal(firstOpenStep({ ...steps, connect: { status: 'skipped' } }, { connect: true }), 'done');
        assert.equal(firstOpenStep({ ...steps, connect: done }, { connect: true }), 'done');
    });

    it('resumes on W4 only when it is on, and falls back when it is switched off again', () => {
        const state = { status: 'in_progress' as const, current_step: 'connect', steps: { about: done, voice: done, brand: done } };
        assert.equal(resumeStep(state, { connect: true }), 'connect');
        assert.equal(resumeStep(state), 'done', 'a step that is switched off is not a place to resume');
        assert.equal(resumeStep({ ...state, status: 'completed' }, { connect: true }), 'done');
    });
});

// ─── The setting ─────────────────────────────────────────────────────────────────────────────────

describe('reading what the operator switched on', () => {
    it('is off by default and for anything but "true"', async () => {
        assert.deepEqual(await readWizardFlags(), { connect: false });
        for (const value of ['false', '', '1', 'yes', 'TRUE']) {
            world.settings.set(APP_SETTING_KEYS.metaLoginEnabled, value);
            assert.deepEqual(await readWizardFlags(), { connect: false }, JSON.stringify(value));
        }
        on();
        assert.deepEqual(await readWizardFlags(), { connect: true });
    });

    it('fails CLOSED: a setting that cannot be read is "off", so the wizard is the one it always was', async () => {
        on();
        world.db.failOn = /app_settings/;
        assert.deepEqual(await readWizardFlags(), { connect: false });
        const { body } = await getState();
        assert.deepEqual(orderOf(body.order), ['about', 'voice', 'brand', 'done']);
    });
});

// ─── Off: exactly today's wizard ─────────────────────────────────────────────────────────────────

describe('with "Connect with Facebook" off (the default)', () => {
    it('lists W4 as switched off, and resumes past it', async () => {
        const { body } = await getState();
        assert.deepEqual(orderOf(body.order), ['about', 'voice', 'brand', 'done']);
        assert.equal(body.order.find((s: { id: string }) => s.id === 'connect').enabled, false);
        await putStep('about', { status: 'done' });
        await putStep('voice', { status: 'done' });
        const reply = await putStep('brand', { status: 'done' });
        assert.equal(reply.body.step, 'done', 'Continue on W3 leads to the last screen');
        assert.equal(row().current_step, 'done');
    });

    it('refuses every write to the step, as it always did', async () => {
        for (const body of [{ viewed: true }, { values: { x: 1 } }, { status: 'skipped' }, { status: 'done' }]) {
            const reply = await putStep('connect', body);
            assert.equal(reply.status, 404, JSON.stringify(body));
            assert.equal(reply.body.code, 'UNKNOWN_STEP');
        }
        assert.equal(row().steps.connect, undefined);
    });

    it('is what a setting of "false" gives, too', async () => {
        world.settings.set(APP_SETTING_KEYS.metaLoginEnabled, 'false');
        assert.equal((await putStep('connect', { viewed: true })).status, 404);
    });
});

// ─── On: one optional step ───────────────────────────────────────────────────────────────────────

describe('with "Connect with Facebook" on', () => {
    beforeEach(on);

    it('lists W4 as a step after W3, optional', async () => {
        const { body } = await getState();
        assert.deepEqual(orderOf(body.order), ['about', 'voice', 'brand', 'connect', 'done']);
        const connect = body.order.find((s: { id: string }) => s.id === 'connect');
        assert.deepEqual({ code: connect.code, required: connect.required, enabled: connect.enabled }, { code: 'W4', required: false, enabled: true });
    });

    it('leads from W3 to W4, and from W4 to the last screen, whether it is finished or skipped', async () => {
        await putStep('about', { status: 'done' });
        await putStep('voice', { status: 'done' });
        const afterBrand = await putStep('brand', { status: 'done' });
        assert.equal(afterBrand.body.step, 'connect');
        assert.equal(row().current_step, 'connect');

        const skipped = await putStep('connect', { status: 'skipped' });
        assert.equal(skipped.status, 200, 'it is not required');
        assert.equal(skipped.body.step, 'done');
        assert.equal((row().steps.connect as StepEntry).status, 'skipped');

        const again = await putStep('connect', { status: 'done' });
        assert.equal(again.status, 200);
        assert.equal((row().steps.connect as StepEntry).status, 'done');
    });

    it('keeps a view and a draft, like any other step', async () => {
        assert.equal((await putStep('connect', { viewed: true })).status, 200);
        assert.equal((await putStep('connect', { values: { note: 'later' } })).status, 200);
        assert.equal((row().steps.connect as StepEntry).values?.note, 'later');
        assert.equal(row().current_step, 'connect');
    });

    it('resumes a tenant on W4 after W3, and not past a W4 they have not settled', async () => {
        await putStep('about', { status: 'done' });
        await putStep('voice', { status: 'done' });
        await putStep('brand', { status: 'done' });
        const { body } = await getState();
        assert.equal(body.step, 'connect');
        const brief = await describeOnboardingBrief(NEWCOMER, { sessionRole: 'user', tenantRole: 'owner' });
        assert.equal(brief?.step, 'connect');
        assert.equal(brief?.gated, true);
    });

    it('never stops the wizard from finishing: W4 can be left unsettled', async () => {
        // The activation fields are what Finish needs; nothing about connecting.
        await patchProfile(NEWCOMER, { version: 1, patch: ACTIVE_PATCH }, { userId: NEW_OWNER_USER });
        await putStep('about', { status: 'done' });
        await putStep('voice', { status: 'done' });
        await putStep('brand', { status: 'skipped' });
        const reply = await finish();
        assert.equal(reply.status, 200, 'with W4 never touched');
        assert.equal(reply.body.status, 'completed');
        assert.equal(row().status, 'completed');
        assert.equal(row().steps.connect, undefined);
    });

    it('reads the setting once for a write and not at all for an autosave of another step', async () => {
        const reads = () => world.db.statements.filter((s) => /app_settings/.test(s.sql)).length;
        const before = reads();
        await saveStep(NEWCOMER, 'about', { values: { name: 'x' } }, { userId: NEW_OWNER_USER, by: 'tenant' });
        assert.equal(reads(), before, 'an autosave of W1 asks nobody anything');
        await saveStep(NEWCOMER, 'about', { status: 'done' }, { userId: NEW_OWNER_USER, by: 'tenant' });
        assert.equal(reads(), before + 1, 'Continue needs to know where it leads next');
    });
});

// ─── A finished tenant ───────────────────────────────────────────────────────────────────────────

describe('a tenant that has finished', () => {
    beforeEach(on);

    it('is never sent to W4, and the session read does not even ask for the setting', async () => {
        const reads = () => world.db.statements.filter((s) => /app_settings/.test(s.sql)).length;
        const before = reads();
        const brief = await describeOnboardingBrief(OWNER, { sessionRole: 'user', tenantRole: 'owner' });
        assert.deepEqual(brief, { status: 'completed', step: 'done', gated: false });
        assert.equal(reads(), before, 'the owner\'s page load issues no extra query');
        const view = await describeWizard(OWNER, { tenantRole: 'owner' });
        assert.deepEqual(orderOf(view.order), ['about', 'voice', 'brand', 'done']);
        assert.equal(view.step, 'done');
        assert.equal(reads(), before, 'nor does the wizard\'s own read, for a tenant that is done');
    });

    it('a tenant whose row is missing reads as finished, and is not asked either', async () => {
        world.onboarding.delete(NEWCOMER);
        const brief = await describeOnboardingBrief(NEWCOMER, { sessionRole: 'user', tenantRole: 'owner' });
        assert.deepEqual(brief, { status: 'completed', step: 'done', gated: false });
    });
});
