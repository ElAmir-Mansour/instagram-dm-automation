/**
 * The settings readers overlay the stored profile (docs/onboarding/01 §0.1, §4; P4).
 *
 * `getStudioSettings` and `getGrowthSettings` keep their SQL and their callers; what changed is that a tenant with a
 * stored profile gets the stored row with the profile-owned fields replaced from it (`studioView` / `growthView`).
 * What is pinned here:
 *   - the view is what comes back, and only the profile-owned fields come from the profile;
 *   - a tenant WITHOUT a stored profile gets its row exactly as before, byte for byte, with no virtual overlay (so
 *     an owned field that is "wrong" in the row is still read as it is);
 *   - a profile from a newer release is not overlaid, and says so once;
 *   - the statement order (the row first, by the same SQL as before), the per-request cache, a transaction client;
 *   - `getMonteurSettings`' narrow timezone read agrees with the reader across every shape a stored timezone can have.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { type GrowthSettings, type StudioSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { defaultGrowthSettings, fromRow } from '../growth/settingsRow.js';
import { getGrowthSettings, resetGoalColumnsWarning } from '../growth/settings.js';
import { defaultStudioSettings, overDefaults } from '../studio/settingsMerge.js';
import { getMonteurSettings, getStudioSettings, updateStudioSettings } from '../studio/settings.js';
import { ELAMIR_GROWTH } from '../studio/testFixtures.js';
import { withProfileCache } from './cache.js';
import { profileFromLegacy } from './legacy.js';
import { resetProfileTableWarning, resetProfileWarnings, saveProfile } from './store.js';
import {
    growthRow, installProfileDb, OTHER, OWNER, OWNER_STUDIO, type ProfileDb, seededState, studioRow, type State,
} from './testDb.js';
import { leafPaths, richProfile, scramble, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';
import { changedPaths, GROWTH_PROFILE_PATHS, growthView, STUDIO_PROFILE_PATHS, studioView } from './views.js';

let state: State;
let db: ProfileDb;
let events: { level: string; event: string; fields: Record<string, unknown> }[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    events = [];
    const previous = setLogSink((level, line) => { const fields = JSON.parse(line); events.push({ level, event: fields.event, fields }); });
    restoreSink = () => setLogSink(previous);
    resetProfileWarnings();
    resetProfileTableWarning();
    resetGoalColumnsWarning();
    state = seededState();
    db = installProfileDb(state);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const sql = (): string[] => db.statements.map((s) => s.sql);
const logged = (event: string): number => events.filter((e) => e.event === event).length;

/** A stored profile as the database holds it: serialised, keys in jsonb's order. */
function store(creatorId: string, profile: unknown, version = 1): void {
    state.profiles.set(creatorId, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
}

/** The row as the reader sees it before any overlay: what `getStudioSettings` returned before P4. */
const todayStudio = (id: string): StudioSettings => {
    const row = state.studio.get(id);
    return row ? overDefaults(throughJsonb(row) as never) : defaultStudioSettings();
};
const todayGrowth = (id: string): GrowthSettings => {
    const row = state.growth.get(id);
    return row ? fromRow(throughJsonb(row) as never) : defaultGrowthSettings();
};

/** Deep equal AND the same bytes: the prompts print some of these objects as JSON, so key order is part of the value. */
function sameBytes(actual: unknown, expected: unknown, message: string): void {
    assert.deepStrictEqual(actual, expected, message);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${message} (key order)`);
}

describe('getStudioSettings with a stored profile', () => {
    it('returns the stored row with the profile-owned fields read from the profile', async () => {
        store(OWNER, richProfile());
        const got = await getStudioSettings(OWNER);
        sameBytes(got, studioView(todayStudio(OWNER), richProfile()), 'the view');
        assert.equal(got.brand.name, 'Sami Fit Studio');
        assert.equal(got.schedule.timezone, 'Africa/Cairo');
        assert.equal(got.product.name, 'Twelve-week program');
        assert.equal(got.voice.language, 'ar');
        assert.equal(got.infographic.theme, 'light');
    });

    it('takes nothing from the row that the profile owns, and everything else from it', async () => {
        const owned = STUDIO_PROFILE_PATHS as readonly string[];
        // The row's owned fields are junk: the stale row a profile edit leaves behind. None of it may survive.
        state.studio.set(OWNER, studioRow(scramble(OWNER_STUDIO, STUDIO_PROFILE_PATHS)));
        store(OWNER, richProfile());
        const got = await getStudioSettings(OWNER);
        assert.ok(!JSON.stringify(got).includes('JUNK:'), 'nothing survives from the row that the profile owns');
        const row = todayStudio(OWNER);
        const rowLeaves = new Map(leafPaths(row).map((p) => [p, p]));
        const mine = (p: string): boolean => owned.some((o) => p === o || p.startsWith(`${o}.`));
        for (const path of rowLeaves.keys()) {
            if (mine(path)) continue;
            const read = (root: unknown): unknown => path.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], root);
            assert.deepStrictEqual(read(got), read(row), `${path} is the row's own`);
        }
        // The stored object order of every section is kept: the view is built over the row, not beside it.
        for (const section of Object.keys(row)) assert.deepEqual(Object.keys((got as never)[section] ?? {}).slice(0, 3), Object.keys((row as never)[section] ?? {}).slice(0, 3));
    });

    it('a profile and no row at all: the view over the neutral defaults', async () => {
        store(OTHER, richProfile());
        sameBytes(await getStudioSettings(OTHER), studioView(defaultStudioSettings(), richProfile()), 'the view over the defaults');
    });

    it('reads the row first, by the statement it always used, and then the profile', async () => {
        store(OWNER, richProfile());
        await getStudioSettings(OWNER);
        assert.deepEqual(sql(), [
            'SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic, explainer FROM studio_settings WHERE creator_id = $1',
            'SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = $1',
        ]);
    });

    it('hands every caller its own copy: editing a result edits nobody else\'s', async () => {
        store(OWNER, richProfile());
        await withProfileCache(async () => {
            const first = await getStudioSettings(OWNER);
            first.product.facts.push('MUTATED');
            first.infographic.socials.length = 0;
            const second = await getStudioSettings(OWNER);
            assert.deepEqual(second.product.facts, ['12 weeks', 'Video lessons', 'Weekly check-in']);
            assert.deepEqual(second.infographic.socials, ['instagram', 'youtube']);
        });
    });

    it('asks for the profile once per request, and a transaction client always asks the database', async () => {
        store(OWNER, richProfile());
        const profileReads = (): number => db.ran(/FROM creator_profiles/).length;
        await withProfileCache(async () => {
            await getStudioSettings(OWNER);
            await getStudioSettings(OWNER);
            await getStudioSettings(OWNER);
        });
        assert.equal(profileReads(), 1, 'three reads, one profile query');
        const client = await pool.connect();
        try {
            await withProfileCache(async () => {
                await getStudioSettings(OWNER, client as never);
                await getStudioSettings(OWNER, client as never);
            });
        } finally {
            client.release();
        }
        assert.equal(profileReads(), 3, 'a client inside a transaction is never served from (or published to) the request cache');
    });

    it('a database without v33 reads as no profile: the row, and one warning', async () => {
        db.v33 = false;
        sameBytes(await getStudioSettings(OWNER), todayStudio(OWNER), 'the row');
        await getStudioSettings(OWNER);
        assert.equal(logged('profile.table_missing'), 1);
    });
});

