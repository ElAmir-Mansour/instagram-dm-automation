-- Migration V6: Post Scheduling Table
CREATE TABLE IF NOT EXISTS scheduled_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    platform VARCHAR(20) NOT NULL, -- 'instagram', 'facebook', or 'both'
    post_type VARCHAR(20) NOT NULL, -- 'image', 'video', 'reel', 'story'
    caption TEXT,
    media_url TEXT, -- Can be null for Facebook text-only posts
    scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) DEFAULT 'PENDING', -- 'PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED'
    error_log TEXT,
    published_post_id VARCHAR(100), -- Meta ID once published
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for the cron scheduler query
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_status_time ON scheduled_posts(status, scheduled_time);
