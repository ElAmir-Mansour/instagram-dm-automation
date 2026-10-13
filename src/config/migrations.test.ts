/**
 * The migration manifest, and the drift it exists to prevent.
 *
 * `EXPECTED_MIGRATIONS` is hand-written because the deployed Vercel bundle does not contain
 * the `.sql` files — nothing imports them, so nothing traces them. The cost of writing it down
 * is that it can fall behind the directory, and this is the test that stops it: it reads the
 * files from disk and asserts the list matches, in the order `scripts/migrate.mjs` applies
 * them. Add a migration without registering it here and this fails.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PROFILE_LIMITS } from '../services/profile/validate.js';
import { compareSchema, EXPECTED_MIGRATIONS } from './migrations.js';

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Exactly the ordering rule in scripts/migrate.mjs: by embedded version number, not lexical. */
function onDiskOrder(): string[] {
    const version = (f: string) => {
        const m = f.match(/_v(\d+)/);
        return m ? parseInt(m[1]!, 10) : Number.MAX_SAFE_INTEGER;
    };
    const files = readdirSync(CONFIG_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort((a, b) => version(a) - version(b) || a.localeCompare(b));
    // `schema.sql` lives at the repository root and is forced first by the runner.
    return ['schema.sql', ...files];
}

describe('EXPECTED_MIGRATIONS', () => {
    it('matches src/config/*.sql exactly, in apply order', () => {
        assert.deepEqual(EXPECTED_MIGRATIONS, onDiskOrder());
    });

    it('sorts v15 after v14, not lexically', () => {
        // A plain .sort() puts migration_v10 before migration_v3, which on a fresh database
        // would ALTER tables that do not exist yet. v15 has to land after v14 for the same
        // reason: it ALTERs `creators` and references `users`.
        const i14 = EXPECTED_MIGRATIONS.indexOf('migration_v14_functionality.sql');
        const i15 = EXPECTED_MIGRATIONS.indexOf('migration_v15_admin.sql');

        assert.ok(i14 >= 0 && i15 >= 0);
        assert.equal(i15, i14 + 1);
    });

    it('starts with the base schema', () => {
        assert.equal(EXPECTED_MIGRATIONS[0], 'schema.sql');
    });
});

describe('compareSchema', () => {
    it('reports nothing pending when the ledger is complete', () => {
        const state = compareSchema([...EXPECTED_MIGRATIONS]);

        assert.deepEqual(state.pending, []);
        assert.equal(state.applied, EXPECTED_MIGRATIONS.length);
        assert.deepEqual(state.unknown, []);
    });

    it('names the missing migration, in apply order', () => {
        const state = compareSchema(EXPECTED_MIGRATIONS.slice(0, -1));

        // Derived, not spelled out: naming the newest file here means every migration after
        // this one fails a test that is not about it, and the fix is to retype a filename —
        // which is exactly the edit somebody makes without reading what it asserted.
        assert.deepEqual(state.pending, [EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1]]);
        assert.equal(state.applied, EXPECTED_MIGRATIONS.length - 1);
    });

    it('treats an empty ledger as everything pending', () => {
        // Which is what a database with no `schema_migrations` table looks like, and the
        // actionable answer: run the migrations.
        const state = compareSchema([]);

        assert.deepEqual(state.pending, [...EXPECTED_MIGRATIONS]);
        assert.equal(state.applied, 0);
    });

    it('reports a ledger row this build does not know about separately from pending', () => {
        // A deployment rolled back behind its database. Calling that "pending" would send the
        // operator to run a migration that does not exist in this checkout.
        const state = compareSchema([...EXPECTED_MIGRATIONS, 'migration_v16_future.sql']);

        assert.deepEqual(state.unknown, ['migration_v16_future.sql']);
        assert.deepEqual(state.pending, []);
    });

    it('finds a gap in the middle rather than assuming the tail', () => {
        const withGap = EXPECTED_MIGRATIONS.filter((m) => m !== 'migration_v13_jobs.sql');
        const state = compareSchema(withGap);

        assert.deepEqual(state.pending, ['migration_v13_jobs.sql']);
    });
});

