/**
 * What a Creator Profile must hold (01 §1): every limit, the formats, the cross-field rules, the size
 * the table allows, and activation. Then the limits' floors: each moved field's limit is found by
 * probing today's Studio and Growth validators, so a valid PUT there cannot make an invalid profile.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GrowthSettings } from '../../db/rows.js';
import { applyGrowthPatch, defaultGrowthSettings, DEFAULT_GOALS, GROWTH_LIMITS } from '../growth/settings.js';
import {
    DISPLAY_FONTS, defaultStudioSettings, INFOGRAPHIC_SOCIALS, INFOGRAPHIC_THEMES, settingsProblems,
} from '../studio/settings.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { defaultProfile, upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import { richProfile, UPLOAD_A, UPLOAD_B } from './testSupport.js';
import {
    CONTENT_RULE_PRESETS, FONTS, SOCIALS, THEMES, type CreatorProfile, type Offer,
} from './types.js';
import { activationMissing, isHttpsUrl, isTimeZone, OFFER_URL, PROFILE_LIMITS, profileBytes, UPLOAD_URL, validateProfile, type ListLimit } from './validate.js';

const clone = <T>(v: T): T => structuredClone(v);

/** The problems with `base` after `edit`; empty when it is still a profile. */
function problems(edit: (p: CreatorProfile) => void, base: CreatorProfile = richProfile()): string[] {
    const p = clone(base);
    edit(p);
    const out = validateProfile(p);
    return 'problems' in out ? out.problems : [];
}

/** Asserts that exactly one problem comes of the edit, and that it names `path`. */
function refused(edit: (p: CreatorProfile) => void, path: string, pattern?: RegExp): void {
    const found = problems(edit);
    assert.ok(found.length >= 1, `expected a problem with ${path}, got none`);
    assert.ok(found.some((m) => m.includes(path)), `expected a problem naming ${path}, got: ${found.join(' | ')}`);
    if (pattern) assert.ok(found.some((m) => pattern.test(m)), `expected ${pattern} in: ${found.join(' | ')}`);
}

const accepted = (edit: (p: CreatorProfile) => void): void => assert.deepStrictEqual(problems(edit), []);
const text = (n: number): string => 'x'.repeat(n);
const codes = (n: number, upper: boolean): string[] => Array.from({ length: n }, (_, i) => String.fromCharCode((upper ? 65 : 97) + Math.floor(i / 26), (upper ? 65 : 97) + (i % 26)));

const PROFILE_SECTION_PROBLEMS = [
    'profile.schema is required', 'profile.identity is required', 'profile.language is required', 'profile.offers is required',
    'profile.audience is required', 'profile.voice is required', 'profile.presenter is required', 'profile.content is required',
    'profile.brand is required', 'profile.socials is required', 'profile.dm is required', 'profile.goals is required',
];

describe('validateProfile: what it accepts', () => {
    it('accepts the neutral defaults, a fully filled profile, and the owner\'s legacy profile', () => {
        for (const p of [defaultProfile(), defaultProfile({ lang: 'en' }), defaultProfile({ rules: [] }), richProfile()]) {
            const out = validateProfile(p);
            assert.ok('profile' in out, 'problems' in out ? out.problems.join('; ') : '');
        }
    });

    it('returns a copy, so changing the input afterwards cannot change what was accepted', () => {
        const p = richProfile();
        const out = validateProfile(p);
        assert.ok('profile' in out);
        p.identity.niche = 'changed';
        p.offers[0]!.facts.push('changed');
        assert.deepStrictEqual(out.profile, richProfile());
    });

    it('is strict about the whole: not an object, no sections, a wrong schema', () => {
        for (const raw of [null, undefined, 'x', 7, [], []]) assert.ok('problems' in validateProfile(raw));
        assert.deepStrictEqual(validateProfile({}), { problems: PROFILE_SECTION_PROBLEMS });
        refused((p) => { (p as { schema: number }).schema = 2; }, 'profile.schema');
        refused((p) => { delete (p as Partial<CreatorProfile>).schema; }, 'profile.schema');
    });

    it('reports at most twenty problems', () => {
        const p = richProfile();
        p.offers[1]!.facts = Array.from({ length: 20 }, () => '');
        p.offers[1]!.bullets = Array.from({ length: 10 }, () => '');
        p.offers[1]!.campaign!.keywords = Array.from({ length: 20 }, () => '');
        const out = validateProfile(p);
        assert.ok('problems' in out);
        assert.equal(out.problems.length, 20, 'fifty entries are empty, and twenty are reported');
    });
});

