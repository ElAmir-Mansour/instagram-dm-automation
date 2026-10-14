/**
 * The draft engine: `profile_drafts` as a state machine that survives serverless invocations (docs/onboarding/03 §4, P24).
 *
 * A draft reads what a tenant gave (an Instagram handle, a website, a YouTube channel, a few lines) and asks a model for a Creator
 * Profile of them. That takes minutes, a Vercel function can end at any time, and the person waiting is looking at a wizard. So the
 * draft is a ROW with a lease, not a job in the shared queue (whose inline drain runs after the response, where the function is
 * frozen, and would hold comment replies back behind a two-minute job). Anything may move it forward: the admin's create, the
 * wizard's poll, or the backstop sweep a worker calls every minute. They cannot step on each other: the lease is one UPDATE.
 *
 *   `startDraft`    makes the row (or returns the one that already answers these inputs, or says the day's limit is spent)
 *   `advanceDraft`  claims the lease and takes steps until the draft is finished, has to wait, or the deadline is near
 *   `sweepDrafts`   advances the drafts nobody is working on
 *
 * A STEP is one bounded piece of work, saved before the next begins (`draftStep.ts` decides which; this file does it):
 *   fetch   the sources, in parallel, 25 s in all; saved, so a retry never fetches again
 *   draft   the voice and business calls, in parallel, 150 s each; a call that answered is saved and never asked again
 * so an invocation that dies after one leaves the next caller to resume at the other, not to start over. One `advanceDraft` takes as
 * many steps as its deadline (270 s) allows: the common case is a whole draft in one invocation, started by whoever asked first.
 *
 * WHAT A READY DRAFT IS. It is stored as a DRAFT and nothing else: not applied to the profile. The wizard (or an admin) applies it
 * field by field through `PATCH /api/profile`, so what the profile holds is what a person confirmed. Nothing outside this directory
 * reads `profile_drafts` (a test fails if it does): what a scraped page and a model's answer become is only ever shown to a person.
 *
 * NO KEY. With no AI provider configured the draft fails cleanly (`error_kind: no_provider`, `needsAiKey`) AFTER the fetch, and
 * keeps what code found (colours, the logo candidates, the social links, the handle) as a `prefill`, so the wizard continues by hand
 * with those filled in.
 */
import { randomBytes } from 'node:crypto';
import { pool } from '../../config/db.js';
import { describeError, log } from '../../utils/log.js';
import { generate, type AiGenerateResult } from '../aiProviders/generate.js';
import { isAiError } from '../llm/errors.js';
import { recordDraftEvent, type DraftOutcome } from '../onboardingEvents.js';
import { withTransaction } from '../studio/common.js';
import { buildDraftPrompt, PROFILE_DRAFT_V1 } from './draftPrompt.js';
import { DRAFT_CALLS, DRAFT_MAX_TOKENS, DRAFT_SCHEMAS, type DraftCall } from './draftSchema.js';
import { fetchDraftSources, type FetchOutcome } from './draftSources.js';
import {
    answerProblem, callTimeoutMs, decideAfterCalls, decideAfterFetch, DEADLINE_MS, DRAFTS_PER_DAY, hasBudgetFor, isActiveStatus, LEASE_MS, MAX_STEPS_PER_ADVANCE,
    MIN_FETCH_BUDGET_MS, nextDraftStep, retryPlan, SWEEP_BATCH, SWEEP_DEADLINE_MS, SWEEP_PARALLEL, type CallState, type DraftErrorKind,
} from './draftStep.js';
import {
    claimDraft, countStart, findReusableDraft, finishFailed, finishReady, insertDraft, LeaseLost, listDueDraftIds, loadCurrentDraft, loadDraft, lockTenantDrafts,
    markStatus, releaseDraft, saveFetched, saveRetry, supersedeDrafts, type DraftOrigin, type DraftRow,
} from './draftStore.js';
import { hasAnyInput, inputsHash, type DraftInputs } from './draftInputs.js';
import { emptyUsage, type AnswersColumn, type CallLog, type DraftCode, type DraftFacts, type FetchedBundle, type ResultColumn, type UsageLog } from './draftTypes.js';
import { readAnswers, readBundle, readUsage, stepRowOf } from './draftView.js';
import { scrubSecrets } from './sourceError.js';
import { validateDraft, type Draft, type DraftContext } from './validateDraft.js';

