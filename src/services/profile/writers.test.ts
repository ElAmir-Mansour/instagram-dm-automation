/**
 * The Studio and Growth settings writers route what the profile owns into `saveProfile` (docs/onboarding/01 §4; P4).
 *
 * A PUT with a stored profile is applied over what the reader shows; a change to a profile-owned field becomes a new
 * profile version (history row, mirror), a change to anything else is written to the row exactly as before and never
 * touches the profile; a tenant with no stored profile is written exactly as before, and no profile is created.
 * What is pinned, on the rows of a stand-in database that applies the statements the code sends:
 *   - every owned path lands in its profile field, and nothing else does (so the Monteur, the CTA words, the palette
 *     and the slots never bump a version);
 *   - one patch with both kinds lands both, and the mirror does not undo the direct write (no clobber);
 *   - a version that moved after the writer read it is a 409 and nothing is written;
 *   - a profile from a newer release is never written over, but an edit that does not need it still goes through;
 *   - the locks, in the global order, and a failure anywhere rolls the row and the profile back together.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { GrowthError } from '../growth/common.js';
import { getGrowthSettings, updateGrowthSettings } from '../growth/settings.js';
import { StudioError } from '../studio/common.js';
import { getStudioSettings, updateStudioSettings } from '../studio/settings.js';
import { ELAMIR_GROWTH } from '../studio/testFixtures.js';
import { withProfileCache } from './cache.js';
import { profileFromLegacy } from './legacy.js';
import { resetNewerSchemaWarnings } from './store.js';
import {
    GROWTH_COLUMNS, growthRow, installProfileDb, OWNER, OWNER_STUDIO, type ProfileDb, seededState, STUDIO_COLUMNS, studioRow, type State,
} from './testDb.js';
import { throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

const MUTEX = /^SELECT id FROM creators WHERE id = \$1 FOR NO KEY UPDATE$/;
const PROFILE_ROW = /^SELECT profile, version FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE$/;
const STUDIO_READ = /^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic FROM studio_settings WHERE creator_id = \$1 FOR UPDATE$/;
const STUDIO_LOCK = /^SELECT creator_id FROM studio_settings WHERE creator_id = \$1 FOR UPDATE$/;
const GROWTH_READ = /^SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings WHERE creator_id = \$1 FOR UPDATE$/;
const STUDIO_WRITE = /^INSERT INTO studio_settings /;
const GROWTH_WRITE = /^INSERT INTO growth_settings /;
const PROFILE_UPDATE = /^UPDATE creator_profiles /;
const HISTORY = /^INSERT INTO creator_profile_versions /;
const PROFILE_WRITES = /^(UPDATE creator_profiles |INSERT INTO creator_profiles |INSERT INTO creator_profile_versions )/;

const OWNER_GROWTH = ELAMIR_GROWTH as GrowthSettings;
const ownerProfile = (): CreatorProfile => profileFromLegacy(OWNER_STUDIO, OWNER_GROWTH);

let state: State;
let db: ProfileDb;
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    resetNewerSchemaWarnings();
    state = seededState();
    db = installProfileDb(state);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const sql = (): string[] => db.statements.map((s) => s.sql);
const count = (pattern: RegExp): number => sql().filter((s) => pattern.test(s)).length;
const first = (pattern: RegExp): number => sql().findIndex((s) => pattern.test(s));
const trace = (): string => sql().map((s) => s.slice(0, 56)).join('\n');

/** The state a tenant with a stored profile is in: the rows as seeded, the profile stored beside them at `version`. */
function storeProfile(profile: unknown = ownerProfile(), version = 1): void {
    state.profiles.set(OWNER, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
}
const storedProfile = (): CreatorProfile => state.profiles.get(OWNER)!.profile as CreatorProfile;
const versionNow = (): number => state.profiles.get(OWNER)!.version;
/** The settings columns of the row, as stored (not its `updated_at`). */
const studioNow = (): StudioSettings => Object.fromEntries(STUDIO_COLUMNS.map((c) => [c, state.studio.get(OWNER)![c]])) as unknown as StudioSettings;
const growthNow = (): GrowthSettings => Object.fromEntries(GROWTH_COLUMNS.map((c) => [c, state.growth.get(OWNER)![c]])) as unknown as GrowthSettings;
const copyOfState = (): string => JSON.stringify([[...state.profiles], state.versions, [...state.studio], [...state.growth]]);

function inOrder(...steps: [string, RegExp][]): void {
    let previous = -1;
    for (const [name, pattern] of steps) {
        const at = sql().findIndex((s, i) => i > previous && pattern.test(s));
        assert.ok(at > previous, `${name} comes after the step before it\n${trace()}`);
        previous = at;
    }
}

/** The four locks, by the first statement that takes each, must follow: creators, creator_profiles, studio_settings, growth_settings. */
function lockOrderIsGlobal(): void {
    const ranks = [MUTEX, PROFILE_ROW, new RegExp(`${STUDIO_READ.source}|${STUDIO_LOCK.source}`), GROWTH_READ].map((pattern) => first(pattern));
    const taken = ranks.map((at, rank) => ({ at, rank })).filter((r) => r.at >= 0).sort((a, b) => a.at - b.at).map((r) => r.rank);
    assert.deepEqual(taken, [...taken].sort((a, b) => a - b), `locks out of order\n${trace()}`);
}

/** Another connection commits a profile change between our read of the version and our save: the lock is what makes this impossible, so the check is what a bug in the lock would hit. */
function intruderBumpsProfileOn(pattern: RegExp): void {
    let done = false;
    db.onStatement = (statement) => {
        if (done || !pattern.test(statement)) return;
        done = true;
        for (const table of [state.profiles, db.snapshot?.profiles]) {
            const row = table?.get(OWNER);
            if (row) row.version += 1;
        }
    };
}

// ─── Studio ──────────────────────────────────────────────────────────────────────────────────

describe('updateStudioSettings with a stored profile: what the profile owns', () => {
    type Edit = [path: string, patch: Record<string, unknown>, read: (p: CreatorProfile) => unknown, expected: unknown];
    const OWNED: Edit[] = [
        ['brand.name', { brand: { name: 'Elamir Academy' } }, (p) => p.identity.brand_name, 'Elamir Academy'],
        ['brand.fonts.display', { brand: { fonts: { display: 'Tajawal' } } }, (p) => p.brand.font_display, 'Tajawal'],
        ['voice.digits', { voice: { digits: 'latin' } }, (p) => p.language.digits, 'latin'],
        ['voice.guide', { voice: { guide: 'Short and warm.' } }, (p) => p.voice.guide, 'Short and warm.'],
        ['voice.avoid', { voice: { avoid: ['MCP', 'hack'] } }, (p) => p.content.never_mention, ['MCP', 'hack']],
        ['voice.avoid, emptied', { voice: { avoid: [] } }, (p) => p.content.never_mention, []],
        ['product.name', { product: { name: 'A new course' } }, (p) => p.offers.find((o) => o.primary)!.name, 'A new course'],
        ['product.url', { product: { url: 'https://example.com/new?ref=1' } }, (p) => p.offers.find((o) => o.primary)!.url, 'https://example.com/new?ref=1'],
        ['product.facts', { product: { facts: ['12 hours'] } }, (p) => p.offers.find((o) => o.primary)!.facts, ['12 hours']],
        ['product.dmBullets', { product: { dmBullets: ['✅ One', '✅ Two'] } }, (p) => p.offers.find((o) => o.primary)!.bullets, ['✅ One', '✅ Two']],
        ['schedule.timezone', { schedule: { timezone: 'Europe/London' } }, (p) => p.identity.timezone, 'Europe/London'],
        ['infographic.name.ar', { infographic: { name: { ar: 'اسم جديد' } } }, (p) => p.identity.display_name.ar, 'اسم جديد'],
        ['infographic.name.en', { infographic: { name: { en: 'New Name' } } }, (p) => p.identity.display_name.en, 'New Name'],
        ['infographic.site', { infographic: { site: 'example.dev' } }, (p) => p.socials.site, 'example.dev'],
        ['infographic.handle', { infographic: { handle: '@new.handle' } }, (p) => p.socials.handle, '@new.handle'],
        ['infographic.socials', { infographic: { socials: ['instagram', 'x'] } }, (p) => p.socials.platforms, ['instagram', 'x']],
        ['infographic.primary', { infographic: { primary: '#112233' } }, (p) => p.brand.primary, '#112233'],
        ['infographic.accent', { infographic: { accent: '#AABBCC' } }, (p) => p.brand.accent, '#AABBCC'],
        ['infographic.photo_url', { infographic: { photo_url: 'https://app.example.com/api/uploads/11111111-1111-4111-8111-111111111111' } }, (p) => p.brand.portrait_url, 'https://app.example.com/api/uploads/11111111-1111-4111-8111-111111111111'],
        ['infographic.theme', { infographic: { theme: 'light' } }, (p) => p.brand.theme, 'light'],
        ['infographic.language', { infographic: { language: 'en' } }, (p) => p.language.surfaces.infographic?.language, 'en'],
        ['voice.language', { voice: { language: 'en' } }, (p) => p.language.primary, 'en'],
    ];

    for (const [path, patch, read, expected] of OWNED) {
        it(`${path} goes into the profile: version 2, a history row, the mirror, and the same answer on the next read`, async () => {
            storeProfile();
            const before = structuredClone(storedProfile());
            const { settings } = await updateStudioSettings(OWNER, patch);

            assert.equal(versionNow(), 2);
            assert.deepStrictEqual(read(storedProfile()), expected, 'the profile holds it');
            const history = state.versions.filter((v) => v.creator_id === OWNER);
            assert.deepEqual(history.map((v) => [v.version, v.source, v.updated_by]), [[2, 'user', null]]);
            assert.deepStrictEqual(history[0]!.profile, storedProfile(), 'the history row is the profile as saved');
            assert.notDeepEqual(storedProfile(), before);

            // The mirror: the rows now say what the profile says, and the reader gives what the PUT answered.
            const read2 = await getStudioSettings(OWNER);
            assert.deepStrictEqual(settings, read2, 'the PUT answers what the next GET does');
            assert.equal(count(PROFILE_UPDATE), 1, 'one profile write');
        });
    }

    it('saves over the version it read in its own transaction, whatever that is: 7 becomes 8', async () => {
        storeProfile(ownerProfile(), 7);
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } });
        assert.equal(versionNow(), 8);
        assert.deepEqual(state.versions.map((v) => v.version), [8]);
    });

    it('writes nothing else into the profile: only the field edited differs from the profile before', async () => {
        storeProfile();
        const before = structuredClone(storedProfile());
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } });
        assert.deepStrictEqual({ ...storedProfile(), identity: { ...storedProfile().identity, timezone: 'x' } }, { ...before, identity: { ...before.identity, timezone: 'x' } });
    });

    it('an edit that changes nothing the profile owns, or sets the same value again, is no new version', async () => {
        storeProfile();
        await updateStudioSettings(OWNER, { brand: { name: OWNER_STUDIO.brand.name }, schedule: { timezone: OWNER_STUDIO.schedule.timezone } });
        await updateStudioSettings(OWNER, { voice: { avoid: [...OWNER_STUDIO.voice.avoid!] } });
        assert.equal(versionNow(), 1);
        assert.equal(count(PROFILE_WRITES), 0);
        assert.equal(state.versions.length, 0);
    });
});

