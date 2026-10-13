/**
 * The owner's tenant as a profile (01 §0.2): what the code assumes for every tenant today, and the
 * profile a tenant with no stored one is described by. A new tenant must never be described by it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultStudioSettings } from '../studio/settings.js';
import { ELAMIR_AGENT, ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS, ELAMIR_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { defaultProfile } from './defaults.js';
import { LEGACY_ASSUMPTIONS, legacyBase, profileFromLegacy } from './legacy.js';
import { activationMissing, validateProfile } from './validate.js';
import { intoProfile } from './views.js';

describe('LEGACY_ASSUMPTIONS', () => {
    it('is what the code hardcodes for every tenant today', () => {
        assert.deepStrictEqual({ ...LEGACY_ASSUMPTIONS, presenter: { ...LEGACY_ASSUMPTIONS.presenter }, rules: [...LEGACY_ASSUMPTIONS.rules] }, {
            presenter: { name: '', pronouns: 'he', on_camera: 'face' },
            rules: ['no_women_imagery'],
            register: 'gulf',
            infographicRegister: 'msa',
            kind: 'educator',
            role: 'tech educator',
            domain: 'tech',
            offerKind: 'course',
        });
    });

    it('cannot be changed by the code that reads it', () => {
        assert.throws(() => { (LEGACY_ASSUMPTIONS as { role: string }).role = 'x'; }, TypeError);
        assert.throws(() => { (LEGACY_ASSUMPTIONS.presenter as { pronouns: string }).pronouns = 'she'; }, TypeError);
        assert.throws(() => { (LEGACY_ASSUMPTIONS.rules as string[]).push('x'); }, TypeError);
    });
});

describe('legacyBase', () => {
    it('carries every assumption for an Arabic tenant: Gulf, with فصحى infographics', () => {
        const p = legacyBase('ar');
        assert.equal(p.language.primary, 'ar');
        assert.equal(p.language.register, 'gulf');
        assert.equal(p.language.digits, 'arabic-indic');
        assert.deepStrictEqual(p.language.surfaces, { infographic: { register: 'msa' } });
        assert.deepStrictEqual(p.presenter, { name: '', pronouns: 'he', on_camera: 'face' });
        assert.deepStrictEqual(p.content.rules, ['no_women_imagery']);
        assert.equal(p.content.domain, 'tech');
        assert.equal(p.identity.role, 'tech educator');
        assert.equal(p.identity.kind, 'educator');
        assert.equal(p.offers.length, 1);
        assert.equal(p.offers[0]!.kind, 'course');
        assert.equal(p.offers[0]!.primary, true);
    });

    it('an English tenant has no Gulf register, and still the same presenter, rule, role and course', () => {
        const p = legacyBase('en');
        assert.equal(p.language.primary, 'en');
        assert.equal(p.language.register, null);
        assert.equal(p.language.digits, 'latin');
        assert.deepStrictEqual(p.language.surfaces, { infographic: { register: 'msa' } }, 'an English tenant can still have Arabic infographics, which were always فصحى');
        assert.equal(p.presenter?.pronouns, 'he');
        assert.deepStrictEqual(p.content.rules, ['no_women_imagery']);
        assert.equal(p.identity.role, 'tech educator');
        assert.equal(p.offers[0]!.kind, 'course');
    });

    it('is a fresh object each time, so one tenant\'s profile cannot be edited through another\'s', () => {
        const a = legacyBase('ar');
        a.content.rules.push('no_women_imagery');
        a.offers[0]!.facts.push('x');
        a.presenter!.pronouns = 'she';
        assert.deepStrictEqual(legacyBase('ar').content.rules, ['no_women_imagery']);
        assert.deepStrictEqual(legacyBase('ar').offers[0]!.facts, []);
        assert.equal(legacyBase('ar').presenter!.pronouns, 'he');
    });
});

describe('profileFromLegacy', () => {
    it('is intoProfile over the legacy base of the settings\' language', () => {
        assert.deepStrictEqual(
            profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, ELAMIR_AGENT.knowledge_base),
            intoProfile(legacyBase('ar'), ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, ELAMIR_AGENT.knowledge_base),
        );
        assert.deepStrictEqual(profileFromLegacy(ENGLISH_SETTINGS), intoProfile(legacyBase('en'), ENGLISH_SETTINGS));
    });

    it('describes the owner: his rows, plus the assumptions', () => {
        const p = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, ELAMIR_AGENT.knowledge_base);
        assert.equal(p.language.register, 'gulf');
        assert.deepStrictEqual(p.language.surfaces, { infographic: { register: 'msa' } }, 'his infographics speak the same language as he does, so no language override');
        assert.deepStrictEqual(p.identity.display_name, { ar: 'الأمير منصور', en: 'ElAmir Mansour' });
        assert.equal(p.identity.brand_name, 'Agentic AI بالعربي');
        assert.equal(p.identity.timezone, 'Asia/Riyadh');
        assert.equal(p.offers[0]!.kind, 'course');
        assert.equal(p.offers[0]!.name, ELAMIR_SEED_SETTINGS.product.name);
        assert.equal(p.offers[0]!.order_via, 'url');
        assert.deepStrictEqual(p.content.never_mention, ['MCP']);
        assert.equal(p.dm.knowledge, ELAMIR_AGENT.knowledge_base);
        assert.deepStrictEqual(p.audience.countries, ['SA', 'AE', 'EG']);
        assert.deepStrictEqual(p.goals, { followers: 10_000, views: 1_000_000 });
        assert.equal(p.presenter?.pronouns, 'he');
        assert.deepStrictEqual(p.content.rules, ['no_women_imagery']);
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
            ['seed', profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH, ELAMIR_AGENT.knowledge_base)],
            ['ELAMIR_SETTINGS', profileFromLegacy(ELAMIR_SETTINGS, ELAMIR_GROWTH, ELAMIR_AGENT.knowledge_base)],
            ['English', profileFromLegacy(ENGLISH_SETTINGS)],
            ['defaults', profileFromLegacy(defaultStudioSettings())],
        ] as const) {
            const out = validateProfile(p);
            assert.ok('profile' in out, `${name}: ${'problems' in out ? out.problems.join('; ') : ''}`);
        }
    });

    it('is not activated for a tenant that never said who they are: that is for the wizard, never for a running path', () => {
        // The owner's rows have no niche or kind of their own to read; his onboarding is simply completed (D14).
        assert.deepStrictEqual(activationMissing(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)), ['identity.niche']);
        assert.deepStrictEqual(activationMissing(profileFromLegacy(defaultStudioSettings())), [
            'identity.display_name', 'identity.niche', 'identity.timezone', 'offers.primary.name',
        ]);
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
    });

    it('a new tenant\'s profile read into its own empty settings stays neutral', () => {
        const p = intoProfile(defaultProfile({ lang: 'en' }), defaultStudioSettings());
        assert.equal(p.presenter, null);
        assert.equal(p.identity.role, '');
        assert.deepStrictEqual(p.offers, []);
        assert.equal(p.content.domain, 'general');
    });
});
