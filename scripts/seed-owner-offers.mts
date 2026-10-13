/**
 * Seed the platform owner's offers: his nine campaign mappings become `course` offers with their `campaign` set.
 * (docs/onboarding/05 P13; the logic is src/services/profile/ownerOffers.ts.)
 *
 *   npx tsx --env-file=../.env scripts/seed-owner-offers.mts            dry run: reads the live profile, prints the diff, writes nothing
 *   npx tsx --env-file=../.env scripts/seed-owner-offers.mts --apply    the same checks, then ONE new profile version if they all pass
 *
 * WHY: the Campaigns screen's CSV import used to seed each course from a table of nine mappings inside the dashboard. It now
 * asks `GET /api/profile/campaign-seeds`, which reads a tenant's offers; until the owner's offers carry the nine, the API
 * answers them from a built-in copy (`legacyCourseMappings.ts`), for him alone. This script makes his stored profile carry them,
 * so the copy can go. His existing offer (the Agentic AI course, from the backfill) gets its campaign and is not duplicated;
 * the other eight are added as `course` offers ordered by message (the mappings hold no link: the import puts each course's own
 * coupon link into `{url}`).
 *
 * THE DRY RUN is the default, and it is read-only in the way scripts/lib/live.mjs guarantees: every statement runs in its own
 * `BEGIN READ ONLY … ROLLBACK`. The application's own pool, which importing the profile code builds from DATABASE_URL, is closed
 * for the whole dry run (`forbidPool`) and opened only by `--apply`, so nothing reaches production by another connection. It
 * prints one line per offer (the course's public title; never a link, a template or a setting), what the campaign seeds come to,
 * and the verdict.
 *
 * BEFORE IT SAVES, the plan must leave the owner's prompts exactly as they are, and the script refuses (exit 1, nothing written)
 * unless every one of these holds: the profile it makes is valid; every offer in it is a `course` (any other kind turns the DM
 * wording into «عروض» and the button into GO_TO_OFFER_1); his campaign seeds are exactly the nine, in order; his primary offer
 * is untouched; the views the save mirrors into the Studio and Growth rows are unchanged; and **every prompt builder the parity
 * script hashes builds the same text from the profile as it is and as it would be** (`tenantSurface`, compared with the parity
 * script's own `compareSurfaces`: one differing row refuses the save). A stored profile that needed repair, or was written by a
 * newer release, is refused too.
 *
 * `--apply` writes through `saveProfile`: one transaction, the version it read must still be the stored one (a profile that
 * changed since is a conflict, not an overwrite), source `backfill`, no user. It mirrors the unchanged views back and keeps a
 * history row. Re-running it afterwards finds the nine in place and does nothing. Then `npm run profiles:parity` proves it.
 *
 * To undo an --apply, in ONE transaction ($1 = the tenant's id, $2 = the version this wrote, which must still be the stored one,
 * so no save has been made since; nothing else was written: the views the save mirrors are unchanged, and the check above proves it):
 *   BEGIN;
 *   UPDATE creator_profiles SET profile = (SELECT profile FROM creator_profile_versions WHERE creator_id=$1 AND version=$2-1), version = $2-1 WHERE creator_id=$1 AND version=$2;
 *   DELETE FROM creator_profile_versions WHERE creator_id=$1 AND version=$2 AND source='backfill';
 *   COMMIT;
 * The campaign-seeds route then falls back to the owner's built-in nine, so the Campaigns import does not notice.
 *
 * Exit: 0 ready, applied, or nothing to do · 1 refused, or the save was refused (a conflict) · 2 usage, or could not run
 * (no DATABASE_URL, migration v33 not applied, no tenant).
 *
 * `--env <path>` names the .env to read DATABASE_URL from; the default is the nearest one walking up from this checkout
 * (a worktree has none of its own), and `node --env-file` works as well.
 */
// @ts-ignore: plain ESM, no declaration file
import { connectReadOnly, describeDbTarget, loadEnv, parseArgs } from './lib/live.mjs';

const USAGE = `AutoReply Pro: seed the owner's offers from his nine campaign mappings. Dry run unless --apply.

  npx tsx scripts/seed-owner-offers.mts [options]

  --dry-run         read the live profile, print the diff and every check; write nothing (the default)
  --apply           the same checks, then write one profile version if they all pass
  --env <path>      .env to read DATABASE_URL from (default: the nearest one above this checkout)
  --help

It refuses (exit 1) unless the owner's prompt surface is byte-identical before and after.

To undo an --apply ($1 = the tenant's id, $2 = the version it wrote), in ONE transaction. It is only valid while that version is
still the stored one (no save has been made since), and it is all --apply wrote: no settings row changes.
  UPDATE creator_profiles SET profile = (SELECT profile FROM creator_profile_versions WHERE creator_id=$1 AND version=$2-1), version = $2-1 WHERE creator_id=$1 AND version=$2; DELETE FROM creator_profile_versions WHERE creator_id=$1 AND version=$2 AND source='backfill'
Exit: 0 ready, applied or nothing to do · 1 refused · 2 usage or could not run.`;

