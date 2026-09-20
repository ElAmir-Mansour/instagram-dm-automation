-- Migration v8: store the Meta webhook verify token alongside the creator.
-- Run this in your Supabase SQL editor.
--
-- The verify token was previously only readable from META_VERIFY_TOKEN, which
-- meant changing it required editing Vercel's environment and redeploying.
-- Meta re-checks this value every time a webhook subscription is created or its
-- callback URL changes, so an unset or stale value silently blocks all webhook
-- reconfiguration. Storing it here lets it be set from the dashboard and take
-- effect immediately.

ALTER TABLE creators ADD COLUMN IF NOT EXISTS webhook_verify_token TEXT;
