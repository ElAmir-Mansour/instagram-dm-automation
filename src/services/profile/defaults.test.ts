/**
 * The neutral profile and the way a stored one is read: nothing of the owner in the default, the same
 * values as the Studio's and Growth's own neutral defaults, and `upgradeProfile` as `overDefaults`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_GOALS, defaultGrowthSettings } from '../growth/settings.js';
import { defaultStudioSettings } from '../studio/settings.js';
import { ELAMIR_AGENT, ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { defaultProfile, upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import { richProfile } from './testSupport.js';
import type { ContentRulePreset, CreatorProfile } from './types.js';
import { activationMissing, validateProfile } from './validate.js';
import { growthView, studioView } from './views.js';

/** Whatever of the owner's, or of his dialect, a neutral profile must not carry. */
const OWNER_MARKERS = [
    'Agentic', 'بالعربي', 'Udemy', 'referralCode', 'elamir', 'الأمير', 'Clario', 'tech educator', 'course', 'كورس', 'الكورس', 'تبي', 'الحين',
    'منصور', 'MCP', 'Riyadh', 'LearnOnTikTok',
];
const markersIn = (value: unknown): string[] => {
    const json = JSON.stringify(value).toLowerCase();
    return OWNER_MARKERS.filter((m) => json.includes(m.toLowerCase()));
};

describe('defaultProfile', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`${lang}: contains none of the owner's markers`, () => {
            assert.deepStrictEqual(markersIn(defaultProfile({ lang })), []);
            assert.deepStrictEqual(markersIn(defaultProfile({ lang, rules: [] })), []);
        });

        it(`${lang}: is a valid profile, and not an activated one`, () => {
            const p = defaultProfile({ lang });
            const out = validateProfile(p);
            assert.ok('profile' in out, 'problems' in out ? out.problems.join('; ') : '');
            assert.deepStrictEqual(activationMissing(p), ['identity.display_name', 'identity.kind', 'identity.niche', 'identity.timezone', 'offers.primary.name']);
        });
    }

    it('Arabic is the default and speaks MSA with Arabic-Indic digits; English has no register', () => {
        assert.deepStrictEqual(defaultProfile().language, defaultProfile({ lang: 'ar' }).language);
        const ar = defaultProfile({ lang: 'ar' });
        assert.equal(ar.language.primary, 'ar');
        assert.equal(ar.language.register, 'msa');
        assert.equal(ar.language.digits, 'arabic-indic');
        assert.equal(ar.brand.font_display, 'Cairo', 'a font with Arabic glyphs');
        const en = defaultProfile({ lang: 'en' });
        assert.equal(en.language.register, null);
        assert.equal(en.language.digits, 'latin');
        assert.equal(en.brand.font_display, 'Inter');
    });

    it('has no presenter, no offer, no role, a general domain and no kind', () => {
        const p = defaultProfile();
        assert.equal(p.presenter, null);
        assert.deepStrictEqual(p.offers, []);
        assert.equal(p.identity.role, '');
        assert.equal(p.identity.kind, null);
        assert.equal(p.content.domain, 'general');
        assert.deepStrictEqual(p.language.surfaces, {});
    });

    it('the no-women rule is pre-ticked by default (D9), and the rules are exactly what it is given', () => {
        assert.deepStrictEqual(defaultProfile().content.rules, ['no_women_imagery']);
        assert.deepStrictEqual(defaultProfile({ lang: 'en' }).content.rules, ['no_women_imagery']);
        assert.deepStrictEqual(defaultProfile({ rules: [] }).content.rules, []);
        const rules: ContentRulePreset[] = ['no_women_imagery'];
        assert.deepStrictEqual(defaultProfile({ rules }).content.rules, rules);
    });

    it('does not share its rules with the list it was given, or with the next profile', () => {
        const rules: ContentRulePreset[] = ['no_women_imagery'];
        const p = defaultProfile({ rules });
        p.content.rules.length = 0;
        assert.deepStrictEqual(rules, ['no_women_imagery']);
        assert.deepStrictEqual(defaultProfile().content.rules, ['no_women_imagery']);
        const a = defaultProfile();
        a.audience.countries.push('SA');
        a.goals.followers = 1;
        assert.deepStrictEqual(defaultProfile().audience.countries, []);
        assert.equal(defaultProfile().goals.followers, 10_000);
    });

    it('its goals are the Growth settings\' default goals', () => {
        assert.deepStrictEqual(defaultProfile().goals, { followers: DEFAULT_GOALS.goal_followers, views: DEFAULT_GOALS.goal_views });
    });

    it('agrees with the Growth defaults exactly, and with the Studio defaults but for the voice guide it deliberately leaves empty', () => {
        assert.deepStrictEqual(growthView(defaultGrowthSettings(), defaultProfile()), defaultGrowthSettings());
        const studio = studioView(defaultStudioSettings(), defaultProfile({ lang: 'en' }));
        const expected = defaultStudioSettings();
        // `voice.guide` wins over every other voice field, so a default that wrote one would silence the tone and samples the wizard collects.
        expected.voice.guide = '';
        assert.deepStrictEqual(studio, expected);
        assert.equal(JSON.stringify(studio), JSON.stringify(expected));
    });
});

