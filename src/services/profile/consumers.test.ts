/**
 * The Growth coach and the heatmap read the profile context (docs/onboarding/01 §4: `growth/coach.ts` `tenantLanguage`,
 * `growth/overview.ts` `tenantTimezone`; P5), where they used to read the Studio settings.
 *
 * What is pinned: the answer is the profile's (a stored profile that disagrees with the settings row wins, as the readers
 * overlay it), the coach surface's own language wins over the profile's, a tenant with no stored profile gets what its
 * settings say, and every fallback the old functions had is kept: English when the profile cannot be read, the audience's
 * own timezone first, an empty timezone reading as UTC, UTC when nothing can be read. A profile from a newer release is
 * not read, as the settings readers do not read it (the rows answer). The goldens (`golden.test.ts`) pin the same functions
 * for the owner's bytes.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { coachSystemPrompt, runCoach, tenantLanguage } from '../growth/coach.js';
import { getOverview, tenantTimezone } from '../growth/overview.js';
import { getStudioSettings } from '../studio/settings.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { withProfileCache } from './cache.js';
import { profileFromLegacy } from './legacy.js';
import { resetProfileTableWarning, resetProfileWarnings } from './store.js';
import { emptyState, growthRow, installProfileDb, missingTable, OTHER, OWNER, type ProfileDb, studioRow, type State } from './testDb.js';
import { throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

let state: State;
let db: ProfileDb;
let events: { level: string; event: string }[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    resetProfileTableWarning();
    resetProfileWarnings();
    events = [];
    const previous = setLogSink((level, line) => { try { events.push({ level, event: JSON.parse(line).event }); } catch { /* not structured */ } });
    restoreSink = () => setLogSink(previous);
    state = emptyState();
    db = installProfileDb(state);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

/** The tenant's settings rows, and (when given) the profile stored for it. */
function tenant(id: string, studio: StudioSettings, growth: GrowthSettings, profile?: CreatorProfile): void {
    state.studio.set(id, studioRow(studio));
    state.growth.set(id, growthRow(growth));
    if (profile) state.profiles.set(id, { profile: throughJsonb(profile), version: 1, activated_at: null, updated_by: null });
}

const ownerProfile = (): CreatorProfile => profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
const warned = (event: string): number => events.filter((e) => e.event === event).length;

describe('tenantLanguage', () => {
    it('is the profile\'s language, not the settings row\'s: a stored profile that disagrees with a stale row wins', async () => {
        const english = ownerProfile();
        english.language = { primary: 'en', register: null, digits: 'latin', surfaces: {} };
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, english); // the row still says Arabic
        assert.equal(ELAMIR_SEED_SETTINGS.voice.language, 'ar');
        assert.equal(await tenantLanguage(OWNER), 'en');

        const arabic = ownerProfile();
        tenant(OTHER, ENGLISH_SETTINGS, ELAMIR_GROWTH, arabic); // the row says English
        assert.equal(await tenantLanguage(OTHER), 'ar');
    });

    it('is the coach surface\'s language when it has its own, whatever the profile speaks', async () => {
        const p = ownerProfile();
        p.language.surfaces = { ...p.language.surfaces, coach: { language: 'en' } };
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, p);
        assert.equal(await tenantLanguage(OWNER), 'en', 'an Arabic tenant whose coach speaks English');

        const q = profileFromLegacy(ENGLISH_SETTINGS);
        q.language.surfaces = { ...q.language.surfaces, coach: { language: 'ar', register: 'msa' } };
        tenant(OTHER, ENGLISH_SETTINGS, ELAMIR_GROWTH, q);
        assert.equal(await tenantLanguage(OTHER), 'ar', 'an English tenant whose coach speaks Arabic');
    });

    it('a tenant with no stored profile is what its settings say (voice.language), as before', async () => {
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        tenant(OTHER, ENGLISH_SETTINGS, ELAMIR_GROWTH);
        assert.equal(await tenantLanguage(OWNER), 'ar');
        assert.equal(await tenantLanguage(OTHER), 'en');
        assert.equal(db.ran(/INSERT|UPDATE/).length, 0, 'reading the language stores nothing');
    });

    it('a tenant with no settings at all is English, the default voice language', async () => {
        assert.equal(await tenantLanguage(OWNER), 'en');
    });

    it('is English when the profile cannot be read, and says so unless the schema is simply missing', async () => {
        db.failOn = /creator_profiles/;
        db.failWith = new Error('connection refused');
        assert.equal(await tenantLanguage(OWNER), 'en');
        assert.equal(warned('growth.language_unreadable'), 1);

        db.failOn = /studio_settings/;
        db.failWith = missingTable('studio_settings');
        assert.equal(await tenantLanguage(OWNER), 'en');
        assert.equal(warned('growth.language_unreadable'), 1, 'a missing table is not worth a warning');
    });

    it('asks for the profile once per request however many readers need the coach\'s language and timezone', async () => {
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, ownerProfile());
        await withProfileCache(async () => {
            await tenantLanguage(OWNER);
            await tenantLanguage(OWNER);
            await tenantTimezone(OWNER);
        });
        // Each one is a context cut from the same stored row; the settings readers share the same cache.
        assert.equal(db.ran(/FROM creator_profiles/).length, 1);
    });
});