describe('validateProfile: unknown and missing keys', () => {
    const unknown: [string, (p: any) => void][] = [
        ['profile.mystery', (p) => { p.mystery = 1; }],
        ['identity.nickname', (p) => { p.identity.nickname = 'x'; }],
        ['identity.display_name.fr', (p) => { p.identity.display_name.fr = 'x'; }],
        ['language.mystery', (p) => { p.language.mystery = 1; }],
        ['language.surfaces.mystery', (p) => { p.language.surfaces.mystery = {}; }],
        ['language.surfaces.dm.mystery', (p) => { p.language.surfaces.dm.mystery = 1; }],
        ['offers[0].mystery', (p) => { p.offers[0].mystery = 1; }],
        ['offers[1].campaign.mystery', (p) => { p.offers[1].campaign.mystery = 1; }],
        ['audience.mystery', (p) => { p.audience.mystery = 1; }],
        ['voice.mystery', (p) => { p.voice.mystery = 1; }],
        ['presenter.mystery', (p) => { p.presenter.mystery = 1; }],
        ['content.mystery', (p) => { p.content.mystery = 1; }],
        ['brand.mystery', (p) => { p.brand.mystery = 1; }],
        ['socials.mystery', (p) => { p.socials.mystery = 1; }],
        ['socials.links.myspace', (p) => { p.socials.links.myspace = 'https://example.com'; }],
        ['dm.mystery', (p) => { p.dm.mystery = 1; }],
        ['dm.faq[0].mystery', (p) => { p.dm.faq[0].mystery = 1; }],
        ['dm.handoff.mystery', (p) => { p.dm.handoff.mystery = 1; }],
        ['dm.hours.mystery', (p) => { p.dm.hours.mystery = 1; }],
        ['goals.mystery', (p) => { p.goals.mystery = 1; }],
    ];
    for (const [path, edit] of unknown) it(`refuses ${path}`, () => refused(edit, path, /is not a profile field/));

    const missing: [string, (p: any) => void][] = [
        ['identity.niche', (p) => { delete p.identity.niche; }],
        ['identity.display_name.en', (p) => { delete p.identity.display_name.en; }],
        ['language.register', (p) => { delete p.language.register; }],
        ['offers[0].order_via', (p) => { delete p.offers[0].order_via; }],
        ['offers[1].campaign.match', (p) => { delete p.offers[1].campaign.match; }],
        ['voice.emoji', (p) => { delete p.voice.emoji; }],
        ['content.rules', (p) => { delete p.content.rules; }],
        ['brand.theme', (p) => { delete p.brand.theme; }],
        ['dm.hours', (p) => { delete p.dm.hours; }],
        ['goals.views', (p) => { delete p.goals.views; }],
        ['presenter', (p) => { delete p.presenter; }],
    ];
    for (const [path, edit] of missing) it(`requires ${path}`, () => refused(edit, path, /is required/));

    it('lets audience.timezone and an offer\'s campaign be absent, the only two optional fields', () => {
        accepted((p) => { delete p.audience.timezone; });
        accepted((p) => { delete p.offers[1]!.campaign; });
    });

    it('refuses the wrong type for a section', () => {
        for (const section of ['identity', 'language', 'audience', 'voice', 'content', 'brand', 'socials', 'dm', 'goals'] as const) {
            refused((p) => { (p as any)[section] = 'x'; }, section, /must be an object/);
        }
        refused((p) => { (p as any).offers = {}; }, 'offers', /must be a list/);
    });
});

