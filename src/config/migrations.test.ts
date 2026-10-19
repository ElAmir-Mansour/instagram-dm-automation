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
import { DEFAULT_DM_ENGINE, DEFAULT_GEMINI_FALLBACK, DM_ENGINES } from '../services/dmEngine.js';
import { DEFAULT_SALES_MODE, SALES_MODES } from '../services/dmSales/mode.js';
import { HANDOFF_REASONS, INTENTS, STAGES } from '../services/dmSales/types.js';
import { VARIANT_IDS } from '../services/dmSales/variants.js';
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

// ─── v35: Meta login ───────────────────────────────────────────────────────────────────────────

describe('migration v35: meta login', () => {
    const FILE = 'migration_v35_meta_login.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');
    /** The same without string literals (the COMMENT texts and the ILIKE pattern), so words inside them are not read as SQL. */
    const code = sql.replace(/'(?:[^']|'')*'/g, "''");

    it('is registered, right after v34, and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(i, EXPECTED_MIGRATIONS.indexOf('migration_v34_onboarding.sql') + 1);
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, as its first statement (it locks creators, the webhook\'s hot table)', () => {
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('creates no table, so there is nothing for RLS to miss, and the generic scan still finds every table covered', () => {
        assert.deepEqual(createdTables(sql), []);
        assert.deepEqual(tablesWithoutRls(allMigrationFiles()), []);
    });

    it('adds exactly the three creators columns and the two oauth_states columns, each nullable and only if absent', () => {
        const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([A-Z]+(?:\(\d+\))?(?: WITH TIME ZONE)?);/g)].map((m) => `${m[1]}.${m[2]} ${m[3]}`);
        assert.deepEqual(added.sort(), [
            'creators.meta_connected_at TIMESTAMP WITH TIME ZONE',
            'creators.meta_page_name TEXT',
            'creators.meta_webhook_subscribed_at TIMESTAMP WITH TIME ZONE',
            'oauth_states.payload TEXT',
            'oauth_states.return_to VARCHAR(20)',
        ]);
        assert.equal((code.match(/ADD COLUMN/g) ?? []).length, 5, 'and no other column is added');
        for (const statement of code.split(';').filter((st) => /ADD COLUMN/.test(st))) {
            assert.doesNotMatch(statement, /NOT NULL|DEFAULT/, 'nothing that would rewrite or reject an existing row');
        }
    });

    it('turns the UNIQUE meta_user_id index into a plain one: dropped first, and only while it is still unique, then recreated non-unique', () => {
        // IF NOT EXISTS matches on the NAME, not the definition (migration v15): a bare CREATE INDEX would silently keep the unique one.
        const dropAt = sql.indexOf('DROP INDEX idx_creators_meta_user');
        const createAt = sql.indexOf('CREATE INDEX IF NOT EXISTS idx_creators_meta_user');
        assert.ok(dropAt > 0 && createAt > dropAt, 'the DROP comes before the CREATE');
        assert.match(sql, /indexname = 'idx_creators_meta_user' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'/, 'the drop is conditional on it being unique');
        assert.doesNotMatch(code, /CREATE UNIQUE INDEX/, 'nothing unique is created');
        assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_creators_meta_user ON creators \(meta_user_id\) WHERE meta_user_id IS NOT NULL;/);
        // v12 made it unique; this file is what makes one person connecting two tenants possible.
        assert.match(readFileSync(path.join(CONFIG_DIR, 'migration_v12_tenancy.sql'), 'utf8'), /CREATE UNIQUE INDEX IF NOT EXISTS idx_creators_meta_user/);
    });

    it('does not change a row: no INSERT, UPDATE or DELETE, so the owner\'s tenant keeps its ids and its token exactly', () => {
        assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE)\b/i);
        assert.doesNotMatch(code, /\bDROP (TABLE|COLUMN|CONSTRAINT)\b/i);
    });

    it('is idempotent: every column and index is created only if absent, and the one DROP is guarded', () => {
        assert.equal((code.match(/ADD COLUMN/g) ?? []).length, (code.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.equal((code.match(/CREATE (UNIQUE )?INDEX/g) ?? []).length, (code.match(/CREATE (UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length);
        assert.equal((code.match(/DROP INDEX/g) ?? []).length, 1);
        assert.match(code, /IF EXISTS \( SELECT 1 FROM pg_indexes [^;]*\) THEN DROP INDEX idx_creators_meta_user; END IF;/);
    });

    it('every table it alters exists by the time it runs', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD/g)) assert.ok(existing.has(m[1]!), `${m[1]} is created before v35`);
        assert.ok(existing.has('oauth_states') && existing.has('creators'));
    });

    it('every column the application reads or writes for a Meta connection is one a migration adds', () => {
        const all = allMigrationFiles().map((f) => f.sql).join('\n');
        for (const column of ['meta_user_id', 'meta_page_name', 'meta_connected_at', 'meta_webhook_subscribed_at', 'instagram_username']) {
            assert.match(all, new RegExp(`creators ADD COLUMN IF NOT EXISTS ${column}\\b`), column);
        }
        for (const column of ['payload', 'return_to']) assert.match(all, new RegExp(`oauth_states ADD COLUMN IF NOT EXISTS ${column}\\b`), column);
    });
});

// ─── v36: prompt-cache tokens on ai_usage ──────────────────────────────────────────────────────

