/**
 * The Postgres queue itself.
 *
 * `runner.test.ts` covers the drain loop against an injected fake, which leaves the real
 * implementation — the part that decides whether two concurrent drains can answer the same
 * person twice — with nothing on it at all.
 *
 * Two kinds of assertion live here, and they are deliberately different:
 *
 *   - **Behavioural.** What the class does with what Postgres hands back: the narrowing of a
 *     row into a `Job`, the null return on a dedupe conflict, the unknown-kind quarantine,
 *     the retry-versus-terminal split in `fail`, the sum `reapStale` reports. `pool.query` is
 *     replaced by a router that answers on the SQL it is given, so all of this is exercised
 *     without a database.
 *
 *   - **Structural.** A handful of assertions about the SQL text. These earn their place
 *     because the guarantees they encode live in Postgres, not in TypeScript, so there is no
 *     behaviour here to observe — and because each one is a mistake that has already been made
 *     or was one edit away. `AND status = 'pending'` on the claim UPDATE is the *entire*
 *     atomicity argument; `FOR UPDATE SKIP LOCKED` alongside the window function is a shape
 *     Postgres rejects outright, so a well-meaning "fix" that adds it back would fail only in
 *     production; and the two reaper branches differ solely by their `attempts` comparison, so
 *     transposing them is a silent change of meaning.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { PostgresJobQueue, getJobQueue, setJobQueue } from './queue.js';
import type { Job } from './types.js';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

interface Executed {
    sql: string;
    params: any[];
}

/**
 * Stand in for `pool.query`, answering from a list of [matcher, result] pairs.
 *
 * Nothing here goes near a database — the DATABASE_URL in `.env` points at production.
 */
function withDb<T>(
    routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]>,
    body: (log: Executed[]) => Promise<T>
): Promise<T> {
    const executed: Executed[] = [];
    const original = pool.query;

    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };

    return body(executed).finally(() => {
        (pool as any).query = original;
    });
}

/** Collapse runs of whitespace so a multi-line statement can be matched as one string. */
const flat = (sql: string) => sql.replace(/\s+/g, ' ');

const queue = new PostgresJobQueue();

describe('enqueue', () => {
    it('returns the new job id and passes every field through in order', async () => {
        await withDb([[/INSERT INTO jobs/, { rows: [{ id: 'job-1' }] }]], async (executed) => {
            const runAfter = new Date('2026-09-22T10:00:00.000Z');
            const id = await queue.enqueue({
                kind: 'dm.process',
                payload: { event: { x: 1 }, entryId: 'e-1' } as any,
                creatorId: 'creator-1',
                dedupeKey: 'dm:mid-1',
                runAfter,
                maxAttempts: 5,
                requestId: 'req-1',
                tenantKey: 'tenant-1',
            });

            assert.equal(id, 'job-1');
            assert.deepEqual(executed[0]!.params, [
                'dm.process',
                JSON.stringify({ event: { x: 1 }, entryId: 'e-1' }),
                'creator-1',
                'dm:mid-1',
                runAfter,
                5,
                'req-1',
                'tenant-1',
            ]);
        });
    });

    it('sends nulls for the optional fields so the SQL defaults apply', async () => {
        // run_after, max_attempts and tenant_key are all COALESCEd in the statement. Passing
        // `undefined` instead of `null` would make `pg` send nothing and shift the positions.
        await withDb([[/INSERT INTO jobs/, { rows: [{ id: 'job-2' }] }]], async (executed) => {
            await queue.enqueue({ kind: 'comment.process', payload: {} as any });

            assert.deepEqual(executed[0]!.params.slice(2), [null, null, null, null, null, null]);
        });
    });

    it('defaults tenant_key to the creator id, so unkeyed jobs still partition', async () => {
        // The fair claim partitions on the bare `tenant_key` column, which is only useful if
        // the enqueue actually writes one. Doing the COALESCE in the claim's PARTITION BY
        // instead would cost a sort on every claim.
        await withDb([[/INSERT INTO jobs/, { rows: [{ id: 'job-3' }] }]], async (executed) => {
            await queue.enqueue({ kind: 'dm.process', payload: {} as any, creatorId: 'c-9' });

            assert.equal(executed[0]!.params[7], 'c-9');
        });
    });

    it('references each parameter once, so Postgres cannot deduce two types for it', async () => {
        // `COALESCE($8, $3::text)` beside a uuid `creator_id = $3` is 42P08 "inconsistent
        // types deduced for parameter $3" — on every enqueue, for six days, invisibly: the
        // webhook fell back to processing after its 200 and some of that work was frozen.
        // This suite mocks the database, so this shape check is what stands in for Postgres.
        await withDb([[/INSERT INTO jobs/, { rows: [{ id: 'job-4' }] }]], async (executed) => {
            await queue.enqueue({ kind: 'dm.process', payload: {} as any, creatorId: 'c-9' });

            const refs = flat(executed[0]!.sql).match(/\$\d+/g) ?? [];
            assert.deepEqual(refs, [...new Set(refs)]);
        });
    });

    it('returns null when the dedupe key was already taken', async () => {
        // A Meta redelivery. Not an error: the first copy is already queued or done.
        await withDb([[/INSERT INTO jobs/, { rows: [] }]], async () => {
            const id = await queue.enqueue({
                kind: 'dm.process', payload: {} as any, dedupeKey: 'dm:mid-1',
            });

            assert.equal(id, null);
        });
    });
});