describe('updateStudioSettings with a stored profile: what it does not own', () => {
    const NOT_OWNED: [string, Record<string, unknown>][] = [
        ['monteur', { monteur: { enabled: true, reels_per_video: 3 } }],
        ['cta', { cta: { tiktokLine: 'Comment below 👇' } }],
        ['brand.palette', { brand: { palette: ['#FFD60A', '#FF8A3D'] } }],
        ['brand.direction', { brand: { direction: 'rtl' } }],
        ['brand.signature', { brand: { signature: { latin: 'NEW', local: 'جديد' } } }],
        ['schedule.slots', { schedule: { slots: ['10:00', '18:00'] } }],
        ['library', { library: { root: '/Users/me/Videos' } }],
        ['infographic.platforms', { infographic: { platforms: ['instagram'] } }],
        ['examples', { examples: [] }],
    ];
    for (const [name, patch] of NOT_OWNED) {
        it(`${name} is written to the row as before and never touches the profile`, async () => {
            storeProfile();
            const profileBefore = JSON.stringify(state.profiles.get(OWNER));
            const { settings } = await updateStudioSettings(OWNER, patch);
            assert.equal(count(PROFILE_WRITES), 0, 'no profile write of any kind');
            assert.equal(JSON.stringify(state.profiles.get(OWNER)), profileBefore, 'the stored profile is byte for byte what it was');
            assert.equal(state.versions.length, 0, 'no history row');
            assert.equal(count(STUDIO_WRITE), 1, 'the row is written once: no mirror');
            assert.equal(count(GROWTH_READ) + count(GROWTH_WRITE), 0, 'and the Growth row is not touched');
            assert.deepStrictEqual(settings, await getStudioSettings(OWNER));
            const [section, value] = Object.entries(patch)[0]! as [keyof StudioSettings, Record<string, unknown>];
            if (section === 'examples') assert.deepEqual(state.studio.get(OWNER)!.examples, []);
            else for (const [key, v] of Object.entries(value)) assert.deepStrictEqual((state.studio.get(OWNER)![section] as Record<string, unknown>)[key], v, `the row holds ${section}.${key}`);
        });
    }

    it('one patch with both kinds lands both, and the mirror does not undo the direct write', async () => {
        storeProfile();
        const palette = ['#FFD60A', '#22C7F0'];
        const { settings } = await updateStudioSettings(OWNER, {
            brand: { name: 'Elamir Academy', palette, direction: 'rtl' },
            schedule: { timezone: 'Europe/London', slots: ['09:00'] },
            infographic: { accent: '#AABBCC', platforms: ['facebook'] },
            monteur: { reels_per_video: 4 },
        });
        assert.equal(versionNow(), 2);
        assert.equal(storedProfile().identity.brand_name, 'Elamir Academy');
        assert.equal(storedProfile().brand.accent, '#AABBCC');
        const row = studioNow();
        assert.deepEqual(row.brand.palette, palette, 'brand.palette survived the mirror of the brand section');
        assert.equal(row.brand.direction, 'rtl');
        assert.equal(row.brand.name, 'Elamir Academy', 'and the owned field in the same section is the profile\'s');
        assert.deepEqual(row.schedule, { timezone: 'Europe/London', slots: ['09:00'] });
        assert.deepEqual(row.infographic.platforms, ['facebook']);
        assert.equal(row.infographic.accent, '#AABBCC');
        assert.equal(row.monteur.reels_per_video, 4);
        assert.deepStrictEqual(settings, await getStudioSettings(OWNER));
        // The Studio row was written twice in the one transaction, the second by the mirror and from the first: the same row.
        assert.equal(count(STUDIO_WRITE), 2);
    });

    it('the mirror writes the owned sections only: cta, library, examples and the Monteur are the direct write\'s', async () => {
        storeProfile();
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' }, cta: { tiktokLine: 'Comment below 👇' }, library: { root: '/Users/me/V' }, monteur: { enabled: true } });
        const row = studioNow();
        assert.equal(row.cta.tiktokLine, 'Comment below 👇');
        assert.equal(row.library.root, '/Users/me/V');
        assert.equal(row.monteur.enabled, true);
        assert.deepEqual(row.examples, []);
    });

    it('a row that has drifted from the profile is healed by the next write, with no version bump', async () => {
        storeProfile();
        state.studio.set(OWNER, studioRow({ ...OWNER_STUDIO, brand: { ...OWNER_STUDIO.brand, name: 'A stale name' }, schedule: { ...OWNER_STUDIO.schedule, timezone: 'Asia/Tokyo' } }));
        await updateStudioSettings(OWNER, { cta: { tiktokLine: 'Comment below 👇' } });
        assert.equal(versionNow(), 1);
        assert.equal(studioNow().brand.name, OWNER_STUDIO.brand.name, 'the row says what the profile says');
        assert.equal(studioNow().schedule.timezone, OWNER_STUDIO.schedule.timezone);
        assert.equal(count(PROFILE_WRITES), 0);
    });
});

