/**
 * The onboarding wizard's state (docs/onboarding/02, plan P18): where a tenant is, what they have typed and not yet confirmed,
 * and when they are done.
 *
 * The wizard has two kinds of writes, and they never meet:
 *
 *   - **Autosave** (`saveStep` with `values`): what a person has typed into a step, kept in `onboarding.steps[step].values`.
 *     It touches ONLY this table, so it never bumps the profile's `version`, never writes a history row and never makes two
 *     saves 409 each other (02 §2: "Resumable"). A value that has not been confirmed is not the profile.
 *   - **Continue** is the confirmation: the page sends the step's values to `PATCH /api/profile` (the profile's own optimistic
 *     version, `services/profile/patch.ts`) and THEN marks the step done here (`saveStep` with `status`). This module never
 *     writes the profile.
 *
 * What is decided here, in pure functions a test can reach without a database:
 *
 *   - **The step registry** (`WIZARD_STEPS`). The seam P24, P25 and P28 plug into: a step is listed here with `enabled: false`
 *     until the PR that builds it flips it. The shell skips a disabled step, so progress counts only what can be done.
 *   - **Where to resume** (`resumeStep`): the step the person last saw, never past the first step that must still be done.
 *   - **The gate** (`onboardingGated`): an owner whose tenant's onboarding is not `completed`, and nobody else. A platform
 *     admin is exempt, an operator or viewer is never trapped in a wizard they cannot finish, and a tenant whose row is
 *     missing reads as completed (D14), so the gate can never catch a tenant onboarding did not know about, the owner's included.
 *   - **What a draft may hold** (`validateStepValues`): a small flat object, so an autosave cannot become a place to park
 *     arbitrary data.
 *
 * Events (`onboarding_events`) are enums and numbers only, never a field's value (02 §6). They are best-effort: a failed
 * insert is logged and never fails the request that caused it.
 */
import { pool } from '../config/db.js';
import type { OnboardingStatus } from '../db/rows.js';
import { queryOne } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { APP_SETTING_KEYS, getSetting } from './appSettings.js';
import { readProfileState, type ProfileState } from './profile/patch.js';
import type { TenantRole } from './tenant.js';

// ─── The registry ────────────────────────────────────────────────────────────────────────────

export const WIZARD_STEP_IDS = ['about', 'voice', 'brand', 'connect', 'proof', 'done'] as const;
export type WizardStepId = (typeof WIZARD_STEP_IDS)[number];

export interface WizardStep {
    id: WizardStepId;
    /** The spec's name for it (02 §3). */
    code: 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6';
    /** A required step cannot be skipped: the six activation fields live on W1 and W2. */
    required: boolean;
    /** False until the PR that builds the step flips it: the shell leaves a disabled step out of the order and the progress count. */
    enabled: boolean;
}

/**
 * W0 (the invite page) is before there is a session and is not here. W4 (connect, P28) and W5 (proof, P25) are listed and
 * disabled: when their PRs land, enabling the entry is all the server needs, and the page registers the renderer.
 */
export const WIZARD_STEPS: readonly WizardStep[] = Object.freeze([
    { id: 'about', code: 'W1', required: true, enabled: true },
    { id: 'voice', code: 'W2', required: true, enabled: true },
    { id: 'brand', code: 'W3', required: false, enabled: true },
    { id: 'connect', code: 'W4', required: false, enabled: false },
    { id: 'proof', code: 'W5', required: false, enabled: false },
    { id: 'done', code: 'W6', required: false, enabled: true },
]);

// ─── What the operator has switched on ───────────────────────────────────────────────────────

/**
 * Steps that are not on or off for everybody: the operator's settings decide. The registry above is the baseline (`enabled` as
 * written there); a flag raises one step above it. Only W4 has one: connecting accounts needs the operator to have switched
 * "Connect with Facebook" on (`meta.login_enabled`, off by default), and until then the step is skipped exactly as it was before
 * it existed: left out of the order, the progress count, `firstOpenStep` and `resumeStep`, and refused by `saveStep`.
 */
export interface WizardFlags {
    connect: boolean;
}

export const NO_FLAGS: Readonly<WizardFlags> = Object.freeze({ connect: false });

/** The registry with the flags applied. A flag can only switch a step ON that the registry lists. */
export function stepsFor(flags: Readonly<WizardFlags> = NO_FLAGS): WizardStep[] {
    return WIZARD_STEPS.map((s) => (s.id === 'connect' ? { ...s, enabled: s.enabled || flags.connect } : { ...s }));
}

