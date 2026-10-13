/**
 * P11, the Monteur's pick and copy for creators who are nothing like the owner (docs/onboarding/05 §2 and §3).
 *
 * The owner's bytes are pinned by the goldens (`profile/golden.test.ts`): his pick and copy prompts, his ask pool and the clip
 * copy built with it, by four routes to the same kits. This file is the other half of the promise, and has three jobs:
 *
 *   - the review: every line a native speaker is asked to read (`REVIEW`), spelled out so a correction is a change to this file;
 *   - the kits: which one a profile selects (register, language, field, kind), and what each holds;
 *   - the second tenants: FITNESS_EN, SHOP_EG and a Levantine and an MSA variant of the shop, run through every builder P11
 *     changed: `assertNoOwnerMarkers` on all of it, no Arabic script for the English coach, no Gulf token for the Egyptian and MSA
 *     shop, no learning-programme tag for a shop, each register's own pool and "send it to" example, no tool or AI hashtag for a
 *     creator in the general field.
 *
 * The sweep's side (a profile that cannot be read, the kits reaching the model) is in `sweep.test.ts`; the YouTube category,
 * which follows the creator's kind, in `youtube.test.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { contextFor, legacyContext, ProfileUnreadableError, type ProfileContext } from '../profile/context.js';
import { FITNESS_EN, offer, SHOP_EG } from '../profile/fixtures.js';
import { fallbackPitch, KIT_KEYS, KITS, REEL_LANGUAGE_KITS, REEL_REGISTER_KITS } from '../profile/kits.js';
import { profileFromLegacy } from '../profile/legacy.js';
import { emptyState, installProfileDb, OTHER, OWNER, setPlatformOwner } from '../profile/testDb.js';
import { assertNoArabicScript, assertNoGulfInEgyptianOrMsa, assertNoOwnerMarkers, GULF_TOKENS } from '../profile/testSupport.js';
import { KINDS, REGISTERS, type CreatorKind, type CreatorProfile, type Domain, type OfferKind } from '../profile/types.js';
import { studioView } from '../profile/views.js';
import { LANGUAGES, LEARNING_KINDS } from '../studio/prompts.js';
import { defaultStudioSettings, type StudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { ASK_POOL, copySystemPrompt, copyUserPrompt, toClipCopy, type CopyContext } from './copy.js';
import {
    COPY_DOMAIN_KITS, copyKit, PICK_DOMAIN_KITS, pickKit, reelKitsFor, reelKitsFromContexts, type CopyKit, type PickKit,
} from './copyKits.js';
import { pickSystemPrompt, pickUserPrompt } from './pick.js';
import type { PickedClip, TranscriptLine } from './transcript.js';

// ─── The tenants ─────────────────────────────────────────────────────────────────────────────

const withRegister = (p: CreatorProfile, register: (typeof REGISTERS)[number]): CreatorProfile => ({ ...p, language: { ...p.language, register } });
const withDomain = (p: CreatorProfile, domain: Domain): CreatorProfile => ({ ...p, content: { ...p.content, domain } });
const withKind = (p: CreatorProfile, kind: CreatorKind | null): CreatorProfile => ({ ...p, identity: { ...p.identity, kind } });

/** The owner, as a profile: what a tenant with no stored profile is described as (Gulf Arabic, the tech field, an educator). */
const OWNER_PROFILE = profileFromLegacy(ELAMIR_SETTINGS);
const SHOP_LEVANTINE = withRegister(SHOP_EG, 'levantine');
const SHOP_MSA = withRegister(SHOP_EG, 'msa');
/** The same coach and the same shop in the tech field: today's hashtags and examples, for the tests that need the contrast. */
const FITNESS_TECH = withDomain(FITNESS_EN, 'tech');
const SHOP_TECH = withDomain(SHOP_EG, 'tech');

const kitsOf = (p: CreatorProfile) => reelKitsFromContexts(contextFor(p, 'clip_pick', 1), contextFor(p, 'clip_copy', 1));

/** The Studio's settings as the real reader returns them for the profile: neutral rows with the profile laid over them. */
function settingsFor(p: CreatorProfile): StudioSettings {
    const neutral = defaultStudioSettings();
    const ar = p.language.primary === 'ar';
    return {
        ...studioView(neutral, p),
        // The CTA is a Studio setting a tenant writes; the shipped default still says "course" (05 R18, P15), which is not this file's to test.
        cta: { ...neutral.cta, instagramAsk: '', tiktokLine: ar ? 'رابطه في البايو 🔗' : '🔗 Link in my bio', dmTemplate: '{question}\n\n{pitch}\n\n{url}' },
    };
}

const line = (n: number, text: string): TranscriptLine => ({ n, first: n - 1, last: n - 1, t0: (n - 1) * 5, t1: n * 5 - 0.5, text, forcedStart: false, forcedEnd: false });
const clip = (title: string): PickedClip => ({
    rank: 1, startLine: 1, endLine: 2, startWord: 0, endWord: 1, start: 0, end: 9.5, title, hook: '', why: null, score: 9,
    scores: { hook: 3, alone: 3, payoff: 3, send: 3 }, hookType: 'promise', text: '',
});

