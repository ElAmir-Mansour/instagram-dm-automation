/**
 * The drain loop: claim jobs, run them, record the outcome.
 *
 * Everything here takes its queue and its handlers as arguments rather than importing them,
 * which is what makes the retry, backoff and budget rules testable without a database or a
 * Meta account. The two production entry points that wire in the real ones are
 * `drainDefault` at the bottom of this file and the `/api/jobs/drain` route.
 *
 * The time budget is the part that is specific to this platform. A serverless invocation has
 * a wall clock, and a drain that starts a 30-second Gemini call with 4 seconds left produces
 * exactly the failure the queue was built to prevent — work abandoned mid-flight. So the loop
 * checks the budget before claiming the next job, and stops rather than starting work it
 * probably cannot finish. What it never claimed is still `pending`. What it had already claimed
 * but not reached (a claim takes a whole batch, and the budget can end partway through one) is
 * handed back to `pending` as it stops, with the attempt given back, rather than left `running`
 * for the reaper to free five minutes later. Either way the next drain takes it.
 */
import { withProfileCache } from '../services/profile/cache.js';
import { describeError, log, withLogContext } from '../utils/log.js';
import { failureRedaction } from './redaction.js';
import type { Job, JobHandlerRegistry, JobQueue, JobResult } from './types.js';

/**
 * How long a claim is considered live before a reaper may take it back.
 *
 * Has to exceed the longest a single job can legitimately take: a DM job is a Gemini call
 * (up to the 30s timeout in ai.ts) plus a Meta send with retries. Five minutes is generous
 * on purpose — reaping a job that is still running is how a DM gets sent twice, and that is
 * a worse outcome than a stranded job being retried a few minutes late.
 */
export const CLAIM_VISIBILITY_SECONDS = 300;

/**
 * Exponential backoff with jitter, in seconds: ~30s, ~2m, ~8m.
 *
 * Jittered because the failure that triggers a retry is usually shared — a Meta outage, an
 * expired token — so every job in the batch fails at once and would otherwise retry in
 * lockstep, turning one outage into a thundering herd against a service that is already
 * unhappy. Mirrors the jitter in `withRetry` (src/services/http.ts).
 */
export function backoffSeconds(attempts: number, random: () => number = Math.random): number {
    const base = 30 * 4 ** Math.max(0, attempts - 1);
    const capped = Math.min(base, 3600);
    return Math.round(capped * (0.5 + random()));
}

export interface DrainOptions {
    queue: JobQueue;
    handlers: JobHandlerRegistry;
    /** Stop claiming once this many milliseconds have elapsed. */
    budgetMs: number;
    /** Most jobs to claim in one round trip. */
    batchSize?: number;
    /** Hard ceiling on jobs per drain, so one call cannot loop forever. */
    maxJobs?: number;
    /** Injected for tests. */
    now?: () => number;
    /** Injected for tests. */
    random?: () => number;
}

export interface DrainResult {
    claimed: number;
    succeeded: number;
    failed: number;
    /** True when the loop stopped because of the budget, not because the queue was empty. */
    budgetExhausted: boolean;
}

/**
 * Run one job, translating its outcome into a queue call. Never throws.
 *
 * Each job gets a profile cache of its own (`withProfileCache`, a fresh scope even inside the request's). The
 * request's scope would otherwise be one snapshot for the whole drain, and a drain is up to 45 s of jobs: a
 * profile saved halfway through would be missed by everything after it. A job is short enough to share one.
 */
async function runOne(
    job: Job,
    handlers: JobHandlerRegistry,
    queue: JobQueue,
    random: () => number
): Promise<boolean> {
    return withProfileCache(() => runInScope(job, handlers, queue, random));
}

