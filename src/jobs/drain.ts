/**
 * Production wiring for the drain.
 *
 * Separate from `runner.ts` so that the runner — where the retry, backoff and budget rules
 * live — imports nothing but its own types. Importing the handler registry there would drag
 * the whole webhook pipeline, and therefore a live `pg.Pool`, into every test of the backoff
 * arithmetic.
 */
import { log } from '../utils/log.js';
import { handlers } from './handlers.js';
import { getJobQueue } from './queue.js';
import { CLAIM_VISIBILITY_SECONDS, drainJobs, type DrainResult } from './runner.js';

/**
 * Budget for the drain that runs inside a webhook invocation, after the 200 has been sent.
 *
 * Deliberately short. The webhook has already acknowledged Meta, so this is opportunistic
 * work — getting the common case (one comment, one DM) done immediately rather than waiting
 * for the next drain. Anything it does not finish stays `pending` and costs nothing.
 */
function inlineBudgetMs(): number {
    const configured = Number(process.env.JOB_INLINE_BUDGET_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 8_000;
}

/** Budget for a dedicated drain request, where the whole invocation is available. */
function workerBudgetMs(): number {
    const configured = Number(process.env.JOB_WORKER_BUDGET_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : 45_000;
}

/**
 * Drain opportunistically from inside a webhook invocation.
 *
 * Never throws and never rejects: it runs after the response has been sent, where an
 * unhandled rejection is an unexplained platform error and nothing more.
 */
export async function drainInline(): Promise<DrainResult | null> {
    try {
        // Reap before claiming, for the same reason `drainWorker` does — and it matters more
        // here, because this is the drain that gets frozen.
        //
        // The inline drain runs after the response, which on Vercel is exactly where the
        // invocation can be stopped. A job claimed and then frozen sits at `running` until
        // something reaps it, and the only two things that reap are `GET /api/jobs/drain` and
        // the daily cron. On a deployment with no external scheduler provisioned — which is
        // the documented state of this one — that is up to 24 hours of a comment or DM
        // sitting invisible in a state nothing is looking at, for a delivery the app was
        // otherwise perfectly able to finish on the next webhook seconds later.
        //
        // Two UPDATEs against a partial index that is empty whenever nothing is stale, so the
        // cost when there is nothing to do is negligible.
        try {
            await getJobQueue().reapStale(CLAIM_VISIBILITY_SECONDS);
        } catch (err) {
            // A failed reap must not stop the drain: there may be perfectly claimable work.
            log('warn', 'job.inline_reap_failed', { message: (err as Error)?.message });
        }

        return await drainJobs({
            queue: getJobQueue(),
            handlers,
            budgetMs: inlineBudgetMs(),
            // Small batches: the point is to finish this delivery's work, not to become a
            // worker. A large batch would also mean claiming jobs this invocation is
            // unlikely to reach before the budget runs out.
            batchSize: 3,
            maxJobs: 10,
        });
    } catch (err) {
        log('error', 'job.inline_drain_failed', { message: (err as Error)?.message });
        return null;
    }
}

/**
 * Drain as a worker: reap stale claims first, then work until the budget is spent.
 *
 * This is what an external scheduler calls. Reaping first is what turns a killed invocation
 * into a delayed job rather than a lost one.
 */
export async function drainWorker(): Promise<DrainResult & { reaped: number }> {
    const queue = getJobQueue();

    let reaped = 0;
    try {
        reaped = await queue.reapStale(CLAIM_VISIBILITY_SECONDS);
    } catch (err) {
        // A failed reap must not stop the drain — there may be perfectly claimable work.
        log('error', 'job.reap_failed', { message: (err as Error)?.message });
    }

    const result = await drainJobs({
        queue,
        handlers,
        budgetMs: workerBudgetMs(),
        batchSize: 5,
        maxJobs: 100,
    });

    return { ...result, reaped };
}