export { toDraftView } from './draftView.js';

// ─── Errors the routes answer with ──────────────────────────────────────────────────────────

export class DraftError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
        super(message);
        this.name = 'DraftError';
    }
}

// ─── Test seams ─────────────────────────────────────────────────────────────────────────────

type SourcesFetcher = typeof fetchDraftSources;
let fetchSources: SourcesFetcher = fetchDraftSources;

/** Tests only: what reads the sources. Returns the previous one, so a test can put it back. */
export function setDraftSourcesFetcher(next: SourcesFetcher): SourcesFetcher {
    const previous = fetchSources;
    fetchSources = next;
    return previous;
}

const newOwner = (): string => `adv-${randomBytes(6).toString('hex')}`;

/**
 * The funnel's three draft moments (P31): started, ready, failed. Enums and numbers only (how long, and the failure's KIND), never the
 * draft's text, a provider's words or anything that was fetched. A draft the operator asked for (`admin_create`, `redraft`) is the
 * operator's; one the wizard asked for is the tenant's; one that finishes on its own is filed under whoever asked. Best-effort.
 */
const noteDraft = (row: Pick<DraftRow, 'creator_id' | 'requested_by' | 'origin'>, outcome: DraftOutcome, details: { ms?: number; code?: string; partial?: boolean } = {}): Promise<void> =>
    recordDraftEvent(
        { creatorId: row.creator_id, userId: row.requested_by, actor: row.origin === 'admin_create' || row.origin === 'redraft' ? 'admin' : 'tenant' },
        outcome, { ...details, ...(outcome === 'started' && row.origin ? { origin: row.origin } : {}) },
    );

// ─── Starting ───────────────────────────────────────────────────────────────────────────────

export interface StartDraftArgs {
    creatorId: string;
    inputs: DraftInputs;
    origin: DraftOrigin;
    requestedBy: string | null;
    /** Make a new draft even though a finished one answers these inputs (a draft in flight is never restarted). */
    force?: boolean;
}

export interface StartDraftResult {
    row: DraftRow;
    /** The row already answered these inputs: nothing was made, and nothing counts against the day's limit. */
    reused: boolean;
    superseded: number;
}

/**
 * Make a draft, or find the one that already answers these inputs. In one transaction under the tenant's lock, so two starts
 * cannot both insert:
 *
 *   1. The same inputs (and prompt version) as a draft in flight, or as a ready one under 24 hours old → that row, as it is.
 *   2. Five new drafts today already → refused (`DRAFT_LIMIT`, 429). Counted in `app_rate_limit_counters`, increment first,
 *      and rolled back with everything else if the draft cannot be made.
 *   3. Otherwise any earlier draft that is in flight or ready is SUPERSEDED (new inputs replace the old draft; its in-flight
 *      invocation finds out at its next write), and the new one is inserted `queued`.
 */