describe('getStudioSettings without a stored profile', () => {
    it('is the row over the defaults, byte for byte as before: no virtual overlay', async () => {
        sameBytes(await getStudioSettings(OWNER), todayStudio(OWNER), 'the owner\'s row');
        // The row says things the legacy profile would not: it is read as it says, never "corrected" from a derived profile.
        const odd: StudioSettings = { ...OWNER_STUDIO, brand: { ...OWNER_STUDIO.brand, name: 'Not the legacy name' }, voice: { ...OWNER_STUDIO.voice, language: 'en' } };
        state.studio.set(OWNER, studioRow(odd));
        const got = await getStudioSettings(OWNER);
        assert.equal(got.brand.name, 'Not the legacy name');
        assert.equal(got.voice.language, 'en');
        sameBytes(got, todayStudio(OWNER), 'the odd row');
    });

    it('a row with a stale owned field (junk) is read as it is', async () => {
        state.studio.set(OWNER, studioRow(scramble(OWNER_STUDIO, STUDIO_PROFILE_PATHS)));
        const got = await getStudioSettings(OWNER);
        assert.equal(got.brand.name, 'JUNK:brand.name', 'with no profile, nothing is overlaid');
        sameBytes(got, todayStudio(OWNER), 'the row');
    });

    it('a tenant with no row either: the neutral defaults', async () => {
        sameBytes(await getStudioSettings(OTHER), defaultStudioSettings(), 'the defaults');
    });

    it('the profile of the legacy settings is never derived on a read: the only table read besides the settings is creator_profiles', async () => {
        await getStudioSettings(OWNER);
        assert.deepEqual(sql().map((s) => /FROM (\w+)/.exec(s)![1]), ['studio_settings', 'creator_profiles']);
    });
});

