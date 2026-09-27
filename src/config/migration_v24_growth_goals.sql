-- Migration v24: the growth goals are settings, not constants.
--
-- The operator chases a follower count and a view count (docs/agents/BRIEF.md). Until now those
-- two numbers lived nowhere the product could read them, so no screen could say "154 of 10,000".
-- They join growth_settings as two columns, one row per tenant, edited from Growth → SEO & reach.
--
-- Defaults are the brief's goals, so an existing tenant sees a distance-to-goal the moment this
-- applies. Validation (a whole number above zero, at most a billion) is in
-- src/services/growth/settings.ts; the columns only hold the type.
--
-- Rollout: `npm run migrate` BEFORE deploying. `getGrowthSettings` selects both columns, and the
-- Growth overview, coach and keyword routes read the settings on every call.
--
-- Idempotent.

ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS goal_followers INTEGER NOT NULL DEFAULT 10000;
ALTER TABLE growth_settings ADD COLUMN IF NOT EXISTS goal_views BIGINT NOT NULL DEFAULT 1000000;
