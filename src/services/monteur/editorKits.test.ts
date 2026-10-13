/**
 * The Editor's prompt is written from the creator's profile (docs/onboarding/05 §2, "P10 · Monteur editor"):
 *
 *   - the owner's profile selects exactly the kit that holds the words the prompt used to hard-code, so his prompt is
 *     the one the goldens pin (golden.test.ts proves the bytes; this proves the kit is the legacy kit);
 *   - a second tenant (the shared fixtures: an English fitness coach, an Egyptian shop; and the variants below, a coach whose
 *     presenter is a woman and a shop that ticked nothing) gets a prompt with none of his words in it: no he/him/his, no
 *     «مثال: مطعم» in English, no Gemini/ChatGPT/n8n, and the "Never a woman" line if and only if the tenant ticked the rule
 *     (`assertNoOwnerMarkers`' `except` is that line, for a tenant that did), with the tenant's own rules after it;
 *   - a profile that cannot be read is today's text, and says so in the log.
 *
 * The worker's picture filter (`usablePhotos` and `NO_WOMEN`, aicourse-captions' scripts/monteur/stock.mjs) is deliberately
 * not conditional on any of this. It is not in this repository, so it is not tested here: its tests are the worker's
 * (library.test.mjs and edits.test.mjs), and the prompt line tested below is only the model's half of the rule.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { contextFor } from '../profile/context.js';
import { FITNESS_EN, SHOP_EG } from '../profile/fixtures.js';
import { profileFromLegacy } from '../profile/legacy.js';
import { emptyState, installProfileDb, OWNER, type ProfileDb, type State, studioRow } from '../profile/testDb.js';
import { assertNoOwnerMarkers, throughJsonb } from '../profile/testSupport.js';
import type { CreatorProfile } from '../profile/types.js';
import { studioView } from '../profile/views.js';
import { LANGUAGES } from '../studio/prompts.js';
import type { StudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_SETTINGS, ENGLISH_SETTINGS } from '../studio/testFixtures.js';
import { editorSystemPrompt, humanTouchesPrompt, NO_WOMEN_LINE } from './editor.js';
import {
    EDITOR_DOMAIN_KITS, EDITOR_LANGUAGE_KITS, editorKit, editorKitFor, type EditorKit, LEGACY_EDITOR_KIT, PRONOUN_KITS, pronounKit,
    type PronounKit,
} from './editorKits.js';
import type { ThinkOn } from './think.js';

// ─── The second tenants ──────────────────────────────────────────────────────────────────────

// FITNESS_EN (presenter `they`, the rule "No before-and-after photos") and SHOP_EG (no presenter, `no_women_imagery` ticked) are the
// shared fixtures. The Editor reads more than they vary, so two variants: the coach with a woman on camera (and 05 §3's wording of
// her rule), and the shop that never ticked the rule.
const FITNESS_EN_SHE: CreatorProfile = {
    ...FITNESS_EN,
    presenter: { name: 'Sami', pronouns: 'she', on_camera: 'face' },
    content: { ...FITNESS_EN.content, custom_rules: ['No before-and-after body photos'] },
};
const SHOP_EG_NO_RULE: CreatorProfile = { ...SHOP_EG, content: { ...SHOP_EG.content, rules: [] } };

const ARABIC = /\p{Script=Arabic}/u;
const MASCULINE = /\b(he|him|his)\b/i;
const FEMININE = /\b(she|her|hers)\b/i;
const count = (text: string, re: RegExp): number => text.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`))?.length ?? 0;

/** The settings the tenant's Editor call reads, as the real readers return them: the neutral stored row with the profile laid over it. */
const settingsOf = (p: CreatorProfile): StudioSettings => studioView(ENGLISH_SETTINGS, p);