// ─── Row Level Security: every table, in the same file that creates it ─────────────────────────
//
// Deny-by-default RLS (v11) is what shuts a leaked Supabase anon key out of the tables. A table added later
// without it is readable by that key until someone notices: v17 was written because `schema_migrations` was
// the one table that missed it. So the rule is a test, not a habit (docs/TENANT_ONBOARDING_PLAN.md D12).

interface SqlFile {
    name: string;
    sql: string;
}

/** The sweep that enabled RLS on every table created before it (migration v11). */
const RLS_SWEEP = 'migration_v11_rls.sql';

/** SQL without its comments, so a statement written in a comment is not read as one. */
const withoutComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');

/** `[public.]name`, quoted or not: the spellings a statement below may use for a table. */
const TABLE_NAME = String.raw`(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?`;

/** Tables a file creates, lower case. Temporary tables are not exposed to anyone and are not counted. */
function createdTables(sql: string): string[] {
    const create = new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE_NAME}`, 'gi');
    return [...withoutComments(sql).matchAll(create)].map((m) => m[1]!.toLowerCase());
}

/** Tables a file enables RLS on, lower case. `FORCE` is not `ENABLE`, and neither is a comment. */
function rlsEnabledTables(sql: string): Set<string> {
    const enable = new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE_NAME}\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY`, 'gi');
    return new Set([...withoutComments(sql).matchAll(enable)].map((m) => m[1]!.toLowerCase()));
}

/**
 * `file: table` for each table that is exposed. `files` are in apply order. A table is covered when its own file
 * enables RLS on it, or when it was created before `migration_v11_rls.sql` and that sweep does: nothing created
 * after the sweep can rely on it, and nothing may rely on a later file either, because a table that waits for a
 * later migration is open until that migration is applied.
 */
function tablesWithoutRls(files: readonly SqlFile[]): string[] {
    const sweepAt = files.findIndex((f) => f.name === RLS_SWEEP);
    const swept = sweepAt >= 0 ? rlsEnabledTables(files[sweepAt]!.sql) : new Set<string>();
    const exposed: string[] = [];
    files.forEach((file, i) => {
        const own = rlsEnabledTables(file.sql);
        for (const table of createdTables(file.sql)) {
            const sweptByV11 = sweepAt >= 0 && i < sweepAt && swept.has(table);
            if (!own.has(table) && !sweptByV11) exposed.push(`${file.name}: ${table}`);
        }
    });
    return exposed;
}

/** `schema.sql` (the repository root) and every migration, in the order the runner applies them. */
function allMigrationFiles(): SqlFile[] {
    return onDiskOrder().map((name) => ({
        name,
        sql: readFileSync(name === 'schema.sql' ? path.join(CONFIG_DIR, '..', '..', 'schema.sql') : path.join(CONFIG_DIR, name), 'utf8'),
    }));
}