describe('updateStudioSettings without a stored profile', () => {
    it('writes exactly what it wrote before: the row, no profile, no history, nothing derived', async () => {
        const { settings, changed } = await updateStudioSettings(OWNER, { brand: { name: 'Elamir Academy' }, schedule: { timezone: 'Europe/London' } });
        assert.deepEqual(changed, ['brand', 'schedule']);
        assert.equal(settings.brand.name, 'Elamir Academy');
        assert.equal(studioNow().brand.name, 'Elamir Academy');
        assert.equal(studioNow().schedule.timezone, 'Europe/London');
        assert.equal(count(PROFILE_WRITES), 0, 'no profile is created by a settings write');
        assert.equal(state.profiles.size, 0);
        assert.equal(state.versions.length, 0);
        assert.equal(count(GROWTH_READ) + count(GROWTH_WRITE), 0);
        assert.equal(count(STUDIO_WRITE), 1);
    });

    it('answers the merged settings as before, not a view', async () => {
        const { settings } = await updateStudioSettings(OWNER, { voice: { guide: 'Short.' } });
        assert.equal(JSON.stringify(settings.voice), JSON.stringify({ ...OWNER_STUDIO.voice, guide: 'Short.' }));
    });
});

describe('updateStudioSettings: the profile\'s refusals', () => {
    it('a version that moved after this transaction read it is a 409, and the row and the profile are as the other writer left them', async () => {
        storeProfile();
        intruderBumpsProfileOn(STUDIO_WRITE);
        const before = JSON.stringify(state.studio.get(OWNER));
        const err = await updateStudioSettings(OWNER, { brand: { name: 'Elamir Academy' } }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof StudioError && err.status === 409, String(err));
        assert.match((err as StudioError).message, /changed since you opened it/);
        assert.equal(JSON.stringify(state.studio.get(OWNER)), before, 'the row write rolled back with the refused save');
        assert.equal(versionNow(), 2, 'the other writer\'s version stands');
        assert.equal(state.versions.length, 0);
        assert.equal(count(/^ROLLBACK$/), 1);
        assert.equal(count(/^COMMIT$/), 0);
    });

    it('a profile from a newer release takes no write: an edit to what it owns is a 409 before anything is written', async () => {
        storeProfile({ ...ownerProfile(), schema: 2, somethingNew: { kept: true } });
        const before = copyOfState();
        const err = await updateStudioSettings(OWNER, { brand: { name: 'Elamir Academy' } }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof StudioError && err.status === 409, String(err));
        assert.match((err as StudioError).message, /newer version of the app/);
        assert.equal(copyOfState(), before, 'nothing was written');
        assert.equal(count(STUDIO_WRITE), 0, 'not even the row');
    });

    it('a profile from a newer release: an edit that needs none of it is written to the row as before', async () => {
        storeProfile({ ...ownerProfile(), schema: 2, somethingNew: { kept: true } });
        const profileBefore = JSON.stringify(state.profiles.get(OWNER));
        const { settings } = await updateStudioSettings(OWNER, { monteur: { enabled: true }, brand: { palette: ['#FFD60A'] } });
        assert.equal(JSON.stringify(state.profiles.get(OWNER)), profileBefore);
        assert.equal(count(PROFILE_WRITES), 0);
        assert.equal(settings.monteur.enabled, true);
        assert.equal(studioNow().monteur.enabled, true);
        assert.deepEqual(studioNow().brand.palette, ['#FFD60A']);
        assert.deepStrictEqual(settings, await getStudioSettings(OWNER), 'and the reader gives the row');
    });

    it('a stored profile that is itself invalid refuses an edit that needs a save, as a 400 with its problems, writing nothing', async () => {
        storeProfile({ ...ownerProfile(), audience: { ...ownerProfile().audience, description: 'x'.repeat(700) } });
        const before = copyOfState();
        const err = await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof StudioError && err.status === 400, String(err));
        assert.ok((err as StudioError).problems?.some((p) => /audience\.description/.test(p)), JSON.stringify((err as StudioError).problems));
        assert.equal(copyOfState(), before);
    });

    it('a patch the Studio rules refuse is the same 400 as before, with the profile untouched', async () => {
        storeProfile();
        const before = copyOfState();
        const err = await updateStudioSettings(OWNER, { schedule: { timezone: 'Not/AZone' } }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof StudioError && err.status === 400);
        assert.equal(copyOfState(), before);
    });

    it('a failing mirror rolls the row, the profile and the history back together', async () => {
        storeProfile();
        const before = copyOfState();
        db.failOn = /^INSERT INTO growth_settings /;
        await assert.rejects(updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } }), /injected failure/);
        assert.equal(copyOfState(), before);
        assert.equal(count(/^COMMIT$/), 0);
    });

    it('a database without v33 says so as a 503, not a 500', async () => {
        db.v33 = false;
        const err = await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof StudioError && err.status === 503, String(err));
        assert.match((err as StudioError).message, /migration v33/);
    });
});

