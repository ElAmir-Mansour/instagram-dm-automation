-- Migration v12: multi-tenant foundation
--
-- Managed tenancy: the operator creates accounts and connects each client's Meta assets.
-- Self-serve signup is deliberately NOT built here, but the shape below is chosen so that
-- adding it later is an addition rather than a rewrite.
--
-- Idempotent. Safe to re-run.

-- ── Users ───────────────────────────────────────────────────────────────────────────────
-- Passwords are scrypt-hashed in the application (src/config/crypto.ts), never here.
-- `token_version` exists so sessions can actually be revoked: the session token embeds it,
-- and bumping this column invalidates every token that user holds. Before this, a leaked
-- token was valid for a full 24h with no way to kill it.
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    -- 'platform_admin' sees and switches into every tenant; 'user' sees only their own.
    role VARCHAR(30) NOT NULL DEFAULT 'user',
    token_version INT NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Memberships ─────────────────────────────────────────────────────────────────────────
-- A join table rather than a `creator_id` column on `users`, specifically so one person can
-- administer several tenants later (an agency seat, a client with two brands) without a
-- migration. That is the single cheapest thing here that avoids a future rewrite.
CREATE TABLE IF NOT EXISTS memberships (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL DEFAULT 'owner',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, creator_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_creator ON memberships(creator_id);

-- ── Tenant identity ─────────────────────────────────────────────────────────────────────
-- A human label for the tenant switcher; `meta_user_id` so a client reconnecting through
-- OAuth later resolves to their existing row instead of creating a duplicate.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE creators ADD COLUMN IF NOT EXISTS meta_user_id VARCHAR(255);
ALTER TABLE creators ADD COLUMN IF NOT EXISTS token_status VARCHAR(30) DEFAULT 'unknown';
ALTER TABLE creators ADD COLUMN IF NOT EXISTS token_last_checked_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS token_error TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_meta_user
    ON creators(meta_user_id) WHERE meta_user_id IS NOT NULL;

-- ── Direct tenant keys on child tables ──────────────────────────────────────────────────
-- `messages` and `interactions` were only reachable through a join, and `media_uploads` had
-- no tenant key at all while being served unauthenticated by UUID. Filtering through a join
-- is the kind of thing that gets forgotten on exactly one endpoint.
ALTER TABLE media_uploads ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES creators(id) ON DELETE CASCADE;
ALTER TABLE messages     ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES creators(id) ON DELETE CASCADE;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS creator_id UUID REFERENCES creators(id) ON DELETE CASCADE;

-- Backfill from existing relationships. Safe to re-run; only fills NULLs.
UPDATE messages m SET creator_id = c.creator_id
  FROM conversations c WHERE m.conversation_id = c.id AND m.creator_id IS NULL;

UPDATE interactions i SET creator_id = ca.creator_id
  FROM campaigns ca WHERE i.campaign_id = ca.id AND i.creator_id IS NULL;

-- media_uploads has no relationship to follow, so it can only be attributed to the single
-- creator that existed when those rows were written.
UPDATE media_uploads SET creator_id = (SELECT id FROM creators ORDER BY created_at LIMIT 1)
 WHERE creator_id IS NULL
   AND (SELECT COUNT(*) FROM creators) = 1;

CREATE INDEX IF NOT EXISTS idx_messages_creator ON messages(creator_id);
CREATE INDEX IF NOT EXISTS idx_interactions_creator ON interactions(creator_id);
CREATE INDEX IF NOT EXISTS idx_media_uploads_creator ON media_uploads(creator_id);

-- ── Token encryption marker ─────────────────────────────────────────────────────────────
-- Values are stored as `enc:v1:<iv>:<tag>:<ciphertext>` once encrypted, so the prefix tells
-- the reader which scheme applies and a key rotation can be staged by version.
COMMENT ON COLUMN creators.page_access_token IS
    'Encrypted at rest via src/config/crypto.ts. Plaintext legacy values are read transparently.';

-- ── Name the existing tenant so the switcher has something to show ─────────────────────
UPDATE creators SET name = COALESCE(name, 'Default') WHERE name IS NULL;

ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
