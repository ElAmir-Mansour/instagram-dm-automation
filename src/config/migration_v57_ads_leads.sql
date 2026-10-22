SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v57: Meta Ads Manager phase A10, lead ads (docs/specs/002-meta-ads-manager/data-model.md, research R16). Idempotent. Safe to re-run.
--
-- Lead ads are BUILT but LOCKED per tenant: nothing is written to these tables until the platform admin records a non-revoked `lead_ads`
-- row in `ads_legal_signoffs` (v56). Egypt's PDPL (compliance deadline 2026-11-01) and Saudi's PDPL apply to every row of ads_leads.
--
-- ads_lead_forms: the instant forms of the tenant's Page.
--   origin   app    made on the Leads tab (src/services/ads/leads.ts createLeadForm)
--            meta   found on the Page by the 6-hourly catch-up (made in Meta Ads Manager); only its id, name and locale are known
--   status   pending   the create was sent and not answered (a timeout): the catch-up looks the form up by name on the Page
--            active    Meta has it; leads are read from it
--            archived  archived at Meta (forms cannot be deleted, only archived)
--            failed    Meta refused the create; `error` says why
--   idempotency_key  one per "New form" dialog: a second submit of the same dialog returns the first row and never POSTs again
--   last_lead_seen_at  the newest lead's created_time: where the catch-up's `time_created > …` filter starts
--   caught_up_at       when the catch-up last read this form (it runs at most every 6 h per tenant)
--   No personal data.
--
-- ads_leads: one row per lead. PERSONAL DATA, so:
--   answers_enc   the lead's `field_data` as JSON, AES-256-GCM (src/config/crypto.ts encryptBytes: iv | tag | ciphertext) with the env-held
--                 TOKEN_ENCRYPTION_KEY. NULL once the retention period ends (`purged_at` set): the row stays as a count (date, form, ad).
--   person_keys   HMAC-SHA256 (crypto.ts personKey) of the normalised email and phone the person gave. It lets the data-erasure flow find a
--                 person's leads without decrypting every row, and is useless without the key. Emptied with the answers.
--   consent_contact  the person answered yes to the optional "may we contact you?" question. Nothing contacts a lead automatically.
--   retain_until  created_time + the tenant's retention days (`ads.settings.<t>.leadRetentionDays`, default 90) at the time it arrived;
--                 the daily sweep also honours a LOWER setting chosen later.
--   handed_to     none (always, today): no automated hand-off to the DM or WhatsApp agent exists.
--   received_via  webhook (the `leadgen` notification) or catchup (the 6-hourly backfill).
--   Never sent to an AI. Deleted by erasure (src/services/erasure.ts), by retention, and with the tenant (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS ads_lead_forms (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id         UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    meta_id            TEXT,
    page_id            TEXT NOT NULL,
    name               TEXT NOT NULL,
    origin             TEXT NOT NULL DEFAULT 'app' CHECK (origin IN ('app', 'meta')),
    locale             TEXT NOT NULL DEFAULT 'AR_AR',
    questions          JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array'),
    privacy_url        TEXT,
    thank_you          JSONB NOT NULL DEFAULT '{}'::jsonb,
    consent_question   BOOLEAN NOT NULL DEFAULT FALSE,
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'archived', 'failed')),
    error              TEXT,
    idempotency_key    TEXT UNIQUE,
    last_lead_seen_at  TIMESTAMPTZ,
    caught_up_at       TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ads_lead_forms_meta ON ads_lead_forms (meta_id) WHERE meta_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ads_lead_forms_creator ON ads_lead_forms (creator_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ads_leads (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id       UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    meta_lead_id     TEXT NOT NULL UNIQUE,
    form_id          UUID REFERENCES ads_lead_forms(id) ON DELETE SET NULL,
    form_meta_id     TEXT,
    ad_meta_id       TEXT,
    created_time     TIMESTAMPTZ NOT NULL,
    answers_enc      BYTEA,
    person_keys      TEXT[] NOT NULL DEFAULT '{}',
    consent_contact  BOOLEAN NOT NULL DEFAULT FALSE,
    retain_until     TIMESTAMPTZ NOT NULL,
    purged_at        TIMESTAMPTZ,
    handed_to        TEXT NOT NULL DEFAULT 'none' CHECK (handed_to IN ('none', 'dm', 'whatsapp')),
    received_via     TEXT NOT NULL DEFAULT 'webhook' CHECK (received_via IN ('webhook', 'catchup')),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ads_leads_creator ON ads_leads (creator_id, created_time DESC);
CREATE INDEX IF NOT EXISTS idx_ads_leads_retention ON ads_leads (retain_until) WHERE purged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ads_leads_person ON ads_leads USING GIN (person_keys);

ALTER TABLE ads_lead_forms ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads_leads ENABLE ROW LEVEL SECURITY;
