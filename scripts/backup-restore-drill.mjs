#!/usr/bin/env node
/**
 * The restore drill: proves the newest nightly backup can actually be turned back into a database.
 *
 * A backup nobody has restored is a hope. This downloads the newest object from the private R2 bucket that `.github/workflows/backup.yml`
 * fills, decrypts it with the owner's age PRIVATE key file, `pg_restore`s it into a SCRATCH database, and prints what is in it: how many
 * migrations the ledger holds and the newest one, and the row count of each main table. Run it once after the first backup, then every
 * few months, and after any change to the backup workflow (RUNBOOK "Backups").
 *
 *   node scripts/backup-restore-drill.mjs [--key daily/2026-11-27.dump.age] [--file ./local.dump.age] [--env <path to .env>]
 *
 *   SCRATCH_DATABASE_URL        REQUIRED. An empty database you can throw away: a second Supabase project (direct or session connection), or a
 *                               local PostgreSQL 17. NEVER production: see "Refuses" below.
 *   AGE_IDENTITY_FILE           REQUIRED. The age private key file (AGE-SECRET-KEY-1...). Read by `age` only; never printed, never copied.
 *   R2_BACKUP_ACCOUNT_ID, R2_BACKUP_ACCESS_KEY_ID, R2_BACKUP_SECRET_ACCESS_KEY, R2_BACKUP_BUCKET
 *                               the same four values as the workflow's secrets (a read-only token is enough). Not needed with --file.
 *   DATABASE_URL                the repo's .env is read (never overwriting the environment) so the production target is known.
 *   PRODUCTION_PROJECT_REF      optional: the Supabase project ref, as one more name to refuse.
 *
 * Needs on the Mac: age, pg_restore (PostgreSQL 17 client), and the aws CLI (`brew install awscli`) unless --file is given.
 *
 * Refuses to run (exit 2, before anything is downloaded) when the scratch URL equals DATABASE_URL or BACKUP_DATABASE_URL (same host, port and
 * database), contains a production project ref (taken from those URLs' hosts and users, or PRODUCTION_PROJECT_REF), or when no production
 * identifier is known at all (then it cannot tell, so it will not guess). It also refuses a scratch database that already has tables in `public`.
 *
 * What it never does: print a URL, a key or a password (only host/database of the scratch target), or write anywhere but a private temp folder
 * that it removes at the end (the decrypted dump lives there for the length of the restore).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { describeDbTarget, loadEnv, parseArgs } from './lib/live.mjs';

/** The tables whose row counts say "the data came back", in the order they are printed. Absent ones are listed as absent, not as an error. */
export const MAIN_TABLES = [
    'creators', 'users', 'memberships', 'campaigns', 'interactions', 'messages', 'conversations',
    'jobs', 'scheduled_posts', 'media_uploads', 'platform_connections', 'app_settings', 'ads_objects',
];

/** A Supabase project ref: 20 lowercase letters and digits. */
const REF = /[a-z0-9]{20}/g;

/** Every project ref a connection string names (the host `db.<ref>.supabase.co`, the pooler user `postgres.<ref>`), lowercased. */
export function projectRefs(url) {
    if (!url) return [];
    try {
        const u = new URL(url);
        const text = `${u.hostname} ${decodeURIComponent(u.username)}`.toLowerCase();
        return [...new Set(text.match(REF) ?? [])];
    } catch {
        return [];
    }
}

/** host:port/database, the identity of a connection ignoring user, password and options. */
export function targetKey(url) {
    try {
        const u = new URL(url);
        return `${u.hostname.toLowerCase()}:${u.port || '5432'}${u.pathname}`;
    } catch {
        return null;
    }
}

/**
 * Whether `scratchUrl` may be restored into. Returns `{ ok: true }` or `{ ok: false, reason }`; the reason names no secret.
 * `productionUrls` are the URLs of the live database (DATABASE_URL, BACKUP_DATABASE_URL); `productionRef` an extra ref to refuse.
 */
