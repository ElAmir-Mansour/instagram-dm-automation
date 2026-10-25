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
import { cachedForRequest, withProfileCache } from '../services/profile/cache.js';
import { setLogSink } from '../utils/log.js';
import { backoffSeconds, drainJobs } from './runner.js';
import { memoryQueue } from './testSupport.js';
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
    /** One entry per `releaseUnrun` call: the claims it was given, each a job id and the attempt number that claim counted. */
    released: Array<Array<{ id: string; attempts: number }>>;
} {
    const completed: string[] = [];
    const failed: FailCall[] = [];
    const claims: number[] = [];
    const enqueued: EnqueueInput[] = [];
    const released: Array<Array<{ id: string; attempts: number }>> = [];
    let next = 0;

    return {
        completed,
        failed,
        claims,
        enqueued,
        released,
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
        async releaseUnrun(claims) {
            released.push(claims.map(({ id, attempts }) => ({ id, attempts })));
            return claims.length;
        },
        async pruneCompleted() {
            return 0;
        },
    };
}

/** Run `body` with the log captured and parsed. The file-wide sink that swallows output is put back afterwards. */
async function logged<T>(body: () => Promise<T>): Promise<{ value: T; lines: Array<Record<string, any>> }> {
    const lines: Array<Record<string, any>> = [];
    const previous = setLogSink((_level, line) => {
        lines.push(JSON.parse(line));
    });
    try {
        return { value: await body(), lines };
    } finally {
        setLogSink(previous);
    }
}

