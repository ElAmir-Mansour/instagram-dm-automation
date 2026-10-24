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
import { growthRouter } from '../../routes/growth.js';
import { studioRouter } from '../../routes/studio.js';
import { setLogSink } from '../../utils/log.js';
import { dmFallbackReply } from '../../webhook/errors.js';
import { disclosureLine } from '../../webhook/meta-payload.js';
import { dmResponseSchema, dmSystemInstruction, starterPersona } from '../ai.js';
import { profileContext } from './context.js';
import { GrowthError } from '../growth/common.js';
import { getGrowthSettings, updateGrowthSettings } from '../growth/settings.js';
import { StudioError } from '../studio/common.js';
import { getStudioSettings, updateStudioSettings } from '../studio/settings.js';
import { ELAMIR_GROWTH } from '../studio/testFixtures.js';
import { withProfileCache } from './cache.js';
import { profileFromLegacy } from './legacy.js';
import { defaultProfile } from './defaults.js';
import { resetProfileWarnings, saveProfile } from './store.js';
import {
    GROWTH_COLUMNS, growthRow, installProfileDb, OWNER, OWNER_STUDIO, type ProfileDb, seededState, STUDIO_COLUMNS, studioRow, type State, USER,
} from './testDb.js';
import { richProfile, throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

const MUTEX = /^SELECT id FROM creators WHERE id = \$1 FOR NO KEY UPDATE$/;
const PROFILE_ROW = /^SELECT profile, version FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE$/;
const STUDIO_READ = /^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic, explainer FROM studio_settings WHERE creator_id = \$1 FOR UPDATE$/;
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
    resetProfileWarnings();
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

/**
 * P8: the DM bot and the comment replies read their language from the profile, and the Studio's `voice.language` is the
 * profile's primary language. On main the bot has never followed the Studio (it is Arabic, Gulf, whatever the Studio speaks),
 * so a write that switches the Studio to English must leave what the bot says exactly as it was: the same instruction, the
 * same schema, the same disclosure line and the same public fallback.
 */
describe('updateStudioSettings: switching the Studio language does not switch the DM bot (P8)', () => {
    /** Everything the DM and comment paths say, for the owner, as the real `profileContext` reads it from the stand-in database. */
    async function whatTheBotSays(): Promise<Record<string, string>> {
        const dm = await profileContext(OWNER, 'dm');
        const comments = await profileContext(OWNER, 'comment_reply');
        const arabicDm = 'هلا {username} 👋 اللينك هنا: https://example.com/c';
        return {
            language: JSON.stringify([dm.language, comments.language.register, dm.who.offerKind]),
            instruction: dmSystemInstruction('PERSONA', 'KB', dm),
            schema: JSON.stringify(dmResponseSchema(dm)),
            disclosure: disclosureLine(dm.language.code),
            persona: starterPersona(dm.language.code),
            instagram: dmFallbackReply({ dmText: arabicDm, isFacebook: false, register: comments.language.register }),
            facebook: dmFallbackReply({ dmText: arabicDm, isFacebook: true, register: comments.language.register }),
        };
    }

    it('the Studio goes English: the DM stays Arabic in the Gulf register, in every line, and the comment fallback stays Gulf', async () => {
        storeProfile();
        const before = await whatTheBotSays();
        assert.match(before.instruction!, /1\. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللغة العربية الفصحى أو بلهجة سهلة ومناسبة\./);

        await updateStudioSettings(OWNER, { voice: { language: 'en' } });

        const stored = storedProfile();
        assert.equal(stored.language.primary, 'en', 'the Studio did switch');
        assert.deepStrictEqual(stored.language.surfaces.dm, { language: 'ar', register: 'gulf' }, 'and the write pinned the DM surface');
        assert.equal(stored.language.register, 'gulf', 'the profile keeps its register');
        assert.deepStrictEqual(await whatTheBotSays(), before, 'nothing the bot says moved');
        const after = await whatTheBotSays();
        assert.equal(after.facebook, 'ما قدرنا نرسل لك على الخاص 🙏 هذا الرابط: https://example.com/c');
        assert.equal(after.instagram, 'ما قدرنا نرسل لك على الخاص 🙏 الرابط في البايو 🔗');
    });

    it('and back to Arabic: still the same', async () => {
        storeProfile();
        const before = await whatTheBotSays();
        await updateStudioSettings(OWNER, { voice: { language: 'en' } });
        await updateStudioSettings(OWNER, { voice: { language: 'ar' } });
        assert.equal(storedProfile().language.primary, 'ar');
        assert.deepStrictEqual(await whatTheBotSays(), before);
    });

    it('a tenant whose profile is not stored: no profile is created, and the legacy profile its rows describe keeps the DM Arabic and Gulf', async () => {
        assert.equal(state.profiles.has(OWNER), false, 'nothing is stored: the profile is the one his rows describe');
        const { language: _was, instagram: _ig, facebook: _fb, ...before } = await whatTheBotSays();
        await updateStudioSettings(OWNER, { voice: { language: 'en' } });
        assert.equal(state.profiles.has(OWNER), false, 'a write to a tenant with no profile creates none');
        assert.equal((state.studio.get(OWNER)!.voice as { language: string }).language, 'en', 'the Studio did switch');
        const { language, instagram, facebook, ...after } = await whatTheBotSays();
        assert.deepStrictEqual(after, before, 'the instruction, schema, disclosure and starter persona are the same');
        // The one line that moves for a tenant that has no stored profile (the owner has one, from the backfill): the legacy
        // profile of an English Studio names no register for comments, so an Arabic DM's public fallback reads as the neutral
        // one. A stored profile keeps its register (the test above). Pinned so that it cannot change unseen.
        assert.deepStrictEqual(JSON.parse(language!)[0], { code: 'ar', register: 'gulf', digits: 'arabic-indic', dir: 'rtl' });
        assert.equal(JSON.parse(language!)[1], null);
        assert.equal(facebook, 'لم نتمكن من مراسلتك في الخاص 🙏 هذا هو الرابط: https://example.com/c');
        assert.equal(instagram, 'لم نتمكن من مراسلتك في الخاص 🙏 الرابط في البايو 🔗');
    });

    it('an English-speaking Studio on a stored profile that names its own DM language keeps it', async () => {
        const p = ownerProfile();
        p.language.surfaces = { ...p.language.surfaces, dm: { language: 'ar', register: 'levantine' } };
        storeProfile(p);
        await updateStudioSettings(OWNER, { voice: { language: 'en' } });
        assert.deepStrictEqual(storedProfile().language.surfaces.dm, { language: 'ar', register: 'levantine' });
        assert.match((await whatTheBotSays()).instruction!, /باللهجة الشامية البسيطة/);
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

// ─── What the dashboard really sends ─────────────────────────────────────────────────────────

/**
 * The Studio settings screen's body (`StudioPage.settingsPayload`, dashboard/js/pages/studio.js): the six sections it
 * edits, each whole, as the last GET gave them, tidied the way the screen tidies them. A save with nothing edited is this.
 */
function studioScreenPayload(read: StudioSettings): Record<string, unknown> {
    const w = JSON.parse(JSON.stringify(read)) as StudioSettings;
    const tidy = (list: unknown): string[] => (Array.isArray(list) ? list.map((x) => String(x).trim()).filter(Boolean) : []);
    w.brand.palette = w.brand.palette.map((c) => String(c).toUpperCase()).filter((c) => /^#[0-9A-Fa-f]{6}$/.test(c));
    for (const key of ['ink', 'paper', 'muted'] as const) w.brand.colors[key] = String(w.brand.colors[key] || '').toUpperCase();
    w.product.facts = tidy(w.product.facts);
    w.product.dmBullets = tidy(w.product.dmBullets);
    w.schedule.slots = tidy(w.schedule.slots);
    w.library.root = typeof w.library.root === 'string' && w.library.root.trim() ? w.library.root.trim() : null;
    return Object.fromEntries((['brand', 'voice', 'product', 'cta', 'schedule', 'library'] as const).map((section) => [section, w[section]]));
}

/** The Growth screen's body for every save but a goal (`GrowthPage.settingsPayload`): the lists and the audience, whole. */
function growthScreenPayload(read: GrowthSettings, change: Partial<GrowthSettings> = {}): Record<string, unknown> {
    const w = JSON.parse(JSON.stringify({ ...read, ...change })) as GrowthSettings;
    return { keywords: w.keywords, hashtag_sets: w.hashtag_sets.map((x) => ({ name: x.name, tags: x.tags })), competitors: w.competitors, audience: w.audience };
}

/**
 * The tenant a profile was saved for: its rows are what the profile mirrored, as after a wizard or an edit. The first
 * save stores the legacy profile as version 1 and `profile` as version 2, so the tenant starts at version 2.
 */
async function savedAs(profile: CreatorProfile): Promise<void> {
    await saveProfile(OWNER, profile, { expectVersion: null, source: 'wizard', userId: null });
    assert.equal(versionNow(), 2);
    state.versions.length = 0;
    db.statements.length = 0;
}

describe('the Studio screen saves its six sections whole: with nothing edited that is no new version', () => {
    const TENANTS: [string, () => Promise<void>][] = [
        ['the owner, whose profile describes his rows', async () => storeProfile()],
        ['a tenant whose rows are a wizard\'s mirror', () => savedAs(richProfile())],
        ['a new Arabic tenant: a neutral profile and no row, which reads as the defaults, UTC and "My Studio" included', async () => {
            state.studio.delete(OWNER);
            state.growth.delete(OWNER);
            storeProfile(defaultProfile({ lang: 'ar' }));
        }],
        ['a new English tenant', async () => {
            state.studio.delete(OWNER);
            state.growth.delete(OWNER);
            storeProfile(defaultProfile({ lang: 'en' }));
        }],
    ];
    for (const [name, setup] of TENANTS) {
        it(name, async () => {
            await setup();
            const versionBefore = versionNow();
            const read = await getStudioSettings(OWNER);
            db.statements.length = 0;
            const { settings } = await updateStudioSettings(OWNER, studioScreenPayload(read));
            assert.equal(versionNow(), versionBefore, 'no new version');
            assert.equal(count(PROFILE_WRITES), 0, 'no profile write of any kind');
            assert.equal(state.versions.length, 0, 'no history row');
            assert.deepStrictEqual(settings, read, 'and the screen is answered with what it already showed');
        });
    }

    it('an edit among the six sections is one version, and the rest of the payload changes nothing else', async () => {
        await savedAs(richProfile());
        const payload = studioScreenPayload(await getStudioSettings(OWNER)) as { schedule: { timezone: string }; cta: { tiktokLine: string } };
        payload.schedule.timezone = 'Europe/London';
        payload.cta.tiktokLine = 'Comment below 👇';
        await updateStudioSettings(OWNER, payload);
        assert.equal(versionNow(), 3, 'one version on top of the wizard\'s');
        assert.equal(storedProfile().identity.timezone, 'Europe/London');
        assert.equal(studioNow().cta.tiktokLine, 'Comment below 👇');
        const { identity: after, ...restAfter } = storedProfile();
        const { identity: before, ...restBefore } = richProfile();
        assert.deepStrictEqual(restAfter, restBefore, 'nothing else in the profile moved');
        assert.deepStrictEqual({ ...after, timezone: before.timezone }, before);
    });
});

describe('the infographics screen', () => {
    it('removing the portrait, { infographic: { photo_url: null } }, is a profile change: portrait_url becomes null, one version', async () => {
        await savedAs(richProfile());
        assert.equal(richProfile().brand.portrait_url !== null, true);
        const { settings } = await updateStudioSettings(OWNER, { infographic: { photo_url: null } });
        assert.equal(versionNow(), 3, 'one version on top of the wizard\'s');
        assert.equal(storedProfile().brand.portrait_url, null);
        assert.equal(settings.infographic.photo_url, null);
        assert.equal(studioNow().infographic.photo_url, null);
        assert.deepStrictEqual((await getStudioSettings(OWNER)).infographic.photo_url, null);
    });

    it('removing a portrait there is none of is no change: no version', async () => {
        storeProfile();
        await updateStudioSettings(OWNER, { infographic: { photo_url: null } });
        assert.equal(versionNow(), 1);
        assert.equal(count(PROFILE_WRITES), 0);
        assert.equal(studioNow().infographic.photo_url, null);
    });

    it('uploading one, { infographic: { photo_url: <upload> } }, sets portrait_url', async () => {
        storeProfile();
        const url = 'https://app.example.com/api/uploads/33333333-3333-4333-8333-333333333333';
        await updateStudioSettings(OWNER, { infographic: { photo_url: url } });
        assert.equal(versionNow(), 2);
        assert.equal(storedProfile().brand.portrait_url, url);
    });

    it('saving the brand form (the whole infographic section, as read) with nothing edited is no version; one field edited is one', async () => {
        await savedAs(richProfile());
        const brand = JSON.parse(JSON.stringify((await getStudioSettings(OWNER)).infographic)) as StudioSettings['infographic'];
        await updateStudioSettings(OWNER, { infographic: brand });
        assert.equal(versionNow(), 2, 'still the wizard\'s');
        assert.equal(count(PROFILE_WRITES), 0);
        await updateStudioSettings(OWNER, { infographic: { ...brand, accent: '#123456' } });
        assert.equal(versionNow(), 3);
        assert.equal(storedProfile().brand.accent, '#123456');
        assert.equal(storedProfile().brand.portrait_url, richProfile().brand.portrait_url, 'the portrait the form carried is kept');
    });
});

describe('the Growth screen always sends the audience: a keyword, hashtag or competitor save is no new version', () => {
    const TENANTS: [string, () => Promise<void>][] = [
        ['the owner', async () => storeProfile()],
        ['a tenant whose rows are a wizard\'s mirror (audience with a timezone override)', () => savedAs(richProfile())],
        ['a new tenant: a neutral profile and no row (an empty audience)', async () => {
            state.studio.delete(OWNER);
            state.growth.delete(OWNER);
            storeProfile(defaultProfile({ lang: 'ar' }));
        }],
    ];
    for (const [name, setup] of TENANTS) {
        it(name, async () => {
            await setup();
            const versionBefore = versionNow();
            const read = await getGrowthSettings(OWNER);
            db.statements.length = 0;
            const settings = await updateGrowthSettings(OWNER, growthScreenPayload(read, { keywords: [...read.keywords, 'ai agents'] }));
            assert.equal(versionNow(), versionBefore, 'no new version');
            assert.equal(count(PROFILE_WRITES), 0);
            assert.equal(state.versions.length, 0);
            // The Studio row is locked (the patch carries an audience, so it may need a save) but never written: no mirror ran.
            assert.equal(count(STUDIO_WRITE), 0, 'the Studio row is not written');
            assert.deepEqual(settings.keywords, [...read.keywords, 'ai agents']);
            assert.deepEqual(growthNow().keywords, [...read.keywords, 'ai agents']);
            assert.deepStrictEqual(settings.audience, read.audience);
        });
    }

    it('a payload with the audience changed is one version, and the lists in it land too', async () => {
        await savedAs(richProfile());
        const read = await getGrowthSettings(OWNER);
        await updateGrowthSettings(OWNER, growthScreenPayload(read, { keywords: ['x'], audience: { ...read.audience, countries: ['KW'] } }));
        assert.equal(versionNow(), 3, 'one version on top of the wizard\'s');
        assert.deepEqual(storedProfile().audience.countries, ['KW']);
        assert.deepEqual(growthNow().keywords, ['x']);
    });

    it('the goals form sends only the goals: one version', async () => {
        storeProfile();
        await updateGrowthSettings(OWNER, { goal_followers: 25_000, goal_views: 2_000_000 });
        assert.equal(versionNow(), 2);
        assert.deepEqual(storedProfile().goals, { followers: 25_000, views: 2_000_000 });
    });
});

// ─── Who wrote it ────────────────────────────────────────────────────────────────────────────

describe('the profile version records who wrote it', () => {
    it('updateStudioSettings: the actor is updated_by on the profile and on its history row', async () => {
        storeProfile();
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } }, undefined, { userId: USER });
        assert.equal(state.profiles.get(OWNER)!.updated_by, USER);
        assert.deepEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[2, 'user', USER]]);
    });

    it('updateGrowthSettings: the same', async () => {
        storeProfile();
        await updateGrowthSettings(OWNER, { goal_followers: 25_000 }, { userId: USER });
        assert.equal(state.profiles.get(OWNER)!.updated_by, USER);
        assert.deepEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[2, 'user', USER]]);
    });

    it('with no actor (a job, a script) it is null, as before', async () => {
        storeProfile();
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } });
        await updateGrowthSettings(OWNER, { goal_followers: 25_000 });
        assert.deepEqual(state.versions.map((v) => v.updated_by), [null, null]);
    });

    it('through a caller\'s transaction too: the actor goes in the fourth argument', async () => {
        storeProfile();
        const client = { query: (q: string, p?: unknown[]) => (pool as unknown as { query: (a: string, b?: unknown[]) => Promise<never> }).query(q, p) };
        await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } }, client as never, { userId: USER });
        assert.equal(state.profiles.get(OWNER)!.updated_by, USER);
    });

    interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }
    const handlerFor = (router: unknown, path: string): Function => {
        const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods.put);
        assert.ok(layer, `PUT ${path} must be mounted`);
        return layer!.route!.stack.at(-1)!.handle;
    };
    const put = async (router: unknown, userId: string | null, body: unknown): Promise<{ statusCode: number; body: any }> => {
        const res = {
            statusCode: 200, body: null as any,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: unknown) { this.body = payload; return this; },
            setHeader() {}, end() { return this; },
        };
        await handlerFor(router, '/settings')({ params: {}, query: {}, headers: {}, body, session: { userId, role: 'user', tenantId: OWNER }, tenantRole: 'operator' }, res, () => {});
        return res;
    };

    it('PUT /api/studio/settings passes the session\'s user: that user is on the version the save made', async () => {
        storeProfile();
        const res = await put(studioRouter, USER, { schedule: { timezone: 'Europe/London' } });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(state.versions.map((v) => [v.version, v.updated_by]), [[2, USER]]);
        assert.equal(res.body.settings.schedule.timezone, 'Europe/London');
    });

    it('PUT /api/growth/settings passes the session\'s user', async () => {
        storeProfile();
        const res = await put(growthRouter, USER, { goal_followers: 25_000 });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(state.versions.map((v) => [v.version, v.updated_by]), [[2, USER]]);
    });

    it('the shared-password login has no user: the version is written by null, not refused', async () => {
        storeProfile();
        assert.equal((await put(studioRouter, null, { schedule: { timezone: 'Europe/London' } })).statusCode, 200);
        assert.equal((await put(growthRouter, null, { goal_followers: 25_000 })).statusCode, 200);
        assert.deepEqual(state.versions.map((v) => v.updated_by), [null, null]);
    });

    it('a profile refusal reaches the route as the same status and message: a newer-schema profile is a 409', async () => {
        storeProfile({ ...ownerProfile(), schema: 2 });
        const studio = await put(studioRouter, USER, { schedule: { timezone: 'Europe/London' } });
        assert.equal(studio.statusCode, 409);
        assert.match(studio.body.error, /newer version of the app/);
        const growth = await put(growthRouter, USER, { goal_followers: 25_000 });
        assert.equal(growth.statusCode, 409);
        assert.match(growth.body.error, /newer version of the app/);
    });
});