describe('tenantTimezone', () => {
    it('is the audience\'s own timezone first, without reading anything', async () => {
        assert.equal(await tenantTimezone(OWNER, 'Asia/Riyadh'), 'Asia/Riyadh');
        assert.equal(db.statements.length, 0);
    });

    it('is the profile\'s timezone otherwise: a stored profile wins over a stale settings row', async () => {
        const p = ownerProfile();
        p.identity.timezone = 'Asia/Dubai';
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, p); // the row says Asia/Riyadh
        assert.equal(ELAMIR_SEED_SETTINGS.schedule.timezone, 'Asia/Riyadh');
        assert.equal(await tenantTimezone(OWNER), 'Asia/Dubai');
        assert.equal(await tenantTimezone(OWNER, ''), 'Asia/Dubai', 'an empty audience timezone is none');
        assert.equal(await tenantTimezone(OWNER, undefined), 'Asia/Dubai');
    });

    it('is UTC when the profile has none yet: an empty timezone reads as UTC, as `schedule.timezone` does', async () => {
        const p = ownerProfile();
        p.identity.timezone = '';
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, p);
        assert.equal(await tenantTimezone(OWNER), 'UTC');
    });

    it('with no stored profile it is what the Studio row says, and UTC when that is empty or the tenant has no row', async () => {
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        assert.equal(await tenantTimezone(OWNER), 'Asia/Riyadh');
        tenant(OTHER, { ...ELAMIR_SEED_SETTINGS, schedule: { ...ELAMIR_SEED_SETTINGS.schedule, timezone: '' } }, ELAMIR_GROWTH);
        assert.equal(await tenantTimezone(OTHER), 'UTC');
        assert.equal(await tenantTimezone('99999999-9999-4999-8999-999999999999'), 'UTC');
    });

    it('is UTC when nothing can be read, with the same warning rule', async () => {
        db.failOn = /creator_profiles/;
        db.failWith = new Error('connection refused');
        assert.equal(await tenantTimezone(OWNER), 'UTC');
        assert.equal(warned('growth.timezone_unreadable'), 1);
        db.failOn = /studio_settings/;
        db.failWith = missingTable('studio_settings');
        assert.equal(await tenantTimezone(OWNER), 'UTC');
        assert.equal(warned('growth.timezone_unreadable'), 1);
    });
});

describe('a profile written by a newer release', () => {
    // Its language and timezone changed shape: this release reads them as the defaults ('ar', none), which are not what the
    // tenant's rows say, and not what the settings readers show (they pass the profile over and answer from the rows).
    const newer = (): CreatorProfile => {
        const p = ownerProfile() as unknown as Record<string, Record<string, unknown>>;
        return {
            ...p, schema: 2,
            identity: { ...p.identity, timezone: { iana: 'Asia/Dubai', fixed_offset_minutes: 240 } },
            language: { ...p.language, primary: { code: 'en', script: 'latin' } },
        } as unknown as CreatorProfile;
    };
    const rows = (): StudioSettings => ({ ...ENGLISH_SETTINGS, schedule: { ...ENGLISH_SETTINGS.schedule, timezone: 'Asia/Dubai' } });

    it('the coach\'s language and timezone are the rows\', which is what the settings readers show', async () => {
        tenant(OWNER, rows(), ELAMIR_GROWTH, newer());
        const shown = await getStudioSettings(OWNER);
        assert.equal(shown.voice.language, 'en', 'the settings readers answer from the row');
        assert.equal(shown.schedule.timezone, 'Asia/Dubai');
        assert.equal(await tenantLanguage(OWNER), 'en', 'not the default the half-read profile repairs to');
        assert.equal(await tenantTimezone(OWNER), 'Asia/Dubai', 'not UTC, which is what the half-read profile\'s timezone reads as');
        assert.equal(warned('profile.newer_schema'), 1, 'and it is said, once');
    });

    it('a profile this release reads is still what the coach follows, with the same rows', async () => {
        const p = ownerProfile();
        p.language = { primary: 'ar', register: 'gulf', digits: 'arabic-indic', surfaces: {} };
        p.identity.timezone = 'Asia/Kuwait';
        tenant(OWNER, rows(), ELAMIR_GROWTH, p);
        assert.equal(await tenantLanguage(OWNER), 'ar');
        assert.equal(await tenantTimezone(OWNER), 'Asia/Kuwait');
        assert.equal(warned('profile.newer_schema'), 0);
    });
});

describe('through the coach and the overview', () => {
    const NOW = new Date('2026-10-13T12:00:00Z');

    it('runCoach writes in the language the profile gives the coach, and the system prompt is that language\'s', async () => {
        const p = ownerProfile();
        p.language.surfaces = { ...p.language.surfaces, coach: { language: 'en' } };
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, p);
        const requests: { system: string; turns: { text: string }[] }[] = [];
        const out = await runCoach(OWNER, {
            now: NOW,
            callModel: async (req) => { requests.push(req as never); return { summary: 'Cut the intro.', actions: [{ title: 'Cut it', why: '3s', how: 'Open on the result', effort: 'low', impact: 'high' }] }; },
        });
        assert.equal(out.language, 'en');
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.system, coachSystemPrompt('en'));
        assert.notEqual(requests[0]!.system, coachSystemPrompt('ar'));
    });

    it('getOverview puts the profile\'s timezone in the heatmap when the audience has none, and the audience\'s when it has one', async () => {
        const p = ownerProfile();
        p.identity.timezone = 'Asia/Dubai';
        delete p.audience.timezone; // the profile owns the heatmap override: with none, the Growth row's own is not read either
        tenant(OWNER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, p);
        assert.equal((await getOverview(OWNER, { days: 28 }, NOW)).best_times_meta.timezone, 'Asia/Dubai');

        const p2 = ownerProfile();
        p2.identity.timezone = 'Asia/Dubai';
        p2.audience.timezone = 'Asia/Riyadh';
        tenant(OTHER, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, p2);
        assert.equal((await getOverview(OTHER, { days: 28 }, NOW)).best_times_meta.timezone, 'Asia/Riyadh');
    });
});
