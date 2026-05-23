-- Migration v5: Optimize interactions table indexes for analytics queries
-- Run this in your Supabase SQL editor to speed up dashboard charts and logs.

-- 1. Index on status to optimize counts (e.g. Sent vs Failed donut chart)
CREATE INDEX IF NOT EXISTS idx_interactions_status ON interactions(status);

-- 2. Index on timestamp to optimize daily/hourly line chart aggregation and log sorting
CREATE INDEX IF NOT EXISTS idx_interactions_timestamp ON interactions(timestamp DESC);
