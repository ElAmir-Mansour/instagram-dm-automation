/**
 * The drain loop's rules: what gets retried, how long the backoff is, and when the loop
 * stops because the invocation is about to end.
 *
 * All of it against a fake queue. The point of `drainJobs` taking its queue and handlers as
 * arguments is that the interesting behaviour — a handler that throws on attempt 2 and
 * succeeds on attempt 3, a budget that expires mid-batch — can be provoked deterministically,
 * which against Postgres and Gemini it cannot.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { backoffSeconds, drainJobs } from './runner.js';
import type { EnqueueInput, Job, JobHandlerRegistry, JobKind, JobQueue } from './types.js';

// The drain logs an event per job by design. Swallow it here so the assertions are not
// buried in output — what the logger emits is covered by src/utils/log.test.ts.
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

interface FailCall {
    jobId: string;
    error: string;
    retryInSeconds: number | null;
}

/** A queue that hands out a scripted list of batches and records what happened to each job. */
function fakeQueue(batches: Job[][]): JobQueue & {
    completed: string[];
    failed: FailCall[];
    claims: number[];
    enqueued: EnqueueInput[];
} {
    const completed: string[] = [];
    const failed: FailCall[] = [];
    const claims: number[] = [];
    const enqueued: EnqueueInput[] = [];
    let next = 0;

    return {
        completed,
        failed,
        claims,
        enqueued,
        async enqueue(input) {
            enqueued.push(input as EnqueueInput);
            return 'job-new';
        },
        async claim(limit) {
            claims.push(limit);
            return batches[next++] ?? [];
        },
        async complete(jobId) {
            completed.push(jobId);
        },
        async fail(jobId, error, retryInSeconds) {
            failed.push({ jobId, error, retryInSeconds });
        },
        async reapStale() {
            return 0;
        },
        async pruneCompleted() {
            return 0;
        },
    };
}

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: 'job-1',
        kind: 'comment.process' as JobKind,
        payload: { change: {}, entryId: 'entry-1' } as Job['payload'],
        attempts: 1,
        max_attempts: 3,
        request_id: 'req-1',
        creator_id: 'creator-1',
        ...overrides,
    } as Job;
}

/** Handlers that record what they saw and behave as scripted. */
function handlersThat(behaviour: (job: Job) => void | Promise<void>): {
    registry: JobHandlerRegistry;
    seen: Job[];
} {
    const seen: Job[] = [];
    const run = async (_payload: unknown, j: Job) => {
        seen.push(j);
        await behaviour(j);
    };
    return {
        seen,
        registry: {
            'comment.process': run,
            'dm.process': run,
        } as unknown as JobHandlerRegistry,
    };
}

describe('backoffSeconds', () => {
    it('grows exponentially across attempts', () => {
        const noJitter = () => 0.5; // -> multiplier of exactly 1
        assert.equal(backoffSeconds(1, noJitter), 30);
        assert.equal(backoffSeconds(2, noJitter), 120);
        assert.equal(backoffSeconds(3, noJitter), 480);
    });

    it('caps the delay so a job cannot be pushed days out', () => {
        assert.ok(backoffSeconds(20, () => 0.5) <= 3600);
    });

    it('jitters within +-50% of the base', () => {
        // Jitter matters because the failure that triggers a retry is usually shared — an
        // expired token fails every queued job at once, and un-jittered backoff would retry
        // them all in lockstep against a service that is already unhappy.
        assert.equal(backoffSeconds(1, () => 0), 15);
        assert.equal(backoffSeconds(1, () => 1), 45);
    });

    it('treats attempt 0 as attempt 1 rather than producing a shorter delay', () => {
        assert.equal(backoffSeconds(0, () => 0.5), 30);
    });
});