export async function startDraft(args: StartDraftArgs): Promise<StartDraftResult> {
    if (!hasAnyInput(args.inputs)) {
        throw new DraftError(400, 'NO_INPUTS', 'There is nothing to read yet: give an Instagram handle, a website, a YouTube channel or a few lines about yourself.');
    }
    const hash = inputsHash(args.inputs, PROFILE_DRAFT_V1);
    const result = await withTransaction(async (tx) => {
        await lockTenantDrafts(tx, args.creatorId);
        const same = await findReusableDraft(tx, args.creatorId, hash);
        if (same && (!args.force || isActiveStatus(same.status))) return { row: same, reused: true, superseded: 0 };

        const started = await countStart(tx, args.creatorId);
        if (started > DRAFTS_PER_DAY) {
            throw new DraftError(429, 'DRAFT_LIMIT', `Drafts are limited to ${DRAFTS_PER_DAY} a day for each tenant, and today's are used up. Try again tomorrow, or fill the profile in by hand.`, { limit: DRAFTS_PER_DAY });
        }
        const superseded = await supersedeDrafts(tx, args.creatorId);
        const row = await insertDraft(tx, {
            creatorId: args.creatorId, origin: args.origin, requestedBy: args.requestedBy, inputs: args.inputs, hash, promptVersion: PROFILE_DRAFT_V1,
        });
        return { row, reused: false, superseded };
    });
    if (!result.reused) await noteDraft(result.row, 'started');
    log('info', result.reused ? 'onboarding.draft_reused' : 'onboarding.draft_started', {
        draft_id: result.row.id, creator_id: args.creatorId, origin: args.origin, status: result.row.status, superseded: result.superseded, forced: args.force === true,
        has_instagram: Boolean(args.inputs.instagram), has_website: Boolean(args.inputs.website), has_youtube: Boolean(args.inputs.youtube), has_about: Boolean(args.inputs.about), via: args.inputs.via,
    });
    return result;
}

/** The tenant's draft as it stands: the newest that was not replaced. Null when it has never had one. */
export const currentDraft = (creatorId: string): Promise<DraftRow | null> => loadCurrentDraft(pool, creatorId);
export const draftById = (id: string): Promise<DraftRow | null> => loadDraft(pool, id);

// ─── Advancing ──────────────────────────────────────────────────────────────────────────────

export interface AdvanceOptions {
    /** The clock, for tests. The database's `NOW()` still decides the lease; this decides time within the invocation. */
    now?: () => number;
    /** When this invocation must stop (epoch ms). Default: 270 s from now. */
    deadlineAt?: number;
    /** Who is asking: the lease's owner. Default: a fresh id for this invocation. */
    owner?: string;
}

export type AdvanceOutcome =
    /** No such draft. */
    | 'not_found'
    /** It was already finished, failed or superseded. */
    | 'terminal'
    /** Somebody else is working on it. */
    | 'busy'
    /** Its next try is not due (back-off). */
    | 'waiting'
    /** This invocation took at least one step (the draft may or may not be finished: read `row`). */
    | 'worked'
    /** The deadline came before the next step could be started: another caller continues. */
    | 'deadline'
    /** The draft stopped being ours part-way (its lease ran out, or it was superseded): nothing more was written. */
    | 'lease_lost';

export interface StepSummary {
    step: 'fetch' | 'draft' | 'fail';
    outcome: string;
    elapsed_ms: number;
}

export interface AdvanceResult {
    outcome: AdvanceOutcome;
    row: DraftRow | null;
    steps: StepSummary[];
    elapsed_ms: number;
}

interface StepContext {
    owner: string;
    now: () => number;
    deadlineAt: number;
    usage: UsageLog;
}

/**
 * Advance one draft: claim it, take steps, let go. Never throws for a draft that misbehaves: a step that breaks is a retry or a
 * failure of the draft, recorded on its row. (It does throw if the database is unreachable before it has claimed anything.)
 */
