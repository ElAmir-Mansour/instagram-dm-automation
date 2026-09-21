-- Migration v11: enable Row Level Security, deny-by-default, on every public table.
-- Idempotent. Safe to re-run.
--
-- Nothing in schema.sql or any earlier migration has ever run ENABLE ROW LEVEL SECURITY or
-- CREATE POLICY, so every table is currently readable by any role that can reach the database.
-- That is latent only because no Supabase anon key has been published yet. The moment a
-- Supabase JS client appears in dashboard/ — a realtime inbox is the obvious next step — the
-- anon key ships to every browser that loads the page, and `creators.page_access_token` (still
-- stored in plaintext) becomes a public read. That is a direct path to the Meta tokens.
--
-- WHY THIS DOES NOT BREAK THE APP: RLS is not enforced against a table's owner. The service
-- connects over DATABASE_URL as the owner role that created these tables, so every query in
-- src/ is unaffected by this migration. Supabase's `anon` and `authenticated` roles are not
-- owners, so they are the ones this shuts out; `service_role` holds BYPASSRLS and is likewise
-- unaffected. Enabling RLS with no policies attached is the deny-everything default.
--
-- WHAT THIS IS NOT: this is a blast shield, not multi-tenancy. Real per-tenant isolation needs
-- (1) a dedicated non-owner role for the app to connect as, (2) FORCE ROW LEVEL SECURITY on
-- each table so even the owner is subject to policies, and (3) actual policies keyed on
-- creator_id from a verified session claim. Until the app stops resolving its tenant with
-- `SELECT id FROM creators WHERE is_active = true LIMIT 1`, there is no claim to key on.

-- IF EXISTS because rate_limit_counters and dm_send_log arrive with migration v10; this file
-- should apply cleanly whether or not that one has run yet.
ALTER TABLE IF EXISTS creators            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS campaigns           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS interactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS conversations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS ai_agents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS scheduled_posts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS media_uploads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS dm_send_log         ENABLE ROW LEVEL SECURITY;

-- No CREATE POLICY statements. That is the point: a table with RLS enabled and zero policies
-- returns no rows and accepts no writes for every role except its owner and BYPASSRLS roles.

-- Verification. Every row should read rowsecurity = true and policies = 0.
SELECT c.relname        AS table_name,
       c.relrowsecurity AS rowsecurity,
       c.relforcerowsecurity AS forced,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relkind = 'r'
 ORDER BY c.relname;
