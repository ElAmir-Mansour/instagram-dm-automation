-- Migration v10: Hardening pass
-- Idempotent. Safe to re-run.

-- 1. interactions.platform — WRITTEN BY src/index.ts SINCE THE FACEBOOK RELEASE BUT NEVER
--    ADDED BY ANY MIGRATION. Production only works because it was added by hand; any fresh
--    database silently fails every comment webhook until this runs.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS platform VARCHAR(20) DEFAULT 'instagram';

-- 2. Idempotency for the DM path. The comment path is protected by interactions.comment_id
--    UNIQUE; the messaging path had nothing, so Meta retries re-ran Gemini and re-sent DMs.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_meta_id
    ON messages(meta_message_id) WHERE meta_message_id IS NOT NULL;

-- 3. Publish state machine: atomic claim + stale-claim reaping + a retry cap.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP WITH TIME ZONE;

-- 4. Per-creator send-rate counters. Replaces the in-memory limiter, which counted per
--    lambda instance and therefore under-counted by however many were warm.
CREATE TABLE IF NOT EXISTS rate_limit_counters (
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    bucket VARCHAR(50) NOT NULL,           -- 'dm', 'private_reply', ...
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (creator_id, bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_counters(window_start);

-- 5. One automated DM per recipient per 24h, per Meta's comment/story trigger guidance.
CREATE TABLE IF NOT EXISTS dm_send_log (
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    recipient_id VARCHAR(255) NOT NULL,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (creator_id, recipient_id, sent_at)
);
CREATE INDEX IF NOT EXISTS idx_dm_send_log_lookup ON dm_send_log(creator_id, recipient_id, sent_at DESC);

-- 6. Disclosure tracking — Meta requires telling the user they are talking to an automated
--    service at the start of a thread. Recorded per conversation so it is sent exactly once.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_disclosed_at TIMESTAMP WITH TIME ZONE;

-- 7. Missing indexes on hot dashboard paths. Both /campaigns and /stats/campaigns LEFT JOIN
--    interactions on campaign_id, which was a full scan of the largest table on every load.
CREATE INDEX IF NOT EXISTS idx_interactions_campaign ON interactions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);

-- 8. The webhook routes by page id; make that lookup provably unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_facebook_page
    ON creators(facebook_page_id) WHERE facebook_page_id IS NOT NULL;
