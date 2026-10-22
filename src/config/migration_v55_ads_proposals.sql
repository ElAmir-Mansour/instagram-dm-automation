SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v55: AI proposals (Meta Ads Manager phase A7, src/services/ads/proposals/). Idempotent. Safe to re-run.
--
--   ads_proposals   a campaign Claude drafted (from the owner's words or a post) or one change the daily review proposes. Nothing is
--                   created or changed at Meta until a person approves it; approving enqueues `ads_ops` rows carrying `proposal_id`
--                   (v53) and a new campaign is created PAUSED. No customer data: `request_text` is the owner's words, `payload` a
--                   campaign spec or a change, `evidence` the account's own aggregate numbers (FR-049).
--
-- States: drafting → open | failed; open → approved → applying → applied | failed; open → rejected | expired (`expires_at`, 7 days).
-- The service enforces the moves (store.ts PROPOSAL_TRANSITIONS); the CHECK keeps the vocabulary closed.
--
-- `studio_jobs_kind_check` gains `ads_think`: the owner's drafts are answered by Claude on his Mac (the Studio worker in aicourse-captions,
-- scripts/studio/adsThinkJob.mjs), like `monteur_think` (v28). The list below is v31's plus `ads_think`; no migration since v31 widened it.
--
-- Row level security on, deny-by-default like every table (v11). Keyed by the tenant, cascades with it.
--
-- Rollout: `npm run migrate` BEFORE deploying, and restart the Mac worker after pulling aicourse-captions.

CREATE TABLE IF NOT EXISTS ads_proposals (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id    UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('new_campaign', 'change', 'rule_raise', 'test_winner')),
    source        TEXT NOT NULL CHECK (source IN ('request', 'post', 'daily_review', 'rule', 'study')),
    -- The owner's words, at most 1000 characters (the route trims). Never a customer's.
    request_text  TEXT,
    -- The post a "Suggest a campaign" on a Posts card was for: { postId, platform }.
    post_ref      JSONB,
    -- A new campaign's spec with its assumptions and expected range, or one review item's change (contracts/ai-proposal.schema.md).
    payload       JSONB,
    rationale     TEXT,
    evidence      JSONB,
    -- { worstCaseDelta, newWorstCase, currency }
    effect        JSONB,
    -- { policy: [...findings], money: {ok, reason, note}, meta_validate: {ok, error}, dropped?, unavailable?, ops? }
    checks        JSONB,
    state         TEXT NOT NULL DEFAULT 'drafting'
                  CHECK (state IN ('drafting', 'open', 'approved', 'applying', 'applied', 'failed', 'rejected', 'expired')),
    -- Why it failed, or the owner's reason for rejecting it.
    error         TEXT,
    -- { via: 'mac'|'api', provider, model, effort, usd }
    model         JSONB,
    -- 1, or 2 after the one regeneration the checks allow.
    attempt       INT NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 2),
    decided_by    UUID,
    decided_at    TIMESTAMPTZ,
    expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_proposals_creator_state ON ads_proposals (creator_id, state, created_at DESC);
-- The daily expiry sweep: open proposals past their time, and drafts the Mac never answered.
CREATE INDEX IF NOT EXISTS idx_ads_proposals_open_expiry ON ads_proposals (expires_at) WHERE state IN ('open', 'drafting');

ALTER TABLE ads_proposals ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE ads_proposals IS
    'AI proposals (Ads A7): a drafted campaign or one change, applied as ads_ops only after a person approves it. Aggregates only. See migration_v55.';

-- ── The Mac's job kind ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_kind_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN (
    'scan_library', 'index_lesson', 'render_carousel',
    'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render',
    'monteur_think',
    'render_infographic',
    'ads_think'
));