describe('validateProfile: every limit in 01 §1, at the limit and one past it', () => {
    const textLimits: [string, number, (p: CreatorProfile, v: string) => void][] = [
        ['identity.display_name.ar', PROFILE_LIMITS.displayName, (p, v) => { p.identity.display_name.ar = v; }],
        ['identity.display_name.en', PROFILE_LIMITS.displayName, (p, v) => { p.identity.display_name.en = v; }],
        ['identity.brand_name', PROFILE_LIMITS.brandName, (p, v) => { p.identity.brand_name = v; }],
        ['identity.role', PROFILE_LIMITS.role, (p, v) => { p.identity.role = v; }],
        ['identity.niche', PROFILE_LIMITS.niche, (p, v) => { p.identity.niche = v; }],
        ['audience.description', PROFILE_LIMITS.audienceDescription, (p, v) => { p.audience.description = v; }],
        ['voice.guide', PROFILE_LIMITS.guide, (p, v) => { p.voice.guide = v; }],
        ['voice.address', PROFILE_LIMITS.address, (p, v) => { p.voice.address = v; }],
        ['presenter.name', PROFILE_LIMITS.presenterName, (p, v) => { p.presenter!.name = v; }],
        ['offers[1].id', PROFILE_LIMITS.offerId, (p, v) => { p.offers[1]!.id = v; }],
        ['offers[1].name', PROFILE_LIMITS.offerName, (p, v) => { p.offers[1]!.name = v; }],
        ['offers[1].url', PROFILE_LIMITS.offerUrl, (p, v) => { p.offers[1]!.url = `https://example.com/${v.slice(20)}`; }],
        ['offers[1].price', PROFILE_LIMITS.offerPrice, (p, v) => { p.offers[1]!.price = v; }],
        ['offers[1].keyword', PROFILE_LIMITS.offerKeyword, (p, v) => { p.offers[1]!.keyword = v; }],
        ['offers[1].campaign.dm_template', PROFILE_LIMITS.campaignDm, (p, v) => { p.offers[1]!.campaign!.dm_template = v; }],
        ['socials.handle', PROFILE_LIMITS.handle, (p, v) => { p.socials.handle = v; }],
        ['socials.site', PROFILE_LIMITS.site, (p, v) => { p.socials.site = v; }],
        ['socials.links.instagram', PROFILE_LIMITS.link, (p, v) => { p.socials.links.instagram = `https://example.com/${v.slice(20)}`; }],
        ['dm.knowledge', PROFILE_LIMITS.knowledge, (p, v) => { p.dm.knowledge = v; }],
        ['dm.faq[0].q', PROFILE_LIMITS.faqQuestion, (p, v) => { p.dm.faq[0]!.q = v; }],
        ['dm.faq[0].a', PROFILE_LIMITS.faqAnswer, (p, v) => { p.dm.faq[0]!.a = v; }],
        ['dm.handoff.when', PROFILE_LIMITS.handoffWhen, (p, v) => { p.dm.handoff!.when = v; }],
        ['dm.handoff.message', PROFILE_LIMITS.handoffMessage, (p, v) => { p.dm.handoff!.message = v; }],
    ];
    for (const [path, max, set] of textLimits) {
        it(`${path}: ${max} characters`, () => {
            // Padded up front, so the URL rows are long enough to cut from.
            accepted((p) => set(p, text(max)));
            refused((p) => set(p, text(max + 1)), path, new RegExp(`the limit is ${max}`));
        });
    }

    const listLimits: [string, ListLimit, (p: CreatorProfile, v: string[]) => void][] = [
        ['audience.pains', PROFILE_LIMITS.pains, (p, v) => { p.audience.pains = v; }],
        ['audience.goals', PROFILE_LIMITS.audienceGoals, (p, v) => { p.audience.goals = v; }],
        ['voice.tone', PROFILE_LIMITS.tone, (p, v) => { p.voice.tone = v; }],
        ['voice.samples', PROFILE_LIMITS.samples, (p, v) => { p.voice.samples = v; }],
        ['voice.use_words', PROFILE_LIMITS.words, (p, v) => { p.voice.use_words = v; }],
        ['voice.avoid_words', PROFILE_LIMITS.words, (p, v) => { p.voice.avoid_words = v; }],
        ['content.pillars', PROFILE_LIMITS.pillars, (p, v) => { p.content.pillars = v; }],
        ['content.never_mention', PROFILE_LIMITS.neverMention, (p, v) => { p.content.never_mention = v; }],
        ['content.custom_rules', PROFILE_LIMITS.customRules, (p, v) => { p.content.custom_rules = v; }],
        ['offers[1].facts', PROFILE_LIMITS.facts, (p, v) => { p.offers[1]!.facts = v; }],
        ['offers[1].bullets', PROFILE_LIMITS.bullets, (p, v) => { p.offers[1]!.bullets = v; }],
        ['offers[1].campaign.keywords', PROFILE_LIMITS.campaignKeywords, (p, v) => { p.offers[1]!.campaign!.keywords = v; }],
        ['offers[1].campaign.public_replies', PROFILE_LIMITS.campaignReplies, (p, v) => { p.offers[1]!.campaign!.public_replies = v; }],
    ];
    for (const [path, limit, set] of listLimits) {
        it(`${path}: ${limit.items} × ${limit.each}`, () => {
            accepted((p) => set(p, Array.from({ length: limit.items }, () => text(limit.each))));
            refused((p) => set(p, Array.from({ length: limit.items + 1 }, () => text(1))), path, new RegExp(`holds at most ${limit.items}`));
            refused((p) => set(p, [text(limit.each + 1)]), `${path}[0]`, new RegExp(`the limit is ${limit.each}`));
            refused((p) => set(p, ['ok', '  ']), `${path}[1]`, /is required/);
            refused((p) => set(p, ['ok', 7 as unknown as string]), `${path}[1]`, /must be text/);
            refused((p) => set(p, 'text' as unknown as string[]), path, /must be a list/);
        });
    }

    it('offers: ten, with exactly one primary', () => {
        const offers = (n: number) => (p: CreatorProfile): void => {
            p.offers = Array.from({ length: n }, (_, i) => ({ ...richProfile().offers[0]!, id: `o${i}`, primary: i === 0 }));
        };
        accepted(offers(10));
        refused(offers(11), 'offers', /holds at most 10/);
    });

    it('dm.faq: thirty', () => {
        const faq = (n: number) => (p: CreatorProfile): void => { p.dm.faq = Array.from({ length: n }, (_, i) => ({ q: `q${i}`, a: `a${i}` })); };
        accepted(faq(30));
        refused(faq(31), 'dm.faq', /holds at most 30/);
    });

    it('audience.countries: thirty, audience.languages: ten', () => {
        accepted((p) => { p.audience.countries = codes(30, true); });
        refused((p) => { p.audience.countries = codes(31, true); }, 'audience.countries', /holds at most 30/);
        accepted((p) => { p.audience.languages = codes(10, false); });
        refused((p) => { p.audience.languages = codes(11, false); }, 'audience.languages', /holds at most 10/);
    });

    it('goals: whole numbers from 1 to a billion', () => {
        accepted((p) => { p.goals = { followers: 1, views: 1_000_000_000 }; });
        for (const bad of [0, -1, 1.5, 1_000_000_001, Number.NaN, Infinity, '5']) {
            refused((p) => { (p.goals as { followers: unknown }).followers = bad; }, 'goals.followers', /whole number from 1 to 1000000000/);
        }
    });

    it('the whole profile: 128 KB, measured the way the table measures it', () => {
        // Filled to every field's limit, which is more than the table holds.
        const fat = richProfile();
        fat.offers = Array.from({ length: 6 }, (_, i): Offer => ({
            id: `o${i}`, kind: 'program', name: text(200), order_via: 'url', url: `https://example.com/${text(900)}`, price: text(60),
            facts: Array.from({ length: 20 }, () => text(60)), bullets: Array.from({ length: 10 }, () => text(200)), keyword: text(80), primary: i === 0,
            campaign: {
                match: 'word', keywords: Array.from({ length: 20 }, () => text(80)), dm_template: text(4000),
                public_replies: Array.from({ length: 10 }, () => text(300)),
            },
        }));
        fat.dm.faq = Array.from({ length: 30 }, () => ({ q: text(300), a: text(2000) }));
        const out = validateProfile(fat);
        assert.ok('problems' in out);
        assert.match(out.problems.join('|'), /the profile is \d+ bytes; the limit is 131072/);

        // Trim it to exactly the limit: accepted. One byte more: refused.
        let excess = profileBytes(fat) - PROFILE_LIMITS.profileBytes;
        assert.ok(excess > 0);
        for (const item of fat.dm.faq) {
            const cut = Math.min(excess, item.a.length - 1);
            item.a = item.a.slice(0, item.a.length - cut);
            excess -= cut;
        }
        assert.equal(excess, 0);
        assert.equal(profileBytes(fat), PROFILE_LIMITS.profileBytes);
        assert.ok('profile' in validateProfile(fat));
        fat.dm.faq[0]!.a += 'x';
        assert.equal(profileBytes(fat), PROFILE_LIMITS.profileBytes + 1);
        assert.ok('problems' in validateProfile(fat));
    });

    it('measures what Postgres prints for jsonb, which is longer than JSON.stringify', () => {
        const value = { a: [1, 2], b: 'x', c: {}, d: [] };
        assert.equal(Buffer.byteLength('{"a": [1, 2], "b": "x", "c": {}, "d": []}'), profileBytes(value));
        assert.ok(profileBytes(value) > Buffer.byteLength(JSON.stringify(value)));
        assert.equal(profileBytes({ k: 'ع' }), Buffer.byteLength('{"k": "ع"}'), 'bytes, not characters: an Arabic letter is two');
        assert.equal(profileBytes({ k: undefined, j: 1 }), Buffer.byteLength('{"j": 1}'), 'an undefined member is not there');
    });
});

