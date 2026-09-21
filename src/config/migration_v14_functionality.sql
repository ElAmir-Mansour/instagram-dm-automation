-- Migration v14: the columns the functionality audit needed.
--
-- Six independent additions, grouped into one migration because they are all additive and all
-- default to today's behaviour. Nothing here changes what an existing row means.
--
-- Idempotent. Safe to re-run.

-- ─── 1. Per-campaign keyword match mode ─────────────────────────────────────────────────
--
-- `keywordMatches(text, keyword, mode)` has supported 'word' since the Arabic normalisation
-- pass, but nothing persisted it, so the parameter was unreachable: every campaign matched by
-- substring whether or not that was safe. Substring matching is what makes `تم` fire inside
-- اهتمام, تمام and يتم — the dashboard already warns about it while you type and until now
-- could not offer a fix.
--
-- DEFAULT 'substring' is load-bearing. Existing campaigns must keep matching exactly as they
-- do today; switching a campaign to word matching is an explicit act by its owner.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS match_mode VARCHAR(16) NOT NULL DEFAULT 'substring';

-- Guarded rather than plain ADD CONSTRAINT: `IF NOT EXISTS` is not available for constraints,
-- and a bare ADD would fail the whole migration on a re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'campaigns_match_mode_check'
    ) THEN
        ALTER TABLE campaigns
            ADD CONSTRAINT campaigns_match_mode_check
            CHECK (match_mode IN ('substring', 'word'));
    END IF;
END $$;

-- ─── 2. The app-wide Meta rate bucket ───────────────────────────────────────────────────
--
-- Meta's app-level limit is `200 × daily active users` per hour, pooled across the whole app
-- rather than per account — so it does not scale with tenant count, and one tenant with a
-- viral reel can 429 every other tenant. `rate_limit_counters` cannot hold this: its primary
-- key includes `creator_id`, which is NOT NULL and carries a foreign key, so there is no
-- sentinel row to count against without either inventing a fake creator or rebuilding the
-- primary key of a live table.
--
-- A separate table instead. Same shape, same 48h pruning, one less column.
CREATE TABLE IF NOT EXISTS app_rate_limit_counters (
    bucket VARCHAR(50) NOT NULL,
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_app_rate_limit_window ON app_rate_limit_counters(window_start);

-- v11 made RLS deny-by-default across public tables. The application connects as the table
-- owner and is unaffected; a new table left out would be the one hole in that shield.
ALTER TABLE app_rate_limit_counters ENABLE ROW LEVEL SECURITY;

-- ─── 3. Fair queueing needs a partition key that exists at enqueue time ─────────────────
--
-- `jobs.claim` was `ORDER BY run_after` — strict FIFO, so a tenant with 10,000 queued events
-- starves everyone behind them. ARCHITECTURE.md §6.1 proposes round-robin by `creator_id`,
-- but `jobs.creator_id` is never populated on the webhook path: resolving the tenant needs a
-- database read, and the entire point of enqueueing is to get off the Meta clock before doing
-- any. Every row in the table has it NULL, so partitioning on it groups everything together.
--
-- `entry.id` — the Meta page id the delivery is addressed to — is in the payload already and
-- needs no lookup. It is a stable per-tenant key even though it is not the tenant's uuid.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tenant_key TEXT;

-- The claim partitions by the bare column and orders by run_after inside each partition, so
-- this index satisfies both and the window function needs no sort. That is the reason the
-- enqueue writes `COALESCE(tenantKey, creatorId)` into the column rather than the claim
-- COALESCEing at read time.
CREATE INDEX IF NOT EXISTS idx_jobs_claimable_fair
    ON jobs(tenant_key, run_after) WHERE status = 'pending';

-- Existing rows, so they do not all share one partition. Every row the webhook wrote before
-- v14 has creator_id NULL too, so in practice this backfills nothing today — it matters for a
-- deployment that enqueued anything with a known tenant.
UPDATE jobs SET tenant_key = creator_id::text
 WHERE tenant_key IS NULL AND creator_id IS NOT NULL;

-- ─── 4. Inbound DM handling state ───────────────────────────────────────────────────────
--
-- `messages.meta_message_id UNIQUE` is the DM pipeline's idempotency claim, and it was doing
-- two jobs at once: stopping a Meta redelivery from re-running a paid Gemini call, and —
-- unintentionally — stopping a *retry* from doing anything either. The inbound row is written
-- before the AI call, so once a transient Gemini or Meta failure happened, every subsequent
-- attempt hit the claim, logged `dm.duplicate_ignored` and returned successfully. A customer
-- whose message failed once was never answered, and the job that carried it was marked done.
--
-- Splitting "we have seen this message" from "we have finished with this message" is what
-- makes the queue's retry reach the DM path.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS handled_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_claimed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_attempts INT NOT NULL DEFAULT 0;

-- Every row that exists before this migration has already been through the old pipeline, and
-- whatever happened to it happened months ago. Marking them handled means the new re-entrant
-- claim can never decide that a four-month-old DM is unfinished work and answer it now.
UPDATE messages SET handled_at = COALESCE(created_at, NOW()) WHERE handled_at IS NULL;

-- The claim's lookup path, for the conflict branch.
CREATE INDEX IF NOT EXISTS idx_messages_unhandled
    ON messages(created_at) WHERE handled_at IS NULL AND direction = 'inbound';

-- ─── 5. The retention sweep's scan ──────────────────────────────────────────────────────
--
-- `pruneRawPayloads` selects `WHERE raw_payload IS NOT NULL AND created_at < ...`, which was a
-- sequential scan of the whole table on every cron run. Partial, so it costs nothing once the
-- backlog is cleared — the index is empty when every payload has been pruned.
CREATE INDEX IF NOT EXISTS idx_messages_raw_payload_prune
    ON messages(created_at) WHERE raw_payload IS NOT NULL;

-- ─── 6. Completed jobs accumulate ───────────────────────────────────────────────────────
--
-- Named in ARCHITECTURE.md §9 as deliberately deferred. The sweep now exists
-- (`pruneCompletedJobs`) and needs an index it can use, because the hot-path indexes are all
-- partial on `status = 'pending'` / `'running'` and none of them cover `done`.
CREATE INDEX IF NOT EXISTS idx_jobs_done_updated
    ON jobs(updated_at) WHERE status = 'done';