const KNOWN = new Set(['_', 'dry-run', 'apply', 'env', 'help', 'h']);

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
if (args.env !== undefined && typeof args.env !== 'string') stop('--env needs a path.');
const apply = args.apply === true;

// The environment first: `config/db.ts` builds its pool from DATABASE_URL the moment it is imported, so nothing that
// reaches it may be imported before this runs. That is why the modules below are imported dynamically.
loadEnv(typeof args.env === 'string' ? args.env : null);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set. Pass --env <path-to-.env> or export it.');
const target = describeDbTarget(process.env.DATABASE_URL);

const { setLogSink } = await import('../src/utils/log.js');
// The report is this script's output; the app's own log lines would only interleave with it.
setLogSink(() => {});
const { readGrowthSettings } = await import('../src/services/growth/settingsRow.js');
const { readStudioSettings } = await import('../src/services/studio/settingsMerge.js');
const { loadProfile, ProfileError } = await import('../src/services/profile/store.js');
const { readAgent } = await import('../src/services/profile/parity.js');
const { applyOwnerOffers, assessOwnerOffers, formatOwnerOffers } = await import('../src/services/profile/ownerOffers.js');
const { forbidPool } = await import('../src/services/profile/noDatabase.js');
type Exec = import('../src/services/studio/common.js').Exec;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);

// ─── 1. The dry run: read-only, always ──────────────────────────────────────────────────────

// Closed until --apply: everything below reads through `connectReadOnly`, and nothing may reach the pool another way.
const reopenPool = forbidPool();

const db = await connectReadOnly('autoreply-seed-owner-offers').catch((err: unknown) => stop(`could not connect: ${message(err)}`));
let input;
let header;
let creatorId = '';
try {
    const exec = db as unknown as Exec;
    const tables = await db.query(`SELECT to_regclass('public.creator_profiles') AS profiles, to_regclass('public.creator_profile_versions') AS versions`);
    if (!tables.rows[0]?.profiles || !tables.rows[0]?.versions) stop('The profile tables are missing: apply migration v33 first (npm run migrate).');
    // The platform owner: the first creator ever made (`getPlatformOwnerId`). This script has no --tenant: the nine are his.
    const found = await db.query('SELECT id FROM creators ORDER BY created_at, id LIMIT 1');
    const id: string | undefined = found.rows[0]?.id;
    if (!id) stop('The database has no tenants.');
    creatorId = id!;
    const studio = await readStudioSettings(exec, creatorId);
    const growth = await readGrowthSettings(exec, creatorId);
    const loaded = await loadProfile(creatorId, exec);
    const agent = await readAgent(exec, creatorId);
    input = { studio, growth, profile: loaded.profile, version: loaded.version, agent, stored: loaded.version === null ? null : { repaired: loaded.repaired, newerSchema: loaded.newerSchema } };
    header = {
        tenant: creatorId,
        profile: loaded.version === null ? 'legacy (none stored: read from the rows)' : `stored v${loaded.version}`,
        target,
        mode: apply ? 'apply' : 'dry-run',
    } as const;
} catch (err) {
    stop(`could not read the tenant: ${message(err)}`);
} finally {
    await db.end().catch(() => undefined);
}

// What the plan does and every reason not to save it. A builder that throws is a refusal that names its row, not a crash.
const assessment = await assessOwnerOffers(input!).catch((err: unknown) => stop(`could not assess: ${message(err)}`));
console.log(formatOwnerOffers(assessment, header!));
if (assessment.status === 'refused') process.exit(1);

// ─── 2. --apply: the same assessment, then one save ─────────────────────────────────────────

if (apply && assessment.status === 'ready') {
    reopenPool();
    const { pool } = await import('../src/config/db.js');
    process.stderr.write(`applying to ${target}\n`);
    try {
        // The gate is applyOwnerOffers': only an assessment made in this run, whose status is ready, is written.
        const saved = await applyOwnerOffers(creatorId, assessment);
        console.log(`saved: profile version ${saved.version} (source backfill). Now: npm run profiles:parity (it must still print PARITY).`);
    } catch (err) {
        if (err instanceof ProfileError) {
            process.stderr.write(`refused by the store: ${err.code}: ${message(err)}\n`);
            process.exitCode = 1;
        } else {
            process.stderr.write(`could not save: ${message(err)}\n`);
            process.exitCode = 2;
        }
    } finally {
        await pool.end().catch(() => undefined);
    }
}
