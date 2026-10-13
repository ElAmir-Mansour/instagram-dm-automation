/**
 * Copy the owner's three built-in carousels into his own `studio_settings.examples`, marked `reference: true`.
 * (docs/onboarding/05 §2 "P9 · Studio writer" and §4 step 5; what to write is src/services/studio/ownerExamples.ts.)
 *
 *   npx tsx --env-file=../.env scripts/copy-owner-examples.mts            dry run: reads, prints, writes nothing
 *   npx tsx --env-file=../.env scripts/copy-owner-examples.mts --apply    write them
 *
 * WHY. His `examples` is NULL, so he has always been written for from the three built-in carousels (`examples.ts`), shown to the
 * model as "Reference carousels by another creator". P9 shows every other tenant no examples at all, and keeps showing him the
 * built-ins only until they are in his row; this puts them there, so the fallback can be removed (P14). `reference: true` keeps
 * the prompt's wording ("another creator's") exactly as it is, and the prompt prints each example with its keys in one fixed order
 * (`exampleJson`), so the order jsonb stores them in changes nothing. The dry run PROVES that: it builds his Studio system prompt
 * with the fallback (today's) and from the stored copy alone, and prints both hashes.
 *
 * THE DRY RUN is the default, and it is read-only in the way scripts/lib/live.mjs guarantees: every statement runs in its own
 * `BEGIN READ ONLY … ROLLBACK`, and the application's own pool (which importing the settings code builds from DATABASE_URL) is
 * closed for the whole dry run (`forbidPool`: it throws on use) and opened only by `--apply`.
 *
 * THE WRITE goes through the application's own settings writer, `updateStudioSettings`: `examples` is not a profile-owned path
 * (`STUDIO_PROFILE_PATHS` in profile/views.ts has no `examples`), so the profile and its versions are not touched, only the
 * Studio settings row. It runs in one transaction that holds the tenant's settings lock, re-reads the row under it, and writes
 * only if it still holds none (or already the three). A row that holds examples of its own is REFUSED, never overwritten.
 *
 * The tenant is the platform owner and nobody else: the first creator ever made (`getPlatformOwnerId`), because the built-ins are
 * his carousels.
 *
 * ORDER (05 §4): deploy P9 → run this (dry run, read it, `--apply`) → `npm run profiles:parity` shows his prompt unchanged →
 * deploy P14. To undo, in one statement (it only restores what the row held before: nothing):
 *   UPDATE studio_settings SET examples = NULL WHERE creator_id = '<his id>'
 *
 * Exit: 0 done, or a dry run that would copy · 1 refused (the row holds other examples) or the prompt would change · 2 usage,
 * or the script could not run. `--env <path>` names the .env to read when `--env-file` was not given.
 */
import { createHash } from 'node:crypto';
// @ts-ignore: plain ESM, no declaration file
import { connectReadOnly, describeDbTarget, loadEnv, parseArgs } from './lib/live.mjs';

const USAGE = `AutoReply Pro: copy the owner's built-in carousels into his own row. Dry run unless --apply.

  npx tsx --env-file=../.env scripts/copy-owner-examples.mts [options]

  --dry-run    read and print what would be copied; write nothing (the default)
  --apply      write the three carousels into his studio_settings.examples, marked reference: true
  --env <path> .env to read DATABASE_URL from when --env-file was not given (default: the nearest one above this checkout)
  --help

It refuses a row that already holds examples that are not these three. To undo an --apply:
  UPDATE studio_settings SET examples = NULL WHERE creator_id = '<his id>'

Exit: 0 done or would copy · 1 refused, or his prompt would change · 2 usage or could not run.`;

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
if (args.apply && args['dry-run']) stop('--apply and --dry-run contradict each other: --apply already shows the dry run first.');
if (args.apply !== undefined && args.apply !== true) stop('--apply takes no value.');
if (args['dry-run'] !== undefined && args['dry-run'] !== true) stop('--dry-run takes no value.');
if (args.env !== undefined && typeof args.env !== 'string') stop('--env needs a path.');
const apply = args.apply === true;

// The environment first: `config/db.ts` builds its pool from DATABASE_URL the moment it is imported, so nothing that reaches it
// may be imported before this runs. That is why the modules below are imported dynamically.
loadEnv(typeof args.env === 'string' ? args.env : null);
if (!process.env.DATABASE_URL) stop('DATABASE_URL is not set. Pass --env-file, --env <path-to-.env>, or export it.');
const target = describeDbTarget(process.env.DATABASE_URL);

const { setLogSink } = await import('../src/utils/log.js');
// The report is this script's output; the app's own log lines would only interleave with it.
setLogSink(() => {});
const { contextFor } = await import('../src/services/profile/context.js');
const { throughJsonb } = await import('../src/services/profile/jsonb.js');
const { forbidPool } = await import('../src/services/profile/noDatabase.js');
const { loadProfile } = await import('../src/services/profile/store.js');
const { studioView } = await import('../src/services/profile/views.js');
const { ownerExamples, planOwnerExamples } = await import('../src/services/studio/ownerExamples.js');
const { buildSystemPrompt } = await import('../src/services/studio/prompts.js');
const { readStudioSettings } = await import('../src/services/studio/settingsMerge.js');
type Exec = import('../src/services/studio/common.js').Exec;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200);
const sha = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);

