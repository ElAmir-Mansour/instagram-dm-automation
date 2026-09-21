-- Migration v13: a durable job queue.
--
-- The problem this solves is stated in src/index.ts: the webhook answers Meta 200 and then
-- keeps working in the same invocation. On Vercel, execution after the response can be frozen
-- at any point, so the work is lost — and because Meta was already told the delivery
-- succeeded, it is lost permanently, with nothing anywhere recording that it existed. A DM
-- that Gemini was mid-way through answering simply never gets answered, and the only trace is
-- an inbound `messages` row with no outbound partner.
--
-- Writing the intent down before acknowledging Meta changes the failure from "silently lost"
-- to "still pending". That is the entire point of this table. It does not require a queue
-- service: `run_after` plus an atomic claim is a queue, and Postgres is already here.
--
-- Deliberately NOT a Redis/SQS/QStash schema. See the decision record in ARCHITECTURE.md —
-- in short, at this volume the database round-trip is not the bottleneck, and a table can be
-- inspected with the SQL editor the operator already uses at 2am.
--
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- Dotted handler name, e.g. 'comment.process'. Matched against the registry in
    -- src/jobs/handlers.ts; an unknown kind fails the job rather than crashing the drain,
    -- so a rollback that removes a handler does not take the whole queue down.
    kind VARCHAR(64) NOT NULL,

    -- The event body. JSONB rather than TEXT so a stuck job can be inspected with SQL
    -- (`payload->'value'->>'text'`) instead of being copied out and parsed by hand.
    payload JSONB NOT NULL,

    -- Nullable because a job is enqueued before the tenant is resolved: resolution needs a
    -- database read, and the whole purpose of enqueueing is to get off the Meta clock first.
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,

    -- Queue-level idempotency, above the row-level claims that already exist
    -- (interactions.comment_id, messages.meta_message_id). Meta redelivers aggressively; this
    -- stops a redelivery from even becoming a job.
    dedupe_key TEXT,

    status VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 3,

    -- When this job may next be claimed. Backoff is a write to this column, which also makes
    -- the table a scheduler: a post due at 14:32 is a job with run_after = 14:32, and the
    -- once-daily cron stops being what determines publish granularity.
    run_after TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    claimed_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,

    -- The correlation id of the request that enqueued this. Carrying it across the queue
    -- boundary is what makes a log search for one Meta delivery return the work it caused,
    -- and not just the acknowledgement.
    request_id TEXT,

    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- The claim query's index. Partial, because `done` rows accumulate and are uninteresting to
-- the only query that runs on the hot path.
CREATE INDEX IF NOT EXISTS idx_jobs_claimable
    ON jobs(run_after) WHERE status = 'pending';

-- Reaping stale claims — the other query the runner makes.
CREATE INDEX IF NOT EXISTS idx_jobs_running
    ON jobs(claimed_at) WHERE status = 'running';

-- The dedupe guarantee. Partial so that jobs without a natural key (a Meta event carrying no
-- mid) are still allowed, and are simply not deduplicated.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dedupe
    ON jobs(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- For the operator view: "what failed today".
CREATE INDEX IF NOT EXISTS idx_jobs_status_created
    ON jobs(status, created_at DESC);

-- RLS is deny-by-default across public tables (v11); jobs holds raw Meta event bodies, so it
-- is at least as sensitive as `messages` and gets the same treatment. The application
-- connects as the table owner and is unaffected.
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
