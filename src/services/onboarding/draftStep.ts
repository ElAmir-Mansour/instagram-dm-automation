/**
 * What a draft does next: the decisions of the state machine, with no database, no clock and no network (docs/onboarding/03 §4;
 * the `nextThinkStep` pattern of `monteur/think.ts`). `drafts.ts` reads a row, asks these functions what to do, does it, and
 * writes the outcome; so every transition, the lease, the deadline and the retry policy are decided here, where they are
 * tested by value.
 *
 *   queued ──claim──▶ fetching ──sources saved──▶ drafting ──answers checked──▶ ready
 *      │                  │                           │
 *      └──────────────────┴───────────────┬───────────┘
 *                                         ├──▶ failed        (a final error, a spent retry budget, no source, too old)
 *                                         └──▶ superseded    (the tenant's inputs changed: a newer draft replaced it)
 *
 * TIMINGS (the plan's P24 row, 150 / 270 / 290):
 *   - a model call times out at 150 s;
 *   - one invocation works until its DEADLINE, 270 s after it started, and starts no step it cannot finish by then;
 *   - the LEASE it holds is 290 s, longer than the deadline, so a second caller cannot take the draft over while the first is
 *     still inside its time and bill the same draft twice;
 *   - the sweep stops at 280 s.
 *
 * RETRIES. At most three attempts, with a minute and then five minutes between them. What may be retried is what a later
 * try can fix (a network error, a 429, a 5xx or 529, a timeout, one malformed answer); what may not is what it cannot (no key,
 * a refused request, a refusal, an answer cut off, no source at all). A call that has answered is never asked again.
 */
import type { AiErrorKind } from '../llm/errors.js';
import { DRAFT_SCHEMAS, DRAFT_TIMEOUT_MS, type DraftCall } from './draftSchema.js';

// ─── Timings and limits ─────────────────────────────────────────────────────────────────────

/** One model call. Re-exported from the schema's own constant so the two cannot drift. */
export const CALL_TIMEOUT_MS = DRAFT_TIMEOUT_MS;
/** One invocation's working time. */
export const DEADLINE_MS = 270_000;
/** How long a claim holds the draft. Longer than the deadline by design. */
export const LEASE_MS = 290_000;
/** The sweep's own deadline: what it gives its drafts to finish in. */
export const SWEEP_DEADLINE_MS = 280_000;
/** The fetch phase, shared by every source (03 §1). */
export const FETCH_PHASE_MS = 25_000;
/** Left over after a step's work for writing its result. */
export const SAVE_MARGIN_MS = 8_000;
/** A fetch step is only started with this much time left: the phase and its write. */
export const MIN_FETCH_BUDGET_MS = FETCH_PHASE_MS + SAVE_MARGIN_MS + 2_000;
/** A draft step is only started with this much time left: a call that cannot be given a minute would only be cut off and billed. */
export const MIN_DRAFT_BUDGET_MS = 60_000 + SAVE_MARGIN_MS;
/** Three tries in all. */
export const MAX_ATTEMPTS = 3;
/** The wait after the first failed try, then after the second. */
export const BACKOFF_MS: readonly number[] = [60_000, 300_000];
/** A draft not finished this long after it was made is given up: nothing may stay "drafting" forever. */
export const MAX_AGE_MS = 30 * 60_000;
/** A malformed answer is retried once, not twice (06 §2). */
export const MAX_BAD_OUTPUT = 2;
/** How many steps one invocation may take (fetch, draft, and room for a surprise). */
export const MAX_STEPS_PER_ADVANCE = 4;
/** How many drafts the sweep works on at once, and how many it looks at per call. */
export const SWEEP_PARALLEL = 3;
export const SWEEP_BATCH = 10;
/** New drafts a tenant may start per UTC day (03 §4, "Re-draft limit"). */
export const DRAFTS_PER_DAY = 5;

// ─── Status ─────────────────────────────────────────────────────────────────────────────────

