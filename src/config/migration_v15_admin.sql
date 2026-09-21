-- Migration v15: the administration surface.
--
-- Three unrelated additions, grouped because they all land with the same feature and all
-- default to today's behaviour. Nothing here changes what an existing row means.
--
-- Idempotent. Safe to re-run.

-- ─── 1. An audit trail for privileged actions ───────────────────────────────────────────
--
-- Until now nothing recorded who changed what. Every mutating admin action was a bare UPDATE
-- from a session that, on this deployment, is usually the shared DASHBOARD_PASSWORD — so the
-- question "who deactivated that tenant on Tuesday" had no answer anywhere, and the one
-- irreversible action in the product (data-subject erasure) was performed by hand in the SQL
-- editor with no record at all.
--
-- `detail` is JSONB rather than TEXT so an action can be reconstructed with SQL
-- (`detail->>'instagram_page_id'`) instead of being read as prose. It must never hold a
-- secret: the writers in src/services/audit.ts record *which* fields changed and the
-- non-sensitive values, never a token, password or connection string.
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    -- ON DELETE SET NULL, not CASCADE. Deleting a user must not delete the record of what
    -- that user did — that is precisely the record you want after an account is removed.
    -- `actor_email` is denormalised for the same reason: it survives the user row.
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT,

    -- Dotted, lowercase, machine-stable — the same convention as log events in
    -- src/utils/log.ts, and for the same reason: a filter written against a name should not
    -- break because somebody reworded a sentence.
    action VARCHAR(64) NOT NULL,

    target_type VARCHAR(32),
    -- TEXT rather than UUID: a target is sometimes a uuid (a creator, a user, a job) and
    -- sometimes not (a Meta page id, an erasure handle).
    target_id TEXT,

    detail JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- The only ordering this table is ever read in.
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);

-- "show me every erasure" / "every token write" — the second query the operator has.
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, created_at DESC);

-- v11 made RLS deny-by-default across public tables. The application connects as the table
-- owner and is unaffected; a new table left out would be the one hole in that shield. This
-- one holds actor emails, so it is at least as sensitive as `users`.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- ─── 2. Token expiry, persisted ─────────────────────────────────────────────────────────
--
-- `token_status` records *whether* the token works and `token_error` records why not, but
-- "this token dies in nine days" was only ever visible while the dashboard's token page was
-- open, because it came back live from `debug_token` and was thrown away. So the health
-- endpoint had nothing to read, and the two dates below — which are the two separate ways a
-- Meta token stops working — could not be shown anywhere without an outbound call per page
-- load.
--
-- Written by `recheckTenantToken` (src/services/tokenHealth.ts) and by every path that saves
-- a token. NULL means "never checked", which is honestly different from "never expires":
-- a never-expiring PAGE token reports expires_at = 0, and that is stored as NULL too, so
-- `token_status = 'valid'` with a NULL expiry is the expected healthy state and the dashboard
-- reads it as "does not expire".
ALTER TABLE creators ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP WITH TIME ZONE;

-- Separate from expiry and easy to miss: data access lapses 90 days after the user last
-- re-authorised, and when it does, reads start failing while the token still reports valid.
ALTER TABLE creators ADD COLUMN IF NOT EXISTS token_data_access_expires_at TIMESTAMP WITH TIME ZONE;

-- ─── 3. Repair: facebook_page_id was never actually unique ──────────────────────────────
--
-- v3 created `idx_creators_facebook_page` as a PLAIN index. v10 then ran
-- `CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_facebook_page`, which matched the existing
-- name and did nothing — so the "make that lookup provably unambiguous" comment in v10 has
-- been false since it was written. Verified against the live database: the index is there and
-- `indisunique` is false.
--
-- It matters now because `PATCH /api/admin/tenants/:id` can move a page id between tenants,
-- and `getCreatorByPageId` resolves a webhook with `ORDER BY created_at LIMIT 1` — so two
-- creators sharing a facebook_page_id means one tenant's Facebook events are silently
-- delivered to the other, with no error anywhere. `instagram_page_id` has a real UNIQUE
-- constraint from schema.sql and is unaffected.
--
-- The route also pre-checks for a conflicting creator and answers 409, so it does not depend
-- on this index existing — but the database should enforce it, because the route is not the
-- only thing that writes these columns.
DO $$
DECLARE
    duplicate_ids INT;
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_class c
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = 'idx_creators_facebook_page'
           AND NOT i.indisunique
    ) THEN
        SELECT count(*) INTO duplicate_ids FROM (
            SELECT facebook_page_id
              FROM creators
             WHERE facebook_page_id IS NOT NULL
             GROUP BY facebook_page_id
            HAVING count(*) > 1
        ) d;

        IF duplicate_ids > 0 THEN
            -- Do not fail the migration: duplicates are a data problem for an operator to
            -- resolve, and rolling back v15 over it would also withhold the audit table.
            -- The route's own pre-check still refuses to create a new conflict.
            RAISE NOTICE
                'creators.facebook_page_id has % duplicated value(s); leaving idx_creators_facebook_page non-unique. Resolve the duplicates and re-run this migration.',
                duplicate_ids;
        ELSE
            DROP INDEX idx_creators_facebook_page;
            CREATE UNIQUE INDEX idx_creators_facebook_page
                ON creators(facebook_page_id) WHERE facebook_page_id IS NOT NULL;
        END IF;
    END IF;
END $$;