describe('a profile written by a newer release', () => {
    const newer = (): unknown => ({ ...richProfile(), schema: 2, somethingNew: { kept: true } });

    it('is not overlaid: the Studio and the Growth readers answer from their rows, and the warning is logged once per tenant', async () => {
        store(OWNER, newer());
        sameBytes(await getStudioSettings(OWNER), todayStudio(OWNER), 'the Studio row');
        sameBytes(await getGrowthSettings(OWNER), todayGrowth(OWNER), 'the Growth row');
        await getStudioSettings(OWNER);
        await getGrowthSettings(OWNER);
        await getMonteurSettings(OWNER);
        assert.equal(logged('profile.newer_schema'), 1, 'one line however many readers ask');
        assert.equal(events.find((e) => e.event === 'profile.newer_schema')!.level, 'warn');
        store(OTHER, newer());
        await getStudioSettings(OTHER);
        assert.equal(logged('profile.newer_schema'), 2, 'another tenant is another line');
    });

    it('leaves the stored profile as it was', async () => {
        store(OWNER, newer());
        const before = JSON.stringify(state.profiles.get(OWNER));
        await getStudioSettings(OWNER);
        assert.equal(JSON.stringify(state.profiles.get(OWNER)), before);
    });
});

describe('getGrowthSettings', () => {
    it('with a stored profile: the row with the audience and goals read from the profile', async () => {
        store(OWNER, richProfile());
        const got = await getGrowthSettings(OWNER);
        sameBytes(got, growthView(todayGrowth(OWNER), richProfile()), 'the view');
        assert.deepEqual(got.audience, { countries: ['EG', 'SA'], languages: ['ar', 'en'], timezone: 'Asia/Dubai' });
        assert.equal(got.goal_followers, 5000);
        assert.equal(got.goal_views, 250_000);
        assert.deepEqual(got.keywords, ELAMIR_GROWTH.keywords, 'the keywords are the Growth agent\'s own, and stay in the row');
        assert.deepEqual(got.hashtag_sets, ELAMIR_GROWTH.hashtag_sets);
        assert.deepEqual(got.competitors, ELAMIR_GROWTH.competitors);
    });

    it('takes nothing from the row that the profile owns', async () => {
        state.growth.set(OWNER, growthRow(scramble(ELAMIR_GROWTH as GrowthSettings, GROWTH_PROFILE_PATHS)));
        store(OWNER, richProfile());
        const got = await getGrowthSettings(OWNER);
        assert.ok(!JSON.stringify(got).includes('JUNK:'));
        assert.notEqual(got.goal_followers, 7);
    });

    it('without a stored profile: the row exactly as before, junk included', async () => {
        sameBytes(await getGrowthSettings(OWNER), todayGrowth(OWNER), 'the owner\'s row');
        state.growth.set(OWNER, growthRow(scramble(ELAMIR_GROWTH as GrowthSettings, GROWTH_PROFILE_PATHS)));
        const got = await getGrowthSettings(OWNER);
        assert.equal(got.goal_followers, 7, 'nothing is overlaid');
        sameBytes(got, todayGrowth(OWNER), 'the junk row');
    });

    it('reads the row first and the profile second; a tenant with no row and a profile gets the view over the defaults', async () => {
        store(OTHER, richProfile());
        sameBytes(await getGrowthSettings(OTHER), growthView(defaultGrowthSettings(), richProfile()), 'the view over the defaults');
        assert.deepEqual(sql().map((s) => /FROM (\w+)/.exec(s)![1]), ['growth_settings', 'creator_profiles']);
    });
});