/** What the model answers for one clip, in each language: no ask of its own, so the register's pool is what the caption carries. */
const STORIES = {
    en: {
        lines: [line(1, 'Ten minutes at home is enough to start.'), line(2, 'Do this routine every morning.')],
        title: 'Ten minutes at home',
        item: {
            clip: 1, first_line: 'Ten minutes is enough', body: 'A short routine you can do at home\nSend this to the friend who never has time',
            ask_line: 'no keyword here', tiktok_body: 'A ten minute workout for busy parents.', hashtags: ['homeworkout', 'fitness', 'parents'],
            keyword_candidates: ['plan', 'workout', 'routine'], variants: [], question: 'Want a plan that fits your day? 💪',
            pitch: 'The plan has a workout for every day.', alt_text: 'A speaker shows a ten minute home workout',
        },
    },
    ar: {
        lines: [line(1, 'شمعة واحدة تغيّر جو البيت كله.'), line(2, 'أشعل الشمعة وقت الاسترخاء.')],
        title: 'شمعة تهدّي البيت',
        item: {
            clip: 1, first_line: 'شمعة لافندر تهدّي البيت', body: 'ريحة هادية تفرق في يومك\nابعتها لصاحبك اللي بيحب الشموع',
            ask_line: 'no keyword here', tiktok_body: 'شمعة لافندر يدوية بريحة هادية.', hashtags: ['شمعة', 'هدايا', 'ديكور'],
            keyword_candidates: ['شمعة', 'لافندر', 'هدية'], variants: [], question: 'عايز تعرف الريحة؟',
            pitch: 'الشمعة يدوية وبريحة هادية.', alt_text: 'متحدث يعرض شمعة لافندر يدوية',
        },
    },
} as const;

/** Everything P11 writes for a tenant, by builder (and the clip copy for the first of the five asks). */
function builtFor(p: CreatorProfile): Record<string, string> {
    const story = STORIES[p.language.primary];
    const settings = settingsFor(p);
    const kits = kitsOf(p);
    const ctx: CopyContext = { kit: kits.copy, activeKeywords: [], recentAsks: [] };
    const outcome = toClipCopy(story.item, clip(story.title), settings, ctx, [], [], 0);
    if ('error' in outcome) throw new Error(outcome.error);
    // The model left the DM's question and pitch empty: what the clip falls back to is the register's, and a course's alone.
    const bare = toClipCopy({ ...story.item, question: '', pitch: '' }, clip(story.title), settings, ctx, [], [], 0);
    if ('error' in bare) throw new Error(bare.error);
    return {
        'pick-system': pickSystemPrompt(settings, kits.pick),
        'pick-user': pickUserPrompt({ lines: story.lines, settings, lessons: [], kit: kits.pick, keep: 2 }),
        'copy-system': copySystemPrompt(settings, kits.copy),
        'copy-user': copyUserPrompt({ clips: [clip(story.title)], lines: story.lines, settings, lessons: [], activeKeywords: [], recentAsks: [] }),
        'clip-copy': JSON.stringify(outcome),
        'clip-copy-fallbacks': JSON.stringify(bare),
    };
}

const hashtagsLine = (copySystem: string): string => copySystem.split('\n').find((l) => l.startsWith('- hashtags:'))!;
const TECH_TAGS = /Gemini|ChatGPT|الذكاء_الاصطناعي|#tech\b|#تقنية|#برمجة/;

// ─── The review ──────────────────────────────────────────────────────────────────────────────

/**
 * Every line a native speaker is asked to read (05 §2), as the kit writes it. The Gulf pool is the owner's and is not under
 * review; the other three are Opus drafts, and so are the two Arabic lines of the general field below. The "send it to" example is
 * P9's (`KITS[key].studio.forwardExample`, reviewed in `profile/kits.test.ts`); it is listed here because it is the line of 05's
 * table that the copy prompt shows, and the copy kit is held to read it from there. All of them address one
 * reader (a man): a `voice.address` of feminine or plural is a follow-up.
 */
const REVIEW: Record<'msa' | 'egyptian' | 'levantine', { asks: readonly string[]; forward: string }> = {
    msa: {
        asks: [
            'هل تريد الرابط؟ اكتب «{keyword}» وسيصلك في الخاص 📩',
            'هل تودّ تطبيقها بنفسك؟ علّق بـ«{keyword}» وسأرسل لك التفاصيل 📩',
            'هل تحتاج الشرح كاملًا؟ اكتب «{keyword}» ويصلك في الخاص 👇',
            'هل تريد الخطوات؟ علّق بـ«{keyword}» وستصلك رسالة مني 📩',
            'هل تودّ تجربتها؟ اكتب «{keyword}» في التعليقات 👇',
        ],
        forward: '«أرسلها لصديقك الذي …»',
    },
    egyptian: {
        asks: [
            'عايز اللينك؟ اكتب «{keyword}» ويوصلك على الخاص 📩',
            'حابب تطبّقها بنفسك؟ علّق «{keyword}» وأبعتلك التفاصيل 📩',
            'محتاج الشرح كله؟ اكتب «{keyword}» وهيوصلك على الخاص 👇',
            'عايز الخطوات؟ علّق «{keyword}» وهتجيلك رسالة مني 📩',
            'نفسك تجرّبها؟ اكتب «{keyword}» في الكومنتات 👇',
        ],
        forward: '«ابعتها لصاحبك اللي …»',
    },
    levantine: {
        asks: [
            'بدّك الرابط؟ اكتب «{keyword}» وبيوصلك عالخاص 📩',
            'حابب تطبّقها بحالك؟ علّق «{keyword}» وببعتلك التفاصيل 📩',
            'بدّك الشرح كامل؟ اكتب «{keyword}» وبيجيك عالخاص 👇',
            'بدّك الخطوات؟ علّق «{keyword}» وبتوصلك رسالة مني 📩',
            'حابب تجرّبها؟ اكتب «{keyword}» بالتعليقات 👇',
        ],
        forward: '«ابعتها لرفيقك اللي …»',
    },
};

