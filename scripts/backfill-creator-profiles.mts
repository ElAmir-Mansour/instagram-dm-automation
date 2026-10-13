/**
 * Backfill `creator_profiles`: store each tenant's profile as version 1, described from the settings it already has.
 * (docs/onboarding/01 §3, 05 §4; the logic is src/services/profile/backfill.ts.)
 *
 *   npm run profiles:backfill -- --env ../.env                 dry run, every tenant: nothing is written
 *   npm run profiles:backfill -- --env ../.env --tenant <uuid> one tenant
 *   npm run profiles:backfill -- --env ../.env --apply         write version 1 for every tenant that passes
 *
 * THE DRY RUN is the default, and it is read-only in the way scripts/lib/live.mjs guarantees: every statement runs in its
 * own `BEGIN READ ONLY … ROLLBACK`, and the database refuses a write. The application's own pool, which importing the
 * profile code builds from DATABASE_URL, is closed for the whole dry run (`forbidPool`: it throws on use) and opened only
 * by `--apply`, so no code path can reach production by any connection but that one. For each tenant it reads the LIVE
 * `studio_settings` and `growth_settings` rows, builds `profileFromLegacy` of them, validates it, and holds both lens
 * laws and the storage round trip against those rows (views.test.ts holds them on fixtures; this holds them on what is in
 * the database). It prints, per tenant, ok or the problems: paths, rules and lengths, never a value, a token or a settings row.
 *
 * `--apply` runs that same check first and writes only for a tenant that passes. One transaction per tenant on a normal
 * pool connection: a 5 s lock timeout, the tenant's lock, the rows read again under it and assessed again, then
 * `INSERT … ON CONFLICT (creator_id) DO NOTHING` and a version-1 history row (source `backfill`). A tenant that has a
 * stored profile is left alone. A tenant with NO settings rows at all gets the neutral `defaultProfile()` (Arabic, the default
 * content rules, no owner assumptions) instead of staying described as the owner (P16): stored with its two settings rows
 * mirrored, as a tenant created today is. The platform owner never does, and a tenant with only one of the two rows stays virtual.
 * It never overwrites a profile, and for a tenant that has settings rows it never touches them. Re-running it is a no-op. Run the dry run, read it, then `--apply`; then
 * `npm run profiles:parity` to prove no prompt moved.
 *
 * Exit: 0 every tenant is clean · 1 a tenant has a problem (or was refused or failed under --apply) · 2 usage, or the
 * script could not run (no DATABASE_URL, migration v33 not applied, no such tenant).
 *
 * `--env <path>` names the .env to read DATABASE_URL from; the default is the nearest one walking up from this checkout
 * (a worktree has none of its own).
 */
// @ts-ignore: plain ESM, no declaration file
import { connectReadOnly, describeDbTarget, loadEnv, parseArgs } from './lib/live.mjs';

