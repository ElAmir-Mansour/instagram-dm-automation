/**
 * P8, the second tenants (docs/onboarding/05 §3): the DM bot and the comment replies, written for creators who are nothing
 * like the owner. The owner's bytes are pinned by the goldens (`golden.test.ts`); this is the other half of the promise:
 * none of his strings reaches anyone else.
 *
 * Every builder P8 changed is run for each tenant: `dmSystemInstruction`, `dmResponseSchema`, `disclosureLine`,
 * `starterPersona` and `dmFallbackReply` (all five variants of it). Then:
 *
 *   - `assertNoOwnerMarkers` on every output, with 05 §3's list («بالعربي» as a whole word, so the neutral Arabic rule
 *     «بالعربية الفصحى» passes on its own);
 *   - FITNESS_EN: no Arabic script at all, in anything;
 *   - SHOP_EG and the neutral MSA profile: none of the Gulf tokens as a word, bare or with a «و» «ف» «ب» prefix;
 *   - positive checks: each tenant speaks its own language and register, and calls its own offer by its own noun.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dmResponseSchema, dmSystemInstruction, starterPersona, type DmContext } from '../ai.js';
import { dmFallbackReply } from '../../webhook/errors.js';
import { disclosureLine } from '../../webhook/meta-payload.js';
import { contextFor, type ProfileContext } from './context.js';
import { ELAMIR_AGENT, ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { defaultProfile } from './defaults.js';
import { FITNESS_EN, FITNESS_EN_PROGRAM, offer, SHOP_EG, SHOP_EG_SERVICE } from './fixtures.js';
import { profileFromLegacy } from './legacy.js';
import {
    assertNoArabicScript, assertNoGulfInEgyptianOrMsa, assertNoOwnerMarkers, GULF_TOKENS, OWNER_MARKERS,
} from './testSupport.js';
import { OFFER_KINDS, type CreatorProfile } from './types.js';

/** A tenant's DM (the campaign template it was sent) and its knowledge base, in its own language. */
interface Voice { kb: string; link: string; noLink: string }

const ENGLISH: Voice = {
    kb: 'Programs:\n1. Twelve-week plan: a workout for every day, link in the DM.',
    link: 'Hi {username} 👋 Here is the plan: https://samifit.example/plan.',
    noLink: 'Hi {username} 👋 Reply to this message for the details',
};
const EGYPTIAN: Voice = {
    kb: 'المنتجات:\n1. شمعة لافندر: شمعة يدوية بريحة هادية.',
    link: 'أهلا {username} 👋 اللينك هنا: https://nour.example/candle،',
    noLink: 'أهلا {username} 👋 ابعتلنا وهنبعتلك التفاصيل',
};
const NEUTRAL_ARABIC: Voice = {
    kb: 'العروض:\n1. عرض تجريبي.',
    link: 'مرحبا {username} 👋 هذا هو الرابط: https://example.com/offer.',
    noLink: 'مرحبا {username} 👋 راسلنا لنرسل لك التفاصيل',
};

/** Everything P8 writes for a tenant, by builder. The fallback is built for each of its five variants. */
function builtFor(profile: CreatorProfile, voice: Voice): Record<string, string> {
    const dm = contextFor(profile, 'dm', 1);
    const comments = contextFor(profile, 'comment_reply', 1);
    const register = comments.language.register;
    return {
        'dm.system-instruction': dmSystemInstruction(starterPersona(dm.language.code), voice.kb, dm),
        'dm.response-schema': JSON.stringify(dmResponseSchema(dm), null, 2),
        'dm.disclosure-line': disclosureLine(dm.language.code),
        'dm.starter-persona': starterPersona(dm.language.code),
        'comments.instagram': dmFallbackReply({ dmText: voice.link, isFacebook: false, register }),
        'comments.facebook-link': dmFallbackReply({ dmText: voice.link, isFacebook: true, register }),
        'comments.facebook-no-link': dmFallbackReply({ dmText: voice.noLink, isFacebook: true, register }),
        'comments.instagram-no-link': dmFallbackReply({ dmText: voice.noLink, isFacebook: false, register }),
        'comments.facebook-no-link-in-the-other-language': dmFallbackReply({ dmText: 'Reply here for the details', isFacebook: true, register }),
    };
}

const NEUTRAL_AR = defaultProfile({ lang: 'ar' });
const NEUTRAL_EN = defaultProfile({ lang: 'en' });

