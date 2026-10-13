-- Migration v33: the Creator Profile, one stored record per tenant (docs/onboarding/01 §3).
-- Idempotent. Safe to re-run.
--
-- `creator_profiles` is the source of truth for who a tenant is: name, language and register, what they
-- sell, their voice, their content rules, their brand. The Studio and Growth settings become views over
-- it (src/services/profile/views.ts), and `saveProfile` mirrors every write back into the existing
-- `studio_settings` / `growth_settings` rows in the same transaction, so rolling the code back never
-- strands data. Nothing reads this table yet: this migration and `src/services/profile/store.ts` only
-- give the profile somewhere to live, and no request path changes with them.
--
-- A tenant with no row is not an error: it reads as the profile its legacy settings describe
-- (`profileFromLegacy`), and the first save inserts version 1 from that.
--
-- It is its own table rather than a `studio_settings` section because the DM bot, Growth and the admin
-- surface all read it, it needs a version and a history, and a section would be fetched with the
-- Studio's few-shot examples (up to ~100 KB).

-- The FKs lock creators/users and the ALTERs take ACCESS EXCLUSIVE on four draft tables: fail in 5 s rather than queue live requests (LOCAL ends with the runner's per-file transaction, so nothing sticks to a pooled connection).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS creator_profiles (
    creator_id   UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
    profile      JSONB NOT NULL,
    -- Optimistic lock: a write says which version it read, and loses when another write got there first.
    version      INT NOT NULL DEFAULT 1,
    -- When the profile first held everything activation needs. Not set by the store; the wizard does.
    activated_at TIMESTAMP WITH TIME ZONE,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    -- 128 KB, measured on the text Postgres prints for the jsonb (src/services/profile/validate.ts profileBytes).
    CONSTRAINT creator_profiles_size CHECK (octet_length(profile::text) <= 131072)
);

-- Every version ever stored, and who wrote it. `source` is who made the change, not what it touched.
CREATE TABLE IF NOT EXISTS creator_profile_versions (
    creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    version    INT NOT NULL,
    profile    JSONB NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('backfill', 'wizard', 'user', 'admin')),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (creator_id, version)
);

-- The profile version a generated row was written under, so a draft can say which profile made it.
-- Nullable: every row that exists today, and every row written before a writer stamps it, has none.
ALTER TABLE carousel_drafts ADD COLUMN IF NOT EXISTS profile_version INT;
ALTER TABLE clip_drafts     ADD COLUMN IF NOT EXISTS profile_version INT;
ALTER TABLE infographics    ADD COLUMN IF NOT EXISTS profile_version INT;
ALTER TABLE studio_lessons  ADD COLUMN IF NOT EXISTS profile_version INT;

-- Deny-by-default, like every other table since v11. The app connects as owner and bypasses it.
ALTER TABLE creator_profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE creator_profile_versions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE creator_profiles IS
    'One Creator Profile per tenant: the source of truth the Studio and Growth settings are views over. See src/services/profile/ and docs/onboarding/01-profile-model.md.';
COMMENT ON TABLE creator_profile_versions IS
    'Every version of a creator_profiles row, with the source (backfill, wizard, user, admin) and the user who wrote it.';
