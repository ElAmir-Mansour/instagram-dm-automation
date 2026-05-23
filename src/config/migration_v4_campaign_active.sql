-- Migration v4: Add is_active column to campaigns table
-- Run this in your Supabase SQL editor to allow pausing campaigns.

-- 1. Add is_active column (defaults to TRUE)
ALTER TABLE campaigns
    ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;

-- 2. Index for filtering active campaigns quickly
CREATE INDEX IF NOT EXISTS idx_campaigns_active
    ON campaigns(is_active)
    WHERE is_active = TRUE;
