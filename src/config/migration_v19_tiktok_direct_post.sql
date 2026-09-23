-- Migration v19: per-post TikTok options, for Direct Post.
--
-- Inbox mode needed nothing per post: the creator chose privacy, interactions and disclosure
-- in TikTok's own editor. Direct Post has no editor step, so TikTok's Content Sharing
-- Guidelines move those choices into our composer — and a scheduled post has to carry them
-- until it is published:
--
--   { "mode": "direct" | "inbox",
--     "privacy_level": "SELF_ONLY" | "PUBLIC_TO_EVERYONE" | ...,
--     "allow_comment": bool, "allow_duet": bool, "allow_stitch": bool,
--     "brand_organic": bool, "brand_content": bool, "is_aigc": bool,
--     "consent_at": ISO timestamp — when the creator ticked "I agree to post this" }
--
-- NULL means inbox mode, which is every TikTok row created before this migration.
-- Idempotent.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS platform_options JSONB;

COMMENT ON COLUMN scheduled_posts.platform_options IS
    'TikTok per-post options (mode, privacy_level, interaction/disclosure toggles, consent_at). NULL = inbox mode. See migration_v19.';
