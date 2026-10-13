/**
 * The language and register kits (docs/onboarding/05 §2, P8).
 *
 * Two jobs. One is structural: every register has every line, so a register added to the profile cannot be left speaking
 * another's text, and the Gulf kit is the owner's text word for word (the goldens pin the rest of his output; this pins the
 * kit itself). The other is the review: the non-Gulf Arabic lines are drafts, and `REVIEW` below spells out every one so that a
 * native speaker of each dialect reads this file's table and nothing else. A line changed in `kits.ts` fails here until the
 * table says the same, which is how a reviewer's correction is recorded.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commentFallback, KIT_KEYS, KITS, kitFor, kitForLang, offerNoun, type LanguageKit } from './kits.js';
import { OFFER_KINDS, REGISTERS } from './types.js';

describe('the kits', () => {
    it('are one per Arabic register plus English, in the profile\'s own register names', () => {
        assert.deepEqual([...KIT_KEYS].sort(), [...REGISTERS, 'en'].sort());
        assert.deepEqual(Object.keys(KITS).sort(), [...REGISTERS, 'en'].sort(), 'a register in types.ts has a kit, and a kit has a register');
        for (const key of KIT_KEYS) assert.equal(KITS[key].key, key);
    });

    it('say which language they are: the four registers Arabic, the fifth English', () => {
        for (const key of REGISTERS) assert.equal(KITS[key].lang, 'ar', key);
        assert.equal(KITS.en.lang, 'en');
        for (const key of KIT_KEYS) assert.equal(KITS[key].dm.schemaLanguage, key === 'en' ? 'English' : 'Arabic', key);
    });

    it('have every line, and none is blank', () => {
        for (const key of KIT_KEYS) {
            const kit = KITS[key];
            const lines = [
                kit.dm.knowledgeHeader, kit.dm.rulesHeader, kit.dm.friendly, kit.dm.offers('X'), kit.dm.limits,
                kit.disclosure, kit.starterPersona, ...Object.values(kit.offerNouns),
                kit.commentFallback.lead, kit.commentFallback.bio, kit.commentFallback.link('https://x.test'), kit.commentFallback.none,
            ];
            for (const line of lines) assert.ok(line.trim().length > 0, `${key} has a blank line`);
            assert.ok(kit.dm.offers('NOUN').includes('NOUN'), `${key}: rule 2 says the noun it is given`);
            assert.ok(kit.commentFallback.link('https://x.test/y').endsWith('https://x.test/y'), `${key}: the link comes last`);
        }
    });

    it('the Gulf kit is the owner\'s text, word for word', () => {
        const g = KITS.gulf;
        assert.equal(g.dm.knowledgeHeader, '=== قاعدة المعرفة المتاحة لديك (Knowledge Base) ===');
        assert.equal(g.dm.rulesHeader, '=== تعليمات إضافية مهمة ===');
        assert.equal(g.dm.friendly, 'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللغة العربية الفصحى أو بلهجة سهلة ومناسبة.');
        assert.equal(g.dm.offers('كورسات'), 'إذا طلب المستخدم كورسات أو معلومات تواصل، استخدم خيار "quick_reply" أو "carousel" لتقديمها بشكل تفاعلي ومنظم بدلاً من مجرد سرد روابط نصية.');
        assert.equal(g.dm.limits, 'التزم تماماً بحدود الحروف: عناوين الأزرار والـ quick replies لا تتجاوز 20 حرفاً. عناوين الكروت لا تتجاوز 80 حرفاً.');
        assert.equal(g.disclosure, '🤖 رد آلي من المساعد الذكي');
        assert.equal(g.starterPersona, 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.');
        assert.equal(commentFallback(g, { isFacebook: false, link: undefined }), 'ما قدرنا نرسل لك على الخاص 🙏 الرابط في البايو 🔗');
        assert.equal(commentFallback(g, { isFacebook: true, link: 'https://x.test/y' }), 'ما قدرنا نرسل لك على الخاص 🙏 هذا الرابط: https://x.test/y');
        assert.equal(commentFallback(g, { isFacebook: true, link: undefined }), 'ما قدرنا نرسل لك على الخاص 🙏 راسلنا على الخاص ونرسل لك التفاصيل');
    });

    it('the four Arabic registers share what is an instruction to the model, and differ in what is dialect: rule 1 and the public reply', () => {
        for (const key of ['msa', 'egyptian', 'levantine'] as const) {
            const kit = KITS[key];
            assert.equal(kit.dm.knowledgeHeader, KITS.gulf.dm.knowledgeHeader, key);
            assert.equal(kit.dm.rulesHeader, KITS.gulf.dm.rulesHeader, key);
            assert.equal(kit.dm.limits, KITS.gulf.dm.limits, key);
            assert.equal(kit.dm.offers('N'), KITS.gulf.dm.offers('N'), key);
            assert.deepEqual(kit.offerNouns, KITS.gulf.offerNouns, key);
            assert.equal(kit.disclosure, KITS.gulf.disclosure, key);
            assert.notEqual(kit.dm.friendly, KITS.gulf.dm.friendly, `${key} asks for its own register`);
            assert.notEqual(kit.commentFallback.lead, KITS.gulf.commentFallback.lead, `${key} says its own "we could not message you"`);
        }
    });
});

describe('choosing a kit', () => {
    it('English is English whatever register is kept with it (an English surface can still be asked for one Arabic piece, but its own text is English)', () => {
        for (const register of [null, ...REGISTERS] as const) assert.equal(kitFor({ code: 'en', register }).key, 'en', String(register));
    });

    it('Arabic is the register it names, and MSA when it names none (the neutral Arabic)', () => {
        for (const register of REGISTERS) assert.equal(kitFor({ code: 'ar', register }).key, register);
        assert.equal(kitFor({ code: 'ar', register: null }).key, 'msa');
    });

    it('a kit for a language alone: English, or the neutral Arabic', () => {
        assert.equal(kitForLang('en').key, 'en');
        assert.equal(kitForLang('ar').key, 'msa');
    });
});

describe('what an offer is called (rule 2)', () => {
    const nouns: Record<string, { ar: string; en: string }> = {
        course: { ar: 'كورسات', en: 'courses' },
        program: { ar: 'برامج', en: 'programs' },
        product: { ar: 'منتجات', en: 'products' },
        service: { ar: 'خدمات', en: 'services' },
    };

    it('course, program, product and service have a noun in each language', () => {
        for (const [kind, noun] of Object.entries(nouns)) {
            assert.equal(offerNoun(KITS.gulf, kind as never), noun.ar, kind);
            assert.equal(offerNoun(KITS.egyptian, kind as never), noun.ar, kind);
            assert.equal(offerNoun(KITS.en, kind as never), noun.en, kind);
        }
    });

    it('every other kind, a mix of kinds and no offer at all are "offers"', () => {
        for (const kind of OFFER_KINDS.filter((k) => !(k in nouns))) {
            assert.equal(offerNoun(KITS.msa, kind), 'عروضًا', kind);
            assert.equal(offerNoun(KITS.en, kind), 'offers', kind);
        }
        for (const kind of ['mixed', null] as const) {
            assert.equal(offerNoun(KITS.levantine, kind), 'عروضًا', String(kind));
            assert.equal(offerNoun(KITS.en, kind), 'offers', String(kind));
        }
    });
});

describe('the public reply for an undeliverable DM', () => {
    it('Instagram points to the bio, Facebook carries the link, and with no link asks to be written to', () => {
        const en = KITS.en;
        assert.equal(commentFallback(en, { isFacebook: false, link: 'https://x.test' }), 'We couldn\'t message you privately 🙏 The link is in our bio 🔗', 'a link is no use on Instagram');
        assert.equal(commentFallback(en, { isFacebook: true, link: 'https://x.test/a' }), 'We couldn\'t message you privately 🙏 Here\'s the link: https://x.test/a');
        assert.equal(commentFallback(en, { isFacebook: true, link: undefined }), 'We couldn\'t message you privately 🙏 Send us a message and we\'ll share the details.');
    });
});

// ─── The review table ────────────────────────────────────────────────────────────────────────

/**
 * Every line a native speaker is asked to read (05 §2), as the kit writes it. The Gulf column is the owner's and is not
 * under review; the other three are Opus drafts. `{link}` stands for the campaign's link. All of them address one reader
 * (a man): a `voice.address` of feminine or plural is a follow-up.
 */