export async function advanceDraft(draftId: string, options: AdvanceOptions = {}): Promise<AdvanceResult> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const deadlineAt = options.deadlineAt ?? startedAt + DEADLINE_MS;
    const owner = options.owner ?? newOwner();
    const steps: StepSummary[] = [];
    const done = (outcome: AdvanceOutcome, row: DraftRow | null): AdvanceResult => ({ outcome, row, steps, elapsed_ms: now() - startedAt });

    const before = await loadDraft(pool, draftId);
    if (!before) return done('not_found', null);

    // Cheap early answers, so a poll or a sweep that finds nothing to do does not touch the lease. The CLAIM below is what decides.
    const early = nextDraftStep(stepRowOf(before), now());
    if (early.kind === 'terminal') return done('terminal', before);
    if (early.kind === 'wait') return done(early.why === 'leased' ? 'busy' : 'waiting', before);

    const claimed = await claimDraft(pool, draftId, owner, LEASE_MS);
    if (!claimed) return done('busy', await loadDraft(pool, draftId));
    // An owner that never let go (a function that died mid-step): its try is spent (the claim counted it), and it is worth a line.
    const abandoned = before.lease_owner !== null;
    if (abandoned) log('warn', 'onboarding.draft_abandoned_lease', { draft_id: draftId, creator_id: claimed.creator_id, attempts: claimed.attempts, previous_owner: before.lease_owner });

    const ctx: StepContext = { owner, now, deadlineAt, usage: readUsage(claimed.usage) ?? emptyUsage() };
    ctx.usage.advances += 1;
    let row = claimed;
    let outcome: AdvanceOutcome = 'worked';
    let inStep: { step: 'fetch' | 'draft'; since: number } | null = null;
    try {
        for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
            const step = nextDraftStep(stepRowOf(row), now(), owner);
            if (step.kind === 'terminal' || step.kind === 'wait') break;
            const t0 = now();
            if (step.kind === 'expire') {
                row = await failDraft(ctx, row, 'expired', 'The draft was not finished in time and was given up.');
                steps.push({ step: 'fail', outcome: 'expired', elapsed_ms: now() - t0 });
                break;
            }
            if (step.kind === 'exhausted') {
                row = await failDraft(ctx, row, abandoned ? 'abandoned' : ((row.error_kind as DraftErrorKind | null) ?? 'internal'), row.error ?? 'The draft used up its tries.');
                steps.push({ step: 'fail', outcome: 'exhausted', elapsed_ms: now() - t0 });
                break;
            }
            if (!hasBudgetFor(step.kind, deadlineAt, now())) {
                outcome = steps.length === 0 ? 'deadline' : 'worked';
                log('info', 'onboarding.draft_deadline', { draft_id: draftId, creator_id: row.creator_id, next: step.kind, remaining_ms: Math.max(0, deadlineAt - now()) });
                break;
            }
            inStep = { step: step.kind, since: t0 };
            row = step.kind === 'fetch' ? await fetchStep(ctx, row) : await draftStep(ctx, row);
            inStep = null;
            steps.push({ step: step.kind, outcome: row.status, elapsed_ms: now() - t0 });
        }
    } catch (err) {
        if (err instanceof LeaseLost) {
            outcome = 'lease_lost';
            log('warn', 'onboarding.draft_lease_lost', { draft_id: draftId, creator_id: claimed.creator_id, owner, what: err.what, elapsed_ms: now() - startedAt });
        } else {
            // A bug or a database that went away mid-step. The draft must not be left claimed and silent: it is a failed try.
            log('error', 'onboarding.draft_step_crashed', { draft_id: draftId, creator_id: claimed.creator_id, step: inStep?.step ?? null, ...describeError(err) });
            if (inStep) steps.push({ step: inStep.step, outcome: 'crashed', elapsed_ms: now() - inStep.since });
            try {
                // What an unexpected exception says is stored on the row for the operator: scrubbed of anything key-shaped, and cut short.
                row = await retryOrFail(ctx, row, 'internal', scrubSecrets(err instanceof Error ? err.message : String(err)), true);
            } catch (inner) {
                if (!(inner instanceof LeaseLost)) log('error', 'onboarding.draft_crash_unrecorded', { draft_id: draftId, ...describeError(inner) });
                outcome = 'lease_lost';
            }
        }
    } finally {
        try {
            await releaseDraft(pool, draftId, owner);
        } catch (err) {
            // The lease simply runs out (290 s); the next caller takes the draft over then.
            log('warn', 'onboarding.draft_release_failed', { draft_id: draftId, ...describeError(err) });
        }
    }

    const finalRow = (await loadDraft(pool, draftId)) ?? row;
    // Claimed, and then nothing to do: the draft's back-off had not run out by this process's clock (the database's `NOW()` said it had).
    const result = done(steps.length === 0 && outcome === 'worked' ? 'waiting' : outcome, finalRow);
    log('info', 'onboarding.draft_advance', {
        draft_id: draftId, creator_id: finalRow.creator_id, outcome: result.outcome, status: finalRow.status, attempts: finalRow.attempts,
        steps: steps.map((s) => `${s.step}:${s.outcome}`).join(','), elapsed_ms: result.elapsed_ms,
    });
    return result;
}

