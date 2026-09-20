-- Migration v9: optional cover image for scheduled video/reel posts.
-- Instagram defaults a reel's thumbnail to frame 0, which is black for any
-- video that fades in, so covers are supplied explicitly.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS cover_url TEXT;