/** What the hashtag line and the keyword examples say to a creator in the general field, in each language (drafts, like the pools). */
const GENERAL_FIELD = {
    ar: {
        hashtags: '- hashtags: 3-5 tags without # naming this clip\'s topic: the specific subject it shows (a product, a place, a step or a result), mostly Arabic. Never generic tags (#نصائح #تعلم) nor #اكسبلور #explore #fyp #foryou.',
        keywords: 'دليل، قائمة، خطوات',
    },
    en: {
        hashtags: '- hashtags: 3-5 tags without # naming this clip\'s topic: the specific subject it shows (a product, a place, a step or a result). Never generic tags (#tips #learning) nor #explore #fyp #foryou.',
        keywords: 'guide, plan, steps',
    },
} as const;

describe('the ask pools', () => {
    it('are one per kit: the four Arabic registers and English, five asks each, each a question that holds «{keyword}» once', () => {
        assert.deepEqual(Object.keys(ASK_POOL).sort(), [...KIT_KEYS].sort());
        assert.deepEqual([...KIT_KEYS].sort(), [...REGISTERS, 'en'].sort());
        for (const key of KIT_KEYS) {
            assert.equal(ASK_POOL[key].length, 5, key);
            for (const ask of ASK_POOL[key]) {
                assert.equal(ask.split('«{keyword}»').length - 1, 1, `${key}: ${ask}`);
                assert.equal(ask.split('{keyword}').length - 1, 1, `${key}: no bare {keyword}`);
                assert.match(ask, /[?؟]/, `${key}: a question: ${ask}`);
            }
            assert.equal(new Set(ASK_POOL[key]).size, 5, `${key}: five different asks`);
        }
    });

    it('are the kits\' own asks: the sweep, the golden and this review read one text', () => {
        for (const key of KIT_KEYS) assert.deepEqual([...ASK_POOL[key]], [...REEL_REGISTER_KITS[key].asks], key);
    });

    it('the Gulf pool is the pool this app always had, word for word: it is the owner\'s', () => {
        assert.deepEqual([...ASK_POOL.gulf], [
            'تبي الرابط؟ اكتب «{keyword}» ويوصلك بالخاص 📩',
            'حاب تطبقها بنفسك؟ علّق «{keyword}» وأرسل لك التفاصيل 📩',
            'تحتاج الشرح كامل؟ اكتب «{keyword}» ويجيك بالخاص 👇',
            'ودك بالخطوات؟ علّق «{keyword}» وتوصلك رسالة مني 📩',
            'تبي تجربها؟ اكتب «{keyword}» بالتعليقات 👇',
        ]);
        assert.equal(copyKit(contextFor(OWNER_PROFILE, 'clip_copy', null)).forward, '«ابعتها لصاحبك اللي …»');
    });

    it('the English pool is the one it already was, and has no Arabic script', () => {
        assert.deepEqual([...ASK_POOL.en], [
            'Want the link? Comment «{keyword}» and I\'ll DM it to you 📩',
            'Want to try it yourself? Comment «{keyword}» 👇',
            'Need the full walkthrough? Comment «{keyword}» and check your DMs 📩',
            'Want the steps? Comment «{keyword}» and I\'ll send them 👇',
            'Should I send you the details? Comment «{keyword}» 📩',
        ]);
        assert.equal(KITS.en.studio.forwardExample, '"Send this to the friend who …"');
        assertNoArabicScript([...ASK_POOL.en, KITS.en.studio.forwardExample].join('\n'), 'the English asks');
    });

    for (const key of ['msa', 'egyptian', 'levantine'] as const) {
        it(`${key}: five asks and the "send it to" example, as 05 §2 drafts them (for a native speaker to read)`, () => {
            assert.deepEqual([...ASK_POOL[key]], REVIEW[key].asks);
            assert.equal(KITS[key].studio.forwardExample, REVIEW[key].forward);
            assert.equal(copyKit(contextFor(withRegister(SHOP_EG, key), 'clip_copy', null)).forward, REVIEW[key].forward, 'and the copy kit shows it');
        });
    }

    it('no register is given another\'s asks: not one line is shared between two pools', () => {
        const seen = new Map<string, string>();
        for (const key of KIT_KEYS) {
            for (const ask of ASK_POOL[key]) {
                assert.equal(seen.get(ask), undefined, `${key} repeats ${seen.get(ask)}'s ask: ${ask}`);
                seen.set(ask, key);
            }
        }
    });

    it('the MSA and Egyptian pools say none of the Gulf tokens (تبي ودك الحين …), and neither dialect says the other\'s', () => {
        for (const key of ['msa', 'egyptian'] as const) {
            assertNoGulfInEgyptianOrMsa([...ASK_POOL[key], KITS[key].studio.forwardExample].join('\n'), `the ${key} pool`);
        }
        // Levantine shares «ما قدرنا» with the Gulf (not in these asks), so the whole token list applies as substrings here.
        for (const token of GULF_TOKENS) assert.ok(![...ASK_POOL.levantine].some((a) => a.includes(token)), `the Levantine pool says ${token}`);
        assert.doesNotMatch(ASK_POOL.levantine.join('\n'), /عايز|هيوصلك|هتجيلك|الكومنتات/, 'no Egyptian in the Levantine pool');
        assert.doesNotMatch(ASK_POOL.egyptian.join('\n'), /بدّك|عالخاص|بالتعليقات|ببعتلك/, 'no Levantine in the Egyptian pool');
        assert.doesNotMatch(ASK_POOL.msa.join('\n'), /عايز|بدّك|اللينك|الكومنتات|أبعتلك/, 'MSA is MSA');
    });
});

