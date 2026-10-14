/**
 * The Studio and Growth views over the Creator Profile (docs/onboarding/01 §0.3): the two lens laws on
 * the owner's fixtures and a neutral English one, the field-by-field map pinned from both ends, and the
 * shape rules (key order, absent optional keys) that the golden prompts depend on.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GrowthSettings } from '../../db/rows.js';
import { defaultGrowthSettings } from '../growth/settings.js';
import { defaultStudioSettings } from '../studio/settings.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { defaultProfile } from './defaults.js';
import { legacyBase, profileFromLegacy } from './legacy.js';
import { deepFreeze, getAt, hasAt, jsonbReorder, leafPaths, richProfile, scramble, throughJsonb, UPLOAD_A, UPLOAD_B } from './testSupport.js';
import type { CreatorProfile } from './types.js';
import { validateProfile } from './validate.js';
import { changedPaths, GROWTH_PROFILE_PATHS, growthIntoProfile, growthView, intoProfile, STUDIO_PROFILE_PATHS, studioView } from './views.js';

const withBrand = (s: StudioSettings, brand: Partial<StudioSettings['brand']>): StudioSettings => ({ ...s, brand: { ...s.brand, ...brand } });
const withProductUrl = (s: StudioSettings, url: string): StudioSettings => ({ ...s, product: { ...s.product, url } });

const STUDIOS: readonly [string, StudioSettings][] = [
    ['ELAMIR_SETTINGS', ELAMIR_SETTINGS],
    ['ELAMIR_SEED_SETTINGS', ELAMIR_SEED_SETTINGS],
    ['the neutral English fixture', ENGLISH_SETTINGS],
    ['the Studio defaults', defaultStudioSettings()],
    // brand.direction is a setting of its own, edited in Studio settings, and it need not agree with the language.
    ['an Arabic row set left to right', withBrand(ELAMIR_SEED_SETTINGS, { direction: 'ltr' })],
    ['an English row set right to left', withBrand(ENGLISH_SETTINGS, { direction: 'rtl' })],
    // The brand name the profile would show anyway when it holds none of its own, and a timezone it would show for none.
    ['a brand named as the English display name', withBrand(ELAMIR_SEED_SETTINGS, { name: ELAMIR_SEED_SETTINGS.infographic.name.en })],
    ['a timezone of UTC', { ...ELAMIR_SEED_SETTINGS, schedule: { ...ELAMIR_SEED_SETTINGS.schedule, timezone: 'UTC' } }],
];

const GROWTHS: readonly [string, GrowthSettings][] = [
    ['ELAMIR_GROWTH', ELAMIR_GROWTH],
    ['the Growth defaults', defaultGrowthSettings()],
    // The same facts with the audience's keys in another order: a view must keep the order it was given.
    ['an audience in another key order', { ...ELAMIR_GROWTH, audience: { timezone: 'Asia/Riyadh', languages: ['ar'], countries: ['SA', 'AE'] } }],
];

/** The profiles a row may be read into: the legacy base, and the neutral default in either language. */
const basesFor = (s: StudioSettings): readonly [string, CreatorProfile][] => [
    ['the legacy base', legacyBase(s.voice.language)],
    ['the default profile', defaultProfile({ lang: s.voice.language })],
    ['the default profile in the other language', defaultProfile({ lang: s.voice.language === 'ar' ? 'en' : 'ar' })],
];

/** Settings fields the profile does not own: how the agents work, the carousel template, the CTA words. */
const STUDIO_KEPT = [
    'brand.signature', 'brand.palette', 'brand.colors', 'brand.fonts.mono', 'brand.direction', 'brand.theme', 'cta', 'schedule.slots', 'library', 'examples',
    'monteur', 'infographic.platforms',
];
const GROWTH_KEPT = ['keywords', 'hashtag_sets', 'competitors'];
const isKept = (kept: readonly string[], leaf: string): boolean => kept.some((k) => leaf === k || leaf.startsWith(`${k}.`));

const same = (actual: unknown, expected: unknown, message?: string): void => {
    assert.deepStrictEqual(actual, expected, message);
    // The prompts print some of these objects as JSON, so key order is part of the value.
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${message ?? 'the objects'} differ in key order`);
};

describe('the profile owns exactly the settings 01 §2 says', () => {
    it('every leaf of every Studio fixture is either profile-owned or explicitly kept, never neither', () => {
        for (const [name, s] of STUDIOS) {
            for (const leaf of leafPaths(s)) {
                const owned = (STUDIO_PROFILE_PATHS as readonly string[]).includes(leaf);
                assert.notEqual(owned, isKept(STUDIO_KEPT, leaf), `${name}: ${leaf} must be owned by the profile or listed as kept, and not both`);
            }
        }
    });

    it('every owned Studio path exists in the seed, so each one is exercised', () => {
        for (const path of STUDIO_PROFILE_PATHS) assert.ok(hasAt(ELAMIR_SEED_SETTINGS, path), `${path} is in the seed`);
    });

    it('the same for the Growth settings', () => {
        for (const leaf of leafPaths(ELAMIR_GROWTH)) {
            const owned = (GROWTH_PROFILE_PATHS as readonly string[]).includes(leaf);
            assert.notEqual(owned, isKept(GROWTH_KEPT, leaf), `${leaf} must be owned by the profile or listed as kept, and not both`);
        }
        for (const path of GROWTH_PROFILE_PATHS) assert.ok(hasAt(ELAMIR_GROWTH, path), `${path} is in the owner's Growth settings`);
    });
});