describe('migration v36: ai_usage cache tokens', () => {
    const FILE = 'migration_v36_ai_usage_cache.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');
    /** The same without string literals (the COMMENT texts), so words inside them are not read as SQL. */
    const code = sql.replace(/'(?:[^']|'')*'/g, "''");

    it('is registered, right after v35, and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(i, EXPECTED_MIGRATIONS.indexOf('migration_v35_meta_login.sql') + 1);
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, as its first statement (every AI call reserves a row in the table it alters)', () => {
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('creates no table, so there is nothing for RLS to miss, and the generic scan still finds every table covered', () => {
        assert.deepEqual(createdTables(sql), []);
        assert.deepEqual(tablesWithoutRls(allMigrationFiles()), []);
    });

    it('adds exactly the two ai_usage columns, each a whole number that defaults to 0, and only if absent', () => {
        const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) (INT NOT NULL DEFAULT 0);/g)].map((m) => `${m[1]}.${m[2]} ${m[3]}`);
        assert.deepEqual(added.sort(), ['ai_usage.cache_read_tokens INT NOT NULL DEFAULT 0', 'ai_usage.cache_write_tokens INT NOT NULL DEFAULT 0']);
        assert.equal((code.match(/ADD COLUMN/g) ?? []).length, 2, 'and no other column is added');
    });

    it('rewrites no row: the default is a constant, which is stored in the catalog and not written into the table', () => {
        for (const statement of code.split(';').filter((st) => /ADD COLUMN/.test(st))) {
            assert.match(statement, /DEFAULT 0$/, 'a constant default, never a function (now(), random()) that would force a rewrite');
        }
        assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE)\b/i);
        assert.doesNotMatch(code, /\bDROP\b|\bTRUNCATE\b|\bALTER COLUMN\b|\bSET DATA TYPE\b/i);
        assert.doesNotMatch(code, /CREATE (UNIQUE )?INDEX/i, 'no index: nothing reads these columns by value');
    });

    it('is idempotent: every column is added only if absent, so running it twice is the same as once', () => {
        assert.equal((code.match(/ADD COLUMN/g) ?? []).length, (code.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
    });

    it('alters a table that exists by the time it runs: v34 creates ai_usage', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        for (const m of sql.matchAll(/ALTER TABLE (\w+) ADD/g)) assert.ok(existing.has(m[1]!), `${m[1]} is created before v36`);
        assert.ok(existing.has('ai_usage'));
    });

    it('documents the three columns that now describe a call\'s input', () => {
        for (const column of ['input_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
            assert.match(sql, new RegExp(`COMMENT ON COLUMN ai_usage\\.${column} IS`), column);
        }
    });

    it('every column the application writes is one the migration adds: settleCall names both, and recordCall and the reservation need neither', () => {
        const usage = readFileSync(path.join(CONFIG_DIR, '..', 'services', 'aiProviders', 'usage.ts'), 'utf8');
        const update = /UPDATE ai_usage\s+SET ([\s\S]*?)WHERE id = \$1/.exec(usage);
        assert.ok(update, 'settleCall\'s UPDATE is found');
        const written = [...update![1]!.matchAll(/\b([a-z_]+) = \$\d+/g)].map((m) => m[1]);
        assert.ok(written.includes('cache_read_tokens') && written.includes('cache_write_tokens'));
        for (const column of ['cache_read_tokens', 'cache_write_tokens']) assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column} INT`), column);
        // The INSERTs run before a call is paid for or for a refusal: they leave the columns to their default of 0.
        for (const insert of usage.matchAll(/INSERT INTO ai_usage \(([^)]*)\)/g)) assert.doesNotMatch(insert[1]!, /cache_/);
    });
});

// ─── v37: the DM engine switch ─────────────────────────────────────────────────────────────────

describe('migration v37: the DM engine switch', () => {
    const FILE = 'migration_v37_dm_engine.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');

    it('is registered, right after v36, and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(i, EXPECTED_MIGRATIONS.indexOf('migration_v36_ai_usage_cache.sql') + 1);
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, and that is its first line and first statement', () => {
        assert.match(raw, /^SET LOCAL lock_timeout = '5s';/);
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('adds the engine, defaulting to Gemini, and the fallback switch, defaulting to on: today\'s behaviour for every existing row', () => {
        assert.match(sql, /ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS engine VARCHAR\(10\) NOT NULL DEFAULT 'gemini'/);
        assert.match(sql, /ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS gemini_fallback BOOLEAN NOT NULL DEFAULT TRUE/);
        // The code's idea of "a row that says nothing" is the column's default.
        assert.equal(DEFAULT_DM_ENGINE, 'gemini');
        assert.equal(DEFAULT_GEMINI_FALLBACK, true);
    });

    it('allows exactly the engines the code runs, and replaces its CHECK so a re-run is harmless', () => {
        const check = /ADD CONSTRAINT ai_agents_engine_check CHECK \(engine IN \(([^)]*)\)\)/.exec(sql);
        assert.ok(check, 'the CHECK is there');
        assert.deepEqual([...check![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]), [...DM_ENGINES]);
        assert.ok(sql.indexOf('DROP CONSTRAINT IF EXISTS ai_agents_engine_check') >= 0 && sql.indexOf('DROP CONSTRAINT IF EXISTS ai_agents_engine_check') < sql.indexOf('ADD CONSTRAINT ai_agents_engine_check'));
    });

    it('is idempotent and creates no table: every column is added only if absent', () => {
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, 2);
        assert.deepEqual(createdTables(sql), []);
        assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX/);
    });

    it('alters a table that exists by the time it runs, and touches no other', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        const altered = [...sql.matchAll(/ALTER TABLE (\w+) /g)].map((m) => m[1]!);
        assert.deepEqual([...new Set(altered)], ['ai_agents']);
        assert.ok(existing.has('ai_agents'));
    });
});

// ─── v39: the DM sales turn's switch and state ─────────────────────────────────────────────────

describe('migration v39: the DM sales turn\'s switch and state', () => {
    const FILE = 'migration_v39_dm_sales_state.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');

    it('is registered, after v37 (v38 belongs to another change), and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.ok(i > EXPECTED_MIGRATIONS.indexOf('migration_v37_dm_engine.sql'));
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, and that is its first line and first statement', () => {
        assert.match(raw, /^SET LOCAL lock_timeout = '5s';/);
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('adds the sales mode defaulting to OFF and an empty test list: every existing agent answers as it did', () => {
        assert.match(sql, /ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS sales_mode VARCHAR\(5\) NOT NULL DEFAULT 'off'/);
        assert.match(sql, /ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS sales_test_senders TEXT\[\] NOT NULL DEFAULT '\{\}'/);
        // The code's idea of "a row that says nothing" is the column's default.
        assert.equal(DEFAULT_SALES_MODE, 'off');
    });

    it('allows exactly the modes the code runs, and replaces its CHECK so a re-run is harmless', () => {
        const check = /ADD CONSTRAINT ai_agents_sales_mode_check CHECK \(sales_mode IN \(([^)]*)\)\)/.exec(sql);
        assert.ok(check, 'the CHECK is there');
        assert.deepEqual([...check![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]), [...SALES_MODES]);
        assert.ok(sql.indexOf('DROP CONSTRAINT IF EXISTS ai_agents_sales_mode_check') >= 0 && sql.indexOf('DROP CONSTRAINT IF EXISTS ai_agents_sales_mode_check') < sql.indexOf('ADD CONSTRAINT ai_agents_sales_mode_check'));
    });

    it('allows exactly the stages and hand-off reasons the code uses', () => {
        const stage = /ADD CONSTRAINT conversations_stage_check CHECK \(stage IN \(([^)]*)\)\)/.exec(sql);
        assert.ok(stage, 'the stage CHECK is there');
        assert.deepEqual([...stage![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]), [...STAGES]);
        assert.match(sql, /conversations ADD COLUMN IF NOT EXISTS stage VARCHAR\(12\) NOT NULL DEFAULT 'new'/);
        const reason = /ADD CONSTRAINT conversations_handoff_reason_check CHECK \(handoff_reason IS NULL OR handoff_reason IN \(([^)]*)\)\)/.exec(sql);
        assert.ok(reason, 'the hand-off reason CHECK is there');
        assert.deepEqual([...reason![1]!.matchAll(/'([^']*)'/g)].map((m) => m[1]), HANDOFF_REASONS.filter((r) => r !== 'none'), 'every reason but "none", which is NULL');
        for (const name of ['conversations_stage_check', 'conversations_handoff_reason_check']) {
            assert.ok(sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`) >= 0 && sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`) < sql.indexOf(`ADD CONSTRAINT ${name}`), name);
        }
    });

    it('fits every value the code writes: the widest intent, stage and reason are inside their columns', () => {
        const width = (column: string): number => Number(new RegExp(`${column} VARCHAR\\((\\d+)\\)`).exec(sql)![1]);
        assert.ok(Math.max(...INTENTS.map((i) => i.length)) <= width('last_intent'));
        assert.ok(Math.max(...STAGES.map((s) => s.length)) <= width('stage'));
        assert.ok(Math.max(...HANDOFF_REASONS.map((r) => r.length)) <= width('handoff_reason'));
    });

    it('adds the funnel the plan names to conversations, and the ai_meta to messages: nothing more', () => {
        const added = (table: string): string[] => [...sql.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS (\\w+)`, 'g'))].map((m) => m[1]!);
        assert.deepEqual(added('conversations'), [
            'stage', 'last_intent', 'offer_id', 'offers_linked', 'last_link_at', 'qualifier_turns', 'abuse_strikes', 'last_inbound_at', 'handoff_at',
            'handoff_reason', 'opted_out_at', 'followups_sent', 'source_campaign_id',
        ]);
        assert.deepEqual(added('messages'), ['ai_meta']);
        assert.match(sql, /messages ADD COLUMN IF NOT EXISTS ai_meta JSONB;/);
        assert.deepEqual(added('ai_agents'), ['sales_mode', 'sales_test_senders']);
    });

    it('is idempotent and creates no table, so there is no new table to enable row level security on (the ones it alters have it since v11)', () => {
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.deepEqual(createdTables(sql), []);
        assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX/);
        const rls = readFileSync(path.join(CONFIG_DIR, 'migration_v11_rls.sql'), 'utf8');
        for (const table of ['ai_agents', 'conversations', 'messages', 'campaigns']) assert.match(rls, new RegExp(`ALTER TABLE IF EXISTS ${table}\\s+ENABLE ROW LEVEL SECURITY`), table);
    });

    it('alters tables that exist by the time it runs, and touches no other', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        const altered = [...sql.matchAll(/ALTER TABLE (\w+) /g)].map((m) => m[1]!);
        assert.deepEqual([...new Set(altered)].sort(), ['ai_agents', 'conversations', 'messages']);
        for (const table of ['ai_agents', 'conversations', 'messages', 'campaigns']) assert.ok(existing.has(table), `${table} exists before v39`);
    });

    it('does not change a row: no UPDATE, no DELETE, no INSERT', () => {
        assert.doesNotMatch(sql, /\b(UPDATE|INSERT|TRUNCATE)\b|\bDELETE FROM\b|\bDROP TABLE\b/i, 'a foreign key\'s ON DELETE SET NULL is not a DELETE');
    });
});

