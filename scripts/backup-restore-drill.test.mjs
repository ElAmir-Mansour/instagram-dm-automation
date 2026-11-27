/**
 * The drill's guards: it must never restore into production, and must pick the newest backup. The restore itself is run by hand (RUNBOOK "Backups").
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { checkScratchTarget, hardRestoreErrors, MAIN_TABLES, newestBackupKey, projectRefs, targetKey } from './backup-restore-drill.mjs';

const REF = 'abcdefghijklmnopqrst';
const PROD_POOLER = `postgresql://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres`;
const PROD_DIRECT = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
const SCRATCH = 'postgresql://postgres:pw@db.zyxwvutsrqponmlkjihg.supabase.co:5432/postgres';

describe('checkScratchTarget refuses production', () => {
    it('accepts a different project', () => {
        assert.deepEqual(checkScratchTarget(SCRATCH, [PROD_POOLER, PROD_DIRECT]), { ok: true });
    });
    it('accepts a local database when production is known', () => {
        assert.equal(checkScratchTarget('postgresql://me@localhost:5439/scratch', [PROD_POOLER]).ok, true);
    });
    it('refuses the same host and database, whatever the user, password and options', () => {
        const same = `postgresql://other:different@db.${REF}.supabase.co:5432/postgres?sslmode=require`;
        assert.equal(checkScratchTarget(same, [PROD_DIRECT]).ok, false);
        assert.equal(checkScratchTarget(PROD_DIRECT, [PROD_DIRECT]).ok, false);
    });
    it('refuses any URL that names the production project ref, e.g. its pooler user', () => {
        assert.equal(checkScratchTarget(`postgresql://postgres.${REF}:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`, [PROD_DIRECT]).ok, false);
        assert.equal(checkScratchTarget(PROD_POOLER, [PROD_DIRECT]).ok, false);
    });
    it('refuses a ref given by PRODUCTION_PROJECT_REF alone', () => {
        assert.equal(checkScratchTarget(`postgresql://u:p@db.${REF}.supabase.co:5432/postgres`, [], REF.toUpperCase()).ok, false);
        assert.equal(checkScratchTarget(SCRATCH, [], REF).ok, true);
    });
    it('refuses when nothing says what production is: it will not guess', () => {
        const r = checkScratchTarget(SCRATCH, [undefined, ''], '');
        assert.equal(r.ok, false);
        assert.match(r.reason, /cannot tell/);
    });
    it('refuses a missing or unparseable URL', () => {
        assert.equal(checkScratchTarget('', [PROD_DIRECT]).ok, false);
        assert.equal(checkScratchTarget('not a url', [PROD_DIRECT]).ok, false);
    });
    it('never puts a password in a reason', () => {
        const r = checkScratchTarget(PROD_DIRECT, [PROD_DIRECT]);
        assert.ok(!JSON.stringify(r).includes('pw'));
    });
});

describe('helpers', () => {
    it('reads refs from a direct host and from a pooler user', () => {
        assert.deepEqual(projectRefs(PROD_DIRECT), [REF]);
        assert.deepEqual(projectRefs(PROD_POOLER), [REF]);
        assert.deepEqual(projectRefs('postgresql://me@localhost/x'), []);
        assert.equal(targetKey(PROD_DIRECT), `db.${REF}.supabase.co:5432/postgres`);
    });
    it('picks the newest daily key and ignores anything else', () => {
        const listing = [
            '2026-11-25 02:17:03   123456 2026-11-25.dump.age',
            '2026-11-27 02:17:41   123999 2026-11-27.dump.age',
            '2026-11-26 02:17:10   123700 2026-11-26.dump.age',
            '2026-11-28 02:00:00        5 notes.txt',
        ].join('\n');
        assert.equal(newestBackupKey(listing), 'daily/2026-11-27.dump.age');
        assert.equal(newestBackupKey(''), null);
    });
    it('ignores the expected "schema public already exists" and nothing else', () => {
        const benign = 'pg_restore: error: could not execute query: ERROR:  schema "public" already exists\npg_restore: warning: errors ignored on restore: 1';
        assert.deepEqual(hardRestoreErrors(benign), []);
        const real = benign + '\npg_restore: error: could not execute query: ERROR:  relation "x" does not exist';
        assert.equal(hardRestoreErrors(real).length, 1);
        assert.deepEqual(hardRestoreErrors(undefined), []);
    });
    it('counts the tables that prove the data came back', () => {
        for (const t of ['creators', 'messages', 'jobs', 'scheduled_posts']) assert.ok(MAIN_TABLES.includes(t));
    });
});

describe('the workflow', () => {
    const yml = readFileSync(new URL('../.github/workflows/backup.yml', import.meta.url), 'utf8');
    it('skips cleanly without secrets, never traces, and encrypts through a pipe', () => {
        assert.match(yml, /enabled=false/);
        assert.match(yml, /set \+x/);
        assert.match(yml, /\| age --recipient/);
        assert.doesNotMatch(yml, /set -x|--verbose|echo[^\n]*\$\{?(BACKUP_DATABASE_URL|AWS_SECRET_ACCESS_KEY|R2_BACKUP_SECRET_ACCESS_KEY)/);
        assert.match(yml, /schedule:[\s\S]*cron:/);
        assert.match(yml, /workflow_dispatch/);
        assert.match(yml, /KEEP_DAILY: '14'/);
        assert.match(yml, /KEEP_WEEKLY: '8'/);
    });
});
