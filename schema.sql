CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS creators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instagram_page_id VARCHAR(255) UNIQUE NOT NULL,
    page_access_token TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    post_id VARCHAR(255), 
    trigger_keyword VARCHAR(255) NOT NULL,
    dm_template TEXT NOT NULL,
    public_reply_template TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
    comment_id VARCHAR(255) UNIQUE NOT NULL,
    sender_username VARCHAR(255) NOT NULL,
    post_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING',
    error_log TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_trigger ON campaigns(trigger_keyword);
CREATE INDEX IF NOT EXISTS idx_interactions_spam_check ON interactions(sender_username, post_id, timestamp);