const each = (built: Record<string, string>, check: (text: string, label: string) => void): void => {
    for (const [name, text] of Object.entries(built)) check(text, name);
};

describe('the checks themselves', () => {
    it('assertNoOwnerMarkers fails on every marker 05 §3 lists, alone and inside a sentence', () => {
        assert.equal(OWNER_MARKERS.length, 27);
        for (const marker of OWNER_MARKERS) {
            assert.throws(() => assertNoOwnerMarkers(marker), new RegExp(`owner's marker`), marker);
            assert.throws(() => assertNoOwnerMarkers(`a sentence with ${marker} in the middle of it`), /owner's marker/, marker);
        }
    });

    it('passes text with none of them, and «بالعربية» (the ordinary word) is not the owner\'s «بالعربي»', () => {
        assertNoOwnerMarkers('Programs, products, services and offers. منتجات وخدمات وعروضًا.');
        assertNoOwnerMarkers('الرد يكون بالعربية الفصحى البسيطة');
    });

    it('«بالعربي» is a whole word: alone, in a sentence, before punctuation or with a «و» it is the owner\'s, as the start of «بالعربية» it is not', () => {
        for (const text of ['بالعربي', 'Agentic AI بالعربي', 'اكتب بالعربي، لو سمحت', 'وبالعربي كمان', 'شرح بالعربي.']) {
            assert.throws(() => assertNoOwnerMarkers(text), /بالعربي/, text);
        }
        for (const text of ['بالعربية', 'بالعربية الفصحى', 'ويكتب بالعربيةً']) assertNoOwnerMarkers(text, text);
    });

    it('assertNoArabicScript fails on one Arabic letter', () => {
        assertNoArabicScript('Nothing here. 🙏 🔗');
        assert.throws(() => assertNoArabicScript('English and ع'), /Arabic script/);
    });

    it('assertNoGulfInEgyptianOrMsa fails on each Gulf token as a word, bare or with a «و» «ف» «ب» prefix, and not on a longer word that holds one', () => {
        for (const token of GULF_TOKENS) {
            for (const text of [token, `قبل ${token} بعد`, `${token}،`, `و${token}`, `ف${token}`, `ب${token}`, `قبل و${token} بعد`]) {
                assert.throws(() => assertNoGulfInEgyptianOrMsa(text), /Egyptian or MSA tenant/, text);
            }
        }
        // The cases the review named.
        for (const text of ['والحين', 'وتبي', 'وودك', 'وما قدرنا', 'بالحين']) assert.throws(() => assertNoGulfInEgyptianOrMsa(text), /Egyptian or MSA tenant/, text);
        assertNoGulfInEgyptianOrMsa('تبيان وتبيين والحينئذ وودكا ومتبي وأتبي', 'longer words that merely contain a token');
    });

    it('the Levantine register is the one the Gulf check is not for: its public reply holds «ما قدرنا»', () => {
        assert.throws(() => assertNoGulfInEgyptianOrMsa(dmFallbackReply({ dmText: 'هلا', isFacebook: false, register: 'levantine' })), /ما قدرنا/);
        for (const register of ['msa', 'egyptian'] as const) assertNoGulfInEgyptianOrMsa(dmFallbackReply({ dmText: 'هلا', isFacebook: false, register }), register);
    });
});

describe('FITNESS_EN: an English fitness coach', () => {
    const built = builtFor(FITNESS_EN, ENGLISH);

    it('every builder is free of the owner\'s markers', () => each(built, (text, label) => assertNoOwnerMarkers(text, label)));

    it('and of Arabic script, all of it', () => each(built, (text, label) => assertNoArabicScript(text, label)));

    it('the DM bot is told English rules, English headings and an English persona: the whole instruction', () => {
        assert.equal(built['dm.system-instruction'], [
            'You are a smart assistant who answers followers\' questions in English.',
            '',
            '=== Knowledge base available to you ===',
            ENGLISH.kb,
            '',
            '=== Additional important instructions ===',
            '1. Your replies must be friendly and interactive, written in simple, natural English.',
            '2. If the user asks for offers or contact details, use the "quick_reply" or "carousel" option to present them in an interactive, organized way instead of just listing text links.',
            '3. Keep strictly to the character limits: button titles and quick-reply titles must not exceed 20 characters. Card titles must not exceed 80 characters.',
        ].join('\n'));
    });

    it('its offers are mixed (a call and a program), so they are "offers", and the button id says OFFER', () => {
        assert.equal(contextFor(FITNESS_EN, 'dm', 1).who.offerKind, 'mixed');
        assert.match(built['dm.system-instruction']!, /asks for offers or contact details/);
        assert.match(built['dm.response-schema']!, /e\.g\., GO_TO_OFFER_1\./);
        assert.doesNotMatch(built['dm.response-schema']!, /COURSE/);
    });

    it('the schema asks for English, the disclosure and the starter persona are English', () => {
        assert.match(built['dm.response-schema']!, /Must be written in English if appropriate\./);
        assert.equal(built['dm.disclosure-line'], '🤖 Automated reply from the AI assistant');
        assert.equal(built['dm.starter-persona'], 'You are a smart assistant who answers followers\' questions in English.');
    });

    it('the public replies are English, in all five variants', () => {
        assert.equal(built['comments.instagram'], 'We couldn\'t message you privately 🙏 The link is in our bio 🔗');
        assert.equal(built['comments.facebook-link'], 'We couldn\'t message you privately 🙏 Here\'s the link: https://samifit.example/plan');
        assert.equal(built['comments.facebook-no-link'], 'We couldn\'t message you privately 🙏 Send us a message and we\'ll share the details.');
        assert.equal(built['comments.instagram-no-link'], 'We couldn\'t message you privately 🙏 The link is in our bio 🔗');
        assert.equal(built['comments.facebook-no-link-in-the-other-language'], built['comments.facebook-no-link']);
    });

    it('a program-only coach says "programs"', () => {
        const program = builtFor(FITNESS_EN_PROGRAM, ENGLISH);
        assert.match(program['dm.system-instruction']!, /If the user asks for programs or contact details/);
        each(program, (text, label) => assertNoOwnerMarkers(text, label));
        each(program, (text, label) => assertNoArabicScript(text, label));
    });
});

describe('SHOP_EG: an Egyptian-Arabic shop', () => {
    const built = builtFor(SHOP_EG, EGYPTIAN);

    it('every builder is free of the owner\'s markers', () => each(built, (text, label) => assertNoOwnerMarkers(text, label)));

    it('and of the Gulf tokens as whole words', () => each(built, (text, label) => assertNoGulfInEgyptianOrMsa(text, label)));

    it('the DM bot is asked for simple Egyptian, and told to call the offers «منتجات»: the whole instruction', () => {
        assert.equal(built['dm.system-instruction'], [
            'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.',
            '',
            '=== قاعدة المعرفة المتاحة لديك (Knowledge Base) ===',
            EGYPTIAN.kb,
            '',
            '=== تعليمات إضافية مهمة ===',
            '1. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة المصرية البسيطة.',
            '2. إذا طلب المستخدم منتجات أو معلومات تواصل، استخدم خيار "quick_reply" أو "carousel" لتقديمها بشكل تفاعلي ومنظم بدلاً من مجرد سرد روابط نصية.',
            '3. التزم تماماً بحدود الحروف: عناوين الأزرار والـ quick replies لا تتجاوز 20 حرفاً. عناوين الكروت لا تتجاوز 80 حرفاً.',
        ].join('\n'));
    });

    it('the schema asks for Arabic with a button id of OFFER, and the disclosure is the Arabic line', () => {
        assert.match(built['dm.response-schema']!, /Must be written in Arabic if appropriate\./);
        assert.match(built['dm.response-schema']!, /e\.g\., GO_TO_OFFER_1\./);
        assert.equal(built['dm.disclosure-line'], '🤖 رد آلي من المساعد الذكي');
    });

    it('the public replies to an Arabic DM are the Egyptian lines, and to an English one the English line', () => {
        assert.equal(built['comments.instagram'], 'معرفناش نبعتلك على الخاص 🙏 اللينك في البايو 🔗');
        assert.equal(built['comments.facebook-link'], 'معرفناش نبعتلك على الخاص 🙏 ده اللينك: https://nour.example/candle');
        assert.equal(built['comments.facebook-no-link'], 'معرفناش نبعتلك على الخاص 🙏 ابعتلنا وهنبعتلك التفاصيل');
        assert.equal(built['comments.instagram-no-link'], 'معرفناش نبعتلك على الخاص 🙏 اللينك في البايو 🔗');
        assert.equal(built['comments.facebook-no-link-in-the-other-language'], 'We couldn\'t message you privately 🙏 Send us a message and we\'ll share the details.');
    });

    it('a service-only shop says «خدمات»', () => {
        const service = builtFor(SHOP_EG_SERVICE, EGYPTIAN);
        assert.match(service['dm.system-instruction']!, /إذا طلب المستخدم خدمات أو معلومات تواصل/);
        each(service, (text, label) => assertNoOwnerMarkers(text, label));
        each(service, (text, label) => assertNoGulfInEgyptianOrMsa(text, label));
    });

    it('a surface of its own: a DM surface in Levantine changes the DM rule and not the public reply, which is the comments surface\'s', () => {
        const split = structuredClone(SHOP_EG);
        split.language.surfaces = { dm: { register: 'levantine' } };
        const built = builtFor(split, EGYPTIAN);
        assert.match(built['dm.system-instruction']!, /باللهجة الشامية البسيطة/);
        assert.equal(built['comments.instagram'], 'معرفناش نبعتلك على الخاص 🙏 اللينك في البايو 🔗');
    });
});

describe('a default profile', () => {
    it('Arabic reads as the neutral MSA: no owner marker, no Gulf, and the rule says فصحى', () => {
        const built = builtFor(NEUTRAL_AR, NEUTRAL_ARABIC);
        // Rule 1 says «بالعربية الفصحى»: the ordinary word, which is not the owner's «بالعربي» (a whole-word marker).
        each(built, (text, label) => assertNoOwnerMarkers(text, label));
        each(built, (text, label) => assertNoGulfInEgyptianOrMsa(text, label));
        assert.match(built['dm.system-instruction']!, /^1\. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة بالعربية الفصحى البسيطة\.$/m);
        assert.match(built['dm.system-instruction']!, /^2\. إذا طلب المستخدم عروضًا أو معلومات تواصل/m, 'no offers: «عروضًا»');
        assert.match(built['dm.response-schema']!, /GO_TO_OFFER_1/);
        assert.equal(built['comments.instagram'], 'لم نتمكن من مراسلتك في الخاص 🙏 الرابط في البايو 🔗');
        assert.equal(built['comments.facebook-link'], 'لم نتمكن من مراسلتك في الخاص 🙏 هذا هو الرابط: https://example.com/offer');
        assert.equal(built['comments.facebook-no-link'], 'لم نتمكن من مراسلتك في الخاص 🙏 راسلنا وسنرسل لك التفاصيل');
    });

    it('English reads as English, with no Arabic and no marker', () => {
        const built = builtFor(NEUTRAL_EN, ENGLISH);
        each(built, (text, label) => assertNoOwnerMarkers(text, label));
        each(built, (text, label) => assertNoArabicScript(text, label));
        assert.match(built['dm.system-instruction']!, /asks for offers or contact details/);
        assert.equal(built['comments.instagram'], 'We couldn\'t message you privately 🙏 The link is in our bio 🔗');
    });
});

describe('the owner\'s own nouns are a course seller\'s, and only theirs', () => {
    const sellsCourses = (profile: CreatorProfile): CreatorProfile => ({ ...profile, offers: [offer({ id: 'c', kind: 'course', name: 'Course', primary: true })] });

    it('a creator of courses is told «كورسات» and GO_TO_COURSE_1, in either language', () => {
        const ar = contextFor(sellsCourses(SHOP_EG), 'dm', 1);
        assert.match(dmSystemInstruction('p', 'k', ar), /إذا طلب المستخدم كورسات أو معلومات تواصل/);
        assert.match(JSON.stringify(dmResponseSchema(ar)), /GO_TO_COURSE_1/);
        const en = contextFor(sellsCourses(FITNESS_EN), 'dm', 1);
        assert.match(dmSystemInstruction('p', 'k', en), /If the user asks for courses or contact details/);
        assert.match(JSON.stringify(dmResponseSchema(en)), /GO_TO_COURSE_1/);
    });

    it('no other kind of offer is: each says its own noun and OFFER', () => {
        const nouns = { program: 'برامج', product: 'منتجات', service: 'خدمات', coaching: 'عروضًا', community: 'عروضًا', event: 'عروضًا', other: 'عروضًا' } as const;
        for (const [kind, noun] of Object.entries(nouns)) {
            const ctx: DmContext = contextFor({ ...SHOP_EG, offers: [offer({ id: 'x', kind: kind as never, primary: true })] }, 'dm', 1);
            assert.match(dmSystemInstruction('p', 'k', ctx), new RegExp(`إذا طلب المستخدم ${noun} أو معلومات تواصل`), kind);
            assert.match(JSON.stringify(dmResponseSchema(ctx)), /GO_TO_OFFER_1/, kind);
            assert.doesNotMatch(JSON.stringify(dmResponseSchema(ctx)), /COURSE/, kind);
        }
    });
});

describe('what the DM and comment wording reads from the context', () => {
    it('only the language, the register and the kind of offer: another profile with the same three says the same', () => {
        const same: CreatorProfile = { ...structuredClone(SHOP_EG), identity: { ...SHOP_EG.identity, role: 'something else', niche: 'another niche' }, voice: { ...SHOP_EG.voice, address: 'masc' } };
        assert.deepEqual(builtFor(same, EGYPTIAN), builtFor(SHOP_EG, EGYPTIAN));
    });

    it('is a function of the context alone: a hand-made context says what the profile\'s does', () => {
        const ctx = contextFor(SHOP_EG, 'dm', 1) as ProfileContext<'dm'>;
        const handMade: DmContext = { language: { code: 'ar', register: 'egyptian', digits: 'latin', dir: 'rtl' }, who: { ...ctx.who } };
        assert.equal(dmSystemInstruction('p', 'k', handMade), dmSystemInstruction('p', 'k', ctx));
    });
});

/**
 * A tripwire for P13, which gives the owner his nine offers (`offers[].campaign`): the DM wording reads `who.offerKind`, "the
 * kind every offer shares", and it is `course` for him only while every offer he has is a course. A second offer of another
 * kind makes his offers "mixed", and his rule 2 turns into «عروضًا» and his button id into GO_TO_OFFER_1. That may be what he
 * wants, but it must be seen, not slipped in: this is what changes, and the only thing.
 */
describe('the owner with a second offer: what P13 must not change by accident', () => {
    const owner = profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);
    const withSecond = (kind: (typeof OFFER_KINDS)[number]): CreatorProfile => ({
        ...owner, offers: [...owner.offers, offer({ id: 'second', kind, name: 'A second offer', order_via: 'dm', keyword: 'second' })],
    });
    /** Everything the DM and comment paths say for him. */
    const says = (p: CreatorProfile): Record<string, string> => {
        const dm = contextFor(p, 'dm', 1);
        const register = contextFor(p, 'comment_reply', 1).language.register;
        return {
            instruction: dmSystemInstruction(ELAMIR_AGENT.system_prompt, ELAMIR_AGENT.knowledge_base, dm),
            schema: JSON.stringify(dmResponseSchema(dm), null, 2),
            disclosure: disclosureLine(dm.language.code),
            persona: starterPersona(dm.language.code),
            instagram: dmFallbackReply({ dmText: 'هلا', isFacebook: false, register }),
            facebook: dmFallbackReply({ dmText: 'هلا https://example.com/c', isFacebook: true, register }),
        };
    };

    it('his own offers are courses: rule 2 says «كورسات» and the button is GO_TO_COURSE_1', () => {
        assert.equal(contextFor(owner, 'dm', 1).who.offerKind, 'course');
        const now = says(owner);
        assert.match(now.instruction!, /2\. إذا طلب المستخدم كورسات أو معلومات تواصل/);
        assert.match(now.schema!, /GO_TO_COURSE_1/);
    });

    it('a second course changes nothing', () => {
        assert.deepEqual(says(withSecond('course')), says(owner));
    });

    it('a second offer of any other kind changes exactly two things: the noun in rule 2 and the button id', () => {
        const before = says(owner);
        for (const kind of OFFER_KINDS.filter((k) => k !== 'course')) {
            const after = says(withSecond(kind));
            assert.equal(contextFor(withSecond(kind), 'dm', 1).who.offerKind, 'mixed', kind);
            assert.equal(after.instruction, before.instruction!.replace('إذا طلب المستخدم كورسات', 'إذا طلب المستخدم عروضًا'), `${kind}: rule 2, and nothing else in the instruction`);
            assert.equal(after.schema, before.schema!.replace('GO_TO_COURSE_1', 'GO_TO_OFFER_1'), `${kind}: the button id, and nothing else in the schema`);
            for (const same of ['disclosure', 'persona', 'instagram', 'facebook']) assert.equal(after[same], before[same], `${kind}: ${same} does not move`);
        }
    });
});