// ─── The kits ────────────────────────────────────────────────────────────────────────────────

describe('the kits a profile selects', () => {
    it('the owner\'s (the legacy assumptions: Gulf Arabic, the tech field, an educator) hold the entries that were hard-coded', () => {
        const pick = pickKit(legacyContext('clip_pick'));
        const copy = copyKit(legacyContext('clip_copy'));
        assert.equal(pick.lang, 'ar');
        assert.equal(pick.language, REEL_LANGUAGE_KITS.ar);
        assert.equal(pick.domain, PICK_DOMAIN_KITS.tech);
        assert.equal(copy.key, 'gulf');
        assert.equal(copy.register, REEL_REGISTER_KITS.gulf);
        assert.equal(copy.language, REEL_LANGUAGE_KITS.ar);
        assert.equal(copy.domain, COPY_DOMAIN_KITS.tech.ar);
        assert.deepEqual(copy.learnTags, LANGUAGES.ar.learnTags, 'an educator\'s TikTok captions carry the learning-programme tags');
    });

    it('the register picks the pool and the example: each of the four Arabic registers has its own', () => {
        for (const register of REGISTERS) {
            const kit = copyKit(contextFor(withRegister(SHOP_EG, register), 'clip_copy', null));
            assert.equal(kit.key, register);
            assert.equal(kit.register, REEL_REGISTER_KITS[register]);
            assert.equal(kit.register.asks, ASK_POOL[register], 'the pool the clip copy falls back to');
            assert.equal(kit.lang, 'ar');
        }
    });

    it('English is English whatever register is kept with it, and Arabic with no register is the neutral Arabic', () => {
        for (const register of [null, ...REGISTERS] as const) {
            const en = copyKit(contextFor({ ...FITNESS_EN, language: { ...FITNESS_EN.language, register } }, 'clip_copy', null));
            assert.equal(en.key, 'en', String(register));
            assert.equal(en.lang, 'en');
        }
        const none = copyKit(contextFor({ ...SHOP_EG, language: { ...SHOP_EG.language, register: null } }, 'clip_copy', null));
        assert.equal(none.key, 'msa');
    });

    it('the reels surface decides, not the profile\'s other surfaces: a DM in Gulf does not make the reels Gulf, a reels override does', () => {
        const dm = { ...SHOP_EG, language: { ...SHOP_EG.language, surfaces: { dm: { register: 'gulf' as const } } } };
        assert.equal(copyKit(contextFor(dm, 'clip_copy', null)).key, 'egyptian');
        const reels = { ...SHOP_EG, language: { ...SHOP_EG.language, surfaces: { reels: { register: 'levantine' as const } } } };
        assert.equal(copyKit(contextFor(reels, 'clip_copy', null)).key, 'levantine');
        assert.equal(pickKit(contextFor({ ...SHOP_EG, language: { ...SHOP_EG.language, surfaces: { reels: { language: 'en' as const } } } }, 'clip_pick', null)).lang, 'en');
    });

    it('the pick and the copy are cut from the same surface: one creator, one voice, from the pick to the Marketer', () => {
        for (const p of [FITNESS_EN, SHOP_EG, SHOP_LEVANTINE, SHOP_MSA, FITNESS_TECH]) {
            const { pick, copy } = kitsOf(p);
            assert.equal(pick.lang, copy.lang);
            assert.equal(pick.language, copy.language);
        }
    });

    it('a field this release does not know is the general one: never the tech one', () => {
        const unknown = withDomain(SHOP_EG, 'legal' as never);
        assert.equal(copyKit(contextFor(unknown, 'clip_copy', null)).domain, COPY_DOMAIN_KITS.general.ar);
        assert.equal(pickKit(contextFor(unknown, 'clip_pick', null)).domain, PICK_DOMAIN_KITS.general);
    });

    it('the learning-programme tags are for an educator and a coach (the Studio\'s own rule, LEARNING_KINDS), and for no other kind (nor for a profile that has not said)', () => {
        for (const kind of [...KINDS, null] as const) {
            const wants = kind !== null && LEARNING_KINDS.includes(kind);
            assert.deepEqual(copyKit(contextFor(withKind(SHOP_EG, kind), 'clip_copy', null)).learnTags, wants ? LANGUAGES.ar.learnTags : [], String(kind));
        }
        assert.deepEqual([...LEARNING_KINDS], ['educator', 'coach']);
        assert.deepEqual(copyKit(contextFor(withKind(FITNESS_EN, 'educator'), 'clip_copy', null)).learnTags, LANGUAGES.en.learnTags, 'in the language of the reel');
    });

    it('the register\'s own words are P9\'s, read and not copied: the forward example, the DM\'s fallback question, and a course\'s pitch', () => {
        for (const register of REGISTERS) {
            const kit = copyKit(contextFor({ ...withRegister(SHOP_EG, register), offers: [offer({ id: 'c', kind: 'course', name: 'N', primary: true })] }, 'clip_copy', null));
            assert.equal(kit.forward, KITS[register].studio.forwardExample, register);
            assert.equal(kit.fallbackQuestion, KITS[register].studio.fallbackQuestion, register);
            assert.equal(kit.fallbackPitch, KITS[register].studio.coursePitch, register);
        }
        const en = copyKit(contextFor(withKind(FITNESS_EN, 'educator'), 'clip_copy', null));
        assert.equal(en.forward, KITS.en.studio.forwardExample);
        assert.equal(en.fallbackQuestion, KITS.en.studio.fallbackQuestion);
    });

    it('only a course has a fallback pitch: every other kind of offer, a mix of kinds and no offer at all have none', () => {
        const withOffers = (offers: CreatorProfile['offers']): CreatorProfile => ({ ...SHOP_EG, offers });
        for (const kind of ['product', 'service', 'program', 'coaching', 'community', 'event', 'other'] as const satisfies readonly OfferKind[]) {
            const kit = copyKit(contextFor(withOffers([offer({ id: 'o', kind, name: 'N', primary: true })]), 'clip_copy', null));
            assert.equal(kit.fallbackPitch, '', kind);
            assert.equal(kit.fallbackPitch, fallbackPitch(KITS.egyptian, kind), 'P9\'s rule');
        }
        const mixed = withOffers([offer({ id: 'a', kind: 'course', name: 'A', primary: true }), offer({ id: 'b', kind: 'product', name: 'B' })]);
        assert.equal(copyKit(contextFor(mixed, 'clip_copy', null)).fallbackPitch, '');
        assert.equal(copyKit(contextFor(withOffers([]), 'clip_copy', null)).fallbackPitch, '');
    });
});

