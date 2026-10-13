/**
 * The profile scripts (`backfill-creator-profiles.mts`, `prompt-parity.mts`, `seed-owner-offers.mts`): what can be proved without a database.
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
const SEED = path.join(ROOT, 'scripts', 'seed-owner-offers.mts');
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
    /** The code alone: no comments, and not the usage text (which prints the rollback SQL, and is not a statement the script runs). */
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/const USAGE = `[\s\S]*?`;/, '');
    const count = (src, pattern) => (src.match(pattern) ?? []).length;

    // What the parity script cannot do is not "it never imports the pool": importing the profile code builds the real pool from
    // DATABASE_URL anyway. It is that the pool is closed for the whole run (noDatabase.test.ts proves what that does), before
    // anything is read, and never reopened. That is what is pinned here.
    it('the parity script closes the application pool before it connects, reads or compares, and never reopens it', () => {
        const src = code(parity);
        const forbid = src.indexOf('forbidPool(');
        const connect = src.indexOf('connectReadOnly(');
        const loads = src.indexOf('loadProfile(');
        const run = src.indexOf('runParity(');
        assert.ok(forbid > 0, 'it calls forbidPool');
        assert.ok(forbid < connect && connect < loads && loads < run, 'forbidPool, then connect, then read, then compare');
        assert.equal(count(src, /forbidPool\(/g), 1);
        assert.match(src, /^forbidPool\(\);$/m, 'called as a statement: the function that would reopen the pool is thrown away');
        assert.doesNotMatch(src, /config\/db|reopen/, 'the script neither imports the pool nor reopens it');
        assert.match(src, /connectReadOnly\(/);
        assert.doesNotMatch(src, /from 'pg'|require\('pg'\)|new pg\.|new Pool\(/);
        assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b/);
        assert.doesNotMatch(src, /backfillTenant|applyBackfill|saveProfile/);
    });

    it('the backfill script closes the pool for the dry run and reaches the pool and the write only inside `if (apply)`', () => {
        const src = code(backfill);
        const gate = src.indexOf('if (apply) {');
        assert.ok(gate > 0, 'the write is behind --apply');
        const before = src.slice(0, gate);
        const after = src.slice(gate);
        assert.ok(before.indexOf('forbidPool(') > 0 && before.indexOf('forbidPool(') < before.indexOf('connectReadOnly('), 'the pool is closed before the dry run connects');
        assert.match(before, /const reopenPool = forbidPool\(\);/);
        assert.doesNotMatch(before, /reopenPool\(\)/, 'and not reopened before the gate');
        assert.doesNotMatch(before, /config\/db|backfillTenant\(|applyBackfill\(|new pg\.|from 'pg'|new Pool\(/, 'nothing before the gate can write');
        assert.match(after, /reopenPool\(\)/);
        assert.match(after, /import\('\.\.\/src\/config\/db\.js'\)/);
        // The write loop's gate is backfill.ts's applyBackfill, unit-tested there: the script only calls it, and only here.
        assert.equal(count(src, /applyBackfill\(/g), 1);
        assert.match(after, /applyBackfill\(/);
        assert.doesNotMatch(src, /backfillTenant\(/, 'the script cannot write a tenant except through the gate');
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

describe('--apply says how to undo it', () => {
    it('the help prints the rollback SQL, for one tenant, in one transaction, and says when it is valid', async () => {
        const { stdout } = await script(BACKFILL, ['--help']);
        assert.ok(
            stdout.includes("DELETE FROM creator_profile_versions WHERE creator_id=$1 AND version=1 AND source='backfill'; DELETE FROM creator_profiles WHERE creator_id=$1 AND version=1"),
            stdout
        );
        assert.match(stdout, /ONE transaction/);
        assert.match(stdout, /only valid while the profile is still\s+version 1/);
    });
});

// ─── seed-owner-offers.mts (P13) ───────────────────────────────────────────────────────────────

describe('seed-owner-offers refuses what it does not understand', () => {
    it('--help prints the usage, says it refuses unless the prompt surface is identical, and prints the rollback', async () => {
        const { code, stdout } = await script(SEED, ['--help']);
        assert.equal(code, 0);
        assert.match(stdout, /Dry run unless --apply/);
        assert.match(stdout, /refuses \(exit 1\) unless the owner's prompt surface is byte-identical before and after/);
        assert.match(stdout, /ONE transaction/);
        assert.ok(stdout.includes("DELETE FROM creator_profile_versions WHERE creator_id=$1 AND version=$2 AND source='backfill'"), stdout);
    });

    it('a mistyped or stray option is an error (exit 2), never a quiet dry run, and there is no --tenant: the nine are his', async () => {
        const runs = await Promise.all([
            script(SEED, ['--aply', ...NOWHERE]),
            script(SEED, ['--apply=yes', ...NOWHERE]),
            script(SEED, ['apply', ...NOWHERE]),
            script(SEED, ['--apply', '--dry-run', ...NOWHERE]),
            script(SEED, ['--tenant', TENANT, ...NOWHERE]),
        ]);
        for (const r of runs) assert.equal(r.code, 2, `${r.stderr}${r.stdout}`);
        assert.match(runs[0].stderr, /unknown option --aply/);
        assert.match(runs[1].stderr, /--apply takes no value/);
        assert.match(runs[2].stderr, /unexpected argument "apply"/);
        assert.match(runs[3].stderr, /--apply and --dry-run contradict each other/);
        assert.match(runs[4].stderr, /unknown option --tenant/);
        for (const r of runs) assert.equal(r.stdout.includes('seed owner offers'), false, 'nothing was reported: nothing ran');
    });

    it('without a DATABASE_URL it connects to nothing, with or without --apply', async () => {
        for (const args of [NOWHERE, ['--apply', ...NOWHERE]]) {
            const r = await script(SEED, args);
            assert.equal(r.code, 2);
            assert.match(r.stderr, /DATABASE_URL is not set/);
            assert.equal(r.stdout, '');
        }
    });
});

describe('what seed-owner-offers can reach, by its source', () => {
    const seed = readFileSync(SEED, 'utf8');
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/const USAGE = `[\s\S]*?`;/, '');
    const count = (src, pattern) => (src.match(pattern) ?? []).length;

    it('closes the application pool before it connects, reads or assesses, and reopens it only behind the apply gate', () => {
        const src = code(seed);
        const forbid = src.indexOf('forbidPool(');
        const connect = src.indexOf('connectReadOnly(');
        const read = src.indexOf('loadProfile(');
        const assess = src.indexOf('assessOwnerOffers(');
        assert.ok(forbid > 0 && forbid < connect && connect < read && read < assess, 'forbidPool, then connect, then read, then assess');
        assert.match(src, /const reopenPool = forbidPool\(\);/);
        const gate = src.indexOf('if (apply && assessment.status ===');
        assert.ok(gate > assess, 'the write is behind --apply, after the assessment');
        assert.doesNotMatch(src.slice(0, gate), /reopenPool\(\)|config\/db|applyOwnerOffers\(|saveProfile|from 'pg'|new pg\.|new Pool\(/, 'nothing before the gate can write');
    });

    it('a refused assessment exits 1 before the apply gate is reached: the refusal is not skippable', () => {
        const src = code(seed);
        const refused = src.indexOf("if (assessment.status === 'refused') process.exit(1);");
        assert.ok(refused > 0, 'a refusal exits 1');
        assert.ok(refused < src.indexOf('if (apply && assessment.status ==='), 'and before the apply gate');
        assert.match(src, /if \(apply && assessment\.status === 'ready'\) \{/, 'only a ready assessment is applied: an unchanged one writes nothing');
    });

    it('writes only through applyOwnerOffers, once, inside the gate, and sends no statement of its own', () => {
        const src = code(seed);
        assert.equal(count(src, /applyOwnerOffers\(/g), 1);
        assert.match(src.slice(src.indexOf('if (apply && assessment.status ===')), /applyOwnerOffers\(creatorId, assessment\)/);
        assert.doesNotMatch(src, /saveProfile\(/, 'the store is reached through the gate, not directly');
        assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT)\b/, 'its own statements only read');
    });

    it('sets the environment before anything that builds the pool is imported', () => {
        const env = seed.indexOf('loadEnv(');
        const firstImport = seed.indexOf("await import('../src/");
        assert.ok(env > 0 && firstImport > env, 'config/db.ts reads DATABASE_URL when it is imported');
        assert.doesNotMatch(seed.slice(0, env), /^import .* from '\.\.\/src\//m, 'no static import of the app before the environment is loaded');
    });
});
