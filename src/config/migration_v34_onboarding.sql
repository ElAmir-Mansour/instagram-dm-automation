-- Migration v34: tenant onboarding (docs/onboarding/02 §5, 03 §4-5, 06). Idempotent. Safe to re-run.
--
-- A tenant can now exist before it has a Meta connection. Until this file, `creators.instagram_page_id` and
-- `creators.page_access_token` were NOT NULL, so the only way to make a tenant was to hold its page id and a verified
-- page token, and the only person who could was the operator. From here the operator creates a tenant by NAME
-- (POST /api/admin/tenants { name, lang }), the tenant connects Meta later (v35, docs/onboarding/04), and everything that reads
-- those two columns treats a NULL as "not connected": skipped, never an error.
--
-- What this file adds, and which later PR uses it:
--   creators.instagram_username, website_url   the handle and site the operator typed (the draft's inputs, P24)
--   invites                                     the link a tenant opens to set a password (P17)
--   onboarding                                  where each tenant is in the wizard (P17, P18); EXISTING tenants are `completed`
--   profile_drafts                              what the AI read about a tenant, awaiting their confirmation (P24)
--   voice_examples                              the proof samples a tenant approved or edited (P25)
--   onboarding_events                           the funnel: enums and paths only, never field values (P31)
--   ai_usage                                    every provider call, for the budgets (P20c)
-- Nothing here is read by a request path yet except the `creators` columns above: the new tables only give those
-- features somewhere to live.
--
-- Every new table cascades from its tenant (a deleted tenant leaves nothing behind) and enables RLS in this same file
-- (migrations.test.ts fails otherwise). The app connects as owner and bypasses RLS; it shuts out a leaked anon key.

-- Locks `creators` (the webhook's hot table) for the two ALTERs and the CHECK's scan, and `users` for the FKs: fail in 5 s
-- rather than queue live requests behind a long query. LOCAL ends with the runner's per-file transaction, so nothing
-- sticks to a pooled connection.
SET LOCAL lock_timeout = '5s';

-- ─── 1. creators: the Meta connection becomes optional ───────────────────────────────────────

-- DROP NOT NULL is a no-op on a column that is already nullable. The UNIQUE constraint on instagram_page_id stays:
-- Postgres lets any number of rows hold NULL under it, and two tenants still cannot hold the same id.
ALTER TABLE creators ALTER COLUMN instagram_page_id DROP NOT NULL;
ALTER TABLE creators ALTER COLUMN page_access_token DROP NOT NULL;

-- A page id with no token is a tenant the webhook would resolve and then be unable to answer. The two travel together:
-- a connection sets the ids AND the token, a disconnect clears the ids AND the token. (A token with no ids is allowed:
-- a tenant that pasted its token first and has not been given its ids yet is just not routable.)
-- Guarded rather than a bare ADD CONSTRAINT, which has no IF NOT EXISTS and would fail a re-run. Every row that exists
-- today has a token (the column was NOT NULL), so the scan this takes cannot fail.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'creators_meta_ids_need_token' AND conrelid = 'creators'::regclass
    ) THEN
        ALTER TABLE creators
            ADD CONSTRAINT creators_meta_ids_need_token
            CHECK (page_access_token IS NOT NULL OR (instagram_page_id IS NULL AND facebook_page_id IS NULL));
    END IF;
END $$;

-- What the operator typed when creating the tenant by name. Not credentials, not unique: the draft reads them (P24).
ALTER TABLE creators ADD COLUMN IF NOT EXISTS instagram_username TEXT;
ALTER TABLE creators ADD COLUMN IF NOT EXISTS website_url TEXT;

COMMENT ON COLUMN creators.instagram_page_id IS
    'The Instagram business account id every Instagram webhook is routed by. NULL: no Meta connection (the tenant is skipped by the webhook, the publish sweep and the Growth sync).';
COMMENT ON COLUMN creators.page_access_token IS
    'enc:v1 page access token, read through src/services/tenant.ts. NULL: no Meta connection. creators_meta_ids_need_token forbids page ids without one.';

-- ─── 2. onboarding: where each tenant is, and who is already done ────────────────────────────

-- status: invited (created, link not used yet) → in_progress (the wizard has been opened) → completed. A tenant with no row
-- at all also reads as completed (D14), so a gate can never catch a tenant this file did not know about.
CREATE TABLE IF NOT EXISTS onboarding (
    creator_id   UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
    status       VARCHAR(20) NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'in_progress', 'completed')),
    current_step VARCHAR(30),
    -- Per step: { status, at, by } and the values autosaved before Continue. Never the profile itself.
    steps        JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Who filled the wizard in: the tenant, or the operator on their behalf.
    filled_by    VARCHAR(10) CHECK (filled_by IN ('tenant', 'admin')),
    started_at   TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Every tenant that exists now is onboarded already, the owner included (D14): the new gates are for tenants made from here on.