/**
 * Read the flags. Fails CLOSED: a setting that cannot be read (a database that has no `app_settings`, a failed query) is "off", so
 * the wizard is the one it was before this existed and nobody is sent to a step the operator never switched on.
 */
export async function readWizardFlags(): Promise<WizardFlags> {
    try {
        // The switch alone, as `getMetaLoginSettings` reads it (database only, "true" and nothing else): the configuration id is the
        // connect route's business, not the wizard's.
        return { connect: (await getSetting(APP_SETTING_KEYS.metaLoginEnabled)) === 'true' };
    } catch (err) {
        log('warn', 'onboarding.flags_unreadable', describeError(err));
        return { ...NO_FLAGS };
    }
}

/** The steps a person can fill in, in order: the ones with something to save (`done` is where they land). */
const formSteps = (flags: Readonly<WizardFlags> = NO_FLAGS): WizardStep[] => stepsFor(flags).filter((s) => s.enabled && s.id !== 'done');

export function stepById(id: unknown): WizardStep | null {
    return WIZARD_STEPS.find((s) => s.id === id) ?? null;
}

/** The step after `id` that is switched on, or `done`. */
export function nextStepAfter(id: WizardStepId, flags: Readonly<WizardFlags> = NO_FLAGS): WizardStepId {
    const enabled = stepsFor(flags).filter((s) => s.enabled);
    const at = enabled.findIndex((s) => s.id === id);
    return enabled[at + 1]?.id ?? 'done';
}

// ─── What is stored ──────────────────────────────────────────────────────────────────────────

export type StepStatus = 'done' | 'skipped';
export type Actor = 'tenant' | 'admin';

