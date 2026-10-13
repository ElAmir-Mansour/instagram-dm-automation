/**
 * The owner's tenant as a profile (01 §0.2): what the code assumes for every tenant today, and the
 * profile a tenant with no stored one is described by. A new tenant must never be described by it.
 *
 * Each assumption is held to the text it produces: the golden prompts (src/services/profile/__golden__)
 * are what the code writes today, so a value in LEGACY_ASSUMPTIONS that the code no longer writes, or a
 * line of the code that stops matching its value, fails here and not in a review.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { defaultStudioSettings } from '../studio/settings.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { defaultProfile } from './defaults.js';
import { goldenPath, type GoldenSet } from './golden.js';
import { LEGACY_ASSUMPTIONS, legacyBase, profileFromLegacy } from './legacy.js';
import { activationMissing, validateProfile } from './validate.js';
import { intoProfile, studioView } from './views.js';

const A = LEGACY_ASSUMPTIONS;
/** A golden as the code wrote it, for the owner (`elamir`) or for the neutral English tenant (`control`). */
const golden = (name: string, set: GoldenSet = 'elamir', ext: 'txt' | 'json' = 'txt'): string => readFileSync(goldenPath(name, ext, set), 'utf8');
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

describe('LEGACY_ASSUMPTIONS: each is text the code writes into the owner\'s prompts, and into every other tenant\'s', () => {
    it('presenter: he/him, written in the Editor\'s prompts and in no other form', () => {
        assert.equal(A.presenter.pronouns, 'he');
        for (const [set, name] of [['elamir', 'monteur.editor-system.human-on.elamir'], ['elamir', 'monteur.editor-human-touches'], ['control', 'monteur.editor-system.human-on.english']] as const) {
            const text = golden(name, set);
            assert.ok(count(text, /\b(he|him|his)\b/g) >= 2, `${name} speaks of the presenter as he`);
            assert.equal(count(text, /\b(she|her|hers)\b/gi), 0, `${name} never says she`);
        }
        assert.ok(count(golden('monteur.editor-system.human-on.elamir'), /\b(he|him|his)\b/g) >= 14, 'it is not one stray pronoun: the whole prompt is written about a man');
        assert.match(golden('monteur.editor-human-touches'), /an arrow at him when he addresses the viewer/);
    });

    it('rules: the no-women rule is the last line of every Editor prompt, owner\'s and English tenant\'s alike', () => {
        assert.deepStrictEqual([...A.rules], ['no_women_imagery']);
        const line = 'Never a woman or a girl in any picture, emoji or sticker (the creator\'s rule); prefer objects and scenes to people.';
        for (const [set, name] of [['elamir', 'monteur.editor-system.human-off.elamir'], ['elamir', 'monteur.editor-system.human-on.elamir'], ['control', 'monteur.editor-system.human-off.english']] as const) {
            assert.ok(golden(name, set).trimEnd().endsWith(line), `${name} ends with the rule`);
        }
    });

    it('register: the Gulf words of the ask pool, and none of another dialect\'s', () => {
        assert.equal(A.register, 'gulf');
        const pool = golden('monteur.copy.ask-pool.ar', 'elamir', 'json');
        for (const word of ['تبي', 'ودك', 'يجيك']) assert.ok(pool.includes(word), `the pool says ${word}`);
        for (const other of ['عايز', 'عاوز', 'بدّك', 'بدك', 'شو', 'هلق', 'دلوقتي']) assert.ok(!pool.includes(other), `the pool does not say ${other}`);
    });

    it('address: the pools speak to one man («تبي», «ودك», «صاحبك»)', () => {
        assert.equal(A.address, 'masc');
        assert.match(golden('monteur.copy-system.elamir'), /ابعتها لصاحبك/);
        const pool = golden('monteur.copy.ask-pool.ar', 'elamir', 'json');
        assert.ok(pool.includes('تبي') && pool.includes('ودك'));
    });

    it('infographicRegister: the infographic writer asks for فصحى and forbids dialect, whatever the tenant speaks', () => {
        assert.equal(A.infographicRegister, 'msa');
        const text = golden('infographic.system.ar');
        assert.match(text, /Write in Modern Standard Arabic/);
        assert.match(text, /Never use dialect/);
    });

    it('dm: the DM instruction is written in Arabic for every tenant, and its rule 1 is the Gulf-friendly one', () => {
        assert.equal(A.dm.language, 'ar');
        assert.equal(A.dm.register, 'gulf');
        const text = golden('dm.system-instruction');
        assert.match(text, /باللغة العربية الفصحى أو بلهجة سهلة/);
        // The starter persona a NEW tenant gets is Arabic as well: the DM path has never had another language.
        assert.match(golden('dm.starter-persona', 'control'), /باللغة العربية/);
    });

    it('kind: only an educator\'s TikTok caption carries #LearnOnTikTok, and every caption does today', () => {
        assert.equal(A.kind, 'educator');
        assert.match(golden('captions.tiktok.elamir'), /#LearnOnTikTok/);
        assert.match(golden('captions.tiktok.english', 'control'), /#LearnOnTikTok/, 'an English tenant gets it too, so it is a legacy assumption and not the owner\'s own');
    });

    it('role: "tech educator", the infographic writer\'s first sentence', () => {
        assert.equal(A.role, 'tech educator');
        assert.match(golden('infographic.system.ar'), /^You write one animated comparison infographic for a tech educator's Instagram/);
        assert.match(golden('infographic.system.en', 'control'), /^You write one animated comparison infographic for a tech educator's Instagram/);
    });

    it('domain: the tech blocks, the infographic writer\'s engineer reviewer and the Editor\'s tool examples', () => {
        assert.equal(A.domain, 'tech');
        for (const [name, set, word] of [
            ['infographic.system.ar', 'elamir', 'goroutines'], ['infographic.system.ar', 'elamir', 'senior engineer'],
            ['infographic.system.en', 'control', 'goroutines'], ['monteur.editor-system.human-off.elamir', 'elamir', 'n8n'],
            ['monteur.editor-system.human-off.english', 'control', 'n8n'],
        ] as const) assert.ok(golden(name, set).includes(word), `${name} says ${word}`);
    });

    it('offerKind: what is sold is "the course" in the Studio writer\'s prompt, for an English tenant too', () => {
        assert.equal(A.offerKind, 'course');
        assert.match(golden('studio.system.elamir'), /whose course is «/);
        assert.match(golden('studio.system.english', 'control'), /whose course is/);
    });

    it('cannot be changed by the code that reads it', () => {
        assert.throws(() => { (LEGACY_ASSUMPTIONS as { role: string }).role = 'x'; }, TypeError);
        assert.throws(() => { (LEGACY_ASSUMPTIONS.presenter as { pronouns: string }).pronouns = 'she'; }, TypeError);
        assert.throws(() => { (LEGACY_ASSUMPTIONS.rules as string[]).push('x'); }, TypeError);
        assert.throws(() => { (LEGACY_ASSUMPTIONS.dm as { language: string }).language = 'en'; }, TypeError);
    });
});

describe('legacyBase', () => {
    it('carries every assumption for an Arabic tenant: Gulf, with فصحى infographics, and nothing to override for the DM', () => {
        const p = legacyBase('ar');
        assert.equal(p.language.primary, 'ar');
        assert.equal(p.language.register, 'gulf');
        assert.equal(p.language.digits, 'arabic-indic');
        assert.deepStrictEqual(p.language.surfaces, { infographic: { register: 'msa' } }, 'the DM already speaks his language and register');
        assert.equal(p.voice.address, 'masc');
        assert.deepStrictEqual(p.presenter, { name: '', pronouns: 'he', on_camera: 'face' });
        assert.deepStrictEqual(p.content.rules, ['no_women_imagery']);
        assert.equal(p.content.domain, 'tech');
        assert.equal(p.identity.role, 'tech educator');
        assert.equal(p.identity.kind, 'educator');
        assert.equal(p.offers.length, 1);
        assert.equal(p.offers[0]!.kind, 'course');
        assert.equal(p.offers[0]!.primary, true);
    });

    it('an English tenant has no Gulf register, speaks Arabic on two surfaces and keeps the same presenter, rule, role and course', () => {
        const p = legacyBase('en');
        assert.equal(p.language.primary, 'en');
        assert.equal(p.language.register, null);
        assert.equal(p.language.digits, 'latin');
        assert.deepStrictEqual(p.language.surfaces, {
            infographic: { register: 'msa' },
            dm: { language: 'ar', register: 'gulf' },
        }, 'Arabic infographics were always فصحى and the DM path is forced to Arabic: both survive an English tenant');
        assert.equal(p.voice.address, 'masc');
        assert.equal(p.presenter?.pronouns, 'he');
        assert.deepStrictEqual(p.content.rules, ['no_women_imagery']);
        assert.equal(p.identity.role, 'tech educator');
        assert.equal(p.offers[0]!.kind, 'course');
        // The empty offer shell is for intoProfile to fill (a link-less one is invalid until it is); the rest is valid as it stands.
        const out = validateProfile({ ...p, offers: [] });
        assert.ok('profile' in out, `an Arabic surface under an English profile has the register it needs: ${'problems' in out ? out.problems.join('; ') : ''}`);
    });

    it('is a fresh object each time, so one tenant\'s profile cannot be edited through another\'s', () => {
        const a = legacyBase('ar');
        a.content.rules.push('no_women_imagery');
        a.offers[0]!.facts.push('x');
        a.presenter!.pronouns = 'she';
        a.language.surfaces.infographic!.register = 'gulf';
        const en = legacyBase('en');
        en.language.surfaces.dm!.register = 'msa';
        assert.deepStrictEqual(legacyBase('ar').content.rules, ['no_women_imagery']);
        assert.deepStrictEqual(legacyBase('ar').offers[0]!.facts, []);
        assert.equal(legacyBase('ar').presenter!.pronouns, 'he');
        assert.equal(legacyBase('ar').language.surfaces.infographic!.register, 'msa');
        assert.equal(legacyBase('en').language.surfaces.dm!.register, 'gulf');
    });
});

/** `s` with its brand name, timezone or product link changed. */
const edit = (s: StudioSettings, change: { brand?: string; timezone?: string; url?: string }): StudioSettings => ({
    ...s,
    brand: { ...s.brand, name: change.brand ?? s.brand.name },
    schedule: { ...s.schedule, timezone: change.timezone ?? s.schedule.timezone },
    product: { ...s.product, url: change.url ?? s.product.url },
});

describe('profileFromLegacy', () => {
    it('is the legacy base of the settings\' language, read into by the settings', () => {
        // Where the two fields it copies are not ones intoProfile would have left blank, nothing else differs.
        assert.deepStrictEqual(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH), intoProfile(legacyBase('ar'), ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH));
        assert.equal(profileFromLegacy(ENGLISH_SETTINGS).language.primary, 'en');
        assert.equal(profileFromLegacy(ENGLISH_SETTINGS).language.register, null);
    });

    it('describes the owner: his rows, plus the assumptions', () => {
        const p = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
        assert.equal(p.language.register, 'gulf');
        assert.deepStrictEqual(p.language.surfaces, { infographic: { register: 'msa' } }, 'his infographics speak the same language as he does, so no language override');
        assert.deepStrictEqual(p.identity.display_name, { ar: 'الأمير منصور', en: 'ElAmir Mansour' });
        assert.equal(p.identity.brand_name, 'Agentic AI بالعربي');
        assert.equal(p.identity.timezone, 'Asia/Riyadh');
        assert.equal(p.offers[0]!.kind, 'course');
        assert.equal(p.offers[0]!.name, ELAMIR_SEED_SETTINGS.product.name);
        assert.equal(p.offers[0]!.order_via, 'url');
        assert.deepStrictEqual(p.content.never_mention, ['MCP']);
        assert.deepStrictEqual(p.audience.countries, ['SA', 'AE', 'EG']);
        assert.deepStrictEqual(p.goals, { followers: 10_000, views: 1_000_000 });
        assert.equal(p.voice.address, 'masc');
        assert.equal(p.presenter?.pronouns, 'he');
        assert.deepStrictEqual(p.content.rules, ['no_women_imagery']);
    });

    it('always copies the brand name, even one equal to what the profile would show anyway', () => {
        // intoProfile would leave brand_name empty here, because the English display name already reads as it.
        // For a tenant described for the first time that blank would follow display_name the day it changed.
        const named = edit(ELAMIR_SEED_SETTINGS, { brand: ELAMIR_SEED_SETTINGS.infographic.name.en });
        assert.equal(named.brand.name, named.infographic.name.en);
        assert.equal(intoProfile(legacyBase('ar'), named).identity.brand_name, '', 'the shortcut, which a stored profile keeps for the second lens law');
        assert.equal(profileFromLegacy(named).identity.brand_name, 'ElAmir Mansour', 'a profile described from legacy holds it');
        // The Studio's neutral name is a name too.
        assert.equal(profileFromLegacy(defaultStudioSettings()).identity.brand_name, 'My Studio');
        // So changing the display name afterwards does not move the Studio's brand name.
        const p = profileFromLegacy(named);
        const renamed = { ...p, identity: { ...p.identity, display_name: { ar: 'اسم آخر', en: 'Another Name' } } };
        assert.equal(studioView(named, renamed).brand.name, 'ElAmir Mansour');
    });

    it('always copies the timezone: UTC stays UTC, and an empty one stays empty', () => {
        assert.equal(intoProfile(legacyBase('ar'), edit(ELAMIR_SEED_SETTINGS, { timezone: 'UTC' })).identity.timezone, '', 'the shortcut again');
        assert.equal(profileFromLegacy(edit(ELAMIR_SEED_SETTINGS, { timezone: 'UTC' })).identity.timezone, 'UTC');
        assert.equal(profileFromLegacy(defaultStudioSettings()).identity.timezone, 'UTC');
        assert.equal(profileFromLegacy(edit(ELAMIR_SEED_SETTINGS, { timezone: '' })).identity.timezone, '');
        assert.equal(profileFromLegacy(edit(ELAMIR_SEED_SETTINGS, { timezone: 'Europe/London' })).identity.timezone, 'Europe/London');
    });

    it('records an infographic language that differs from the voice\'s as a surface override', () => {
        // ELAMIR_SETTINGS has the neutral infographic section, which is English, under an Arabic voice.
        const p = profileFromLegacy(ELAMIR_SETTINGS);
        assert.deepStrictEqual(p.language.surfaces, { infographic: { register: 'msa', language: 'en' } });
    });

    it('describes a tenant with no product as a course shell, because today\'s prompts say "course" regardless', () => {
        const p = profileFromLegacy(defaultStudioSettings());
        assert.equal(p.offers.length, 1);
        assert.equal(p.offers[0]!.kind, 'course');
        assert.equal(p.offers[0]!.name, '');
        assert.equal(p.offers[0]!.order_via, 'dm', 'with no link there is only one way to order');
    });

    it('is a valid profile for the owner\'s rows, and for each of the other fixtures', () => {
        for (const [name, p] of [
            ['seed', profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)],
            ['ELAMIR_SETTINGS', profileFromLegacy(ELAMIR_SETTINGS, ELAMIR_GROWTH)],
            ['English', profileFromLegacy(ENGLISH_SETTINGS)],
            ['defaults', profileFromLegacy(defaultStudioSettings())],
            ['an http product link', profileFromLegacy(edit(ELAMIR_SEED_SETTINGS, { url: 'http://example.com/course' }))],
        ] as const) {
            const out = validateProfile(p);
            assert.ok('profile' in out, `${name}: ${'problems' in out ? out.problems.join('; ') : ''}`);
        }
    });

    it('is not activated for a tenant that never said who they are: that is for the wizard, never for a running path', () => {
        // The owner's rows have no niche or kind of their own to read; his onboarding is simply completed (D14).
        assert.deepStrictEqual(activationMissing(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)), ['identity.niche']);
        // A tenant on the Studio's defaults has said nothing: no name, no niche, and a timezone that is the default's.
        assert.deepStrictEqual(activationMissing(profileFromLegacy(defaultStudioSettings())), ['identity.display_name', 'identity.niche', 'offers.primary.name']);
    });
});

describe('a new tenant is not the owner', () => {
    // Everything the code assumes for the owner, one assumption at a time: the default carries none of it.
    it('the default profile differs from the legacy base in every assumption', () => {
        const fresh = defaultProfile({ lang: 'ar' });
        const legacy = legacyBase('ar');
        assert.notDeepStrictEqual(fresh.presenter, legacy.presenter);
        assert.equal(fresh.presenter, null);
        assert.notEqual(fresh.language.register, legacy.language.register);
        assert.notDeepStrictEqual(fresh.language.surfaces, legacy.language.surfaces);
        assert.notEqual(fresh.identity.role, legacy.identity.role);
        assert.notEqual(fresh.identity.kind, legacy.identity.kind);
        assert.notEqual(fresh.content.domain, legacy.content.domain);
        assert.notDeepStrictEqual(fresh.offers, legacy.offers);
        assert.equal(defaultProfile({ lang: 'en' }).voice.address, 'neutral');
        assert.equal(defaultProfile({ lang: 'en' }).language.surfaces.dm, undefined, 'a new English tenant is not forced into Arabic DMs by the profile');
    });

    it('a new tenant\'s profile read into its own empty settings stays neutral', () => {
        const p = intoProfile(defaultProfile({ lang: 'en' }), defaultStudioSettings());
        assert.equal(p.presenter, null);
        assert.equal(p.identity.role, '');
        assert.deepStrictEqual(p.offers, []);
        assert.equal(p.content.domain, 'general');
    });
});
