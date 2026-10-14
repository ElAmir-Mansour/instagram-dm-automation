SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue a TikTok refresh behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v44: the profile fields a TikTok connection keeps (docs/TENANT_ONBOARDING_PLAN.md P33). Idempotent. Safe to re-run.
--
--   platform_connections.profile   JSONB. What `user.info.profile` returned when the account connected: `{ username, bio, profileLink,
--                                  verified, fetchedAt }` (StoredTikTokProfile in src/services/tiktokConnections.ts). The onboarding draft reads
--                                  it as a source (src/services/onboarding/ttMap.ts). NULL on every row that exists today, and on every connection
--                                  made while the operator setting `tiktok.profile_scope_enabled` is off, which is its default: the scope is only
--                                  requested once the TikTok portal has approved it. It is written apart from the connection's own INSERT and
--                                  cleared when a reconnect reads none, so another account's bio never sits on this connection. The row is deleted
--                                  with the connection (Settings -> Disconnect, or TikTok's `authorization.removed` webhook), and the profile with it.
--
-- Not stored here: the display name and avatar (columns since v18, from `user.info.basic`), and the follower, following, likes and video counts,
-- which TikTok returns only for `user.info.stats`, a scope this app does not request.
--
-- No existing row changes: a nullable column with no default is catalog-only, so adding it rewrites nothing. No table is created, and
-- `platform_connections` has row level security since v18. No index: the draft reads a tenant's connection by its unique `(creator_id, platform)`.
--
-- Rollout: `npm run migrate` BEFORE deploying, as for every migration. A deployment that is behind survives it: with the setting off (the default)
-- nothing reads or writes the column, and with it on a connect that cannot save the profile logs `tiktok.profile_save_failed` and still connects.

ALTER TABLE platform_connections ADD COLUMN IF NOT EXISTS profile JSONB;

COMMENT ON COLUMN platform_connections.profile IS
    'TikTok: the user.info.profile fields read at connect time ({username, bio, profileLink, verified, fetchedAt}), or NULL. Deleted with the connection. P33.';