describe('upgradeProfile', () => {
    it('reads anything that is not an object as the default', () => {
        for (const raw of [null, undefined, 'x', 7, [], true]) assert.deepStrictEqual(upgradeProfile(raw), defaultProfile());
        assert.deepStrictEqual(upgradeProfile({}), defaultProfile());
    });

    it('is the identity on a valid profile, so a stored profile reads as it was written', () => {
        for (const p of [richProfile(), defaultProfile(), defaultProfile({ lang: 'en' }), defaultProfile({ rules: [] }), profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, ELAMIR_AGENT.knowledge_base)]) {
            assert.deepStrictEqual(upgradeProfile(p), p);
            assert.equal(JSON.stringify(upgradeProfile(p)), JSON.stringify(p));
            // And through the database: JSONB reorders keys and keeps nothing else.
            assert.deepStrictEqual(upgradeProfile(JSON.parse(JSON.stringify(p))), p);
        }
    });

    it('fills a field a release added later with its default, section by section', () => {
        const stored = JSON.parse(JSON.stringify(richProfile()));
        delete stored.voice.address;
        delete stored.identity.role;
        delete stored.dm;
        stored.brand = { primary: '#010203' };
        const p = upgradeProfile(stored);
        assert.equal(p.voice.address, '');
        assert.equal(p.identity.role, '');
        assert.deepStrictEqual(p.dm, defaultProfile().dm);
        assert.equal(p.brand.primary, '#010203');
        assert.equal(p.brand.accent, defaultProfile().brand.accent);
        assert.equal(p.identity.niche, richProfile().identity.niche, 'what was stored is kept');
    });

    it('drops what the profile has no field for, without reporting it', () => {
        const stored = { ...richProfile(), mystery: 1, identity: { ...richProfile().identity, nickname: 'x' } };
        assert.deepStrictEqual(upgradeProfile(stored), richProfile());
    });

    it('keeps the fields the default has no key for: surfaces, links, offers with campaigns, the audience timezone', () => {
        const p = upgradeProfile(richProfile());
        assert.deepStrictEqual(p.language.surfaces, richProfile().language.surfaces);
        assert.deepStrictEqual(p.socials.links, richProfile().socials.links);
        assert.deepStrictEqual(p.offers, richProfile().offers);
        assert.equal(p.audience.timezone, 'Asia/Dubai');
    });

    it('reads a profile with no audience timezone without one, and drops surface keys it does not know', () => {
        const stored = JSON.parse(JSON.stringify(richProfile()));
        delete stored.audience.timezone;
        stored.language.surfaces.mystery = { language: 'en' };
        stored.language.surfaces.dm.mystery = 'x';
        stored.socials.links.myspace = 'https://example.com';
        const p = upgradeProfile(stored);
        assert.equal('timezone' in p.audience, false);
        assert.equal('mystery' in p.language.surfaces, false);
        assert.deepStrictEqual(p.language.surfaces.dm, { register: 'levantine' });
        assert.equal('myspace' in p.socials.links, false);
    });

    it('fills an offer saved before a field existed from a blank offer', () => {
        const p = upgradeProfile({ offers: [{ id: 'a', name: 'Old offer', primary: true }] });
        assert.deepStrictEqual(p.offers, [{ id: 'a', kind: 'other', name: 'Old offer', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }]);
    });

    it('builds the default for the stored language, so an English profile does not get an Arabic font or register', () => {
        const p = upgradeProfile({ language: { primary: 'en' } });
        assert.equal(p.language.register, null);
        assert.equal(p.language.digits, 'latin');
        assert.equal(p.brand.font_display, 'Inter');
        assert.equal(upgradeProfile({ language: { primary: 'ar' } }).language.register, 'msa');
    });

    it('reads a profile with no rules key as the platform default, and one with an empty list as none', () => {
        const stored = JSON.parse(JSON.stringify(richProfile()));
        delete stored.content.rules;
        assert.deepStrictEqual(upgradeProfile(stored).content.rules, ['no_women_imagery'], 'a rule that was never written must not read as a rule that was switched off');
        stored.content.rules = [];
        assert.deepStrictEqual(upgradeProfile(stored).content.rules, []);
        stored.content.rules = ['no_women_imagery', 'a_preset_from_the_future'];
        assert.deepStrictEqual(upgradeProfile(stored).content.rules, ['no_women_imagery']);
    });

    it('survives the wrong type in a field, reading it as the default, rather than handing a reader something that throws', () => {
        const p = upgradeProfile({ identity: 'x', voice: { tone: 'warm', emoji: 5 }, goals: { followers: 'many' }, content: null, offers: 'none', dm: { faq: {} } });
        assert.deepStrictEqual(p, defaultProfile());
    });

    it('does not share anything with what it was given', () => {
        const stored = richProfile();
        const p = upgradeProfile(stored);
        p.voice.tone.push('JUNK');
        p.offers[1]!.campaign!.keywords.push('JUNK');
        p.dm.faq[0]!.q = 'JUNK';
        assert.deepStrictEqual(stored, richProfile());
    });

    it('the result of a valid profile is a valid profile', () => {
        const out: CreatorProfile = upgradeProfile(JSON.parse(JSON.stringify(richProfile())));
        assert.ok('profile' in validateProfile(out));
    });
});