// ─── The fetch step ─────────────────────────────────────────────────────────────────────────

const summarize = (outcome: FetchOutcome): string => {
    const parts = (Object.entries(outcome.status) as Array<[string, FetchOutcome['status'][keyof FetchOutcome['status']]]>)
        .filter(([, r]) => r.state !== 'ok')
        .map(([name, r]) => `${name} ${r.state}${r.kind ? ` (${r.kind})` : ''}`);
    return parts.length ? `Nothing could be read: ${parts.join('; ')}.` : 'Nothing could be read.';
};

async function fetchStep(ctx: StepContext, claimed: DraftRow): Promise<DraftRow> {
    const t0 = ctx.now();
    let row = claimed;
    if (row.status === 'queued') row = await markStatus(pool, row.id, ctx.owner, 'fetching');
    const outcome = await fetchSources(row.creator_id, row.inputs);
    const elapsed = ctx.now() - t0;
    const decision = decideAfterFetch(outcome.usable, outcome.anyRetryable, row.attempts, ctx.now());
    ctx.usage.steps.push({ step: 'fetch', at: new Date(ctx.now()).toISOString(), elapsed_ms: elapsed, outcome: decision.kind === 'proceed' ? 'ok' : decision.kind === 'retry' ? 'retry' : 'failed', attempt: row.attempts + 1 });
    log('info', 'onboarding.draft_step', {
        draft_id: row.id, creator_id: row.creator_id, step: 'fetch', outcome: decision.kind, attempt: row.attempts + 1, elapsed_ms: elapsed, sources: outcome.usable,
    });

    if (decision.kind === 'proceed') {
        return saveFetched(pool, row.id, ctx.owner, { sources: outcome.bundle, sourcesStatus: outcome.status, usage: ctx.usage });
    }
    if (decision.kind === 'retry') {
        return saveRetry(pool, row.id, ctx.owner, {
            attempts: decision.attempts, nextAttemptAt: new Date(decision.nextAttemptAt), error: summarize(outcome), errorKind: 'no_source',
            sourcesStatus: outcome.status, usage: ctx.usage,
        });
    }
    const failed = await finishFailed(pool, row.id, ctx.owner, { error: summarize(outcome), errorKind: decision.errorKind, draft: null, sourcesStatus: outcome.status, usage: ctx.usage });
    await noteDraft(failed, 'failed', { ms: ctx.now() - row.created_at.getTime(), code: decision.errorKind });
    return failed;
}

// ─── The draft step ─────────────────────────────────────────────────────────────────────────

/** What `validateDraft` is given besides the model's answers: everything code found, and nothing a model said. */
function contextOf(bundle: FetchedBundle, inputs: DraftInputs): DraftContext {
    const f = bundle.facts;
    return {
        sources: bundle.sources,
        signals: bundle.signals,
        candidates: bundle.candidates,
        keywordsInUse: f.keywordsInUse,
        knownUrls: f.knownUrls,
        knownEmails: f.knownEmails,
        knownPhones: f.knownPhones,
        code: {
            brand: f.brand ? { primary: f.brand.primary, accent: f.brand.accent } : null,
            socials: { handle: f.handle, site: f.site?.pages[0]?.url ?? inputs.website, links: f.socialLinks },
        },
    };
}

/** Facts for the screen: everything in `DraftFacts` except the lists that only `validateDraft` reads. */
function codeOf(f: DraftFacts): DraftCode {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { knownUrls, knownEmails, knownPhones, keywordsInUse, ...shown } = f;
    return shown;
}

/** What code alone found: no model answered, so this is only the colours, the logo candidates, the links and the handle. */
function prefillOf(bundle: FetchedBundle, inputs: DraftInputs): ResultColumn {
    return { stage: 'prefill', result: validateDraft({}, contextOf(bundle, inputs)), code: codeOf(bundle.facts), models: {}, promptVersion: PROFILE_DRAFT_V1 };
}