describe('claim', () => {
    const row = (over: Partial<Record<string, unknown>> = {}) => ({
        id: 'job-1',
        kind: 'dm.process',
        payload: { entryId: 'e-1' },
        attempts: 1,
        max_attempts: 3,
        request_id: 'req-1',
        creator_id: 'creator-1',
        tenant_key: 'creator-1',
        ...over,
    });

    it('narrows the returned rows into Jobs', async () => {
        await withDb([[/UPDATE jobs/, { rows: [row(), row({ id: 'job-2' })] }]], async (executed) => {
            const claimed = await queue.claim(5);

            assert.equal(executed[0]!.params[0], 5, 'the limit must reach the query');
            assert.deepEqual(claimed.map((j) => j.id), ['job-1', 'job-2']);
            const first = claimed[0] as Job;
            assert.equal(first.kind, 'dm.process');
            assert.deepEqual(first.payload, { entryId: 'e-1' });
            assert.equal(first.attempts, 1);
            assert.equal(first.max_attempts, 3);
            assert.equal(first.request_id, 'req-1');
            assert.equal(first.tenant_key, 'creator-1');
            assert.equal(first.run_after, null, 'a row without the column reads as unknown, not as a date');
        });
    });

    it('returns when each job became due, for the runner\'s queued_ms', async () => {
        const due = new Date('2026-10-31T17:06:00.000Z');
        await withDb([[/UPDATE jobs/, { rows: [row({ run_after: due })] }]], async (executed) => {
            const [claimed] = await queue.claim(1);
            assert.match(flat(executed[0]!.sql), /RETURNING id, kind, payload, attempts, max_attempts, request_id, creator_id, tenant_key, run_after/);
            assert.equal(claimed!.run_after, due);
        });
    });

    it('quarantines a row whose kind has no handler instead of crashing the drain', async () => {
        // One row with a kind nobody registered must not stop every other tenant's work. It
        // is failed terminally — `retryInSeconds` null — because retrying cannot help.
        const statements: string[] = [];
        await withDb(
            [
                [/UPDATE jobs\s+SET status = 'running'/, { rows: [row({ kind: 'comment.processs' }), row({ id: 'job-2' })] }],
                [/SET status = 'failed'/, { rowCount: 1 }],
            ],
            async (executed) => {
                const claimed = await queue.claim(5);
                statements.push(...executed.map((e) => flat(e.sql)));

                assert.deepEqual(claimed.map((j) => j.id), ['job-2'], 'the good job still runs');
                assert.equal(executed.length, 2);
                assert.match(statements[1]!, /SET status = 'failed'/);
                assert.match(executed[1]!.params[1], /Unknown job kind "comment\.processs"/);
            }
        );
    });

    it('guards the UPDATE with status = pending — the whole atomicity argument', async () => {
        // Without this predicate two concurrent drains both claim the same row and the same
        // person gets two DMs, which cannot be undone from here. The ranking CTE does not
        // provide this: it reads a snapshot. The guard is what makes the losing UPDATE match
        // nothing once it re-reads the committed row as 'running'.
        await withDb([[/UPDATE jobs/, { rows: [] }]], async (executed) => {
            await queue.claim(1);

            const sql = flat(executed[0]!.sql);
            assert.match(sql, /UPDATE jobs SET status = 'running'/);
            assert.match(sql, /WHERE id IN \(SELECT id FROM picked\) AND status = 'pending'/);
        });
    });

    it('does not reach for FOR UPDATE SKIP LOCKED, which Postgres rejects here', async () => {
        // "FOR UPDATE is not allowed with window functions" — the shape this query used to be
        // described as could never have run. Adding it back would look like a hardening fix
        // and would fail only at runtime, in production, on the claim path.
        await withDb([[/UPDATE jobs/, { rows: [] }]], async (executed) => {
            await queue.claim(1);

            assert.equal(/FOR UPDATE/i.test(executed[0]!.sql), false);
        });
    });

    it('ranks round-robin across tenants rather than first-come-first-served', async () => {
        // Strict `ORDER BY run_after` means one tenant whose reel went viral fills the queue
        // and every other tenant's DMs wait behind all of it. Rank per tenant, then take
        // everyone's oldest before anyone's second.
        await withDb([[/UPDATE jobs/, { rows: [] }]], async (executed) => {
            await queue.claim(1);

            const sql = flat(executed[0]!.sql);
            assert.match(sql, /ROW_NUMBER\(\) OVER \( PARTITION BY tenant_key ORDER BY run_after, created_at \) AS tenant_rank/);
            assert.match(sql, /FROM ranked ORDER BY tenant_rank, run_after LIMIT \$1/);
            assert.match(sql, /WHERE status = 'pending' AND run_after <= NOW\(\)/);
        });
    });
});

