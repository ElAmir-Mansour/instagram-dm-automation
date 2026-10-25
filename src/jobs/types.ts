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
export const JOB_KINDS = ['comment.process', 'dm.process', 'dm.followup', 'wa.event', 'ads.draft', 'ads.lead'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
    return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

/** A `dm.process` job from `entry.messaging` (Instagram, Messenger). */
export interface MessagingDmPayload {
    /** One element of `entry.messaging`, exactly as Meta sent it. */
    event: unknown;
    entryId: string;
    /**
     * The body's `object` (`'instagram'` | `'page'`): the one field that says which network
     * a DM came from, and it lives on the body, not the event. Absent on jobs queued before
     * v26.
     */
    object?: string;
}

/**
 * A `dm.process` job for one WhatsApp message. `change` is the `value` of the `messages` change it came from, trimmed to this one message and
 * its own contact, with `metadata` kept: stored raw, as the Instagram event is, so a fixed normaliser can replay a job that failed. `object` is
 * the app's own name for the network (`'whatsapp'`), NOT the body's `object` (`'whatsapp_business_account'`).
 */
export interface WhatsAppDmPayload {
    object: 'whatsapp';
    /** `entry.id`: the Messaging account (WABA) id. */
    entryId: string;
    /** `value.metadata.phone_number_id`: which number was written to, and so which tenant. Null when Meta sent none. */
    phoneNumberId: string | null;
    change: unknown;
}

export function isWhatsAppDmPayload(payload: MessagingDmPayload | WhatsAppDmPayload): payload is WhatsAppDmPayload {
    return payload.object === 'whatsapp' && 'change' in payload;
}

/**
 * The three things a `wa.event` job can be. `status` and `preference` carry the raw `value` trimmed like `WhatsAppDmPayload.change`; `account`
 * carries the whole `value` of an account-level change (quality, limits, bans, name review), which has no message in it.
 */
export type WaEventPayload =
    | { kind: 'status'; entryId: string; phoneNumberId: string | null; change: unknown }
    | { kind: 'account'; entryId: string; field: string; value: unknown; /** Unix seconds: `entry.time`, else the change's own. */ time: number | null }
    | { kind: 'preference'; entryId: string; phoneNumberId: string | null; change: unknown };

/**
 * What each kind carries.
 *
 * The Meta event is stored verbatim rather than pre-normalised. Normalising before the queue
 * would mean a bug in the normaliser is unrecoverable — the original is gone — whereas
 * storing the raw event means a fixed normaliser can be replayed against jobs that already
 * failed. It also keeps the enqueue path free of any logic that could throw before the
 * acknowledgement to Meta, which is the whole reason the queue exists.
 */
/**
 * A Page `leadgen` webhook change (lead ads, A10): only the ids Meta sent, never the person's answers. The handler fetches the lead
 * itself (`GET /{leadgen_id}`) with the tenant's Page token, so nothing personal ever sits in `jobs`.
 */
export interface LeadJobPayload {
    leadgenId: string;
    pageId: string | null;
    formId: string | null;
    adId: string | null;
    /** Unix seconds, as Meta sent it. */
    createdTime: number | null;
}

export interface JobPayloads {
    'comment.process': {
        /** One element of `entry.changes`, exactly as Meta sent it. */
        change: unknown;
        /** `entry.id` — the page id the tenant is resolved from. */
        entryId: string;
    };
    /** Instagram and Messenger DMs (`MessagingDmPayload`), and WhatsApp messages (`WhatsAppDmPayload`): told apart by `isWhatsAppDmPayload`. */
    'dm.process': MessagingDmPayload | WhatsAppDmPayload;
    /**
     * A WhatsApp webhook change that is not a customer message: a delivery status of one of OUR messages, an account-level event, or a
     * preference change (docs/specs/001-whatsapp-agent/contracts/webhook-inbound.md section 3). Never reaches an AI; see `WaEventPayload`.
     */
    'wa.event': WaEventPayload;
    /** A lead from a lead ad (A10). See `LeadJobPayload`. */
    'ads.lead': LeadJobPayload;
    /**
     * The one nudge for a link a sales DM sent (docs/DM_SALES_PLAN.md §7, S9), due `dm.sales.followup_minutes` after it. Unlike the two
     * above this is NOT a Meta event: it is written by the sales turn after the link was recorded, and everything it needs to decide is
     * read again when it runs (`src/services/dmSales/followupJob.ts`), so the payload names only what the job is about.
     */
    /**
     * Move an AI ad proposal on (Ads A7, src/services/ads/proposals/service.ts `advanceProposal`): draft it on the tenant's own provider, or
     * queue / read the owner's Mac job, then run the checks. Names only the proposal; everything is read again when it runs.
     */
    'ads.draft': {
        creatorId: string;
        proposalId: string;
    };
    'dm.followup': {
        conversationId: string;
        creatorId: string;
        /** The person's id on the platform: what the nudge is sent to, and what a test-mode allowlist lists. */
        senderId: string;
        /** The Facebook Page id for a Messenger conversation; absent for Instagram (the endpoint `me`). */
        pageId?: string;
        /** The offer whose link went out. */
        offerId: string;
        /** The `messages` row that carried the link: with the conversation, the dedupe key. */
        linkMessageId: string;
        /** When the link went out (ISO 8601): a later link makes this job stale (a newer job exists for it). */
        linkAt: string;
        /**
         * The channel, when the scheduler named one. Only a job for ANOTHER channel (`whatsapp`) is written with it, and no follow-up is ever scheduled for one
         * (`scheduleFollowup`); the field is what stops a job that somehow exists from sending on the wrong network. Absent, as in every job queued before it
         * existed and every Instagram and Messenger one, the channel is what it always was: Messenger with a `pageId`, Instagram without.
         */
        channel?: 'instagram' | 'facebook' | 'whatsapp';
    };
}

/**
 * `cancelled` is terminal and operator-initiated: `POST /api/admin/jobs/:id/cancel` sets it on
 * a pending job the operator has decided must never run. It is a distinct value rather than a
 * reuse of `failed` because the failed list is the queue's work list, and a deliberate
 * cancellation does not belong on it. Nothing on a hot path can see it — the claim filters
 * `pending`, the reaper `running`, the retention sweep `done` — so the row is inert.
 */
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

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

/**
 * What names one claim of a job: the row, and the attempt number that claim gave it. `claim` returns every row with `attempts` already
 * counted, so a `Job` is a `JobClaim`. The number is what tells this claim from a later one on the same row: the reaper frees a stale
 * claim without touching `attempts`, and the next claim counts one more.
 */
export type JobClaim = Pick<Job, 'id' | 'attempts'>;

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
 *
 * One optional extra, for WhatsApp only so far: a handler may return a `JobResult` asking for the
 * stored payload to be replaced as the job completes (see `JobResult`). Returning nothing is what
 * every other handler does, and changes nothing.
 */
export type JobHandler<K extends JobKind = JobKind> = (
    payload: JobPayloads[K],
    job: Job<K>
) => Promise<void | JobResult>;

/** A replacement for a job's stored payload, written in the same statement that ends the job. */
export interface PayloadRedaction {
    payload: unknown;
}

/**
 * What a handler may hand back when it finishes. `redactPayload`, when present, replaces `jobs.payload` in the UPDATE that marks the job `done`.
 *
 * It exists because a job's payload is the Meta event verbatim, kept until the queue prunes it (7 days for a `done` row, never for a `failed`
 * one). For a WhatsApp message from a person the owner has not listed as a tester, that is a customer's words, phone and name sitting in the
 * queue after the message itself was deliberately stored without them (docs/specs/001-whatsapp-agent review C3). A job that fails and will be
 * retried keeps its payload: the next attempt needs it. A failure that ends the job redacts through `redactOnFailure` (./redaction.ts).
 */
export interface JobResult {
    redactPayload?: unknown;
}

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
 *   release  -> nack with no delay: a message received and never started goes straight back
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
    /** Mark the job done. With `redact`, its stored payload is replaced in the same statement. */
    complete(jobId: string, redact?: PayloadRedaction): Promise<void>;
    /**
     * Record a failure and either schedule a retry after `retryInSeconds` or give up. With `redact` and no retry (`retryInSeconds` null), the
     * stored payload is replaced in the same statement; a job that will run again keeps the payload it needs.
     */
    fail(jobId: string, error: string, retryInSeconds: number | null, redact?: PayloadRedaction): Promise<void>;
    /** Return claims older than the visibility timeout to `pending`. Returns how many. */
    reapStale(olderThanSeconds: number): Promise<number>;
    /**
     * Hand back jobs that were claimed and never started: `pending` again with the claim cleared, and the attempt the claim counted
     * given back (never below 0), so the next claim finds each exactly as it was. The drain calls this when its time budget ends
     * partway through a batch (`drainJobs`). Left alone, those jobs sit `running` until `reapStale` frees them
     * `CLAIM_VISIBILITY_SECONDS` later, and one claimed on its last attempt is failed "abandoned" without ever having run.
     *
     * A row is handed back only while it is still THE CLAIM THE CALLER MADE: `running`, and on the attempt number that claim gave it
     * (`JobClaim`). A job that has since finished or failed is not the caller's to give back, and neither is one the reaper freed and
     * another drain claimed in the meantime: that claim counted a later attempt and is running somewhere else, and putting it back in
     * the queue would let a third drain run it as well. Such a row is left exactly as it is.
     *
     * Only for jobs that did NOT run; the refund is true of those and of nothing else. Returns how many were handed back.
     */
    releaseUnrun(claims: readonly JobClaim[]): Promise<number>;
    /** Delete `done` rows older than the retention window. Returns how many. */
    pruneCompleted(olderThanDays: number, limit: number): Promise<number>;
}