describe('scramble, which the laws and the golden path (b) rest on', () => {
    it('overwrites every owned path the row has, and nothing else: a law over an unscrambled row would prove nothing', () => {
        const scrambled = scramble(ELAMIR_SEED_SETTINGS, STUDIO_PROFILE_PATHS);
        for (const path of STUDIO_PROFILE_PATHS) assert.notDeepStrictEqual(getAt(scrambled, path), getAt(ELAMIR_SEED_SETTINGS, path), `${path} is junk`);
        for (const leaf of leafPaths(ELAMIR_SEED_SETTINGS).filter((l) => isKept(STUDIO_KEPT, l))) {
            assert.deepStrictEqual(getAt(scrambled, leaf), getAt(ELAMIR_SEED_SETTINGS, leaf), `${leaf} is untouched`);
        }
        const growth = scramble(ELAMIR_GROWTH, GROWTH_PROFILE_PATHS);
        for (const path of GROWTH_PROFILE_PATHS) assert.notDeepStrictEqual(getAt(growth, path), getAt(ELAMIR_GROWTH, path), `${path} is junk`);
    });

    it('does not add a path the row does not have, and does not touch its input', () => {
        const none = scramble(defaultGrowthSettings(), GROWTH_PROFILE_PATHS);
        assert.deepStrictEqual(none.audience, {});
        assert.notDeepStrictEqual(none.goal_followers, defaultGrowthSettings().goal_followers);
        const before = structuredClone(ELAMIR_SEED_SETTINGS);
        scramble(ELAMIR_SEED_SETTINGS, STUDIO_PROFILE_PATHS);
        assert.deepStrictEqual(ELAMIR_SEED_SETTINGS, before);
    });
});

describe('jsonbReorder, the way golden path (b) stores a profile', () => {
    it('sorts object keys by their length in bytes and then by the bytes, as jsonb does, and leaves arrays alone', () => {
        const stored = jsonbReorder({ bb: 1, ا: 2, a: 3, ab: 4, longer: { z: 1, y: [{ ba: 1, c: 2 }, 'x'] } });
        assert.deepStrictEqual(Object.keys(stored), ['a', 'ab', 'bb', 'ا', 'longer'], '«ا» is two bytes, so it follows the two-letter keys');
        assert.deepStrictEqual(Object.keys(stored.longer), ['y', 'z']);
        assert.deepStrictEqual(Object.keys(stored.longer.y[0] as object), ['c', 'ba']);
        assert.deepStrictEqual(stored.longer.y[1], 'x');
    });

    it('changes the order of a real profile, and of nothing but the order', () => {
        const p = richProfile();
        const stored = throughJsonb(p);
        assert.notEqual(JSON.stringify(stored), JSON.stringify(p));
        assert.deepStrictEqual(stored, p, 'deepStrictEqual does not see key order');
        assert.deepStrictEqual(Object.keys(stored), [
            'dm', 'brand', 'goals', 'voice', 'offers', 'schema', 'content', 'socials', 'audience', 'identity', 'language', 'presenter',
        ]);
    });
});

describe('lens law 1: studioView(stale, intoProfile(p, s)) ≡ s', () => {
    for (const [name, s] of STUDIOS) {
        for (const [baseName, base] of basesFor(s)) {
            it(`${name}, read into ${baseName}: the stale row becomes the row`, () => {
                const p = intoProfile(base, s);
                same(studioView(scramble(s, STUDIO_PROFILE_PATHS), p), s);
            });
        }
    }

    it('holds one field at a time, so a failure names the field that was not replaced', () => {
        const p = intoProfile(legacyBase('ar'), ELAMIR_SEED_SETTINGS);
        for (const path of STUDIO_PROFILE_PATHS) {
            const view = studioView(scramble(ELAMIR_SEED_SETTINGS, [path]), p);
            assert.deepStrictEqual(getAt(view, path), getAt(ELAMIR_SEED_SETTINGS, path), `${path} is read from the profile, not the stored row`);
        }
    });

    it('a field the profile does not own is the stored one, whatever the profile says', () => {
        for (const [name, s] of STUDIOS) {
            const kept = leafPaths(s).filter((leaf) => isKept(STUDIO_KEPT, leaf));
            const stale = scramble(s, kept);
            const view = studioView(stale, richProfile());
            for (const leaf of kept) assert.deepStrictEqual(getAt(view, leaf), getAt(stale, leaf), `${name}: ${leaf} stays as stored`);
        }
    });
});

describe('lens law 2: intoProfile(p, studioView(s, p)) ≡ p', () => {
    for (const [name, s] of STUDIOS) {
        for (const [baseName, base] of basesFor(s)) {
            it(`${name}, read into ${baseName}: reading the view back changes nothing`, () => {
                const p = intoProfile(base, s, ELAMIR_GROWTH);
                same(intoProfile(p, studioView(s, p), growthView(ELAMIR_GROWTH, p)), p);
            });
        }
    }

    it('holds for a profile that was never read from settings, however full', () => {
        const p = richProfile();
        const s = studioView(defaultStudioSettings(), p);
        const g = growthView(defaultGrowthSettings(), p);
        same(intoProfile(p, s, g), p);
    });

    it('holds where the view is lossy: an empty brand name, an empty timezone, a redundant language override', () => {
        const rich = richProfile();
        const p: CreatorProfile = {
            ...rich,
            identity: { ...rich.identity, brand_name: '', timezone: '' },
            language: { ...rich.language, surfaces: { ...rich.language.surfaces, infographic: { language: 'ar' } } },
        };
        const s = studioView(defaultStudioSettings(), p);
        assert.equal(s.brand.name, 'Sami Fitness', 'with no brand name the Studio shows the English display name');
        assert.equal(s.schedule.timezone, 'UTC', 'with no timezone the Studio shows its own default');
        same(intoProfile(p, s, growthView(defaultGrowthSettings(), p)), p);
    });

    it('holds for an empty default, which has no offer, no brand name and no timezone', () => {
        for (const lang of ['ar', 'en'] as const) {
            const p = defaultProfile({ lang });
            same(intoProfile(p, studioView(defaultStudioSettings(), p), growthView(defaultGrowthSettings(), p)), p);
        }
    });
});

