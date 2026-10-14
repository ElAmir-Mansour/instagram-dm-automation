SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the comment path behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v41: who a private reply went to, on the interaction (docs/DM_SALES_PLAN.md S10, the comment -> DM bridge). Idempotent. Safe to re-run.
--
-- A comment's private reply was fire-and-forget: `interactions` kept the commenter's USERNAME and nothing that a later DM carries, so a
-- person who commented a keyword, got the link, and then wrote back was a stranger to the DM bot. Meta's Send API answers a private reply
-- with `{ recipient_id, message_id }`, `recipient_id` being the platform-scoped id (the IGSID on Instagram, the PSID on Facebook) that
-- the same person's DM later carries as `sender.id` (assumption A1 of the plan, logged side by side until the owner has seen it hold).
--
--   recipient_id   the id the private reply went to. NULL on every row written before this, on a comment whose private reply never went
--                  out (FAILED, USER_BLOCKED_DMS), and on one whose reply landed on a retry (`landed_before_retry`: Meta's refusal of the
--                  second try carries no recipient). The comment pipeline writes it AFTER the interaction is SENT, in its own statement and
--                  its own try/catch, so a failure to write it can never change what happened to the comment.
--
-- The DM sales turn reads it back (src/services/dmSales/bridge.ts): the latest SENT interaction of this creator whose `recipient_id` is the
-- sender of the DM, inside the window, names the campaign the conversation began with. The partial index below is that lookup. It holds
-- only rows that have a recipient, so it starts empty, costs the comment path one index entry per SENT comment from now on, and is
-- the same shape as `idx_dm_send_log_lookup` (v10).
--
-- No existing row changes: a nullable column with no default is catalog-only, so adding it rewrites nothing, and the index is built over
-- no rows. `interactions` already has row level security (v11), and no table is created.
--
-- Rollout: `npm run migrate` BEFORE deploying, as for every migration. The comment path survives a database that is behind: the write
-- fails inside its try/catch, is logged `comment.bridge_failed`, and the comment is answered exactly as before.

ALTER TABLE interactions ADD COLUMN IF NOT EXISTS recipient_id VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_interactions_recipient
    ON interactions (creator_id, recipient_id, timestamp DESC)
    WHERE recipient_id IS NOT NULL;

COMMENT ON COLUMN interactions.recipient_id IS
    'The platform-scoped id (IGSID / PSID) the private reply went to, from Meta''s Send API response. NULL when none was reported. The DM sales turn joins a later DM to this row by it (S10).';