/** One entry of `onboarding.steps`, as read back and made safe: the column is JSONB, so anything could be in it. */
export interface StepEntry {
    status?: StepStatus;
    at?: string;
    by?: Actor;
    /** What was typed and not confirmed. Gone once the step is marked done again: Continue replaces the entry. */
    values?: Record<string, unknown>;
    saved_at?: string;
    /** When the page last showed the step: only for the time-on-step the funnel records. */
    viewed_at?: string;
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.length <= 40;

/** An entry as it may be shown: only the keys this module writes, each of the type it writes. */
export function readEntry(raw: unknown): StepEntry {
    if (!isObj(raw)) return {};
    const out: StepEntry = {};
    if (raw.status === 'done' || raw.status === 'skipped') out.status = raw.status;
    if (isIso(raw.at)) out.at = raw.at;
    if (raw.by === 'tenant' || raw.by === 'admin') out.by = raw.by;
    if (isObj(raw.values)) out.values = raw.values;
    if (isIso(raw.saved_at)) out.saved_at = raw.saved_at;
    if (isIso(raw.viewed_at)) out.viewed_at = raw.viewed_at;
    return out;
}

export interface OnboardingState {
    status: OnboardingStatus;
    current_step: string | null;
    steps: Record<string, StepEntry>;
    filled_by: Actor | null;
    started_at: Date | string | null;
    completed_at: Date | string | null;
}

const COLUMNS = 'status, current_step, steps, filled_by, started_at, completed_at';

function readRow(row: Loose): OnboardingState {
    const steps: Record<string, StepEntry> = {};
    if (isObj(row.steps)) {
        for (const id of WIZARD_STEP_IDS) if (id in row.steps) steps[id] = readEntry(row.steps[id]);
    }
    const status = row.status === 'invited' || row.status === 'in_progress' || row.status === 'completed' ? row.status : 'completed';
    return {
        status,
        current_step: typeof row.current_step === 'string' ? row.current_step : null,
        steps,
        filled_by: row.filled_by === 'tenant' || row.filled_by === 'admin' ? row.filled_by : null,
        started_at: (row.started_at as Date | string | null) ?? null,
        completed_at: (row.completed_at as Date | string | null) ?? null,
    };
}

/** The tenant's row, or null: no row at all reads as completed (D14), so callers treat null as "done, nothing to ask". */
export async function loadOnboarding(creatorId: string): Promise<OnboardingState | null> {
    const row = await queryOne<Loose>(`SELECT ${COLUMNS} FROM onboarding WHERE creator_id = $1`, [creatorId]);
    return row ? readRow(row) : null;
}

// ─── Resume, and the gate ────────────────────────────────────────────────────────────────────

const settled = (entry: StepEntry | undefined): boolean => entry?.status === 'done' || entry?.status === 'skipped';

/**
 * The first step that still has to be dealt with: a switched-on step that is neither done nor skipped, or `done` when none is.
 * A required step is never passed over, so this is also the furthest a person may go.
 */
export function firstOpenStep(steps: Record<string, StepEntry>, flags: Readonly<WizardFlags> = NO_FLAGS): WizardStepId {
    return formSteps(flags).find((s) => !settled(steps[s.id]))?.id ?? 'done';
}

/**
 * Where the page opens: the step the person last saw, but never past the first that is still open (a stored position beyond it
 * means the entry behind it was changed, and landing there would skip a required step), and `done` once completed.
 */
export function resumeStep(state: Pick<OnboardingState, 'status' | 'current_step' | 'steps'> | null, flags: Readonly<WizardFlags> = NO_FLAGS): WizardStepId {
    if (!state || state.status === 'completed') return 'done';
    const furthest = firstOpenStep(state.steps, flags);
    const order = stepsFor(flags).filter((s) => s.enabled).map((s) => s.id);
    const saved = state.current_step as WizardStepId | null;
    if (!saved || !order.includes(saved)) return furthest;
    return order.indexOf(saved) <= order.indexOf(furthest) ? saved : furthest;
}

/**
 * Is this session sent to the wizard from every other route? Only an OWNER of a tenant whose onboarding is not completed:
 *
 *   - `completed` is the first condition on purpose. The owner's tenant is completed (v34 inserted a row for every tenant that
 *     existed), a tenant with no row reads as completed, and so nothing about a deployment that predates onboarding can gate;
 *   - a platform admin is exempt: they reach every tenant to operate it, and are never sent into a setup they are not doing
 *     (`?mode=behalf` is the one way in, and the page asks for it);
 *   - only an owner can finish the wizard (the writes are owner-only), so an operator or a viewer joining an unfinished
 *     tenant is not trapped in a screen they cannot complete.
 */
export function onboardingGated(input: { status: OnboardingStatus | null; sessionRole: string | null; tenantRole: TenantRole | null }): boolean {
    if (input.status === null || input.status === 'completed') return false;
    if (input.sessionRole === 'platform_admin') return false;
    return input.tenantRole === 'owner';
}

export interface OnboardingBrief {
    status: OnboardingStatus;
    /** Where the page would open. */
    step: WizardStepId;
    /** Is this session sent to `#/welcome`? The dashboard's navigate gate reads this and nothing else. */
    gated: boolean;
}

/**
 * What `GET /api/auth/me` says about the session's tenant. `null` when it cannot be read (a deployment without v34, a failed
 * query): the dashboard then gates nothing. Failing open is the safe side: the worst case is a new tenant who is not sent to
 * the wizard, never an owner who is locked out of the dashboard.
 */
export async function describeOnboardingBrief(
    creatorId: string, who: { sessionRole: string | null; tenantRole: TenantRole | null }
): Promise<OnboardingBrief | null> {
    try {
        const state = await loadOnboarding(creatorId);
        const status: OnboardingStatus = state?.status ?? 'completed';
        // The flags only change where an UNFINISHED tenant resumes: nothing is asked for one that is completed (or has no row).
        const flags = status === 'completed' ? NO_FLAGS : await readWizardFlags();
        return {
            status,
            step: resumeStep(state, flags),
            gated: onboardingGated({ status, sessionRole: who.sessionRole, tenantRole: who.tenantRole }),
        };
    } catch (err) {
        log('warn', 'onboarding.brief_unreadable', { tenant_id: creatorId, ...describeError(err) });
        return null;
    }
}

// ─── What a draft may hold ───────────────────────────────────────────────────────────────────

export const STEP_VALUES_LIMITS = Object.freeze({ keys: 40, string: 2000, items: 30, bytes: 16 * 1024 });
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const isScalar = (v: unknown): boolean =>
    v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= STEP_VALUES_LIMITS.string);

/**
 * The reason `values` cannot be kept, or null. A flat object: text, numbers, booleans, null and lists of those. It is what a
 * form holds, and nothing a form holds needs to be deeper. Bounded so that an autosave is not a place to keep a file.
 */
