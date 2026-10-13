/**
 * The profile store (docs/onboarding/01 §3 and §4), against a small in-memory stand-in for the four tables it
 * touches. The stand-in is deliberately a little more than a recorder: it applies the statements the store
 * sends (`INSERT … ON CONFLICT`, the optimistic `UPDATE … WHERE version`, the mirror's upserts with their
 * `SET` lists), and a `BEGIN` takes a snapshot that a `ROLLBACK` restores. So "a refused save leaves nothing
 * behind" and "the mirror never touches a column it does not own" are asserted on the rows, not on the SQL text.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { fromRow as growthFromRow, defaultGrowthSettings } from '../growth/settingsRow.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { defaultStudioSettings, overDefaults } from '../studio/settingsMerge.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { withProfileCache } from './cache.js';
import { defaultProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import {
    loadLegacyProfile, loadProfile, loadStoredProfile, ProfileError, resetProfileTableWarning, saveProfile, type SaveProfileOptions,
} from './store.js';
import { richProfile, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';
import { validateProfile } from './validate.js';
import { GROWTH_PROFILE_PATHS, growthView, STUDIO_PROFILE_PATHS, studioView } from './views.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

// ─── The stand-in ────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

interface State {
    profiles: Map<string, { profile: unknown; version: number; activated_at: Date | null; updated_by: string | null }>;
    versions: { creator_id: string; version: number; profile: unknown; source: string; updated_by: string | null }[];
    studio: Map<string, Row>;
    growth: Map<string, Row>;
}

const STUDIO_COLUMNS = ['brand', 'voice', 'product', 'cta', 'schedule', 'library', 'examples', 'monteur', 'infographic'] as const;
const GROWTH_COLUMNS = ['keywords', 'hashtag_sets', 'competitors', 'audience', 'goal_followers', 'goal_views'] as const;

const missingTable = (name: string): Error => Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });

/**
 * Every statement the store sends, answered from `state`. `v33` false is a database without the migration; `failOn`
 * makes a matching statement throw, as the database would, so a test can break a save halfway through.
 */