describe('validateProfile: formats', () => {
    it('colours are #RRGGBB', () => {
        for (const bad of ['#FFF', 'red', '#GGGGGG', '112233', '#1122334', '', '#11 233', 7]) {
            refused((p) => { (p.brand as { primary: unknown }).primary = bad; }, 'brand.primary', /must be a colour like #FFD60A/);
            refused((p) => { (p.brand as { accent: unknown }).accent = bad; }, 'brand.accent');
        }
        accepted((p) => { p.brand.primary = '#aabbcc'; p.brand.accent = '#AABBCC'; });
    });

    it('timezones are checked with Intl: identity.timezone may be empty, audience.timezone may be absent but not empty', () => {
        refused((p) => { p.identity.timezone = 'Mars/Olympus'; }, 'identity.timezone', /must be a timezone/);
        refused((p) => { p.identity.timezone = 'riyadh'; }, 'identity.timezone');
        accepted((p) => { p.identity.timezone = 'Europe/London'; });
        accepted((p) => { p.identity.timezone = 'UTC'; });
        accepted((p) => { p.identity.timezone = ''; });
        refused((p) => { p.audience.timezone = 'Nowhere/Land'; }, 'audience.timezone');
        refused((p) => { p.audience.timezone = ''; }, 'audience.timezone');
        accepted((p) => { p.audience.timezone = 'Asia/Riyadh'; });
        assert.equal(isTimeZone('Asia/Riyadh'), true);
        assert.equal(isTimeZone(''), false);
        assert.equal(isTimeZone(5), false);
    });

    it('an offer\'s address is http or https, as the Studio\'s product link is, and no other scheme', () => {
        const bad = ['ftp://example.com', 'https://', 'http://', 'https:// example.com', 'https://example.com/a b', 'example.com', 'javascript:alert(1)', 'file:///etc/passwd', '//example.com'];
        for (const url of bad) refused((p) => { p.offers[1]!.url = url; }, 'offers[1].url', /starting with http:\/\/ or https:\/\//);
        for (const url of ['https://www.udemy.com/course/x/?referralCode=ABC', 'http://example.com/course', 'HTTPS://Example.com/a', 'HTTP://example.com']) {
            accepted((p) => { p.offers[1]!.url = url; });
            accepted((p) => { p.offers[0]!.url = url; });
        }
    });

    it('a social link is https only, with a host and no spaces: it is new with the profile, so there is no older rule to keep', () => {
        const bad = ['http://example.com/a', 'ftp://example.com', 'https://', 'https:// example.com', 'https://example.com/a b', 'example.com', 'javascript:alert(1)'];
        for (const url of bad) refused((p) => { p.socials.links.instagram = url; }, 'socials.links.instagram', /starting with https:\/\//);
        accepted((p) => { p.socials.links.instagram = 'https://instagram.com/sami.fit'; });
        assert.equal(isHttpsUrl('https://example.com'), true);
        assert.equal(isHttpsUrl('http://example.com'), false);
    });

    it('a link on a social is required to be a link: empty is not "no link", leave the key out', () => {
        refused((p) => { p.socials.links.instagram = ''; }, 'socials.links.instagram', /is required/);
    });

    it('the portrait and the logo are one of our own uploads, or null', () => {
        const bad = [
            'https://example.com/photo.png', 'http://app.example.com/api/uploads/11111111-1111-4111-8111-111111111111',
            'https://app.example.com/api/uploads/not-a-uuid', 'https://app.example.com/api/uploads/11111111-1111-4111-8111-111111111111.png',
            'https://app.example.com/api/uploads/11111111-1111-4111-8111-111111111111/x', '', 7,
        ];
        for (const url of bad) {
            refused((p) => { (p.brand as { portrait_url: unknown }).portrait_url = url; }, 'brand.portrait_url', /one of your uploads/);
            refused((p) => { (p.brand as { logo_url: unknown }).logo_url = url; }, 'brand.logo_url', /one of your uploads/);
        }
        accepted((p) => { p.brand.portrait_url = UPLOAD_A; p.brand.logo_url = UPLOAD_B; });
        accepted((p) => { p.brand.portrait_url = null; p.brand.logo_url = null; });
    });

    it('country codes are two upper-case letters, or null; languages two or three lower-case', () => {
        for (const bad of ['sa', 'SAU', 'S', '', 5]) refused((p) => { (p.identity as { country: unknown }).country = bad; }, 'identity.country');
        accepted((p) => { p.identity.country = null; });
        accepted((p) => { p.identity.country = 'SA'; });
        for (const bad of ['sa', 'SAU', 'S1', 5]) refused((p) => { p.audience.countries = [bad as string]; }, 'audience.countries[0]');
        for (const bad of ['AR', 'a', 'arab', 'a1', 5]) refused((p) => { p.audience.languages = [bad as string]; }, 'audience.languages[0]');
        accepted((p) => { p.audience.languages = ['ar', 'fil']; });
    });

    it('every closed list is closed', () => {
        const wrong: [string, (p: any) => void][] = [
            ['identity.kind', (p) => { p.identity.kind = 'wizard'; }],
            ['language.primary', (p) => { p.language.primary = 'fr'; }],
            ['language.register', (p) => { p.language.register = 'moroccan'; }],
            ['language.digits', (p) => { p.language.digits = 'roman'; }],
            ['language.surfaces.dm.language', (p) => { p.language.surfaces.dm.language = 'fr'; }],
            ['language.surfaces.dm.register', (p) => { p.language.surfaces.dm.register = 'moroccan'; }],
            ['offers[0].kind', (p) => { p.offers[0].kind = 'subscription'; }],
            ['offers[0].order_via', (p) => { p.offers[0].order_via = 'phone'; }],
            ['offers[1].campaign.match', (p) => { p.offers[1].campaign.match = 'regex'; }],
            ['audience.level', (p) => { p.audience.level = 'expert'; }],
            ['voice.emoji', (p) => { p.voice.emoji = 'many'; }],
            ['presenter.pronouns', (p) => { p.presenter.pronouns = 'it'; }],
            ['presenter.on_camera', (p) => { p.presenter.on_camera = 'puppet'; }],
            ['content.domain', (p) => { p.content.domain = 'finance'; }],
            ['content.rules[0]', (p) => { p.content.rules = ['no_men_imagery']; }],
            ['brand.font_display', (p) => { p.brand.font_display = 'Comic Sans'; }],
            ['brand.theme', (p) => { p.brand.theme = 'sepia'; }],
            ['socials.platforms[0]', (p) => { p.socials.platforms = ['myspace']; }],
        ];
        for (const [path, edit] of wrong) refused(edit, path, /must be one of/);
        for (const kind of ['educator', 'coach', 'shop', 'agency', 'creator'] as const) accepted((p) => { p.identity.kind = kind; });
        accepted((p) => { p.identity.kind = null; p.audience.level = null; p.presenter = null; });
    });

    it('the role and the niche are one line', () => {
        refused((p) => { p.identity.role = 'fitness\ncoach'; }, 'identity.role', /one line/);
        refused((p) => { p.identity.niche = 'home workouts\r\nfor parents'; }, 'identity.niche', /one line/);
        refused((p) => { p.identity.niche = 'a\u2028b'; }, 'identity.niche', /one line/);
        accepted((p) => { p.identity.role = ''; p.identity.niche = ''; });
    });
});

describe('validateProfile: the rules that cross fields', () => {
    it('register is required when the language is Arabic, and kept when it is English', () => {
        refused((p) => { p.language.primary = 'ar'; p.language.register = null; }, 'language.register', /required when the language is Arabic/);
        for (const register of ['msa', 'gulf', 'egyptian', 'levantine'] as const) accepted((p) => { p.language.register = register; });
        accepted((p) => { p.language.primary = 'en'; p.language.register = null; });
        accepted((p) => { p.language.primary = 'en'; p.language.register = 'egyptian'; });
        assert.ok('profile' in validateProfile(defaultProfile({ lang: 'ar' })));
        assert.ok('problems' in validateProfile({ ...defaultProfile({ lang: 'ar' }), language: { ...defaultProfile().language, register: null } }));
    });

    it('exactly one offer is primary when there are offers, and none is fine when there are none', () => {
        refused((p) => { p.offers.forEach((o) => { o.primary = false; }); }, 'offers', /exactly one primary offer; it has 0/);
        refused((p) => { p.offers.forEach((o) => { o.primary = true; }); }, 'offers', /exactly one primary offer; it has 2/);
        accepted((p) => { p.offers = []; });
        accepted((p) => { p.offers = [p.offers[0]!]; p.offers[0]!.primary = true; });
    });

    it('offer ids are unique', () => {
        refused((p) => { p.offers[0]!.id = p.offers[1]!.id; }, 'offers', /same id/);
    });

    it('an offer ordered by link needs a link; one ordered by message does not, and may have one', () => {
        refused((p) => { p.offers[1]!.url = ''; }, 'offers[1].url', /required when the offer is ordered by link/);
        accepted((p) => { p.offers[0]!.url = ''; });
        accepted((p) => { p.offers[0]!.url = 'https://example.com/dm-me'; });
        accepted((p) => { p.offers[1]!.order_via = 'dm'; p.offers[1]!.url = ''; });
    });

    it('lists that must not repeat do not: countries, languages, platforms, rules, hours\' days', () => {
        refused((p) => { p.audience.countries = ['EG', 'EG']; }, 'audience.countries', /same entry twice/);
        refused((p) => { p.audience.languages = ['ar', 'ar']; }, 'audience.languages', /same entry twice/);
        refused((p) => { p.socials.platforms = ['instagram', 'instagram']; }, 'socials.platforms', /same entry twice/);
        refused((p) => { p.content.rules = ['no_women_imagery', 'no_women_imagery']; }, 'content.rules', /same entry twice/);
        refused((p) => { p.dm.hours!.days = [1, 1]; }, 'dm.hours.days', /same day twice/);
    });

    it('never_mention may repeat itself: the Studio\'s voice.avoid may, and a valid PUT there must stay valid', () => {
        accepted((p) => { p.content.never_mention = ['MCP', 'MCP']; });
    });

    it('hours: days 0 to 6, at least one, and times like 09:00', () => {
        accepted((p) => { p.dm.hours = { days: [0, 1, 2, 3, 4, 5, 6], from: '00:00', to: '23:59' }; });
        accepted((p) => { p.dm.hours = null; });
        refused((p) => { p.dm.hours!.days = []; }, 'dm.hours.days', /at least one day/);
        refused((p) => { p.dm.hours!.days = [7]; }, 'dm.hours.days[0]', /from 0 to 6/);
        refused((p) => { p.dm.hours!.days = [1.5]; }, 'dm.hours.days[0]');
        refused((p) => { p.dm.hours!.days = [0, 1, 2, 3, 4, 5, 6, 0]; }, 'dm.hours.days', /holds at most 7/);
        for (const bad of ['9:00', '24:00', '09:60', '0900', '', 900]) {
            refused((p) => { (p.dm.hours as { from: unknown }).from = bad; }, 'dm.hours.from', /time like 09:00/);
            refused((p) => { (p.dm.hours as { to: unknown }).to = bad; }, 'dm.hours.to', /time like 09:00/);
        }
    });

    it('a handoff, when there is one, says when and what', () => {
        refused((p) => { p.dm.handoff = { when: '', message: 'x' }; }, 'dm.handoff.when', /is required/);
        refused((p) => { p.dm.handoff = { when: 'x', message: ' ' }; }, 'dm.handoff.message', /is required/);
        accepted((p) => { p.dm.handoff = null; });
    });

    it('a campaign needs a DM, and may have no keywords or replies', () => {
        refused((p) => { p.offers[1]!.campaign!.dm_template = ''; }, 'offers[1].campaign.dm_template', /is required/);
        accepted((p) => { p.offers[1]!.campaign!.keywords = []; p.offers[1]!.campaign!.public_replies = []; });
    });

    it('a presenter may be absent, and may have no name', () => {
        accepted((p) => { p.presenter = null; });
        accepted((p) => { p.presenter = { name: '', pronouns: 'he', on_camera: 'face' }; });
    });
});

describe('activationMissing (D10: six fields)', () => {
    const complete = (): CreatorProfile => richProfile();

    it('is empty for a finished profile', () => {
        assert.deepStrictEqual(activationMissing(complete()), []);
    });

    it('names what a new tenant has still to give: a name, a kind, a niche, a timezone, an offer', () => {
        assert.deepStrictEqual(activationMissing(defaultProfile({ lang: 'ar' })), [
            'identity.display_name', 'identity.kind', 'identity.niche', 'identity.timezone', 'offers.primary.name',
        ]);
    });

    it('each of the six, alone', () => {
        const cases: [string, (p: CreatorProfile) => void, string[]][] = [
            ['the name', (p) => { p.identity.display_name = { ar: '', en: '' }; }, ['identity.display_name']],
            ['the kind', (p) => { p.identity.kind = null; }, ['identity.kind']],
            ['the niche', (p) => { p.identity.niche = ''; }, ['identity.niche']],
            ['the timezone', (p) => { p.identity.timezone = ''; }, ['identity.timezone']],
            ['the register of an Arabic profile', (p) => { p.language.register = null; }, ['language.register']],
            ['the offer', (p) => { p.offers = []; }, ['offers.primary.name']],
        ];
        for (const [name, edit, expected] of cases) {
            const p = complete();
            edit(p);
            assert.deepStrictEqual(activationMissing(p), expected, name);
        }
    });

    it('a name in either language is enough, and spaces are not a name', () => {
        const p = complete();
        p.identity.display_name = { ar: 'سامي', en: '' };
        assert.deepStrictEqual(activationMissing(p), []);
        p.identity.display_name = { ar: '', en: 'Sami' };
        assert.deepStrictEqual(activationMissing(p), []);
        p.identity.display_name = { ar: '  ', en: ' ' };
        assert.deepStrictEqual(activationMissing(p), ['identity.display_name']);
        p.identity.niche = '   ';
        assert.deepStrictEqual(activationMissing(p), ['identity.display_name', 'identity.niche']);
    });

    it('an English profile needs no register', () => {
        const p = complete();
        p.language.primary = 'en';
        p.language.register = null;
        assert.deepStrictEqual(activationMissing(p), []);
    });

    it('the primary offer needs a name, and a link or "they message me to order"', () => {
        const p = complete();
        p.offers[1]!.name = '';
        assert.deepStrictEqual(activationMissing(p), ['offers.primary.name']);
        p.offers[1]!.name = 'Program';
        p.offers[1]!.url = '';
        assert.deepStrictEqual(activationMissing(p), ['offers.primary.url']);
        p.offers[1]!.order_via = 'dm';
        assert.deepStrictEqual(activationMissing(p), [], 'a primary offer with order_via dm needs no URL');
        p.offers[1]!.name = '';
        p.offers[1]!.url = '';
        assert.deepStrictEqual(activationMissing(p), ['offers.primary.name']);
    });

    it('only the primary offer counts, not another with a name', () => {
        const p = complete();
        p.offers[1]!.name = '';
        assert.equal(p.offers[0]!.name.length > 0, true);
        assert.deepStrictEqual(activationMissing(p), ['offers.primary.name']);
    });

    it('the DM bot also needs a handoff, only when asked', () => {
        const p = complete();
        p.dm.handoff = null;
        assert.deepStrictEqual(activationMissing(p), []);
        assert.deepStrictEqual(activationMissing(p, { dm: true }), ['dm.handoff']);
        assert.deepStrictEqual(activationMissing(complete(), { dm: true }), []);
    });

    it('does not depend on the profile being otherwise valid, and is never a reason to refuse one', () => {
        // The owner's profile, from his rows, has no niche and is still a valid profile (D14: his onboarding is completed).
        const legacy = profileFromLegacy(defaultStudioSettings());
        assert.ok('profile' in validateProfile(legacy));
        assert.ok(activationMissing(legacy).length > 0);
    });
});

// ─── The floors ─────────────────────────────────────────────────────────────────────────────

/** The largest `n` in `[lo, hi)` for which `ok(n)` holds, given that it holds at `lo`, fails at `hi` and never comes back. */
function largest(ok: (n: number) => boolean, lo = 1, hi = 100_000): number {
    assert.ok(ok(lo), 'the probe passes at its smallest size');
    assert.ok(!ok(hi), 'the probe fails at its largest size, so there is a limit to find');
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (ok(mid)) lo = mid;
        else hi = mid;
    }
    return lo;
}

/** Whether the Studio settings validator is happy with the defaults after `edit(s, n)`. */
const studioOk = (edit: (s: StudioSettings, n: number) => void) => (n: number): boolean => {
    const s = defaultStudioSettings();
    edit(s, n);
    return settingsProblems(s).length === 0;
};

describe('the limits are never lower than today\'s, field by field', () => {
    /** [what moves, the profile field's limit, today's limit found by probing the Studio validator]. */
    const floors: [string, number, number][] = [
        ['brand.name → identity.brand_name', PROFILE_LIMITS.brandName, largest(studioOk((s, n) => { s.brand.name = text(n); }))],
        ['infographic.name.ar → display_name.ar', PROFILE_LIMITS.displayName, largest(studioOk((s, n) => { s.infographic.name.ar = text(n); }))],
        ['infographic.name.en → display_name.en', PROFILE_LIMITS.displayName, largest(studioOk((s, n) => { s.infographic.name.en = text(n); }))],
        ['infographic.site → socials.site', PROFILE_LIMITS.site, largest(studioOk((s, n) => { s.infographic.site = text(n); }))],
        ['infographic.handle → socials.handle', PROFILE_LIMITS.handle, largest(studioOk((s, n) => { s.infographic.handle = text(n); }))],
        ['voice.guide → voice.guide', PROFILE_LIMITS.guide, largest(studioOk((s, n) => { s.voice.guide = text(n); }))],
        ['voice.avoid (entries) → never_mention', PROFILE_LIMITS.neverMention.items, largest(studioOk((s, n) => { s.voice.avoid = Array.from({ length: n }, () => 'x'); }), 1, 1000)],
        ['voice.avoid (each) → never_mention', PROFILE_LIMITS.neverMention.each, largest(studioOk((s, n) => { s.voice.avoid = [text(n)]; }))],
        ['product.name → offer name', PROFILE_LIMITS.offerName, largest(studioOk((s, n) => { s.product.name = text(n); }))],
        ['product.url → offer url', PROFILE_LIMITS.offerUrl, largest(studioOk((s, n) => { s.product.url = `https://${text(n - 8)}`; }), 9)],
        ['product.facts (entries) → offer facts', PROFILE_LIMITS.facts.items, largest(studioOk((s, n) => { s.product.facts = Array.from({ length: n }, () => 'x'); }), 1, 1000)],
        ['product.facts (each) → offer facts', PROFILE_LIMITS.facts.each, largest(studioOk((s, n) => { s.product.facts = [text(n)]; }))],
        ['product.dmBullets (entries) → offer bullets', PROFILE_LIMITS.bullets.items, largest(studioOk((s, n) => { s.product.dmBullets = Array.from({ length: n }, () => 'x'); }), 1, 1000)],
        ['product.dmBullets (each) → offer bullets', PROFILE_LIMITS.bullets.each, largest(studioOk((s, n) => { s.product.dmBullets = [text(n)]; }))],
        ['growth audience.countries → audience.countries', PROFILE_LIMITS.countries, GROWTH_LIMITS.countries],
        ['growth audience.languages → audience.languages', PROFILE_LIMITS.languages, GROWTH_LIMITS.languages],
        ['growth goal_followers / goal_views → goals', PROFILE_LIMITS.goalMax, GROWTH_LIMITS.goalMax],
    ];
    for (const [what, limit, today] of floors) {
        it(`${what}: ${limit} against ${today} today`, () => {
            assert.ok(limit >= today, `${what}: the profile allows ${limit}, but a valid Studio or Growth setting today may hold ${today}`);
        });
    }

    it('and the probes found the limits the code is known to have, so they measure something', () => {
        const found = Object.fromEntries(floors.map(([what, , today]) => [what, today]));
        assert.equal(found['brand.name → identity.brand_name'], 80);
        assert.equal(found['voice.guide → voice.guide'], 4000);
        assert.equal(found['product.name → offer name'], 200);
        assert.equal(found['product.url → offer url'], 1000);
        assert.equal(found['voice.avoid (entries) → never_mention'], 30);
        assert.equal(found['infographic.handle → socials.handle'], 32);
    });

    // The strongest form of the promise: a Studio and Growth setting with every moved field at its
    // limit is valid today, and is a valid profile.
    const maxStudio = (): StudioSettings => {
        const s = defaultStudioSettings();
        s.brand.name = text(80);
        s.voice.guide = text(4000);
        s.voice.avoid = Array.from({ length: 30 }, () => text(80));
        s.product = {
            name: text(200), url: `https://example.com/${text(1000 - 20)}`,
            facts: Array.from({ length: 20 }, () => text(60)), dmBullets: Array.from({ length: 10 }, () => text(200)),
        };
        s.infographic = {
            ...s.infographic, name: { ar: text(40), en: text(40) }, site: text(40), handle: text(32), socials: [...INFOGRAPHIC_SOCIALS], photo_url: UPLOAD_A,
        };
        return s;
    };
    const maxGrowth = (): GrowthSettings => {
        const { settings, problems: found } = applyGrowthPatch(defaultGrowthSettings(), {
            audience: { countries: codes(30, true), languages: codes(10, false), timezone: 'Pacific/Kiritimati' }, goal_followers: 1_000_000_000, goal_views: 1_000_000_000,
        });
        assert.deepStrictEqual(found, []);
        return settings;
    };

    it('a Studio and Growth setting at every limit is valid there, and makes a valid profile', () => {
        assert.deepStrictEqual(settingsProblems(maxStudio()), [], 'the probe settings are themselves valid');
        for (const [name, s] of [['English', maxStudio()], ['Arabic', { ...maxStudio(), voice: { ...maxStudio().voice, language: 'ar' as const, digits: 'arabic-indic' as const } }]] as const) {
            const out = validateProfile(profileFromLegacy(s, maxGrowth(), text(PROFILE_LIMITS.knowledge)));
            assert.ok('profile' in out, `${name}: ${'problems' in out ? out.problems.join('; ') : ''}`);
        }
    });

    it('an http product link, which the Studio accepts today, makes a valid profile, and so does every other link it accepts', () => {
        for (const url of ['http://example.com/course', 'https://example.com/course', 'HTTP://Example.com', 'https://?q=1', 'http://x']) {
            const s = defaultStudioSettings();
            s.product = { name: 'Course', url, facts: [], dmBullets: [] };
            assert.deepStrictEqual(settingsProblems(s), [], `today a Studio PUT may save ${url}`);
            const out = validateProfile(profileFromLegacy(s));
            assert.ok('profile' in out, `${url}: ${'problems' in out ? out.problems.join('; ') : ''}`);
        }
    });

    it('a legacy knowledge base of 60,000 characters round-trips through profileFromLegacy and validates, in Latin and in Arabic', () => {
        // The agent's knowledge base is an unbounded TEXT column today, so this limit is a ceiling.
        // Arabic letters are two bytes each, so the Arabic case is the one the 128 KB of the whole profile could refuse.
        for (const [name, kb] of [['Latin', 'k'.repeat(PROFILE_LIMITS.knowledge)], ['Arabic', 'ك'.repeat(PROFILE_LIMITS.knowledge)]] as const) {
            assert.equal(kb.length, 60_000);
            const p = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, kb);
            assert.equal(p.dm.knowledge, kb, `${name}: the profile holds the knowledge base unchanged`);
            const out = validateProfile(p);
            assert.ok('profile' in out, `${name}: ${'problems' in out ? out.problems.join('; ') : ''}`);
            assert.equal(upgradeProfile(JSON.parse(JSON.stringify(p))).dm.knowledge, kb, `${name}: and it comes back from storage`);
            refused((q) => { q.dm.knowledge = `${kb}x`; }, 'dm.knowledge', /the limit is 60000/);
        }
    });

    it('the whole-profile cap still applies to a long knowledge base: 60,000 Arabic letters leave room for the rest, a fat profile does not', () => {
        const p = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, 'ك'.repeat(PROFILE_LIMITS.knowledge));
        const room = PROFILE_LIMITS.profileBytes - profileBytes(p);
        assert.ok(room > 0, `the owner's profile with a 60,000-letter Arabic knowledge base is ${profileBytes(p)} bytes`);
        p.dm.faq = Array.from({ length: 30 }, () => ({ q: 'ك'.repeat(300), a: 'ك'.repeat(2000) }));
        const out = validateProfile(p);
        assert.ok('problems' in out);
        assert.match(out.problems.join('|'), /the limit is 131072/);
    });
});