// ─── v41: who a private reply went to ──────────────────────────────────────────────────────────

describe('migration v41: interactions.recipient_id (the comment -> DM bridge)', () => {
    const FILE = 'migration_v41_interaction_recipient.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');

    it('is registered right after v40 (v39 and v40 are taken), and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(EXPECTED_MIGRATIONS[i - 1], 'migration_v40_conversation_profile.sql');
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, and that is its first line and first statement (it locks interactions, the comment path\'s table)', () => {
        assert.match(raw, /^SET LOCAL lock_timeout = '5s';/);
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('adds exactly one column to interactions: nullable, no default, only if absent, and as wide as the other tables\' recipient ids', () => {
        const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([A-Z]+(?:\(\d+\))?)([^;]*);/g)];
        assert.equal(added.length, 1);
        assert.deepEqual([added[0]![1], added[0]![2], added[0]![3]], ['interactions', 'recipient_id', 'VARCHAR(255)']);
        assert.equal(added[0]![4]!.trim(), '', 'nothing after the type: no NOT NULL, no DEFAULT, so no row is rewritten');
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, 1);
        // The same width as `dm_send_log.recipient_id` and `conversations.instagram_user_id`, the ids it is compared with.
        assert.match(readFileSync(path.join(CONFIG_DIR, 'migration_v10_hardening.sql'), 'utf8'), /recipient_id VARCHAR\(255\) NOT NULL/);
        assert.match(readFileSync(path.join(CONFIG_DIR, 'schema_migration_v2.sql'), 'utf8'), /instagram_user_id VARCHAR\(255\) NOT NULL/);
    });

    it('indexes the bridge\'s lookup, partial, so it holds only rows that have a recipient and builds over none', () => {
        const index = /CREATE INDEX IF NOT EXISTS (\w+) ON interactions \(([^)]*)\) WHERE ([^;]*);/.exec(sql);
        assert.ok(index, 'the index is there');
        assert.equal(index![1], 'idx_interactions_recipient');
        assert.equal(index![2], 'creator_id, recipient_id, timestamp DESC', 'tenant, then who, then the newest first: what `commentSource` asks for');
        assert.equal(index![3]!.trim(), 'recipient_id IS NOT NULL');
        assert.doesNotMatch(sql, /CREATE UNIQUE INDEX/, 'a UNIQUE index named like an old one would silently no-op (v15)');
        assert.doesNotMatch(sql, /CONCURRENTLY/, 'the runner applies each file inside a transaction, where it is refused');
    });

    it('is idempotent and creates no table, so there is no new table to enable row level security on (interactions has it since v11)', () => {
        assert.equal((sql.match(/CREATE INDEX/g) ?? []).length, (sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length);
        assert.deepEqual(createdTables(sql), []);
        assert.match(readFileSync(path.join(CONFIG_DIR, 'migration_v11_rls.sql'), 'utf8'), /ALTER TABLE IF EXISTS interactions\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('alters a table that exists by the time it runs, and touches no other', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        assert.deepEqual([...new Set([...sql.matchAll(/ALTER TABLE (\w+) /g)].map((m) => m[1]!))], ['interactions']);
        assert.ok(existing.has('interactions'));
    });

    it('does not change a row: no UPDATE, no DELETE, no INSERT', () => {
        assert.doesNotMatch(sql, /\b(UPDATE|INSERT|TRUNCATE)\b|\bDELETE FROM\b|\bDROP TABLE\b/i);
    });
});

// ─── v42: the A/B arm a DM conversation was given ──────────────────────────────────────────────

describe('migration v42: conversations.sales_variant (the DM sales turn\'s A/B arm)', () => {
    const FILE = 'migration_v42_dm_variant.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');

    it('is registered right after v41, and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.equal(EXPECTED_MIGRATIONS[i - 1], 'migration_v41_interaction_recipient.sql');
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, and that is its first line and first statement (it locks conversations, the DM path\'s table)', () => {
        assert.match(raw, /^SET LOCAL lock_timeout = '5s';/);
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('adds exactly one column to conversations: nullable, no default, only if absent, wide enough for a slot id', () => {
        const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([A-Z]+(?:\(\d+\))?)([^;]*);/g)];
        assert.equal(added.length, 1);
        assert.deepEqual([added[0]![1], added[0]![2], added[0]![3]], ['conversations', 'sales_variant', 'VARCHAR(8)']);
        assert.equal(added[0]![4]!.trim(), '', 'nothing after the type: no NOT NULL, no DEFAULT, so no row is rewritten');
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, 1);
        for (const id of VARIANT_IDS) assert.ok(id.length <= 8, id);
    });

    it('is idempotent, creates no table and no index, and so has nothing to enable row level security on (conversations has it since v11)', () => {
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.deepEqual(createdTables(sql), []);
        assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX/);
        assert.match(readFileSync(path.join(CONFIG_DIR, 'migration_v11_rls.sql'), 'utf8'), /ALTER TABLE IF EXISTS conversations\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('alters a table that exists by the time it runs, and touches no other', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        assert.deepEqual([...new Set([...sql.matchAll(/ALTER TABLE (\w+) /g)].map((m) => m[1]!))], ['conversations']);
        assert.ok(existing.has('conversations'));
    });

    it('does not change a row: no UPDATE, no DELETE, no INSERT', () => {
        assert.doesNotMatch(sql, /\b(UPDATE|INSERT|TRUNCATE)\b|\bDELETE FROM\b|\bDROP TABLE\b/i);
    });
});

// ─── v44: the profile a TikTok connection keeps ────────────────────────────────────────────────

describe('migration v44: platform_connections.profile (TikTok user.info.profile, P33)', () => {
    const FILE = 'migration_v44_tiktok_profile.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');

    it('is registered after v42 (v43 may be taken by other work and land between), and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.ok(i > EXPECTED_MIGRATIONS.indexOf('migration_v42_dm_variant.sql'));
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, and that is its first line and first statement (it locks platform_connections, which the token refresh writes)', () => {
        assert.match(raw, /^SET LOCAL lock_timeout = '5s';/);
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('adds exactly one column to platform_connections: JSONB, nullable, no default, only if absent', () => {
        const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([A-Z]+(?:\(\d+\))?)([^;]*);/g)];
        assert.equal(added.length, 1);
        assert.deepEqual([added[0]![1], added[0]![2], added[0]![3]], ['platform_connections', 'profile', 'JSONB']);
        assert.equal(added[0]![4]!.trim(), '', 'nothing after the type: no NOT NULL, no DEFAULT, so no row is rewritten');
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, 1);
    });

    it('is idempotent, creates no table and no index, and so has nothing to enable row level security on (platform_connections has it since v18)', () => {
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.deepEqual(createdTables(sql), []);
        assert.doesNotMatch(sql, /CREATE (UNIQUE )?INDEX/);
        assert.match(readFileSync(path.join(CONFIG_DIR, 'migration_v18_tiktok.sql'), 'utf8'), /ALTER TABLE platform_connections\s+ENABLE ROW LEVEL SECURITY/);
    });

    it('alters a table that exists by the time it runs, and touches no other', () => {
        const before = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        const existing = new Set(allMigrationFiles().filter((f) => before.includes(f.name)).flatMap((f) => createdTables(f.sql)));
        assert.deepEqual([...new Set([...sql.matchAll(/ALTER TABLE (\w+) /g)].map((m) => m[1]!))], ['platform_connections']);
        assert.ok(existing.has('platform_connections'));
    });

    it('does not change a row: no UPDATE, no DELETE, no INSERT', () => {
        assert.doesNotMatch(sql, /\b(UPDATE|INSERT|TRUNCATE)\b|\bDELETE FROM\b|\bDROP TABLE\b/i);
    });
});