describe('complete', () => {
    it('marks the job done and clears the error from any earlier attempt', async () => {
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async (executed) => {
            await queue.complete('job-1');

            const sql = flat(executed[0]!.sql);
            assert.match(sql, /SET status = 'done'/);
            assert.match(sql, /last_error = NULL/);
            assert.deepEqual(executed[0]!.params, ['job-1']);
        });
    });
});

describe('fail', () => {
    it('is terminal when no retry was scheduled', async () => {
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async (executed) => {
            await queue.fail('job-1', 'dead token', null);

            const sql = flat(executed[0]!.sql);
            assert.match(sql, /SET status = 'failed'/);
            assert.equal(/run_after/.test(sql), false, 'a terminal failure must not be rescheduled');
            assert.deepEqual(executed[0]!.params, ['job-1', 'dead token']);
        });
    });

    it('returns the job to pending with a backoff when a retry was scheduled', async () => {
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async (executed) => {
            await queue.fail('job-1', 'Gemini 503', 120);

            const sql = flat(executed[0]!.sql);
            assert.match(sql, /SET status = 'pending'/);
            assert.match(sql, /run_after = NOW\(\) \+ make_interval\(secs => \$3\)/);
            assert.deepEqual(executed[0]!.params, ['job-1', 'Gemini 503', 120]);
        });
    });

    it('truncates the error, because a Meta body is long and this column is listed', async () => {
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async (executed) => {
            await queue.fail('job-1', 'x'.repeat(5000), null);

            assert.equal(executed[0]!.params[1].length, 2000);
        });
    });

    it('treats a zero-second retry as a retry, not as terminal', async () => {
        // `retryInSeconds === null` is the terminal signal. A loose `!retryInSeconds` would
        // read 0 as terminal and drop a job the runner asked to be retried immediately.
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async (executed) => {
            await queue.fail('job-1', 'transient', 0);

            assert.match(flat(executed[0]!.sql), /SET status = 'pending'/);
            assert.equal(executed[0]!.params[2], 0);
        });
    });
});

