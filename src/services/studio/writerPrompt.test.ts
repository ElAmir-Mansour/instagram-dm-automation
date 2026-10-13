/**
 * The Studio writer is written from the tenant's profile (docs/onboarding/05 §2 "P9 · Studio writer", §3; P9).
 *
 * Pinned here:
 *   - the owner's context writes the golden prompts byte for byte, and the examples he is shown are the three references in his own row
 *     (P14 removed the built-in fallback they were once read from; jsonb reorders keys: `exampleJson` does not care);
 *   - a second tenant's prompts, schema and fallbacks name its own offer, say its register's words, take no hashtag that is not its kind's,
 *     carry none of the owner's markers, and have no "Approved carousels" section unless it has examples;
 *   - the register kits: every non-Gulf register rejects what Gulf rejected, and names its own time words;
 *   - `studioWording` resolves the context as the DM and the comments do, and says nothing about examples: they are the row's.
 *
 * `golden.test.ts` holds the owner's bytes through four paths; this file holds everything that is not his.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setLogSink } from '../../utils/log.js';
import { contextFor, legacyContext } from '../profile/context.js';
import { defaultProfile } from '../profile/defaults.js';
import { FITNESS_EN, FITNESS_EN_PROGRAM, SHOP_EG, SHOP_EG_SERVICE } from '../profile/fixtures.js';
import { goldenPath } from '../profile/golden.js';
import { fallbackPitch, KIT_KEYS, KITS, kitFor, offerNounSingular } from '../profile/kits.js';
import { legacyBase, profileFromLegacy } from '../profile/legacy.js';
import { emptyState, installProfileDb, OTHER, OWNER, type ProfileDb, setPlatformOwner, studioRow } from '../profile/testDb.js';
import { assertNoArabicScript, assertNoGulfInEgyptianOrMsa, assertNoOwnerMarkers, throughJsonb } from '../profile/testSupport.js';
import type { ArabicRegister, CreatorKind, CreatorProfile } from '../profile/types.js';
import { studioView } from '../profile/views.js';
import { StudioError } from './common.js';
import { studioWording, WRITER_PROFILE_UNREADABLE } from './drafts.js';
import { ARABIC_EXAMPLES, ENGLISH_EXAMPLES, OWNER_REFERENCE_EXAMPLES } from './exampleFixtures.js';
import { exampleJson } from './examples.js';
import { DRAFT_SCHEMA, draftSchema, normalizeTiktokCaption } from './generate.js';
import {
    buildDm, buildPlanSystemPrompt, buildSystemPrompt, examplesFor, LANGUAGES, LEARNING_KINDS, pitchCore, type StudioWording, writerKit,
} from './prompts.js';
import { settingsProblems } from './settings.js';
import { defaultStudioSettings, type StudioSettings } from './settingsTypes.js';
import { ELAMIR_SEED_SERVED, ELAMIR_SETTINGS, ENGLISH_SETTINGS } from './testFixtures.js';

// ─── The fixtures ───────────────────────────────────────────────────────────────────────────

const wordingOf = (p: CreatorProfile): StudioWording => contextFor(p, 'carousel', 1);
const withRegister = (p: CreatorProfile, register: ArabicRegister): CreatorProfile => ({ ...p, language: { ...p.language, register } });
const withKind = (p: CreatorProfile, kind: CreatorKind | null): CreatorProfile => ({ ...p, identity: { ...p.identity, kind } });

const SHOP_MSA = withRegister(SHOP_EG, 'msa');
const SHOP_LEVANTINE = withRegister(SHOP_EG, 'levantine');
const SHOP_GULF = withRegister(SHOP_EG, 'gulf');
const DEFAULT_AR = defaultProfile({ lang: 'ar' });
const DEFAULT_EN = defaultProfile({ lang: 'en' });

/**
 * The tenant's Studio settings as its profile gives them: `studioView` over the neutral defaults, as they are. The default call to
 * action names no course (docs/onboarding/05 R18, P15), so a second tenant's prompt is free of the owner's markers on the defaults alone.
 */
function settingsOf(p: CreatorProfile): StudioSettings {
    return studioView(defaultStudioSettings(), p);
}

type Tenant = readonly [name: string, profile: CreatorProfile];
const TENANTS: readonly Tenant[] = [
    ['FITNESS_EN', FITNESS_EN], ['FITNESS_EN_PROGRAM', FITNESS_EN_PROGRAM],
    ['SHOP_EG', SHOP_EG], ['SHOP_EG_SERVICE', SHOP_EG_SERVICE], ['SHOP_MSA', SHOP_MSA], ['SHOP_LEVANTINE', SHOP_LEVANTINE],
    ['defaultProfile(ar)', DEFAULT_AR], ['defaultProfile(en)', DEFAULT_EN],
];