-- ON CONFLICT DO NOTHING: a re-run never turns a tenant onboarding has since begun back into a completed one.
INSERT INTO onboarding (creator_id, status, started_at, completed_at)
SELECT id, 'completed', created_at, created_at FROM creators
ON CONFLICT (creator_id) DO NOTHING;

-- ─── 3. invites: the link that replaces a typed password (D5) ────────────────────────────────

-- The raw token is 32 random bytes in the link's hash fragment and is never stored: only its sha256, like `hashWorkerToken`.
CREATE TABLE IF NOT EXISTS invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash      CHAR(64) NOT NULL UNIQUE,
    creator_id      UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- Who the link is for, when the operator knew. A link for one email is refused to anyone signed in as another.
    email           TEXT,
    membership_role VARCHAR(30) NOT NULL DEFAULT 'owner' CHECK (membership_role IN ('owner', 'operator', 'viewer')),
    -- join: a new person gets an account and a membership. reset: an existing person gets a new password.
    purpose         VARCHAR(10) NOT NULL DEFAULT 'join' CHECK (purpose IN ('join', 'reset')),
    -- A reset's person: the account whose password it replaces.
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMP WITH TIME ZONE NOT NULL,
    first_opened_at TIMESTAMP WITH TIME ZONE,
    open_count      INT NOT NULL DEFAULT 0,
    used_at         TIMESTAMP WITH TIME ZONE,
    used_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    revoked_at      TIMESTAMP WITH TIME ZONE
);
CREATE INDEX IF NOT EXISTS idx_invites_creator ON invites(creator_id, created_at DESC);

-- ─── 4. profile_drafts: what was read about a tenant, until a person confirms it (03 §4) ────

-- Scraped text lands HERE and only here. Agents read `creator_profiles`, which holds what a person confirmed with Continue.
CREATE TABLE IF NOT EXISTS profile_drafts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id      UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    origin          TEXT CHECK (origin IN ('admin_create', 'wizard', 'redraft')),
    requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    inputs          JSONB NOT NULL,
    inputs_hash     TEXT NOT NULL,
    prompt_version  TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'fetching', 'drafting', 'ready', 'failed', 'superseded')),
    attempts        INT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMP WITH TIME ZONE,
    lease_until     TIMESTAMP WITH TIME ZONE,
    lease_owner     TEXT,
    sources         JSONB,
    sources_status  JSONB,
    draft           JSONB,
    partial         BOOLEAN DEFAULT FALSE,
    usage           JSONB,
    error           TEXT,
    error_kind      TEXT,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    finished_at     TIMESTAMP WITH TIME ZONE
);
-- One draft in flight per tenant: a second `advance` finds the first instead of billing twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_drafts_one_active
    ON profile_drafts(creator_id) WHERE status IN ('queued', 'fetching', 'drafting');
CREATE INDEX IF NOT EXISTS idx_profile_drafts_creator ON profile_drafts(creator_id, created_at DESC);

-- ─── 5. voice_examples: the samples a tenant said "sounds like me" to (03 §5) ───────────────