const kitOf = (p: CreatorProfile): EditorKit => editorKit(contextFor(p, 'clip_edit', 1));
const promptOf = (p: CreatorProfile, human: boolean): string => {
    const settings = settingsOf(p);
    return editorSystemPrompt({ ...settings, monteur: { ...settings.monteur, human } }, kitOf(p));
};
const OWNER_KIT = editorKit(contextFor(profileFromLegacy(ELAMIR_SETTINGS), 'clip_edit', 1));
const ownerPrompt = (human: boolean): string =>
    editorSystemPrompt({ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, human } }, OWNER_KIT);

// ─── The kits ────────────────────────────────────────────────────────────────────────────────

describe('the kits', () => {
    it('pronouns: he, she, or the neutral "the speaker", each with its four forms', () => {
        assert.deepEqual({ ...PRONOUN_KITS.he }, { subj: 'he', obj: 'him', det: 'his', pron: 'his' });
        assert.deepEqual({ ...PRONOUN_KITS.she }, { subj: 'she', obj: 'her', det: 'her', pron: 'hers' });
        assert.deepEqual({ ...PRONOUN_KITS.they }, { subj: 'the speaker', obj: 'the speaker', det: 'the speaker\'s', pron: 'the speaker\'s' });
    });

    it('a presenter selects their kit; no presenter, or a value this release does not know, is the neutral one', () => {
        assert.equal(pronounKit({ pronouns: 'he' }), PRONOUN_KITS.he);
        assert.equal(pronounKit({ pronouns: 'she' }), PRONOUN_KITS.she);
        assert.equal(pronounKit({ pronouns: 'they' }), PRONOUN_KITS.they);
        assert.equal(pronounKit(null), PRONOUN_KITS.they);
        assert.equal(pronounKit(undefined), PRONOUN_KITS.they);
        assert.equal(pronounKit({ pronouns: 'xe' as never }), PRONOUN_KITS.they);
    });

    it('the language kit names the language, and holds the two labels that were Arabic whatever the reel\'s language; the English one has no Arabic', () => {
        assert.deepEqual({ ...EDITOR_LANGUAGE_KITS.ar }, { name: 'Arabic', example: '«مثال: مطعم»', never: '«هنا»' });
        assert.deepEqual({ ...EDITOR_LANGUAGE_KITS.en }, { name: 'English', example: '"Example: restaurant"', never: '"here"' });
        assert.ok(!ARABIC.test(EDITOR_LANGUAGE_KITS.en.name + EDITOR_LANGUAGE_KITS.en.example + EDITOR_LANGUAGE_KITS.en.never));
        // The names are the Studio's own, not a second copy that could drift from what the writer and the pick call the language.
        assert.equal(EDITOR_LANGUAGE_KITS.ar.name, LANGUAGES.ar.name);
        assert.equal(EDITOR_LANGUAGE_KITS.en.name, LANGUAGES.en.name);
    });

    it('the domain kit: tech keeps today\'s words, general says the same thing about no particular field', () => {
        assert.deepEqual({ ...EDITOR_DOMAIN_KITS.tech }, {
            tools: 'Gemini, ChatGPT, Claude, n8n, Python…', latinTerms: ', tech terms in Latin script', emoji: '🐍 Python',
        });
        assert.deepEqual({ ...EDITOR_DOMAIN_KITS.general }, {
            tools: 'an app, a brand, a product', latinTerms: ', brand and product names in Latin script', emoji: '🎁 a gift',
        });
        for (const kit of Object.values(EDITOR_DOMAIN_KITS)) assert.ok(kit.latinTerms.startsWith(', ') && !kit.latinTerms.endsWith('.'), 'it ends the sentence the prompt closes itself');
    });

    it('the legacy kit is the prompt as it was written: a man, Arabic examples, the tech tools, the rule, no other', () => {
        assert.deepEqual(LEGACY_EDITOR_KIT, { pronouns: PRONOUN_KITS.he, language: EDITOR_LANGUAGE_KITS.ar, domain: EDITOR_DOMAIN_KITS.tech, noWomen: true, rules: [] });
        assert.ok(Object.isFrozen(LEGACY_EDITOR_KIT) && Object.isFrozen(LEGACY_EDITOR_KIT.rules), 'a shared default no caller can edit');
    });
});