function installProfileDb(state: State, options: { v33?: boolean } = {}): FakeDb & { failOn: RegExp | null; snapshot: State | null; v33: boolean } {
    const db = installFakeDb() as FakeDb & { failOn: RegExp | null; snapshot: State | null; v33: boolean };
    db.failOn = null;
    db.snapshot = null;
    db.v33 = options.v33 ?? true;

    const copy = (s: State): State => structuredClone(s);
    const restore = (from: State): void => {
        state.profiles = from.profiles;
        state.versions = from.versions;
        state.studio = from.studio;
        state.growth = from.growth;
    };
    /** What `pg` hands back for a jsonb column: parsed, with its keys in Postgres's order. */
    const jsonb = <T>(value: T): T => throughJsonb(value);

    const entries = (list: string): string[] => list.split(',').map((s) => s.trim()).filter(Boolean);

    /** `INSERT INTO t (cols) VALUES (…) ON CONFLICT (creator_id) DO UPDATE SET …`, applied to `table`. */
    const upsert = (table: Map<string, Row>, sql: string, params: unknown[]): Row[] => {
        const columns = entries(/INSERT INTO \w+ \(([^)]*)\)/.exec(sql)![1]!);
        const tuple = entries(/VALUES \((.*)\) ON CONFLICT/.exec(sql)![1]!);
        assert.equal(columns.length, tuple.length, 'a value for every column');
        const inserted: Row = {};
        columns.forEach((column, i) => {
            const slot = tuple[i]!;
            const param = /^\$(\d+)(?:::(\w+))?$/.exec(slot);
            if (!param) inserted[column] = slot === 'NOW()' ? new Date() : slot;
            else if (param[2] === 'jsonb') inserted[column] = JSON.parse(params[Number(param[1]) - 1] as string);
            else inserted[column] = params[Number(param[1]) - 1];
        });
        const id = inserted.creator_id as string;
        const existing = table.get(id);
        if (!existing) {
            table.set(id, inserted);
            return [];
        }
        const set = entries(/DO UPDATE SET (.*)$/.exec(sql)![1]!);
        for (const assignment of set) {
            const [column, value] = assignment.split('=').map((s) => s.trim()) as [string, string];
            existing[column] = value === 'NOW()' ? new Date() : inserted[value.replace('EXCLUDED.', '')];
        }
        return [];
    };

    const route = (pattern: RegExp, answer: (params: any[], sql: string) => { rows: any[]; rowCount?: number }): void => {
        db.routes.push([pattern, answer]);
    };

    // Anything that fails on purpose, and anything that needs a table this database lacks, answers before the routes do.
    const guard = (pool as unknown as { query: (sql: string, params?: any[]) => Promise<unknown> }).query;
    const guarded = async (sql: string, params: any[] = []): Promise<unknown> => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        if (db.failOn?.test(flat)) {
            db.statements.push({ sql: flat, params });
            throw new Error(`injected failure on: ${flat.slice(0, 60)}`);
        }
        if (!db.v33 && /creator_profile/.test(flat)) {
            db.statements.push({ sql: flat, params });
            throw missingTable(/creator_profile_versions/.test(flat) ? 'creator_profile_versions' : 'creator_profiles');
        }
        return guard(sql, params);
    };
    (pool as unknown as { query: unknown }).query = guarded;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: guarded, release() {} });

    route(/^BEGIN$/, () => { db.snapshot = copy(state); return { rows: [] }; });
    route(/^COMMIT$/, () => { db.snapshot = null; return { rows: [] }; });
    route(/^ROLLBACK$/, () => { if (db.snapshot) restore(db.snapshot); db.snapshot = null; return { rows: [] }; });

    route(/^SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = \$1$/, ([id]) => {
        const row = state.profiles.get(id);
        return { rows: row ? [{ profile: jsonb(row.profile), version: row.version, activated_at: row.activated_at }] : [] };
    });
    route(/^SELECT profile, version FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE$/, ([id]) => {
        const row = state.profiles.get(id);
        return { rows: row ? [{ profile: jsonb(row.profile), version: row.version }] : [] };
    });
    route(/^INSERT INTO creator_profiles .* ON CONFLICT \(creator_id\) DO NOTHING RETURNING version$/, ([id, profile]) => {
        if (state.profiles.has(id)) return { rows: [] };
        state.profiles.set(id, { profile: JSON.parse(profile), version: 1, activated_at: null, updated_by: null });
        return { rows: [{ version: 1 }] };
    });
    route(/^UPDATE creator_profiles SET profile = \$2::jsonb, version = version \+ 1, updated_by = \$3, updated_at = NOW\(\) WHERE creator_id = \$1 AND version = \$4 RETURNING version$/, ([id, profile, by, expect]) => {
        const row = state.profiles.get(id);
        if (!row || row.version !== expect) return { rows: [] };
        row.profile = JSON.parse(profile);
        row.version += 1;
        row.updated_by = by;
        return { rows: [{ version: row.version }] };
    });
    route(/^INSERT INTO creator_profile_versions /, ([id, version, profile, source, by]) => {
        if (state.versions.some((v) => v.creator_id === id && v.version === version)) {
            throw Object.assign(new Error('duplicate key value violates unique constraint "creator_profile_versions_pkey"'), { code: '23505' });
        }
        state.versions.push({ creator_id: id, version, profile: JSON.parse(profile), source, updated_by: by });
        return { rows: [] };
    });

    route(/^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic FROM studio_settings WHERE creator_id = \$1$/, ([id]) => {
        const row = state.studio.get(id);
        return { rows: row ? [Object.fromEntries(STUDIO_COLUMNS.map((c) => [c, jsonb(row[c] ?? null)]))] : [] };
    });
    route(/^SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings WHERE creator_id = \$1$/, ([id]) => {
        const row = state.growth.get(id);
        // BIGINT arrives as a string, as `pg` returns it.
        return { rows: row ? [{ ...Object.fromEntries(GROWTH_COLUMNS.map((c) => [c, jsonb(row[c] ?? null)])), goal_views: String(row.goal_views) }] : [] };
    });
    route(/^INSERT INTO studio_settings /, (params, sql) => ({ rows: upsert(state.studio, sql, params) }));
    route(/^INSERT INTO growth_settings /, (params, sql) => ({ rows: upsert(state.growth, sql, params) }));

    return db;
}

const emptyState = (): State => ({ profiles: new Map(), versions: [], studio: new Map(), growth: new Map() });

/** A tenant's stored settings rows as Postgres holds them: one JSON column per section. */
function studioRow(settings: StudioSettings): Row {
    return Object.fromEntries(STUDIO_COLUMNS.map((c) => [c, structuredClone(settings[c])]));
}
function growthRow(settings: GrowthSettings): Row {
    return Object.fromEntries(GROWTH_COLUMNS.map((c) => [c, structuredClone(settings[c])]));
}

/** The owner's tenant: an Arabic row set LEFT to right, which the profile must not undo. */
const OWNER_STUDIO: StudioSettings = {
    ...ELAMIR_SEED_SETTINGS,
    brand: { ...ELAMIR_SEED_SETTINGS.brand, direction: 'ltr' },
    examples: [],
};

function seededState(): State {
    const state = emptyState();
    state.studio.set(OWNER, studioRow(OWNER_STUDIO));
    state.growth.set(OWNER, growthRow(ELAMIR_GROWTH));
    return state;
}

const SAVE: SaveProfileOptions = { expectVersion: null, source: 'wizard', userId: USER };
const save = (next: unknown, options: Partial<SaveProfileOptions> = {}, id = OWNER) => saveProfile(id, next, { ...SAVE, ...options });

