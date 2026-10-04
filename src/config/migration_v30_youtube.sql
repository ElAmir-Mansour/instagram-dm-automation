-- Migration v30: YouTube as a fourth publishing platform (Shorts).
--
-- No new table. A YouTube channel is a `platform_connections` row (`platform = 'youtube'`,
-- `external_account_id` = the channel id, UC…), owned by src/services/youtubeConnections.ts, and a
-- YouTube post is its own `scheduled_posts` row (`platform = 'youtube'`), linked to its Meta sibling
-- by `group_id` like a TikTok one. `oauth_states.platform` never had a CHECK.
--
--   scheduled_posts.platform_options   for a YouTube row: `{ title, privacy }`
--                                      (src/services/youtubePublish.ts)
--   scheduled_posts.external_publish_id 'YTU:<resumable upload session URL>' while an upload is in
--                                      flight, so a retry asks Google where it got to instead of
--                                      uploading the video twice
--   scheduled_posts.published_post_id  'YT:<video id>'
--
-- Rollout: `npm run migrate` BEFORE deploying. Connect inserts a 'youtube' connection row, which
-- the old CHECK refuses.
--
-- Idempotent.

ALTER TABLE platform_connections DROP CONSTRAINT IF EXISTS platform_connections_platform_check;
ALTER TABLE platform_connections ADD CONSTRAINT platform_connections_platform_check
    CHECK (platform IN ('tiktok', 'youtube'));

COMMENT ON TABLE platform_connections IS
    'Non-Meta platform credentials (TikTok, YouTube). Tokens are enc:v1 (AES-256-GCM). See migration_v18_tiktok.sql and migration_v30_youtube.sql.';