describe('updateStudioSettings: locks and transactions', () => {
    it('an owned edit takes creators, the profile row, the Studio row, then the Growth row, each before it is written', async () => {
        storeProfile();
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } });
        inOrder(
            ['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the profile row, locked', PROFILE_ROW], ['the Studio row, locked', STUDIO_READ],
            ['the row write', STUDIO_WRITE], ['the profile update', PROFILE_UPDATE], ['the history row', HISTORY],
            ['the Growth row, locked', GROWTH_READ], ['the Growth mirror', GROWTH_WRITE], ['COMMIT', /^COMMIT$/]
        );
        assert.equal(first(MUTEX), first(/^BEGIN$/) + 1, 'the mutex is the first thing the transaction does');
        assert.equal(first(PROFILE_ROW), first(MUTEX) + 1, 'the profile row is the second lock');
        lockOrderIsGlobal();
    });

    it('an edit that needs no save takes the mutex, the profile row and the Studio row, and never the Growth row', async () => {
        storeProfile();
        await updateStudioSettings(OWNER, { monteur: { enabled: true } });
        inOrder(['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the profile row', PROFILE_ROW], ['the Studio row', STUDIO_READ], ['the write', STUDIO_WRITE], ['COMMIT', /^COMMIT$/]);
        assert.equal(count(GROWTH_READ), 0);
        lockOrderIsGlobal();
    });

    it('a tenant with no stored profile still takes the profile row second (a row that does not exist locks nothing, the mutex serialises)', async () => {
        await updateStudioSettings(OWNER, { monteur: { enabled: true } });
        inOrder(['the creators mutex', MUTEX], ['the profile row', PROFILE_ROW], ['the Studio row', STUDIO_READ], ['the write', STUDIO_WRITE]);
        lockOrderIsGlobal();
    });

    it('given a transaction\'s client, the whole write goes through it: it opens none, and the caller commits', async () => {
        storeProfile();
        const calls: string[] = [];
        const client = { query: (q: string, p?: unknown[]) => { calls.push(q.replace(/\s+/g, ' ').trim()); return (pool as unknown as { query: (a: string, b?: unknown[]) => Promise<never> }).query(q, p); } };
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } }, client as never);
        assert.ok(MUTEX.test(calls[0]!) && PROFILE_ROW.test(calls[1]!) && STUDIO_READ.test(calls[2]!));
        assert.ok(calls.some((c) => PROFILE_UPDATE.test(c)) && calls.some((c) => HISTORY.test(c)) && calls.some((c) => GROWTH_WRITE.test(c)));
        assert.equal(calls.filter((c) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(c)).length, 0);
        assert.equal(versionNow(), 2);
    });

    it('a read in the same request after an owned edit sees the new profile: the save cleared the request cache', async () => {
        storeProfile();
        await withProfileCache(async () => {
            assert.equal((await getStudioSettings(OWNER)).schedule.timezone, 'Asia/Riyadh');
            await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } });
            assert.equal((await getStudioSettings(OWNER)).schedule.timezone, 'Europe/London');
        });
    });
});