describe('reapStale', () => {
    it('abandons a stale claim with no attempts left, and requeues one with attempts left', async () => {
        // The two outcomes are genuinely different and the statements differ only by the
        // `attempts` comparison, so transposing them would turn every recoverable job into a
        // permanent failure — and every exhausted one into an infinite loop.
        await withDb(
            [
                [/SET status = 'failed'/, { rowCount: 2 }],
                [/SET status = 'pending'/, { rowCount: 3 }],
            ],
            async (executed) => {
                const reaped = await queue.reapStale(600);

                assert.equal(reaped, 5, 'the return value is abandoned + requeued');
                assert.equal(executed.length, 2, 'two statements, not one');

                const abandoned = flat(executed[0]!.sql);
                assert.match(abandoned, /SET status = 'failed'/);
                assert.match(abandoned, /AND attempts >= max_attempts/);
                assert.match(abandoned, /\[abandoned: the claim went stale and no attempts remain\]/);
                assert.match(abandoned, /last_error = COALESCE\(last_error, ''\) \|\|/,
                    'appended, so the original error is not lost');

                const requeued = flat(executed[1]!.sql);
                assert.match(requeued, /SET status = 'pending', claimed_at = NULL/);
                assert.match(requeued, /AND attempts < max_attempts/);
            }
        );
    });

    it('only touches rows whose claim is older than the window', async () => {
        await withDb(
            [
                [/SET status = 'failed'/, { rowCount: 0 }],
                [/SET status = 'pending'/, { rowCount: 0 }],
            ],
            async (executed) => {
                const reaped = await queue.reapStale(600);

                assert.equal(reaped, 0);
                for (const { sql, params } of executed) {
                    assert.match(flat(sql), /WHERE status = 'running' AND claimed_at < NOW\(\) - make_interval\(secs => \$1\)/);
                    assert.deepEqual(params, [600]);
                }
            }
        );
    });
});