describe('the pick prompt', () => {
    const text = (p: CreatorProfile): string => builtFor(p)['pick-system']!;

    it('shows an Arabic reel the Arabic fillers and an English reel the English ones', () => {
        for (const p of [SHOP_EG, SHOP_LEVANTINE, SHOP_MSA]) {
            assert.match(text(p), /\(هنا جينا، خلينا نفتح، كما نرى\)/);
            assert.match(text(p), /\(مثلا، يعني، فـ، برضو، أو، ممكن، طيب، ما\)/);
            assert.match(text(p), /no «زي ما قلت \/ وبعدين \/ فـ»/);
            assert.match(text(p), /title: at most 6 words in Arabic/);
        }
        const en = text(FITNESS_EN);
        assert.match(en, /An opening that only narrates the screen \(here we go, as you can see\) is hook 0/);
        assert.match(en, /first words are a filler or a connector \(so, like, basically\) is not a 3/);
        assert.match(en, /no greeting, no intro, no «as I said \/ and then \/ so»\)/);
        assert.match(en, /title: at most 6 words in English/);
        assertNoArabicScript(en, 'the English pick prompt');
        assertNoArabicScript(builtFor(FITNESS_EN)['pick-user']!, 'the English pick turn');
    });

    it('asks for "Tech terms in Latin script", and calls a tool worth sending to a colleague, in the tech field and nowhere else', () => {
        for (const p of [FITNESS_TECH, SHOP_TECH, OWNER_PROFILE]) {
            assert.match(text(p), /Not the first spoken sentence\. Tech terms in Latin script, no hype words\./, p.identity.role);
            assert.match(text(p), /- send: worth sending to a colleague: a tool, a prompt, a step, a number or a surprise\. Motivation alone is 0\./);
        }
        for (const p of [FITNESS_EN, SHOP_EG, SHOP_LEVANTINE, SHOP_MSA]) {
            assert.doesNotMatch(text(p), /Tech terms|Latin script|colleague|a tool, a prompt/, p.identity.role);
            assert.match(text(p), /Not the first spoken sentence\. No hype words\./);
            assert.match(text(p), /- send: worth sending to a friend: a tip, a step, a number or a surprise\. Motivation alone is 0\./);
        }
    });

    it('labels the transcript with the language the title is written in', () => {
        assert.match(builtFor(FITNESS_EN)['pick-user']!, /^Transcript \(English\):$/m);
        assert.match(builtFor(SHOP_EG)['pick-user']!, /^Transcript \(Arabic\):$/m);
    });

    it('keeps the creator\'s own never-mention list, which the view carries', () => {
        assert.match(builtFor(FITNESS_EN)['pick-user']!, /^Never pick a moment about: steroids\.$/m);
    });
});

