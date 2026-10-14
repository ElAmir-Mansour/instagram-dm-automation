-- Migration v40: who the sender is, on the conversation (the inbox's detail view). Idempotent. Safe to re-run.
--
-- `conversations.username` was never written by the DM pipeline, so every Instagram thread showed as "User 3051" (the last four digits
-- of the id). Meta's Instagram User Profile API answers who a person is once they have messaged the business
-- (https://developers.facebook.com/docs/messenger-platform/instagram/features/user-profile): name, username, profile_pic,
-- follower_count, is_user_follow_business, is_business_follow_user, is_verified_user. The DM pipeline asks for it on first contact and at
-- most once a day after that (src/services/senderProfile.ts), and the inbox asks for it when it opens a thread that has none.
--
--   username                  (existing column) the Instagram handle; written from `username` below
--   profile_name              the person's display name; NULL when they have none set
--   profile_pic_url           Meta's link to the picture. It EXPIRES after a few days (Meta says to fetch it again, not store it), so it is a
--                             cache: the inbox falls back to initials when it fails to load, and a refresh replaces it
--   follower_count            their follower count
--   is_user_follow_business   they follow the account
--   is_business_follow_user   the account follows them
--   is_verified_user          their verification badge
--   profile_fetched_at        the last SUCCESSFUL lookup. NULL = never got one. The inbox refreshes a thread whose profile is older than a day
--   profile_checked_at        the last ATTEMPT, success or failure. This is the throttle: one attempt per conversation per day, or per hour
--                             while there is still no successful lookup. Claimed atomically in one UPDATE, so two DMs a second apart ask once
--
-- No existing row changes: nullable columns with no default are catalog-only, so adding them rewrites nothing. A thread fills in on its
-- next DM or the first time the operator opens it.
--
-- Rollout: `npm run migrate` BEFORE deploying. The DM pipeline's lookup is best effort and never blocks a reply: on a database without these
-- columns it logs `dm.profile_failed` and the DM is answered as before. The inbox reads tolerate the columns being absent.

-- Locks `conversations` (the DM path's hot table) for the ADDs: fail in 5 s rather than queue a DM behind a long query. LOCAL ends with the
-- runner's per-file transaction, so nothing sticks to a pooled connection.
SET LOCAL lock_timeout = '5s';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile_name VARCHAR(255);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile_pic_url TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follower_count INTEGER;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_user_follow_business BOOLEAN;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_business_follow_user BOOLEAN;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_verified_user BOOLEAN;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile_fetched_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS profile_checked_at TIMESTAMP WITH TIME ZONE;

COMMENT ON COLUMN conversations.profile_pic_url IS
    'Meta''s link to the sender''s picture. Expires after a few days: a cache the inbox falls back from, refreshed with the profile.';
COMMENT ON COLUMN conversations.profile_fetched_at IS
    'The last successful Instagram User Profile lookup for this sender. NULL: never got one.';
COMMENT ON COLUMN conversations.profile_checked_at IS
    'The last attempt at that lookup, success or failure: the throttle (one a day, one an hour while none has succeeded).';
