/**
 * The two profile scripts (`backfill-creator-profiles.mts`, `prompt-parity.mts`): what can be proved without a database.
 *
 * Their logic is in src/services/profile/ and is tested there. What is here is the shell around it: that a mistyped flag
 * is refused rather than ignored (a run that quietly dropped `--aply` would be a dry run the operator took for a write,
 * and the reverse is worse), that nothing connects without a DATABASE_URL, and, by reading the source, that the
 * parity script has no way to write and the backfill script reaches the write path only behind `--apply`.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BACKFILL = path.join(ROOT, 'scripts', 'backfill-creator-profiles.mts');
const PARITY = path.join(ROOT, 'scripts', 'prompt-parity.mts');
const TENANT = '06026423-ad15-45d7-8d02-4bc122a6bcff';

/** Runs a script with no DATABASE_URL and an `.env` that does not exist, so it can reach nothing even by accident. */
async function script(file, args) {
    try {
        const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', file, ...args], {
            cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 60_000,
        });
        return { code: 0, stdout, stderr };
    } catch (err) {
        return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
}

const NOWHERE = ['--env', path.join(ROOT, 'does-not-exist', '.env')];

describe('the profile scripts refuse what they do not understand', () => {
    it('--help prints the usage and exits 0', async () => {
        const [a, b] = await Promise.all([script(BACKFILL, ['--help']), script(PARITY, ['--help'])]);
        assert.equal(a.code, 0);
        assert.match(a.stdout, /Dry run unless --apply/);
        assert.equal(b.code, 0);
        assert.match(b.stdout, /Read-only/);
    });

    it('a mistyped or stray option is an error (exit 2), never a quiet dry run', async () => {
        const runs = await Promise.all([
            script(BACKFILL, ['--aply', ...NOWHERE]),
            script(BACKFILL, ['--apply=yes', ...NOWHERE]),
            script(BACKFILL, ['apply', ...NOWHERE]),
            script(BACKFILL, ['--apply', '--dry-run', ...NOWHERE]),
            script(BACKFILL, ['--tenant', 'not-a-uuid', ...NOWHERE]),
            script(BACKFILL, ['--tenant', ...NOWHERE]),
            script(PARITY, ['--jsno', ...NOWHERE]),
            script(PARITY, ['--tenant', 'not-a-uuid', ...NOWHERE]),
            script(PARITY, ['--apply', ...NOWHERE]),
        ]);
        for (const r of runs) assert.equal(r.code, 2, `${r.stderr}${r.stdout}`);
        assert.match(runs[0].stderr, /unknown option --aply/);
        assert.match(runs[1].stderr, /--apply takes no value/);
        assert.match(runs[2].stderr, /unexpected argument "apply"/);
        assert.match(runs[3].stderr, /--apply and --dry-run contradict each other/);
        assert.match(runs[4].stderr, /--tenant needs a tenant id/);
        assert.match(runs[8].stderr, /unknown option --apply/, 'the parity script has no --apply at all');
        for (const r of runs) assert.equal(r.stdout.includes('profile backfill'), false, 'nothing was reported: nothing ran');
    });

    it('without a DATABASE_URL neither script connects to anything', async () => {
        const [a, b, c] = await Promise.all([
            script(BACKFILL, NOWHERE),
            script(BACKFILL, ['--apply', '--tenant', TENANT, ...NOWHERE]),
            script(PARITY, NOWHERE),
        ]);
        for (const r of [a, b, c]) {
            assert.equal(r.code, 2);
            assert.match(r.stderr, /DATABASE_URL is not set/);
            assert.equal(r.stdout, '');
        }
    });
});

describe('what the scripts can reach, by their source', () => {
    const backfill = readFileSync(BACKFILL, 'utf8');
    const parity = readFileSync(PARITY, 'utf8');
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('the parity script has no write path: no pool, no pg, no statement that changes anything', () => {
        const src = code(parity);
        assert.match(src, /connectReadOnly\(/);
        assert.doesNotMatch(src, /config\/db/, 'it never imports the pool');
        assert.doesNotMatch(src, /from 'pg'|require\('pg'\)|new pg\.|Pool\(/);
        assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/);
        assert.doesNotMatch(src, /backfillTenant|saveProfile/);
    });

    it('the backfill script reaches the pool and the write only inside `if (apply)`; everything before it is read-only', () => {
        const src = code(backfill);
        const gate = src.indexOf('if (apply) {');
        assert.ok(gate > 0, 'the write is behind --apply');
        const before = src.slice(0, gate);
        const after = src.slice(gate);
        assert.match(before, /connectReadOnly\(/);
        assert.doesNotMatch(before, /config\/db|backfillTenant\(|new pg\.|from 'pg'|Pool\(/, 'nothing before the gate can write');
        assert.match(after, /import\('\.\.\/src\/config\/db\.js'\)/);
        assert.match(after, /backfillTenant\(/);
        // The same check that gates the dry run gates the write: a tenant is written only when the decision says apply.
        assert.match(after, /decision\.action === 'apply'/);
        assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT)\b/, 'its own statements only read');
    });

    it('both set the environment before anything that builds the pool is imported', () => {
        for (const src of [backfill, parity]) {
            const env = src.indexOf('loadEnv(');
            const firstImport = src.indexOf("await import('../src/");
            assert.ok(env > 0 && firstImport > env, 'config/db.ts reads DATABASE_URL when it is imported');
            assert.doesNotMatch(src.slice(0, env), /^import .* from '\.\.\/src\//m, 'no static import of the app before the environment is loaded');
        }
    });
});