/** The claims `releaseUnrun` should be handed: each job's id and the attempt number its claim counted. */
const claims = (...pairs: Array<[id: string, attempts: number]>) => pairs.map(([id, attempts]) => ({ id, attempts }));

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
        // b and c were claimed with a, in the same statement, and will not run in this drain. Left alone they would sit `running`
        // (with an attempt counted) until the 300 s reaper; they must go back to the queue now.
        assert.deepEqual(queue.released, [claims(['b', 1], ['c', 1])], 'the jobs it did not reach are handed back, in claim order');
        assert.equal(queue.failed.length, 0, 'handing a job back is not failing it');
        assert.equal(queue.claims.length, 1, 'and the drain does not go round for another batch');
    });

    it('hands back only the jobs after the one that used up the budget, each with the attempt its own claim counted', async () => {
        // The attempts differ on purpose: a job on its second or third try was claimed at attempt 2 or 3, and that number is what
        // `releaseUnrun` matches the row on. A runner that sent one constant, or the wrong job's, would hand back someone else's claim.
        let clock = 0;
        const queue = fakeQueue([[
            job({ id: 'a', attempts: 1 }), job({ id: 'b', attempts: 3 }),
            job({ id: 'c', attempts: 2 }), job({ id: 'd', attempts: 3 }), job({ id: 'e', attempts: 1 }),
        ]]);
        const { registry } = handlersThat((j) => {
            if (j.id === 'b') clock += 5_000;
        });

        const result = await drainJobs({ queue, handlers: registry, budgetMs: 1_000, batchSize: 5, now: () => clock });

        assert.deepEqual(queue.completed, ['a', 'b'], 'both jobs the loop reached ran');
        assert.deepEqual(queue.released, [claims(['c', 2], ['d', 3], ['e', 1])], 'neither of them is handed back, and the rest are, as claimed');
        assert.equal(result.claimed, 2);
    });

    it('hands back nothing when the budget ends on the last job of the batch', async () => {
        // Nothing was claimed and left unrun, so there is nothing to give back and no statement to send.
        let clock = 0;
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' })]]);
        const { registry } = handlersThat((j) => {
            if (j.id === 'b') clock += 5_000;
        });

        const result = await drainJobs({ queue, handlers: registry, budgetMs: 1_000, now: () => clock });

        assert.equal(result.budgetExhausted, true);
        assert.deepEqual(queue.completed, ['a', 'b']);
        assert.deepEqual(queue.released, []);
    });

    it('hands back nothing when the queue empties inside the budget', async () => {
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' })], []]);
        const { registry } = handlersThat(() => {});

        const result = await drainJobs({ queue, handlers: registry, ...budget });

        assert.equal(result.budgetExhausted, false);
        assert.deepEqual(queue.released, []);
    });

    it('never hands back a job that ran, even one that failed, and still hands back the ones after it', async () => {
        // The refund is only true of a job that never started. a ran and threw: it is retried through `fail`, with its attempt spent.
        let clock = 0;
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]]);
        const { registry } = handlersThat((j) => {
            if (j.id === 'a') {
                clock += 5_000;
                throw new Error('Gemini timed out');
            }
        });

        const result = await drainJobs({ queue, handlers: registry, budgetMs: 1_000, now: () => clock, random: () => 0.5 });

        assert.deepEqual(queue.failed.map((f) => f.jobId), ['a']);
        assert.deepEqual(queue.released, [claims(['b', 1], ['c', 1])]);
        assert.deepEqual([result.succeeded, result.failed], [0, 1]);
    });

    it('does not throw when handing the jobs back fails, and says so', async () => {
        // The drain runs after the response, and from a cron whose body nobody reads: an exception has nowhere to go. A failed release
        // only leaves the jobs where they were, for the reaper, which is how every one of them used to be freed.
        let clock = 0;
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]]);
        queue.releaseUnrun = async () => {
            throw new Error('connection terminated');
        };
        const { registry } = handlersThat(() => {
            clock += 5_000;
        });

        const { value: result, lines } = await logged(() => drainJobs({ queue, handlers: registry, budgetMs: 1_000, now: () => clock }));

        assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, budgetExhausted: true });
        const failure = lines.find((l) => l['event'] === 'job.release_failed');
        assert.ok(failure, 'the failure is logged');
        assert.equal(failure['level'], 'error');
        assert.equal(failure['unrun'], 2);
        assert.deepEqual(failure['job_ids'], ['b', 'c']);
        assert.match(String(failure['message']), /connection terminated/);
        assert.ok(lines.some((l) => l['event'] === 'job.drain_complete'), 'and the drain still reports itself');
    });

    it('logs what it handed back', async () => {
        let clock = 0;
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]]);
        const { registry } = handlersThat(() => {
            clock += 5_000;
        });

        const { lines } = await logged(() => drainJobs({ queue, handlers: registry, budgetMs: 1_000, now: () => clock }));

        const released = lines.find((l) => l['event'] === 'job.released');
        assert.ok(released, 'a release is logged');
        assert.equal(released['level'], 'info');
        assert.equal(released['released'], 2);
        assert.equal(released['unrun'], 2);
        assert.deepEqual(released['job_ids'], ['b', 'c']);
        const events = lines.map((l) => l['event']);
        assert.ok(events.indexOf('job.released') < events.indexOf('job.drain_complete'), 'before the drain says it is done');
    });

    it('logs how many it really moved when some were no longer its own claim', async () => {
        // The reaper can get there first, or another drain can have claimed the job since. The UPDATE leaves such a row alone, so the
        // count it returns is the one worth logging.
        let clock = 0;
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c' })]]);
        queue.releaseUnrun = async () => 1;
        const { registry } = handlersThat(() => {
            clock += 5_000;
        });

        const { lines } = await logged(() => drainJobs({ queue, handlers: registry, budgetMs: 1_000, now: () => clock }));

        const released = lines.find((l) => l['event'] === 'job.released');
        assert.equal(released?.['released'], 1);
        assert.equal(released?.['unrun'], 2);
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

describe('a drain that runs out of budget mid-batch, against the in-memory queue', () => {
    // `memoryQueue` gives `claim` and `releaseUnrun` the semantics the SQL in queue.ts gives them (claim: `running`, attempt + 1;
    // release: `pending`, attempt - 1, only if still `running`), so these read what the table would hold afterwards.
    const planned = (n: number): EnqueueInput[] =>
        Array.from({ length: n }, (_, i) => ({ kind: 'comment.process', payload: { change: {}, entryId: `e${i + 1}` } }) as EnqueueInput);

    it('leaves the jobs it did not reach pending, with the attempt the claim counted given back', async () => {
        const { jobs, queue } = memoryQueue(planned(3));
        let clock = 0;
        const { registry } = handlersThat(() => {
            clock += 5_000;
        });

        const result = await drainJobs({ queue, handlers: registry, budgetMs: 1_000, batchSize: 3, now: () => clock });

        assert.equal(result.budgetExhausted, true);
        assert.deepEqual(
            jobs.map((j) => [j.id, j.status, j.attempts]),
            [['job-1', 'done', 1], ['job-2', 'pending', 0], ['job-3', 'pending', 0]],
            'the one that ran is done and spent its attempt; the others are back as they were, not left `running`'
        );
    });

    it('runs a job claimed on its LAST attempt and not reached by the next drain, instead of leaving it to be abandoned', async () => {
        // maxAttempts 1: every claim is a job's last attempt. Left `running`, the reaper would have failed job-2 "[abandoned: the claim
        // went stale and no attempts remain]" five minutes later without it ever having run.
        const { jobs, queue } = memoryQueue(planned(2), 1);
        let clock = 0;
        const { registry, seen } = handlersThat(() => {
            clock += 5_000;
        });

        await drainJobs({ queue, handlers: registry, budgetMs: 1_000, batchSize: 2, now: () => clock });
        assert.deepEqual(seen.map((j) => j.id), ['job-1'], 'the first drain ran only the first job');
        assert.deepEqual([jobs[1]!.status, jobs[1]!.attempts], ['pending', 0]);

        const second = await drainJobs({ queue, handlers: registry, budgetMs: 1_000_000, now: () => clock });

        assert.deepEqual(seen.map((j) => j.id), ['job-1', 'job-2'], 'the second drain claimed it and ran it');
        assert.equal(second.succeeded, 1);
        assert.deepEqual([jobs[1]!.status, jobs[1]!.attempts], ['done', 1]);
    });

    it('leaves alone a job that was reaped and claimed again by another drain while this one was busy', async () => {
        // The race the attempt number closes. This drain claims all three (attempt 1 each). While it is stuck on job-1 the reaper frees
        // job-2 (a stale claim goes back to `pending` with `attempts` as the claim counted it) and another drain claims it: attempt 2,
        // running over there. When this drain's budget ends it hands back what it did not reach. job-3 is still this drain's claim and
        // goes back. job-2 is the other drain's now: matched on its id and `running` alone it would be put back in the queue under that
        // drain's feet and run a second time. Its attempt has moved on, so it is not a match, and must stay exactly as that drain left it.
        const { jobs, queue } = memoryQueue(planned(3));
        let clock = 0;
        let otherDrain: Job | undefined;
        const { registry } = handlersThat(async (j) => {
            clock += 5_000;
            if (j.id === 'job-1') {
                jobs[1]!.status = 'pending'; // what `reapStale` does to a stale claim
                [otherDrain] = await queue.claim(1); // and the other drain's claim of it
            }
        });

        const { value: result, lines } = await logged(() =>
            drainJobs({ queue, handlers: registry, budgetMs: 1_000, batchSize: 3, now: () => clock })
        );

        assert.deepEqual([otherDrain?.id, otherDrain?.attempts], ['job-2', 2], 'the setup: the other drain really holds job-2 at attempt 2');
        assert.equal(result.budgetExhausted, true);
        assert.deepEqual(
            jobs.map((j) => [j.id, j.status, j.attempts]),
            [['job-1', 'done', 1], ['job-2', 'running', 2], ['job-3', 'pending', 0]],
            'job-3 went back as it was; job-2 is still the other drain\'s claim, untouched'
        );
        const released = lines.find((l) => l['event'] === 'job.released');
        assert.equal(released?.['unrun'], 2, 'it tried to hand back both');
        assert.equal(released?.['released'], 1, 'and only the one that was still its own claim moved');
    });

    it('does not hand back a job the reaper freed and nobody has claimed yet either: it is already pending', async () => {
        // The reaper's requeue left it `pending`, so there is nothing running to give back. It keeps the attempt the reaper left it with:
        // the reaper cannot know whether the stalled claim ran, so it leaves it counted, and a late release is not the one to change that.
        const { jobs, queue } = memoryQueue(planned(3));
        let clock = 0;
        const { registry } = handlersThat((j) => {
            clock += 5_000;
            if (j.id === 'job-1') jobs[1]!.status = 'pending'; // reaped, and not claimed again
        });

        await drainJobs({ queue, handlers: registry, budgetMs: 1_000, batchSize: 3, now: () => clock });

        assert.deepEqual(
            jobs.map((j) => [j.id, j.status, j.attempts]),
            [['job-1', 'done', 1], ['job-2', 'pending', 1], ['job-3', 'pending', 0]]
        );
    });
});

describe('the profile cache is per job, not per drain', () => {
    /** A profile read that counts how often it really runs. */
    function reads() {
        const state = { calls: 0 };
        const load = async (): Promise<string> => {
            state.calls++;
            await Promise.resolve();
            return `profile #${state.calls}`;
        };
        return { state, load };
    }

    it('a job reads a tenant once however often it asks, and the next job for that tenant reads again', async () => {
        const { state, load } = reads();
        const seen: string[] = [];
        const { registry } = handlersThat(async (j) => {
            seen.push(await cachedForRequest(j.creator_id!, load));
            seen.push(await cachedForRequest(j.creator_id!, load));
        });
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' }), job({ id: 'c', kind: 'dm.process' as JobKind })]]);

        const result = await drainJobs({ queue, handlers: registry, budgetMs: 60_000 });

        assert.equal(result.succeeded, 3);
        assert.equal(state.calls, 3, 'one read per job: a 45 s drain does not share one snapshot');
        assert.deepEqual(seen, ['profile #1', 'profile #1', 'profile #2', 'profile #2', 'profile #3', 'profile #3']);
    });

    it('a profile saved between two jobs is seen by the second', async () => {
        let stored = 'v1';
        const read = async (): Promise<string> => stored;
        const { registry } = handlersThat(async (j) => {
            const got = await cachedForRequest(j.creator_id!, read);
            if (j.id === 'a') {
                assert.equal(got, 'v1');
                stored = 'v2'; // another request saves the profile while the drain is running
            } else {
                assert.equal(got, 'v2');
            }
        });
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' })]]);
        const result = await drainJobs({ queue, handlers: registry, budgetMs: 60_000 });
        assert.deepEqual([result.succeeded, result.failed], [2, 0]);
    });

    it('a drain inside a request does not read the request\'s snapshot, and does not change it', async () => {
        const { state, load } = reads();
        const { registry } = handlersThat(async (j) => {
            assert.equal(await cachedForRequest(j.creator_id!, load), 'profile #2', 'the job read for itself');
        });
        const queue = fakeQueue([[job()]]);

        await withProfileCache(async () => {
            assert.equal(await cachedForRequest('creator-1', load), 'profile #1', 'the request read it first');
            await drainJobs({ queue, handlers: registry, budgetMs: 60_000 });
            assert.equal(await cachedForRequest('creator-1', load), 'profile #1', 'and its own entry is still there, untouched');
        });
        assert.equal(state.calls, 2);
    });

    it('a job that fails still gets its own scope, and leaves nothing behind for the next', async () => {
        const { state, load } = reads();
        const { registry } = handlersThat(async (j) => {
            await cachedForRequest(j.creator_id!, load);
            if (j.id === 'a') throw new Error('boom');
        });
        const queue = fakeQueue([[job({ id: 'a' }), job({ id: 'b' })]]);
        const result = await drainJobs({ queue, handlers: registry, budgetMs: 60_000, random: () => 0.5 });
        assert.deepEqual([result.succeeded, result.failed], [1, 1]);
        assert.equal(state.calls, 2);
    });
});