export function validateStepValues(values: unknown): string | null {
    if (!isObj(values)) return 'values must be an object.';
    const keys = Object.keys(values);
    if (keys.length > STEP_VALUES_LIMITS.keys) return `values holds at most ${STEP_VALUES_LIMITS.keys} fields.`;
    for (const key of keys) {
        if (!KEY.test(key) || FORBIDDEN_KEYS.has(key)) return `"${key.slice(0, 40)}" is not a field name.`;
        const v = values[key];
        if (isScalar(v)) continue;
        if (Array.isArray(v) && v.length <= STEP_VALUES_LIMITS.items && v.every(isScalar)) continue;
        return `${key} must be text, a number, true or false, or a list of those (text up to ${STEP_VALUES_LIMITS.string} characters).`;
    }
    if (Buffer.byteLength(JSON.stringify(values), 'utf8') > STEP_VALUES_LIMITS.bytes) return `values is larger than ${STEP_VALUES_LIMITS.bytes} bytes.`;
    return null;
}

// ─── Events ──────────────────────────────────────────────────────────────────────────────────

export type WizardEvent = 'step_viewed' | 'step_completed' | 'step_skipped' | 'wizard_completed';

export interface EventContext {
    creatorId: string;
    userId: string | null;
    actor: Actor;
}

/**
 * One funnel row: the event, the step and numbers only (02 §6: "enums and paths only, never field values"). Best-effort: a
 * database without v34, or a failed insert, is logged and the request goes on. The funnel is not worth a failed Continue.
 */
export async function recordEvent(ctx: EventContext, event: WizardEvent, step: WizardStepId | null, props: Record<string, number | string> = {}): Promise<void> {
    try {
        await pool.query(
            'INSERT INTO onboarding_events (creator_id, user_id, actor, event, step, props) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
            [ctx.creatorId, ctx.userId, ctx.actor, event, step, JSON.stringify(props)]
        );
    } catch (err) {
        // Not `event:` — that key is the log line's own name.
        log('warn', 'onboarding.event_failed', { wizard_event: event, step, tenant_id: ctx.creatorId, ...describeError(err) });
    }
}

// ─── Reading, for the wizard ─────────────────────────────────────────────────────────────────

export interface TenantHints {
    /** What the operator typed when creating the tenant: the page offers them as a start, and the person confirms or changes them. */
    name: string | null;
    instagramUsername: string | null;
    websiteUrl: string | null;
}

async function loadHints(creatorId: string): Promise<TenantHints> {
    const row = await queryOne<{ name: string | null; instagram_username: string | null; website_url: string | null }>(
        'SELECT name, instagram_username, website_url FROM creators WHERE id = $1', [creatorId]
    );
    return { name: row?.name ?? null, instagramUsername: row?.instagram_username ?? null, websiteUrl: row?.website_url ?? null };
}

/** The answer of `GET /api/onboarding`. */
export interface WizardView {
    status: OnboardingStatus;
    /** Where to open. */
    step: WizardStepId;
    /** The registry, so the page and the server agree on the order and on what is switched on. */
    order: WizardStep[];
    steps: Record<string, StepEntry>;
    filledBy: Actor | null;
    startedAt: Date | string | null;
    completedAt: Date | string | null;
    /** The profile as it is now. `version` is what `PATCH /api/profile` must be sent back. */
    profile: ProfileState['profile'];
    version: number | null;
    stored: boolean;
    /** What activation still asks for (`activationMissing`). */
    missing: string[];
    hints: TenantHints;
    /** May this session write? Only an owner finishes the wizard. */
    canEdit: boolean;
    /** The draft engine's progress (P24). Null until it exists: the steps are plain forms. */
    draft: null;
}

/** The step values and times are the person's own typing: the page treats every one as text. */
export async function describeWizard(creatorId: string, who: { tenantRole: TenantRole | null }, given?: WizardFlags): Promise<WizardView> {
    const [state, profile, hints] = await Promise.all([loadOnboarding(creatorId), readProfileState(creatorId), loadHints(creatorId)]);
    // No row reads as completed (D14).
    const effective: OnboardingState = state ?? { status: 'completed', current_step: null, steps: {}, filled_by: null, started_at: null, completed_at: null };
    // What the operator switched on is read for a tenant that is still setting up: a finished one is never sent to a step.
    const flags = given ?? (effective.status === 'completed' ? NO_FLAGS : await readWizardFlags());
    return {
        status: effective.status,
        step: resumeStep(state, flags),
        order: stepsFor(flags),
        steps: effective.steps,
        filledBy: effective.filled_by,
        startedAt: effective.started_at,
        completedAt: effective.completed_at,
        profile: profile.profile,
        version: profile.version,
        stored: profile.stored,
        missing: profile.activationMissing,
        hints,
        canEdit: who.tenantRole === 'owner',
        draft: null,
    };
}

