/**
 * A brand-new tenant is written for in nobody's words (docs/onboarding/05 §3, P15): the last step of taking the owner's data out of
 * shared code.
 *
 * Every builder of the prompt surface (`promptSurface.ts`: the Studio's writer, the CTA lines, the DM, the captions, the carousel payload,
 * the Monteur's pick, copy, Editor, Analyst and render payload, the infographic's job, the DM bot's instruction, schema, disclosure and
 * starter persona, the comment fallbacks, the Growth coach and keyword finder) is run for a tenant whose settings are the platform's
 * DEFAULTS read through its profile, and none of the owner's markers may be in any of it: `assertNoOwnerMarkers` with no exception but
 * the line of a preset the tenant itself ticked.
 *
 * The turn the builders are fed is neutral too (`NEUTRAL_TURN`): the owner's goldens are captured with his story, his captions and his
 * hashtags, and a prompt that quotes the turn would hold his markers whatever the builder says. The check that says it is not hollow is
 * the last one: the same surface, fed his rows and his turn, does hold them.
 *
 * The tenants are the four a new account can be: the neutral profile in Arabic (the MSA register, D8) and in English, and the second-tenant
 * fixtures (`FITNESS_EN`, an English coach whose program is its only offer; `SHOP_EG`, an Egyptian shop of candles).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { starterPersona } from '../ai.js';
import { defaultGrowthSettings } from '../growth/settingsRow.js';
import { NO_WOMEN_LINE } from '../monteur/editor.js';
import { defaultInfographicConfig, defaultMonteurConfig, defaultStudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SERVED } from '../studio/testFixtures.js';
import { contextFor } from './context.js';
import { defaultProfile } from './defaults.js';
import { FITNESS_EN, SHOP_EG } from './fixtures.js';
import {
    entryText, NEUTRAL_SAY, NEUTRAL_TURN, OWNER_TURN, SAY, type SurfaceEntry, tenantSurface,
} from './promptSurface.js';
import { assertNoArabicScript, assertNoGulfInEgyptianOrMsa, assertNoOwnerMarkers, OWNER_MARKERS } from './testSupport.js';
import type { CreatorProfile } from './types.js';
import { growthView, studioView } from './views.js';

const NEW_TENANTS: readonly (readonly [name: string, profile: CreatorProfile])[] = [
    ['defaultProfile(ar)', defaultProfile({ lang: 'ar' })],
    ['defaultProfile(en)', defaultProfile({ lang: 'en' })],
    ['FITNESS_EN', FITNESS_EN],
    ['SHOP_EG', SHOP_EG],
];

/** A new tenant's rows, as its readers return them: the platform's defaults over its profile, and the starter persona its agent row gets. */
async function surfaceOf(profile: CreatorProfile): Promise<SurfaceEntry[]> {
    const dm = contextFor(profile, 'dm', null).language.code;
    return tenantSurface({
        studio: studioView(defaultStudioSettings(), profile),
        growth: growthView(defaultGrowthSettings(), profile),
        agent: { system_prompt: starterPersona(dm), knowledge_base: '' },
        profile,
        turn: NEUTRAL_TURN,
    });
}

/** Whether the tenant ticked the no-women preset: the Editor's prompt then says its line, and that line is the one thing of the owner's it may say. */
const ticked = (profile: CreatorProfile): boolean => profile.content.rules.includes('no_women_imagery');
const isEditor = (name: string): boolean => name.startsWith('monteur.editor-system.');

describe('every builder, for a brand-new tenant, says none of the owner\'s words', () => {
    for (const [name, profile] of NEW_TENANTS) {
        it(`${name}: the whole prompt surface`, async () => {
            const entries = await surfaceOf(profile);
            assert.ok(entries.length >= 32, `${entries.length} entries were built`);
            assert.deepEqual(entries.filter((e) => e.error !== undefined).map((e) => `${e.name}: ${e.error}`), [], 'every builder ran');
            for (const entry of entries) {
                const text = entryText(entry);
                const exceptions: string[] = [];
                if (isEditor(entry.name)) {
                    // The tenant ticked the rule (or did not): its line is said once, or not at all. Nothing else of his is let through.
                    assert.equal(text.split(NO_WOMEN_LINE).length - 1, ticked(profile) ? 1 : 0, `${entry.name}: the ticked preset's line, once; an unticked one's, never`);
                    if (ticked(profile)) exceptions.push(NO_WOMEN_LINE);
                }
                assertNoOwnerMarkers(text, `${name}: ${entry.name}`, { except: exceptions });
            }
        });
    }

    for (const [name, profile] of NEW_TENANTS.filter(([, p]) => p.language.primary === 'ar' && p.language.register !== 'gulf')) {
        it(`${name}: no Gulf word in what an Egyptian or MSA tenant is told, anywhere in the surface`, async () => {
            for (const entry of await surfaceOf(profile)) assertNoGulfInEgyptianOrMsa(entryText(entry), `${name}: ${entry.name}`);
        });
    }

    /**
     * An English tenant's prompts have no Arabic script. What may: the entries made of the turn's and the fixtures' own Arabic (the
     * lesson notes, the reels' transcript, the evidence) and the surface's Arabic halves (the infographic's `ar` job, the Arabic fallback
     * replies). Each of them must still hold Arabic, so an exception that stops being needed fails here and is deleted.
     */
    const FIXTURE_ARABIC: readonly string[] = [
        'studio.catalog', 'studio.draft-user', 'monteur.pick-user', 'monteur.copy-user', 'monteur.render-payload',
        'infographic.render-payload.ar', 'comments.dm-fallback-replies.ar', 'growth.keywords-user', 'growth.coach-user',
    ];
    for (const [name, profile] of NEW_TENANTS.filter(([, p]) => p.language.primary === 'en')) {
        it(`${name}: an English tenant's prompts have no Arabic script, outside the fixtures' own`, async () => {
            const entries = await surfaceOf(profile);
            for (const entry of entries) {
                const text = entryText(entry);
                if (FIXTURE_ARABIC.includes(entry.name)) {
                    assert.throws(() => assertNoArabicScript(text, entry.name), /has Arabic script/, `${entry.name} has no Arabic now: delete it from FIXTURE_ARABIC`);
                } else {
                    assertNoArabicScript(text, `${name}: ${entry.name}`);
                }
            }
            for (const exempt of FIXTURE_ARABIC) assert.ok(entries.some((e) => e.name === exempt), `${exempt} is not an entry of the surface any more: delete it from FIXTURE_ARABIC`);
        });
    }

    it('says its own rule and its own offer: the check is about the tenant\'s words, not the absence of words', async () => {
        const byName = (entries: SurfaceEntry[]) => new Map(entries.map((e) => [e.name, entryText(e)]));
        const fitness = byName(await surfaceOf(FITNESS_EN));
        assert.match(fitness.get('studio.system')!, /whose offer is «Twelve-week plan»/);
        assert.match(fitness.get('studio.system')!, /Never mention: steroids/);
        assert.match(fitness.get('monteur.editor-system.human-on')!, /No before-and-after photos/);
        assert.match(fitness.get('dm.disclosure-line')!, /Automated reply/);
        const shop = byName(await surfaceOf(SHOP_EG));
        assert.match(shop.get('studio.system')!, /whose product is «شمعة لافندر»/);
        assert.match(shop.get('dm.system-instruction')!, /باللهجة المصرية البسيطة/);
        const arabic = byName(await surfaceOf(defaultProfile({ lang: 'ar' })));
        assert.match(arabic.get('dm.system-instruction')!, /بالعربية الفصحى البسيطة/, 'the neutral Arabic tenant is written for in MSA (D8)');
        assert.match(arabic.get('dm.starter-persona')!, /مساعد ذكي/);
    });
});