type CallResult =
    | { call: DraftCall; ok: true; result: AiGenerateResult }
    | { call: DraftCall; ok: false; kind: DraftErrorKind; retryable: boolean; message: string; usageIn: number; usageOut: number; provider: string; model: string };

async function askCall(call: DraftCall, bundle: FetchedBundle, creatorId: string, timeoutMs: number): Promise<CallResult> {
    try {
        const prompt = buildDraftPrompt({ call, sources: bundle.sources, signals: bundle.signals });
        const result = await generate({
            purpose: 'onboarding_draft', creatorId, system: prompt.system, user: prompt.user,
            schema: DRAFT_SCHEMAS[call], maxTokens: DRAFT_MAX_TOKENS, timeoutMs,
        });
        return { call, ok: true, result };
    } catch (err) {
        if (isAiError(err)) {
            return { call, ok: false, kind: err.kind, retryable: err.retryable, message: err.message, usageIn: err.usage?.in ?? 0, usageOut: err.usage?.out ?? 0, provider: err.provider, model: err.model };
        }
        // Not a provider's refusal: the prompt could not be built (a bug), or the usage tables could not be written (the database).
        // A later try may fix the second and never the first; the message says which.
        const message = err instanceof Error ? err.message : String(err);
        return { call, ok: false, kind: 'internal', retryable: !/fence is not intact/.test(message), message: message.slice(0, 240), usageIn: 0, usageOut: 0, provider: '', model: '' };
    }
}