// ─── Writing a step ──────────────────────────────────────────────────────────────────────────

export class WizardError extends Error {
    constructor(readonly code: 'UNKNOWN_STEP' | 'BAD_REQUEST' | 'STEP_REQUIRED' | 'ONBOARDING_INCOMPLETE', readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
        this.name = 'WizardError';
    }
}

export interface StepInput {
    /** What was typed (autosave). */
    values?: unknown;
    /** Continue (`done`) or "Skip for now" (`skipped`): the step's entry is replaced, which also drops the draft values. */
    status?: unknown;
    /** The page is showing this step: it becomes where the person resumes. */
    viewed?: unknown;
}

export interface StepActor {
    userId: string | null;
    by: Actor;
}

const MAX_STEP_MS = 60 * 60 * 1000;

/** The milliseconds since `iso`, kept to a sensible range: a step left open overnight is not "a 9-hour step". Null when unknown. */
function msSince(iso: string | undefined, now: number): number | null {
    if (!iso) return null;
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return null;
    return Math.min(MAX_STEP_MS, Math.max(0, now - then));
}

/**
 * Autosave, mark done, skip, or note that a step is on screen. Always one `UPDATE` of one step's entry, so two tabs saving two
 * steps never overwrite each other. A tenant that is already `completed` (or has no row) changes nothing: the answer is the
 * state as it is, so a retried autosave after Finish is harmless rather than an error.
 */
export async function saveStep(
    creatorId: string, stepId: unknown, input: StepInput, actor: StepActor, now: number = Date.now(), given?: WizardFlags
): Promise<OnboardingState | null> {
    const step = stepById(stepId);
    // The operator's switches are read only when they can matter: for the one step they gate, and to find where Continue and
    // Skip lead next. An autosave of any other step asks nobody anything.
    const flags = given ?? (step && (step.id === 'connect' || input.status === 'done' || input.status === 'skipped') ? await readWizardFlags() : NO_FLAGS);
    const enabled = step ? stepsFor(flags).find((s) => s.id === step.id)?.enabled === true : false;
    if (!step || !enabled || step.id === 'done') throw new WizardError('UNKNOWN_STEP', 404, 'There is no such step.');

    const wantsStatus = input.status !== undefined;
    const wantsValues = input.values !== undefined;
    const wantsView = input.viewed !== undefined;
    if (!wantsStatus && !wantsValues && !wantsView) throw new WizardError('BAD_REQUEST', 400, 'Send values, a status, or viewed.');
    if (wantsStatus && input.status !== 'done' && input.status !== 'skipped') throw new WizardError('BAD_REQUEST', 400, 'status must be "done" or "skipped".');
    if (wantsView && input.viewed !== true) throw new WizardError('BAD_REQUEST', 400, 'viewed must be true.');
    if (wantsStatus && (wantsValues || wantsView)) throw new WizardError('BAD_REQUEST', 400, 'Send a status on its own: Continue replaces the draft, and it is not a view.');
    if (input.status === 'skipped' && step.required) throw new WizardError('STEP_REQUIRED', 409, 'This step cannot be skipped.');
    if (wantsValues) {
        const problem = validateStepValues(input.values);
        if (problem) throw new WizardError('BAD_REQUEST', 400, problem);
    }

    const current = await loadOnboarding(creatorId);
    // Nothing to write to: the tenant has no onboarding row (it reads as completed) or has finished.
    if (!current || current.status === 'completed') return current;

    const previous = current.steps[step.id] ?? {};
    const stamp = new Date(now).toISOString();
    let entry: StepEntry;
    let currentStep: string | null = null;
    if (input.status === 'done' || input.status === 'skipped') {
        // Replaced, not merged: the draft values are the unconfirmed copy, and Continue is what confirms them.
        entry = { status: input.status, at: stamp, by: actor.by };
        currentStep = nextStepAfter(step.id, flags);
    } else {
        entry = { ...previous };
        if (wantsValues) {
            entry.values = input.values as Record<string, unknown>;
            entry.saved_at = stamp;
        }
        if (wantsView) {
            entry.viewed_at = stamp;
            currentStep = step.id;
        }
    }
    // A view is recorded when the position changes, or when this step has never been shown (Continue moves the position to the
    // next step before the page has drawn it), so reloading the page on the same step is not a second view.
    const viewChanged = wantsView && (current.current_step !== step.id || !previous.viewed_at);

    const updated = await queryOne<Loose>(
        `UPDATE onboarding
            SET status = CASE WHEN status = 'invited' THEN 'in_progress' ELSE status END,
                started_at = COALESCE(started_at, NOW()),
                filled_by = CASE WHEN $3::text = 'admin' THEN 'admin' ELSE COALESCE(filled_by, $3::text) END,
                current_step = COALESCE($4::text, current_step),
                steps = jsonb_set(steps, ARRAY[$2::text], $5::jsonb, true)
          WHERE creator_id = $1 AND status <> 'completed'
      RETURNING ${COLUMNS}`,
        [creatorId, step.id, actor.by, currentStep, JSON.stringify(entry)]
    );
    // Finished in between: the answer is the state as it is.
    if (!updated) return loadOnboarding(creatorId);

    const ctx: EventContext = { creatorId, userId: actor.userId, actor: actor.by };
    if (input.status === 'done') {
        const ms = msSince(previous.viewed_at, now);
        await recordEvent(ctx, 'step_completed', step.id, ms === null ? {} : { ms_on_step: ms });
    } else if (input.status === 'skipped') {
        await recordEvent(ctx, 'step_skipped', step.id);
    } else if (viewChanged) {
        await recordEvent(ctx, 'step_viewed', step.id);
    }
    return readRow(updated);
}