describe('the defaults a new tenant is handed carry none of the owner\'s words', () => {
    const defaults: Record<string, unknown> = {
        'defaultStudioSettings()': defaultStudioSettings(),
        'defaultGrowthSettings()': defaultGrowthSettings(),
        'defaultMonteurConfig()': defaultMonteurConfig(),
        'defaultInfographicConfig()': defaultInfographicConfig(),
        'defaultProfile({ lang: "ar" })': defaultProfile({ lang: 'ar' }),
        'defaultProfile({ lang: "en" })': defaultProfile({ lang: 'en' }),
        'the starter persona, Arabic': starterPersona('ar'),
        'the starter persona, English': starterPersona('en'),
    };
    for (const [name, value] of Object.entries(defaults)) {
        it(name, () => assertNoOwnerMarkers(JSON.stringify(value), name));
    }

    it('the default call to action names nothing that is sold: no "course" (R18)', () => {
        const { cta } = defaultStudioSettings();
        assert.equal(cta.tiktokLine, '🔗 Link in my bio');
        assert.equal(cta.slide.ttHeadline, 'Everything in one place');
        assertNoOwnerMarkers(JSON.stringify(cta), 'the default cta');
    });

    it('the neutral turn the check feeds the builders is itself clean, so a pass says something about the builders', () => {
        for (const lang of ['ar', 'en'] as const) assertNoOwnerMarkers(JSON.stringify(NEUTRAL_TURN(lang)), `NEUTRAL_TURN(${lang})`);
        assertNoGulfInEgyptianOrMsa(JSON.stringify(NEUTRAL_SAY.ar), 'NEUTRAL_SAY.ar');
        assertNoArabicScript(JSON.stringify(NEUTRAL_SAY.en), 'NEUTRAL_SAY.en');
    });
});

describe('the check is real', () => {
    it('the same surface built for the OWNER\'s rows and his turn does hold his markers, in most of its entries', async () => {
        const entries = await tenantSurface({ studio: ELAMIR_SEED_SERVED, growth: ELAMIR_GROWTH, turn: OWNER_TURN });
        const held = entries.filter((entry) => {
            try { assertNoOwnerMarkers(entryText(entry)); return false; } catch { return true; }
        });
        assert.ok(held.length >= 20, `${held.length} of ${entries.length} of his entries carry his markers`);
    });

    it('his turn alone is enough to hold them: a prompt that quotes it would fail for any tenant', () => {
        for (const lang of ['ar', 'en'] as const) {
            assert.throws(() => assertNoOwnerMarkers(JSON.stringify(SAY[lang])), /holds the owner's/, lang);
            assert.throws(() => assertNoOwnerMarkers(JSON.stringify(OWNER_TURN(lang))), /holds the owner's/, lang);
        }
    });

    it('a new tenant whose editor prompt said the no-women line without ticking it would be caught', async () => {
        const unticked = defaultProfile({ lang: 'en', rules: [] });
        for (const entry of await surfaceOf(unticked)) {
            if (!isEditor(entry.name)) continue;
            const text = entryText(entry);
            assert.ok(!text.includes(NO_WOMEN_LINE));
            assert.throws(() => assertNoOwnerMarkers(`${text}\n${NO_WOMEN_LINE}`), /Never a woman/);
        }
    });

    it('lists every marker of 05 §3 once', () => {
        assert.equal(new Set(OWNER_MARKERS).size, OWNER_MARKERS.length);
        assert.equal(OWNER_MARKERS.length, 27);
    });
});