describe('Row Level Security on every table', () => {
    it('is enabled for every table any migration creates', () => {
        assert.deepEqual(tablesWithoutRls(allMigrationFiles()), []);
    });

    it('the scan sees the tables, so an empty answer means covered and not "found nothing"', () => {
        // A regex that matches nothing makes the test above pass for any set of migrations.
        const files = allMigrationFiles();
        const created = files.flatMap((f) => createdTables(f.sql));
        for (const known of [
            'creators', 'campaigns', 'users', 'jobs', 'studio_settings', 'growth_settings', 'infographics', 'creator_profiles', 'creator_profile_versions',
            'onboarding', 'invites', 'profile_drafts', 'voice_examples', 'onboarding_events', 'ai_usage',
        ]) {
            assert.ok(created.includes(known), `${known} is found`);
        }
        assert.ok(created.length >= 40, `found ${created.length} tables`);
        const enabled = files.flatMap((f) => [...rlsEnabledTables(f.sql)]);
        for (const known of ['creators', 'studio_settings', 'creator_profiles', 'creator_profile_versions', 'onboarding', 'invites', 'profile_drafts', 'voice_examples', 'onboarding_events', 'ai_usage']) {
            assert.ok(enabled.includes(known), `${known} has RLS enabled somewhere`);
        }
    });

    it('fails for a new table that does not enable it', () => {
        const files = [...allMigrationFiles(), { name: 'migration_v99_widgets.sql', sql: 'CREATE TABLE IF NOT EXISTS widgets (id INT);' }];
        assert.deepEqual(tablesWithoutRls(files), ['migration_v99_widgets.sql: widgets']);
    });

    it('passes when the file that creates the table enables it, in any spelling the repo uses', () => {
        for (const enable of [
            'ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;',
            'ALTER TABLE IF EXISTS widgets ENABLE ROW LEVEL SECURITY;',
            'alter table public.widgets   enable   row level security;',
            'ALTER TABLE "widgets" ENABLE ROW LEVEL SECURITY;',
        ]) {
            const sql = `CREATE TABLE widgets (id INT);\n${enable}`;
            assert.deepEqual(tablesWithoutRls([{ name: 'migration_v99_widgets.sql', sql }]), [], enable);
        }
    });

    it('does not take a later file as cover: a table is open until the migration that closes it is applied', () => {
        const files = [
            { name: 'migration_v98_widgets.sql', sql: 'CREATE TABLE IF NOT EXISTS widgets (id INT);' },
            { name: 'migration_v99_rls.sql', sql: 'ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;' },
        ];
        assert.deepEqual(tablesWithoutRls(files), ['migration_v98_widgets.sql: widgets']);
    });

    it('lets v11 cover what existed before it, and nothing created after it', () => {
        const before = { name: 'migration_v2_old.sql', sql: 'CREATE TABLE IF NOT EXISTS old_things (id INT);' };
        const sweep = { name: RLS_SWEEP, sql: 'ALTER TABLE IF EXISTS old_things ENABLE ROW LEVEL SECURITY;\nALTER TABLE IF EXISTS new_things ENABLE ROW LEVEL SECURITY;' };
        const after = { name: 'migration_v12_new.sql', sql: 'CREATE TABLE IF NOT EXISTS new_things (id INT);' };
        assert.deepEqual(tablesWithoutRls([before, sweep]), []);
        assert.deepEqual(tablesWithoutRls([before, sweep, after]), ['migration_v12_new.sql: new_things']);
    });

    it('does not count RLS that is only written in a comment, or a table that is only created in one', () => {
        const commentedEnable = {
            name: 'migration_v99_a.sql',
            sql: 'CREATE TABLE widgets (id INT);\n-- ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;\n/* ALTER TABLE widgets ENABLE ROW LEVEL SECURITY; */',
        };
        assert.deepEqual(tablesWithoutRls([commentedEnable]), ['migration_v99_a.sql: widgets']);
        const commentedCreate = { name: 'migration_v99_b.sql', sql: '-- CREATE TABLE ghosts (id INT);\n/* CREATE TABLE phantoms (id INT); */' };
        assert.deepEqual(tablesWithoutRls([commentedCreate]), []);
    });

    it('does not count FORCE, which is not ENABLE', () => {
        const sql = 'CREATE TABLE widgets (id INT);\nALTER TABLE widgets FORCE ROW LEVEL SECURITY;';
        assert.deepEqual(tablesWithoutRls([{ name: 'migration_v99_widgets.sql', sql }]), ['migration_v99_widgets.sql: widgets']);
    });

    it('does not mix tables up: enabling one table does not cover its neighbour', () => {
        const sql = 'CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\nALTER TABLE a ENABLE ROW LEVEL SECURITY;';
        assert.deepEqual(tablesWithoutRls([{ name: 'migration_v99_ab.sql', sql }]), ['migration_v99_ab.sql: b']);
    });
});

// ─── v33: the Creator Profile tables ───────────────────────────────────────────────────────────

