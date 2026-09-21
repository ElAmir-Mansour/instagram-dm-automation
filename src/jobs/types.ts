/**
 * The job seam's vocabulary.
 *
 * Kept in its own module with no imports from the queue or the handlers, so that the
 * transport (`queue.ts`), the work (`handlers.ts`) and the driver (`runner.ts`) can each be
 * tested without dragging the other two — and, more to the point, so that replacing the
 * transport with QStash or Vercel Queues later is a new file implementing `JobQueue` rather
 * than a change to anything that enqueues or handles.
 */

/**
 * Every kind of work that can be deferred.
 *
 * A closed union rather than a free string: an enqueue for a kind with no handler is a job
 * that fails `max_attempts` times and then sits in the table forever, which is a silent
 * failure of exactly the sort this whole change exists to remove. The compiler can catch it
 * instead.
 */
export const JOB_KINDS = ['comment.process', 'dm.process'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
    return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

/**
 * What each kind carries.
 *
 * The Meta event is stored verbatim rather than pre-normalised. Normalising before the queue
 * would mean a bug in the normaliser is unrecoverable — the original is gone — whereas
 * storing the raw event means a fixed normaliser can be replayed against jobs that already
 * failed. It also keeps the enqueue path free of any logic that could throw before the
 * acknowledgement to Meta, which is the whole reason the queue exists.
 */
export interface JobPayloads {
    'comment.process': {
        /** One element of `entry.changes`, exactly as Meta sent it. */
        change: unknown;
        /** `entry.id` — the page id the tenant is resolved from. */
        entryId: string;
    };
    'dm.process': {
        /** One element of `entry.messaging`, exactly as Meta sent it. */
        event: unknown;
        entryId: string;
    };
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

/** A claimed job, as the runner sees it. */
export interface Job<K extends JobKind = JobKind> {
    id: string;
    kind: K;
    payload: JobPayloads[K];
    attempts: number;
    max_attempts: number;
    /** The correlation id of the request that enqueued this, when there was one. */
    request_id: string | null;
    creator_id: string | null;
    /** The fair-queueing partition. See `EnqueueInput.tenantKey`. */
    tenant_key: string | null;
}

export interface EnqueueInput<K extends JobKind = JobKind> {
    kind: K;
    payload: JobPayloads[K];
    /**
     * Natural idempotency key. A second enqueue with the same key is dropped, whatever the
     * state of the first — including `done`, which is what makes a Meta redelivery a no-op
     * before it costs a Gemini call.
     */
    dedupeKey?: string | undefined;
    creatorId?: string | undefined;
    /**
     * The partition the fair claim round-robins over.
     *
     * `creatorId` would be the natural key and is the wrong one here: resolving the tenant
     * needs a database read, and the entire point of enqueueing is to acknowledge Meta before
     * doing any — so every job the webhook writes has `creator_id` NULL, and partitioning on
     * it puts all tenants in one group. `entry.id` (the Meta page id) is already in the
     * payload, needs no lookup, and is stable per tenant.
     */
    tenantKey?: string | undefined;
    /** Earliest execution time. Omitted means "now"; this is what makes the queue a scheduler. */
    runAfter?: Date | undefined;
    maxAttempts?: number | undefined;
    requestId?: string | undefined;
}

/**
 * A handler for one kind of job.
 *
 * Throwing means "retry me": the runner records the error and schedules a backoff until
 * `max_attempts` is spent. Returning normally means done. There is deliberately no third
 * outcome — a handler that wants to give up permanently should return, having recorded why
 * in its own domain table (`interactions.error_log`), because that is where an operator
 * looks. `jobs.last_error` is for the runner's own failures, not for business outcomes.
 */
export type JobHandler<K extends JobKind = JobKind> = (
    payload: JobPayloads[K],
    job: Job<K>
) => Promise<void>;

export type JobHandlerRegistry = { [K in JobKind]: JobHandler<K> };

/**
 * The transport.
 *
 * Implemented today by `PostgresJobQueue`. The methods are deliberately the small set that
 * QStash, Vercel Queues and SQS all support natively, so the Postgres implementation can be
 * swapped for a hosted one without the runner or the call sites noticing:
 *
 *   enqueue  -> publish
 *   claim    -> receive (with a visibility timeout)
 *   complete -> delete / ack
 *   fail     -> nack with a delay
 *   reap     -> handled by the broker's visibility timeout; a no-op in a hosted impl
 */
export interface JobQueue {
    /** Returns the job id, or null when the dedupe key meant nothing was enqueued. */
    enqueue<K extends JobKind>(input: EnqueueInput<K>): Promise<string | null>;
    /**
     * Atomically take up to `limit` due jobs, fairly across tenants. Safe against concurrent
     * drains.
     */
    claim(limit: number): Promise<Job[]>;
    complete(jobId: string): Promise<void>;
    /** Record a failure and either schedule a retry after `retryInSeconds` or give up. */
    fail(jobId: string, error: string, retryInSeconds: number | null): Promise<void>;
    /** Return claims older than the visibility timeout to `pending`. Returns how many. */
    reapStale(olderThanSeconds: number): Promise<number>;
    /** Delete `done` rows older than the retention window. Returns how many. */
    pruneCompleted(olderThanDays: number, limit: number): Promise<number>;
}