export function checkScratchTarget(scratchUrl, productionUrls = [], productionRef = '') {
    if (!scratchUrl) return { ok: false, reason: 'SCRATCH_DATABASE_URL is not set.' };
    const scratch = targetKey(scratchUrl);
    if (!scratch) return { ok: false, reason: 'SCRATCH_DATABASE_URL is not a connection URL.' };
    const prod = productionUrls.filter(Boolean);
    const refs = new Set(prod.flatMap(projectRefs));
    const extra = (productionRef ?? '').trim().toLowerCase();
    if (extra) refs.add(extra);
    if (prod.length === 0 && refs.size === 0) {
        return { ok: false, reason: 'No production database is known (DATABASE_URL, BACKUP_DATABASE_URL or PRODUCTION_PROJECT_REF), so it cannot tell scratch from production. Set one.' };
    }
    for (const url of prod) {
        if (targetKey(url) === scratch) return { ok: false, reason: 'The scratch URL points at the same host and database as a production URL.' };
    }
    const haystack = scratchUrl.toLowerCase();
    for (const ref of refs) {
        if (haystack.includes(ref)) return { ok: false, reason: 'The scratch URL names the production project.' };
    }
    return { ok: true };
}

/**
 * The error lines of pg_restore's stderr that mean something. `schema "public" already exists` is expected: the dump carries CREATE SCHEMA public
 * and every database already has one (Supabase's scratch project included), so it is skipped and everything after it still restores.
 */
export function hardRestoreErrors(stderr) {
    return String(stderr ?? '')
        .split('\n')
        .filter((line) => /\berror\b/i.test(line))
        .filter((line) => !/schema "public" already exists/i.test(line))
        // pg_restore's closing summary line, "errors ignored on restore: N", counts the benign one too.
        .filter((line) => !/errors ignored on restore/i.test(line));
}

/** The newest backup key out of `aws s3 ls` lines for the daily/ prefix (names sort by date). Null when there is none. */
export function newestBackupKey(listing, prefix = 'daily') {
    const names = String(listing)
        .split('\n')
        .map((line) => line.trim().split(/\s+/).pop() ?? '')
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.dump\.age$/.test(name))
        .sort();
    const last = names[names.length - 1];
    return last ? `${prefix}/${last}` : null;
}

// ─── The run ────────────────────────────────────────────────────────────────────────────────

function run(cmd, args, options = {}) {
    const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
    if (result.error) throw new Error(`${cmd} could not be started: ${result.error.message}. Is it installed?`);
    return result;
}