CREATE TABLE IF NOT EXISTS voice_examples (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id          UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    profile_version     INT,
    kind                TEXT NOT NULL CHECK (kind IN ('dm_reply', 'caption', 'comment_dm', 'comment_public')),
    -- What the sample was written from (the post, the offer), and what the model wrote.
    input               JSONB NOT NULL DEFAULT '{}'::jsonb,
    model_output        TEXT NOT NULL,
    -- The tenant's own wording, when they edited it. NULL until there is a verdict.
    final_text          TEXT,
    -- NULL: shown, not judged yet. A rejected sample is never used in a prompt.
    verdict             TEXT CHECK (verdict IN ('approved', 'edited', 'rejected')),
    -- Who judged it. A sample the operator approves stays unused until the tenant confirms it (tenant_confirmed_at).
    verdict_by          TEXT CHECK (verdict_by IN ('tenant', 'admin')),
    tenant_confirmed_at TIMESTAMP WITH TIME ZONE,
    model               TEXT,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_voice_examples_creator ON voice_examples(creator_id, kind, created_at DESC);

-- ─── 6. onboarding_events: the funnel (02 §6) ────────────────────────────────────────────────

-- Enums and paths only, never a field's value. Kept 180 days (P31 prunes).
CREATE TABLE IF NOT EXISTS onboarding_events (
    id         BIGSERIAL PRIMARY KEY,
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    actor      TEXT NOT NULL CHECK (actor IN ('tenant', 'admin')),
    event      TEXT NOT NULL,
    step       TEXT,
    props      JSONB NOT NULL DEFAULT '{}'::jsonb,
    at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_events_creator ON onboarding_events(creator_id, at);
CREATE INDEX IF NOT EXISTS idx_onboarding_events_at ON onboarding_events(at);

-- ─── 7. ai_usage: every provider call, so a budget can refuse the next one (06) ─────────────

-- creator_id is NULL for spend that belongs to no tenant (an operator's key test).
CREATE TABLE IF NOT EXISTS ai_usage (
    id            BIGSERIAL PRIMARY KEY,
    creator_id    UUID REFERENCES creators(id) ON DELETE CASCADE,
    purpose       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    usd           NUMERIC(12, 6) NOT NULL DEFAULT 0,
    -- FALSE: the model had no price, so it was charged at the highest rate in the table.
    priced        BOOLEAN NOT NULL DEFAULT TRUE,
    -- ok, or the error kind (auth, quota, rate, bad_request, server, timeout, refusal, max_tokens, bad_output, budget, no_provider).
    outcome       TEXT NOT NULL DEFAULT 'ok',
    elapsed_ms    INT,
    at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_day ON ai_usage(at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_day ON ai_usage(creator_id, at);

-- Deny-by-default, like every other table since v11. The app connects as owner and bypasses it.
ALTER TABLE onboarding        ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites           ENABLE ROW LEVEL SECURITY;
ALTER TABLE profile_drafts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_examples    ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage          ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE onboarding IS
    'Where each tenant is in the onboarding wizard. A tenant with no row reads as completed (D14); every tenant that existed at v34 was inserted completed. See docs/onboarding/02.';
COMMENT ON TABLE invites IS
    'Single-use links (sha256 of a 32-byte token) that let a person set a password: purpose join (new account + membership) or reset.';
COMMENT ON TABLE profile_drafts IS
    'What the AI read about a tenant (bio, captions, site), awaiting their confirmation. No agent reads this table: agents read creator_profiles.';
COMMENT ON TABLE voice_examples IS
    'Proof samples a tenant approved, edited or rejected during onboarding; approved and edited ones become few-shot examples.';
COMMENT ON TABLE onboarding_events IS
    'The onboarding funnel: event names, steps and enum props only, never field values. Pruned at 180 days.';
COMMENT ON TABLE ai_usage IS
    'One row per AI provider call: tokens, USD and outcome. The daily budgets are sums over this table.';
