/**
 * The migrations this build of the code expects the database to have.
 *
 * Why a hand-written list and not `readdirSync('src/config')`: on Vercel the function bundle
 * is traced from `src/index.ts` through its imports, and nothing imports a `.sql` file — so
 * the migration files are not in the deployed bundle at all. A runtime `readdirSync` would
 * work locally, throw ENOENT in production, and the only surface that needs this answer is a
 * production dashboard. `scripts/diagnose.mjs` reads the directory instead, because it runs
 * from a checkout where the files exist.
 *
 * The cost of writing it down is drift, so `migrations.test.ts` asserts this array matches
 * `src/config/*.sql` on disk exactly, in this order. Add a migration without registering it
 * here and the test fails.
 *
 * Order matches `scripts/migrate.mjs`: `schema.sql` first, then by the embedded version
 * NUMBER — a plain lexical sort puts v10 before v3, which on a fresh database would ALTER
 * tables that do not exist yet.
 */
export const EXPECTED_MIGRATIONS: readonly string[] = [
    'schema.sql',
    'schema_migration_v2.sql',
    'migration_v3_facebook.sql',
    'migration_v4_campaign_active.sql',
    'migration_v5_indexes.sql',
    'migration_v6_scheduler.sql',
    'migration_v7_media_uploads.sql',
    'migration_v8_verify_token.sql',
    'migration_v9_cover_url.sql',
    'migration_v10_hardening.sql',
    'migration_v11_rls.sql',
    'migration_v12_tenancy.sql',
    'migration_v13_jobs.sql',
    'migration_v14_functionality.sql',
    'migration_v15_admin.sql',
    'migration_v16_membership_roles.sql',
    'migration_v17_ledger_rls.sql',
    'migration_v18_tiktok.sql',
    'migration_v19_tiktok_direct_post.sql',
    'migration_v20_carousel.sql',
    'migration_v21_studio.sql',
    'migration_v22_growth.sql',
] as const;

export interface SchemaState {
    /** How many of the expected migrations the ledger says have been applied. */
    applied: number;
    /** Expected migrations with no ledger row, in the order they must be applied. */
    pending: string[];
    /**
     * Ledger rows naming a file this build does not know about — a deployment rolled back
     * behind its database. Worth surfacing separately: it is not something to fix by running
     * a migration, and reporting it as "pending" would be actively misleading.
     */
    unknown: string[];
}

/**
 * Compare the ledger against what this build expects.
 *
 * Pure, so the interesting cases — a partially migrated database, a rollback, a ledger that
 * does not exist yet — are testable without one.
 */
export function compareSchema(appliedFilenames: readonly string[]): SchemaState {
    const applied = new Set(appliedFilenames);
    const expected = new Set(EXPECTED_MIGRATIONS);

    return {
        applied: EXPECTED_MIGRATIONS.filter((m) => applied.has(m)).length,
        pending: EXPECTED_MIGRATIONS.filter((m) => !applied.has(m)),
        unknown: appliedFilenames.filter((m) => !expected.has(m)),
    };
}