// ─── 1. Read: always read-only ──────────────────────────────────────────────────────────────

// Closed until --apply: everything below reads through `connectReadOnly`, and nothing may reach the pool by another way.
const reopenPool = forbidPool();

const db = await connectReadOnly('autoreply-copy-owner-examples').catch((err: unknown) => stop(`could not connect: ${message(err)}`));
let read;
try {
    const exec = db as unknown as Exec;
    // The statement `getPlatformOwnerId` runs (tenant.ts): the owner is the first creator ever made, active or not.
    const found = await db.query('SELECT id FROM creators ORDER BY created_at, id LIMIT 1');
    const id: string | undefined = found.rows[0]?.id;
    if (!id) stop('The database has no tenants.');
    const row = await readStudioSettings(exec, id!);
    const loaded = await loadProfile(id!, exec);
    read = { id: id!, row, loaded };
} catch (err) {
    stop(`could not read the owner: ${message(err)}`);
} finally {
    await db.end().catch(() => undefined);
}
const { id, row, loaded } = read!;

// ─── 2. What would change, and the proof that his prompt does not ───────────────────────────

const plan = planOwnerExamples(row.examples);
const wanted = ownerExamples();

// His Studio settings as `getStudioSettings` returns them (the row, with the profile's fields over it) and his `carousel` context.
const settings = studioView(row, loaded.profile);
const wording = { ...contextFor(loaded.profile, 'carousel', loaded.version), builtInExamples: true };
// Today: his row has none, so the built-ins are shown by the fallback. After: the copy alone, as the database would hand it back
// (jsonb reorders keys), with the fallback off. They must be the same text, or P14 would move his prompt.
const today = buildSystemPrompt({ ...settings, examples: null }, wording);
const copied = buildSystemPrompt({ ...settings, examples: throughJsonb(wanted) }, { ...wording, builtInExamples: false });
const identical = today === copied;

const lines = [
    `copy owner examples · ${apply ? 'apply' : 'dry run'} · ${target}`,
    `tenant        ${id} (the platform owner: the first creator ever made)`,
    `profile       ${loaded.version === null ? 'legacy (none stored: read from the rows)' : `stored v${loaded.version}`}`,
    `his row       examples: ${row.examples === null ? 'none (NULL)' : `${row.examples.length} stored`}`,
    `to copy       ${wanted.length} carousels, reference: true (${wanted.map((c) => c.id).join(', ')})`,
    `plan          ${plan.action === 'copy' ? 'copy them' : plan.action === 'done' ? 'nothing to do: his row already holds exactly these three' : `REFUSED: ${plan.reason}`}`,
    `his Studio system prompt, today (the built-in fallback)   sha256 ${sha(today)}  ${today.length} characters`,
    `his Studio system prompt, from the copy alone             sha256 ${sha(copied)}  ${copied.length} characters  ${identical ? 'identical' : 'DIFFERENT'}`,
];
console.log(lines.join('\n'));

if (!identical) stop('\nThe prompt would change: the copy is not byte for byte what the fallback shows. Nothing was written.', 1);
if (plan.action === 'refuse') stop('\nNothing was written.', 1);
if (plan.action === 'done') process.exit(0);
if (!apply) {
    console.log('\nDRY RUN: nothing was written. Read the plan above, then run again with --apply.');
    process.exit(0);
}

// ─── 3. --apply: the application's own writer, one transaction, the tenant's lock ───────────

reopenPool();
const { pool } = await import('../src/config/db.js');
const { lockTenantSettings, withTransaction } = await import('../src/services/studio/common.js');
const { updateStudioSettings } = await import('../src/services/studio/settings.js');
process.stderr.write(`applying to ${target}\n`);
try {
    const outcome = await withTransaction(async (tx) => {
        // The lock first, then the row under it: a save that landed since the dry run is seen, not overwritten.
        await lockTenantSettings(tx, id);
        const again = planOwnerExamples((await readStudioSettings(tx, id, true)).examples);
        if (again.action !== 'copy') return again;
        // `examples` is replaced whole and validated with the rest of the settings (`reference` must be a boolean).
        await updateStudioSettings(id, { examples: wanted }, tx);
        return again;
    });
    if (outcome.action === 'copy') console.log(`\nwrote ${wanted.length} examples into the Studio settings of ${id}.\nNext: npm run profiles:parity (his prompt must be unchanged), then deploy P14.`);
    else if (outcome.action === 'done') console.log('\nnothing to do: his row already holds exactly these three.');
    else stop(`\nREFUSED under the lock: ${outcome.reason}. Nothing was written.`, 1);
} catch (err) {
    stop(`\nnot written: ${message(err)}`);
} finally {
    await pool.end().catch(() => undefined);
}