async function draftStep(ctx: StepContext, row: DraftRow): Promise<DraftRow> {
    const t0 = ctx.now();
    const bundle = readBundle(row.sources);
    if (!bundle) throw new Error('A drafting row has no stored sources.');
    const calls = readAnswers(row.draft);
    const toAsk = DRAFT_CALLS.filter((c) => calls[c].answer === undefined && !calls[c].gaveUp);
    const timeoutMs = callTimeoutMs(ctx.deadlineAt, ctx.now());

    const results = await Promise.all(toAsk.map((call) => askCall(call, bundle, row.creator_id, timeoutMs)));
    for (const r of results) {
        const rec = calls[r.call];
        if (r.ok) {
            ctx.usage.totals.usd = Math.round((ctx.usage.totals.usd + r.result.usd) * 1e6) / 1e6;
            ctx.usage.totals.usage_in += r.result.usage.in;
            ctx.usage.totals.usage_out += r.result.usage.out;
            // An answer that is not even the shape the schema asks for (`{}`, a list, a missing section) is a malformed answer: it was billed, and it is
            // retried like one, never taken as the model's word.
            const problem = answerProblem(r.call, r.result.json);
            if (problem) {
                rec.errors.push({ kind: 'bad_output', retryable: true, message: problem });
            } else {
                rec.answer = r.result.json;
                rec.provider = r.result.provider;
                rec.model = r.result.model;
            }
            const logged: CallLog = {
                call: r.call, provider: r.result.provider, model: r.result.model, effort: r.result.effort, usage_in: r.result.usage.in, usage_out: r.result.usage.out,
                usd: r.result.usd, priced: r.result.priced, elapsed_ms: r.result.elapsed_ms, outcome: problem ? 'bad_output' : 'ok', usage_id: r.result.usageId,
            };
            ctx.usage.calls.push(logged);
        } else {
            rec.errors.push({ kind: r.kind, retryable: r.retryable, message: r.message });
            if (!r.retryable) rec.gaveUp = true;
            ctx.usage.totals.usage_in += r.usageIn;
            ctx.usage.totals.usage_out += r.usageOut;
            ctx.usage.calls.push({ call: r.call, provider: r.provider, model: r.model, effort: '', usage_in: r.usageIn, usage_out: r.usageOut, usd: 0, priced: true, elapsed_ms: 0, outcome: r.kind });
        }
    }
    const elapsed = ctx.now() - t0;

    const states: Record<DraftCall, CallState> = { voice: calls.voice, business: calls.business };
    let decision = decideAfterCalls(states, row.attempts, ctx.now());

    // Every call that will ever answer has: check what they said, in code, BEFORE it is called a draft.
    let result: Draft | null = null;
    if (decision.kind === 'finish') {
        try {
            result = validateDraft({ voice: calls.voice.answer, business: calls.business.answer }, contextOf(bundle, row.inputs));
        } catch (err) {
            log('error', 'onboarding.draft_validate_crashed', { draft_id: row.id, creator_id: row.creator_id, ...describeError(err) });
            return failDraft(ctx, row, 'internal', 'The answers could not be checked.', bundle);
        }
        if (!result.usable) {
            // Well formed and EMPTY: nothing the model said survived the checks (an answer of nothing but unknowns, or no usable field besides the
            // posts code picked as samples). That is a malformed answer by another name: it is retried like one (one more try, then it ends as
            // `bad_output`), and it is never a draft, however many fields code filled in around it.
            for (const call of DRAFT_CALLS) {
                const rec = calls[call];
                if (rec.answer === undefined) continue;
                delete rec.answer;
                delete rec.provider;
                delete rec.model;
                rec.errors.push({ kind: 'bad_output', retryable: true, message: 'The model\'s answer held nothing a person could use.' });
            }
            for (const logged of ctx.usage.calls.slice(-results.length)) if (logged.outcome === 'ok') logged.outcome = 'bad_output';
            result = null;
            decision = decideAfterCalls(states, row.attempts, ctx.now());
        }
    }

    ctx.usage.steps.push({ step: 'draft', at: new Date(ctx.now()).toISOString(), elapsed_ms: elapsed, outcome: decision.kind === 'finish' ? 'ok' : decision.kind === 'retry' ? 'retry' : 'failed', attempt: row.attempts + 1 });
    log('info', 'onboarding.draft_step', {
        draft_id: row.id, creator_id: row.creator_id, step: 'draft', outcome: decision.kind, attempt: row.attempts + 1, elapsed_ms: elapsed,
        asked: toAsk.join(','), answered: toAsk.filter((c) => calls[c].answer !== undefined).join(','),
        failed: toAsk.filter((c) => calls[c].answer === undefined).map((c) => `${c}:${calls[c].errors[calls[c].errors.length - 1]?.kind ?? 'none'}`).join(','),
        usage_in: ctx.usage.totals.usage_in, usage_out: ctx.usage.totals.usage_out, usd: ctx.usage.totals.usd,
    });

    const column: AnswersColumn = { stage: 'answers', calls };

    if (decision.kind === 'retry') {
        const errors = calls[decision.missing[0]!]?.errors ?? [];
        const last = errors[errors.length - 1];
        return saveRetry(pool, row.id, ctx.owner, {
            attempts: decision.attempts, nextAttemptAt: new Date(decision.nextAttemptAt), error: last?.message ?? 'A model call failed.', errorKind: last?.kind ?? 'internal',
            draft: column, usage: ctx.usage,
        });
    }
    if (decision.kind === 'fail') {
        return failDraft(ctx, row, decision.errorKind, decision.message, bundle);
    }
    if (!result) throw new Error('A finished draft has no checked result.');

    const models: ResultColumn['models'] = {};
    for (const call of DRAFT_CALLS) if (calls[call].provider && calls[call].model) models[call] = { provider: calls[call].provider!, model: calls[call].model! };
    const finished: ResultColumn = { stage: 'final', result, code: codeOf(bundle.facts), models, promptVersion: PROFILE_DRAFT_V1 };
    const ready = await finishReady(pool, row.id, ctx.owner, { draft: finished, partial: decision.partial || result.partial, usage: ctx.usage });
    await noteDraft(ready, 'ready', { ms: ctx.now() - row.created_at.getTime(), partial: ready.partial === true });
    log('info', 'onboarding.draft_ready', {
        draft_id: row.id, creator_id: row.creator_id, partial: ready.partial, flags: result.flags.length, touched: result.touched.length,
        total_ms: ctx.now() - row.created_at.getTime(), attempts: ready.attempts, usd: ctx.usage.totals.usd,
    });
    return ready;
}

// ─── Ending a draft ─────────────────────────────────────────────────────────────────────────