describe('releaseUnrun', () => {
    // A claim takes a whole batch in one statement and counts an attempt on every row. The jobs a drain never reached (its budget ran
    // out partway) did not run, so what the claim counted did not happen. The guarantees below live in the SQL, not in TypeScript,
    // so they are asserted on the statement; `pool.query` is the stand-in, as for every other test in this file.

    /** What `claim` hands the drain for a job: the id, and the attempt number that claim counted. */
    const claim = (id: string, attempts: number) => ({ id, attempts });

    it('hands the jobs back as they were: pending, claim cleared, the attempt the claim counted refunded', async () => {
        await withDb([[/UPDATE jobs/, { rowCount: 2 }]], async (executed) => {
            const released = await queue.releaseUnrun([claim('job-2', 1), claim('job-3', 2)]);

            assert.equal(released, 2, 'the return value is how many rows the UPDATE moved');
            assert.equal(executed.length, 1, 'one statement for the whole batch');
            assert.match(flat(executed[0]!.sql), /SET status = 'pending', claimed_at = NULL, attempts = GREATEST\(attempts - 1, 0\)/);
        });
    });

    it('sends the ids and the attempts as two arrays that line up, one claim per position', async () => {
        // `unnest($1, $2)` zips them back into (id, attempts) pairs by position, so a claim's id must sit at the same index as its attempt.
        // This is what notices if one of the two is ever sorted, filtered or deduplicated on its own.
        await withDb([[/UPDATE jobs/, { rowCount: 3 }]], async (executed) => {
            await queue.releaseUnrun([claim('job-9', 3), claim('job-2', 1), claim('job-5', 2)]);

            assert.deepEqual(executed[0]!.params, [['job-9', 'job-2', 'job-5'], [3, 1, 2]]);
        });
    });

    it('refunds with GREATEST, so a row that already reads 0 cannot go negative', async () => {
        // A bare `attempts - 1` would write -1, and `attempts >= max_attempts` / `attempts < max_attempts` in the reaper and the
        // runner would then read a job that has had no attempts as having a spare one.
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async (executed) => {
            await queue.releaseUnrun([claim('job-1', 1)]);

            const sql = flat(executed[0]!.sql);
            assert.match(sql, /GREATEST\(attempts - 1, 0\)/);
            assert.equal(/attempts = attempts - 1/.test(sql), false);
        });
    });

    it('only touches rows that are still running, matched on the claim', async () => {
        // The guard that stops it undoing a job that has since finished or failed.
        await withDb([[/UPDATE jobs/, { rowCount: 0 }]], async (executed) => {
            await queue.releaseUnrun([claim('job-1', 1)]);

            assert.match(
                flat(executed[0]!.sql),
                /WHERE \(id, attempts\) IN \(SELECT \* FROM unnest\(\$1::uuid\[\], \$2::int\[\]\)\) AND status = 'running'$/
            );
        });
    });

    it('matches each row on the attempt its claim gave it, so a job that was reaped and claimed again is left alone', async () => {
        // The reaper frees a stale claim without touching `attempts`, and the next claim counts one more. A drain that stalled past the
        // window and then hands back "its" jobs would, matched on id and status alone, put the OTHER drain's live claim back in the queue
        // for a third drain to run as well: a duplicate DM to a real person. `(id, attempts)` makes the claim's own number part of the
        // match, so a row that has moved on to a later attempt matches nothing. There is no database here, so this is the statement's text.
        await withDb([[/UPDATE jobs/, { rowCount: 0 }]], async (executed) => {
            const released = await queue.releaseUnrun([claim('job-1', 1)]);

            const sql = flat(executed[0]!.sql);
            assert.match(sql, /WHERE \(id, attempts\) IN \(SELECT \* FROM unnest\(\$1::uuid\[\], \$2::int\[\]\)\)/);
            assert.equal(/id = ANY/.test(sql), false, 'the id alone is not enough to match on');
            assert.equal(released, 0, 'and a row that no longer matches is reported as not moved');
        });
    });

    it('does not reschedule the job or touch its error: it is not a failure, and it keeps its place in the line', async () => {
        // `run_after` is what `fail` writes to push a retry out; a job handed back is due now, so the next drain's claim takes it.
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async (executed) => {
            await queue.releaseUnrun([claim('job-1', 1)]);

            const sql = flat(executed[0]!.sql);
            assert.equal(/run_after/.test(sql), false);
            assert.equal(/last_error/.test(sql), false);
        });
    });

    it('returns how many rows it really moved, which is fewer when some were no longer this claim', async () => {
        await withDb([[/UPDATE jobs/, { rowCount: 1 }]], async () => {
            assert.equal(await queue.releaseUnrun([claim('job-1', 1), claim('job-2', 1), claim('job-3', 2)]), 1);
        });
    });

    it('sends nothing at all for an empty list', async () => {
        // No route is arranged, so any statement would throw. `unnest('{}', '{}')` would be harmless, but a round trip for nothing is not.
        await withDb([], async (executed) => {
            assert.equal(await queue.releaseUnrun([]), 0);
            assert.equal(executed.length, 0);
        });
    });
});

describe('pruneCompleted', () => {
    it('deletes only finished jobs, in bounded batches', async () => {
        // A `failed` row is the one an operator needs to look at, and `pending`/`running` are
        // live work. Batching matters because an unbounded DELETE that times out rolls back
        // entirely and never makes progress.
        await withDb([[/DELETE FROM jobs/, { rowCount: 500 }]], async (executed) => {
            const deleted = await queue.pruneCompleted(30, 500);

            assert.equal(deleted, 500);
            const sql = flat(executed[0]!.sql);
            assert.match(sql, /WHERE status = 'done'/);
            assert.match(sql, /updated_at < NOW\(\) - make_interval\(days => \$1\)/);
            assert.match(sql, /LIMIT \$2/);
            assert.deepEqual(executed[0]!.params, [30, 500]);
        });
    });
});

describe('getJobQueue', () => {
    it('returns one shared Postgres queue, and can be overridden for tests', async () => {
        const previous = setJobQueue(null);
        try {
            const first = getJobQueue();
            assert.ok(first instanceof PostgresJobQueue);
            assert.equal(getJobQueue(), first, 'it must not build a new pool user per call');

            const fake = {} as any;
            assert.equal(setJobQueue(fake), first, 'setJobQueue hands back what it replaced');
            assert.equal(getJobQueue(), fake);
        } finally {
            setJobQueue(previous);
        }
    });
});
