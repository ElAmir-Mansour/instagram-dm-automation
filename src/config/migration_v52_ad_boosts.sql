SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v52: Boost a published post with the Meta Marketing API (docs/META_ADS_RESEARCH.md option 2, src/services/metaAds.ts). Idempotent. Safe to re-run.
--
-- One row per boost: the published post it promotes (a `scheduled_posts` row and which platform's copy of it), the Meta objects created for it
-- (campaign → ad set → creative → ad, every one created PAUSED), what the owner asked for (budget, days, objective, country) and what it has
-- spent. The ids are written as each object is created, so a chain that fails half way still names what exists and can be deleted.
--
--   status            creating   the chain is running; ids fill in as Meta answers
--                     paused     every object exists and is PAUSED: spends nothing
--                     active     the owner pressed Activate: campaign, ad set and ad are ACTIVE
--                     completed  the ad set's end time passed (or Meta reports it finished)
--                     failed     the chain stopped; `error` says where. Whatever was created is PAUSED and is deleted best effort
--                     deleted    the campaign was deleted at Meta (it deletes its ad sets and ads)
--   daily_budget      MAJOR units of the account currency (5.00 = $5). Meta is sent minor units (`toMinorUnits`)
--   planned_total     daily_budget × days: the ad set's LIFETIME budget, so Meta cannot spend more than this on it. The monthly cap counts it
--   spend             what Meta reports, major units, from the daily insights read
--
-- The scheduled post is ON DELETE SET NULL, not CASCADE: deleting a post from the dashboard must not erase the record of money spent on it.
-- RLS deny-by-default like every table (v11).
--
-- Rollout: `npm run migrate` BEFORE deploying. The daily cron's insights read queries this table (fail-soft, but loudly).

CREATE TABLE IF NOT EXISTS ad_boosts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id         UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    scheduled_post_id  UUID REFERENCES scheduled_posts(id) ON DELETE SET NULL,
    platform           TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook')),
    media_id           TEXT NOT NULL,
    ad_account_id      TEXT NOT NULL,
    objective          TEXT NOT NULL CHECK (objective IN ('ENGAGEMENT', 'AWARENESS', 'TRAFFIC')),
    country            TEXT NOT NULL,
    link               TEXT,
    currency           TEXT NOT NULL,
    daily_budget       NUMERIC(14, 2) NOT NULL CHECK (daily_budget > 0),
    days               INTEGER NOT NULL CHECK (days BETWEEN 1 AND 30),
    planned_total      NUMERIC(14, 2) NOT NULL CHECK (planned_total > 0),
    status             TEXT NOT NULL DEFAULT 'creating'
                       CHECK (status IN ('creating', 'paused', 'active', 'completed', 'failed', 'deleted')),
    campaign_id        TEXT,
    adset_id           TEXT,
    creative_id        TEXT,
    ad_id              TEXT,
    spend              NUMERIC(14, 2),
    insights           JSONB,
    error              TEXT,
    created_by         UUID,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at       TIMESTAMPTZ,
    ends_at            TIMESTAMPTZ,
    synced_at          TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_boosts_creator ON ad_boosts (creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ad_boosts_post ON ad_boosts (scheduled_post_id);

ALTER TABLE ad_boosts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ad_boosts IS
    'A boost of a published post (Meta Marketing API): its campaign/ad set/creative/ad ids, budget, status and spend. See migration_v52.';
