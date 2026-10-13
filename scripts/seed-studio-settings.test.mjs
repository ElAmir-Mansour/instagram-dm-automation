/**
 * The Studio seed script refuses a tenant that has a stored Creator Profile, with or without `--force`.
 *
 * For such a tenant the settings the profile owns are a mirror of it: the readers show the profile's values, so a SQL write
 * to those columns is hidden, and the next save through the profile writes the profile's values back over it. The seed
 * writes exactly those columns (brand, voice, product, schedule, infographic), so after the backfill it must not write at all.
 * What is held here, against a stand-in pool that records every statement: the refusal, that `--force` does not skip it,
 * that nothing is written when it fires, that a tenant without a profile (or a database without v33) is seeded as before,
 * and, by reading the source, that the profile check is made before the settings check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { profileRefusal, seedTenant, storedProfileVersion } from './seed-studio-settings.mjs';

const TENANT = '06026423-ad15-45d7-8d02-4bc122a6bcff';

/** A pool that answers the three lookups the script makes, and records everything it is asked. */
function standIn({ creator = true, profileVersion = null, settings = false, v33 = true } = {}) {
    const statements = [];
    return {
        statements,
        async query(sql, params = []) {
            const flat = sql.replace(/\s+/g, ' ').trim();
            statements.push({ sql: flat, params });
            if (/FROM creators/.test(flat)) return { rows: creator ? [{ id: TENANT, name: 'ElAmir' }] : [] };
            if (/FROM creator_profiles/.test(flat)) {
                if (!v33) throw Object.assign(new Error('relation "creator_profiles" does not exist'), { code: '42P01' });
                return { rows: profileVersion === null ? [] : [{ version: profileVersion }] };
            }
            if (/FROM studio_settings/.test(flat)) return { rows: settings ? [{ updated_at: new Date('2026-10-01T00:00:00Z') }] : [] };
            if (/^INSERT INTO studio_settings/.test(flat)) return { rows: [] };
            throw new Error(`unexpected statement: ${flat}`);
        },
    };
}
const writes = (pool) => pool.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql));

describe('a tenant with a stored profile is never seeded', () => {
    it('is refused, and nothing is written', async () => {
        const pool = standIn({ profileVersion: 3 });
        const out = await seedTenant(pool, TENANT);
        assert.equal(out.status, 'refused');
        assert.deepEqual(writes(pool), []);
    });

    it('is refused with --force too, which only overrides settings the tenant saved', async () => {
        for (const settings of [false, true]) {
            const pool = standIn({ profileVersion: 1, settings });
            const out = await seedTenant(pool, TENANT, { force: true });
            assert.equal(out.status, 'refused', `settings saved: ${settings}`);
            assert.deepEqual(writes(pool), [], `settings saved: ${settings}`);
        }
    });

    it('says why, in terms the operator can act on', async () => {
        const { message } = await seedTenant(standIn({ profileVersion: 7 }), TENANT, { force: true });
        assert.equal(message, profileRefusal(TENANT, 7));
        assert.match(message, /stored Creator Profile \(version 7\)/);
        assert.match(message, /--force does not override that/);
        assert.match(message, /mirror of the profile/);
        assert.match(message, /hidden/);
        assert.match(message, /Edit them in the dashboard, or through saveProfile/);
        assert.match(message, /STUDIO_PROFILE_PATHS/);
    });

    it('asks for the profile before it looks at the saved settings', async () => {
        const pool = standIn({ profileVersion: 2, settings: true });
        await seedTenant(pool, TENANT, { force: true });
        const order = pool.statements.map((s) => /FROM (\w+)/.exec(s.sql)?.[1]);
        assert.ok(order.indexOf('creator_profiles') >= 0);
        assert.ok(!order.includes('studio_settings'), 'refused before the settings were even read');
    });

    it('is checked before anything is written, in the source: the profile lookup precedes the settings lookup and the INSERT', () => {
        const src = readFileSync(new URL('./seed-studio-settings.mjs', import.meta.url), 'utf8');
        const body = src.slice(src.indexOf('export async function seedTenant'));
        const profile = body.indexOf('storedProfileVersion(pool, creatorId)');
        assert.ok(profile > 0);
        assert.ok(profile < body.indexOf('FROM studio_settings'));
        assert.ok(profile < body.indexOf('INSERT INTO studio_settings'));
        const beforeSettings = body.slice(body.indexOf('const creator = await'), body.indexOf('const existing'));
        assert.doesNotMatch(beforeSettings, /force/, 'force is not consulted before the profile refusal');
    });
});

describe('a tenant without a stored profile is seeded as before', () => {
    it('writes the settings once', async () => {
        const pool = standIn();
        const out = await seedTenant(pool, TENANT);
        assert.equal(out.status, 'seeded');
        assert.equal(writes(pool).length, 1);
        assert.match(writes(pool)[0].sql, /^INSERT INTO studio_settings/);
    });

    it('still refuses saved settings without --force, and replaces them with it', async () => {
        const saved = standIn({ settings: true });
        assert.equal((await seedTenant(saved, TENANT)).status, 'refused');
        assert.deepEqual(writes(saved), []);
        const forced = standIn({ settings: true });
        assert.equal((await seedTenant(forced, TENANT, { force: true })).status, 'seeded');
        assert.equal(writes(forced).length, 1);
    });

    it('a database that has not had v33 applied has no profile to refuse for', async () => {
        const pool = standIn({ v33: false });
        assert.equal(await storedProfileVersion(pool, TENANT), null);
        assert.equal((await seedTenant(pool, TENANT)).status, 'seeded');
    });

    it('any other error from the profile lookup is not swallowed', async () => {
        const pool = { query: async () => { throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }); } };
        await assert.rejects(storedProfileVersion(pool, TENANT), /connection reset/);
    });

    it('no such creator is reported as that, before the profile is looked up', async () => {
        const pool = standIn({ creator: false });
        const out = await seedTenant(pool, TENANT);
        assert.equal(out.status, 'missing');
        assert.equal(pool.statements.length, 1);
    });
});
