/**
 * The neutral profile and the way a stored one is read: nothing of the owner in the default, the same
 * values as the Studio's and Growth's own neutral defaults, and `upgradeProfile` as `overDefaults`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_GOALS, defaultGrowthSettings } from '../growth/settings.js';
import { defaultStudioSettings } from '../studio/settings.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { blankSales, defaultProfile, upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import { richProfile, throughJsonb } from './testSupport.js';
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

    it('addresses a man in Arabic, as the pools are written, and no one in particular in English', () => {
        assert.equal(defaultProfile({ lang: 'ar' }).voice.address, 'masc');
        assert.equal(defaultProfile({ lang: 'en' }).voice.address, 'neutral');
    });

    it('has no knowledge base: that stays an agent setting, and the DM section is the faq, the handoff and the hours', () => {
        assert.deepStrictEqual(Object.keys(defaultProfile().dm), ['faq', 'handoff', 'hours']);
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
    /** The profile after storage: serialised, and its keys reordered the way Postgres does. */
    const stored = (p: CreatorProfile = richProfile()): any => throughJsonb(p);
    const profileOf = (raw: unknown): CreatorProfile => upgradeProfile(raw).profile;

    it('returns the profile, what it had to repair, and whether the schema is newer than this release', () => {
        const out = upgradeProfile(richProfile());
        assert.deepStrictEqual(Object.keys(out).sort(), ['newerSchema', 'profile', 'repaired']);
        assert.deepStrictEqual(out.repaired, []);
        assert.equal(out.newerSchema, false);
    });

    it('reads nothing, or anything that is not an object, as the default; only a value that was stored is a repair', () => {
        for (const raw of [null, undefined]) {
            const out = upgradeProfile(raw);
            assert.deepStrictEqual(out.profile, defaultProfile());
            assert.deepStrictEqual(out.repaired, []);
        }
        for (const raw of ['x', 7, [], true]) {
            const out = upgradeProfile(raw);
            assert.deepStrictEqual(out.profile, defaultProfile());
            assert.deepStrictEqual(out.repaired, ['profile'], `${JSON.stringify(raw)} was stored, and not kept`);
        }
        assert.deepStrictEqual(upgradeProfile({}), { profile: defaultProfile(), repaired: [], newerSchema: false });
    });

    it('is the identity on a valid profile, through storage, with nothing repaired', () => {
        for (const p of [richProfile(), defaultProfile(), defaultProfile({ lang: 'en' }), defaultProfile({ rules: [] }), profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)]) {
            const out = upgradeProfile(stored(p));
            assert.deepStrictEqual(out.profile, p);
            assert.deepStrictEqual(out.repaired, []);
            assert.equal(out.newerSchema, false);
            // And before it: serialised, with the keys left in the order they were written.
            assert.deepStrictEqual(upgradeProfile(JSON.parse(JSON.stringify(p))).profile, p);
        }
    });

    it('fills a field a release added later with its default, section by section, and that is not a repair', () => {
        const raw = stored();
        delete raw.voice.address;
        delete raw.identity.role;
        delete raw.dm;
        raw.brand = { primary: '#010203' };
        delete raw.offers[1].campaign.name_match;
        const out = upgradeProfile(raw);
        assert.equal(out.profile.voice.address, 'masc');
        assert.equal(out.profile.identity.role, '');
        assert.deepStrictEqual(out.profile.dm, defaultProfile().dm);
        assert.equal(out.profile.brand.primary, '#010203');
        assert.equal(out.profile.brand.accent, defaultProfile().brand.accent);
        assert.equal(out.profile.offers[1]!.campaign!.name_match, '', 'a campaign saved before name_match existed matches no course name');
        assert.equal(out.profile.identity.niche, richProfile().identity.niche, 'what was stored is kept');
        assert.deepStrictEqual(out.repaired, []);
    });

    it('drops what the profile has no field for, and says so', () => {
        const raw = { ...stored(), mystery: 1 };
        raw.identity.nickname = 'x';
        raw.offers[0].mystery = true;
        raw.offers[1].campaign.mystery = true;
        raw.language.surfaces.mystery = { language: 'en' };
        raw.language.surfaces.dm.mystery = 'x';
        raw.socials.links.myspace = 'https://example.com';
        const out = upgradeProfile(raw);
        assert.deepStrictEqual(out.profile, richProfile());
        assert.deepStrictEqual([...out.repaired].sort(), [
            'identity.nickname', 'language.surfaces.dm.mystery', 'language.surfaces.mystery', 'mystery', 'offers[0].mystery',
            'offers[1].campaign.mystery', 'socials.links.myspace',
        ]);
    });

    it('keeps the fields the default has no key for: surfaces, links, offers with campaigns, the audience timezone', () => {
        const out = upgradeProfile(stored());
        assert.deepStrictEqual(out.profile.language.surfaces, richProfile().language.surfaces);
        assert.deepStrictEqual(out.profile.socials.links, richProfile().socials.links);
        assert.deepStrictEqual(out.profile.offers, richProfile().offers);
        assert.equal(out.profile.audience.timezone, 'Asia/Dubai');
        const raw = stored();
        delete raw.audience.timezone;
        assert.equal('timezone' in profileOf(raw).audience, false);
        raw.audience.timezone = 5;
        const bad = upgradeProfile(raw);
        assert.equal('timezone' in bad.profile.audience, false);
        assert.deepStrictEqual(bad.repaired, ['audience.timezone']);
    });

    it('builds the default for the stored language, so an English profile does not get an Arabic font, register or address', () => {
        const en = profileOf({ language: { primary: 'en' } });
        assert.equal(en.language.register, null);
        assert.equal(en.language.digits, 'latin');
        assert.equal(en.brand.font_display, 'Inter');
        assert.equal(en.voice.address, 'neutral');
        assert.equal(profileOf({ language: { primary: 'ar' } }).language.register, 'msa');
        const bad = upgradeProfile({ language: { primary: 'fr' } });
        assert.equal(bad.profile.language.primary, 'ar');
        assert.deepStrictEqual(bad.repaired, ['language.primary']);
    });

    it('reads a profile with no rules key as the platform default, and one with an empty list as none', () => {
        const raw = stored();
        delete raw.content.rules;
        assert.deepStrictEqual(profileOf(raw).content.rules, ['no_women_imagery'], 'a rule that was never written must not read as a rule that was switched off');
        assert.deepStrictEqual(upgradeProfile(raw).repaired, [], 'and that is a field added later, not a repair');
        raw.content.rules = [];
        assert.deepStrictEqual(upgradeProfile(raw), { profile: { ...richProfile(), content: { ...richProfile().content, rules: [] } }, repaired: [], newerSchema: false });
        raw.content.rules = ['no_women_imagery', 'a_preset_from_the_future'];
        const out = upgradeProfile(raw);
        assert.deepStrictEqual(out.profile.content.rules, ['no_women_imagery']);
        assert.deepStrictEqual(out.repaired, ['content.rules']);
    });

    describe('what it checks, and names when it resets it', () => {
        const cases: [string, (raw: any) => void, string, (p: CreatorProfile) => unknown, unknown][] = [
            // The fields that are null by default, which a stored value of another kind must not replace.
            ['presenter that is a string', (r) => { r.presenter = 'Sami'; }, 'presenter', (p) => p.presenter, null],
            ['presenter missing a field', (r) => { delete r.presenter.on_camera; }, 'presenter', (p) => p.presenter, null],
            ['presenter with a number for a name', (r) => { r.presenter.name = 5; }, 'presenter', (p) => p.presenter, null],
            ['presenter with a pronoun that is not one', (r) => { r.presenter.pronouns = 'it'; }, 'presenter', (p) => p.presenter, null],
            ['kind outside its list', (r) => { r.identity.kind = 'wizard'; }, 'identity.kind', (p) => p.identity.kind, null],
            ['kind that is a number', (r) => { r.identity.kind = 7; }, 'identity.kind', (p) => p.identity.kind, null],
            ['country that is a number', (r) => { r.identity.country = 7; }, 'identity.country', (p) => p.identity.country, null],
            ['audience level outside its list', (r) => { r.audience.level = 'expert'; }, 'audience.level', (p) => p.audience.level, null],
            ['handoff that is a string', (r) => { r.dm.handoff = 'x'; }, 'dm.handoff', (p) => p.dm.handoff, null],
            ['handoff without a message', (r) => { delete r.dm.handoff.message; }, 'dm.handoff', (p) => p.dm.handoff, null],
            ['hours whose days are not a list', (r) => { r.dm.hours.days = 'mon'; }, 'dm.hours', (p) => p.dm.hours, null],
            ['hours whose days are not numbers', (r) => { r.dm.hours.days = ['mon']; }, 'dm.hours', (p) => p.dm.hours, null],
            ['hours without a time', (r) => { delete r.dm.hours.to; }, 'dm.hours', (p) => p.dm.hours, null],
            ['portrait that is a number', (r) => { r.brand.portrait_url = 3; }, 'brand.portrait_url', (p) => p.brand.portrait_url, null],
            ['logo that is a list', (r) => { r.brand.logo_url = []; }, 'brand.logo_url', (p) => p.brand.logo_url, null],
            // A campaign, which has no default.
            ['campaign that is a string', (r) => { r.offers[1].campaign = 'x'; }, 'offers[1].campaign', (p) => p.offers[1]!.campaign, undefined],
            ['campaign with a match mode that is not one', (r) => { r.offers[1].campaign.match = 'regex'; }, 'offers[1].campaign.match', (p) => p.offers[1]!.campaign!.match, 'substring'],
            ['campaign keywords that are not a list', (r) => { r.offers[1].campaign.keywords = 'a, b'; }, 'offers[1].campaign.keywords', (p) => p.offers[1]!.campaign!.keywords, []],
            ['campaign name_match that is a number', (r) => { r.offers[1].campaign.name_match = 5; }, 'offers[1].campaign.name_match', (p) => p.offers[1]!.campaign!.name_match, ''],
            // The rest of the fields, by type and by list.
            ['a section that is not an object', (r) => { r.identity = 'x'; }, 'identity', (p) => p.identity, defaultProfile().identity],
            ['a list that is not a list', (r) => { r.voice.tone = 'warm'; }, 'voice.tone', (p) => p.voice.tone, []],
            ['a text that is a number', (r) => { r.voice.guide = 5; }, 'voice.guide', (p) => p.voice.guide, ''],
            ['a number that is a string', (r) => { r.goals.followers = 'many'; }, 'goals.followers', (p) => p.goals.followers, 10_000],
            ['an emoji level outside its list', (r) => { r.voice.emoji = 'many'; }, 'voice.emoji', (p) => p.voice.emoji, 'light'],
            ['an address outside its list', (r) => { r.voice.address = 'you'; }, 'voice.address', (p) => p.voice.address, 'masc'],
            ['a register outside its list', (r) => { r.language.register = 'moroccan'; }, 'language.register', (p) => p.language.register, 'msa'],
            ['an Arabic profile with no register', (r) => { r.language.register = null; }, 'language.register', (p) => p.language.register, 'msa'],
            ['a font outside its list', (r) => { r.brand.font_display = 'Comic Sans'; }, 'brand.font_display', (p) => p.brand.font_display, 'Cairo'],
            ['surfaces that are a list', (r) => { r.language.surfaces = []; }, 'language.surfaces', (p) => p.language.surfaces, {}],
            ['a surface language outside its list', (r) => { r.language.surfaces.dm.language = 'fr'; }, 'language.surfaces.dm.language', (p) => p.language.surfaces.dm, { register: 'levantine' }],
            ['links that are a string', (r) => { r.socials.links = 'x'; }, 'socials.links', (p) => p.socials.links, {}],
            ['a link that is a number', (r) => { r.socials.links.instagram = 5; }, 'socials.links.instagram', (p) => p.socials.links, {}],
            ['offers that are not a list', (r) => { r.offers = {}; }, 'offers', (p) => p.offers, []],
            ['an offer that is a string', (r) => { r.offers[0] = 'x'; }, 'offers[0]', (p) => p.offers.length, 1],
            ['an offer kind outside its list', (r) => { r.offers[0].kind = 'subscription'; }, 'offers[0].kind', (p) => p.offers[0]!.kind, 'other'],
            ['an offer order_via outside its list', (r) => { r.offers[0].order_via = 'phone'; }, 'offers[0].order_via', (p) => p.offers[0]!.order_via, 'dm'],
        ];
        for (const [name, edit, path, read, expected] of cases) {
            it(`${name}: reads as ${JSON.stringify(expected)?.slice(0, 40) ?? 'absent'} and names ${path}`, () => {
                const raw = stored();
                edit(raw);
                const out = upgradeProfile(raw);
                assert.deepStrictEqual(read(out.profile), expected);
                assert.ok(out.repaired.includes(path), `repaired is ${JSON.stringify(out.repaired)}`);
                assert.equal(out.newerSchema, false);
            });
        }

        it('drops the entries of a list that are not what the list holds, and names the list', () => {
            const raw = stored();
            raw.voice.tone = ['warm', 5, null, 'direct'];
            raw.dm.faq = [{ q: 'a', a: 'b' }, { q: 'only a question' }, 'x'];
            raw.socials.platforms = ['instagram', 'myspace', 7];
            raw.offers[1].facts = ['12 weeks', 12];
            raw.offers[1].campaign.public_replies = [{}];
            const out = upgradeProfile(raw);
            assert.deepStrictEqual(out.profile.voice.tone, ['warm', 'direct']);
            assert.deepStrictEqual(out.profile.dm.faq, [{ q: 'a', a: 'b' }]);
            assert.deepStrictEqual(out.profile.socials.platforms, ['instagram']);
            assert.deepStrictEqual(out.profile.offers[1]!.facts, ['12 weeks']);
            assert.deepStrictEqual(out.profile.offers[1]!.campaign!.public_replies, []);
            assert.deepStrictEqual([...out.repaired].sort(), ['dm.faq', 'offers[1].campaign.public_replies', 'offers[1].facts', 'socials.platforms', 'voice.tone']);
        });

        it('says nothing for a value it checks and keeps, so repaired is never noise', () => {
            const raw = stored();
            raw.presenter = { name: 'Sam', pronouns: 'they', on_camera: 'voice' };
            raw.identity.kind = 'shop';
            raw.dm.handoff = { when: 'a refund', message: 'A person will reply' };
            raw.dm.hours = { days: [1, 2], from: '10:00', to: '14:00' };
            raw.offers[1].campaign.match = 'substring';
            const out = upgradeProfile(raw);
            assert.deepStrictEqual(out.repaired, []);
            assert.deepStrictEqual(out.profile.presenter, raw.presenter);
            assert.deepStrictEqual(out.profile.dm.hours, raw.dm.hours);
        });

        it('survives every field being the wrong type at once, with a repair for each section it had to reset', () => {
            const out = upgradeProfile({ identity: 'x', language: 7, offers: 'none', audience: [], voice: { tone: 'warm', emoji: 5 }, presenter: 1, content: null, brand: 3, socials: 'y', dm: { faq: {} }, goals: { followers: 'many' } });
            assert.deepStrictEqual(out.profile, defaultProfile());
            for (const path of ['identity', 'language', 'offers', 'audience', 'voice.tone', 'voice.emoji', 'presenter', 'content', 'brand', 'socials', 'dm.faq', 'goals.followers']) {
                assert.ok(out.repaired.includes(path), `${path} is named: ${JSON.stringify(out.repaired)}`);
            }
        });
    });

    describe('a schema newer than this release', () => {
        it('is flagged, and nothing unknown is dropped, so what a newer release stored is still on the profile', () => {
            const raw = stored();
            raw.schema = 2;
            raw.mystery = { from: 'the future' };
            raw.identity.pronunciation = 'sa-mee';
            raw.offers[1].campaign.window = 7;
            raw.offers[0].subscription = { monthly: true };
            raw.language.surfaces.podcast = { language: 'en' };
            raw.language.surfaces.dm.tone = 'formal';
            raw.socials.links.mastodon = 'https://example.social/@sami';
            raw.audience.age = '25-34';
            const out = upgradeProfile(raw);
            assert.equal(out.newerSchema, true);
            assert.deepStrictEqual(out.repaired, [], 'unknown keys are not repairs when the schema is newer: they are kept');
            const p = out.profile as unknown as Record<string, any>;
            assert.deepStrictEqual(p.mystery, { from: 'the future' });
            assert.equal(p.identity.pronunciation, 'sa-mee');
            assert.equal(p.offers[1].campaign.window, 7);
            assert.deepStrictEqual(p.offers[0].subscription, { monthly: true });
            assert.deepStrictEqual(p.language.surfaces.podcast, { language: 'en' });
            assert.equal(p.language.surfaces.dm.tone, 'formal');
            assert.equal(p.socials.links.mastodon, 'https://example.social/@sami');
            assert.equal(p.audience.age, '25-34');
            assert.equal(p.schema, 2, 'the stored schema stays as stored');
        });

        it('cannot be saved by mistake: validateProfile refuses a schema other than 1', () => {
            const raw = stored();
            raw.schema = 2;
            const out = validateProfile(upgradeProfile(raw).profile);
            assert.ok('problems' in out);
            assert.match(out.problems.join('|'), /profile\.schema must be 1/);
        });

        it('still checks the fields it knows, and names them', () => {
            const raw = stored();
            raw.schema = 3;
            raw.presenter = 'x';
            const out = upgradeProfile(raw);
            assert.equal(out.newerSchema, true);
            assert.deepStrictEqual(out.repaired, ['presenter']);
        });

        it('is only a schema above 1: 1, a missing one, and a garbled one are this release\'s', () => {
            assert.equal(upgradeProfile(stored()).newerSchema, false);
            const missing = stored();
            delete missing.schema;
            assert.deepStrictEqual(upgradeProfile(missing).repaired, []);
            for (const bad of [0, 1.5, -1, 'x', null, [], {}]) {
                const raw = stored();
                raw.schema = bad;
                const out = upgradeProfile(raw);
                assert.equal(out.newerSchema, false, JSON.stringify(bad));
                assert.equal(out.profile.schema, 1);
                assert.deepStrictEqual(out.repaired, ['schema'], JSON.stringify(bad));
            }
        });
    });

    it('does not share anything with what it was given', () => {
        const raw = stored();
        const out = upgradeProfile(raw);
        out.profile.voice.tone.push('JUNK');
        out.profile.offers[1]!.campaign!.keywords.push('JUNK');
        out.profile.dm.faq[0]!.q = 'JUNK';
        out.profile.language.surfaces.dm!.register = 'gulf';
        assert.deepStrictEqual(raw, stored());
    });

    it('the result of a valid profile is a valid profile', () => {
        assert.ok('profile' in validateProfile(upgradeProfile(stored()).profile));
    });
});

