-- Migration v3: Add Facebook Page support to creators table
-- Run this in your Supabase SQL editor before deploying the updated code.

-- 1. Add facebook_page_id column (nullable, since existing rows only have Instagram IDs)
ALTER TABLE creators
    ADD COLUMN IF NOT EXISTS facebook_page_id VARCHAR(255);

-- 2. Index for fast webhook lookup
CREATE INDEX IF NOT EXISTS idx_creators_facebook_page
    ON creators(facebook_page_id)
    WHERE facebook_page_id IS NOT NULL;

-- Done. After running this, update your creator row to set facebook_page_id:
--   UPDATE creators
--   SET facebook_page_id = '123456789012345'
--   WHERE instagram_page_id = 'your_ig_page_id';