describe('getMonteurSettings\' timezone is the Studio reader\'s schedule.timezone, by a narrow read', () => {
    const profileWith = (identity: unknown, extra: Record<string, unknown> = {}): unknown => {
        const p = structuredClone(richProfile()) as unknown as Record<string, unknown>;
        if (identity === undefined) delete p.identity;
        else p.identity = identity;
        return { ...p, ...extra };
    };
    const base = (): CreatorProfile['identity'] => richProfile().identity;
    const cases: [string, () => unknown, string][] = [
        ['a timezone', () => profileWith({ ...base(), timezone: 'Europe/London' }), 'Europe/London'],
        ['an empty timezone reads as UTC', () => profileWith({ ...base(), timezone: '' }), 'UTC'],
        ['no timezone key reads as UTC', () => profileWith({ ...base(), timezone: undefined }), 'UTC'],
        ['a timezone of the wrong type reads as UTC', () => profileWith({ ...base(), timezone: 5 }), 'UTC'],
        ['a null timezone reads as UTC', () => profileWith({ ...base(), timezone: null }), 'UTC'],
        ['no identity at all reads as UTC', () => profileWith(undefined), 'UTC'],
        ['an identity of the wrong type reads as UTC', () => profileWith('nobody'), 'UTC'],
    ];
    for (const [name, build, expected] of cases) {
        it(name, async () => {
            store(OWNER, build());
            const studio = (await getStudioSettings(OWNER)).schedule.timezone;
            const monteur = (await getMonteurSettings(OWNER)).timezone;
            assert.equal(studio, expected, 'the Studio reader');
            assert.equal(monteur, studio, 'the Monteur reader agrees');
        });
    }

    // A stored profile that is not an object at all (a hand edit, a bad write): both readers read it as the default.
    const notObjects: [string, unknown][] = [['a string', 'garbage'], ['a number', 42], ['a list', ['x']], ['an empty list', []], ['JSON null', null], ['a boolean', true]];
    for (const [name, raw] of notObjects) {
        it(`a stored profile that is ${name} reads as the default, UTC, in both readers`, async () => {
            state.profiles.set(OWNER, { profile: raw, version: 1, activated_at: null, updated_by: null });
            const studio = (await getStudioSettings(OWNER)).schedule.timezone;
            const monteur = (await getMonteurSettings(OWNER)).timezone;
            assert.equal(studio, 'UTC', 'the Studio reader');
            assert.equal(monteur, studio, 'the Monteur reader agrees');
            assert.equal((await getGrowthSettings(OWNER)).goal_followers, 10_000, 'and the Growth reader reads the default goals');
        });
    }

    it('a newer-schema profile, no profile, and no v33: the row\'s own timezone, as the Studio reader gives it', async () => {
        const rowTimezone = todayStudio(OWNER).schedule.timezone;
        store(OWNER, profileWith({ ...base(), timezone: 'Europe/London' }, { schema: 2 }));
        assert.equal((await getMonteurSettings(OWNER)).timezone, rowTimezone);
        assert.equal((await getStudioSettings(OWNER)).schedule.timezone, rowTimezone);
        state.profiles.delete(OWNER);
        assert.equal((await getMonteurSettings(OWNER)).timezone, rowTimezone);
        store(OWNER, profileWith({ ...base(), timezone: 'Europe/London' }));
        db.v33 = false;
        assert.equal((await getMonteurSettings(OWNER)).timezone, rowTimezone);
        assert.equal((await getStudioSettings(OWNER)).schedule.timezone, rowTimezone);
    });

    it('reads the two values it needs and nothing else: the profile is never fetched', async () => {
        store(OWNER, richProfile());
        const { monteur, timezone } = await getMonteurSettings(OWNER);
        assert.equal(timezone, 'Africa/Cairo');
        assert.equal(monteur.enabled, OWNER_STUDIO.monteur.enabled);
        assert.deepEqual(sql(), [
            'SELECT monteur, schedule FROM studio_settings WHERE creator_id = $1',
            `SELECT profile->'schema' AS profile_schema, profile->'identity'->'timezone' AS identity_timezone FROM creator_profiles WHERE creator_id = $1`,
        ]);
    });
});

describe('the owner\'s profile through the readers', () => {
    it('the profile of his own rows, stored and read back, gives his rows back unchanged', async () => {
        // The state the live backfill leaves: his profile is profileFromLegacy of his rows, and the rows are untouched.
        const profile = profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH as GrowthSettings);
        store(OWNER, profile);
        sameBytes(await getStudioSettings(OWNER), todayStudio(OWNER), 'Studio');
        sameBytes(await getGrowthSettings(OWNER), todayGrowth(OWNER), 'Growth');
        assert.equal((await getMonteurSettings(OWNER)).timezone, OWNER_STUDIO.schedule.timezone);
    });
});

