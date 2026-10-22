SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v56: Meta Ads Manager phase A8 (audiences) and A9 (rules), plus the legal sign-off that unlocks customer lists and lead ads
-- (docs/specs/002-meta-ads-manager/data-model.md). Idempotent. Safe to re-run.
--
-- Four tables. Every one is keyed by `creator_id` (ON DELETE CASCADE) and RLS deny-by-default like every table (v11).
--
-- ads_audiences: the Custom Audiences the tenant made from the Ads screen. Audiences made in Meta Ads Manager are not stored (no kind fits them).
--   kind     ig_engagement    people who engaged with the Instagram account
--            page_engagement  people who engaged with the Facebook Page
--            video_viewers    people who watched a video
--            messagers        people who messaged the Page or the Instagram account
--            lookalike        a lookalike of `seed_audience_id` (country and ratio in `spec`)
--            customer_list    a list the owner uploaded (needs a `customer_lists` legal sign-off, ads_legal_signoffs)
--   status   creating   the create call has not been answered, or Meta has not finished building it
--            ready      Meta reports a usable size
--            too_small  Meta reports a size below what an ad set can target
--            flagged    Meta flagged it as implying sensitive data (operation_status 471): it cannot be used; delete it and make a neutral one
--            deleted    deleted at Meta (the row stays for the audit trail)
--   spec          the source ids, events, retention days, ratio and country. JSONB, never a free-text field.
--   size_lower / size_upper   Meta's size estimate range, as Meta reports it (it never gives one exact figure)
--   seed_audience_id   a lookalike's source. ON DELETE SET NULL: deleting the seed must not erase the lookalike's record
--   synced_at     when the mirror last read this audience from Meta
--   Names are neutral and never imply sensitive data (health, religion, finances): Meta policy, and the name is visible to Meta.
--   NO PERSONAL DATA is stored here, ever. For a customer list the row keeps only {rows_sent, matched_estimate} in `spec`:
--   the hashed rows go to Meta and are scrubbed from the op queue when the upload finishes.
--
-- ads_rules: automatic rules the owner writes (phase A9). `scope` is {level, object_ids[] | 'all'}; `conditions` is an ARRAY of
--   {metric, op, value, window}; `min_data` is {impressions?, spend?}: below it a rule skips instead of acting on noise; `actions`
--   is an ARRAY of {type, percent?}. Types pause, lower_budget and notify act at once; raise_budget and resume only become proposals
--   the owner approves. `approved_by`/`approved_at` record who switched the rule on, `last_ok_at` the last run that read its data.
--
-- ads_rule_runs: one row per evaluation of a rule. Kept 90 days (the daily sweep prunes older rows).
--   outcome  ok               ran, nothing matched
--            acted            matched and queued ops (`ops` holds their ids)
--            proposed         matched and made a proposal (`proposal_id`)
--            skipped_no_data  below `min_data`, so nothing was judged
--            blind            the insights read failed or is stale: the rule did nothing rather than guess
--   creator_id is repeated here so reads are tenant-scoped without a join. `proposal_id` has NO foreign key: ads_proposals is v55
--   and may not exist on every branch yet.
--
-- ads_legal_signoffs: the platform admin's record that a legal opinion covers a capability for a set of countries. ONLY the platform
--   admin writes rows (routes/admin.ts). A capability is unlocked while a non-revoked row (`revoked_at IS NULL`) covers it:
--   scope customer_lists unlocks uploading customer lists, scope lead_ads unlocks lead forms and lead storage. `note` says who gave
--   the opinion and where it is kept. Egypt's PDPL 151/2020 compliance deadline is 2026-11-01; Saudi PDPL applies as well.
--   Revoking sets `revoked_at`; rows are never deleted.
--
-- Rollout: `npm run migrate` BEFORE deploying. The Audiences screen, the rule engine and the sign-off routes query these tables.

CREATE TABLE IF NOT EXISTS ads_audiences (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id         UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    meta_id            TEXT,
    kind               TEXT NOT NULL
                       CHECK (kind IN ('ig_engagement', 'page_engagement', 'video_viewers', 'messagers', 'lookalike', 'customer_list')),
    name               TEXT NOT NULL,
    spec               JSONB NOT NULL DEFAULT '{}'::jsonb,
    status             TEXT NOT NULL DEFAULT 'creating'
                       CHECK (status IN ('creating', 'ready', 'too_small', 'flagged', 'deleted')),
    size_lower         BIGINT,
    size_upper         BIGINT,
    seed_audience_id   UUID REFERENCES ads_audiences(id) ON DELETE SET NULL,
    synced_at          TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_audiences_meta ON ads_audiences (creator_id, meta_id) WHERE meta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ads_audiences_status ON ads_audiences (creator_id, status);

CREATE TABLE IF NOT EXISTS ads_rules (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id     UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    scope          JSONB NOT NULL,
    conditions     JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conditions) = 'array'),
    min_data       JSONB NOT NULL DEFAULT '{}'::jsonb,
    actions        JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array'),
    approved_by    UUID,
    approved_at    TIMESTAMPTZ,
    last_ok_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_rules_enabled ON ads_rules (creator_id, enabled);

CREATE TABLE IF NOT EXISTS ads_rule_runs (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id      UUID NOT NULL REFERENCES ads_rules(id) ON DELETE CASCADE,
    creator_id   UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    ran_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    outcome      TEXT NOT NULL
                 CHECK (outcome IN ('ok', 'acted', 'proposed', 'skipped_no_data', 'blind')),
    matched      JSONB NOT NULL DEFAULT '[]'::jsonb,
    ops          UUID[] NOT NULL DEFAULT '{}',
    proposal_id  UUID
);

CREATE INDEX IF NOT EXISTS idx_ads_rule_runs_rule ON ads_rule_runs (rule_id, ran_at DESC);

CREATE TABLE IF NOT EXISTS ads_legal_signoffs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id    UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    countries     TEXT[] NOT NULL,
    scope         TEXT NOT NULL CHECK (scope IN ('lead_ads', 'customer_lists')),
    recorded_by   UUID,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note          TEXT,
    revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ads_legal_signoffs_active ON ads_legal_signoffs (creator_id, scope) WHERE revoked_at IS NULL;

ALTER TABLE ads_audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_rule_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_legal_signoffs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ads_audiences IS
    'Meta Custom Audiences (engagement, video, messagers, lookalike, customer list). Neutral names; no personal data, customer lists keep only counts. See migration_v56.';
COMMENT ON TABLE ads_rules IS
    'Automatic ad rules (phase A9): scope, conditions, minimum data and actions. raise_budget and resume actions become proposals. See migration_v56.';
COMMENT ON TABLE ads_rule_runs IS
    'One evaluation of an automatic rule and what it did. Kept 90 days. proposal_id has no foreign key on purpose. See migration_v56.';
COMMENT ON TABLE ads_legal_signoffs IS
    'Platform-admin record that a legal opinion covers customer lists or lead ads for some countries; unlocked while a non-revoked row covers it. See migration_v56.';