/** Every piece of text the writer's builders make for a tenant's wording, labelled, with nothing of the model's in it. */
function textsOf(name: string, p: CreatorProfile, examples: StudioSettings['examples'] = null): Record<string, string> {
    const wording = wordingOf(p);
    const settings = { ...settingsOf(p), examples };
    const kit = writerKit(wording);
    return {
        [`${name}: the system prompt`]: buildSystemPrompt(settings, wording),
        [`${name}: the planner's prompt`]: buildPlanSystemPrompt(settings, wording),
        [`${name}: the draft schema`]: JSON.stringify(draftSchema(wording)),
        [`${name}: the DM fallback`]: buildDm(settings.cta.dmTemplate, { question: kit.fallbackQuestion, pitch: kit.fallbackPitch, url: settings.product.url, bullets: settings.product.dmBullets }),
        [`${name}: a TikTok caption`]: normalizeTiktokCaption('Hook\n\nA value line\n\n#one #two #three #four', ['kw'], settings, kit.learnTags),
    };
}

const read = (set: 'elamir' | 'control', name: string): string => readFileSync(goldenPath(name, 'txt', set), 'utf8');

// ─── The owner ──────────────────────────────────────────────────────────────────────────────

describe('the owner\'s context writes his golden prompts', () => {
    const ownerWording = (): StudioWording => legacyContext('carousel');

    it('is a Gulf educator who sells a course', () => {
        const w = ownerWording();
        assert.deepEqual({ code: w.language.code, register: w.language.register }, { code: 'ar', register: 'gulf' });
        assert.deepEqual({ kind: w.who.kind, offerKind: w.who.offerKind }, { kind: 'educator', offerKind: 'course' });
    });

    it('byte for byte: the system prompt with the three references in his row, and the planner\'s', () => {
        assert.equal(buildSystemPrompt(ELAMIR_SEED_SERVED, ownerWording()), read('elamir', 'studio.system.seed'));
        assert.equal(buildSystemPrompt(ELAMIR_SETTINGS, ownerWording()), read('elamir', 'studio.system.elamir'));
        assert.equal(buildPlanSystemPrompt(ELAMIR_SETTINGS, ownerWording()), read('elamir', 'studio.plan-system.elamir'));
    });

    it('has the language kit of today: Gulf text and every field of LANGUAGES.ar, with the register\'s words the kit\'s', () => {
        const kit = writerKit(ownerWording());
        assert.deepEqual({ ...kit, timeWordsHead: undefined }, { ...LANGUAGES.ar, timeWordsHead: undefined });
        assert.deepEqual(kit.timeWordsHead, LANGUAGES.ar.timeWords.slice(0, 5), 'the prompt names the first five, as it always has');
        assert.equal(kit.fallbackPitch, 'شرحتها خطوة بخطوة في الكورس، مع التطبيق العملي.');
        assert.deepEqual(kit.learnTags, ['#تعلم_على_تيك_توك', '#LearnOnTikTok']);
    });

    it('the English control kit is LANGUAGES.en', () => {
        const kit = writerKit(wordingOf(profileFromLegacy(ENGLISH_SETTINGS)));
        assert.deepEqual({ ...kit, timeWordsHead: undefined }, { ...LANGUAGES.en, timeWordsHead: undefined });
        assert.deepEqual(kit.timeWordsHead, ['today', 'tonight', 'tomorrow', 'yesterday', 'this week']);
    });

    it('draftSchema for a course is the golden DRAFT_SCHEMA, and says the course in dmPitch', () => {
        assert.deepEqual(draftSchema(ownerWording()), DRAFT_SCHEMA);
        assert.equal((DRAFT_SCHEMA.properties as Record<string, { description?: string }>).dmPitch!.description, 'one sentence naming the part of the course');
    });
});

// ─── The examples ───────────────────────────────────────────────────────────────────────────

