/**
 * The Postgres implementation of `JobQueue`.
 *
 * Why Postgres and not a broker: the database is already here, already has connection
 * pooling, and — the deciding factor — a stuck job can be looked at with the SQL editor the
 * operator already has open. At this volume (single account, tens of events an hour) the
 * extra round-trip is irrelevant next to the 2-8s Gemini call it is wrapping. The moment
 * that stops being true, `JobQueue` is the seam: see ADR-2 in ARCHITECTURE.md.
 *
 * The one thing that has to be right here is the claim. Two concurrent invocations both
 * reading a job as pending and both running it is a duplicate DM to a real person, which
 * cannot be undone from here — the same failure the scheduled-post claim in api.ts was
 * written to prevent. `FOR UPDATE SKIP LOCKED` inside the subquery is what makes it atomic:
 * the lock is taken during the select, and a concurrent claimer skips the locked rows rather
 * than blocking on them or seeing them as free.
 */
import { queryCount, queryOne, queryRows } from '../db/query.js';
import { log } from '../utils/log.js';
import { isJobKind, type EnqueueInput, type Job, type JobKind, type JobQueue } from './types.js';

/** Shape the claim query returns, before it is narrowed to `Job`. */
interface JobDbRow {
    id: string;
    kind: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
    request_id: string | null;
    creator_id: string | null;
    tenant_key: string | null;
}

export class PostgresJobQueue implements JobQueue {
    async enqueue<K extends JobKind>(input: EnqueueInput<K>): Promise<string | null> {
        const row = await queryOne<{ id: string }>(
            // `tenant_key` takes the creator id when no explicit key was given, so the fair
            // claim can partition on the bare column and use its index. Doing the COALESCE
            // here costs nothing; doing it in the claim's PARTITION BY would cost a sort on
            // every claim.
            `INSERT INTO jobs (kind, payload, creator_id, dedupe_key, run_after, max_attempts, request_id, tenant_key)
             VALUES ($1, $2::jsonb, $3, $4, COALESCE($5, NOW()), COALESCE($6, 3), $7, COALESCE($8, $3::text))
             ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
             RETURNING id`,
            [
                input.kind,
                JSON.stringify(input.payload),
                input.creatorId ?? null,
                input.dedupeKey ?? null,
                input.runAfter ?? null,
                input.maxAttempts ?? null,
                input.requestId ?? null,
                input.tenantKey ?? null,
            ]
        );

        // No row back means the dedupe key was already taken — a Meta redelivery, almost
        // always. Not an error, and deliberately logged at debug: on a busy account this is
        // the single most frequent thing that happens.
        if (!row) {
            log('debug', 'job.deduped', { job_kind: input.kind, dedupe_key: input.dedupeKey });
            return null;
        }

        log('info', 'job.enqueued', {
            job_id: row.id,
            job_kind: input.kind,
            run_after: input.runAfter?.toISOString(),
        });
        return row.id;
    }

    async claim(limit: number): Promise<Job[]> {
        // Fair across tenants, not first-come-first-served.
        //
        // This was `ORDER BY run_after` — strict FIFO — so a tenant whose reel just went
        // viral fills the queue with ten thousand events and every other tenant's DMs wait
        // behind all of them. Round-robin instead: rank each tenant's pending jobs
        // oldest-first, then take every tenant's oldest job before anyone's second.
        //
        // `tenant_key` is the partition, and the enqueue writes `COALESCE(tenantKey,
        // creatorId)` into it so that the COALESCE costs nothing here. Partitioning on the
        // bare column is what lets `idx_jobs_claimable_fair (tenant_key, run_after) WHERE
        // status = 'pending'` satisfy both the PARTITION BY and the ORDER BY without a sort.
        // Jobs with no key at all form one group together, which is the conservative answer:
        // they share a slot rather than each getting one.
        //
        // What makes the claim atomic is `AND status = 'pending'` on the UPDATE, not the
        // ranking. If a concurrent drain took a row between this statement's snapshot and its
        // write, the UPDATE waits on that row's lock and then re-evaluates its WHERE against
        // the committed version — which now reads 'running', so the row is skipped and never
        // returned twice. Two concurrent drains therefore split the work; they cannot both run
        // the same job, which would be a duplicate DM to a real person.
        //
        // `FOR UPDATE SKIP LOCKED` is deliberately absent: Postgres rejects it outright in
        // the presence of a window function ("FOR UPDATE is not allowed with window
        // functions"), so the previous shape of this query could not have run at all. The
        // guard above gives the same guarantee; the only thing lost is that a contending
        // claimer waits a moment rather than skipping ahead, and that wait is the length of
        // one autocommit UPDATE.
        const rows = await queryRows<JobDbRow & Record<string, unknown>>(
            `WITH ranked AS (
                 SELECT id,
                        run_after,
                        ROW_NUMBER() OVER (
                            PARTITION BY tenant_key
                            ORDER BY run_after, created_at
                        ) AS tenant_rank
                   FROM jobs
                  WHERE status = 'pending' AND run_after <= NOW()
             ),
             picked AS (
                 SELECT id FROM ranked ORDER BY tenant_rank, run_after LIMIT $1
             )
             UPDATE jobs
                SET status = 'running',
                    claimed_at = NOW(),
                    attempts = attempts + 1,
                    updated_at = NOW()
              WHERE id IN (SELECT id FROM picked)
                AND status = 'pending'
          RETURNING id, kind, payload, attempts, max_attempts, request_id, creator_id, tenant_key`,
            [limit]
        );

        const claimed: Job[] = [];
        for (const row of rows) {
            // A row whose kind no longer has a handler must not crash the drain — that is how
            // one bad job stops every other tenant's work. Fail it loudly and move on.
            if (!isJobKind(row.kind)) {
                log('error', 'job.unknown_kind', { job_id: row.id, job_kind: row.kind });
                await this.fail(row.id, `Unknown job kind "${row.kind}" — no handler registered.`, null);
                continue;
            }
            claimed.push({
                id: row.id,
                kind: row.kind,
                payload: row.payload as Job['payload'],
                attempts: row.attempts,
                max_attempts: row.max_attempts,
                request_id: row.request_id,
                creator_id: row.creator_id,
                tenant_key: row.tenant_key,
            });
        }
        return claimed;
    }

