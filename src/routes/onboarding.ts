/**
 * The onboarding wizard's routes, under `/api/onboarding` (docs/onboarding/02 §5; plan P18; FLOWS.md §4.9).
 *
 * Mounted BELOW `resolveTenant` in api.ts, so every route acts as the session's tenant.
 *
 *   GET  /                 { status, step, order, steps, profile, version, missing, hints, canEdit, … }   operator or owner
 *   PUT  /steps/:step      { values } | { status: 'done'|'skipped' } | { viewed: true }   →  { status, step, steps }   owner only
 *   POST /complete         →  { status: 'completed', alreadyCompleted, step }    owner only, idempotent
 *
 * W4 (connect your accounts, P28) is a step only when the operator has switched "Connect with Facebook" on (`meta.login_enabled`):
 * `GET /` lists it as enabled, `PUT /steps/connect` works, and Continue from W3 leads to it. With the switch off (the default) or
 * unreadable it is exactly what it was: not in the order, and a write to it is `UNKNOWN_STEP` 404. It is optional and never blocks `POST /complete`.
 *
 * The wizard saves in two ways that never meet (the top of `services/onboardingWizard.ts`): `PUT /steps/:step` with `values`
 * keeps what was typed in `onboarding.steps` and nothing else, so it never moves the profile's `version`; Continue is
 * `PATCH /api/profile` (the profile's own optimistic version, which answers 409 when someone else wrote in between) and then
 * `PUT /steps/:step { status: 'done' }`. A platform admin acts as an owner here, like everywhere below `resolveTenant`; the
 * dashboard decides whether the wizard opens for them (`?mode=behalf`), and the rows record `by: 'admin'`.
 *
 * Refusals are `{ error, code, … }`: `UNKNOWN_STEP` 404, `BAD_REQUEST` 400, `STEP_REQUIRED` 409 (a required step cannot be
 * skipped), `ONBOARDING_INCOMPLETE` 409 with `missing` (the activation fields still empty) and `fixStep` (the step that owns
 * the first of them), and the profile's own codes when the profile cannot be read.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { completeOnboarding, describeWizard, readWizardFlags, resumeStep, saveStep, WizardError, type StepActor } from '../services/onboardingWizard.js';
import { ProfileError } from '../services/profile/store.js';
import { getTenantId, requireTenantRole, type TenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

type Handler = (req: Request, res: Response) => Promise<void>;

/** Every route's error handling, once: a refusal of ours or the profile's is the answer as it is, anything else a logged 500. */
function handle(event: string, fallback: string, fn: Handler) {
    return async (req: Request, res: Response): Promise<void> => {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof WizardError) {
                res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
                return;
            }
            if (err instanceof ProfileError) {
                res.status(err.status).json({ error: err.message, code: err.code });
                return;
            }
            log('error', event, describeError(err));
            res.status(500).json({ error: fallback });
        }
    };
}

/** Who is writing: the person, or the platform admin acting for them. */
function actorOf(req: Request): StepActor {
    return { userId: req.session?.userId ?? null, by: req.session?.role === 'platform_admin' ? 'admin' : 'tenant' };
}

export const onboardingRouter = Router();

/** Reading is operator-level, like the profile it carries; writing is the owner's, who is the one who can finish it. */
const canOperate = requireTenantRole('operator');
const canEdit = requireTenantRole('owner');

onboardingRouter.get('/', canOperate, handle('onboarding.read_failed', 'Failed to read the setup.', async (req, res) => {
    const role: TenantRole | null = req.tenantRole ?? null;
    res.json(await describeWizard(getTenantId(req), { tenantRole: role }));
}));

onboardingRouter.put('/steps/:step', canEdit, handle('onboarding.step_failed', 'Failed to save this step.', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    // What the operator has switched on (W4 needs "Connect with Facebook"), read once: it decides whether `connect` is a step at
    // all, where Continue leads from W3, and where the page resumes. Unreadable is off, so the wizard is the one it always was.
    const flags = await readWizardFlags();
    const state = await saveStep(getTenantId(req), req.params.step, { values: body.values, status: body.status, viewed: body.viewed }, actorOf(req), Date.now(), flags);
    res.json({
        status: state?.status ?? 'completed',
        step: resumeStep(state, flags),
        steps: state?.steps ?? {},
    });
}));

onboardingRouter.post('/complete', canEdit, handle('onboarding.complete_failed', 'Failed to finish the setup.', async (req, res) => {
    res.json(await completeOnboarding(getTenantId(req), actorOf(req)));
}));
