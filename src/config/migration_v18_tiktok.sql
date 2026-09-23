-- Migration v18: TikTok as a third publishing platform.
--
-- Shape of the change, and why it is not columns on `creators`:
--
--   `creators` is Meta-shaped all the way down — `instagram_page_id` and `page_access_token`
--   are NOT NULL, and the single `token_status` / `token_error` pair is written by
--   `noteMetaFailure` and read by every health surface. A TikTok credential stored beside
--   them would share that status: a dead TikTok token would paint the Meta token red, or the
--   reverse. TikTok also needs twice the state — an access token that dies every 24h, a
--   refresh token that lasts a year and may rotate on every use, their two expiries, the
--   account's `open_id`, and a claim column so two concurrent refreshes cannot lose the
--   rotated refresh token. So it gets its own table, keyed to the tenant.
--
-- Idempotent, like every migration here.

-- ── App-wide settings ───────────────────────────────────────────────────────────────────
-- Operational config the operator edits from the dashboard rather than from Vercel's env
-- (the TikTok client key and secret first). Env stays a fallback, never the source of truth:
-- production once ran for months with `META_VERIFY_TOKEN=""` because nothing surfaced it.
-- Secret values are stored `enc:v1:...` via src/config/crypto.ts and never returned by the API.
CREATE TABLE IF NOT EXISTS app_settings (
    key         VARCHAR(100) PRIMARY KEY,
    value       TEXT,
    is_secret   BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_by  UUID REFERENCES users(id) ON DELETE SET NULL
);

-- ── Third-party platform connections ────────────────────────────────────────────────────
-- One row per (tenant, platform). `external_account_id` is TikTok's `open_id`, which is
-- per-app — it is what TikTok webhooks name the account by, hence unique per platform so an
-- event resolves to exactly one tenant.
CREATE TABLE IF NOT EXISTS platform_connections (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id           UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    platform             VARCHAR(20) NOT NULL,
    external_account_id  TEXT NOT NULL,
    display_name         TEXT,
    avatar_url           TEXT,
    scopes               TEXT[] NOT NULL DEFAULT '{}',
    -- Both `enc:v1:...`. NULL after a disconnect or an `authorization.removed` webhook.
    access_token         TEXT,
    access_expires_at    TIMESTAMP WITH TIME ZONE,
    refresh_token        TEXT,
    refresh_expires_at   TIMESTAMP WITH TIME ZONE,
    -- 'active' | 'invalid' (a refresh or call was refused) | 'revoked' (the user removed the app)
    status               VARCHAR(20) NOT NULL DEFAULT 'active',
    last_error           TEXT,
    last_refreshed_at    TIMESTAMP WITH TIME ZONE,
    -- Set while one invocation is refreshing. TikTok may rotate the refresh token on every
    -- refresh, so two concurrent refreshes would each get a new one and the loser's write
    -- would store a token that no longer works.
    refresh_claimed_at   TIMESTAMP WITH TIME ZONE,
    connected_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT platform_connections_platform_check CHECK (platform IN ('tiktok')),
    CONSTRAINT platform_connections_status_check CHECK (status IN ('active', 'invalid', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_connections_creator
    ON platform_connections (creator_id, platform);
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_connections_account
    ON platform_connections (platform, external_account_id);

-- ── OAuth state ─────────────────────────────────────────────────────────────────────────
-- The dashboard session is a Bearer token in localStorage, so TikTok's redirect back carries
-- no session at all. The `state` parameter is therefore the only thing binding a returned
-- code to a tenant: a random nonce, stored here with the tenant and user that asked for it,
-- consumed exactly once, and dead after ten minutes. The same value also rides in an
-- HttpOnly cookie, so a state minted in one browser cannot be completed from another.
CREATE TABLE IF NOT EXISTS oauth_states (
    nonce       VARCHAR(100) PRIMARY KEY,
    platform    VARCHAR(20) NOT NULL,
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- NULL for a legacy shared-password session, which has no user row.
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at     TIMESTAMP WITH TIME ZONE,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states (expires_at);

-- ── Scheduled posts ─────────────────────────────────────────────────────────────────────
-- A TikTok post is its own row (`platform = 'tiktok'`) rather than a third branch inside a
-- `both` row: the Meta publish path works, is tested, and records partial success in a
-- `FB:… | IG:…` string that a third platform would only make more fragile. `group_id` ties
-- the rows one composer submission created, so the dashboard can present them together.
--
-- TikTok publishing is asynchronous: the upload returns a `publish_id` and TikTok processes
-- for seconds to minutes. `external_publish_id` holds it — written the moment TikTok hands it
-- over, so a retry after a crash asks TikTok what happened instead of uploading twice.
-- New status values, no CHECK (the column never had one — see rows.ts `ScheduleStatus`):
--   PROCESSING — uploaded, TikTok still ingesting
--   IN_INBOX   — delivered to the creator's TikTok inbox; they finish the post in the app
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS group_id UUID;
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS external_publish_id TEXT;
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMP WITH TIME ZONE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_posts_external_publish_id
    ON scheduled_posts (external_publish_id)
    WHERE external_publish_id IS NOT NULL;

-- The list query filters on creator_id and nothing indexed it.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_creator
    ON scheduled_posts (creator_id, scheduled_time DESC);

-- The reconcile sweep reads only rows TikTok has not finished with.
CREATE INDEX IF NOT EXISTS idx_scheduled_posts_processing
    ON scheduled_posts (status_checked_at)
    WHERE status = 'PROCESSING';

-- Deny-by-default, like every other table since v11. The app connects as owner and bypasses it.
ALTER TABLE app_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_connections  ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states          ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE platform_connections IS
    'Non-Meta platform credentials (TikTok). Tokens are enc:v1 (AES-256-GCM). See migration_v18_tiktok.sql.';
COMMENT ON TABLE app_settings IS
    'Operator-editable app-wide config; secrets enc:v1. Env vars are only a fallback.';