function need(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set.`);
    return value;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    loadEnv(typeof args.env === 'string' ? args.env : null);

    const scratchUrl = process.env.SCRATCH_DATABASE_URL;
    const verdict = checkScratchTarget(
        scratchUrl,
        [process.env.DATABASE_URL, process.env.BACKUP_DATABASE_URL],
        process.env.PRODUCTION_PROJECT_REF
    );
    if (!verdict.ok) {
        console.error(`REFUSED: ${verdict.reason}`);
        process.exit(2);
    }
    const identity = need('AGE_IDENTITY_FILE');
    if (!existsSync(identity)) throw new Error('AGE_IDENTITY_FILE does not exist.');
    console.log(`Scratch target: ${describeDbTarget(scratchUrl)}`);

    // The scratch database must be empty: restoring over data would blur what the drill proves.
    const probe = new pg.Client({ connectionString: scratchUrl, ssl: /localhost|127\.0\.0\.1/.test(scratchUrl) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    await probe.connect();
    try {
        const { rows } = await probe.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
        if (rows[0].n > 0) {
            console.error(`REFUSED: the scratch database already has ${rows[0].n} tables in public. Use an empty one (a fresh project, or a new local database).`);
            process.exit(2);
        }
    } finally {
        await probe.end();
    }

    const work = mkdtempSync(path.join(tmpdir(), 'autoreply-drill-'));
    try {
        let encrypted;
        if (typeof args.file === 'string') {
            encrypted = path.resolve(args.file);
            console.log('Using a local backup file.');
        } else {
            const env = {
                ...process.env,
                AWS_ACCESS_KEY_ID: need('R2_BACKUP_ACCESS_KEY_ID'),
                AWS_SECRET_ACCESS_KEY: need('R2_BACKUP_SECRET_ACCESS_KEY'),
                AWS_DEFAULT_REGION: 'auto',
            };
            const bucket = need('R2_BACKUP_BUCKET');
            const endpoint = `https://${need('R2_BACKUP_ACCOUNT_ID')}.r2.cloudflarestorage.com`;
            let key = typeof args.key === 'string' ? args.key : null;
            if (!key) {
                const listing = run('aws', ['--endpoint-url', endpoint, 's3', 'ls', `s3://${bucket}/daily/`], { env });
                if (listing.status !== 0) throw new Error('Listing the bucket failed (check the R2 values and that the aws CLI is installed).');
                key = newestBackupKey(listing.stdout);
                if (!key) throw new Error('The bucket has no backup under daily/.');
            }
            console.log(`Newest backup: ${key}`);
            encrypted = path.join(work, 'backup.dump.age');
            const get = run('aws', ['--endpoint-url', endpoint, 's3', 'cp', `s3://${bucket}/${key}`, encrypted, '--only-show-errors'], { env });
            if (get.status !== 0) throw new Error('Downloading the backup failed.');
        }
        console.log(`Encrypted size: ${statSync(encrypted).size} bytes`);

        const dump = path.join(work, 'backup.dump');
        const dec = run('age', ['--decrypt', '--identity', identity, '--output', dump, encrypted]);
        if (dec.status !== 0) throw new Error('Decryption failed: wrong private key, or the file is damaged.');

        const restore = run('pg_restore', ['--no-owner', '--no-privileges', '--dbname', scratchUrl, dump]);
        const errors = hardRestoreErrors(restore.stderr);
        if (errors.length > 0) {
            console.error(`pg_restore reported ${errors.length} error line(s). First ones:`);
            for (const line of errors.slice(0, 5)) console.error(`  ${line.slice(0, 200)}`);
            console.error('Counts below show how much came back anyway.');
        } else {
            console.log('pg_restore finished with no errors that matter.');
        }

        const db = new pg.Client({ connectionString: scratchUrl, ssl: /localhost|127\.0\.0\.1/.test(scratchUrl) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
        await db.connect();
        let failed = errors.length > 0;
        try {
            const exists = new Set((await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")).rows.map((r) => r.table_name));
            console.log('\nMigration ledger (schema_migrations):');
            if (exists.has('schema_migrations')) {
                const { rows } = await db.query('SELECT count(*)::int AS n, max(applied_at) AS at FROM schema_migrations');
                // The newest by version number (migration_v60_x.sql), not by name: "v9" sorts after "v60" as text.
                const newest = await db.query("SELECT filename FROM schema_migrations ORDER BY (substring(filename from 'v([0-9]+)'))::int DESC NULLS LAST, applied_at DESC LIMIT 1");
                console.log(`  ${rows[0].n} entries, newest file ${newest.rows[0]?.filename ?? '-'}, last applied ${rows[0].at ? new Date(rows[0].at).toISOString() : '-'}`);
                if (rows[0].n === 0) failed = true;
            } else {
                console.log('  MISSING: the ledger table did not come back.');
                failed = true;
            }
            console.log('\nRow counts:');
            for (const table of MAIN_TABLES) {
                if (!exists.has(table)) { console.log(`  ${table.padEnd(22)} (table absent)`); continue; }
                const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${table}"`);
                console.log(`  ${table.padEnd(22)} ${rows[0].n}`);
            }
            console.log(`\nTables restored in public: ${exists.size}`);
        } finally {
            await db.end();
        }
        console.log(failed ? '\nDRILL FAILED: read the lines above.' : '\nDRILL OK: the backup restores. Compare the counts with the live dashboard before trusting them.');
        process.exitCode = failed ? 1 : 0;
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((err) => {
        console.error(`Drill stopped: ${err.message}`);
        process.exit(1);
    });
}