/** Index of the first statement matching `pattern`, or -1. */
const at = (db: FakeDb, pattern: RegExp, from = 0): number => db.statements.findIndex((s, i) => i >= from && pattern.test(s.sql));
const writes = (db: FakeDb): string[] => db.statements.map((s) => s.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql));

let state: State;
let db: ReturnType<typeof installProfileDb>;
let logs: string[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    resetProfileTableWarning();
    logs = [];
    const previous = setLogSink((_level, line) => logs.push(line));
    restoreSink = () => setLogSink(previous);
    state = seededState();
    db = installProfileDb(state);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

/** What went wrong with `fn`, as the ProfileError it must be. */
async function refused(fn: () => Promise<unknown>, code: ProfileError['code'], status: number): Promise<ProfileError> {
    try {
        await fn();
    } catch (err) {
        assert.ok(err instanceof ProfileError, `a ProfileError, not ${String(err)}`);
        assert.equal(err.code, code);
        assert.equal(err.status, status);
        return err;
    }
    assert.fail(`expected ${code}`);
}

const storedProfile = (id = OWNER): CreatorProfile => state.profiles.get(id)!.profile as CreatorProfile;

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────

describe('loadStoredProfile', () => {
    it('is null for a tenant with no row, after one read', async () => {
        assert.equal(await loadStoredProfile(OWNER), null);
        assert.equal(db.statements.length, 1);
        assert.match(db.statements[0]!.sql, /^SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = \$1$/);
        assert.deepEqual(db.statements[0]!.params, [OWNER]);
    });

    it('reads the row through upgradeProfile: a profile written before a field existed gets its default', async () => {
        const full = richProfile();
        const { brand: _brand, ...older } = full; // a release that had no `brand` yet
        state.profiles.set(OWNER, { profile: older, version: 4, activated_at: new Date('2026-10-01T00:00:00Z'), updated_by: null });
        const read = await loadStoredProfile(OWNER);
        assert.ok(read);
        assert.equal(read.version, 4);
        assert.deepEqual(read.activated_at, new Date('2026-10-01T00:00:00Z'));
        assert.deepEqual(read.profile.brand, defaultProfile({ lang: 'ar' }).brand, 'the missing section reads as the default');
        assert.deepEqual(read.profile.identity, full.identity, 'what was stored is what is read');
        assert.deepEqual(read.repaired, [], 'a field a release adds is not a repair');
        assert.equal(read.newerSchema, false);
    });

    it('reports what it had to repair, and a newer schema', async () => {
        state.profiles.set(OWNER, { profile: { ...richProfile(), voice: { ...richProfile().voice, emoji: 'confetti' } }, version: 2, activated_at: null, updated_by: null });
        const repaired = await loadStoredProfile(OWNER);
        assert.deepEqual(repaired!.repaired, ['voice.emoji']);
        assert.equal(repaired!.profile.voice.emoji, 'light');

        state.profiles.set(OTHER, { profile: { ...richProfile(), schema: 2, future: { x: 1 } }, version: 9, activated_at: null, updated_by: null });
        const newer = await loadStoredProfile(OTHER);
        assert.equal(newer!.newerSchema, true);
        assert.deepEqual((newer!.profile as unknown as { future: unknown }).future, { x: 1 }, 'what a newer release stored is kept');
    });

    it('reads as no profile, logged once, on a database without v33', async () => {
        db.v33 = false;
        assert.equal(await loadStoredProfile(OWNER), null);
        assert.equal(await loadStoredProfile(OTHER), null);
        const warnings = logs.filter((l) => l.includes('profile.table_missing'));
        assert.equal(warnings.length, 1, 'once per process, not per call');
        assert.match(warnings[0]!, /migration_v33_creator_profiles\.sql/);
    });

    it('does not swallow anything else: another error, or the same code about another table', async () => {
        db.failOn = /creator_profiles/;
        await assert.rejects(loadStoredProfile(OWNER), /injected failure/);
        db.failOn = null;
        (pool as unknown as { query: unknown }).query = async () => { throw missingTable('infographics'); };
        await assert.rejects(loadStoredProfile(OWNER), /"infographics" does not exist/);
    });
});

describe('loadProfile', () => {
    it('is the stored profile, with its version, when there is one', async () => {
        state.profiles.set(OWNER, { profile: richProfile(), version: 3, activated_at: null, updated_by: USER });
        const loaded = await loadProfile(OWNER);
        assert.equal(loaded.version, 3);
        assert.deepEqual(loaded.profile, richProfile());
        assert.equal(db.ran(/studio_settings|growth_settings/).length, 0, 'the settings rows are not read when a profile is stored');
    });

    it('is the legacy profile, version null, for a tenant with none: read from the stored rows, written nowhere', async () => {
        const loaded = await loadProfile(OWNER);
        assert.equal(loaded.version, null);
        assert.equal(loaded.activated_at, null);
        assert.deepEqual(loaded.repaired, []);
        assert.equal(loaded.newerSchema, false);
        const expected = profileFromLegacy(overDefaults(throughJsonb(studioRow(OWNER_STUDIO))), growthFromRow(throughJsonb(growthRow(ELAMIR_GROWTH)) as unknown as GrowthSettings));
        assert.deepEqual(loaded.profile, expected);
        assert.equal(loaded.profile.language.primary, 'ar');
        assert.equal(loaded.profile.identity.timezone, 'Asia/Riyadh');
        assert.equal(loaded.profile.audience.timezone, 'Asia/Riyadh');
        assert.deepEqual(writes(db), [], 'a read never writes');
        assert.equal(state.profiles.size, 0);
    });

    it('is the legacy profile of the defaults for a tenant with no settings rows either', async () => {
        const loaded = await loadProfile(OTHER);
        assert.equal(loaded.version, null);
        assert.deepEqual(loaded.profile, profileFromLegacy(defaultStudioSettings(), defaultGrowthSettings()));
    });

    it('reads the settings rows itself: it does not go through getStudioSettings or getGrowthSettings', async () => {
        await loadProfile(OWNER);
        const sql = db.statements.map((s) => s.sql);
        assert.ok(sql.some((s) => /^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic FROM studio_settings/.test(s)));
        assert.ok(sql.some((s) => /^SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings/.test(s)));
    });

    it('is the legacy profile on a database without v33, which is what the tenant is until it has one', async () => {
        db.v33 = false;
        const loaded = await loadProfile(OWNER);
        assert.equal(loaded.version, null);
        assert.equal(loaded.profile.language.primary, 'ar');
    });

    it('loadLegacyProfile is that same profile, for the backfill to reuse', async () => {
        assert.deepEqual(await loadLegacyProfile(OWNER), (await loadProfile(OWNER)).profile);
    });
});

// ─── Saving ──────────────────────────────────────────────────────────────────────────────────

describe('saveProfile: a tenant that has no stored profile yet', () => {
    it('stores version 1 from the legacy settings first (source backfill), then the save as version 2', async () => {
        const legacy = await loadLegacyProfile(OWNER);
        const saved = await save(richProfile());

        assert.equal(saved.version, 2);
        assert.deepEqual(saved.profile, richProfile());
        assert.deepEqual(state.profiles.get(OWNER)!.profile, richProfile());
        assert.equal(state.profiles.get(OWNER)!.version, 2);
        assert.equal(state.profiles.get(OWNER)!.updated_by, USER);

        assert.deepEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[1, 'backfill', null], [2, 'wizard', USER]]);
        assert.deepEqual(state.versions[0]!.profile, legacy, 'version 1 is what the legacy settings described');
        assert.deepEqual(state.versions[1]!.profile, richProfile());
    });

    it('does it in one transaction, in this order', async () => {
        await save(richProfile());
        const order = [
            at(db, /^BEGIN$/),
            at(db, /FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE/),
            at(db, /^SELECT brand, voice/),
            at(db, /^INSERT INTO creator_profiles .* DO NOTHING/),
            at(db, /^INSERT INTO creator_profile_versions/),
            at(db, /^UPDATE creator_profiles/),
            at(db, /^INSERT INTO studio_settings/),
            at(db, /^INSERT INTO growth_settings/),
            at(db, /^COMMIT$/),
        ];
        assert.ok(order.every((i) => i >= 0), `every step ran: ${order}`);
        assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in order');
        assert.equal(at(db, /^ROLLBACK$/), -1);
        const versionInserts = db.statements.filter((s) => /^INSERT INTO creator_profile_versions/.test(s.sql));
        assert.deepEqual(versionInserts.map((s) => s.params[1]), [1, 2]);
        assert.ok(at(db, /^INSERT INTO creator_profile_versions/) < at(db, /^UPDATE creator_profiles/), 'the backfill is stored before the save');
    });

    it('a caller that read the virtual profile (expectVersion null) is the one this very save created version 1 for', async () => {
        const saved = await save(richProfile(), { expectVersion: null });
        assert.equal(saved.version, 2);
    });

    it('a profile stored since the caller read the virtual one is a conflict, and nothing is written', async () => {
        state.profiles.set(OWNER, { profile: richProfile(), version: 1, activated_at: null, updated_by: null });
        const err = await refused(() => save({ ...richProfile(), goals: { followers: 1, views: 1 } }, { expectVersion: null }), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(err.detail.currentVersion, 1);
        assert.deepEqual(storedProfile(), richProfile());
        assert.equal(state.profiles.get(OWNER)!.version, 1);
        assert.deepEqual(state.versions, []);
        assert.deepEqual(writes(db), [], 'no write was even attempted');
    });

    it('a stale number for a row that was not there is a conflict too, and the backfill goes with it', async () => {
        await refused(() => save(richProfile(), { expectVersion: 5 }), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(state.profiles.size, 0, 'the version-1 insert was rolled back');
        assert.deepEqual(state.versions, []);
        assert.ok(at(db, /^ROLLBACK$/) > 0);
    });
});

describe('saveProfile: the version check', () => {
    beforeEach(() => {
        state.profiles.set(OWNER, { profile: defaultProfile(), version: 3, activated_at: null, updated_by: null });
    });

    it('writes version + 1 when the caller read the stored version', async () => {
        const saved = await save(richProfile(), { expectVersion: 3, source: 'user' });
        assert.equal(saved.version, 4);
        assert.equal(state.profiles.get(OWNER)!.version, 4);
        assert.deepEqual(storedProfile(), richProfile());
        assert.deepEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[4, 'user', USER]]);
    });

    it('refuses an old version, names the current one, and changes nothing', async () => {
        const err = await refused(() => save(richProfile(), { expectVersion: 2 }), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(err.detail.currentVersion, 3);
        assert.match(err.message, /changed since you opened it/);
        assert.deepEqual(storedProfile(), defaultProfile());
        assert.equal(state.profiles.get(OWNER)!.version, 3);
        assert.deepEqual(state.versions, []);
        assert.deepEqual(state.studio.get(OWNER), studioRow(OWNER_STUDIO), 'the mirror did not run either');
    });

    it('refuses a version from the future too: it is not "at least"', async () => {
        await refused(() => save(richProfile(), { expectVersion: 4 }), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(state.profiles.get(OWNER)!.version, 3);
    });

    it('two saves from the same version: the second loses', async () => {
        await save(richProfile(), { expectVersion: 3 });
        await refused(() => save({ ...richProfile(), goals: { followers: 9, views: 9 } }, { expectVersion: 3 }), 'PROFILE_VERSION_CONFLICT', 409);
        assert.equal(state.profiles.get(OWNER)!.version, 4);
        assert.deepEqual((storedProfile()).goals, richProfile().goals, 'the first save is what is stored');
        assert.equal(state.versions.length, 1);
    });

    it('asks the database to make the check, in the UPDATE, and locks the row for the transaction', async () => {
        await save(richProfile(), { expectVersion: 3 });
        const update = db.statements.find((s) => /^UPDATE creator_profiles/.test(s.sql))!;
        assert.match(update.sql, /SET profile = \$2::jsonb, version = version \+ 1, updated_by = \$3, updated_at = NOW\(\) WHERE creator_id = \$1 AND version = \$4 RETURNING version/);
        assert.deepEqual([update.params[0], update.params[2], update.params[3]], [OWNER, USER, 3]);
        assert.doesNotMatch(update.sql, /activated_at/, 'saving never activates: finishing the wizard does');
        assert.ok(at(db, /FOR UPDATE/) > 0 && at(db, /FOR UPDATE/) < at(db, /^UPDATE creator_profiles/));
    });

    it('the system (no user) saves with updated_by null', async () => {
        await save(richProfile(), { expectVersion: 3, source: 'admin', userId: null });
        assert.equal(state.profiles.get(OWNER)!.updated_by, null);
        assert.deepEqual(state.versions.map((v) => [v.source, v.updated_by]), [['admin', null]]);
    });
});

describe('saveProfile: a profile from a newer release', () => {
    it('is refused, and left exactly as it is', async () => {
        const newer = { ...richProfile(), schema: 2, future: { kept: true } };
        state.profiles.set(OWNER, { profile: newer, version: 7, activated_at: null, updated_by: null });
        const err = await refused(() => save(richProfile(), { expectVersion: 7 }), 'PROFILE_NEWER_SCHEMA', 409);
        assert.match(err.message, /newer version of the app/);
        assert.equal(err.detail.currentVersion, 7);
        assert.deepEqual(state.profiles.get(OWNER)!.profile, newer);
        assert.equal(state.profiles.get(OWNER)!.version, 7);
        assert.deepEqual(state.versions, []);
        assert.deepEqual(writes(db), []);
    });

    it('is refused before the profile is even looked at, so an invalid one gets this answer, not a list of problems', async () => {
        state.profiles.set(OWNER, { profile: { ...richProfile(), schema: 2 }, version: 7, activated_at: null, updated_by: null });
        await refused(() => save({ nonsense: true }, { expectVersion: 7 }), 'PROFILE_NEWER_SCHEMA', 409);
    });
});

describe('saveProfile: validation', () => {
    it('refuses an invalid profile with every problem, as a 400', async () => {
        state.profiles.set(OWNER, { profile: defaultProfile(), version: 1, activated_at: null, updated_by: null });
        const bad = { ...richProfile(), brand: { ...richProfile().brand, primary: 'red' }, goals: { followers: 0, views: -1 } };
        const err = await refused(() => save(bad, { expectVersion: 1 }), 'PROFILE_INVALID', 400);
        assert.ok(err.detail.problems!.length >= 2, `all of them: ${err.detail.problems}`);
        assert.ok(err.detail.problems!.some((p) => p.includes('brand.primary')));
        assert.match(err.message, /problems with this profile/);
        assert.deepEqual(storedProfile(), defaultProfile());
        assert.equal(state.profiles.get(OWNER)!.version, 1);
        assert.deepEqual(state.versions, []);
    });

    it('a single problem is the message itself', async () => {
        state.profiles.set(OWNER, { profile: defaultProfile(), version: 1, activated_at: null, updated_by: null });
        const err = await refused(() => save({ ...richProfile(), brand: { ...richProfile().brand, accent: 'blue' } }, { expectVersion: 1 }), 'PROFILE_INVALID', 400);
        assert.equal(err.detail.problems!.length, 1);
        assert.equal(err.message, err.detail.problems![0]);
    });

    it('leaves nothing behind for a tenant that had no row: the version-1 insert is rolled back with the refusal', async () => {
        await refused(() => save({ nonsense: true }), 'PROFILE_INVALID', 400);
        assert.equal(state.profiles.size, 0);
        assert.deepEqual(state.versions, []);
        assert.ok(at(db, /^ROLLBACK$/) > 0 && at(db, /^COMMIT$/) === -1);
    });

    it('saves what validateProfile returned, not the object it was handed', async () => {
        const next = richProfile();
        const saved = await save(next);
        next.identity.niche = 'changed after the save';
        assert.notEqual(saved.profile.identity.niche, next.identity.niche);
        assert.equal(storedProfile().identity.niche, richProfile().identity.niche);
    });

    it('the fixture itself is a valid profile, or none of this proves anything', () => {
        assert.ok('profile' in validateProfile(richProfile()));
    });
});

describe('saveProfile: the mirror into the settings rows', () => {
    /** The sections of a statement's `DO UPDATE SET` list, without the bookkeeping column. */
    const setList = (pattern: RegExp): string[] => {
        const sql = db.statements.find((s) => pattern.test(s.sql))!.sql;
        return [.../DO UPDATE SET (.*)$/.exec(sql)![1]!.matchAll(/(\w+) = EXCLUDED\.\1/g)].map((m) => m[1]!);
    };
    const firstSegment = (paths: readonly string[]): string[] => [...new Set(paths.map((p) => p.split('.')[0]!))];

    it('writes exactly the sections that hold a profile-owned field, and no others', async () => {
        await save(richProfile());
        assert.deepEqual(setList(/^INSERT INTO studio_settings/), firstSegment(STUDIO_PROFILE_PATHS), 'Studio: the sections of STUDIO_PROFILE_PATHS');
        assert.deepEqual(setList(/^INSERT INTO growth_settings/), firstSegment(GROWTH_PROFILE_PATHS), 'Growth: the columns of GROWTH_PROFILE_PATHS');
        assert.deepEqual(firstSegment(STUDIO_PROFILE_PATHS), ['brand', 'voice', 'product', 'schedule', 'infographic']);
        for (const column of ['cta', 'library', 'examples', 'monteur']) assert.ok(!setList(/^INSERT INTO studio_settings/).includes(column), `${column} is not rewritten`);
        for (const column of ['keywords', 'hashtag_sets', 'competitors']) assert.ok(!setList(/^INSERT INTO growth_settings/).includes(column), `${column} is not rewritten`);
    });

    it('writes the profile into those sections, over what the row holds', async () => {
        const saved = await save(richProfile());
        const before = overDefaults(throughJsonb(studioRow(OWNER_STUDIO)));
        const expected = studioView(before, saved.profile);
        const row = state.studio.get(OWNER)!;
        for (const section of ['brand', 'voice', 'product', 'schedule', 'infographic'] as const) {
            assert.deepEqual(row[section], expected[section], section);
        }
        // Spot-check the profile's own values arrived, whatever the view does with them.
        assert.equal((row.brand as StudioSettings['brand']).name, 'Sami Fit Studio');
        assert.equal((row.voice as StudioSettings['voice']).language, 'ar');
        assert.equal((row.product as StudioSettings['product']).name, 'Twelve-week program');
        assert.equal((row.schedule as StudioSettings['schedule']).timezone, 'Africa/Cairo');
        assert.equal((row.infographic as StudioSettings['infographic']).handle, '@sami.fit');
        const growth = state.growth.get(OWNER)!;
        assert.deepEqual(growth.audience, { countries: ['EG', 'SA'], languages: ['ar', 'en'], timezone: 'Asia/Dubai' });
        assert.equal(growth.goal_followers, 5000);
        assert.equal(growth.goal_views, 250_000);
    });

    it('leaves every field the profile does not own exactly as the row had it', async () => {
        await save(richProfile());
        const row = state.studio.get(OWNER)!;
        const was = studioRow(OWNER_STUDIO);
        // Whole sections it does not touch.
        for (const column of ['cta', 'library', 'examples', 'monteur']) assert.deepEqual(row[column], was[column], column);
        // And the fields inside the sections it does.
        const brand = row.brand as StudioSettings['brand'];
        const brandWas = was.brand as StudioSettings['brand'];
        assert.equal(brand.direction, 'ltr', 'an Arabic row set left to right stays so: brand.direction is a Studio setting');
        assert.deepEqual(brand.palette, brandWas.palette);
        assert.deepEqual(brand.signature, brandWas.signature);
        assert.deepEqual(brand.colors, brandWas.colors);
        assert.equal(brand.theme, brandWas.theme);
        assert.equal(brand.fonts.mono, brandWas.fonts.mono);
        assert.deepEqual((row.schedule as StudioSettings['schedule']).slots, (was.schedule as StudioSettings['schedule']).slots);
        assert.deepEqual((row.infographic as StudioSettings['infographic']).platforms, (was.infographic as StudioSettings['infographic']).platforms);
        const growth = state.growth.get(OWNER)!;
        for (const column of ['keywords', 'hashtag_sets', 'competitors']) assert.deepEqual(growth[column], growthRow(ELAMIR_GROWTH)[column], column);
    });

    it('is the view of the profile: reading the mirrored rows back gives the profile\'s own facts', async () => {
        const saved = await save(richProfile());
        const studio = overDefaults(throughJsonb(state.studio.get(OWNER)!) as never);
        const growth = growthFromRow(throughJsonb(state.growth.get(OWNER)!) as unknown as GrowthSettings);
        // Applying the view to what the mirror wrote changes nothing: a rollback finds the profile's facts in the rows.
        assert.deepEqual(studioView(studio, saved.profile), studio);
        assert.deepEqual(growthView(growth, saved.profile), growth);
    });

    it('creates the settings rows a tenant does not have, with the defaults for what the profile does not own', async () => {
        await save(richProfile(), {}, OTHER);
        const studio = state.studio.get(OTHER)!;
        assert.deepEqual(studio.cta, defaultStudioSettings().cta);
        assert.deepEqual(studio.library, defaultStudioSettings().library);
        assert.equal((studio.brand as StudioSettings['brand']).name, 'Sami Fit Studio');
        assert.equal(studio.examples, undefined, 'the built-in examples stay the built-in examples: no list is invented');
        assert.equal(studio.monteur, undefined);
        const growth = state.growth.get(OTHER)!;
        assert.deepEqual(growth.audience, { countries: ['EG', 'SA'], languages: ['ar', 'en'], timezone: 'Asia/Dubai' });
        assert.equal(growth.keywords, undefined, 'the column defaults apply');
        // Read back, the tenant is what the profile says.
        assert.deepEqual(overDefaults(throughJsonb(studio) as never).cta, defaultStudioSettings().cta);
    });

    it('is part of the transaction: a failure in the mirror takes the whole save back', async () => {
        db.failOn = /^INSERT INTO growth_settings/;
        await assert.rejects(save(richProfile()), /injected failure/);
        assert.equal(state.profiles.size, 0, 'no profile');
        assert.deepEqual(state.versions, [], 'no history');
        assert.deepEqual(state.studio.get(OWNER), studioRow(OWNER_STUDIO), 'and the Studio mirror that ran before it is undone');
        assert.deepEqual(state.growth.get(OWNER), growthRow(ELAMIR_GROWTH));
        assert.ok(at(db, /^ROLLBACK$/) > 0 && at(db, /^COMMIT$/) === -1);
    });
});

describe('saveProfile: where it runs', () => {
    it('opens and commits its own transaction on the pool, and releases the connection', async () => {
        await save(richProfile());
        assert.equal(db.statements.filter((s) => /^BEGIN$/.test(s.sql)).length, 1);
        assert.equal(db.statements.filter((s) => /^COMMIT$/.test(s.sql)).length, 1);
    });

    it('inside a caller\'s own transaction (any client but the pool) it opens none, and commits nothing', async () => {
        const calls: string[] = [];
        const client = { query: (sql: string, params?: unknown[]) => { calls.push(sql.replace(/\s+/g, ' ').trim()); return (pool as unknown as { query: (s: string, p?: unknown[]) => Promise<never> }).query(sql, params); } };
        const saved = await saveProfile(OWNER, richProfile(), SAVE, client as never);
        assert.equal(saved.version, 2);
        assert.equal(calls.filter((c) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(c)).length, 0);
        assert.ok(calls.some((c) => /^UPDATE creator_profiles/.test(c)), 'its statements went through the client it was given');
        assert.ok(calls.some((c) => /^INSERT INTO studio_settings/.test(c)));
    });

    it('answers PROFILE_STORAGE_MISSING (503) on a database without v33, naming the migration', async () => {
        db.v33 = false;
        const err = await refused(() => save(richProfile()), 'PROFILE_STORAGE_MISSING', 503);
        assert.match(err.message, /migration v33/);
        assert.ok(at(db, /^ROLLBACK$/) > 0);
    });

    it('does not mistake some other missing table for it', async () => {
        db.failOn = /^SELECT brand, voice/;
        await assert.rejects(save(richProfile()), (err: unknown) => !(err instanceof ProfileError));
    });
});

// ─── The cache ───────────────────────────────────────────────────────────────────────────────

describe('the per-request cache, through the store', () => {
    const reads = (): number => db.statements.filter((s) => /^SELECT profile, version, activated_at FROM creator_profiles/.test(s.sql)).length;
    beforeEach(() => {
        state.profiles.set(OWNER, { profile: richProfile(), version: 1, activated_at: null, updated_by: null });
    });

    it('hits: the second read in a request is not a query', async () => {
        await withProfileCache(async () => {
            const first = await loadStoredProfile(OWNER);
            const second = await loadStoredProfile(OWNER);
            assert.equal(reads(), 1);
            assert.deepEqual(second, first);
        });
    });

    it('misses outside a request: tests, scripts and workers always read', async () => {
        await loadStoredProfile(OWNER);
        await loadStoredProfile(OWNER);
        assert.equal(reads(), 2);
    });

    it('misses for a different tenant, and for a tenant with no row (null is cached too)', async () => {
        await withProfileCache(async () => {
            await loadStoredProfile(OWNER);
            await loadStoredProfile(OTHER);
            await loadStoredProfile(OTHER);
            assert.equal(reads(), 2);
        });
    });

    it('is bypassed by a transaction client: it reads the database, and neither fills nor uses the cache', async () => {
        await withProfileCache(async () => {
            const client = { query: (sql: string, params?: unknown[]) => (pool as unknown as { query: (s: string, p?: unknown[]) => Promise<never> }).query(sql, params) };
            await loadStoredProfile(OWNER, client as never);
            await loadStoredProfile(OWNER, client as never);
            assert.equal(reads(), 2, 'twice, through the client');
            await loadStoredProfile(OWNER);
            assert.equal(reads(), 3, 'and the pool read after them was a real read, not an answer a transaction left behind');
            await loadStoredProfile(OWNER);
            assert.equal(reads(), 3);
        });
    });

    it('hands every caller its own copy: one that edits its profile edits nobody else\'s', async () => {
        await withProfileCache(async () => {
            const first = (await loadStoredProfile(OWNER))!;
            first.profile.identity.niche = 'vandalised';
            first.profile.offers.length = 0;
            const second = (await loadStoredProfile(OWNER))!;
            assert.equal(second.profile.identity.niche, richProfile().identity.niche);
            assert.equal(second.profile.offers.length, 2);
            assert.equal(reads(), 1);
        });
    });

    it('is cleared for that tenant by a save, so the next read sees the new version', async () => {
        await withProfileCache(async () => {
            assert.equal((await loadStoredProfile(OWNER))!.version, 1);
            await loadStoredProfile(OTHER);
            const saved = await save({ ...richProfile(), goals: { followers: 9, views: 9 } }, { expectVersion: 1 });
            assert.equal(saved.version, 2);
            const after = (await loadStoredProfile(OWNER))!;
            assert.equal(after.version, 2);
            assert.deepEqual(after.profile.goals, { followers: 9, views: 9 });
            const readsOfOther = db.statements.filter((s) => /creator_profiles/.test(s.sql) && s.params[0] === OTHER && /^SELECT profile, version, activated_at/.test(s.sql)).length;
            assert.equal(readsOfOther, 1, 'the other tenant\'s entry was left alone');
        });
    });

    it('is cleared by a refused save too: whatever the save found is not what the next reader should assume', async () => {
        await withProfileCache(async () => {
            await loadStoredProfile(OWNER);
            await refused(() => save(richProfile(), { expectVersion: 99 }), 'PROFILE_VERSION_CONFLICT', 409);
            await loadStoredProfile(OWNER);
            assert.equal(reads(), 2);
        });
    });

    it('does not keep a failed read: the next one asks again', async () => {
        await withProfileCache(async () => {
            db.failOn = /^SELECT profile, version, activated_at FROM creator_profiles/;
            await assert.rejects(loadStoredProfile(OWNER), /injected failure/);
            db.failOn = null;
            assert.equal((await loadStoredProfile(OWNER))!.version, 1);
        });
    });

    it('loadProfile is cached through it: a stored profile is one query however many ask', async () => {
        await withProfileCache(async () => {
            await loadProfile(OWNER);
            await loadProfile(OWNER);
            await loadStoredProfile(OWNER);
            assert.equal(reads(), 1);
        });
    });
});