export const DRAFT_STATUSES = ['queued', 'fetching', 'drafting', 'ready', 'failed', 'superseded'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export const ACTIVE_STATUSES: readonly DraftStatus[] = ['queued', 'fetching', 'drafting'];

export const isActiveStatus = (status: string): boolean => (ACTIVE_STATUSES as readonly string[]).includes(status);
export const isTerminalStatus = (status: string): boolean => !isActiveStatus(status);

/** What can end a draft badly: a model call's kinds, and four of the engine's own. */
export type DraftErrorKind = AiErrorKind | 'no_source' | 'expired' | 'abandoned' | 'internal';

// ─── The next step ──────────────────────────────────────────────────────────────────────────

/** What `nextDraftStep` needs to know about a row. */
export interface StepRow {
    status: string;
    attempts: number;
    created_at: Date;
    next_attempt_at: Date | null;
    lease_until: Date | null;
    lease_owner: string | null;
    /** The fetched sources are stored (a `drafting` row without them goes back to fetching). */
    hasSources: boolean;
}

export type DraftStep =
    /** Nothing to do: ready, failed or superseded. */
    | { kind: 'terminal' }
    /** Older than `MAX_AGE_MS`: fail it. */
    | { kind: 'expire' }
    /** Its attempts are spent (an abandoned lease counts as one): fail it. */
    | { kind: 'exhausted' }
    /** Somebody else holds it, or its next try is not due. `untilMs` is when that stops being so. */
    | { kind: 'wait'; why: 'leased' | 'backoff'; untilMs: number }
    | { kind: 'fetch' }
    | { kind: 'draft' };

/**
 * What to do with a draft, from its row, the time, and who is asking (`owner`: the invocation, whose own lease does not
 * block it). Checked in this order: a finished draft is finished; an old one is given up; a spent one is failed; one held by
 * somebody else waits; one in back-off waits; then the work its status names.
 *
 * Age and attempts come BEFORE the lease: a draft nobody can finish must still be able to end, by whoever finds it.
 */
export function nextDraftStep(row: StepRow, nowMs: number, owner: string | null = null): DraftStep {
    if (isTerminalStatus(row.status)) return { kind: 'terminal' };
    if (nowMs - row.created_at.getTime() > MAX_AGE_MS) return { kind: 'expire' };
    if (row.attempts >= MAX_ATTEMPTS) return { kind: 'exhausted' };
    if (row.lease_until && row.lease_until.getTime() > nowMs && !(owner !== null && row.lease_owner === owner)) {
        return { kind: 'wait', why: 'leased', untilMs: row.lease_until.getTime() };
    }
    if (row.next_attempt_at && row.next_attempt_at.getTime() > nowMs) return { kind: 'wait', why: 'backoff', untilMs: row.next_attempt_at.getTime() };
    if (row.status === 'drafting' && row.hasSources) return { kind: 'draft' };
    return { kind: 'fetch' };
}

/** Whether a caller may fire `advance` now and expect it to do something: what the wizard's poll is told. */
export const isAdvanceable = (step: DraftStep): boolean => step.kind === 'fetch' || step.kind === 'draft' || step.kind === 'expire' || step.kind === 'exhausted';

// ─── Retries ────────────────────────────────────────────────────────────────────────────────

/** The attempt count after one more failed try, and when the next is due; null when that was the last try. */
export function retryPlan(attemptsBefore: number, nowMs: number): { attempts: number; nextAttemptAt: number } | null {
    const attempts = attemptsBefore + 1;
    if (attempts >= MAX_ATTEMPTS) return null;
    const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
    return { attempts, nextAttemptAt: nowMs + wait };
}

// ─── What the model calls came to ───────────────────────────────────────────────────────────

export interface CallFailure {
    kind: DraftErrorKind;
    retryable: boolean;
    message: string;
}

/** One call's state across tries: its answer once it has one, what went wrong each time, and whether it has been given up on. */
export interface CallState {
    answer?: unknown;
    errors: CallFailure[];
    /** Failed in a way a later try cannot fix: not asked again. */
    gaveUp: boolean;
}

export type CallsDecision =
    /** Build the draft from what answered. `partial`: a call did not. */
    | { kind: 'finish'; partial: boolean }
    /** Ask the calls in `missing` again, later. */
    | { kind: 'retry'; missing: DraftCall[]; attempts: number; nextAttemptAt: number }
    | { kind: 'fail'; errorKind: DraftErrorKind; message: string };

/** The kinds that tell an operator the most, first: a missing key explains more than a timeout does. */
const ERROR_PRIORITY: readonly DraftErrorKind[] = ['no_provider', 'auth', 'quota', 'budget', 'refusal', 'max_tokens', 'bad_request', 'rate', 'server', 'timeout', 'bad_output', 'internal'];

/**
 * Why a call's answer cannot be used at all, or null when it has the shape the schema asks for: a JSON object holding every section the call
 * is asked for. `{}`, a list, a string and an answer that stops half way are malformed; a complete answer of nothing but "unknown" and empty lists
 * is NOT malformed here (a creator who sells nothing correctly answers the business call that way): whether it says anything is `validateDraft`'s
 * `usable`, decided over both calls together.
 */
export function answerProblem(call: DraftCall, answer: unknown): string | null {
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return 'The model\'s answer was not a JSON object.';
    const required = (DRAFT_SCHEMAS[call] as { required?: readonly string[] }).required ?? [];
    const missing = required.filter((key) => !(key in answer));
    return missing.length > 0 ? `The model's answer left out ${missing.slice(0, 6).join(', ')}.` : null;
}

/** Whether a call's latest failure may be tried again. A malformed answer is allowed `MAX_BAD_OUTPUT` times in all. */
export function mayRetryCall(state: CallState): boolean {
    const last = state.errors[state.errors.length - 1];
    if (!last || !last.retryable) return false;
    if (last.kind === 'bad_output') return state.errors.filter((e) => e.kind === 'bad_output').length < MAX_BAD_OUTPUT;
    return true;
}

/**
 * What to do once the calls of one try have come back (some answered, some failed). Pure.
 *
 *   everything answered                    → finish
 *   something to retry and tries remain    → retry only what has not answered (never a call that did: it is already paid for)
 *   otherwise, at least one answer         → finish, partial: what landed is worth showing
 *   otherwise                              → fail, with the most telling error
 */
export function decideAfterCalls(calls: Readonly<Record<DraftCall, CallState>>, attemptsBefore: number, nowMs: number): CallsDecision {
    const names = Object.keys(calls) as DraftCall[];
    const missing = names.filter((n) => calls[n].answer === undefined);
    if (missing.length === 0) return { kind: 'finish', partial: false };

    const retriable = missing.filter((n) => !calls[n].gaveUp && mayRetryCall(calls[n]));
    if (retriable.length > 0) {
        const plan = retryPlan(attemptsBefore, nowMs);
        if (plan) return { kind: 'retry', missing: retriable, attempts: plan.attempts, nextAttemptAt: plan.nextAttemptAt };
    }
    if (missing.length < names.length) return { kind: 'finish', partial: true };

    // What each missing call said on its LATEST try: a draft that timed out twice and then answered with nothing ended on an empty answer.
    const errors = missing.flatMap((n) => calls[n].errors.slice(-1));
    const worst = ERROR_PRIORITY.map((kind) => errors.find((e) => e.kind === kind)).find((e) => e !== undefined) ?? errors[errors.length - 1];
    return { kind: 'fail', errorKind: worst?.kind ?? 'internal', message: worst?.message ?? 'The model gave no answer.' };
}

// ─── What the fetch came to ─────────────────────────────────────────────────────────────────

export type FetchDecision =
    | { kind: 'proceed' }
    | { kind: 'retry'; attempts: number; nextAttemptAt: number }
    | { kind: 'fail'; errorKind: DraftErrorKind };

/**
 * What to do when the fetch phase has finished. Any source that gave something is enough to draft from, so a source that
 * failed on its own never fails the draft. With nothing at all: a failure that a later try can fix is retried (while tries
 * remain); anything else is `no_source`.
 */
export function decideAfterFetch(usableSources: number, anyRetryable: boolean, attemptsBefore: number, nowMs: number): FetchDecision {
    if (usableSources > 0) return { kind: 'proceed' };
    if (anyRetryable) {
        const plan = retryPlan(attemptsBefore, nowMs);
        if (plan) return { kind: 'retry', ...plan };
    }
    return { kind: 'fail', errorKind: 'no_source' };
}

// ─── The budget of one invocation ───────────────────────────────────────────────────────────

/** Milliseconds left of `deadlineAt` at `nowMs`, never negative. */
export const remainingMs = (deadlineAt: number, nowMs: number): number => Math.max(0, deadlineAt - nowMs);

/** Whether there is time to start `step` (a fetch or a draft) before `deadlineAt`. */
export function hasBudgetFor(step: 'fetch' | 'draft', deadlineAt: number, nowMs: number): boolean {
    return remainingMs(deadlineAt, nowMs) >= (step === 'fetch' ? MIN_FETCH_BUDGET_MS : MIN_DRAFT_BUDGET_MS);
}

/** The most one model call may be given: its own limit, or what is left less the time to write the result. */
export function callTimeoutMs(deadlineAt: number, nowMs: number): number {
    return Math.max(1_000, Math.min(CALL_TIMEOUT_MS, remainingMs(deadlineAt, nowMs) - SAVE_MARGIN_MS));
}
