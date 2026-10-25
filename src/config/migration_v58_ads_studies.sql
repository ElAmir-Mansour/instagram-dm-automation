SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v58: split tests (Ads Manager phase A12, src/services/ads/studies.ts). Idempotent. Safe to re-run.
--
--   ads_studies  one row per split test the owner made in the app: two to seven versions of an ad (`creative`, Meta's SPLIT_TEST_V2)
--                or two to five ad sets (`audience`, Meta's SPLIT_TEST), the daily budget and the dates, and what Meta answered.
--
-- The arms are ads_objects rows (v53) that the builder made PAUSED; `cells` keeps their ids, Meta ids and shares so the screen and the
-- winner proposal do not depend on the arms still being in the stored copy. `meta_id` stays NULL until the `study` op (ads_ops) is done.
-- `proposal_id` is the keep-the-winner proposal in ads_proposals (v55); no foreign key, so a proposal's retention never blocks a study's.
--
-- No personal data: names, ids, money, dates and Meta's result numbers only. Keyed by the tenant, cascades with it, and row level
-- security is on, deny-by-default like every table (v11).
--
-- Rollout: `npm run migrate` BEFORE deploying. GET /api/ads/studies reads this table.

CREATE TABLE IF NOT EXISTS ads_studies (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id          UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    ad_account_id       TEXT NOT NULL,
    business_id         TEXT NOT NULL,
    -- NULL until Meta made the study.
    meta_id             TEXT,
    type                TEXT NOT NULL CHECK (type IN ('creative', 'audience')),
    name                TEXT NOT NULL,
    -- [{ name, objectId, metaId, objectName, level: 'ad' | 'adset', treatmentPercentage }]
    cells               JSONB NOT NULL,
    -- Major units of `currency`, for the whole test a day (split between the arms).
    daily_budget        NUMERIC(14, 2) NOT NULL CHECK (daily_budget > 0),
    currency            TEXT NOT NULL,
    start_time          TIMESTAMPTZ NOT NULL,
    end_time            TIMESTAMPTZ NOT NULL,
    state               TEXT NOT NULL DEFAULT 'creating'
                        CHECK (state IN ('creating', 'ready', 'running', 'ended', 'stopped', 'failed')),
    -- { winnerObjectIds, highPerformerIds, confidenceByObjectId, final, noWinner, checkedAt }
    result              JSONB,
    -- The `study` op that creates it at Meta.
    op_id               UUID,
    proposal_id         UUID,
    -- The reason a create failed, in Meta's words.
    error               TEXT,
    created_by          UUID,
    results_checked_at  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (end_time > start_time)
);

-- A new table, so IF NOT EXISTS cannot keep an older, weaker index of the same name (migration v15's lesson).
CREATE INDEX IF NOT EXISTS idx_ads_studies_creator ON ads_studies (creator_id, created_at DESC);
-- The results poll reads only the studies that can still change.
CREATE INDEX IF NOT EXISTS idx_ads_studies_open ON ads_studies (state, results_checked_at) WHERE state IN ('creating', 'ready', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_studies_meta ON ads_studies (creator_id, meta_id) WHERE meta_id IS NOT NULL;

ALTER TABLE ads_studies ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ads_studies IS 'Ads split tests (creative or audience), one row per test. See migration_v58.';
