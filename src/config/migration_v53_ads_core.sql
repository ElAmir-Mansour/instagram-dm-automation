SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v53: the Ads Manager's core tables (src/services/ads/README.md). Idempotent. Safe to re-run.
--
--   ads_objects         the stored copy of every campaign, ad set, ad and creative in the tenant's ad account, also those made in Meta
--                       Ads Manager (`origin = 'meta'`). Filled by the structure sync (phase A2); this file backfills Boost's objects
--   ads_insights_daily  results per object per day, the day in the AD ACCOUNT's time zone. Money in major units of `currency`
--   ads_ops             the paced write queue: every write to Meta is one row with its outcome (A2 runs it; A1 records spend-cap writes
--                       and activations here, and the money rule counts a running activation as "about to run")
--   ads_pacer           one row per ad account: Meta's usage headers, the local point estimate and the time Meta blocked us until
--   ads_alerts          one row per alert sent: `(tenant, kind, object, day)` is unique, which is the once-a-day dedupe
--
-- Also: `ads.enabled.<tenant>` for every tenant that already has ads settings (Boost is live for the owner, so it stays on), one live boost
-- per (post, platform) enforced by the database instead of only by the screen, and `tracked_links.ads_object_id` so a link made for an ad
-- can be joined to it.
--
-- Money is NUMERIC(14,2) in MAJOR units of the row's currency, converted to Meta's minor units at the edge (src/services/ads/money.ts). Every
-- table is keyed by the tenant, cascades with it, and has row level security on, deny-by-default like every table (v11).
--
-- Rollout: `npm run migrate` BEFORE deploying. The guard, the health check and the spend-cap route read these tables.

-- ── The stored copy ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ads_objects (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id         UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    ad_account_id      TEXT NOT NULL,
    level              TEXT NOT NULL CHECK (level IN ('campaign', 'adset', 'ad', 'creative')),
    -- NULL until the object exists at Meta.
    meta_id            TEXT,
    parent_id          UUID REFERENCES ads_objects(id) ON DELETE SET NULL,
    name               TEXT,
    origin             TEXT NOT NULL CHECK (origin IN ('app', 'boost', 'proposal', 'meta')),
    status             TEXT,
    effective_status   TEXT,
    objective          TEXT,
    destination_type   TEXT,
    optimization_goal  TEXT,
    budget_kind        TEXT NOT NULL DEFAULT 'none' CHECK (budget_kind IN ('daily', 'lifetime', 'none')),
    budget_amount      NUMERIC(14, 2),
    currency           TEXT NOT NULL,
    start_time         TIMESTAMPTZ,
    end_time           TIMESTAMPTZ,
    targeting_summary  JSONB,
    review             JSONB,
    -- The app's own facts about the object (offer, greeting, boost id, proposal id). Never personal data.
    app_meta           JSONB NOT NULL DEFAULT '{}',
    raw                JSONB,
    synced_at          TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A new table, so IF NOT EXISTS cannot keep an older, weaker index of the same name (migration v15's lesson).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_objects_meta ON ads_objects (creator_id, level, meta_id) WHERE meta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ads_objects_status ON ads_objects (creator_id, level, effective_status);
CREATE INDEX IF NOT EXISTS idx_ads_objects_parent ON ads_objects (parent_id);

ALTER TABLE ads_objects ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS ads_insights_daily (
    creator_id             UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    level                  TEXT NOT NULL CHECK (level IN ('account', 'campaign', 'adset', 'ad')),
    -- The ad account's id for `account` rows.
    meta_id                TEXT NOT NULL,
    -- The ad account's calendar day, not UTC's.
    day                    DATE NOT NULL,
    currency               TEXT NOT NULL,
    -- Excludes tax: Meta's invoices are the accounting record.
    spend                  NUMERIC(14, 2) NOT NULL DEFAULT 0,
    impressions            BIGINT NOT NULL DEFAULT 0,
    -- Not additive across days or levels: valid only for its own row.
    reach                  BIGINT NOT NULL DEFAULT 0,
    clicks                 BIGINT NOT NULL DEFAULT 0,
    link_clicks            BIGINT NOT NULL DEFAULT 0,
    conversations_started  INTEGER NOT NULL DEFAULT 0,
    first_replies          INTEGER NOT NULL DEFAULT 0,
    leads                  INTEGER NOT NULL DEFAULT 0,
    follows                INTEGER,
    video_views            INTEGER NOT NULL DEFAULT 0,
    actions                JSONB,
    attribution            TEXT,
    -- The last 3 days: Meta may still revise them.
    provisional            BOOLEAN NOT NULL DEFAULT TRUE,
    synced_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (creator_id, level, meta_id, day)
);

ALTER TABLE ads_insights_daily ENABLE ROW LEVEL SECURITY;

-- ── The paced write queue ────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ads_ops (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id        UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    ad_account_id     TEXT NOT NULL,
    -- What the op writes to: an ads_objects id, a Meta id, or `account`. Ops on one key run one at a time.
    object_key        TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('create', 'update', 'status', 'budget', 'archive', 'delete', 'spend_cap',
                                                    'audience_create', 'audience_users', 'lead_form', 'study')),
    -- The Graph params, already validated. Never a token.
    payload           JSONB NOT NULL DEFAULT '{}',
    idempotency_key   TEXT UNIQUE,
    depends_on        UUID REFERENCES ads_ops(id) ON DELETE SET NULL,
    state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'verify', 'done', 'failed', 'cancelled')),
    not_before        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attempts          INTEGER NOT NULL DEFAULT 0,
    -- Meta's ids, or its error { code, subcode, message, fbtrace_id }.
    result            JSONB,
    -- { userId, role, via: 'owner' | 'rule' | 'proposal' | 'guard' }
    actor             JSONB NOT NULL DEFAULT '{}',
    proposal_id       UUID,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ads_ops_claim ON ads_ops (ad_account_id, state, not_before);