// ─── v50: WhatsApp as a channel (schema only) ──────────────────────────────────────────────────

describe('migration v50: whatsapp (channel CHECKs, contact and delivery columns, consents, usage ledger)', () => {
    const FILE = 'migration_v50_whatsapp.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');
    /** The files the runner applies before v50, in order. */
    const before = (): SqlFile[] => {
        const earlier = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        return allMigrationFiles().filter((f) => earlier.includes(f.name));
    };
    const quoted = (list: string): string[] => [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
    /** The columns the file adds, with everything written after each name. */
    const addedColumns = (): { table: string; name: string; spec: string }[] =>
        [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([^;]*);/g)].map((m) => ({ table: m[1]!, name: m[2]!, spec: m[3]!.trim() }));
    const addedTo = (table: string): string[] => addedColumns().filter((c) => c.table === table).map((c) => c.name);
    /** The values the newest earlier definition of a CHECK allowed (`CONSTRAINT name CHECK (... IN ('a', 'b'))`, inline or added). */
    const previousCheckValues = (name: string): string[] => {
        let found: string[] | null = null;
        for (const file of before()) {
            const body = new RegExp(`CONSTRAINT ${name}\\s+CHECK\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, 'g');
            for (const m of withoutComments(file.sql).replace(/\s+/g, ' ').matchAll(body)) found = quoted(m[1]!);
        }
        assert.ok(found, `an earlier migration defines ${name}`);
        return found;
    };
    /** The values the CHECK this file re-adds allows. */
    const checkValues = (name: string): string[] => {
        const m = new RegExp(`ADD CONSTRAINT ${name} CHECK \\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`).exec(sql);
        assert.ok(m, `${name} is re-added`);
        return quoted(m![1]!);
    };
    const droppedBeforeAdded = (name: string): boolean => {
        const drop = sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name};`);
        return drop >= 0 && drop < sql.indexOf(`ADD CONSTRAINT ${name} `);
    };

    it('is registered after v44 (v45-v49 belong to other work and may sit between), and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.ok(i > EXPECTED_MIGRATIONS.indexOf('migration_v44_tiktok_profile.sql'));
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, and that is its first line and first statement (it locks conversations and messages, the DM path\'s tables)', () => {
        assert.match(raw, /^SET LOCAL lock_timeout = '5s';/);
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('adds whatsapp to conversations.platform and keeps every value the newest earlier CHECK allowed', () => {
        const name = 'conversations_platform_check';
        const previous = previousCheckValues(name);
        assert.deepEqual(previous, ['instagram', 'facebook'], 'what v26 allowed');
        const now = checkValues(name);
        assert.ok(now.includes('whatsapp'));
        assert.deepEqual(now, [...previous, 'whatsapp']);
        assert.match(sql, /ADD CONSTRAINT conversations_platform_check CHECK \(platform IS NULL OR platform IN /, 'NULL stays allowed: a thread no DM has reached');
        assert.ok(droppedBeforeAdded(name), 'dropped by its exact name, then re-added');
    });

    it('adds whatsapp to platform_connections.platform and keeps every value the newest earlier CHECK allowed', () => {
        const name = 'platform_connections_platform_check';
        const previous = previousCheckValues(name);
        assert.deepEqual(previous, ['tiktok', 'youtube'], 'what v30 allowed');
        const now = checkValues(name);
        assert.ok(now.includes('whatsapp'));
        assert.deepEqual(now, [...previous, 'whatsapp']);
        assert.ok(droppedBeforeAdded(name), 'dropped by its exact name, then re-added');
    });

    it('leaves link_clicks.ua_class alone: a WhatsApp click is attributed through the link\'s conversation platform (review M1)', () => {
        assert.doesNotMatch(sql, /link_clicks|ua_class|tracked_links/);
    });

    it('adds exactly the columns the data model names, to exactly the tables it names', () => {
        assert.deepEqual(addedTo('platform_connections'), ['settings']);
        assert.deepEqual(addedTo('ai_agents'), ['whatsapp_mode', 'whatsapp_test_senders']);
        assert.deepEqual(addedTo('conversations'), ['wa_phone', 'wa_username', 'wa_parent_user_id', 'entry_source', 'free_window_expires_at']);
        assert.deepEqual(addedTo('messages'), [
            'delivery_status', 'delivery_error_code', 'delivery_error', 'pricing_category', 'pricing_type', 'billable', 'no_reply_reason', 'media_upload_id',
        ]);
        assert.equal(addedColumns().length, 1 + 2 + 5 + 8);
        // The contact's WhatsApp name is the existing conversations.profile_name (v40), not a second column.
        assert.doesNotMatch(sql, /contact_name/);
    });

    it('gives every added column the type the data model names', () => {
        assert.deepEqual(Object.fromEntries(addedColumns().map((c) => [`${c.table}.${c.name}`, c.spec])), {
            'platform_connections.settings': "JSONB NOT NULL DEFAULT '{}'::jsonb",
            'ai_agents.whatsapp_mode': "TEXT NOT NULL DEFAULT 'off'",
            'ai_agents.whatsapp_test_senders': "TEXT[] NOT NULL DEFAULT '{}'",
            'conversations.wa_phone': 'TEXT',
            'conversations.wa_username': 'TEXT',
            'conversations.wa_parent_user_id': 'TEXT',
            'conversations.entry_source': 'JSONB',
            'conversations.free_window_expires_at': 'TIMESTAMP WITH TIME ZONE',
            'messages.delivery_status': 'TEXT',
            'messages.delivery_error_code': 'INTEGER',
            'messages.delivery_error': 'TEXT',
            'messages.pricing_category': 'TEXT',
            'messages.pricing_type': 'TEXT',
            'messages.billable': 'BOOLEAN',
            'messages.no_reply_reason': 'TEXT',
            'messages.media_upload_id': 'UUID',
        });
    });

    it('rewrites no existing row: every added column is nullable or has a constant default, and none has an inline CHECK or REFERENCES', () => {
        for (const { table, name, spec } of addedColumns()) {
            const label = `${table}.${name}`;
            const defaults = [...spec.matchAll(/\bDEFAULT\s+(\S+)/g)].map((m) => m[1]!);
            assert.ok(!/\bNOT NULL\b/.test(spec) || defaults.length === 1, `${label} is NOT NULL, so it needs a default`);
            // A literal is stored in the catalog. A function (now(), gen_random_uuid()) would rewrite the table.
            for (const d of defaults) assert.match(d, /^'[^']*'(::\w+)?$/, `${label}: a constant default`);
            assert.doesNotMatch(spec, /\b(CHECK|REFERENCES|UNIQUE|PRIMARY|GENERATED)\b/, `${label}: constrained afterwards, by name, as v39 does`);
        }
    });

    it('defaults the agent\'s WhatsApp switch to OFF, and allows exactly off, test and everyone', () => {
        assert.deepEqual(checkValues('ai_agents_whatsapp_mode_check'), ['off', 'test', 'everyone']);
        assert.match(sql, /ADD CONSTRAINT ai_agents_whatsapp_mode_check CHECK \(whatsapp_mode IN \(/);
        assert.ok(droppedBeforeAdded('ai_agents_whatsapp_mode_check'));
    });

    it('allows exactly the delivery statuses WhatsApp reports, and NULL (every inbound row, and every row before this)', () => {
        assert.deepEqual(checkValues('messages_delivery_status_check'), ['sent', 'delivered', 'read', 'played', 'failed']);
        assert.match(sql, /ADD CONSTRAINT messages_delivery_status_check CHECK \(delivery_status IS NULL OR delivery_status IN \(/);
        assert.ok(droppedBeforeAdded('messages_delivery_status_check'));
    });

    it('creates exactly contact_consents and channel_usage, and enables row level security on both, with no policy', () => {
        assert.deepEqual(createdTables(sql), ['contact_consents', 'channel_usage']);
        assert.deepEqual([...rlsEnabledTables(raw)].sort(), ['channel_usage', 'contact_consents']);
        assert.doesNotMatch(sql, /\bCREATE POLICY\b|\bDISABLE ROW LEVEL SECURITY\b/i, 'deny by default: enabled, no policies');
        // The repo-wide rule agrees: no table is left to a later migration.
        assert.deepEqual(tablesWithoutRls(allMigrationFiles()), []);
    });

    it('declares the foreign keys with the ON DELETE rules the retention sweep and the erasure flow rely on', () => {
        // Every REFERENCES says what happens on delete: none is left to the default (NO ACTION), which would make a delete fail.
        const references = [...sql.matchAll(/REFERENCES (\w+)\((\w+)\)( ON DELETE (?:CASCADE|SET NULL))?/g)].map((m) => [m[1], m[2], m[3]?.trim()]);
        assert.deepEqual(references, [
            ['media_uploads', 'id', 'ON DELETE SET NULL'],
            ['creators', 'id', 'ON DELETE CASCADE'],
            ['conversations', 'id', 'ON DELETE SET NULL'],
            ['creators', 'id', 'ON DELETE CASCADE'],
        ]);
        assert.equal((sql.match(/\bREFERENCES\b/g) ?? []).length, references.length);
        // And to whom each belongs.
        assert.match(sql, /ALTER TABLE messages ADD CONSTRAINT messages_media_upload_id_fkey FOREIGN KEY \(media_upload_id\) REFERENCES media_uploads\(id\) ON DELETE SET NULL;/);
        assert.ok(droppedBeforeAdded('messages_media_upload_id_fkey'));
        assert.match(sql, /contact_consents \( id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\), creator_id UUID NOT NULL REFERENCES creators\(id\) ON DELETE CASCADE, conversation_id UUID REFERENCES conversations\(id\) ON DELETE SET NULL,/);
        assert.match(sql, /channel_usage \( creator_id UUID NOT NULL REFERENCES creators\(id\) ON DELETE CASCADE,/);
    });

    it('references columns of the same type: creators.id, conversations.id and media_uploads.id are UUIDs, and exist before v50', () => {
        const files = before();
        const existing = new Set(files.flatMap((f) => createdTables(f.sql)));
        for (const table of ['creators', 'conversations', 'media_uploads', 'messages', 'ai_agents', 'platform_connections']) assert.ok(existing.has(table), `${table} exists before v50`);
        const source = (name: string): string => files.find((f) => f.name === name)!.sql;
        assert.match(source('schema.sql'), /CREATE TABLE IF NOT EXISTS creators \(\s+id UUID PRIMARY KEY/);
        assert.match(source('schema_migration_v2.sql'), /CREATE TABLE IF NOT EXISTS conversations \(\s+id UUID PRIMARY KEY/);
        assert.match(source('migration_v7_media_uploads.sql'), /CREATE TABLE IF NOT EXISTS media_uploads \(\s+id UUID PRIMARY KEY/);
    });

    it('records consent as the data model says: constrained category, action and source, newest first per contact, one row per event', () => {
        const table = /CREATE TABLE IF NOT EXISTS contact_consents \(([^;]*)\);/.exec(sql)![1]!;
        for (const column of ['platform', 'contact_ref', 'category', 'action', 'source']) assert.match(table, new RegExp(`\\b${column} TEXT NOT NULL`), column);
        assert.match(table, /\bwording TEXT,/, 'the wording is optional');
        assert.match(table, /created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW\(\)/);
        const check = (column: string): string[] => quoted(new RegExp(`${column} TEXT NOT NULL CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(table)![1]!);
        assert.deepEqual(check('category'), ['service', 'updates', 'marketing']);
        assert.deepEqual(check('action'), ['granted', 'withdrawn']);
        assert.deepEqual(check('source'), ['agent_offer', 'stop_phrase', 'user_preferences', 'owner', 'in_app_signup']);
        assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_contact_consents_contact ON contact_consents \(creator_id, contact_ref, category, created_at DESC\);/);
        assert.doesNotMatch(sql, /CREATE UNIQUE INDEX/, 'many rows per contact; and a UNIQUE index named like an old one would silently no-op (v15)');
    });

    it('indexes messages.media_upload_id (partial, non-null only), so the FK\'s SET NULL does not scan messages for every upload the retention sweep deletes', () => {
        assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_messages_media_upload ON messages \(media_upload_id\) WHERE media_upload_id IS NOT NULL;/);
    });

    it('keeps the usage ledger one row per bucket: a composite primary key, and counters that start at zero', () => {
        const table = /CREATE TABLE IF NOT EXISTS channel_usage \(([^;]*)\);/.exec(sql)![1]!;
        assert.match(table, /PRIMARY KEY \(creator_id, platform, external_account_id, period, category, pricing_type, market\)/);
        assert.match(table, /delivered INTEGER NOT NULL DEFAULT 0,/);
        assert.match(table, /billable INTEGER NOT NULL DEFAULT 0,/);
        assert.match(table, /est_cost_usd NUMERIC\(10, 4\) NOT NULL DEFAULT 0,/);
        for (const column of ['platform', 'external_account_id', 'period', 'category', 'pricing_type', 'market']) assert.match(table, new RegExp(`\\b${column} TEXT NOT NULL`), column);
    });

    it('is idempotent: every column, table and index only if absent, and every constraint dropped by name before it is added', () => {
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, (sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length);
        assert.equal((sql.match(/CREATE INDEX/g) ?? []).length, (sql.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length);
        const added = [...sql.matchAll(/ALTER TABLE \w+ ADD CONSTRAINT (\w+) /g)].map((m) => m[1]!);
        assert.equal(added.length, 5, 'two platform CHECKs, the agent mode, the delivery status, and the media foreign key');
        for (const name of added) assert.ok(droppedBeforeAdded(name), `${name} is dropped by name first`);
        assert.doesNotMatch(sql, /CONCURRENTLY/, 'the runner applies each file inside a transaction, where it is refused');
    });

    it('alters tables that exist by the time it runs, and touches no other', () => {
        assert.deepEqual([...new Set([...sql.matchAll(/ALTER TABLE (\w+) /g)].map((m) => m[1]!))].sort(), [
            'ai_agents', 'channel_usage', 'contact_consents', 'conversations', 'messages', 'platform_connections',
        ]);
    });

    it('does not change a row: no UPDATE, no DELETE, no INSERT', () => {
        assert.doesNotMatch(sql, /\b(UPDATE|INSERT|TRUNCATE)\b|\bDELETE FROM\b|\bDROP TABLE\b|\bDROP COLUMN\b/i, 'a foreign key\'s ON DELETE SET NULL is not a DELETE');
    });
});

// ─── v51: customer media is private ────────────────────────────────────────────────────────────

describe('migration v51: private media (media_uploads.is_private)', () => {
    const FILE = 'migration_v51_private_media.sql';
    const raw = readFileSync(path.join(CONFIG_DIR, FILE), 'utf8');
    const sql = withoutComments(raw).replace(/\s+/g, ' ');
    /** The files the runner applies before v51, in order. */
    const before = (): SqlFile[] => {
        const earlier = EXPECTED_MIGRATIONS.slice(0, EXPECTED_MIGRATIONS.indexOf(FILE));
        return allMigrationFiles().filter((f) => earlier.includes(f.name));
    };

    it('is registered after v50 (v46-v49 belong to other work and may sit between), and a database without it reports it as pending', () => {
        const i = EXPECTED_MIGRATIONS.indexOf(FILE);
        assert.ok(i >= 0, 'it is in EXPECTED_MIGRATIONS');
        assert.ok(i > EXPECTED_MIGRATIONS.indexOf('migration_v50_whatsapp.sql'));
        assert.equal(compareSchema(EXPECTED_MIGRATIONS.filter((m) => m !== FILE)).pending[0], FILE);
    });

    it('gives up on a lock after 5 s, LOCAL to the runner\'s transaction, and that is its first line and first statement', () => {
        assert.match(raw, /^SET LOCAL lock_timeout = '5s';/);
        assert.equal(sql.split(';')[0]!.trim(), "SET LOCAL lock_timeout = '5s'");
        assert.doesNotMatch(sql, /\bSET\s+(SESSION\s+)?lock_timeout/i, 'no session-level setting');
    });

    it('adds exactly one column, is_private, to media_uploads: BOOLEAN NOT NULL with a CONSTANT default, so no row is rewritten and every existing upload stays public', () => {
        const added = [...sql.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS (\w+) ([^;]*);/g)].map((m) => [m[1], m[2], m[3]!.trim()]);
        assert.deepEqual(added, [['media_uploads', 'is_private', 'BOOLEAN NOT NULL DEFAULT false']]);
        assert.doesNotMatch(sql, /DEFAULT\s+(now|random|gen_random|uuid|clock|\()/i, 'a volatile default would rewrite the table');
    });

    it('is idempotent and cheap: IF NOT EXISTS, no index build, no row touched, nothing dropped', () => {
        assert.equal((sql.match(/ADD COLUMN/g) ?? []).length, (sql.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length);
        assert.doesNotMatch(sql, /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i, 'no index to build while holding a lock on media_uploads');
        assert.doesNotMatch(sql, /CONCURRENTLY/, 'the runner applies each file inside a transaction, where it is refused');
        assert.doesNotMatch(sql, /\b(UPDATE|INSERT|TRUNCATE)\b|\bDELETE FROM\b|\bDROP\b/i, 'it changes no row and removes nothing');
    });

    it('alters a table that exists by the time it runs, and no other', () => {
        const earlier = new Set(before().flatMap((f) => [...withoutComments(f.sql).matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/gi)].map((m) => m[1]!.toLowerCase())));
        assert.ok(earlier.has('media_uploads'));
        assert.deepEqual([...new Set([...sql.matchAll(/ALTER TABLE (\w+) /g)].map((m) => m[1]!))], ['media_uploads']);
    });

    it('creates no table, so there is no new table to enable row level security on', () => {
        assert.doesNotMatch(sql, /CREATE TABLE/i);
    });
});