// ─── Growth ──────────────────────────────────────────────────────────────────────────────────

describe('updateGrowthSettings with a stored profile: what the profile owns', () => {
    type Edit = [path: string, patch: Record<string, unknown>, read: (p: CreatorProfile) => unknown, expected: unknown];
    const OWNED: Edit[] = [
        ['audience.countries', { audience: { countries: ['AE', 'KW'] } }, (p) => p.audience.countries, ['AE', 'KW']],
        ['audience.languages', { audience: { languages: ['ar', 'en'] } }, (p) => p.audience.languages, ['ar', 'en']],
        ['audience.timezone', { audience: { timezone: 'Asia/Dubai' } }, (p) => p.audience.timezone, 'Asia/Dubai'],
        ['audience.timezone, removed', { audience: { timezone: null } }, (p) => 'timezone' in p.audience, false],
        ['goal_followers', { goal_followers: 25_000 }, (p) => p.goals.followers, 25_000],
        ['goal_views', { goal_views: '2000000' }, (p) => p.goals.views, 2_000_000],
    ];

    for (const [path, patch, read, expected] of OWNED) {
        it(`${path} goes into the profile: version 2, a history row, the mirror, and the same answer on the next read`, async () => {
            storeProfile();
            const settings = await updateGrowthSettings(OWNER, patch);
            assert.equal(versionNow(), 2);
            assert.deepStrictEqual(read(storedProfile()), expected, 'the profile holds it');
            assert.deepEqual(state.versions.filter((v) => v.creator_id === OWNER).map((v) => [v.version, v.source, v.updated_by]), [[2, 'user', null]]);
            assert.deepStrictEqual(settings, await getGrowthSettings(OWNER), 'the PUT answers what the next GET does');
            assert.equal(count(PROFILE_UPDATE), 1);
        });
    }

    it('a goal set to null goes back to the default, in the profile', async () => {
        storeProfile({ ...ownerProfile(), goals: { followers: 5000, views: 250_000 } });
        state.growth.set(OWNER, growthRow({ ...OWNER_GROWTH, goal_followers: 5000, goal_views: 250_000 }));
        await updateGrowthSettings(OWNER, { goal_followers: null });
        assert.deepEqual(storedProfile().goals, { followers: 10_000, views: 250_000 });
        assert.equal(growthNow().goal_followers, 10_000);
    });

    it('saves over the version it read in its own transaction, whatever that is: 7 becomes 8', async () => {
        storeProfile(ownerProfile(), 7);
        await updateGrowthSettings(OWNER, { goal_followers: 25_000 });
        assert.equal(versionNow(), 8);
        assert.deepEqual(state.versions.map((v) => v.version), [8]);
    });

    it('the audience merges field by field into the profile: what was not sent is kept', async () => {
        storeProfile();
        await updateGrowthSettings(OWNER, { audience: { countries: ['AE'] } });
        assert.deepEqual(storedProfile().audience.languages, ['ar']);
        assert.equal(storedProfile().audience.timezone, 'Asia/Riyadh');
        assert.deepEqual(growthNow().audience, { countries: ['AE'], languages: ['ar'], timezone: 'Asia/Riyadh' });
    });

    it('writes nothing else into the profile, and leaves the Studio row\'s values as they were', async () => {
        storeProfile();
        const before = structuredClone(storedProfile());
        const studioBefore = JSON.stringify(throughJsonb(studioRow(OWNER_STUDIO)));
        await updateGrowthSettings(OWNER, { goal_followers: 25_000 });
        assert.deepStrictEqual({ ...storedProfile(), goals: before.goals }, before);
        assert.equal(JSON.stringify(throughJsonb(studioNow())), studioBefore, 'the mirror rewrote the Studio row with the values it held');
    });

    it('an edit that sets the same value again is no new version', async () => {
        storeProfile();
        await updateGrowthSettings(OWNER, { goal_followers: OWNER_GROWTH.goal_followers, audience: { countries: [...OWNER_GROWTH.audience.countries!] } });
        assert.equal(versionNow(), 1);
        assert.equal(count(PROFILE_WRITES), 0);
    });
});