describe('the rules copied from the Studio settings agree with them', () => {
    const photoOk = (url: string | null): boolean => {
        const s = defaultStudioSettings();
        s.infographic.photo_url = url;
        return !settingsProblems(s).some((m) => m.includes('photo_url'));
    };
    const colourOk = (value: string): boolean => {
        const s = defaultStudioSettings();
        s.infographic.primary = value;
        return !settingsProblems(s).some((m) => m.includes('infographic.primary'));
    };
    const timeOk = (value: string): boolean => {
        const s = defaultStudioSettings();
        s.monteur.run_at = value;
        return !settingsProblems(s).some((m) => m.includes('monteur.run_at'));
    };
    const zoneOk = (value: string): boolean => {
        const s = defaultStudioSettings();
        s.schedule.timezone = value;
        return !settingsProblems(s).some((m) => m.includes('schedule.timezone'));
    };

    it('UPLOAD_URL accepts and refuses the same addresses as infographic.photo_url', () => {
        for (const url of [UPLOAD_A, UPLOAD_B, 'https://example.com/photo.png', 'http://a.com/api/uploads/11111111-1111-4111-8111-111111111111',
            'https://a.com/api/uploads/xyz', 'https://a.com/api/uploads/11111111-1111-4111-8111-111111111111.png', '', 'https:///api/uploads/11111111-1111-4111-8111-111111111111']) {
            assert.equal(UPLOAD_URL.test(url), photoOk(url), url);
        }
        assert.equal(photoOk(null), true);
    });

    it('OFFER_URL accepts and refuses the same addresses as product.url', () => {
        const productUrlOk = (url: string): boolean => {
            const s = defaultStudioSettings();
            s.product.url = url;
            return !settingsProblems(s).some((m) => m.includes('product.url'));
        };
        for (const url of ['https://example.com', 'http://example.com/a', 'HTTPS://EXAMPLE.COM', 'ftp://example.com', 'https://', 'http://', 'example.com',
            'https://a b', 'https://?q=1', 'javascript:alert(1)', '//example.com', 'https://example.com/\n']) {
            assert.equal(OFFER_URL.test(url), productUrlOk(url), url);
        }
    });

    it('colours, times and timezones are judged the same way', () => {
        for (const c of ['#FFD60A', '#ffd60a', '#FFF', 'red', '#GGGGGG', '#1122334', '']) {
            assert.equal(problems((p) => { p.brand.primary = c; }).length === 0, colourOk(c), c);
        }
        for (const t of ['07:00', '23:59', '24:00', '7:00', '07:60', '']) {
            assert.equal(problems((p) => { p.dm.hours = { days: [1], from: t, to: '17:00' }; }).length === 0, timeOk(t), t);
        }
        for (const z of ['Asia/Riyadh', 'UTC', 'Mars/Base', 'riyadh', '']) {
            assert.equal(isTimeZone(z), zoneOk(z), z);
        }
    });

    it('the closed lists are the Studio\'s: fonts, socials and themes', () => {
        assert.deepStrictEqual([...FONTS], [...DISPLAY_FONTS]);
        assert.deepStrictEqual([...SOCIALS], [...INFOGRAPHIC_SOCIALS]);
        assert.deepStrictEqual([...THEMES], [...INFOGRAPHIC_THEMES]);
    });

    it('the default goals are the Growth settings\' default goals', () => {
        assert.equal(PROFILE_LIMITS.goalMax, GROWTH_LIMITS.goalMax);
        assert.deepStrictEqual({ followers: DEFAULT_GOALS.goal_followers, views: DEFAULT_GOALS.goal_views }, defaultProfile().goals);
    });

    it('the one rule preset is the one the editor writes', () => {
        assert.deepStrictEqual([...CONTENT_RULE_PRESETS], ['no_women_imagery']);
    });
});