describe('drainJobs', () => {
    const budget = { budgetMs: 10_000 };

    it('completes a job whose handler returns', async () => {
        const queue = fakeQueue([[job({ id: 'a' })]]);
        const { registry, seen } = handlersThat(() => {});

        const result = await drainJobs({ queue, handlers: registry, ...budget });

        assert.deepEqual(queue.completed, ['a']);
        assert.equal(queue.failed.length, 0);
        assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, budgetExhausted: false });
        assert.equal(seen.length, 1);
    });

    it('passes the stored payload through to the handler', async () => {
        const payload = { change: { field: 'comments' }, entryId: 'entry-9' };
        const queue = fakeQueue([[job({ payload: payload as Job['payload'] })]]);
        const received: unknown[] = [];
        const registry = {
            'comment.process': async (p: unknown) => {
                received.push(p);
            },
            'dm.process': async () => {},
        } as unknown as JobHandlerRegistry;

        await drainJobs({ queue, handlers: registry, ...budget });
        assert.deepEqual(received, [payload]);
    });

    it('schedules a retry when a handler throws and attempts remain', async () => {
        const queue = fakeQueue([[job({ id: 'b', attempts: 1, max_attempts: 3 })]]);
        const { registry } = handlersThat(() => {
            throw new Error('Gemini timed out');
        });

        const result = await drainJobs({
            queue, handlers: registry, ...budget, random: () => 0.5,
        });

        assert.equal(queue.completed.length, 0);
        assert.equal(queue.failed.length, 1);
        assert.equal(queue.failed[0]!.jobId, 'b');
        assert.equal(queue.failed[0]!.error, 'Gemini timed out');
        assert.equal(queue.failed[0]!.retryInSeconds, 30);
        assert.equal(result.failed, 1);
    });

    it('gives up permanently once attempts are spent', async () => {
        // retryInSeconds === null is what tells the queue to mark the job `failed` rather
        // than pending. A job that keeps rescheduling itself forever is worse than one that
        // stops and waits to be looked at.
        const queue = fakeQueue([[job({ id: 'c', attempts: 3, max_attempts: 3 })]]);
        const { registry } = handlersThat(() => {
            throw new Error('token is dead');
        });

        await drainJobs({ queue, handlers: registry, ...budget });

        assert.equal(queue.failed[0]!.retryInSeconds, null);
    });

    it('keeps going after one job in a batch fails', async () => {
        // The whole reason each event is isolated: one bad event used to abort the rest of
        // the delivery, and Meta had already been told the delivery succeeded.
        const queue = fakeQueue([[job({ id: 'ok1' }), job({ id: 'bad' }), job({ id: 'ok2' })]]);
        const { registry } = handlersThat((j) => {
            if (j.id === 'bad') throw new Error('boom');
        });

        const result = await drainJobs({ queue, handlers: registry, ...budget });

        assert.deepEqual(queue.completed, ['ok1', 'ok2']);
        assert.deepEqual(queue.failed.map((f) => f.jobId), ['bad']);
        assert.equal(result.claimed, 3);
        assert.equal(result.succeeded, 2);
    });

    it('stops when the queue comes back empty', async () => {
        const queue = fakeQueue([[job({ id: 'a' })], []]);
        const { registry } = handlersThat(() => {});

        const result = await drainJobs({ queue, handlers: registry, ...budget });

        assert.equal(result.claimed, 1);
        assert.equal(result.budgetExhausted, false);
        assert.equal(queue.claims.length, 2, 'should claim once more to discover the queue is empty');
    });

    it('claims repeatedly while work remains', async () => {
        const queue = fakeQueue([[job({ id: 'a' })], [job({ id: 'b' })], []]);
        const { registry } = handlersThat(() => {});

        const result = await drainJobs({ queue, handlers: registry, ...budget, batchSize: 1 });

        assert.deepEqual(queue.completed, ['a', 'b']);
        assert.equal(result.claimed, 2);
    });

    it('stops claiming once the time budget is spent', async () => {
        // The failure this prevents: starting a 30-second Gemini call with four seconds of
        // invocation left, which is precisely the abandoned-mid-flight work the queue exists
        // to stop happening.
        let clock = 0;
        const queue = fakeQueue([[job({ id: 'a' })], [job({ id: 'b' })], [job({ id: 'c' })]]);
        const { registry } = handlersThat(() => {
            clock += 600;
        });

        const result = await drainJobs({
            queue,
            handlers: registry,
            budgetMs: 1_000,
            batchSize: 1,
            now: () => clock,
        });

        assert.equal(result.budgetExhausted, true);
        assert.equal(result.claimed, 2, 'stops before claiming a third job');
    });

    it('breaks out mid-batch when the budget expires', async () => {
        let clock = 0;
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]]);
        const { registry } = handlersThat(() => {
            clock += 5_000;
        });

        const result = await drainJobs({
            queue, handlers: registry, budgetMs: 1_000, now: () => clock,
        });

        assert.deepEqual(queue.completed, ['a']);
        assert.equal(result.claimed, 1);
        assert.equal(result.budgetExhausted, true);
    });

    it('honours maxJobs as a hard ceiling', async () => {
        const queue = fakeQueue([[job({ id: 'a' })], [job({ id: 'b' })], [job({ id: 'c' })]]);
        const { registry } = handlersThat(() => {});

        const result = await drainJobs({
            queue, handlers: registry, ...budget, batchSize: 1, maxJobs: 2,
        });

        assert.equal(result.claimed, 2);
    });

    it('never claims more than the remaining maxJobs allowance', async () => {
        const queue = fakeQueue([[job({ id: 'a' })], []]);
        const { registry } = handlersThat(() => {});

        await drainJobs({ queue, handlers: registry, ...budget, batchSize: 10, maxJobs: 3 });

        assert.deepEqual(queue.claims, [3, 2]);
    });

    it('returns rather than throwing when the claim itself fails', async () => {
        // A drain runs after the response has been sent, and from a cron whose body nobody
        // reads. An exception here has nowhere to go.
        const queue = fakeQueue([]);
        queue.claim = async () => {
            throw new Error('connection terminated');
        };
        const { registry } = handlersThat(() => {});

        const result = await drainJobs({ queue, handlers: registry, ...budget });
        assert.deepEqual(result, { claimed: 0, succeeded: 0, failed: 0, budgetExhausted: false });
    });

    it('survives the bookkeeping write failing after a handler error', async () => {
        // If the database is the queue, a failed `fail()` leaves the job `running` and the
        // reaper is the backstop. What must not happen is the drain dying.
        const queue = fakeQueue([[job({ id: 'a' })], []]);
        queue.fail = async () => {
            throw new Error('pool exhausted');
        };
        const { registry } = handlersThat(() => {
            throw new Error('handler blew up');
        });

        const result = await drainJobs({ queue, handlers: registry, ...budget });
        assert.equal(result.failed, 1);
    });

    it('does nothing and reports nothing when the queue is empty', async () => {
        const queue = fakeQueue([[]]);
        const { registry } = handlersThat(() => {});

        const result = await drainJobs({ queue, handlers: registry, ...budget });
        assert.deepEqual(result, { claimed: 0, succeeded: 0, failed: 0, budgetExhausted: false });
    });

    it('routes each job to the handler for its own kind', async () => {
        const queue = fakeQueue([[
            job({ id: 'c1', kind: 'comment.process' }),
            job({ id: 'd1', kind: 'dm.process' }),
        ]]);
        const calls: string[] = [];
        const registry = {
            'comment.process': async () => {
                calls.push('comment');
            },
            'dm.process': async () => {
                calls.push('dm');
            },
        } as unknown as JobHandlerRegistry;

        await drainJobs({ queue, handlers: registry, ...budget });
        assert.deepEqual(calls, ['comment', 'dm']);
    });
});