describe('updateGrowthSettings with a stored profile: what it does not own', () => {
    const NOT_OWNED: [string, Record<string, unknown>][] = [
        ['keywords', { keywords: ['ai agents', 'prompt'] }],
        ['hashtag_sets', { hashtag_sets: [{ name: 'Only', tags: ['#ai'] }] }],
        ['competitors', { competitors: ['someone.else'] }],
    ];
    for (const [name, patch] of NOT_OWNED) {
        it(`${name} is written to the row as before and never touches the profile or the Studio row`, async () => {
            storeProfile();
            const profileBefore = JSON.stringify(state.profiles.get(OWNER));
            const settings = await updateGrowthSettings(OWNER, patch);
            assert.equal(count(PROFILE_WRITES), 0);
            assert.equal(JSON.stringify(state.profiles.get(OWNER)), profileBefore);
            assert.equal(state.versions.length, 0);
            assert.equal(count(STUDIO_WRITE) + count(STUDIO_LOCK) + count(STUDIO_READ), 0, 'the Studio row is not touched');
            assert.equal(count(GROWTH_WRITE), 1);
            const [key, value] = Object.entries(patch)[0]!;
            assert.deepEqual((growthNow() as unknown as Record<string, unknown>)[key], value);
            assert.deepStrictEqual(settings, await getGrowthSettings(OWNER));
        });
    }

    it('one patch with both kinds lands both', async () => {
        storeProfile();
        const settings = await updateGrowthSettings(OWNER, { keywords: ['ai agents'], goal_views: 3_000_000, competitors: ['someone.else'] });
        assert.equal(versionNow(), 2);
        assert.equal(storedProfile().goals.views, 3_000_000);
        assert.deepEqual(growthNow().keywords, ['ai agents']);
        assert.deepEqual(growthNow().competitors, ['someone.else']);
        assert.equal(growthNow().goal_views, 3_000_000);
        assert.deepEqual(growthNow().hashtag_sets, OWNER_GROWTH.hashtag_sets, 'what was not sent is kept');
        assert.deepStrictEqual(settings, await getGrowthSettings(OWNER));
        assert.equal(count(GROWTH_WRITE), 2, 'the row, then the mirror of it');
    });

    it('a row that has drifted from the profile is healed by the next write, with no version bump', async () => {
        storeProfile();
        state.growth.set(OWNER, growthRow({ ...OWNER_GROWTH, goal_followers: 1, goal_views: 2, audience: { countries: ['ZZ'] } }));
        await updateGrowthSettings(OWNER, { keywords: ['ai agents'] });
        assert.equal(versionNow(), 1);
        assert.equal(growthNow().goal_followers, OWNER_GROWTH.goal_followers);
        assert.deepEqual(growthNow().audience, OWNER_GROWTH.audience);
    });
});

