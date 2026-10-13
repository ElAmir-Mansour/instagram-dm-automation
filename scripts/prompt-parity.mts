/**
 * Prompt parity for one tenant, against the LIVE database, read-only. (docs/onboarding/05 §4; the logic is
 * src/services/profile/parity.ts and the builders are src/services/profile/promptSurface.ts, the ones the golden tests pin.)
 *
 *   npm run profiles:parity -- --env ../.env                   the active tenant
 *   npm run profiles:parity -- --env ../.env --tenant <uuid>
 *   npm run profiles:parity -- --env ../.env --json            machine-readable, full hashes
 *
 * It reads the tenant's Studio and Growth rows and its profile (the stored one, else the one the rows describe) through
 * `connectReadOnly`, then builds every prompt twice, and prints
 *
 *   name  sha256(a)  sha256(b)  match
 *
 * (a) is the builders handed the settings as stored, today's path; (b) is the same builders handed
 * `studioView(stored, profile)` and `growthView(stored, profile)`. They must be equal for every builder: that is what lets a
 * reader move to the profile without a prompt moving. Exit 1 if any differs.
 *
 * THE PER-DEPLOY CHECK is to run it on `main` and again on the release branch, then diff the two outputs. Nothing in the
 * output depends on the clock or the machine, so any difference is a prompt that moved.
 *
 *   (on main)     npm run --silent profiles:parity -- --env … > /tmp/parity.main.txt
 *   (on release)  npm run --silent profiles:parity -- --env … > /tmp/parity.release.txt
 *   diff /tmp/parity.main.txt /tmp/parity.release.txt
 *
 * Only names, hashes and (for a difference) a line and column are printed: a prompt holds the tenant's guide, links and
 * offers, and none of it leaves this process. No database write is possible, and the Growth builders run against a stand-in
 * for the pool, never a connection.
 *
 * Exit: 0 parity · 1 a builder differs · 2 usage, or the script could not run.
 */
// @ts-ignore: plain ESM, no declaration file
import { connectReadOnly, describeDbTarget, loadEnv, parseArgs } from './lib/live.mjs';

const USAGE = `AutoReply Pro prompt parity. Read-only.

  npm run profiles:parity -- [options]

  --tenant <uuid>   the tenant to check (default: the first active one)
  --json            machine-readable output, full hashes
  --env <path>      .env to read DATABASE_URL from (default: the nearest one above this checkout)
  --help

Exit: 0 parity · 1 a builder differs · 2 usage or could not run.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN = new Set(['_', 'tenant', 'json', 'env', 'help', 'h']);

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
if (args.json !== undefined && args.json !== true) stop('--json takes no value.');
if (args.tenant !== undefined && (typeof args.tenant !== 'string' || !UUID.test(args.tenant))) stop('--tenant needs a tenant id (a uuid).');
if (args.env !== undefined && typeof args.env !== 'string') stop('--env needs a path.');

// The environment first: `config/db.ts` builds its pool from DATABASE_URL the moment it is imported (see
// backfill-creator-profiles.mts), so everything that reaches it is imported after this.
loadEnv(typeof args.env === 'string' ? args.env : null);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set. Pass --env <path-to-.env> or export it.');
const target = describeDbTarget(process.env.DATABASE_URL);

const { setLogSink } = await import('../src/utils/log.js');
// Output is diffed between branches: the app's own log lines must not be in it.
setLogSink(() => {});
const { readGrowthSettings } = await import('../src/services/growth/settingsRow.js');
const { readStudioSettings } = await import('../src/services/studio/settingsMerge.js');
const { loadProfile } = await import('../src/services/profile/store.js');
const { formatParity, parityJson, runParity } = await import('../src/services/profile/parity.js');
type Exec = import('../src/services/studio/common.js').Exec;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);

const db = await connectReadOnly('autoreply-prompt-parity').catch((err: unknown) => stop(`could not connect: ${message(err)}`));
let input;
let header;
try {
    const exec = db as unknown as Exec;
    const found = args.tenant === undefined
        ? await db.query('SELECT id FROM creators ORDER BY (is_active IS NOT FALSE) DESC, created_at, id LIMIT 1')
        : await db.query('SELECT id FROM creators WHERE id = $1', [String(args.tenant).toLowerCase()]);
    const id: string | undefined = found.rows[0]?.id;
    if (!id) stop(args.tenant === undefined ? 'The database has no tenants.' : `No tenant ${args.tenant}.`);

    const studio = await readStudioSettings(exec, id!);
    const growth = await readGrowthSettings(exec, id!);
    const loaded = await loadProfile(id!, exec);
    input = { studio, growth, profile: loaded.profile };
    const state = loaded.version === null ? 'legacy (none stored: read from the rows)' : `stored v${loaded.version}`;
    const notes = [...loaded.repaired.map((p: string) => `repaired ${p}`), ...(loaded.newerSchema ? ['newer schema'] : [])];
    header = { tenant: id!, profile: notes.length ? `${state}, ${notes.join(', ')}` : state, target };
} catch (err) {
    stop(`could not read the tenant: ${message(err)}`);
} finally {
    await db.end().catch(() => undefined);
}

const report = await runParity(input!);
console.log(args.json ? parityJson(report, header!) : formatParity(report, header!));
process.exitCode = report.ok ? 0 : 1;
