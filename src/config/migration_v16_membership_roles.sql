-- Migration v16: give `memberships.role` a meaning.
--
-- The column has existed since v12 with `NOT NULL DEFAULT 'owner'`. It was stored, rendered on
-- the Users page and written into the audit log, and no authorization decision anywhere read
-- it: `assertTenantAccess` answered on membership EXISTENCE. Somebody granted as a "member"
-- could delete campaigns, rotate the Meta page access token and publish to the live account.
--
-- `src/services/tenant.ts` now enforces three tiers — owner > operator > viewer — and this
-- migration makes the stored values agree with that vocabulary.
--
-- ── Nothing here takes access away from anybody ──
-- This is the single most important property of this file, and it is the reason the UPDATE
-- below goes in the direction it does. Every row that exists today carries either 'owner' (the
-- default, and what every code path wrote) or 'member' (the only other value the old grant
-- form could produce). Both meant *full access*, because the column was decorative. Mapping
-- them to 'owner' therefore preserves exactly what those people can do today; it does not
-- promote anyone, it writes down what was already true.
--
-- The same reasoning runs through the application: `normalizeTenantRole` resolves any
-- unrecognised value to `owner`, so a row this migration has not reached yet — a database
-- behind its deployment — is not restricted either. Restriction is opt-in, chosen per
-- membership from the grant form, exactly as `match_mode` was introduced in v14.
--
-- Idempotent. Safe to re-run.

-- ── 1. Normalise the legacy vocabulary ─────────────────────────────────────────────────
--
-- Runs BEFORE the constraint, because the constraint would otherwise fail the whole migration
-- on the first 'member' row it met. Only touches rows outside the new vocabulary, so a
-- re-run — or a run after somebody has deliberately set a viewer — changes nothing.
UPDATE memberships
   SET role = 'owner'
 WHERE role IS NULL OR role NOT IN ('owner', 'operator', 'viewer');

-- ── 2. Pin the vocabulary ──────────────────────────────────────────────────────────────
--
-- Without this, a typo in a grant is stored happily and then resolves to `owner` at request
-- time — the fail-open default doing precisely the wrong thing for a value somebody meant to
-- be restrictive. The API validates the same list (`POST /api/admin/users/:id/memberships`),
-- and two places that must agree is one place too many unless the database is the backstop.
--
-- Guarded rather than a plain ADD CONSTRAINT: `IF NOT EXISTS` is not available for
-- constraints, and a bare ADD would fail the migration on a re-run. Same shape as
-- `campaigns_match_mode_check` in v14.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'memberships_role_check'
    ) THEN
        ALTER TABLE memberships
            ADD CONSTRAINT memberships_role_check
            CHECK (role IN ('owner', 'operator', 'viewer'));
    END IF;
END $$;

-- ── 3. Say what the column means, where the next person will look ──────────────────────
COMMENT ON COLUMN memberships.role IS
    'In-tenant role, enforced by requireTenantRole() in src/services/tenant.ts. '
    'owner: the Meta connection (page access token, webhook verify token). '
    'operator: campaigns, scheduled posts, the inbox, the AI agent. '
    'viewer: read only. Unrecognised values resolve to owner — see normalizeTenantRole.';