const USAGE = `AutoReply Pro profile backfill. Dry run unless --apply.

  npm run profiles:backfill -- [options]

  --dry-run         check every tenant against the live rows; write nothing (the default)
  --apply           write version 1 for each tenant that passes the same check (and the neutral default for one with no settings)
  --tenant <uuid>   only this tenant
  --env <path>      .env to read DATABASE_URL from (default: the nearest one above this checkout)
  --help

To undo an --apply for a tenant ($1 = its id), in ONE transaction. It is only valid while the profile is still
version 1 (no save has been made since), and it is all --apply wrote for a tenant that had settings: no settings row is touched.
  DELETE FROM creator_profile_versions WHERE creator_id=$1 AND version=1 AND source='backfill'; DELETE FROM creator_profiles WHERE creator_id=$1 AND version=1
For a tenant the report says was CREATED as "the neutral default", --apply also inserted its two settings rows (it had none): delete those too.
  DELETE FROM studio_settings WHERE creator_id=$1; DELETE FROM growth_settings WHERE creator_id=$1

Exit: 0 clean · 1 problems · 2 usage or could not run.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN = new Set(['_', 'dry-run', 'apply', 'tenant', 'env', 'help', 'h']);

const stop = (message: string, code = 2): never => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

const args = parseArgs(process.argv.slice(2)) as Record<string, string | boolean | string[]>;
if (args.help || args.h) {
    console.log(USAGE);
    process.exit(0);
}
const unknown = Object.keys(args).filter((k) => !KNOWN.has(k));
if (unknown.length > 0) stop(`unknown option ${unknown.map((k) => `--${k}`).join(', ')}\n\n${USAGE}`);
if ((args._ as string[]).length > 0) stop(`unexpected argument "${(args._ as string[])[0]}"\n\n${USAGE}`);
if (args.apply && args['dry-run']) stop('--apply and --dry-run contradict each other: --apply already runs the dry run first.');
if (args.apply !== undefined && args.apply !== true) stop('--apply takes no value.');
if (args['dry-run'] !== undefined && args['dry-run'] !== true) stop('--dry-run takes no value.');
const only = args.tenant === undefined ? undefined : String(args.tenant).toLowerCase();
if (args.tenant !== undefined && (typeof args.tenant !== 'string' || !UUID.test(args.tenant))) stop('--tenant needs a tenant id (a uuid).');
if (args.env !== undefined && typeof args.env !== 'string') stop('--env needs a path.');
const apply = args.apply === true;

// The environment first: `config/db.ts` builds its pool from DATABASE_URL the moment it is imported, so nothing
// that reaches it may be imported before this runs. That is why the modules below are imported dynamically.
loadEnv(typeof args.env === 'string' ? args.env : null);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set. Pass --env <path-to-.env> or export it.');
const target = describeDbTarget(process.env.DATABASE_URL);

const { setLogSink } = await import('../src/utils/log.js');
// The report is this script's output; the app's own log lines (a missing-table warning, say) would only interleave with it.
setLogSink(() => {});
const { assessTenant, applyBackfill, formatBackfillReport, hasProblems, readTenants } = await import('../src/services/profile/backfill.js');
const { forbidPool } = await import('../src/services/profile/noDatabase.js');
type AppliedOutcome = import('../src/services/profile/backfill.js').AppliedOutcome;
type Exec = import('../src/services/studio/common.js').Exec;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);

// ─── 1. The dry run: read-only, always ──────────────────────────────────────────────────────

// Closed until --apply: the dry run reads through `connectReadOnly` and nothing may reach the pool by another way.
const reopenPool = forbidPool();

const db = await connectReadOnly('autoreply-profile-backfill').catch((err: unknown) => stop(`could not connect: ${message(err)}`));
const tenants = await (async () => {
    try {
        const tables = await db.query(`SELECT to_regclass('public.creator_profiles') AS profiles, to_regclass('public.creator_profile_versions') AS versions`);
        if (!tables.rows[0]?.profiles || !tables.rows[0]?.versions) return stop('The profile tables are missing: apply migration v33 first (npm run migrate).');
        return await readTenants(db as unknown as Exec, only);
    } catch (err) {
        return stop(`could not read the tenants: ${message(err)}`);
    } finally {
        await db.end().catch(() => undefined);
    }
})();
if (tenants.length === 0) stop(only ? `No tenant ${only}.` : 'The database has no tenants.');

const assessments = tenants.map(assessTenant);

// ─── 2. --apply: the same check, then a write for each tenant that passed ───────────────────

let outcomes: AppliedOutcome[] = [];
if (apply) {
    reopenPool();
    const { pool } = await import('../src/config/db.js');
    process.stderr.write(`applying to ${target}\n`);
    try {
        // The gate is applyBackfill's: only a tenant whose assessment above says apply is written.
        outcomes = await applyBackfill(assessments, undefined, (o) => {
            process.stderr.write(`  ${o.id}: ${o.status}${'reason' in o ? ` (${o.reason})` : ''}\n`);
        });
    } finally {
        await pool.end().catch(() => undefined);
    }
    if (outcomes.some((o) => o.status === 'created')) process.stderr.write('to undo a tenant, see the rollback SQL in --help\n');
}

console.log(formatBackfillReport(assessments, { mode: apply ? 'apply' : 'dry-run', target, outcomes }));
process.exitCode = hasProblems(assessments, outcomes) ? 1 : 0;