describe('a stored profile with fields that had to be repaired when it was read', () => {
    const damaged = (): unknown => ({ ...richProfile(), brand: { ...richProfile().brand, font_display: 'Comic Sans', theme: 'neon' } });

    it('is overlaid, with the repaired fields reading as their defaults, and the drift is logged once per tenant', async () => {
        store(OWNER, damaged());
        const got = await getStudioSettings(OWNER);
        assert.equal(got.brand.fonts.display, 'Cairo', 'the font the stored value could not be read as: the default for an Arabic profile');
        assert.equal(got.infographic.theme, 'dark');
        assert.equal(got.brand.name, 'Sami Fit Studio', 'everything else is the profile\'s');
        await getStudioSettings(OWNER);
        await getGrowthSettings(OWNER);
        assert.equal(logged('profile.repaired'), 1, 'one line however many readers ask');
        assert.equal(events.find((e) => e.event === 'profile.repaired')!.level, 'warn');
    });

    it('a clean profile logs nothing, and neither does the Monteur\'s narrow read of a wrongly typed timezone', async () => {
        store(OWNER, richProfile());
        await getStudioSettings(OWNER);
        await getGrowthSettings(OWNER);
        assert.equal(logged('profile.repaired'), 0);
        store(OWNER, { ...richProfile(), identity: { ...richProfile().identity, timezone: 5 } });
        assert.equal((await getMonteurSettings(OWNER)).timezone, 'UTC');
        assert.equal(logged('profile.repaired'), 0, 'the narrow read repairs a stand-in profile, which says nothing about the stored one');
    });
});

describe('a settings row that has drifted from the profile', () => {
    const drift = (settings: 'studio' | 'growth'): { fields: Record<string, unknown> }[] =>
        events.filter((e) => e.event === 'profile.row_drift' && e.fields.settings === settings);

    it('is logged once per tenant and settings, with the paths that differ', async () => {
        // The row is the owner's; the profile says something else in several owned fields.
        store(OWNER, richProfile());
        await getStudioSettings(OWNER);
        await getStudioSettings(OWNER);
        const [line] = drift('studio');
        assert.equal(drift('studio').length, 1, 'once, however many reads');
        assert.equal(events.find((e) => e.event === 'profile.row_drift')!.level, 'warn');
        assert.equal(line!.fields.creator_id, OWNER);
        const paths = line!.fields.paths as string[];
        assert.deepEqual(paths, changedPaths(todayStudio(OWNER), studioView(todayStudio(OWNER), richProfile()), STUDIO_PROFILE_PATHS), 'exactly the owned paths where the row and the view differ');
        for (const path of ['brand.name', 'schedule.timezone', 'voice.digits', 'product.name', 'infographic.theme']) assert.ok(paths.includes(path), path);
        assert.ok(!paths.includes('monteur.enabled') && !paths.includes('schedule.slots'), 'only what the profile owns');

        await getGrowthSettings(OWNER);
        await getGrowthSettings(OWNER);
        assert.equal(drift('growth').length, 1, 'Growth drifts on its own line');
        assert.deepEqual(drift('growth')[0]!.fields.paths, ['audience.countries', 'audience.languages', 'audience.timezone', 'goal_followers', 'goal_views']);
        assert.equal(logged('profile.row_drift'), 2);
    });

    it('another tenant is another line', async () => {
        store(OWNER, richProfile());
        store(OTHER, richProfile());
        await getStudioSettings(OWNER);
        await getStudioSettings(OTHER);
        assert.equal(drift('studio').length, 2);
    });

    it('is not logged when the row is what the profile says: the owner\'s stored profile, and a row the mirror wrote', async () => {
        store(OWNER, profileFromLegacy(OWNER_STUDIO, ELAMIR_GROWTH as GrowthSettings));
        await getStudioSettings(OWNER);
        await getGrowthSettings(OWNER);
        assert.equal(logged('profile.row_drift'), 0);
        await saveProfile(OTHER, richProfile(), { expectVersion: null, source: 'wizard', userId: null });
        await getStudioSettings(OTHER);
        await getGrowthSettings(OTHER);
        assert.equal(logged('profile.row_drift'), 0, 'after a save the rows mirror the profile');
    });

    it('is not logged for a tenant with no profile or one from a newer release: nothing is overlaid, so nothing differs', async () => {
        await getStudioSettings(OWNER);
        store(OTHER, { ...richProfile(), schema: 2 });
        await getStudioSettings(OTHER);
        await getGrowthSettings(OTHER);
        assert.equal(logged('profile.row_drift'), 0);
    });

    it('the reader still answers with the profile: drift is a line in the log, not a different answer', async () => {
        store(OWNER, richProfile());
        sameBytes(await getStudioSettings(OWNER), studioView(todayStudio(OWNER), richProfile()), 'the view');
    });

    it('a write heals it: the row then equals the view, and a process that starts afresh finds nothing to say', async () => {
        store(OWNER, richProfile());
        await updateStudioSettings(OWNER, { cta: { tiktokLine: 'Comment below' } });
        resetProfileWarnings();
        events.length = 0;
        await getStudioSettings(OWNER);
        assert.equal(logged('profile.row_drift'), 0);
    });
});
