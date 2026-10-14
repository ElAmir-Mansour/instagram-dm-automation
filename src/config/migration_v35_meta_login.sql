-- Migration v35: Meta login, "connect with clicks" (docs/onboarding/04). Idempotent. Safe to re-run.
--
-- A tenant connects its own Facebook Page and Instagram account through Facebook Login for Business instead of the operator pasting
-- a token (v34 made a Meta connection optional; this is how one is made). Nothing here creates a table: it widens three things.
--
--   creators.meta_page_name, meta_connected_at, meta_webhook_subscribed_at
--       what a connection records beside the ids and the token: the Page's name (for Settings), when it was made (the setup
--       wizard's "comment test" only counts events after it), and when the Page was subscribed to the app's webhook (NULL: the
--       subscription failed or could not be confirmed, and the connection was kept with a warning).
--       `meta_user_id` already exists (v12) and has never been written; it now is, with the Facebook user who authorised.
--   idx_creators_meta_user                      UNIQUE becomes a plain index (below)
--   oauth_states.payload, return_to             the generic OAuth state (src/services/oauthState.ts)
--
-- Nothing reads the new columns until the Meta routes (src/routes/meta.ts) are called, and no existing row is changed: the owner's
-- tenant keeps its ids and token exactly as they are, with the three new columns NULL.

-- Locks `creators` (the webhook's hot table) for the ADDs and the index swap: fail in 5 s rather than queue live requests behind a
-- long query. LOCAL ends with the runner's per-file transaction, so nothing sticks to a pooled connection.
SET LOCAL lock_timeout = '5s';

-- ─── 1. creators: what a Meta connection records ─────────────────────────────────────────────

ALTER TABLE creators ADD COLUMN IF NOT EXISTS meta_page_name TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS meta_connected_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS meta_webhook_subscribed_at TIMESTAMP WITH TIME ZONE;

-- v12 made meta_user_id UNIQUE, to find a client again when it reconnected. That is wrong now: one person who runs two businesses
-- connects both tenants with the same Facebook account, and the second connection would collide with the first. It becomes a plain
-- index. IF NOT EXISTS matches on the NAME and not the definition (migration v15), so a bare CREATE INDEX would silently keep the
-- unique one: it is dropped first, and only when it is still unique, so a re-run leaves the plain index alone.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = current_schema()
           AND indexname = 'idx_creators_meta_user'
           AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
    ) THEN
        DROP INDEX idx_creators_meta_user;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_creators_meta_user ON creators (meta_user_id) WHERE meta_user_id IS NOT NULL;

COMMENT ON COLUMN creators.meta_user_id IS
    'The Facebook user who authorised the connection (Facebook Login for Business). NOT unique: one person may connect several tenants. NULL for a connection made by pasting a token.';
COMMENT ON COLUMN creators.meta_page_name IS
    'The Facebook Page''s name at the time it was connected, for Settings. NULL for a connection made by pasting a token.';
COMMENT ON COLUMN creators.meta_connected_at IS
    'When the Meta connection was made by Login. The setup wizard counts comment events after this. NULL for a connection made by pasting a token.';
COMMENT ON COLUMN creators.meta_webhook_subscribed_at IS
    'When the Page was subscribed to the app''s webhook fields (POST /{page}/subscribed_apps) and the subscription was read back. NULL: not subscribed, or not confirmed.';

-- ─── 2. oauth_states: one state for every connect flow ───────────────────────────────────────

-- payload: encrypted JSON (enc:v1, AES-256-GCM). For platform 'meta' it carries what the connect asked for (a reconnect); for
-- 'meta_pick' it carries the Pages the user may choose from, each with its Page access token, for ten minutes. A choice (or the
-- sweep after the state expired) sets it back to NULL: a Page token never sits in this table longer than it has to.
-- return_to: where the callback sends the browser back to ('settings' or 'welcome'). TikTok and YouTube leave both NULL and are
-- written and read exactly as before.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS payload TEXT;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS return_to VARCHAR(20);

COMMENT ON COLUMN oauth_states.payload IS
    'enc:v1 JSON. platform meta: the connect''s intent. platform meta_pick: the Pages to choose from with their tokens, NULLed the moment a choice is made.';
COMMENT ON COLUMN oauth_states.return_to IS
    'Where the callback returns the browser: settings or welcome. NULL for TikTok and YouTube (always Settings).';