    async complete(jobId: string): Promise<void> {
        await queryCount(
            `UPDATE jobs SET status = 'done', last_error = NULL, updated_at = NOW() WHERE id = $1`,
            [jobId]
        );
    }

    async fail(jobId: string, error: string, retryInSeconds: number | null): Promise<void> {
        if (retryInSeconds === null) {
            await queryCount(
                `UPDATE jobs
                    SET status = 'failed', last_error = $2, updated_at = NOW()
                  WHERE id = $1`,
                // Bounded: a Meta error body can be long, and this column is read in a
                // dashboard list view.
                [jobId, error.slice(0, 2000)]
            );
            return;
        }

        await queryCount(
            `UPDATE jobs
                SET status = 'pending',
                    last_error = $2,
                    run_after = NOW() + make_interval(secs => $3),
                    updated_at = NOW()
              WHERE id = $1`,
            [jobId, error.slice(0, 2000), retryInSeconds]
        );
    }

    async reapStale(olderThanSeconds: number): Promise<number> {
        // Two statements rather than one, because the two outcomes are genuinely different:
        // a job with attempts left goes back in the queue, a job without becomes a permanent
        // failure an operator has to look at. Mirrors the scheduled-post reaper in api.ts.
        const abandoned = await queryCount(
            `UPDATE jobs
                SET status = 'failed',
                    last_error = COALESCE(last_error, '') ||
                        ' [abandoned: the claim went stale and no attempts remain]',
                    updated_at = NOW()
              WHERE status = 'running'
                AND claimed_at < NOW() - make_interval(secs => $1)
                AND attempts >= max_attempts`,
            [olderThanSeconds]
        );

        const requeued = await queryCount(
            `UPDATE jobs
                SET status = 'pending', claimed_at = NULL, updated_at = NOW()
              WHERE status = 'running'
                AND claimed_at < NOW() - make_interval(secs => $1)
                AND attempts < max_attempts`,
            [olderThanSeconds]
        );

        if (abandoned > 0 || requeued > 0) {
            log('warn', 'job.reaped', { requeued, abandoned });
        }
        return requeued + abandoned;
    }

    /**
     * Delete completed jobs.
     *
     * Named in ARCHITECTURE.md §9 as deliberately deferred: `done` rows accumulate forever, in
     * the same 500MB tier as the video in `media_uploads`, and each one holds a verbatim Meta
     * event — so this is a retention question and not only a storage one. Batched for the same
     * reason `pruneRawPayloads` is: a first run against months of history must not be one
     * DELETE inside an invocation with a wall clock, because a DELETE that times out rolls
     * back entirely and never makes progress.
     *
     * Only `done`. A `failed` row is the one an operator needs to look at, and a `pending` or
     * `running` row is live work.
     */
    async pruneCompleted(olderThanDays: number, limit: number): Promise<number> {
        return queryCount(
            `DELETE FROM jobs
              WHERE id IN (
                    SELECT id FROM jobs
                     WHERE status = 'done'
                       AND updated_at < NOW() - make_interval(days => $1)
                     LIMIT $2
              )`,
            [olderThanDays, limit]
        );
    }
}

/**
 * The queue this process uses.
 *
 * A function rather than a module-level constant so a future implementation can be chosen
 * from the environment (`JOB_QUEUE=qstash`) without every importer changing shape.
 */
let queueInstance: JobQueue | null = null;

export function getJobQueue(): JobQueue {
    queueInstance ??= new PostgresJobQueue();
    return queueInstance;
}

/** Override the queue — tests only. Returns the previous instance. */
export function setJobQueue(next: JobQueue | null): JobQueue | null {
    const previous = queueInstance;
    queueInstance = next;
    return previous;
}
