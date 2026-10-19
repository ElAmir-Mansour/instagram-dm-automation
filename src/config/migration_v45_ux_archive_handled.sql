SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep, the comment path or the inbox behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v45: archive and "mark handled" (specs/001-dashboard-ux data-model.md v45, research R-04). Idempotent. Safe to re-run.
--
-- Three nullable timestamps. Each is a way OUT of a "needs attention" state that today has no exit (audit IN-01, PO-14): the live walkthrough
-- found four parked posts and a 152-day-old thread that can never leave the count, because nothing but a dashboard reply or switching the AI
-- back on ended them. A column, not a delete and not a reuse of `stage = 'closed'`: parked posts are kept on purpose, and `stage` is sales
-- state, not triage state.
--
--   scheduled_posts.archived_at   Set by Archive, cleared by Unarchive. The attention summary and "Needs attention" skip an archived row. The
--                                 publish sweep skips it too, and the reconcile sweeps (TikTok / Instagram) still run on a row already in
--                                 flight: both are later changes. Nothing in this migration changes what either sweep does.
--   campaigns.archived_at         An archived campaign never matches a comment (`matchCampaign`'s filter, a later change) and is listed
--                                 under the "Archived" filter. Pausing (`is_active`) stays a separate, reversible switch.
--   conversations.handled_at      Set by "Mark handled": the thread leaves the owner's To do. Cleared automatically when a new inbound
--                                 message is stored for the thread (the same statement that bumps `last_message_at`, a later change), so a
--                                 new question re-enters To do. NOT `messages.handled_at` (v14), which marks a pipeline outcome on one
--                                 inbound message and means something else.
--
-- No existing row changes: a nullable column with no default is catalog-only, so adding it rewrites nothing, and NULL is "not archived /
-- not handled" for every row that exists today. No table is created, so no row level security to add (v11 covers all three).
--
-- The two indexes are partial, over the rows that are still live, which is what every reader of these columns asks for:
--   idx_scheduled_posts_active    (creator_id, scheduled_time) WHERE archived_at IS NULL
--   idx_campaigns_unarchived      (creator_id)                 WHERE archived_at IS NULL
-- The campaigns one is NOT called `idx_campaigns_active`, the name data-model.md gives it: v4 already created an index of that name (on
-- `is_active`), and `CREATE INDEX IF NOT EXISTS` matches on the NAME, not the definition, so it would have been skipped silently and the
-- index would never exist. The v4 index is left alone: it is a different index, and dropping it is not this migration's business.
--
-- Rollout: `npm run migrate` BEFORE deploying, as for every migration. Everything that reads these columns ships after it.

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE campaigns       ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE conversations   ADD COLUMN IF NOT EXISTS handled_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_scheduled_posts_active
    ON scheduled_posts (creator_id, scheduled_time)
    WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_campaigns_unarchived
    ON campaigns (creator_id)
    WHERE archived_at IS NULL;

COMMENT ON COLUMN scheduled_posts.archived_at IS
    'When the owner archived this post (Archive), or NULL. Cleared by Unarchive. An archived post is excluded from "Needs attention" and the attention summary; the publish sweep skips it (a later change). Not a delete: the row and its media are kept. v45.';
COMMENT ON COLUMN campaigns.archived_at IS
    'When the owner archived this campaign, or NULL. An archived campaign never matches a comment and is listed under the Archived filter. Separate from is_active (paused). v45.';
COMMENT ON COLUMN conversations.handled_at IS
    'When the owner pressed "Mark handled" on this thread, or NULL. Cleared automatically when a new inbound message is stored, so a new question returns the thread to To do. Not messages.handled_at (v14). v45.';
