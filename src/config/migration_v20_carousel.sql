-- Migration v20: carousel (multi-image) posts.
--
-- A carousel's images, in slide order: an Instagram CAROUSEL container, a Facebook multi-photo
-- feed post, or a TikTok photo post. NULL for every other row, including a single-photo
-- TikTok post, whose one image stays in media_url.
--
-- media_url keeps mirroring media_urls[1] (the first slide — Postgres arrays count from 1), so
-- every reader that only knows media_url, like the dashboard cards and thumbnails, still sees
-- the lead image. The media retention sweep reads this column as well: matching media_url
-- alone would delete slides 2..N while the post is still waiting to publish.
--
-- Idempotent.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS media_urls TEXT[];

COMMENT ON COLUMN scheduled_posts.media_urls IS
    'Carousel images in slide order; media_url mirrors the first. NULL for non-carousel rows. See migration_v20.';