describe('both laws, for a tenant read into its virtual profile', () => {
    for (const [name, s] of STUDIOS) {
        it(`${name}: profileFromLegacy then the view gives the row back, and reading the view back changes nothing`, () => {
            const p = profileFromLegacy(s, ELAMIR_GROWTH);
            same(studioView(scramble(s, STUDIO_PROFILE_PATHS), p), s);
            same(intoProfile(p, studioView(s, p), growthView(ELAMIR_GROWTH, p)), p);
        });
    }
});

describe('the same laws for the Growth settings', () => {
    for (const [name, g] of GROWTHS) {
        it(`${name}: the stale row becomes the row, and reading the view back changes nothing`, () => {
            const p = intoProfile(legacyBase('ar'), ELAMIR_SEED_SETTINGS, g);
            same(growthView(scramble(g, GROWTH_PROFILE_PATHS), p), g);
            same(intoProfile(p, ELAMIR_SEED_SETTINGS, growthView(g, p)), p);
        });
    }

    it('holds one field at a time', () => {
        const p = intoProfile(legacyBase('ar'), ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        for (const path of GROWTH_PROFILE_PATHS) {
            const view = growthView(scramble(ELAMIR_GROWTH, [path]), p);
            assert.deepStrictEqual(getAt(view, path), getAt(ELAMIR_GROWTH, path), `${path} is read from the profile`);
        }
    });

    it('the keywords, hashtag sets and competitors are the stored ones, whatever the profile says', () => {
        const stale = scramble(ELAMIR_GROWTH, GROWTH_KEPT.filter((k) => hasAt(ELAMIR_GROWTH, k)));
        const view = growthView(stale, intoProfile(richProfile(), ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH));
        for (const k of GROWTH_KEPT) assert.deepStrictEqual(getAt(view, k), getAt(stale, k), k);
    });
});

describe('the map from settings to profile, pinned from the profile side', () => {
    // A lens that maps two fields onto each other consistently, the wrong way round, passes both laws.
    // These say which field is which, with a portrait the seed does not have.
    const s: StudioSettings = { ...ELAMIR_SEED_SETTINGS, infographic: { ...ELAMIR_SEED_SETTINGS.infographic, photo_url: UPLOAD_A } };
    const p = profileFromLegacy(s, ELAMIR_GROWTH);
    const offer = p.offers[0]!;
    const table: [string, unknown, unknown][] = [
        ['identity.brand_name ← brand.name', p.identity.brand_name, s.brand.name],
        ['brand.font_display ← brand.fonts.display', p.brand.font_display, s.brand.fonts.display],
        ['language.primary ← voice.language', p.language.primary, s.voice.language],
        ['language.digits ← voice.digits', p.language.digits, s.voice.digits],
        ['voice.guide ← voice.guide', p.voice.guide, s.voice.guide],
        ['content.never_mention ← voice.avoid', p.content.never_mention, s.voice.avoid],
        ['offers[primary].name ← product.name', offer.name, s.product.name],
        ['offers[primary].url ← product.url', offer.url, s.product.url],
        ['offers[primary].facts ← product.facts', offer.facts, s.product.facts],
        ['offers[primary].bullets ← product.dmBullets', offer.bullets, s.product.dmBullets],
        ['identity.timezone ← schedule.timezone', p.identity.timezone, s.schedule.timezone],
        ['identity.display_name.ar ← infographic.name.ar', p.identity.display_name.ar, s.infographic.name.ar],
        ['identity.display_name.en ← infographic.name.en', p.identity.display_name.en, s.infographic.name.en],
        ['socials.site ← infographic.site', p.socials.site, s.infographic.site],
        ['socials.handle ← infographic.handle', p.socials.handle, s.infographic.handle],
        ['socials.platforms ← infographic.socials', p.socials.platforms, s.infographic.socials],
        ['brand.primary ← infographic.primary', p.brand.primary, s.infographic.primary],
        ['brand.accent ← infographic.accent', p.brand.accent, s.infographic.accent],
        ['brand.portrait_url ← infographic.photo_url', p.brand.portrait_url, s.infographic.photo_url],
        ['brand.theme ← infographic.theme', p.brand.theme, s.infographic.theme],
        ['audience.countries ← growth audience.countries', p.audience.countries, ELAMIR_GROWTH.audience.countries],
        ['audience.languages ← growth audience.languages', p.audience.languages, ELAMIR_GROWTH.audience.languages],
        ['audience.timezone ← growth audience.timezone', p.audience.timezone, ELAMIR_GROWTH.audience.timezone],
        ['goals.followers ← goal_followers', p.goals.followers, ELAMIR_GROWTH.goal_followers],
        ['goals.views ← goal_views', p.goals.views, ELAMIR_GROWTH.goal_views],
    ];
    for (const [label, actual, expected] of table) {
        it(label, () => assert.deepStrictEqual(actual, expected));
    }

    it('and from the other side: a profile of all-different values lands in the right Studio and Growth fields', () => {
        const rich = richProfile();
        const view = studioView(defaultStudioSettings(), rich);
        const main = rich.offers[1]!;
        assert.equal(view.brand.name, 'Sami Fit Studio');
        assert.equal(view.brand.fonts.display, 'Tajawal');
        assert.equal(view.voice.language, 'ar');
        assert.equal(view.voice.digits, 'latin');
        assert.equal(view.voice.guide, 'Warm, direct, never preachy.');
        assert.deepEqual(view.voice.avoid, ['steroids', 'crash diets']);
        assert.deepEqual(view.product, { name: main.name, url: main.url, facts: main.facts, dmBullets: main.bullets }, 'the product is the PRIMARY offer, not the first');
        assert.equal(view.schedule.timezone, 'Africa/Cairo');
        assert.deepEqual(view.infographic.name, { ar: 'سامي للياقة', en: 'Sami Fitness' });
        assert.equal(view.infographic.site, 'samifit.example');
        assert.equal(view.infographic.handle, '@sami.fit');
        assert.deepEqual(view.infographic.socials, ['instagram', 'youtube']);
        assert.equal(view.infographic.primary, '#112233');
        assert.equal(view.infographic.accent, '#AABBCC');
        assert.equal(view.infographic.photo_url, UPLOAD_B, 'the portrait, not the logo');
        assert.equal(view.infographic.theme, 'light');
        assert.equal(view.infographic.language, 'ar');
        const growth = growthView(defaultGrowthSettings(), rich);
        assert.deepEqual(growth.audience, { countries: ['EG', 'SA'], languages: ['ar', 'en'], timezone: 'Asia/Dubai' });
        assert.equal(growth.goal_followers, 5000);
        assert.equal(growth.goal_views, 250_000);
    });
});

describe('what a view derives or falls back to', () => {
    it('brand.direction is the stored setting, whatever the profile\'s languages are', () => {
        // It is the carousel template's reading direction, edited in Studio settings (studio.js) and validated as
        // a setting of its own: an Arabic row set left to right, or an English one right to left, is a choice.
        const ar = defaultProfile({ lang: 'ar' });
        const en = defaultProfile({ lang: 'en' });
        const arabicCarousel: CreatorProfile = { ...en, language: { ...en.language, surfaces: { carousel: { language: 'ar' } } } };
        const englishCarousel: CreatorProfile = { ...ar, language: { ...ar.language, surfaces: { carousel: { language: 'en' } } } };
        for (const direction of ['rtl', 'ltr'] as const) {
            const stored = withBrand(defaultStudioSettings(), { direction });
            for (const p of [ar, en, arabicCarousel, englishCarousel, richProfile()]) {
                assert.equal(studioView(stored, p).brand.direction, direction);
            }
        }
        assert.ok(!(STUDIO_PROFILE_PATHS as readonly string[]).includes('brand.direction'), 'so a Studio PUT of it is not the profile\'s to route');
    });

    it('a profile read from settings does not take brand.direction either, and does not put one back', () => {
        for (const direction of ['rtl', 'ltr'] as const) {
            const s = withBrand(ELAMIR_SEED_SETTINGS, { direction });
            assert.equal(studioView(s, profileFromLegacy(s)).brand.direction, direction);
            assert.equal(studioView(scramble(s, ['brand.direction']), profileFromLegacy(s)).brand.direction, 'JUNK:brand.direction', 'a stale direction stays stale: the profile does not own it');
        }
    });

    it('brand.name falls back to the English display name, then to "My Studio"', () => {
        const p = defaultProfile({ lang: 'en' });
        assert.equal(studioView(defaultStudioSettings(), p).brand.name, 'My Studio');
        const named = { ...p, identity: { ...p.identity, display_name: { ar: 'سامي', en: 'Sami' } } };
        assert.equal(studioView(defaultStudioSettings(), named).brand.name, 'Sami');
        assert.equal(studioView(defaultStudioSettings(), { ...named, identity: { ...named.identity, brand_name: 'Sami Studio' } }).brand.name, 'Sami Studio');
        const arabicOnly = { ...p, identity: { ...p.identity, display_name: { ar: 'سامي', en: '' } } };
        assert.equal(studioView(defaultStudioSettings(), arabicOnly).brand.name, 'My Studio', 'the Arabic display name is not a Studio brand name');
    });

    it('schedule.timezone reads an empty profile timezone as UTC', () => {
        assert.equal(studioView(ELAMIR_SEED_SETTINGS, defaultProfile()).schedule.timezone, 'UTC');
    });

    it('the infographic language is the surface\'s, else the primary language', () => {
        const p = defaultProfile({ lang: 'ar' });
        assert.equal(studioView(defaultStudioSettings(), p).infographic.language, 'ar');
        const overridden: CreatorProfile = { ...p, language: { ...p.language, surfaces: { infographic: { language: 'en' } } } };
        assert.equal(studioView(defaultStudioSettings(), overridden).infographic.language, 'en');
    });

    it('a profile with no offer has no product: the stored one is not kept', () => {
        const view = studioView(ELAMIR_SEED_SETTINGS, defaultProfile());
        assert.deepStrictEqual(view.product, { name: '', url: '', facts: [], dmBullets: [] });
    });

    it('offers with none marked primary (an invalid profile) fall back to the first', () => {
        const rich = richProfile();
        const p = { ...rich, offers: rich.offers.map((o) => ({ ...o, primary: false })) };
        assert.equal(studioView(defaultStudioSettings(), p).product.name, 'One-to-one call');
    });
});

describe('the shape of a view: key order, and keys that are not there', () => {
    it('keeps the stored key order at every level the view touches', () => {
        const reversed = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T;
        const stored: StudioSettings = {
            ...reversed(ELAMIR_SEED_SETTINGS),
            brand: { ...reversed(ELAMIR_SEED_SETTINGS.brand), fonts: reversed(ELAMIR_SEED_SETTINGS.brand.fonts) },
            voice: reversed(ELAMIR_SEED_SETTINGS.voice),
            product: reversed(ELAMIR_SEED_SETTINGS.product),
            schedule: reversed(ELAMIR_SEED_SETTINGS.schedule),
            infographic: { ...reversed(ELAMIR_SEED_SETTINGS.infographic), name: reversed(ELAMIR_SEED_SETTINGS.infographic.name) },
        };
        const view = studioView(stored, intoProfile(legacyBase('ar'), stored));
        assert.deepEqual(Object.keys(view), Object.keys(stored));
        for (const section of ['brand', 'voice', 'product', 'schedule', 'infographic'] as const) {
            assert.deepEqual(Object.keys(view[section]), Object.keys(stored[section]), `${section} keeps its stored key order`);
        }
        assert.deepEqual(Object.keys(view.brand.fonts), Object.keys(stored.brand.fonts));
        assert.deepEqual(Object.keys(view.infographic.name), Object.keys(stored.infographic.name));
        assert.equal(JSON.stringify(view), JSON.stringify(stored));
    });

    it('leaves voice.avoid out when the row has none and the profile has nothing to say', () => {
        const { avoid: _avoid, ...voice } = ELAMIR_SEED_SETTINGS.voice;
        const stored: StudioSettings = { ...ELAMIR_SEED_SETTINGS, voice };
        const none = studioView(stored, { ...defaultProfile(), content: { ...defaultProfile().content, never_mention: [] } });
        assert.equal('avoid' in none.voice, false, 'no avoid key is invented');
        const some = studioView(stored, { ...defaultProfile(), content: { ...defaultProfile().content, never_mention: ['MCP'] } });
        assert.deepStrictEqual(some.voice.avoid, ['MCP'], 'but a word the profile has is written');
    });

    it('empties a stored voice.avoid the profile no longer has, rather than keeping or deleting it', () => {
        const view = studioView(ELAMIR_SEED_SETTINGS, defaultProfile());
        assert.deepStrictEqual(view.voice.avoid, []);
    });

    it('leaves the audience keys out that neither the row nor the profile has, and removes a stale timezone', () => {
        const none = growthView(defaultGrowthSettings(), defaultProfile());
        assert.deepStrictEqual(none.audience, {});
        assert.equal('timezone' in none.audience, false);
        const stale = growthView(ELAMIR_GROWTH, defaultProfile());
        assert.equal('timezone' in stale.audience, false, 'the heatmap override is gone with the profile\'s');
        assert.deepStrictEqual(stale.audience, { countries: [], languages: [] }, 'stale lists are emptied, in their order');
        assert.deepStrictEqual(Object.keys(stale.audience), ['countries', 'languages']);
    });

    it('writes no key as undefined, so JSON and deepStrictEqual agree', () => {
        const view = growthView(defaultGrowthSettings(), defaultProfile());
        assert.deepStrictEqual(view, defaultGrowthSettings());
        assert.equal(Object.values(view.audience).includes(undefined as never), false);
    });
});

describe('a view never touches its inputs and never shares what it was given', () => {
    it('is pure: frozen inputs are accepted, and nothing in them changes', () => {
        const stored = deepFreeze(structuredClone(ELAMIR_SEED_SETTINGS));
        const growth = deepFreeze(structuredClone(ELAMIR_GROWTH));
        const p = deepFreeze(richProfile());
        studioView(stored, p);
        growthView(growth, p);
        intoProfile(p, stored, growth);
        assert.deepStrictEqual(stored, ELAMIR_SEED_SETTINGS);
        assert.deepStrictEqual(growth, ELAMIR_GROWTH);
        assert.deepStrictEqual(p, richProfile());
    });

    it('shares no list with the profile or the settings it reads from', () => {
        const p = richProfile();
        const view = studioView(defaultStudioSettings(), p);
        view.voice.avoid!.push('JUNK');
        view.product.facts.push('JUNK');
        view.product.dmBullets.push('JUNK');
        view.infographic.socials.push('x');
        assert.deepStrictEqual(p, richProfile(), 'editing the view cannot edit the profile');

        const s = structuredClone(ELAMIR_SEED_SETTINGS);
        const back = intoProfile(richProfile(), s);
        back.socials.platforms.push('github');
        back.offers[1]!.facts.push('JUNK');
        back.content.never_mention.push('JUNK');
        assert.deepStrictEqual(s, ELAMIR_SEED_SETTINGS, 'editing the profile cannot edit the settings');
    });
});

describe('intoProfile', () => {
    it('keeps every field the settings do not carry: identity kind and niche, the presenter, the dm settings, the links', () => {
        const rich = richProfile();
        const p = intoProfile(rich, ELAMIR_SEED_SETTINGS);
        assert.deepStrictEqual(p.identity.kind, rich.identity.kind);
        assert.deepStrictEqual(p.identity.niche, rich.identity.niche);
        assert.deepStrictEqual(p.presenter, rich.presenter);
        assert.deepStrictEqual(p.content.rules, rich.content.rules);
        assert.deepStrictEqual(p.content.custom_rules, rich.content.custom_rules);
        assert.deepStrictEqual(p.voice.tone, rich.voice.tone);
        assert.deepStrictEqual(p.socials.links, rich.socials.links);
        assert.deepStrictEqual(p.dm.faq, rich.dm.faq);
        assert.deepStrictEqual(p.brand.logo_url, rich.brand.logo_url);
        assert.deepStrictEqual(p.offers[0], rich.offers[0], 'an offer that is not the primary is not the Studio\'s product');
        assert.deepStrictEqual(p.offers[1]!.campaign, rich.offers[1]!.campaign);
    });

    it('keeps an offer\'s sales block, the primary\'s included: the Studio\'s product is a name, a link, facts and bullets, so a Studio write never erases what the DM bot sells from', () => {
        const rich = richProfile();
        assert.ok(rich.offers[1]!.primary && rich.offers[1]!.sales, 'the fixture\'s primary offer has one');
        // A Studio write that changes the product the primary offer is read as.
        const edited = { ...ELAMIR_SEED_SETTINGS, product: { ...ELAMIR_SEED_SETTINGS.product, name: 'Renamed in the Studio', facts: ['one fact'] } };
        const p = intoProfile(rich, edited);
        assert.equal(p.offers[1]!.name, 'Renamed in the Studio', 'the write did land on the primary offer');
        assert.deepStrictEqual(p.offers[1]!.sales, rich.offers[1]!.sales);
        assert.deepStrictEqual(p.offers[0], rich.offers[0]);
    });

    it('does not show a sales block to the Studio: the view of the product is the same with it and without it', () => {
        const rich = richProfile();
        const bare = structuredClone(rich);
        for (const o of bare.offers) delete o.sales;
        assert.deepStrictEqual(studioView(ELAMIR_SEED_SETTINGS, rich), studioView(ELAMIR_SEED_SETTINGS, bare), 'no prompt builder that reads the settings can see it');
    });

    it('keeps the profile\'s audience and goals when no Growth settings are given, and replaces them when they are', () => {
        const rich = richProfile();
        const kept = intoProfile(rich, ELAMIR_SEED_SETTINGS);
        assert.deepStrictEqual(kept.audience, rich.audience);
        assert.deepStrictEqual(kept.goals, rich.goals);
        const replaced = intoProfile(rich, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        assert.deepStrictEqual(replaced.goals, { followers: 10_000, views: 1_000_000 });
    });

    it('has no knowledge base to carry: the DM bot\'s stays an agent setting, not a profile field', () => {
        assert.equal('knowledge' in richProfile().dm, false);
        assert.equal('knowledge' in intoProfile(defaultProfile(), ELAMIR_SEED_SETTINGS).dm, false);
        assert.equal('knowledge' in profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH).dm, false);
        assert.deepStrictEqual(Object.keys(defaultProfile().dm), ['faq', 'handoff', 'hours']);
    });

    it('takes the audience timezone from the Growth settings, or removes it', () => {
        const rich = richProfile();
        assert.equal(intoProfile(rich, ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH).audience.timezone, 'Asia/Riyadh');
        const without = intoProfile(rich, ELAMIR_SEED_SETTINGS, defaultGrowthSettings());
        assert.equal('timezone' in without.audience, false);
        assert.deepStrictEqual(without.audience.countries, []);
    });

    it('makes an offer from a product when the profile has none, and none from an empty product', () => {
        const fromProduct = intoProfile(defaultProfile(), ENGLISH_SETTINGS);
        assert.equal(fromProduct.offers.length, 1);
        assert.deepStrictEqual(fromProduct.offers[0], {
            id: 'main', kind: 'other', name: 'Spreadsheets from Zero', url: 'https://example.com/spreadsheets?ref=studio',
            facts: ['12 lessons', '3 hours of video', 'Lifetime access'], bullets: ['12 lessons · 3 hours of video', 'Lifetime access'],
            order_via: 'url', price: '', keyword: '', primary: true,
        });
        assert.deepStrictEqual(intoProfile(defaultProfile(), defaultStudioSettings()).offers, []);
    });

    it('turns a link-less offer into an order-by-message one, because an offer with neither is invalid', () => {
        const noLink: StudioSettings = { ...ENGLISH_SETTINGS, product: { ...ENGLISH_SETTINGS.product, url: '' } };
        assert.equal(intoProfile(defaultProfile(), noLink).offers[0]!.order_via, 'dm');
        const rich = richProfile();
        const p = intoProfile(rich, { ...ENGLISH_SETTINGS, product: { ...ENGLISH_SETTINGS.product, url: '' } });
        assert.equal(p.offers[1]!.order_via, 'dm');
        assert.equal(p.offers[1]!.url, '');
        // An offer that is already ordered by message keeps its link when the Studio has one.
        const dm: CreatorProfile = { ...rich, offers: [{ ...rich.offers[1]!, order_via: 'dm' }] };
        assert.equal(intoProfile(dm, ENGLISH_SETTINGS).offers[0]!.order_via, 'dm');
    });

    it('orders an offer by its link again when the link goes from empty to set', () => {
        const noLink: StudioSettings = { ...ENGLISH_SETTINGS, product: { ...ENGLISH_SETTINGS.product, url: '' } };
        const away = intoProfile(defaultProfile(), noLink);
        assert.equal(away.offers[0]!.order_via, 'dm');
        const back = intoProfile(away, ENGLISH_SETTINGS);
        assert.equal(back.offers[0]!.url, ENGLISH_SETTINGS.product.url);
        assert.equal(back.offers[0]!.order_via, 'url', 'the link the Studio has again is how the offer is ordered');
        // The same through the owner's course shell, which starts without a link.
        assert.equal(profileFromLegacy(ELAMIR_SEED_SETTINGS).offers[0]!.order_via, 'url');
        assert.equal(profileFromLegacy(withProductUrl(ELAMIR_SEED_SETTINGS, '')).offers[0]!.order_via, 'dm');
        // A message-only offer that has had a link all along is the tenant's choice: it stays.
        const rich = richProfile();
        const choice: CreatorProfile = { ...rich, offers: [{ ...rich.offers[1]!, order_via: 'dm' }] };
        assert.equal(intoProfile(choice, ELAMIR_SEED_SETTINGS).offers[0]!.order_via, 'dm');
    });

    it('writes the infographic language as an override only when it differs from the primary, and keeps the surface\'s register', () => {
        const base = legacyBase('ar');
        const english: StudioSettings = { ...ELAMIR_SEED_SETTINGS, infographic: { ...ELAMIR_SEED_SETTINGS.infographic, language: 'en' } };
        assert.deepStrictEqual(intoProfile(base, english).language.surfaces.infographic, { register: 'msa', language: 'en' });
        // The same language as the primary again: the override goes, the register stays.
        const back = intoProfile(intoProfile(base, english), ELAMIR_SEED_SETTINGS);
        assert.deepStrictEqual(back.language.surfaces.infographic, { register: 'msa' });
        // With nothing else on the surface, the surface goes too.
        const bare = defaultProfile({ lang: 'ar' });
        const over = intoProfile(bare, english);
        assert.deepStrictEqual(over.language.surfaces, { infographic: { language: 'en' } });
        assert.deepStrictEqual(intoProfile(over, ELAMIR_SEED_SETTINGS).language.surfaces, {});
    });

    it('keeps an infographic override that still holds when the primary language changes', () => {
        // Arabic infographics for an Arabic tenant; the Studio switches to English, the infographics stay Arabic.
        const p = intoProfile(defaultProfile({ lang: 'ar' }), { ...ELAMIR_SEED_SETTINGS, voice: { ...ELAMIR_SEED_SETTINGS.voice, language: 'en' } });
        assert.equal(p.language.primary, 'en');
        assert.deepStrictEqual(p.language.surfaces.infographic, { language: 'ar' });
    });

    describe('the Studio\'s language is not the DM bot\'s (01 §7.7, P8)', () => {
        const inEnglish = (s: StudioSettings): StudioSettings => ({ ...s, voice: { ...s.voice, language: 'en' } });

        it('a write that moves an Arabic profile off `ar` pins the DM surface to the Arabic and register it spoke', () => {
            for (const register of ['gulf', 'msa', 'egyptian', 'levantine'] as const) {
                const arabic: CreatorProfile = { ...defaultProfile({ lang: 'ar' }), language: { ...defaultProfile({ lang: 'ar' }).language, register } };
                const switched = intoProfile(arabic, inEnglish(ELAMIR_SEED_SETTINGS));
                assert.equal(switched.language.primary, 'en', register);
                assert.deepStrictEqual(switched.language.surfaces.dm, { language: 'ar', register }, register);
                assert.equal(switched.language.register, register, 'the profile\'s own register is kept');
                assert.ok('profile' in validateProfile(switched), `${register}: still a valid profile`);
            }
        });

        it('keeps what a DM surface already says: its register when it names one, and its language when it names one', () => {
            const arabic = defaultProfile({ lang: 'ar' });
            const registerOnly: CreatorProfile = { ...arabic, language: { ...arabic.language, register: 'gulf', surfaces: { dm: { register: 'levantine' } } } };
            assert.deepStrictEqual(intoProfile(registerOnly, inEnglish(ELAMIR_SEED_SETTINGS)).language.surfaces.dm, { register: 'levantine', language: 'ar' });
            const own: CreatorProfile = { ...arabic, language: { ...arabic.language, surfaces: { dm: { language: 'en' } } } };
            assert.deepStrictEqual(intoProfile(own, inEnglish(ELAMIR_SEED_SETTINGS)).language.surfaces.dm, { language: 'en' }, 'a DM surface that names its language is the tenant\'s choice');
        });

        it('does not touch the DM surface when the primary stays Arabic, or when it was not Arabic to begin with', () => {
            const arabic = defaultProfile({ lang: 'ar' });
            assert.equal(intoProfile(arabic, ELAMIR_SEED_SETTINGS).language.surfaces.dm, undefined);
            const english = defaultProfile({ lang: 'en' });
            assert.equal(intoProfile(english, ENGLISH_SETTINGS).language.surfaces.dm, undefined);
            assert.equal(intoProfile(english, ELAMIR_SEED_SETTINGS).language.surfaces.dm, undefined, 'English to Arabic: the DM was English and is Arabic now, with nothing to pin');
        });

        it('going back to Arabic leaves the pin: the DM is Arabic either way, and the lens laws hold at every step', () => {
            const owner = legacyBase('ar');
            const english = intoProfile(owner, inEnglish(ELAMIR_SEED_SETTINGS));
            const back = intoProfile(english, ELAMIR_SEED_SETTINGS);
            assert.equal(back.language.primary, 'ar');
            assert.deepStrictEqual(back.language.surfaces.dm, { language: 'ar', register: 'gulf' });
            for (const [p, s] of [[owner, inEnglish(ELAMIR_SEED_SETTINGS)], [english, ELAMIR_SEED_SETTINGS]] as const) {
                const into = intoProfile(p, s);
                assert.deepStrictEqual(studioView(scramble(s, STUDIO_PROFILE_PATHS), into).voice, s.voice, 'law 1: the view of what was written is what was written');
                assert.deepStrictEqual(changedPaths(into, intoProfile(into, studioView(s, into)), ['language', 'offers']), [], 'law 2: reading the view back changes nothing');
            }
        });
    });

    it('gives an Arabic surface it creates a register when the profile has none, and not when it has', () => {
        const arabicInfographic: StudioSettings = { ...ENGLISH_SETTINGS, infographic: { ...ENGLISH_SETTINGS.infographic, language: 'ar' } };
        const english = defaultProfile({ lang: 'en' });
        assert.equal(english.language.register, null);
        const made = intoProfile(english, arabicInfographic);
        assert.deepStrictEqual(made.language.surfaces.infographic, { language: 'ar', register: 'msa' }, 'a surface that speaks Arabic needs a register, and the Studio cannot name one');
        assert.ok('profile' in validateProfile(made));
        const withRegister = intoProfile({ ...english, language: { ...english.language, register: 'egyptian' } }, arabicInfographic);
        assert.deepStrictEqual(withRegister.language.surfaces.infographic, { language: 'ar' }, 'the profile\'s own register already serves it');
        const own = intoProfile({ ...english, language: { ...english.language, surfaces: { infographic: { register: 'levantine' } } } }, arabicInfographic);
        assert.deepStrictEqual(own.language.surfaces.infographic, { register: 'levantine', language: 'ar' }, 'and the surface\'s own is kept');
    });

    it('gives an Arabic profile the MSA register when the Studio switches an English one to Arabic, and keeps it going back', () => {
        const english = defaultProfile({ lang: 'en' });
        assert.equal(english.language.register, null);
        const arabic = intoProfile(english, { ...ENGLISH_SETTINGS, voice: { ...ENGLISH_SETTINGS.voice, language: 'ar', digits: 'arabic-indic' } });
        assert.equal(arabic.language.register, 'msa', 'an Arabic profile without a register would be invalid, and the Studio cannot say which');
        const egyptian = intoProfile({ ...arabic, language: { ...arabic.language, register: 'egyptian' } }, ENGLISH_SETTINGS);
        assert.equal(egyptian.language.primary, 'en');
        assert.equal(egyptian.language.register, 'egyptian', 'the chosen register survives a trip through English');
    });
});

describe('changedPaths: which profile-owned fields an edit changed (P4 routes exactly those into saveProfile)', () => {
    it('names the owned paths whose value differs, and only those', () => {
        const before = ELAMIR_SEED_SETTINGS;
        const after: StudioSettings = {
            ...before,
            brand: { ...before.brand, name: 'Another', palette: ['#FFD60A'] },
            schedule: { ...before.schedule, timezone: 'Europe/London' },
            voice: { ...before.voice, avoid: [...(before.voice.avoid ?? []), 'extra'] },
        };
        assert.deepStrictEqual(changedPaths(before, after, STUDIO_PROFILE_PATHS), ['brand.name', 'voice.avoid', 'schedule.timezone']);
    });

    it('is empty for a change to anything the profile does not own, however large', () => {
        const after: StudioSettings = {
            ...ELAMIR_SEED_SETTINGS,
            brand: { ...ELAMIR_SEED_SETTINGS.brand, palette: ['#FFD60A'], direction: 'rtl', signature: { latin: 'X', local: 'ي' } },
            cta: { ...ELAMIR_SEED_SETTINGS.cta, tiktokLine: 'Changed' },
            schedule: { ...ELAMIR_SEED_SETTINGS.schedule, slots: ['09:00'] },
            library: { root: '/elsewhere' },
            monteur: { ...ELAMIR_SEED_SETTINGS.monteur, enabled: !ELAMIR_SEED_SETTINGS.monteur.enabled },
            infographic: { ...ELAMIR_SEED_SETTINGS.infographic, platforms: ['facebook'] },
        };
        assert.deepStrictEqual(changedPaths(ELAMIR_SEED_SETTINGS, after, STUDIO_PROFILE_PATHS), []);
        assert.deepStrictEqual(changedPaths(ELAMIR_GROWTH, { ...ELAMIR_GROWTH, keywords: ['x'], hashtag_sets: [], competitors: [] }, GROWTH_PROFILE_PATHS), []);
    });

    it('compares lists and objects by value, and reads an absent key as undefined: adding or removing an optional key is a change', () => {
        assert.deepStrictEqual(changedPaths(ELAMIR_GROWTH, { ...ELAMIR_GROWTH, audience: { ...ELAMIR_GROWTH.audience, countries: [...ELAMIR_GROWTH.audience.countries!] } }, GROWTH_PROFILE_PATHS), []);
        const { timezone: _tz, ...withoutTimezone } = ELAMIR_GROWTH.audience;
        assert.deepStrictEqual(changedPaths(ELAMIR_GROWTH, { ...ELAMIR_GROWTH, audience: withoutTimezone }, GROWTH_PROFILE_PATHS), ['audience.timezone']);
        assert.deepStrictEqual(changedPaths({}, {}, GROWTH_PROFILE_PATHS), [], 'nothing on either side');
        assert.deepStrictEqual(changedPaths({ goal_followers: 1 }, { goal_followers: 2, goal_views: 3 }, GROWTH_PROFILE_PATHS), ['goal_followers', 'goal_views']);
    });
});

describe('growthIntoProfile: the Growth half of intoProfile', () => {
    const profiles: readonly [string, CreatorProfile][] = [
        ['the owner\'s', profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)],
        ['a rich one', richProfile()],
        ['the default', defaultProfile()],
    ];

    it('is intoProfile with a Studio the profile already says, for every Growth settings and profile', () => {
        for (const [name, p] of profiles) {
            for (const [growthName, g] of GROWTHS) {
                same(growthIntoProfile(p, g), intoProfile(p, studioView(defaultStudioSettings(), p), g), `${name} profile, ${growthName}`);
            }
        }
    });

    it('changes the audience countries, languages, timezone and the goals, and nothing else', () => {
        for (const [name, p] of profiles) {
            const out = growthIntoProfile(p, { keywords: ['x'], hashtag_sets: [], competitors: [], audience: { countries: ['KW'], languages: ['en'] }, goal_followers: 77, goal_views: 88 });
            assert.deepStrictEqual(out.audience.countries, ['KW'], name);
            assert.deepStrictEqual(out.audience.languages, ['en'], name);
            assert.ok(!('timezone' in out.audience), `${name}: a Growth row without an override removes the profile's`);
            assert.deepStrictEqual(out.goals, { followers: 77, views: 88 }, name);
            const { countries: _c, languages: _l, timezone: _t, ...restOfAudience } = out.audience;
            const { countries: _c2, languages: _l2, timezone: _t2, ...restBefore } = p.audience;
            assert.deepStrictEqual({ ...out, audience: restOfAudience, goals: p.goals }, { ...p, audience: restBefore }, `${name}: every other field is the profile's own`);
        }
    });

    it('is the inverse of growthView, and leaves its input alone', () => {
        for (const [name, p] of profiles) {
            const frozen = deepFreeze(structuredClone(p));
            for (const [growthName, g] of GROWTHS) {
                same(growthIntoProfile(frozen, growthView(g, frozen)), p, `${name} profile, ${growthName}`);
            }
        }
    });
});