describe('exampleJson: the examples as the prompt prints them', () => {
    const builtIns = [...ARABIC_EXAMPLES, ...ENGLISH_EXAMPLES];

    it('jsonb really does reorder an example\'s keys (the reason there is a fixed order)', () => {
        for (const c of builtIns) assert.notEqual(JSON.stringify(throughJsonb(c), null, 2), JSON.stringify(c, null, 2), c.id);
    });

    it('prints each built-in as it always has, after a trip through jsonb, with or without the reference flag', () => {
        for (const c of builtIns) {
            const today = JSON.stringify(c, null, 2);
            assert.equal(exampleJson(c), today, `${c.id} as it is`);
            assert.equal(exampleJson(throughJsonb(c)), today, `${c.id} through jsonb`);
            assert.equal(exampleJson(throughJsonb({ ...c, reference: true })), today, `${c.id} through jsonb, a reference`);
        }
    });

    it('drops `reference`, orders every slide kind\'s keys as the types declare them, and leaves an unknown key last, sorted', () => {
        const printed = JSON.parse(exampleJson(throughJsonb({
            ...ENGLISH_EXAMPLES[0]!, reference: true, zzz: 1, aaa: 2,
            slides: [{ kind: 'cover', title: 'T', zzz: 1, altText: 'A', aaa: 2 }, { kind: 'mystery', body: 'b', title: 't' }],
        } as never)));
        assert.deepEqual(Object.keys(printed), ['id', 'accent', 'keyword', 'slides', 'captions', 'aaa', 'zzz']);
        assert.deepEqual(Object.keys(printed.slides[0]), ['kind', 'title', 'altText', 'aaa', 'zzz']);
        assert.deepEqual(Object.keys(printed.slides[1]), ['kind', 'body', 'title'], 'a kind it does not know: `kind` first, the rest sorted');
    });

    it('does not fail on what the settings check only loosely: a stray string where a shape was expected', () => {
        assert.doesNotThrow(() => exampleJson({ id: 'X', accent: '#000000', keyword: 'k', slides: ['oops', null, { kind: 'cover', title: 't', shot: 'name' }], captions: 'none' } as never));
    });

    it('prints the keys of every nested shape in the same order: shots, items, steps, compare sides', () => {
        const printed = exampleJson(throughJsonb({
            id: 'X', accent: '#000000', keyword: 'k', captions: { instagram: 'i', tiktokTitle: 't', tiktok: 'tt' },
            slides: [
                { kind: 'point', shot: { focusY: 0.5, name: 'n', zoom: 1, focusX: 0.5 }, tip: 't', body: 'b', title: 'x', n: 1 },
                { kind: 'list', title: 'l', items: [{ sub: 's', text: 't', icon: 'i' }] },
                { kind: 'steps', title: 's', steps: [{ body: 'b', title: 't' }] },
                { kind: 'compare', right: { items: ['r'], label: 'R' }, left: { items: ['l'], label: 'L' }, title: 'c' },
            ],
        }));
        const out = JSON.parse(printed);
        assert.deepEqual(Object.keys(out.slides[0]), ['kind', 'n', 'title', 'body', 'shot', 'tip']);
        assert.deepEqual(Object.keys(out.slides[0].shot), ['name', 'zoom', 'focusX', 'focusY']);
        assert.deepEqual(Object.keys(out.slides[1].items[0]), ['icon', 'text', 'sub']);
        assert.deepEqual(Object.keys(out.slides[2].steps[0]), ['title', 'body']);
        assert.deepEqual(Object.keys(out.slides[3]), ['kind', 'title', 'left', 'right']);
        assert.deepEqual(Object.keys(out.slides[3].left), ['label', 'items']);
    });
});

describe('examplesFor', () => {
    const mine = { ...ENGLISH_EXAMPLES[0]!, id: 'Mine' };
    const theirs = { ...ENGLISH_EXAMPLES[0]!, id: 'Theirs', reference: true };

    it('a tenant with none of its own is shown none', () => {
        for (const examples of [null, []]) assert.deepEqual(examplesFor({ ...defaultStudioSettings(), examples }), { examples: [], own: false });
    });

    it('the owner is shown the three references his row holds, as references: another creator\'s, three at most', () => {
        assert.deepEqual(examplesFor(ELAMIR_SETTINGS), { examples: OWNER_REFERENCE_EXAMPLES(), own: false });
    });

    it('a row\'s examples win, and are the tenant\'s own unless every one is marked as a reference', () => {
        const settings = (examples: StudioSettings['examples']): StudioSettings => ({ ...defaultStudioSettings(), examples });
        assert.deepEqual(examplesFor(settings([mine])), { examples: [mine], own: true });
        assert.equal(examplesFor(settings([theirs])).own, false, 'only references: another creator\'s');
        assert.equal(examplesFor(settings([theirs, mine])).own, true, 'one of its own makes them its own');
        assert.equal(examplesFor(settings([theirs, theirs, theirs, mine])).own, false, 'the fourth is not shown, so it does not count');
        assert.equal(examplesFor(settings([mine, mine, mine, mine])).examples.length, 3);
    });

    it('ignores what is not a carousel', () => {
        const settings = { ...defaultStudioSettings(), examples: [null, 'x', { id: 'no slides' }] as never };
        assert.deepEqual(examplesFor(settings).examples, []);
    });
});