describe('updateGrowthSettings without a stored profile', () => {
    it('writes exactly what it wrote before: the row, no profile, no history, no Studio statement', async () => {
        const settings = await updateGrowthSettings(OWNER, { goal_followers: 25_000, audience: { countries: ['AE'] }, keywords: ['ai agents'] });
        assert.equal(settings.goal_followers, 25_000);
        assert.deepEqual(settings.audience.countries, ['AE']);
        assert.equal(growthNow().goal_followers, 25_000);
        assert.equal(count(PROFILE_WRITES), 0);
        assert.equal(state.profiles.size, 0);
        assert.equal(count(STUDIO_WRITE) + count(STUDIO_LOCK) + count(STUDIO_READ), 0);
        assert.equal(count(GROWTH_WRITE), 1);
    });
});

describe('updateGrowthSettings: the profile\'s refusals', () => {
    it('a version that moved after this transaction read it is a 409, and everything rolls back', async () => {
        storeProfile();
        intruderBumpsProfileOn(GROWTH_WRITE);
        const before = JSON.stringify(state.growth.get(OWNER));
        const err = await updateGrowthSettings(OWNER, { goal_followers: 25_000 }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof GrowthError && err.status === 409, String(err));
        assert.equal(JSON.stringify(state.growth.get(OWNER)), before);
        assert.equal(versionNow(), 2);
        assert.equal(state.versions.length, 0);
        assert.equal(count(/^COMMIT$/), 0);
    });

    it('a profile from a newer release: an edit to what it owns is a 409 before anything is written', async () => {
        storeProfile({ ...ownerProfile(), schema: 2, somethingNew: { kept: true } });
        const before = copyOfState();
        const err = await updateGrowthSettings(OWNER, { goal_followers: 25_000 }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof GrowthError && err.status === 409, String(err));
        assert.match((err as GrowthError).message, /newer version of the app/);
        assert.equal(copyOfState(), before);
        assert.equal(count(GROWTH_WRITE), 0);
    });

    it('a profile from a newer release: an edit that needs none of it is written to the row as before', async () => {
        storeProfile({ ...ownerProfile(), schema: 2, somethingNew: { kept: true } });
        const profileBefore = JSON.stringify(state.profiles.get(OWNER));
        const settings = await updateGrowthSettings(OWNER, { keywords: ['ai agents'] });
        assert.equal(JSON.stringify(state.profiles.get(OWNER)), profileBefore);
        assert.deepEqual(settings.keywords, ['ai agents']);
        assert.deepEqual(growthNow().keywords, ['ai agents']);
        assert.equal(count(PROFILE_WRITES), 0);
    });

    it('a stored profile that is itself invalid refuses an edit that needs a save, as a 400 with its problems', async () => {
        storeProfile({ ...ownerProfile(), audience: { ...ownerProfile().audience, description: 'x'.repeat(700) } });
        const before = copyOfState();
        const err = await updateGrowthSettings(OWNER, { goal_followers: 25_000 }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof GrowthError && err.status === 400, String(err));
        assert.ok(((err as GrowthError).extra?.problems as string[]).some((p) => /audience\.description/.test(p)));
        assert.equal(copyOfState(), before);
    });

    it('a patch the Growth rules refuse is the same 400 as before, with the profile untouched', async () => {
        storeProfile();
        const before = copyOfState();
        const err = await updateGrowthSettings(OWNER, { goal_followers: 'lots' }).then(() => null, (e: unknown) => e);
        assert.ok(err instanceof GrowthError && err.status === 400);
        assert.equal(copyOfState(), before);
    });

    it('a failing mirror rolls the row, the profile and the history back together', async () => {
        storeProfile();
        const before = copyOfState();
        db.failOn = /^INSERT INTO studio_settings /;
        await assert.rejects(updateGrowthSettings(OWNER, { goal_followers: 25_000 }), /injected failure/);
        assert.equal(copyOfState(), before);
    });
});

