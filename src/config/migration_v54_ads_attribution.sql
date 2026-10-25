SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v54: ads → DM bot attribution (Meta Ads Manager phase A3, src/services/ads/attribution.ts). Idempotent. Safe to re-run.
--
-- A click-to-message ad (Instagram Direct, Messenger) sends Meta's `referral` with the person's first message, on a postback (a new Messenger
-- thread) or as a standalone event (an existing thread). The FIRST touch is written to `conversations.entry_source` (v50) as `kind:'ctm'` and never
-- rewritten; this migration adds what the later ones and the bot's silence need:
--
--   ad_touches       later ad referrals on a conversation that already has an entry source: `[{ad_id, ref, platform, at}]`, newest first, at
--                    most 10 (the code trims it). A constant default, so adding it rewrites no row.
--   no_reply_reason  why the bot could not answer this conversation at all, today only `business_ai_owns_thread` (Meta Business AI holds the
--                    Instagram thread, send error 100/2534037). NULL when nothing stops it. `messages.no_reply_reason` (v50) is per message;
--                    this is per conversation.
--
-- The index serves the per-ad joins (conversations, tracked clicks and handoffs per ad id): a partial expression index, only on the rows that
-- carry an ad id (click-to-WhatsApp `ctwa` since v50, click-to-message `ctm` from now on). The conversations table is small; it is built inside
-- the runner's transaction (CONCURRENTLY is refused there) under the 5 s lock timeout above.
--
-- Rollout: `npm run migrate` BEFORE deploying. The DM path writes `ad_touches` on an ad referral and the Inbox reads both columns.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_touches JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS no_reply_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_entry_ad
    ON conversations (creator_id, (entry_source->>'ad_id'))
    WHERE entry_source ? 'ad_id';

COMMENT ON COLUMN conversations.ad_touches IS
    'Later Meta ad referrals on a conversation whose entry_source is already set: [{ad_id, ref, platform, at}], newest first, at most 10. See migration_v54.';
COMMENT ON COLUMN conversations.no_reply_reason IS
    'Why the bot cannot answer this conversation (business_ai_owns_thread: Meta Business AI holds it), or NULL. See migration_v54.';