async function runInScope(
    job: Job,
    handlers: JobHandlerRegistry,
    queue: JobQueue,
    random: () => number
): Promise<boolean> {
    // Re-establish the correlation id from the enqueueing request, so a log search for one
    // Meta delivery turns up the work it caused and not just its acknowledgement.
    return withLogContext(
        {
            job_id: job.id,
            job_kind: job.kind,
            attempt: job.attempts,
            ...(job.request_id ? { request_id: job.request_id } : {}),
            ...(job.creator_id ? { creator_id: job.creator_id } : {}),
        },
        async () => {
            const startedAt = Date.now();
            try {
                // The registry is keyed by the same union `job.kind` is narrowed to, but the
                // per-kind payload types make the pairing unprovable to the compiler without
                // a discriminated switch at every call site. The queue guarantees the two
                // agree, so this is asserted once, here, rather than in each handler.
                const handler = handlers[job.kind] as (payload: unknown, job: Job) => Promise<void | JobResult>;
                const result = await handler(job.payload, job);

                // A handler that asks for its payload to be replaced (WhatsApp, for a stranger's message) has it replaced in the statement that
                // completes the job. Every other handler returns nothing and completes exactly as it always did.
                if (result && result.redactPayload !== undefined) await queue.complete(job.id, { payload: result.redactPayload });
                else await queue.complete(job.id);
                log('info', 'job.succeeded', { duration_ms: Date.now() - startedAt });
                return true;
            } catch (err) {
                const fields = describeError(err);
                const exhausted = job.attempts >= job.max_attempts;
                const retryIn = exhausted ? null : backoffSeconds(job.attempts, random);

                // Dead tokens and missing permissions do not become true on the fourth try.
                // Retrying them is how an app attracts Meta's enforcement attention — the
                // same reasoning as PERMANENT_CODES in src/services/http.ts.
                log(exhausted ? 'error' : 'warn', exhausted ? 'job.failed' : 'job.retrying', {
                    ...fields,
                    duration_ms: Date.now() - startedAt,
                    retry_in_seconds: retryIn,
                    attempts_remaining: Math.max(0, job.max_attempts - job.attempts),
                });

                try {
                    // The payload a handler asked to have redacted is replaced only by the failure that ENDS the job: while a retry is coming,
                    // the next attempt needs it.
                    const redact = exhausted ? failureRedaction(err) : null;
                    const message = String(fields['message'] ?? 'unknown error');
                    if (redact) await queue.fail(job.id, message, retryIn, redact);
                    else await queue.fail(job.id, message, retryIn);
                } catch (bookkeepingErr) {
                    // The database is the queue, so if this write fails the job stays
                    // `running` and the reaper is the backstop. Nothing else to do but say so.
                    log('error', 'job.bookkeeping_failed', describeError(bookkeepingErr));
                }
                return false;
            }
        }
    );
}

/**
 * Give back the jobs a drain claimed and then did not reach, because its budget ran out partway through the batch.
 *
 * `claim` takes the whole batch in one statement, so these are `running` with an attempt counted although nothing ever started them,
 * and only the reaper would free them, `CLAIM_VISIBILITY_SECONDS` later. The inline drain claims three at a time, so one slow DM
 * used to hold the other two back by about five minutes, and a job claimed on its last attempt was failed "[abandoned …]" for a run
 * it never had. Handed back, they are `pending` now, due and claimable by the very next drain, with the attempt refunded.
 *
 * Never throws, for the reason `drainJobs` never does: this runs on the way out of a drain that has already spent its time. A
 * failed release only leaves the jobs where they were, waiting for the reaper, which is what happened to every one of them before
 * this existed, so it says so and carries on.
 */
async function handBackUnrun(queue: JobQueue, jobs: Job[]): Promise<void> {
    if (jobs.length === 0) return;

    const jobIds = jobs.map((job) => job.id);
    try {
        // `released` can be lower than `unrun`: a row that is no longer `running` (the reaper got there first) is left as it is.
        const released = await queue.releaseUnrun(jobIds);
        log('info', 'job.released', { released, unrun: jobIds.length, job_ids: jobIds });
    } catch (err) {
        log('error', 'job.release_failed', { unrun: jobIds.length, job_ids: jobIds, ...describeError(err) });
    }
}

/**
 * Drain until the queue is empty, the budget is spent, or `maxJobs` is reached.
 *
 * Never throws: a drain is called from a webhook that has already answered Meta and from a
 * cron whose response nobody reads. There is nowhere for an exception to usefully go.
 */
export async function drainJobs(options: DrainOptions): Promise<DrainResult> {
    const {
        queue,
        handlers,
        budgetMs,
        batchSize = 5,
        maxJobs = 50,
        now = Date.now,
        random = Math.random,
    } = options;

    const startedAt = now();
    const result: DrainResult = { claimed: 0, succeeded: 0, failed: 0, budgetExhausted: false };

    while (result.claimed < maxJobs) {
        if (now() - startedAt >= budgetMs) {
            result.budgetExhausted = true;
            break;
        }

        let batch: Job[];
        try {
            batch = await queue.claim(Math.min(batchSize, maxJobs - result.claimed));
        } catch (err) {
            log('error', 'job.claim_failed', describeError(err));
            break;
        }

        if (batch.length === 0) break;

        for (const [index, job] of batch.entries()) {
            result.claimed++;
            if (await runOne(job, handlers, queue, random)) result.succeeded++;
            else result.failed++;

            // Checked inside the batch too: a batch of five DM jobs is potentially 40 seconds
            // of Gemini, and the budget has to be able to stop it partway.
            if (now() - startedAt >= budgetMs) {
                result.budgetExhausted = true;
                // The jobs after this one were claimed with it, in the same statement, and nothing is going to start them:
                // hand them back now instead of leaving them `running` for the reaper (see `handBackUnrun`).
                await handBackUnrun(queue, batch.slice(index + 1));
                break;
            }
        }

        if (result.budgetExhausted) break;
    }

    if (result.claimed > 0 || result.budgetExhausted) {
        log('info', 'job.drain_complete', {
            ...result,
            duration_ms: now() - startedAt,
        });
    }
    return result;
}
