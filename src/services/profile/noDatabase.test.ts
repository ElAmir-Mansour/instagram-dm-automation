/**
 * `forbidPool` (`noDatabase.ts`): what makes the live scripts' "read only through connectReadOnly" a property of the run
 * and not of the code as it stands today. The scripts' use of it is pinned in `scripts/profile-scripts.test.mjs`.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { readGrowthSettings } from '../growth/settingsRow.js';
import type { Exec } from '../studio/common.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { forbidPool, POOL_REFUSAL } from './noDatabase.js';
import { parityExitCode, runParity } from './parity.js';
import { profileFromLegacy } from './legacy.js';
import { loadProfile, loadStoredProfile } from './store.js';

const original = { query: pool.query, connect: pool.connect };
let restore: (() => void) | undefined;
afterEach(() => {
    restore?.();
    restore = undefined;
    assert.equal(pool.query, original.query, 'the pool is back as it was');
    assert.equal(pool.connect, original.connect);
});

describe('forbidPool', () => {
    it('makes the pool\'s query and connect throw, naming which was called, and the function it returns puts both back', async () => {
        restore = forbidPool();
        assert.notEqual(pool.query, original.query);
        await assert.rejects(pool.query('SELECT 1'), new RegExp(`${POOL_REFUSAL}.*pool\\.query was called`));
        await assert.rejects(pool.connect(), new RegExp(`${POOL_REFUSAL}.*pool\\.connect was called`));
        restore();
        restore = undefined;
        assert.equal(pool.query, original.query);
        assert.equal(pool.connect, original.connect);
    });

    it('a reader that reaches for the pool instead of the connection it was given fails loudly, by name', async () => {
        restore = forbidPool();
        // The default `exec` of every profile reader is the pool: this is the mistake it guards against.
        await assert.rejects(loadStoredProfile('00000000-0000-4000-8000-000000000001'), /closed to this script/);
        await assert.rejects(loadProfile('00000000-0000-4000-8000-000000000001'), /closed to this script/);
        await assert.rejects(readGrowthSettings(pool as unknown as Exec, '00000000-0000-4000-8000-000000000001'), /closed to this script/);
    });

    it('the whole parity run works under it: no builder reads the pool, and its own stand-in puts the stubs back, not the originals', async () => {
        restore = forbidPool();
        const stubs = { query: pool.query, connect: pool.connect };
        const report = await runParity({ studio: ELAMIR_SEED_SETTINGS, growth: ELAMIR_GROWTH, profile: profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH) });
        assert.equal(parityExitCode(report), 0, report.rows.filter((r) => !r.match).map((r) => r.name).join(', '));
        assert.equal(report.threw, 0, 'nothing tried the closed pool');
        assert.equal(pool.query, stubs.query, 'still closed after the Growth builders\' stand-in is done');
        assert.equal(pool.connect, stubs.connect);
    });
});