/**
 * `Offer.sales` as a stored profile is read (docs/DM_SALES_PLAN.md §5, S4). The block is JSONB inside `creator_profiles`, so there is no
 * migration, and the reader is what makes it safe: a reader that did not know the key would read it as an unknown field, name it in
 * `repaired` and drop it, and the next save would erase what the owner typed. These pin that it survives, and that a bad one is
 * repaired the way every other field is.
 */
describe('upgradeProfile: Offer.sales', () => {
    const stored = (p: CreatorProfile = richProfile()): any => throughJsonb(p);
    const main = (p: CreatorProfile): NonNullable<CreatorProfile['offers'][number]['sales']> => p.offers[1]!.sales!;

    it('reads a stored sales block as it was written, keys reordered by the database, with nothing repaired', () => {
        const raw = stored();
        assert.notEqual(JSON.stringify(raw.offers[1].sales), JSON.stringify(richProfile().offers[1]!.sales), 'the keys really were reordered');
        const out = upgradeProfile(raw);
        assert.deepStrictEqual(out.repaired, []);
        assert.deepStrictEqual(out.profile.offers[1]!.sales, richProfile().offers[1]!.sales);
        assert.deepStrictEqual(out.profile, richProfile());
    });

    it('leaves an offer with no block without one: an absent key stays absent', () => {
        const out = upgradeProfile(stored());
        assert.equal('sales' in out.profile.offers[0]!, false);
        assert.deepStrictEqual(out.repaired, []);
    });

    it('fills a field a release added later from the blank block, section by section, and that is not a repair', () => {
        const raw = stored();
        delete raw.offers[1].sales.currency;
        delete raw.offers[1].sales.proof;
        delete raw.offers[1].sales.level;
        const out = upgradeProfile(raw);
        assert.equal(main(out.profile).currency, '');
        assert.deepStrictEqual(main(out.profile).proof, []);
        assert.equal(main(out.profile).level, 'any');
        assert.equal(main(out.profile).for_whom, richProfile().offers[1]!.sales!.for_whom, 'what was stored is kept');
        assert.deepStrictEqual(out.repaired, []);
    });

    it('reads an empty block as the blank one: it states no price and pitches at no one', () => {
        const raw = stored();
        raw.offers[1].sales = {};
        const out = upgradeProfile(raw);
        assert.deepStrictEqual(main(out.profile), blankSales());
        assert.equal(main(out.profile).price_valid_until, '');
        assert.deepStrictEqual(out.repaired, []);
        assert.ok('profile' in validateProfile(out.profile));
    });

    it('drops a key the block has no field for, and says so', () => {
        const raw = stored();
        raw.offers[1].sales.mystery = 1;
        const out = upgradeProfile(raw);
        assert.deepStrictEqual(out.profile, richProfile());
        assert.deepStrictEqual(out.repaired, ['offers[1].sales.mystery']);
    });

    it('resets what is stored in the wrong shape to the blank value, and names the path', () => {
        const cases: [string, (raw: any) => void, string, unknown][] = [
            ['a block that is a string', (r) => { r.offers[1].sales = 'x'; }, 'offers[1].sales', undefined],
            ['a block that is a list', (r) => { r.offers[1].sales = []; }, 'offers[1].sales', undefined],
            ['a level outside its list', (r) => { r.offers[1].sales.level = 'expert'; }, 'offers[1].sales.level', 'any'],
            ['a level that is a number', (r) => { r.offers[1].sales.level = 3; }, 'offers[1].sales.level', 'any'],
            ['for_whom that is a number', (r) => { r.offers[1].sales.for_whom = 5; }, 'offers[1].sales.for_whom', ''],
            ['outcomes that are not a list', (r) => { r.offers[1].sales.outcomes = 'a, b'; }, 'offers[1].sales.outcomes', []],
            ['a price date that is a number', (r) => { r.offers[1].sales.price_valid_until = 20261231; }, 'offers[1].sales.price_valid_until', ''],
            ['a currency that is a list', (r) => { r.offers[1].sales.currency = ['USD']; }, 'offers[1].sales.currency', ''],
            ['an image that is a number', (r) => { r.offers[1].sales.image_url = 1; }, 'offers[1].sales.image_url', ''],
        ];
        for (const [what, edit, path, value] of cases) {
            const raw = stored();
            edit(raw);
            const out = upgradeProfile(raw);
            assert.deepStrictEqual(out.repaired, [path], what);
            const read = path === 'offers[1].sales' ? out.profile.offers[1]!.sales : (main(out.profile) as unknown as Record<string, unknown>)[path.split('.').pop()!];
            assert.deepStrictEqual(read, value, what);
        }
    });

    it('drops a list entry that is not what its list holds, and keeps the others', () => {
        const raw = stored();
        raw.offers[1].sales.faqs = [{ q: 'ok', a: 'fine' }, { q: 'no answer' }, 'x', { q: 5, a: 'a' }];
        raw.offers[1].sales.objections = [{ objection: 'o', answer: 'a' }, { objection: 'o' }];
        raw.offers[1].sales.outcomes = ['one', 2, null, 'three'];
        raw.offers[1].sales.proof = [
            { kind: 'stat', text: 't', source: 's' }, { kind: 'rumour', text: 't', source: 's' }, { kind: 'stat', text: 't' }, { text: 't', source: 's' },
        ];
        const out = upgradeProfile(raw);
        assert.deepStrictEqual(main(out.profile).faqs, [{ q: 'ok', a: 'fine' }]);
        assert.deepStrictEqual(main(out.profile).objections, [{ objection: 'o', answer: 'a' }]);
        assert.deepStrictEqual(main(out.profile).outcomes, ['one', 'three']);
        assert.deepStrictEqual(main(out.profile).proof, [{ kind: 'stat', text: 't', source: 's' }]);
        assert.deepStrictEqual([...out.repaired].sort(), ['offers[1].sales.faqs', 'offers[1].sales.objections', 'offers[1].sales.outcomes', 'offers[1].sales.proof']);
    });

    it('with a schema newer than this release, keeps what a newer release added to the block', () => {
        const raw = stored();
        raw.schema = 2;
        raw.offers[1].sales.guarantee = { days: 30 };
        const out = upgradeProfile(raw);
        assert.equal(out.newerSchema, true);
        assert.deepStrictEqual(out.repaired, []);
        assert.deepStrictEqual((main(out.profile) as unknown as Record<string, unknown>).guarantee, { days: 30 });
    });

    it('does not share anything with what it was given', () => {
        const raw = stored();
        const out = upgradeProfile(raw);
        main(out.profile).outcomes.push('JUNK');
        main(out.profile).faqs[0]!.q = 'JUNK';
        main(out.profile).proof[0]!.text = 'JUNK';
        assert.deepStrictEqual(raw, stored());
    });

    it('blankSales() is a block of its own each time, and a valid one when it sits on an offer', () => {
        const a = blankSales();
        a.outcomes.push('x');
        assert.deepStrictEqual(blankSales().outcomes, []);
        const p = richProfile();
        p.offers[1]!.sales = blankSales();
        assert.ok('profile' in validateProfile(p));
    });
});
