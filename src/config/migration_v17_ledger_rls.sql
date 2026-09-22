-- Migration v17: the migration ledger itself was the one table without RLS.
--
-- Supabase flagged `schema_migrations` as publicly accessible on 2026-09-22.
-- Verified before writing this: of the 16 tables in `public`, fifteen have
-- `relrowsecurity = true` with zero policies — deny-by-default, exactly as
-- `migration_v11_rls.sql` intended. `schema_migrations` was the only one off.
--
-- It was missed because it is the one table NOT created by a migration:
-- `scripts/migrate.mjs` creates it before it runs anything, so v11's sweep
-- never saw it. That script is fixed in the same commit, otherwise a fresh
-- deployment reintroduces the hole on its first `npm run migrate`.
--
-- ── Why it mattered, measured rather than assumed ──
-- `anon` and `authenticated` hold DELETE, INSERT, SELECT, UPDATE and TRUNCATE
-- on this table — the same grants they hold on `creators`. On `creators` those
-- grants are unreachable because RLS is on with no policy to allow anything.
-- Here they were live to anyone with the project URL and the anon key, which is
-- public by design.
--
-- The read is minor: sixteen migration filenames. The WRITE is not. Inserting a
-- row for a migration that has not run makes the runner treat it as applied and
-- SKIP it — so a future security migration could silently never execute, while
-- `migrate:status` reports a clean ledger. TRUNCATE would discard the checksums
-- that detect a migration file changing after it ran.
--
-- The app connects as the table owner and owners bypass RLS, so this changes
-- nothing about how the runner reads or writes the ledger. Idempotent.
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE schema_migrations IS
    'Migration ledger, written by scripts/migrate.mjs. RLS on with no policies: '
    'the app connects as owner and bypasses it, while anon/authenticated are '
    'denied despite holding table grants. See migration_v17_ledger_rls.sql.';
