-- Migration v22: the Growth & SEO hub. The contract is GROWTH.md at the repo root; the
-- platform facts behind every metric name are in src/services/growth/README.md.
--
-- Three tables:
--   post_insights           one row per published post, per platform, whatever published it
--   account_insights_daily  one row per account, per day
--   growth_settings         the tenant's search keywords, hashtag sets, competitors, audience
--
-- Two additions the contract leaves open (GROWTH.md §1, §4):
--   - growth_settings.last_sync_at / last_sync. Sync bookkeeping: the 10-minute rate limit on
--     POST /api/growth/sync is an atomic UPDATE on `last_sync_at`, so it holds across serverless
--     instances. `last_sync` is what the last run found, so the status endpoint can report it
--     without calling Meta again.
--   - scheduled_posts.meta_options. The Instagram reach levers chosen at create or edit time:
--     alt text, collaborators, trial reel. They get their own column, not `platform_options`,
--     because that column is TikTok's: `NULL` there means "inbox mode", and a Meta row moved to
--     `tiktok` by an edit would carry Instagram options into TikTok's publisher.
--
-- Metrics are JSONB, not columns. Meta renames and retires metric names every few versions
-- (`impressions` → `views`, `plays` → `views`), so a column per metric would need a migration
-- each time. A metric the platform didn't return is ABSENT from the object, never 0. The API
-- reports an absent metric as null.
--
-- Idempotent, like every migration here.

-- ── Per-post metrics ─────────────────────────────────────────────────────────────────────
-- `media_id` is the platform's id, so posts made outside the app count too. When the app did
-- publish the post, `scheduled_post_id` links it, matched through
-- `scheduled_posts.published_post_id` ("FB:… | IG:…").
CREATE TABLE IF NOT EXISTS post_insights (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id         UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    platform           TEXT NOT NULL,
    media_id           TEXT NOT NULL,
    scheduled_post_id  UUID REFERENCES scheduled_posts(id) ON DELETE SET NULL,
    -- REELS, CAROUSEL_ALBUM, IMAGE, VIDEO; TEXT for a Facebook status with no media.
    media_type         TEXT,
    permalink          TEXT,
    caption            TEXT,
    thumbnail_url      TEXT,
    published_at       TIMESTAMP WITH TIME ZONE,
    -- { views, reach, likes, comments, saved, shares, total_interactions, follows,
    --   profile_visits, avg_watch_time_ms, … }
    metrics            JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT post_insights_platform_check CHECK (platform IN ('instagram', 'facebook', 'tiktok')),
    CONSTRAINT post_insights_creator_platform_media_key UNIQUE (creator_id, platform, media_id)
);

CREATE INDEX IF NOT EXISTS idx_post_insights_creator_published
    ON post_insights (creator_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_post_insights_scheduled_post
    ON post_insights (scheduled_post_id) WHERE scheduled_post_id IS NOT NULL;

-- ── Per-account metrics, by day ──────────────────────────────────────────────────────────
-- { followers, reach, views, accounts_engaged, profile_views, follows, unfollows,
--   website_clicks, … }. `followers` is the account's follower total on the day a sync ran;
-- `profile_views` and `website_clicks` still answer with metric_type=total_value on v26 (verified
-- live 2026-09-25); like every metric, they are absent when Meta returns nothing.
CREATE TABLE IF NOT EXISTS account_insights_daily (
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL,
    day         DATE NOT NULL,
    metrics     JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (creator_id, platform, day)
);

-- ── Per-tenant SEO settings ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS growth_settings (
    creator_id    UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
    -- Search terms the audience types, e.g. «ذكاء اصطناعي», «برومبت».
    keywords      TEXT[] NOT NULL DEFAULT '{}',
    -- [{ name, tags: string[] }]
    hashtag_sets  JSONB NOT NULL DEFAULT '[]'::jsonb,
    -- Instagram usernames, for Business Discovery.
    competitors   TEXT[] NOT NULL DEFAULT '{}',
    -- { countries: ['SA','AE','EG'], languages: ['ar'], timezone }
    audience      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS last_sync JSONB;

-- ── Reach levers on a scheduled post ─────────────────────────────────────────────────────
-- { alt_text?, alt_texts?: (string|null)[], collaborators?: string[], trial_reel?: { graduation } }
-- NULL when none were chosen. Written by POST/PUT /api/posts/scheduled and the Studio's schedule.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS meta_options JSONB;

-- Deny-by-default, like every other table since v11. The app connects as owner and bypasses it.
ALTER TABLE post_insights           ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_insights_daily  ENABLE ROW LEVEL SECURITY;
ALTER TABLE growth_settings         ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN scheduled_posts.meta_options IS
    'Instagram reach levers (alt text, collaborators, trial reel). Not platform_options, which is TikTok''s. See migration_v22_growth.sql.';
COMMENT ON TABLE post_insights IS
    'Per-post metrics from Meta, one row per platform media id; metrics JSONB, absent = unavailable. See GROWTH.md.';