describe('updateGrowthSettings: locks', () => {
    it('an owned edit takes creators, the profile row, the Studio row, then the Growth row: the Studio row is locked before the Growth row is read', async () => {
        storeProfile();
        await updateGrowthSettings(OWNER, { goal_followers: 25_000 });
        inOrder(
            ['BEGIN', /^BEGIN$/], ['the creators mutex', MUTEX], ['the profile row, locked', PROFILE_ROW], ['the Studio row, locked', STUDIO_LOCK],
            ['the Growth row, locked', GROWTH_READ], ['the row write', GROWTH_WRITE], ['the profile update', PROFILE_UPDATE], ['the history row', HISTORY],
            ['the Studio mirror', STUDIO_WRITE], ['COMMIT', /^COMMIT$/]
        );
        assert.equal(first(MUTEX), first(/^BEGIN$/) + 1);
        assert.equal(first(PROFILE_ROW), first(MUTEX) + 1);
        lockOrderIsGlobal();
    });

    it('an edit that cannot need a save locks no Studio row', async () => {
        storeProfile();
        await updateGrowthSettings(OWNER, { keywords: ['ai agents'] });
        inOrder(['the creators mutex', MUTEX], ['the profile row', PROFILE_ROW], ['the Growth row', GROWTH_READ], ['the write', GROWTH_WRITE], ['COMMIT', /^COMMIT$/]);
        assert.equal(count(STUDIO_LOCK) + count(STUDIO_READ), 0);
        lockOrderIsGlobal();
    });

    it('a tenant with no stored profile takes the profile row second and locks no Studio row', async () => {
        await updateGrowthSettings(OWNER, { goal_followers: 25_000 });
        inOrder(['the creators mutex', MUTEX], ['the profile row', PROFILE_ROW], ['the Growth row', GROWTH_READ], ['the write', GROWTH_WRITE]);
        assert.equal(count(STUDIO_LOCK) + count(STUDIO_READ), 0);
        lockOrderIsGlobal();
    });
});