describe('migration v33: creator_profiles', () => {
    const FILE = 'migration_v33_creator_profiles.sql';
    const sql = withoutComments(readFileSync(path.join(CONFIG_DIR, FILE), 'utf8')).replace(/\s+/g, ' ');

    it('is registered, right after v32', () => {
        const i33 = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i33 >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(i33, EXPECTED_MIGRATIONS.indexOf('migration_v32_infographic_review.sql') + 1);
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE, 'a database without it reports it as pending');
    });

    it('gives up on a lock after 5 s, in a way that ends with the runner\'s transaction: its first statement', () => {
        // The FKs lock creators and users, and the ALTERs take ACCESS EXCLUSIVE on four draft tables; behind a long
        // query that queues live requests. LOCAL, not SESSION: a session setting would stay on a pooled connection.
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('creates the profile table and its history, and nothing else', () => {
        assert.deepEqual(createdTables(sql), ['creator_profiles', 'creator_profile_versions']);
    });

    it('enables RLS on both, in the same file', () => {
        assert.deepEqual([...rlsEnabledTables(sql)].sort(), ['creator_profile_versions', 'creator_profiles']);
    });

    it('is idempotent: every table and column is created only if absent', () => {
        assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        // IF NOT EXISTS matches on the NAME, not the definition (migration v15): an index here would need a DROP first.
        assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX/, 'no index is created by this file, so none can silently no-op');
    });

    it('both tables cascade from the tenant, so deleting a tenant leaves no profile behind', () => {
        assert.match(sql, /creator_profiles \( creator_id UUID PRIMARY KEY REFERENCES creators\(id\) ON DELETE CASCADE/);
        assert.match(sql, /creator_profile_versions \( creator_id UUID NOT NULL REFERENCES creators\(id\) ON DELETE CASCADE/);
    });

    it('a version is one row per tenant and number, and a deleted user leaves the row', () => {
        assert.match(sql, /PRIMARY KEY \(creator_id, version\)/);
        assert.equal((sql.match(/updated_by UUID REFERENCES users\(id\) ON DELETE SET NULL/g) ?? []).length, 2);
    });

    it('caps the stored profile at the validator\'s own limit, measured the way the validator measures it', () => {
        assert.match(sql, /CONSTRAINT creator_profiles_size CHECK \(octet_length\(profile::text\) <= (\d+)\)/);
        assert.equal(Number(/octet_length\(profile::text\) <= (\d+)/.exec(sql)![1]), PROFILE_LIMITS.profileBytes);
    });

    it('names the four sources the store writes', () => {
        assert.match(sql, /source TEXT NOT NULL CHECK \(source IN \('backfill', 'wizard', 'user', 'admin'\)\)/);
    });

    it('adds a nullable profile_version to the four tables a generated row lands in', () => {
        const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS profile_version INT;/g)].map((m) => m[1]);
        assert.deepEqual(added.sort(), ['carousel_drafts', 'clip_drafts', 'infographics', 'studio_lessons']);
        assert.doesNotMatch(sql, /profile_version INT NOT NULL/, 'rows that exist today have none');
    });

    it('every table it alters or references exists by the time it runs', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN/g)) assert.ok(existing.has(m[1]!), `${m[1]} is created before v33`);
        for (const m of sql.matchAll(/REFERENCES (\w+)\(/g)) assert.ok(existing.has(m[1]!), `${m[1]} is created before v33`);
    });
});

// ─── v34: onboarding ───────────────────────────────────────────────────────────────────────────