/** A final failure. The prefill (what code found) is kept whenever the fetch had run, so the wizard can still fill what it can. */
async function failDraft(ctx: StepContext, row: DraftRow, kind: DraftErrorKind, message: string, bundle: FetchedBundle | null = readBundle(row.sources)): Promise<DraftRow> {
    const prefill = bundle ? prefillOf(bundle, row.inputs) : null;
    const failed = await finishFailed(pool, row.id, ctx.owner, { error: message.slice(0, 500), errorKind: kind, draft: prefill, usage: ctx.usage });
    await noteDraft(failed, 'failed', { ms: ctx.now() - row.created_at.getTime(), code: kind });
    log('warn', 'onboarding.draft_failed', {
        draft_id: row.id, creator_id: row.creator_id, error_kind: kind, attempts: row.attempts, total_ms: ctx.now() - row.created_at.getTime(), prefill: prefill !== null,
        message: message.slice(0, 240),
    });
    return failed;
}

/** A try that went wrong in a way that may pass: count it and come back, or, with no tries left, end the draft. */
async function retryOrFail(ctx: StepContext, row: DraftRow, kind: DraftErrorKind, message: string, retryable: boolean): Promise<DraftRow> {
    const plan = retryable ? retryPlan(row.attempts, ctx.now()) : null;
    if (!plan) return failDraft(ctx, row, kind, message);
    return saveRetry(pool, row.id, ctx.owner, { attempts: plan.attempts, nextAttemptAt: new Date(plan.nextAttemptAt), error: message.slice(0, 500), errorKind: kind, usage: ctx.usage });
}

// ─── The backstop ───────────────────────────────────────────────────────────────────────────

export interface SweepOptions {
    now?: () => number;
    deadlineMs?: number;
}

export interface SweepResult {
    considered: number;
    advanced: number;
    skipped: number;
    finished: number;
    outcomes: Record<string, number>;
    elapsed_ms: number;
}

/**
 * The drafts nobody is working on (not held, not in back-off), oldest first, up to `SWEEP_BATCH`; `SWEEP_PARALLEL` at a time, each
 * given what is left of the sweep's 280 s (never more than a draft's own 270). A draft the sweep cannot start before then is left for
 * the next call, which a worker makes about every minute. It is the backstop and not the main road: the admin's create and the
 * wizard's poll move drafts on first, and this finds the ones whose invocation was lost, whose back-off is over, or that nobody opened.
 */
export async function sweepDrafts(options: SweepOptions = {}): Promise<SweepResult> {
    const now = options.now ?? Date.now;
    const startedAt = now();
    const sweepEnd = startedAt + (options.deadlineMs ?? SWEEP_DEADLINE_MS);
    const ids = await listDueDraftIds(pool, SWEEP_BATCH);
    const outcomes: Record<string, number> = {};
    let advanced = 0;
    let skipped = 0;
    let finished = 0;
    let next = 0;

    const worker = async (): Promise<void> => {
        for (;;) {
            const id = ids[next++];
            if (id === undefined) return;
            // Not worth claiming a draft there is no time to take a step of: it would sit leased, doing nothing, for 290 s.
            if (sweepEnd - now() < MIN_FETCH_BUDGET_MS) {
                skipped += 1;
                continue;
            }
            try {
                const result = await advanceDraft(id, { now, deadlineAt: Math.min(sweepEnd, now() + DEADLINE_MS) });
                outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
                if (result.outcome === 'worked') advanced += 1;
                if (result.row && !isActiveStatus(result.row.status)) finished += 1;
            } catch (err) {
                outcomes.error = (outcomes.error ?? 0) + 1;
                log('error', 'onboarding.sweep_draft_failed', { draft_id: id, ...describeError(err) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(SWEEP_PARALLEL, ids.length) }, worker));

    const result: SweepResult = { considered: ids.length, advanced, skipped, finished, outcomes, elapsed_ms: now() - startedAt };
    log(ids.length > 0 ? 'info' : 'debug', 'onboarding.sweep', { ...result, outcomes: JSON.stringify(outcomes) });
    return result;
}
