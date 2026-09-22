#!/usr/bin/env node
/**
 * Migration runner with a ledger.
 *
 * Replaces run-migration.mjs and run-all-migrations.mjs, which hardcoded specific filenames,
 * recorded nothing, and — worse — caught their own errors and exited 0, so a failed migration
 * was indistinguishable from a successful one. That is how `interactions.platform` came to
 * exist in production while appearing in no migration file at all.
 *
 *   node --env-file=.env scripts/migrate.mjs            apply pending migrations
 *   node --env-file=.env scripts/migrate.mjs --status   show what would run
 *   node --env-file=.env scripts/migrate.mjs --baseline mark everything as applied, run nothing
 *
 * Ordering is by filename, so migrations must sort correctly. `schema.sql` is forced first.
 */
import pg from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

const CONFIG_DIR = 'src/config';
const args = new Set(process.argv.slice(2));

if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Try: node --env-file=.env scripts/migrate.mjs');
    process.exit(1);
}

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
});

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

function discover() {
    // Sort by the embedded version NUMBER, not lexically: plain .sort() puts
    // migration_v10 before migration_v3, which on a fresh database would ALTER tables
    // that do not exist yet.
    const version = (f) => {
        const m = f.match(/_v(\d+)/);
        return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
    };
    const rest = readdirSync(CONFIG_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort((a, b) => version(a) - version(b) || a.localeCompare(b));
    // The base schema must precede every ALTER that depends on it.
    return ['../../schema.sql', ...rest];
}

async function main() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            filename    TEXT PRIMARY KEY,
            checksum    TEXT NOT NULL,
            applied_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        )`);

    // Deny-by-default, immediately — this table is created here rather than by a
    // migration, which is exactly why migration_v11's RLS sweep never covered it
    // and Supabase flagged it as publicly accessible. On a fresh database the
    // ALTER in migration_v17 runs moments later anyway; this line is what stops
    // the gap existing at all, including for anyone who creates the ledger and
    // never gets as far as applying v17. Owners bypass RLS, so the runner below
    // is unaffected. Idempotent.
    await pool.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');

    const applied = new Map(
        (await pool.query('SELECT filename, checksum FROM schema_migrations')).rows
            .map((r) => [r.filename, r.checksum])
    );

    const files = discover();
    const pending = [];

    for (const rel of files) {
        const full = rel.startsWith('../../') ? rel.replace('../../', '') : path.join(CONFIG_DIR, rel);
        const name = path.basename(full);
        let sql;
        try { sql = readFileSync(full, 'utf8'); } catch { continue; }
        const sum = sha(sql);

        if (applied.has(name)) {
            if (applied.get(name) !== sum) {
                // Editing an applied migration means the ledger no longer describes the
                // database. Loud, because silently re-running it could be destructive.
                console.warn(`⚠️  ${name} changed since it was applied (ledger ${applied.get(name)}, file ${sum}). Not re-running.`);
            }
            continue;
        }
        pending.push({ name, full, sql, sum });
    }

    if (args.has('--status')) {
        console.log(`applied: ${applied.size}`);
        console.log(pending.length ? `pending:\n${pending.map((p) => '  ' + p.name).join('\n')}` : 'pending: none');
        return;
    }

    if (args.has('--baseline')) {
        for (const p of pending) {
            await pool.query(
                'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [p.name, p.sum]
            );
            console.log(`baselined (not run): ${p.name}`);
        }
        return;
    }

    if (!pending.length) { console.log('Nothing to apply.'); return; }

    for (const p of pending) {
        process.stdout.write(`applying ${p.name} ... `);
        const client = await pool.connect();
        try {
            // Each migration is its own transaction: a failure rolls that file back entirely
            // and stops the run, rather than leaving the schema half-changed.
            await client.query('BEGIN');
            await client.query(p.sql);
            await client.query(
                'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
                [p.name, p.sum]
            );
            await client.query('COMMIT');
            console.log('ok');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.log('FAILED');
            console.error(`\n${p.name} failed and was rolled back:\n  ${err.message}\n`);
            // Exit non-zero. The scripts this replaces swallowed errors and exited 0.
            process.exitCode = 1;
            return;
        } finally {
            client.release();
        }
    }
    console.log('\nAll migrations applied.');
}

main()
    .catch((e) => { console.error('Migration run failed:', e.message); process.exitCode = 1; })
    .finally(() => pool.end());