// ─── The owner ───────────────────────────────────────────────────────────────────────────────

describe('the owner', () => {
    it('his profile selects the legacy kit', () => {
        assert.deepEqual(OWNER_KIT, LEGACY_EDITOR_KIT);
    });

    it('so his prompt is the same text from the profile and from no profile, touches on and off', () => {
        for (const human of [true, false]) {
            const settings = { ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, human } };
            assert.equal(editorSystemPrompt(settings, OWNER_KIT), editorSystemPrompt(settings, LEGACY_EDITOR_KIT), `human ${human}`);
        }
    });

    it('and it still says what it said: he, him and his, the Arabic labels, the tech tools, the rule\'s line last', () => {
        for (const human of [true, false]) {
            const text = ownerPrompt(human);
            assert.ok(MASCULINE.test(text) && !FEMININE.test(text), `human ${human}`);
            for (const phrase of [
                'Show what he refers to', 'never copy his.', 'e.g. «مثال: مطعم».', 'never «هنا».',
                'On-screen words are in Arabic, tech terms in Latin script. The teaching kinds', '🌍 language, 🐍 Python, 🧠 thinking',
                "when the speaker names a tool or product (Gemini, ChatGPT, Claude, n8n, Python…), its name in Latin script; never one he doesn't name.",
            ]) assert.ok(text.includes(phrase), `${phrase} (human ${human})`);
            assert.ok(text.endsWith(`\n${NO_WOMEN_LINE}`), 'the line ends the prompt, as it always did');
            assert.ok(!text.includes('Creator\'s rules'));
        }
        assert.ok(ownerPrompt(true).includes(`\n${humanTouchesPrompt(PRONOUN_KITS.he)}\n${NO_WOMEN_LINE}`));
        assert.equal(NO_WOMEN_LINE, 'Never a woman or a girl in any picture, emoji or sticker (the creator\'s rule); prefer objects and scenes to people.');
    });
});

// ─── The second tenants' prompts ─────────────────────────────────────────────────────────────

interface Tenant {
    name: string;
    profile: CreatorProfile;
    /** What is expected, written out: not read back from the profile by the code under test. */
    pronouns: PronounKit;
    lang: 'en' | 'ar';
    /** Ticked `no_women_imagery`: the line is printed if and only if this. */
    ticked: boolean;
    rules: string[];
}
const TENANTS: Tenant[] = [
    { name: 'FITNESS_EN', profile: FITNESS_EN, pronouns: PRONOUN_KITS.they, lang: 'en', ticked: false, rules: ['No before-and-after photos'] },
    { name: 'FITNESS_EN_SHE', profile: FITNESS_EN_SHE, pronouns: PRONOUN_KITS.she, lang: 'en', ticked: false, rules: ['No before-and-after body photos'] },
    { name: 'SHOP_EG', profile: SHOP_EG, pronouns: PRONOUN_KITS.they, lang: 'ar', ticked: true, rules: [] },
    { name: 'SHOP_EG_NO_RULE', profile: SHOP_EG_NO_RULE, pronouns: PRONOUN_KITS.they, lang: 'ar', ticked: false, rules: [] },
];