describe('migration v34: onboarding', () => {
    const FILE = 'migration_v34_onboarding.sql';
    const NEW_TABLES = ['onboarding', 'invites', 'profile_drafts', 'voice_examples', 'onboarding_events', 'ai_usage'];
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');

    it('is registered, right after v33, and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(i, EXPECTED_MIGRATIONS.indexOf('migration_v33_creator_profiles.sql') + 1);
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, as its first statement (it locks creators, the webhook\'s hot table)', () => {
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('creates the six tables, and no others', () => {
        assert.deepEqual(createdTables(sql).sort(), [...NEW_TABLES].sort());
    });

    it('enables RLS on every one of them in this same file, and on nothing else', () => {
        assert.deepEqual([...rlsEnabledTables(sql)].sort(), [...NEW_TABLES].sort());
        // The generic scan agrees: with v34 in the list, no table anywhere is exposed.
        assert.deepEqual(tablesWithoutRls(allMigrationFiles()), []);
    });

    it('the RLS scan would catch v34 missing one: remove each enable in turn and that table is reported', () => {
        for (const table of NEW_TABLES) {
            const without = raw.replace(new RegExp(`ALTER TABLE ${table}\\s+ENABLE ROW LEVEL SECURITY;`), '');
            assert.notEqual(without, raw, `${table}'s enable was found to remove`);
            const files = allMigrationFiles().map((f) => (f.name === FILE ? { ...f, sql: without } : f));
            assert.deepEqual(tablesWithoutRls(files), [`${FILE}: ${table}`], table);
        }
    });

    it('every foreign key to creators cascades, so deleting a tenant leaves nothing of it behind (D12)', () => {
        const toCreators = [...sql.matchAll(/REFERENCES creators\(id\)( ON DELETE (?:CASCADE|SET NULL))?/g)];
        // onboarding, invites, profile_drafts, voice_examples, onboarding_events and ai_usage each have one.
        assert.equal(toCreators.length, NEW_TABLES.length);
        for (const m of toCreators) assert.equal(m[1], ' ON DELETE CASCADE', m[0]);
    });

    it('a deleted user leaves the rows its tenant still owns: user columns are SET NULL, except the account a reset invite is for', () => {
        const toUsers = [...sql.matchAll(/(\w+)\s+UUID(?: NOT NULL)? REFERENCES users\(id\) ON DELETE (CASCADE|SET NULL)/g)].map((m) => `${m[1]}:${m[2]}`).sort();
        assert.deepEqual(toUsers, ['created_by:SET NULL', 'requested_by:SET NULL', 'used_by:SET NULL', 'user_id:CASCADE', 'user_id:SET NULL']);
    });

    it('makes the Meta connection optional, and keeps the ids and the token together', () => {
        assert.match(sql, /ALTER TABLE creators ALTER COLUMN instagram_page_id DROP NOT NULL;/);
        assert.match(sql, /ALTER TABLE creators ALTER COLUMN page_access_token DROP NOT NULL;/);
        assert.match(sql, /conname = 'creators_meta_ids_need_token' AND conrelid = 'creators'::regclass/);
        assert.match(sql, /ADD CONSTRAINT creators_meta_ids_need_token CHECK \(page_access_token IS NOT NULL OR \(instagram_page_id IS NULL AND facebook_page_id IS NULL\)\)/);
        assert.doesNotMatch(sql, /DROP NOT NULL[^;]*facebook_page_id/, 'the Facebook id was already nullable');
    });

    it('adds the handle and the site to creators, nullable', () => {
        assert.match(sql, /ALTER TABLE creators ADD COLUMN IF NOT EXISTS instagram_username TEXT;/);
        assert.match(sql, /ALTER TABLE creators ADD COLUMN IF NOT EXISTS website_url TEXT;/);
    });

    it('marks every tenant that exists as onboarded, and never changes one onboarding has since touched', () => {
        const insert = / INSERT INTO onboarding \(creator_id, status, started_at, completed_at\) SELECT id, 'completed', created_at, created_at FROM creators ON CONFLICT \(creator_id\) DO NOTHING;/;
        assert.match(sql, insert);
        assert.doesNotMatch(sql, /ON CONFLICT[^;]*DO UPDATE/, 'a re-run may not overwrite a status');
        assert.doesNotMatch(sql, /UPDATE onboarding/);
        // The table exists before the insert reads into it.
        assert.ok(sql.indexOf('CREATE TABLE IF NOT EXISTS onboarding') < sql.search(insert));
    });

    it('is idempotent: every table, column and index is created only if absent, and the constraint is guarded', () => {
        assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length, (sql.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/ADD CONSTRAINT/g) ?? []).length, 1);
        assert.match(sql, /IF NOT EXISTS \( SELECT 1 FROM pg_constraint WHERE conname = 'creators_meta_ids_need_token'/);
        assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM/, 'it removes nothing');
    });

    it('creates a UNIQUE index only on a table this file creates: IF NOT EXISTS matches on the NAME (v15), so one on an older table could silently no-op', () => {
        const unique = [...sql.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS (\w+) ON (\w+)/g)].map((m) => ({ index: m[1]!, table: m[2]! }));
        assert.deepEqual(unique, [{ index: 'idx_profile_drafts_one_active', table: 'profile_drafts' }]);
        for (const { table } of unique) assert.ok(NEW_TABLES.includes(table), `${table} is created by this file`);
        // And no existing index is re-created: the creators indexes of v10 and v12 are left as they are.
        assert.doesNotMatch(sql, /idx_creators_/);
    });

    it('allows one draft in flight per tenant, and the three states that count as in flight are the ones the state machine uses', () => {
        assert.match(sql, /idx_profile_drafts_one_active ON profile_drafts\(creator_id\) WHERE status IN \('queued', 'fetching', 'drafting'\)/);
        assert.match(sql, /status TEXT NOT NULL DEFAULT 'queued' CHECK \(status IN \('queued', 'fetching', 'drafting', 'ready', 'failed', 'superseded'\)\)/);
    });

    it('keeps only the hash of an invite token, unique, and the vocabulary of its purpose and role', () => {
        assert.match(sql, /token_hash CHAR\(64\) NOT NULL UNIQUE/);
        assert.doesNotMatch(sql, /\btoken TEXT|raw_token/, 'the raw token is never stored');
        assert.match(sql, /purpose VARCHAR\(10\) NOT NULL DEFAULT 'join' CHECK \(purpose IN \('join', 'reset'\)\)/);
        assert.match(sql, /membership_role VARCHAR\(30\) NOT NULL DEFAULT 'owner' CHECK \(membership_role IN \('owner', 'operator', 'viewer'\)\)/);
    });

    it('onboarding: the three statuses, new tenants start invited, and the filler is the tenant or the admin', () => {
        assert.match(sql, /status VARCHAR\(20\) NOT NULL DEFAULT 'invited' CHECK \(status IN \('invited', 'in_progress', 'completed'\)\)/);
        assert.match(sql, /filled_by VARCHAR\(10\) CHECK \(filled_by IN \('tenant', 'admin'\)\)/);
        assert.match(sql, /onboarding \( creator_id UUID PRIMARY KEY REFERENCES creators\(id\) ON DELETE CASCADE, status/);
    });

    it('voice_examples: the four kinds, the three verdicts, who judged, and when the tenant confirmed (an admin\'s approval is not yet the tenant\'s)', () => {
        assert.match(sql, /kind TEXT NOT NULL CHECK \(kind IN \('dm_reply', 'caption', 'comment_dm', 'comment_public'\)\)/);
        assert.match(sql, /verdict TEXT CHECK \(verdict IN \('approved', 'edited', 'rejected'\)\)/);
        assert.match(sql, /verdict_by TEXT CHECK \(verdict_by IN \('tenant', 'admin'\)\)/);
        assert.match(sql, /tenant_confirmed_at TIMESTAMP WITH TIME ZONE/);
    });

    it('ai_usage: tokens, USD, priced, outcome and time, with a tenant that may be none (an operator\'s key test)', () => {
        const table = /CREATE TABLE IF NOT EXISTS ai_usage \((.*?)\);/.exec(sql)![1]!;
        for (const column of [
            'creator_id UUID REFERENCES creators', 'purpose TEXT NOT NULL', 'provider TEXT NOT NULL', 'model TEXT NOT NULL', 'input_tokens INT NOT NULL',
            'output_tokens INT NOT NULL', 'usd NUMERIC\\(12, 6\\) NOT NULL', 'priced BOOLEAN NOT NULL', 'outcome TEXT NOT NULL', 'elapsed_ms INT', 'at TIMESTAMP WITH TIME ZONE NOT NULL',
        ]) {
            assert.match(table, new RegExp(column), column);
        }
        assert.doesNotMatch(table, /creator_id UUID NOT NULL/);
    });

    it('every table it alters or references exists by the time it runs', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        for (const m of sql.matchAll(/ALTER TABLE (\w+) (?:ADD|ALTER)/g)) assert.ok(existing.has(m[1]!), `${m[1]} is created before v34`);
        for (const m of sql.matchAll(/REFERENCES (\w+)\(/g)) assert.ok(existing.has(m[1]!), `${m[1]} is created before v34`);
    });
});