// ─── Finishing ───────────────────────────────────────────────────────────────────────────────

/** Which step owns a missing activation field, so a refused Finish can send the person to the one that fixes it. */
export function stepForMissingField(field: string): WizardStepId {
    return field.startsWith('language.') ? 'voice' : 'about';
}

export interface Completion {
    status: 'completed';
    /** True when this call changed nothing: it was completed before (or there is no row to complete). */
    alreadyCompleted: boolean;
    step: 'done';
}

/**
 * Finish. Idempotent: the second call (a double tap, a retry after a dropped connection) answers the same and writes and
 * records nothing. The first needs the six activation fields (`activationMissing`) and says which are missing and which step
 * holds each, so the page can take the person back to it instead of showing an error.
 *
 * Creating the first campaign and compiling the DM persona belong to the proof step (P25), not to this one.
 */
export async function completeOnboarding(creatorId: string, actor: StepActor, now: number = Date.now()): Promise<Completion> {
    const current = await loadOnboarding(creatorId);
    if (!current || current.status === 'completed') return { status: 'completed', alreadyCompleted: true, step: 'done' };

    const profile = await readProfileState(creatorId);
    if (profile.activationMissing.length > 0) {
        const missing = profile.activationMissing;
        throw new WizardError('ONBOARDING_INCOMPLETE', 409, 'Some answers are still missing.', {
            missing,
            fixStep: stepForMissingField(missing[0]!),
        });
    }

    const done = await queryOne<{ started_at: Date | string | null; completed_at: Date | string | null; filled_by: Actor | null }>(
        `UPDATE onboarding
            SET status = 'completed', completed_at = NOW(), current_step = 'done',
                started_at = COALESCE(started_at, NOW()),
                filled_by = CASE WHEN $2::text = 'admin' THEN 'admin' ELSE COALESCE(filled_by, $2::text) END
          WHERE creator_id = $1 AND status <> 'completed'
      RETURNING started_at, completed_at, filled_by`,
        [creatorId, actor.by]
    );
    if (!done) return { status: 'completed', alreadyCompleted: true, step: 'done' };

    const startedAt = done.started_at ? new Date(done.started_at).getTime() : NaN;
    const props: Record<string, number | string> = { by: done.filled_by ?? actor.by };
    if (!Number.isNaN(startedAt)) props.total_ms = Math.max(0, now - startedAt);
    await recordEvent({ creatorId, userId: actor.userId, actor: actor.by }, 'wizard_completed', null, props);
    return { status: 'completed', alreadyCompleted: false, step: 'done' };
}