describe('the copy prompt', () => {
    const text = (p: CreatorProfile): string => builtFor(p)['copy-system']!;

    it('tells each register its own "who to send it to" example', () => {
        assert.match(text(SHOP_EG), /who to send it to \(«ابعتها لصاحبك اللي …»\)/);
        assert.match(text(SHOP_LEVANTINE), /who to send it to \(«ابعتها لرفيقك اللي …»\)/);
        assert.match(text(SHOP_MSA), /who to send it to \(«أرسلها لصديقك الذي …»\)/);
        assert.match(text(FITNESS_EN), /who to send it to \("Send this to the friend who …"\)/);
    });

    it('describes the hashtags of the tech field with its tools, and of any other field with no tool, no AI and no programming tag', () => {
        assert.equal(hashtagsLine(text(OWNER_PROFILE)), '- hashtags: 3-5 tags without # naming this clip\'s topic: the tool it shows (Gemini, ChatGPT) and the subject (الذكاء_الاصطناعي), mostly Arabic. Never generic tags (#تقنية #تعلم #برمجة) nor #اكسبلور #explore #fyp #foryou.');
        assert.equal(hashtagsLine(text(FITNESS_TECH)), '- hashtags: 3-5 tags without # naming this clip\'s topic: the tool it shows (Gemini, ChatGPT) and the subject. Never generic tags (#tech #learning) nor #explore #fyp #foryou.');
        for (const p of [FITNESS_EN, SHOP_EG, SHOP_LEVANTINE, SHOP_MSA]) {
            assert.doesNotMatch(text(p), TECH_TAGS, `${p.identity.role}: no tech or AI hashtag anywhere in the prompt`);
        }
        assert.equal(hashtagsLine(text(FITNESS_EN)), GENERAL_FIELD.en.hashtags);
        for (const p of [SHOP_EG, SHOP_LEVANTINE, SHOP_MSA]) assert.equal(hashtagsLine(text(p)), GENERAL_FIELD.ar.hashtags);
    });

    it('shows the examples of a keyword that belong to the field: the owner\'s own for tech, plain words for any other', () => {
        assert.match(text(OWNER_PROFILE), /tied to what the DM sends, like سياق، محلي، سيرة\./);
        assert.match(text(FITNESS_TECH), /tied to what the DM sends, like context, local, resume\./);
        assert.match(text(FITNESS_EN), new RegExp(`like ${GENERAL_FIELD.en.keywords}\\.`));
        assert.match(text(SHOP_EG), new RegExp(`like ${GENERAL_FIELD.ar.keywords}\\.`));
        for (const word of ['سياق', 'محلي', 'سيرة', 'context', 'resume']) {
            for (const p of [FITNESS_EN, SHOP_EG]) assert.ok(!text(p).includes(word), `${p.identity.role}: ${word}`);
        }
    });

    it('opens an alt text the way its language does, and names no MSA to an English model', () => {
        assert.match(text(FITNESS_EN), /- alt_text: at most 2 sentences: "A speaker explains …" plus/);
        for (const p of [SHOP_EG, SHOP_LEVANTINE, SHOP_MSA]) assert.match(text(p), /- alt_text: neutral MSA, at most 2 sentences: «متحدث يشرح …» plus/);
    });

    it('writes in the tenant\'s language, with the digits its profile asks for, and names its own brand and offer', () => {
        assert.match(text(FITNESS_EN), /^You write the post copy for short vertical reels by «Sami Fit», whose product is «Twelve-week plan»\. Answer with JSON only, in English\. Use Latin digits\.$/m);
        assert.match(text(SHOP_EG), /^You write the post copy for short vertical reels by «Nour Shop», whose product is «شمعة لافندر»\. Answer with JSON only, in Arabic\. Use Latin digits\.$/m);
        assert.match(builtFor(FITNESS_EN)['copy-user']!, /^Never mention: steroids\.$/m, 'its own never-mention list');
    });
});

// ─── The second tenants ──────────────────────────────────────────────────────────────────────