-- The per-object limits read the history of one object (4 budget edits an hour, 30 s apart, 10 spend-cap changes a day).
CREATE INDEX IF NOT EXISTS idx_ads_ops_object ON ads_ops (creator_id, object_key, kind, finished_at DESC);

ALTER TABLE ads_ops ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS ads_pacer (
    ad_account_id      TEXT PRIMARY KEY,
    creator_id         UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- Points spent in the current 300 s window: our own count, replaced by Meta's `acc_id_util_pct` whenever it is sent.
    score_estimate     NUMERIC NOT NULL DEFAULT 0,
    window_started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    blocked_until      TIMESTAMPTZ,
    -- The raw usage headers, the last tier seen, the version Meta served.
    last_usage         JSONB NOT NULL DEFAULT '{}',
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ads_pacer ENABLE ROW LEVEL SECURITY;

-- ── Alerts ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ads_alerts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    object_key  TEXT NOT NULL,
    -- The ad account's calendar day.
    day         DATE NOT NULL,
    detail      JSONB NOT NULL DEFAULT '{}',
    -- { telegram, email, admin_copy }: 'sent' | 'failed' | 'off'
    channels    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_alerts_once_a_day ON ads_alerts (creator_id, kind, object_key, day);

ALTER TABLE ads_alerts ENABLE ROW LEVEL SECURITY;

-- ── Changes to existing data ─────────────────────────────────────────────────────────────────────────────────────────────────────────

-- One live boost per published post and platform, held by the database (it was only the screen before).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_boosts_one_live
    ON ad_boosts (scheduled_post_id, platform) WHERE status IN ('creating', 'paused', 'active');

-- A tracked link made for an ad (research R25). SET NULL: the click history outlives the stored copy of the ad.
ALTER TABLE tracked_links ADD COLUMN IF NOT EXISTS ads_object_id UUID REFERENCES ads_objects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tracked_links_ads_object ON tracked_links (ads_object_id) WHERE ads_object_id IS NOT NULL;

-- Ads stay on for every tenant that already uses them (today only the owner): `ads.enabled.<tenant>` is the platform admin's switch,
-- and every /api/ads route answers 404 without it.
INSERT INTO app_settings (key, value, is_secret)
SELECT 'ads.enabled.' || substr(key, length('ads.settings.') + 1), 'true', FALSE
  FROM app_settings
 WHERE key LIKE 'ads.settings.%'
ON CONFLICT (key) DO NOTHING;

-- Boost's objects into the stored copy, so the structure sync (A2) finds them already labelled `boost`. Campaigns first, then what hangs
-- under them. A failed boost made nothing that lasts, and is left out.
INSERT INTO ads_objects (creator_id, ad_account_id, level, meta_id, name, origin, status, currency, app_meta)
SELECT b.creator_id, b.ad_account_id, 'campaign', b.campaign_id, 'AutoReply boost ' || b.id, 'boost',
       CASE b.status WHEN 'active' THEN 'ACTIVE' WHEN 'deleted' THEN 'DELETED' ELSE 'PAUSED' END,
       b.currency, jsonb_build_object('boost_id', b.id)
  FROM ad_boosts b
 WHERE b.campaign_id IS NOT NULL AND b.status <> 'failed'
ON CONFLICT (creator_id, level, meta_id) WHERE meta_id IS NOT NULL DO NOTHING;

INSERT INTO ads_objects (creator_id, ad_account_id, level, meta_id, parent_id, name, origin, status, budget_kind, budget_amount, currency, end_time, app_meta)
SELECT b.creator_id, b.ad_account_id, 'adset', b.adset_id, c.id, 'AutoReply boost ' || b.id, 'boost',
       CASE b.status WHEN 'active' THEN 'ACTIVE' WHEN 'deleted' THEN 'DELETED' ELSE 'PAUSED' END,
       'lifetime', b.planned_total, b.currency, b.ends_at, jsonb_build_object('boost_id', b.id)
  FROM ad_boosts b
  JOIN ads_objects c ON c.creator_id = b.creator_id AND c.level = 'campaign' AND c.meta_id = b.campaign_id
 WHERE b.adset_id IS NOT NULL AND b.status <> 'failed'
ON CONFLICT (creator_id, level, meta_id) WHERE meta_id IS NOT NULL DO NOTHING;

INSERT INTO ads_objects (creator_id, ad_account_id, level, meta_id, parent_id, name, origin, status, currency, app_meta)
SELECT b.creator_id, b.ad_account_id, 'ad', b.ad_id, s.id, 'AutoReply boost ' || b.id, 'boost',
       CASE b.status WHEN 'active' THEN 'ACTIVE' WHEN 'deleted' THEN 'DELETED' ELSE 'PAUSED' END,
       b.currency, jsonb_build_object('boost_id', b.id, 'creative_id', b.creative_id)
  FROM ad_boosts b
  JOIN ads_objects s ON s.creator_id = b.creator_id AND s.level = 'adset' AND s.meta_id = b.adset_id
 WHERE b.ad_id IS NOT NULL AND b.status <> 'failed'
ON CONFLICT (creator_id, level, meta_id) WHERE meta_id IS NOT NULL DO NOTHING;

INSERT INTO ads_objects (creator_id, ad_account_id, level, meta_id, name, origin, currency, app_meta)
SELECT b.creator_id, b.ad_account_id, 'creative', b.creative_id, 'AutoReply boost ' || b.id, 'boost',
       b.currency, jsonb_build_object('boost_id', b.id)
  FROM ad_boosts b
 WHERE b.creative_id IS NOT NULL AND b.status <> 'failed'
ON CONFLICT (creator_id, level, meta_id) WHERE meta_id IS NOT NULL DO NOTHING;

COMMENT ON TABLE ads_objects IS 'The stored copy of the ad account''s campaigns, ad sets, ads and creatives (Ads Manager). See migration_v53.';
COMMENT ON TABLE ads_insights_daily IS 'Ads results per object per day, the day in the ad account''s time zone. See migration_v53.';
COMMENT ON TABLE ads_ops IS 'The paced write queue to the Marketing API: one row per write and its outcome. See migration_v53.';
COMMENT ON TABLE ads_pacer IS 'Per ad account: Meta''s usage headers, the local point estimate and any block. See migration_v53.';
COMMENT ON TABLE ads_alerts IS 'Ads alerts sent, once per (tenant, kind, object, day). See migration_v53.';