const REVIEW: Record<'msa' | 'egyptian' | 'levantine', { friendly: string; bio: string; link: string; none: string }> = {
    msa: {
        friendly: 'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة بالعربية الفصحى البسيطة.',
        bio: 'لم نتمكن من مراسلتك في الخاص 🙏 الرابط في البايو 🔗',
        link: 'لم نتمكن من مراسلتك في الخاص 🙏 هذا هو الرابط: {link}',
        none: 'لم نتمكن من مراسلتك في الخاص 🙏 راسلنا وسنرسل لك التفاصيل',
    },
    egyptian: {
        friendly: 'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة المصرية البسيطة.',
        bio: 'معرفناش نبعتلك على الخاص 🙏 اللينك في البايو 🔗',
        link: 'معرفناش نبعتلك على الخاص 🙏 ده اللينك: {link}',
        none: 'معرفناش نبعتلك على الخاص 🙏 ابعتلنا وهنبعتلك التفاصيل',
    },
    levantine: {
        friendly: 'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة الشامية البسيطة.',
        bio: 'ما قدرنا نبعتلك عالخاص 🙏 الرابط بالبايو 🔗',
        link: 'ما قدرنا نبعتلك عالخاص 🙏 هاد الرابط: {link}',
        none: 'ما قدرنا نبعتلك عالخاص 🙏 راسلنا ومنبعتلك التفاصيل',
    },
};

describe('the non-Gulf Arabic lines, as 05 §2 drafts them (for a native speaker to read)', () => {
    for (const key of ['msa', 'egyptian', 'levantine'] as const) {
        it(`${key}: rule 1 and the three public replies`, () => {
            const kit: LanguageKit = KITS[key];
            const want = REVIEW[key];
            assert.equal(kit.dm.friendly, want.friendly);
            assert.equal(commentFallback(kit, { isFacebook: false, link: undefined }), want.bio);
            assert.equal(commentFallback(kit, { isFacebook: true, link: '{link}' }), want.link);
            assert.equal(commentFallback(kit, { isFacebook: true, link: undefined }), want.none);
        });
    }
});