for (const tenant of TENANTS) {
    const { name, profile, pronouns, lang, ticked, rules } = tenant;
    const she = pronouns === PRONOUN_KITS.she;
    const rulesLine = `Creator's rules: ${rules.join('; ')}.`;

    describe(`${name}: ${lang === 'en' ? 'an English' : 'an Arabic'} tenant, ${she ? 'a woman on camera' : 'no one named on camera'}, ${ticked ? 'the no-women rule ticked' : 'the no-women rule not ticked'}${rules.length ? `, its own rule "${rules[0]}"` : ''}`, () => {
        it('selects its pronouns, its language\'s labels, the general tools, the rule it ticked and the rules it wrote', () => {
            assert.deepEqual(kitOf(profile), {
                pronouns, language: EDITOR_LANGUAGE_KITS[lang], domain: EDITOR_DOMAIN_KITS.general, noWomen: ticked, rules,
            });
            assert.equal(settingsOf(profile).voice.language, lang);
        });

        for (const human of [true, false]) {
            describe(`with the human touches ${human ? 'on' : 'off'}`, () => {
                const text = promptOf(profile, human);

                it('never says he, him or his', () => {
                    assert.doesNotMatch(text, MASCULINE);
                });

                if (she) {
                    it('says she, her and hers where the owner\'s prompt said he, him and his, once each', () => {
                        assert.ok(text.includes('Show what she refers to') && text.includes('while she demonstrates on screen') && text.includes('never copy hers.'));
                        if (human) assert.ok(text.includes('an arrow at her when she addresses the viewer') && text.includes('head (her head, talking-head clips only)') && text.includes('set behind her.'));
                        assert.equal(count(text, FEMININE), count(ownerPrompt(human), MASCULINE), 'every pronoun of the owner\'s prompt is a slot of the kit');
                    });
                } else {
                    it('calls the presenter "the speaker", in every form, and never she or her either', () => {
                        assert.doesNotMatch(text, FEMININE);
                        for (const phrase of [
                            'Show what the speaker refers to', 'a callout points at what the speaker is using', 'every word the speaker says', 'never copy the speaker\'s.',
                            'other words than the speaker\'s, like a headline', 'a term the speaker introduces', 'only of what the speaker says.', 'a ring on what the speaker points at',
                        ]) assert.ok(text.includes(phrase), phrase);
                        if (human) assert.ok(text.includes('an arrow at the speaker when the speaker addresses the viewer') && text.includes('head (the speaker\'s head, talking-head clips only)') && text.includes('set behind the speaker.'));
                    });
                }

                it(`${ticked ? 'prints' : 'does not print'} the women line: it is there if and only if the tenant ticked the rule`, () => {
                    assert.equal(text.includes(NO_WOMEN_LINE), ticked);
                    assert.equal(/woman|girl/i.test(text), ticked, 'and nothing else in the prompt speaks of one');
                    assert.equal(count(text, /Never a woman/), ticked ? 1 : 0);
                });

                it(rules.length ? 'carries its own rules, on one line, last' : 'has no rules line', () => {
                    assert.equal(count(text, /Creator's rules/), rules.length ? 1 : 0);
                    if (rules.length) assert.ok(text.endsWith(`\n${rulesLine}`));
                    else assert.ok(text.endsWith(ticked ? `\n${NO_WOMEN_LINE}` : human ? 'set behind the speaker. text: 1-2 words.' : 'Invent nothing: only what the clip says.'));
                });

                it(lang === 'en' ? 'has no Arabic script at all, and English example labels' : 'keeps the Arabic example labels for an Arabic reel', () => {
                    if (lang === 'en') {
                        assert.doesNotMatch(text, ARABIC);
                        assert.ok(text.includes('e.g. "Example: restaurant".') && text.includes('never "here".'));
                    } else {
                        assert.ok(text.includes('e.g. «مثال: مطعم».') && text.includes('never «هنا».'));
                    }
                });

                it('names the general tools and vocabulary, none of the tech ones', () => {
                    assert.ok(text.includes(`names a tool or product (an app, a brand, a product), its name in Latin script; never one ${pronouns.subj} doesn't name.`));
                    assert.ok(text.includes(`On-screen words are in ${lang === 'en' ? 'English' : 'Arabic'}, brand and product names in Latin script. The teaching kinds`));
                    assert.ok(text.includes('🌍 language, 🎁 a gift, 🧠 thinking'));
                    // The 🐍 in the emoji whitelist is the worker's own set and stays; what goes is the example that pairs it with Python.
                    for (const word of ['Gemini', 'ChatGPT', 'n8n', 'Python', '🐍 Python', 'tech terms']) assert.ok(!text.includes(word), word);
                });

                it('holds none of the owner\'s markers, bar the line of a rule the tenant itself ticked', () => {
                    assertNoOwnerMarkers(text, `${name}, human ${human}`, { except: ticked ? [NO_WOMEN_LINE] : [] });
                });
            });
        }
    });
}

describe('the tenants cover what the kits choose between', () => {
    it('both pronoun kits a tenant can have, both languages, and the rule ticked and not', () => {
        assert.deepEqual(new Set(TENANTS.map((t) => t.pronouns)), new Set([PRONOUN_KITS.she, PRONOUN_KITS.they]));
        assert.deepEqual(new Set(TENANTS.map((t) => t.lang)), new Set(['en', 'ar']));
        assert.deepEqual(new Set(TENANTS.map((t) => t.ticked)), new Set([true, false]));
        assert.ok(TENANTS.some((t) => t.rules.length) && TENANTS.some((t) => !t.rules.length));
    });

    it('the shared fixtures are the ones the table says they are', () => {
        // If P8's fixtures change a fact the Editor reads, this says so rather than a prompt test failing for a reason it does not name.
        assert.equal(FITNESS_EN.presenter?.pronouns, 'they');
        assert.deepEqual(FITNESS_EN.content.custom_rules, ['No before-and-after photos']);
        assert.deepEqual(FITNESS_EN.content.rules, []);
        assert.equal(SHOP_EG.presenter, null);
        assert.deepEqual(SHOP_EG.content.rules, ['no_women_imagery']);
        assert.deepEqual(SHOP_EG.content.custom_rules, []);
        for (const p of [FITNESS_EN, SHOP_EG]) assert.equal(p.content.domain, 'general');
    });
});

// ─── The rule, and a tenant's rules ──────────────────────────────────────────────────────────

describe('the no-women rule and the tenant\'s own rules', () => {
    const base: EditorKit = { ...LEGACY_EDITOR_KIT, noWomen: false };
    const prompt = (kit: EditorKit, human = false) => editorSystemPrompt({ ...ENGLISH_SETTINGS, monteur: { ...ENGLISH_SETTINGS.monteur, human } }, kit);

    it('the line is printed, verbatim, for a tenant that ticked `no_women_imagery`, and for no one else', () => {
        assert.equal(kitOf(SHOP_EG).noWomen, true);
        assert.ok(promptOf(SHOP_EG, false).endsWith(`\n${NO_WOMEN_LINE}`));
        assert.equal(kitOf(SHOP_EG_NO_RULE).noWomen, false);
        assert.ok(!promptOf(SHOP_EG_NO_RULE, false).includes('Never a woman'));
        assert.ok(!prompt(base).includes('Never a woman'));
        assert.ok(prompt({ ...base, noWomen: true }).includes(`\n${NO_WOMEN_LINE}`));
    });

    it('a tenant that ticked the rule and wrote one has the line, then its rule, and the rest of the markers still fail', () => {
        const both: CreatorProfile = { ...SHOP_EG, content: { ...SHOP_EG.content, custom_rules: ['No gym selfies'] } };
        const text = promptOf(both, true);
        assert.ok(text.endsWith(`\n${NO_WOMEN_LINE}\nCreator's rules: No gym selfies.`));
        assertNoOwnerMarkers(text, 'ticked and a rule', { except: [NO_WOMEN_LINE] });
        assert.throws(() => assertNoOwnerMarkers(text, 'the line is not excepted'), /Never a woman/);
    });

    it('a rule follows the women line, and the human touches come before both', () => {
        const kit: EditorKit = { ...base, noWomen: true, rules: ['No before-and-after body photos'] };
        const text = prompt(kit, true);
        assert.ok(text.endsWith(`\n${humanTouchesPrompt(PRONOUN_KITS.he)}\n${NO_WOMEN_LINE}\nCreator's rules: No before-and-after body photos.`));
    });

    it('several rules are one line, in order, closing full stops dropped, and the line ends in one', () => {
        const text = prompt({ ...base, rules: ['No sad faces.', 'Keep it under a minute'] });
        assert.ok(text.endsWith('\nCreator\'s rules: No sad faces; Keep it under a minute.'));
        assert.equal(count(text, /\n/g) - count(prompt(base), /\n/g), 1, 'one line, not one per rule');
    });

    it('a tenant\'s rule is one line whatever it holds, and an empty one is not a rule', () => {
        const ctx = contextFor({ ...FITNESS_EN, content: { ...FITNESS_EN.content, custom_rules: ['  No\n\n  gym   selfies. ', '', '   '] } }, 'clip_edit', 1);
        assert.deepEqual(editorKit(ctx).rules, ['No gym selfies.']);
        const none = editorKit(contextFor({ ...FITNESS_EN, content: { ...FITNESS_EN.content, custom_rules: ['', ' '] } }, 'clip_edit', 1));
        assert.deepEqual(none.rules, []);
        assert.ok(!prompt({ ...base, rules: ['.', ' . '] }).includes('Creator\'s rules'), 'a rule that is only a full stop says nothing');
    });
});

// ─── One source for the language ─────────────────────────────────────────────────────────────

describe('the language is the profile context\'s, in the sentence and in the examples', () => {
    // The reels surface speaks English while the profile's primary language, and so the settings view's `voice.language`, is Arabic.
    const REELS_EN: CreatorProfile = { ...SHOP_EG, language: { ...SHOP_EG.language, surfaces: { reels: { language: 'en' } } } };

    it('the context says English for the reels while the settings say Arabic', () => {
        assert.equal(contextFor(REELS_EN, 'clip_edit', 1).language.code, 'en');
        assert.equal(settingsOf(REELS_EN).voice.language, 'ar');
    });

    it('so the prompt says "English" and gives English labels: the settings\' language is not read', () => {
        const text = editorSystemPrompt(settingsOf(REELS_EN), kitOf(REELS_EN));
        assert.ok(text.includes('On-screen words are in English, brand and product names in Latin script.'));
        assert.ok(text.includes('e.g. "Example: restaurant".') && text.includes('never "here".'));
        assert.doesNotMatch(text, ARABIC);
    });

    it('and the other way round: an Arabic reels surface under an English profile says "Arabic" with the Arabic labels', () => {
        const REELS_AR: CreatorProfile = { ...FITNESS_EN, language: { ...FITNESS_EN.language, register: 'gulf', surfaces: { reels: { language: 'ar', register: 'gulf' } } } };
        assert.equal(settingsOf(REELS_AR).voice.language, 'en');
        const text = editorSystemPrompt(settingsOf(REELS_AR), kitOf(REELS_AR));
        assert.ok(text.includes('On-screen words are in Arabic, brand and product names in Latin script.'));
        assert.ok(text.includes('e.g. «مثال: مطعم».'));
    });

    it('the owner\'s sentence is the one it always was', () => {
        assert.ok(ownerPrompt(true).includes('On-screen words are in Arabic, tech terms in Latin script. The teaching kinds'));
        assert.ok(ownerPrompt(false).includes('On-screen words are in Arabic, tech terms in Latin script. The teaching kinds'));
    });
});

// ─── Reading the kit ─────────────────────────────────────────────────────────────────────────

describe('editorKitFor — the tenant\'s kit; a profile that cannot be read is the owner\'s text for the Mac brain and no Editor call for anyone else', () => {
    let state: State;
    let db: ProfileDb;
    let logs: { event: string; [k: string]: unknown }[];
    let previousSink: ReturnType<typeof setLogSink>;
    const MAC: ThinkOn = { creatorId: OWNER, key: `source/${OWNER}/a1` };
    const unreadable = (log: typeof logs) => log.filter((l) => l.event === 'monteur.editor_profile_unreadable');

    beforeEach(() => {
        state = emptyState();
        db = installProfileDb(state);
        logs = [];
        previousSink = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    });
    afterEach(() => {
        db.restore();
        setLogSink(previousSink);
    });

    const store = (p: CreatorProfile): void => {
        state.profiles.set(OWNER, { profile: throughJsonb(p), version: 3, activated_at: null, updated_by: null });
    };

    it('reads the stored profile through `profileContext`, for the `clip_edit` purpose, on either brain', async () => {
        store(FITNESS_EN);
        assert.deepEqual(await editorKitFor(OWNER, undefined), kitOf(FITNESS_EN));
        assert.deepEqual(await editorKitFor(OWNER, MAC), kitOf(FITNESS_EN));
        assert.equal(db.ran(/FROM creator_profiles/).length, 2);
        assert.deepEqual(logs, []);
    });

    it('a tenant with no stored profile is read from its rows: the legacy assumptions, which for a Studio row like his are his kit', async () => {
        state.studio.set(OWNER, studioRow(ELAMIR_SETTINGS));
        assert.deepEqual(await editorKitFor(OWNER, undefined), LEGACY_EDITOR_KIT);
    });

    it('a database without the profile table yet (migration v33 not applied) is a tenant with no stored profile, not a failure', async () => {
        db.v33 = false;
        state.studio.set(OWNER, studioRow(ELAMIR_SETTINGS));
        assert.deepEqual(await editorKitFor(OWNER, undefined), LEGACY_EDITOR_KIT);
        assert.deepEqual(unreadable(logs), []);
    });

    it('passes the purpose it needs, and what it is given is what it selects', async () => {
        const seen: unknown[] = [];
        const kit = await editorKitFor('tenant-1', undefined, async (id, purpose) => {
            seen.push([id, purpose]);
            return contextFor(SHOP_EG, purpose, 2);
        });
        assert.deepEqual(seen, [['tenant-1', 'clip_edit']]);
        assert.deepEqual(kit, kitOf(SHOP_EG));
    });

    describe('with the Mac brain (the owner, under G1)', () => {
        it('an unreadable profile is the owner\'s text, which a call waited for on the Mac needs, logged once, never a throw', async () => {
            const kit = await editorKitFor('tenant-1', MAC, async () => { throw new Error('connection terminated'); });
            assert.equal(kit, LEGACY_EDITOR_KIT);
            const [line, ...rest] = unreadable(logs);
            assert.equal(line!.creator_id, 'tenant-1');
            assert.equal(line!.mac_brain, true);
            assert.deepEqual(rest, []);
        });

        it('also when the database itself refuses the read', async () => {
            db.failOn = /FROM creator_profiles/;
            db.failWith = new Error('too many connections');
            assert.equal(await editorKitFor(OWNER, MAC), LEGACY_EDITOR_KIT);
            assert.equal(unreadable(logs).length, 1);
        });
    });

    describe('without it (Gemini: every other tenant)', () => {
        it('an unreadable profile is null, so the owner\'s pronouns, labels and tools reach nobody else; logged once, never a throw', async () => {
            const kit = await editorKitFor('tenant-1', undefined, async () => { throw new Error('connection terminated'); });
            assert.equal(kit, null);
            const [line, ...rest] = unreadable(logs);
            assert.equal(line!.creator_id, 'tenant-1');
            assert.equal(line!.mac_brain, false);
            assert.deepEqual(rest, []);
        });

        it('also when the database itself refuses the read', async () => {
            db.failOn = /FROM creator_profiles/;
            db.failWith = new Error('too many connections');
            assert.equal(await editorKitFor(OWNER, undefined), null);
            assert.equal(unreadable(logs).length, 1);
        });
    });
});