describe('the examples section of the prompt', () => {
    const own = { ...ENGLISH_EXAMPLES[0]!, id: 'MineOnly' };
    const reference = { ...ENGLISH_EXAMPLES[0]!, id: 'ReferenceOnly', reference: true };
    const prompt = (p: CreatorProfile, examples: StudioSettings['examples']): string =>
        buildSystemPrompt({ ...settingsOf(p), examples }, wordingOf(p));

    it('is left out, whole, for a tenant with no examples: the last section is "Keyword, DM and id"', () => {
        for (const [name, p] of TENANTS) {
            const system = prompt(p, null);
            assert.ok(!system.includes('Approved carousels'), name);
            assert.ok(!system.includes('another creator'), name);
            assert.ok(system.trimEnd().endsWith('e.g. "LocalAI".'), `${name}: nothing follows the id line`);
        }
    });

    it('says "Carousels the creator approved." for a tenant\'s own, and prints them', () => {
        const system = prompt(FITNESS_EN, [own]);
        assert.match(system, /\n\n## Approved carousels\nCarousels the creator approved\. Match their density/);
        assert.ok(system.endsWith(`${exampleJson(own)}`), 'the example is the last thing, in the fixed key order');
        assert.ok(!system.includes('Their facts, CTA lines and shot names are theirs'), 'the reference caveat is for references');
    });

    it('says "Reference carousels by another creator." for a reference one, with the caveat, and never prints the flag', () => {
        const system = prompt(FITNESS_EN, [reference]);
        assert.match(system, /\n\n## Approved carousels\nReference carousels by another creator\. Match their density/);
        assert.match(system, /Their facts, CTA lines and shot names are theirs: use this creator's\.\n\n\{\n {2}"id": "ReferenceOnly"/);
        assert.ok(!system.includes('"reference"'));
    });

    it('prints a row\'s examples the same however jsonb ordered their keys', () => {
        const stored = [throughJsonb(own)];
        assert.equal(prompt(FITNESS_EN, stored), prompt(FITNESS_EN, [own]));
        assert.ok(prompt(FITNESS_EN, stored).includes('{\n  "id": "MineOnly",\n  "accent"'));
    });

    it('the owner\'s row holds his three references: his prompt is the golden one, whatever order jsonb keeps their keys in', () => {
        const wording = legacyContext('carousel');
        const stored = throughJsonb(OWNER_REFERENCE_EXAMPLES());
        assert.notEqual(JSON.stringify(stored), JSON.stringify(OWNER_REFERENCE_EXAMPLES()), 'the keys really were reordered');
        assert.equal(buildSystemPrompt({ ...ELAMIR_SEED_SERVED, examples: stored }, wording), read('elamir', 'studio.system.seed'));
        assert.equal(buildSystemPrompt(ELAMIR_SEED_SERVED, wording), read('elamir', 'studio.system.seed'));
    });

    it('there is no fallback: the owner\'s row with no examples is shown none, whoever asks and whatever the language', () => {
        for (const wording of [legacyContext('carousel'), contextFor(profileFromLegacy(ENGLISH_SETTINGS), 'carousel', null)]) {
            for (const examples of [null, []]) {
                const system = buildSystemPrompt({ ...ELAMIR_SEED_SERVED, examples }, wording);
                assert.ok(!system.includes('Approved carousels') && !system.includes('Reference carousels'), 'no section');
                assert.ok(system.trimEnd().endsWith('e.g. "LocalAI".'), 'nothing follows the id line');
            }
        }
    });

    it('a tenant whose row holds no examples is not shown the owner\'s carousels, whatever its language', () => {
        for (const [name, p] of TENANTS) {
            const system = prompt(p, null);
            for (const c of [...ARABIC_EXAMPLES, ...ENGLISH_EXAMPLES]) assert.ok(!system.includes(`"id": "${c.id}"`), `${name} was shown ${c.id}`);
        }
    });
});

// ─── A second tenant ────────────────────────────────────────────────────────────────────────

describe('a second tenant\'s writer carries none of the owner\'s markers', () => {
    for (const [name, p] of TENANTS) {
        it(`${name}: no marker in the prompts, the schema, the DM fallback or the TikTok caption`, () => {
            for (const [label, text] of Object.entries(textsOf(name, p))) assertNoOwnerMarkers(text, label);
        });
    }

    for (const [name, p] of TENANTS.filter(([, t]) => t.language.primary === 'en')) {
        it(`${name}: an English tenant has no Arabic script anywhere`, () => {
            for (const [label, text] of Object.entries(textsOf(name, p))) assertNoArabicScript(text, label);
        });
    }

    for (const [name, p] of [['SHOP_EG', SHOP_EG], ['SHOP_EG_SERVICE', SHOP_EG_SERVICE], ['SHOP_MSA', SHOP_MSA], ['defaultProfile(ar)', DEFAULT_AR]] as const) {
        it(`${name}: no Gulf word in what an Egyptian or MSA tenant is told`, () => {
            for (const [label, text] of Object.entries(textsOf(name, p))) assertNoGulfInEgyptianOrMsa(text, label);
        });
    }

    it('the Egyptian shop\'s TikTok caption has no #LearnOnTikTok and no Arabic learning tag', () => {
        const caption = textsOf('SHOP_EG', SHOP_EG)['SHOP_EG: a TikTok caption']!;
        assert.doesNotMatch(caption, /LearnOnTikTok|تعلم_على_تيك_توك/);
    });
});

describe('what a tenant sells is its noun: whose X is, what the X gives, the facts, the pitch', () => {
    const noun = (p: CreatorProfile): string => offerNounSingular(contextFor(p, 'carousel', 1).who.offerKind);

    it('the noun follows the kind every offer shares: course, program, product, service, else offer', () => {
        assert.equal(noun(FITNESS_EN_PROGRAM), 'program');
        assert.equal(noun(SHOP_EG), 'product');
        assert.equal(noun(SHOP_EG_SERVICE), 'service');
        assert.equal(noun(FITNESS_EN), 'offer', 'a coaching call and a program: mixed');
        assert.equal(noun(DEFAULT_EN), 'offer', 'no offer at all');
        assert.equal(noun(legacyBase('ar')), 'course');
        assert.equal(offerNounSingular(null), 'offer');
    });

    it('the program: "whose program is", in the cta line, the facts line and the pitch line, and the schema', () => {
        const p = FITNESS_EN_PROGRAM;
        const system = textsOf('F', p)['F: the system prompt']!;
        assert.match(system, /^You write carousel posts for «Sami Fit», whose program is «Twelve-week plan»\./);
        assert.match(system, /The cta slide's `promise` says what the program gives on this topic\./);
        assert.match(system, /There are no product facts: state no numbers about the program itself\./);
        assert.match(system, /- `dmPitch`: one sentence naming the part of the program that teaches it\.$/m);
        assert.equal((draftSchema(wordingOf(p)).properties as Record<string, { description?: string }>).dmPitch!.description, 'one sentence naming the part of the program');
        assert.match(textsOf('F', p)['F: the planner\'s prompt']!, /^You plan the next carousel posts for «Sami Fit», whose program is «Twelve-week plan»\./);
    });

    it('a shop\'s product, and a pitch that ties the topic to it, since nothing in a product teaches', () => {
        const system = textsOf('S', SHOP_EG)['S: the system prompt']!;
        assert.match(system, /whose product is «شمعة لافندر»\./);
        assert.match(system, /says what the product gives on this topic/);
        assert.match(system, /- `dmPitch`: one sentence tying the topic to the product\.$/m);
        assert.equal((draftSchema(wordingOf(SHOP_EG)).properties as Record<string, { description?: string }>).dmPitch!.description, 'one sentence tying the topic to the product');
    });

    it('a mix of kinds, or none, is "the offer"', () => {
        const system = textsOf('F', FITNESS_EN)['F: the system prompt']!;
        assert.match(system, /whose offer is «Twelve-week plan»/);
        assert.match(system, /- `dmPitch`: one sentence tying the topic to the offer\.$/m);
        assert.equal(pitchCore(wordingOf(DEFAULT_EN)), 'tying the topic to the offer');
    });

    it('with no brand name, the writer is "a" and the creator\'s role, with the right article, and with no role "a creator"', () => {
        const blank = (p: CreatorProfile, role: string): string => {
            const settings = { ...settingsOf(p), brand: { ...settingsOf(p).brand, name: '' }, product: { ...settingsOf(p).product, name: '' } };
            return buildSystemPrompt(settings, wordingOf({ ...p, identity: { ...p.identity, role } }));
        };
        assert.match(blank(FITNESS_EN, 'fitness coach'), /^You write carousel posts for a fitness coach\. A carousel/);
        assert.match(blank(SHOP_EG, 'online shop'), /^You write carousel posts for an online shop\. A carousel/);
        assert.match(blank(SHOP_EG, 'UX designer'), /^You write carousel posts for a UX designer\. A carousel/);
        assert.match(blank(DEFAULT_EN, ''), /^You write carousel posts for a creator\. A carousel/);
    });

    it('a course keeps today\'s words and its pitch; every other kind has no pitch to fall back on', () => {
        for (const key of KIT_KEYS) {
            assert.equal(fallbackPitch(KITS[key], 'course'), KITS[key].studio.coursePitch, key);
            for (const kind of ['program', 'product', 'service', 'coaching', 'community', 'event', 'other', 'mixed', null] as const) {
                assert.equal(fallbackPitch(KITS[key], kind), '', `${key}/${kind}`);
            }
        }
    });

    it('a shop\'s DM fallback is the question alone: the pitch line is dropped, and no blank line is left behind', () => {
        const dm = textsOf('S', SHOP_EG)['S: the DM fallback']!;
        assert.ok(dm.includes('عايز تطبّقها بنفسك خطوة بخطوة؟ 👀'));
        assert.doesNotMatch(dm, /\n\n\n/);
        assert.doesNotMatch(dm, /شرحتها|الكورس|الدورة/);
        assert.match(dm, /^Hi \{username\} 👋\n\nعايز تطبّقها بنفسك خطوة بخطوة؟ 👀\n\nhttps:\/\/nour\.example\/candle/);
    });
});

describe('the register kit: time words and the DM\'s fallback question', () => {
    const EXPECTED: Record<ArabicRegister | 'en', { head: string; question: string }> = {
        gulf: { head: 'اليوم, الليلة, الليله, الحين, هالحين', question: 'تبي تطبّقها بنفسك خطوة بخطوة؟ 👀' },
        msa: { head: 'اليوم, الليلة, الآن, غداً, أمس', question: 'هل تريد تطبيقها بنفسك خطوة بخطوة؟ 👀' },
        egyptian: { head: 'النهارده, الليلة, دلوقتي, بكره, امبارح', question: 'عايز تطبّقها بنفسك خطوة بخطوة؟ 👀' },
        levantine: { head: 'اليوم, الليلة, هلق, بكرا, مبارح', question: 'بدّك تطبّقها بحالك خطوة بخطوة؟ 👀' },
        en: { head: 'today, tonight, tomorrow, yesterday, this week', question: 'Want to try this yourself, step by step? 👀' },
    };

    for (const [name, p, key] of [
        ['SHOP_GULF', SHOP_GULF, 'gulf'], ['SHOP_MSA', SHOP_MSA, 'msa'], ['SHOP_EG', SHOP_EG, 'egyptian'], ['SHOP_LEVANTINE', SHOP_LEVANTINE, 'levantine'], ['FITNESS_EN', FITNESS_EN, 'en'],
    ] as const) {
        it(`${name}: the prompt names the ${key} time words and the DM falls back on the ${key} question`, () => {
            const texts = textsOf(name, p);
            assert.ok(texts[`${name}: the system prompt`]!.includes(`No time words (${EXPECTED[key].head}):`), 'the five the prompt names');
            assert.ok(texts[`${name}: the DM fallback`]!.includes(EXPECTED[key].question), 'the fallback question');
        });
    }

    it('every non-Gulf register rejects every word Gulf rejects, and its own: Gulf validation is unchanged', () => {
        const gulf = KITS.gulf.studio.timeWords;
        assert.equal(gulf.all.length, 24, 'today\'s list');
        assert.deepEqual(gulf.head, gulf.all.slice(0, 5));
        for (const key of ['msa', 'egyptian', 'levantine', 'en'] as const) {
            const { head, all } = KITS[key].studio.timeWords;
            assert.equal(head.length, 5, key);
            for (const word of head) assert.ok(all.includes(word), `${key}: its own head word ${word} is rejected`);
            if (key !== 'en') for (const word of gulf.all) assert.ok(all.includes(word), `${key} still rejects ${word}`);
            assert.equal(new Set(all).size, all.length, `${key}: no word twice`);
        }
        assert.deepEqual(KITS.egyptian.studio.timeWords.all.slice(0, gulf.all.length), [...gulf.all], 'Gulf\'s list first, in its order');
    });

    it('the writer\'s kit rejects the Egyptian words and the Gulf ones for an Egyptian shop, and the Levantine ones for a Levantine shop', () => {
        const eg = writerKit(wordingOf(SHOP_EG)).timeWords;
        for (const word of ['النهارده', 'دلوقتي', 'امبارح', 'الحين', 'اليوم']) assert.ok(eg.includes(word), word);
        assert.ok(!eg.includes('هلق'));
        const lev = writerKit(wordingOf(SHOP_LEVANTINE)).timeWords;
        for (const word of ['هلق', 'بكرا', 'مبارح', 'الحين']) assert.ok(lev.includes(word), word);
        assert.ok(!lev.includes('دلوقتي'));
    });

    it('the forward example: the owner\'s line for Gulf and Egyptian, and each register\'s own, English quoted as it is today', () => {
        assert.equal(KITS.gulf.studio.forwardExample, '«ابعتها لصاحبك اللي …»');
        assert.equal(KITS.egyptian.studio.forwardExample, '«ابعتها لصاحبك اللي …»');
        assert.equal(KITS.msa.studio.forwardExample, '«أرسلها لصديقك الذي …»');
        assert.equal(KITS.levantine.studio.forwardExample, '«ابعتها لرفيقك اللي …»');
        assert.equal(KITS.en.studio.forwardExample, '"Send this to the friend who …"');
    });

    it('the writer\'s language follows the carousel surface, not the profile: an English surface on an Arabic profile writes English', () => {
        const p: CreatorProfile = { ...SHOP_EG, language: { ...SHOP_EG.language, surfaces: { carousel: { language: 'en' } } } };
        const kit = writerKit(wordingOf(p));
        assert.equal(kit.name, 'English');
        assert.equal(kit.fallbackQuestion, KITS.en.studio.fallbackQuestion);
        assert.deepEqual(kit.timeWords, KITS.en.studio.timeWords.all);
        assert.equal(kitFor(contextFor(p, 'carousel', 1).language).key, 'en');
    });
});

describe('the learning hashtags are an educator\'s or a coach\'s', () => {
    const tags = (kind: CreatorKind | null): readonly string[] => writerKit(wordingOf(withKind(SHOP_EG, kind))).learnTags;

    it('an educator and a coach take them, in the language\'s own wording', () => {
        assert.deepEqual([...LEARNING_KINDS].sort(), ['coach', 'educator']);
        for (const kind of LEARNING_KINDS) assert.deepEqual(tags(kind), ['#تعلم_على_تيك_توك', '#LearnOnTikTok'], kind);
        assert.deepEqual(writerKit(wordingOf(FITNESS_EN)).learnTags, ['#LearnOnTikTok'], 'a coach, in English');
    });

    it('a shop, an agency, a creator and a profile with no kind do not', () => {
        for (const kind of ['shop', 'agency', 'creator', null] as const) assert.deepEqual(tags(kind), [], String(kind));
    });

    it('the prompt asks for them only when there are some, and the caption carries only those', () => {
        const coach = textsOf('F', FITNESS_EN);
        assert.match(coach['F: the system prompt']!, /then exactly «🔗 Link in my bio», then 4–6 hashtags including #LearnOnTikTok\. No keyword ask/);
        assert.match(coach['F: a TikTok caption']!, /#LearnOnTikTok$/);
        const shop = textsOf('S', SHOP_EG);
        assert.match(shop['S: the system prompt']!, /then exactly «🔗 Link in my bio», then 4–6 hashtags\. No keyword ask/);
        assert.doesNotMatch(shop['S: the system prompt']!, /including/);
        assert.doesNotMatch(shop['S: a TikTok caption']!, /LearnOnTikTok|تعلم/);
    });

    it('the Monteur\'s callers, handed no tags, still add the language\'s, as they did before P9', () => {
        const caption = normalizeTiktokCaption('Hook\n\n#a #b #c #d', ['kw'], ENGLISH_SETTINGS);
        assert.match(caption, /#LearnOnTikTok$/);
        assert.doesNotMatch(normalizeTiktokCaption('Hook\n\n#a #b #c #d', ['kw'], ENGLISH_SETTINGS, []), /LearnOnTikTok/);
    });
});

// ─── The settings check ─────────────────────────────────────────────────────────────────────

describe('an example\'s `reference` flag is a boolean', () => {
    const settings = (reference: unknown): StudioSettings => ({ ...defaultStudioSettings(), examples: [{ ...ENGLISH_EXAMPLES[0]!, reference } as never] });

    it('true, false and absent are fine', () => {
        for (const reference of [true, false, undefined]) assert.deepEqual(settingsProblems(settings(reference)), [], String(reference));
    });

    it('anything else is refused, by path', () => {
        assert.deepEqual(settingsProblems(settings('yes')), ['examples[0].reference must be true or false: it says the example is another creator\'s']);
    });
});

// ─── The context a tenant is written for ────────────────────────────────────────────────────

describe('studioWording', () => {
    let db: ProfileDb;
    let warnings: string[];
    let restoreSink: (() => void) | undefined;
    beforeEach(() => {
        warnings = [];
        const previous = setLogSink((level, line) => { if (level === 'warn') warnings.push(line); });
        restoreSink = () => setLogSink(previous);
    });
    afterEach(() => {
        db?.restore();
        restoreSink?.();
    });

    /** `tenant` is the creator asking; the platform owner is `owner` (an id, null for no creators at all, or an error: the lookup fails). */
    function tenant(profile: CreatorProfile | null, owner: string | null | Error = OWNER): void {
        const state = emptyState();
        state.studio.set(OWNER, studioRow(ENGLISH_SETTINGS));
        if (profile) state.profiles.set(OWNER, { profile: throughJsonb(profile), version: 4, activated_at: null, updated_by: null });
        db = installProfileDb(state);
        setPlatformOwner(db, owner);
    }

    it('is the stored profile\'s carousel context, and nothing else: the examples are the row\'s, so there is no flag about the owner', async () => {
        tenant(FITNESS_EN);
        const w = await studioWording(OWNER);
        assert.equal(w.who.role, 'fitness coach');
        assert.equal(w.who.offerKind, 'mixed');
        assert.deepEqual({ code: w.language.code, register: w.language.register }, { code: 'en', register: null });
        assert.deepEqual(Object.keys(w).sort(), ['language', 'who']);
    });

    it('is the same for another tenant: its own context', async () => {
        tenant(SHOP_EG, OTHER);
        const w = await studioWording(OWNER);
        assert.equal(w.who.offerKind, 'product');
        assert.equal(w.language.register, 'egyptian');
    });

    it('reads the carousel surface\'s language, not the profile\'s', async () => {
        tenant({ ...SHOP_EG, language: { ...SHOP_EG.language, surfaces: { carousel: { language: 'en' } } } }, OTHER);
        assert.equal((await studioWording(OWNER)).language.code, 'en');
    });

    it('a tenant with no stored profile is the one its rows describe, which is the owner\'s legacy wording', async () => {
        tenant(null, OTHER);
        const w = await studioWording(OWNER);
        assert.deepEqual({ kind: w.who.kind, role: w.who.role, offerKind: w.who.offerKind }, { kind: 'educator', role: 'tech educator', offerKind: 'course' });
    });

    it('does not depend on who the platform owner is: a lookup that fails, or finds nobody, changes nothing when the profile reads', async () => {
        for (const owner of [new Error('connection reset'), null, OWNER, OTHER]) {
            tenant(FITNESS_EN, owner);
            assert.deepEqual(await studioWording(OWNER), { language: wordingOf(FITNESS_EN).language, who: wordingOf(FITNESS_EN).who });
            db.restore();
        }
    });

    describe('the profile cannot be read', () => {
        it('the owner is written for in today\'s wording, logged', async () => {
            tenant(FITNESS_EN);
            db.failOn = /FROM creator_profiles/;
            db.failWith = new Error('connection reset');
            const w = await studioWording(OWNER);
            const legacy = contextFor(legacyBase('ar'), 'carousel', null);
            assert.deepEqual({ language: w.language, who: w.who }, { language: legacy.language, who: legacy.who });
            assert.equal(warnings.filter((l) => /profile\.context_unreadable/.test(l)).length, 1);
            assert.equal(buildSystemPrompt(ELAMIR_SEED_SERVED, w), read('elamir', 'studio.system.seed'));
        });

        it('any other tenant gets a retryable 503, never the owner\'s wording', async () => {
            tenant(FITNESS_EN, OTHER);
            db.failOn = /FROM creator_profiles/;
            db.failWith = new Error('connection reset');
            await assert.rejects(studioWording(OWNER), (err: unknown) => {
                assert.ok(err instanceof StudioError);
                assert.equal(err.status, 503);
                assert.equal(err.code, 'PROFILE_UNREADABLE');
                assert.equal(err.message, WRITER_PROFILE_UNREADABLE);
                assert.match(err.message, /Try again in a moment/);
                return true;
            });
        });
    });
});

// ─── The owner's reference carousels ────────────────────────────────────────────────────────

describe('the owner\'s reference carousels (the fixture his row\'s examples are built from)', () => {
    it('are his three Arabic carousels, in order, marked as references, as fresh copies', () => {
        const copy = OWNER_REFERENCE_EXAMPLES();
        assert.equal(copy.length, 3);
        assert.deepEqual(copy.map((c) => c.id), ['ChatVsAgent', 'ContextPyramid', 'LocalAI']);
        assert.ok(copy.every((c) => c.reference === true));
        assert.deepEqual(copy.map(({ reference: _r, ...c }) => c), ARABIC_EXAMPLES.slice(0, 3));
        copy[0]!.slides.pop();
        assert.notEqual(copy[0]!.slides.length, ARABIC_EXAMPLES[0]!.slides.length, 'a copy: editing it leaves the fixture alone');
        assert.equal(OWNER_REFERENCE_EXAMPLES()[0]!.slides.length, ARABIC_EXAMPLES[0]!.slides.length);
    });

    it('are what the owner\'s fixtures hold, and nobody else\'s', () => {
        assert.deepEqual(ELAMIR_SETTINGS.examples, OWNER_REFERENCE_EXAMPLES());
        assert.deepEqual(ELAMIR_SEED_SERVED.examples, OWNER_REFERENCE_EXAMPLES());
        assert.equal(ENGLISH_SETTINGS.examples, null);
    });

    it('are in no production module: only tests and the test fixtures import the fixture file', () => {
        const files = execFileSync('git', ['ls-files', 'src'], { encoding: 'utf8', cwd: fileURLToPath(new URL('../../../', import.meta.url)) }).split('\n').filter(Boolean);
        const importers = files
            .filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file))
            .filter((file) => /from '[^']*exampleFixtures\.js'/.test(readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')));
        assert.deepEqual(importers, ['src/services/studio/testFixtures.ts']);
    });
});