describe('the second tenants: nothing of the owner\'s reaches them', () => {
    const TENANTS: readonly [string, CreatorProfile][] = [
        ['FITNESS_EN', FITNESS_EN], ['SHOP_EG', SHOP_EG], ['the Levantine shop', SHOP_LEVANTINE], ['the MSA shop', SHOP_MSA],
    ];

    for (const [name, profile] of TENANTS) {
        it(`${name}: no owner marker in the pick, the copy, or the clip they write`, () => {
            for (const [builder, text] of Object.entries(builtFor(profile))) assertNoOwnerMarkers(text, `${name} · ${builder}`);
        });
    }

    it('FITNESS_EN: not one Arabic letter, in any prompt or in the clip', () => {
        for (const [builder, text] of Object.entries(builtFor(FITNESS_EN))) assertNoArabicScript(text, `FITNESS_EN · ${builder}`);
    });

    it('SHOP_EG and the MSA shop: none of the Gulf tokens, as a word, in any prompt or in the clip', () => {
        for (const [name, profile] of [['SHOP_EG', SHOP_EG], ['the MSA shop', SHOP_MSA]] as const) {
            for (const [builder, text] of Object.entries(builtFor(profile))) assertNoGulfInEgyptianOrMsa(text, `${name} · ${builder}`);
        }
    });

    it('the Levantine shop: none of the Gulf words either (its «ما قدرنا» is Levantine too, and is not in these lines)', () => {
        for (const [builder, text] of Object.entries(builtFor(SHOP_LEVANTINE))) {
            for (const token of GULF_TOKENS) assert.ok(!text.includes(token), `${builder} says ${token}`);
        }
    });

    it('no shop\'s TikTok caption carries #LearnOnTikTok, and an educator\'s still does', () => {
        for (const [name, profile] of [['SHOP_EG', SHOP_EG], ['the Levantine shop', SHOP_LEVANTINE], ['the MSA shop', SHOP_MSA]] as const) {
            const copy = (JSON.parse(builtFor(profile)['clip-copy']!) as { copy: { tiktok_caption: string; caption: string } }).copy;
            assert.doesNotMatch(copy.tiktok_caption, /LearnOnTikTok|تعلم_على_تيك_توك/, name);
            assert.doesNotMatch(copy.caption, /LearnOnTikTok/, name);
            assert.match(copy.tiktok_caption, /رابطه في البايو/, 'and its own TikTok line stays');
            assert.match(copy.tiktok_caption, /#شمعة/, 'and its own hashtags');
        }
        const educator = withKind(SHOP_EG, 'educator');
        const caption = (JSON.parse(builtFor(educator)['clip-copy']!) as { copy: { tiktok_caption: string } }).copy.tiktok_caption;
        assert.match(caption, /#تعلم_على_تيك_توك #LearnOnTikTok$/, 'an educator keeps what the Studio\'s normaliser adds');
    });

    it('each register\'s own pool is the one the clip copy falls back to, ask after ask, never another\'s', () => {
        const cases: readonly [CreatorProfile, keyof typeof ASK_POOL][] = [
            [FITNESS_EN, 'en'], [SHOP_EG, 'egyptian'], [SHOP_LEVANTINE, 'levantine'], [SHOP_MSA, 'msa'], [OWNER_PROFILE, 'gulf'],
        ];
        for (const [profile, key] of cases) {
            const story = STORIES[profile.language.primary];
            const kits = kitsOf(profile);
            const settings = settingsFor(profile);
            const seen: string[] = [];
            for (let turn = 0; turn < 5; turn++) {
                const used: string[] = [];
                const out = toClipCopy(story.item, clip(story.title), settings, { kit: kits.copy, activeKeywords: [], recentAsks: [] }, [], used, turn);
                assert.ok('copy' in out, `${key}: ${'error' in out ? out.error : ''}`);
                assert.equal(out.ask, ASK_POOL[key][turn], `${key}, turn ${turn}: the pool's ask`);
                assert.ok(out.copy.caption.includes(ASK_POOL[key][turn]!.split('{keyword}').join(out.copy.keyword)), `${key}: the caption carries it`);
                seen.push(out.ask);
            }
            assert.deepEqual(seen, [...ASK_POOL[key]], `${key}: all five, in order`);
            for (const other of KIT_KEYS.filter((k) => k !== key)) {
                assert.ok(!seen.some((a) => ASK_POOL[other].includes(a)), `${key} was asked ${other}'s line`);
            }
        }
    });

    it('skips an ask the tenant used recently, within its own pool, and prefers the model\'s own ask when it has a keyword', () => {
        const kits = kitsOf(SHOP_EG);
        const settings = settingsFor(SHOP_EG);
        const story = STORIES.ar;
        const ctx = (recentAsks: string[]): CopyContext => ({ kit: kits.copy, activeKeywords: [], recentAsks });
        const recent = toClipCopy(story.item, clip(story.title), settings, ctx([ASK_POOL.egyptian[0]!]), [], [], 0);
        assert.ok('copy' in recent);
        assert.equal(recent.ask, ASK_POOL.egyptian[1], 'the first is recent: the next one');
        const own = toClipCopy({ ...story.item, ask_line: 'عايز تجرّبها؟ اكتب «{keyword}» 👇' }, clip(story.title), settings, ctx([]), [], [], 0);
        assert.ok('copy' in own);
        assert.equal(own.ask, 'عايز تجرّبها؟ اكتب «{keyword}» 👇');
    });

    it('the DM a clip falls back to speaks the register, and a shop never says «في الكورس»', () => {
        const dmOf = (p: CreatorProfile): string => (JSON.parse(builtFor(p)['clip-copy-fallbacks']!) as { copy: { dm: string } }).copy.dm;
        assert.match(dmOf(SHOP_EG), new RegExp(KITS.egyptian.studio.fallbackQuestion));
        assert.match(dmOf(SHOP_LEVANTINE), new RegExp(KITS.levantine.studio.fallbackQuestion));
        assert.match(dmOf(SHOP_MSA), new RegExp(KITS.msa.studio.fallbackQuestion));
        assert.match(dmOf(FITNESS_EN), new RegExp(KITS.en.studio.fallbackQuestion.replace('?', '\\?')));
        for (const p of [SHOP_EG, SHOP_LEVANTINE, SHOP_MSA, FITNESS_EN]) {
            for (const kit of Object.values(KITS)) assert.ok(!dmOf(p).includes(kit.studio.coursePitch), `${p.identity.role}: no course pitch`);
            assert.doesNotMatch(dmOf(p), /الكورس|الدورة|\bcourse\b/i, `${p.identity.role} sells no course`);
            assert.ok(!/\n\n\n/.test(dmOf(p)), 'the pitch line is dropped, not left empty');
        }
    });

    it('a course keeps its pitch, in its own register\'s words: the owner\'s Gulf line, byte for byte', () => {
        const dm = (p: CreatorProfile): string => (JSON.parse(builtFor(p)['clip-copy-fallbacks']!) as { copy: { dm: string } }).copy.dm;
        assert.ok(dm(OWNER_PROFILE).includes('شرحتها خطوة بخطوة في الكورس، مع التطبيق العملي.'));
        assert.ok(dm(OWNER_PROFILE).includes('تبي تطبّقها بنفسك خطوة بخطوة؟ 👀'));
        for (const register of ['msa', 'egyptian', 'levantine'] as const) {
            const course = { ...withRegister(SHOP_EG, register), offers: [offer({ id: 'c', kind: 'course' as const, name: 'دورة', primary: true })] };
            assert.ok(dm(course).includes(KITS[register].studio.coursePitch), register);
        }
    });

    it('SHOP_TECH and FITNESS_TECH: the tech field still gets its tools, so the general text above is a choice and not an absence', () => {
        for (const p of [FITNESS_TECH, SHOP_TECH]) {
            assert.match(builtFor(p)['copy-system']!, /\(Gemini, ChatGPT\)/);
            assert.match(builtFor(p)['pick-system']!, /Tech terms in Latin script/);
        }
    });
});

// ─── Reading the kits for a source ───────────────────────────────────────────────────────────

describe('reelKitsFor', () => {
    type Read = NonNullable<Parameters<typeof reelKitsFor>[1]>;
    const reading = (fn: (creatorId: string, purpose: 'clip_pick' | 'clip_copy') => unknown): Read => (async (id: string, purpose: 'clip_pick' | 'clip_copy') => fn(id, purpose)) as never;

    it('asks for the pick\'s context and then the copy\'s, once each, and cuts the kits from them', async () => {
        const purposes: string[] = [];
        const kits = await reelKitsFor('t', reading((_, purpose) => {
            purposes.push(purpose);
            return contextFor(SHOP_LEVANTINE, purpose, 4);
        }));
        assert.deepEqual(purposes, ['clip_pick', 'clip_copy']);
        assert.equal(kits.copy.key, 'levantine');
        assert.equal(kits.pick.domain, PICK_DOMAIN_KITS.general);
    });

    it('does not swallow a read that failed: what the reader throws is what the sweep gets', async () => {
        const boom = new ProfileUnreadableError('t', 'clip_pick', new Error('connection refused'));
        await assert.rejects(reelKitsFor('t', reading(() => { throw boom; })), (err: unknown) => err === boom);
    });

    describe('with a profile that cannot be read (the real profileContextOrLegacy)', () => {
        const unreadable = async <T>(owner: string, body: () => Promise<T>): Promise<T> => {
            const db = installProfileDb(emptyState());
            db.failOn = /FROM creator_profiles/;
            db.failWith = new Error('connection refused');
            setPlatformOwner(db, owner);
            const sink = setLogSink(() => {});
            try { return await body(); } finally { setLogSink(sink); db.restore(); }
        };

        it('the owner gets his own kits: Gulf asks and the tech field, as before the profile existed', async () => {
            const kits = await unreadable(OWNER, () => reelKitsFor(OWNER));
            assert.deepEqual(kits, reelKitsFromContexts(legacyContext('clip_pick'), legacyContext('clip_copy')));
            assert.equal(kits.copy.key, 'gulf');
            assert.equal(kits.copy.domain, COPY_DOMAIN_KITS.tech.ar);
            assert.equal(kits.pick.domain, PICK_DOMAIN_KITS.tech);
        });

        it('anyone else gets a ProfileUnreadableError, and the owner\'s kits are never what they are handed instead', async () => {
            await unreadable(OWNER, async () => {
                await assert.rejects(reelKitsFor(OTHER), (err: unknown) => err instanceof ProfileUnreadableError && err.creatorId === OTHER && err.purpose === 'clip_pick');
            });
        });
    });

    it('is the same kits as the pure route: a stored profile read through the context gives what contextFor gives', () => {
        for (const p of [FITNESS_EN, SHOP_EG, SHOP_LEVANTINE, SHOP_MSA, FITNESS_TECH]) {
            const pure = kitsOf(p);
            const pick: PickKit = pickKit(contextFor(p, 'clip_pick', 9) as ProfileContext<'clip_pick'>);
            const copy: CopyKit = copyKit(contextFor(p, 'clip_copy', 9) as ProfileContext<'clip_copy'>);
            assert.deepEqual({ pick, copy }, pure, 'the version a context was cut at does not change what it says');
        }
    });
});

describe('the kits are frozen', () => {
    it('a builder that edits a kit throws instead of changing it for every tenant after it', () => {
        assert.throws(() => { (REEL_REGISTER_KITS.gulf.asks as string[]).push('x'); }, TypeError);
        assert.throws(() => { (REEL_REGISTER_KITS as Record<string, unknown>).gulf = null; }, TypeError);
        assert.throws(() => { (PICK_DOMAIN_KITS.tech as { send: string }).send = 'x'; }, TypeError);
        assert.throws(() => { (COPY_DOMAIN_KITS.tech.ar as { genericTags: string }).genericTags = 'x'; }, TypeError);
        assert.throws(() => { (ASK_POOL as Record<string, unknown>).gulf = []; }, TypeError);
    });
});
