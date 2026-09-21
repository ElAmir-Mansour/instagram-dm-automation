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
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
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

        assert.deepEqual(state.pending, ['migration_v15_admin.sql']);
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