// ─── The request cache, after the commit ─────────────────────────────────────────────────────

describe('the request cache is cleared after the commit, not only before it', () => {
    /**
     * Another read of the profile that lands after `saveProfile` has cleared the cache and before the commit: it still sees
     * the committed-before state (a second connection's view), and caches it. The stand-in applies writes at once, so the
     * profile row is put back to what it was for the length of that read.
     */
    function readerLandsBeforeCommit(read: () => Promise<unknown>): void {
        const before = structuredClone(state.profiles.get(OWNER)!);
        let done = false;
        db.onStatement = async (statement) => {
            if (done || !/^COMMIT$/.test(statement)) return;
            done = true;
            const written = state.profiles.get(OWNER)!;
            state.profiles.set(OWNER, structuredClone(before));
            await read();
            state.profiles.set(OWNER, written);
        };
    }

    it('updateStudioSettings: a read in the same request afterwards sees the new profile', async () => {
        storeProfile();
        readerLandsBeforeCommit(() => getStudioSettings(OWNER));
        await withProfileCache(async () => {
            await updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } });
            assert.equal(versionNow(), 2);
            assert.equal((await getStudioSettings(OWNER)).schedule.timezone, 'Europe/London', 'not the profile a reader cached before the commit');
        });
    });

    it('updateGrowthSettings: the same', async () => {
        storeProfile();
        readerLandsBeforeCommit(() => getGrowthSettings(OWNER));
        await withProfileCache(async () => {
            await updateGrowthSettings(OWNER, { goal_followers: 25_000 });
            assert.equal(versionNow(), 2);
            assert.equal((await getGrowthSettings(OWNER)).goal_followers, 25_000);
        });
    });

    it('a write that is refused clears it too: the next read asks the database', async () => {
        storeProfile();
        await withProfileCache(async () => {
            await getStudioSettings(OWNER);
            intruderBumpsProfileOn(STUDIO_WRITE);
            await assert.rejects(updateStudioSettings(OWNER, { schedule: { timezone: 'Europe/London' } }), (err: unknown) => err instanceof StudioError && err.status === 409);
            db.statements.length = 0;
            await getStudioSettings(OWNER);
            assert.equal(count(/FROM creator_profiles/), 1, 'read again, not served from before the refused write');
        });
    });
});
