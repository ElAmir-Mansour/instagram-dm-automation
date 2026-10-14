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
import { guardReply } from '../dmSales/guard.js';
import { commentFallback, KIT_KEYS, KITS, kitFor, kitForLang, offerNoun, type KitKey, type LanguageKit } from './kits.js';
import { assertNoGulfInEgyptianOrMsa } from './testSupport.js';
import { OFFER_KINDS, PROOF_KINDS, REGISTERS, SALES_LEVELS } from './types.js';

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
                kit.studio.forwardExample, kit.studio.fallbackQuestion, kit.studio.coursePitch, ...kit.studio.timeWords.head, ...kit.studio.timeWords.all,
                kit.importFallback.dm, kit.importFallback.replies, kit.attachments.media, kit.attachments.mention,
            ];
            assert.equal(kit.studio.timeWords.head.length, 5, `${key}: the prompt names five time words`);
            for (const line of lines) assert.ok(line.trim().length > 0, `${key} has a blank line`);
            assert.ok(kit.dm.offers('NOUN').includes('NOUN'), `${key}: rule 2 says the noun it is given`);
            assert.ok(kit.commentFallback.link('https://x.test/y').endsWith('https://x.test/y'), `${key}: the link comes last`);
            for (const placeholder of ['{username}', '{name}', '{url}']) assert.ok(kit.importFallback.dm.includes(placeholder), `${key}: the import's DM holds ${placeholder}`);
            assert.equal(kit.importFallback.replies.split(' | ').length, 2, `${key}: two replies, joined as a campaign stores them`);
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

    it('the Gulf kit is the Studio writer\'s text of today too: the time words, the example, the question and the course pitch (P9)', () => {
        const s = KITS.gulf.studio;
        assert.deepEqual([...s.timeWords.all], [
            'اليوم', 'الليلة', 'الليله', 'الحين', 'هالحين', 'الآن', 'الان', 'بكرة', 'بكره', 'غداً', 'غدا',
            'أمس', 'امس', 'البارحة', 'البارحه', 'هالأسبوع', 'هالاسبوع', 'هذا الأسبوع', 'هذا الاسبوع',
            'الأسبوع الجاي', 'الاسبوع الجاي', 'هالشهر', 'قريباً', 'قريبا',
        ]);
        assert.deepEqual([...s.timeWords.head], ['اليوم', 'الليلة', 'الليله', 'الحين', 'هالحين'], 'the first five: what the prompt has always named');
        assert.equal(s.forwardExample, '«ابعتها لصاحبك اللي …»');
        assert.equal(s.fallbackQuestion, 'تبي تطبّقها بنفسك خطوة بخطوة؟ 👀');
        assert.equal(s.coursePitch, 'شرحتها خطوة بخطوة في الكورس، مع التطبيق العملي.');
    });

    it('English is the neutral Studio text of today: its time words, and the question and pitch it falls back on', () => {
        const s = KITS.en.studio;
        assert.deepEqual([...s.timeWords.all], ['today', 'tonight', 'tomorrow', 'yesterday', 'this week', 'next week', 'this month', 'right now']);
        assert.deepEqual([...s.timeWords.head], ['today', 'tonight', 'tomorrow', 'yesterday', 'this week']);
        assert.equal(s.fallbackQuestion, 'Want to try this yourself, step by step? 👀');
        assert.equal(s.coursePitch, 'I walk through it step by step in the course.');
        assert.equal(s.forwardExample, '"Send this to the friend who …"');
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

/**
 * The Studio writer's lines of the same table (05 §2, "Arabic text per register"), as the kits write them: the five time words the
 * prompt names ("head"), the question a DM falls back to, the pitch it falls back to for a COURSE (no other kind has one), and the example
 * a reel's "who to send it to" line gives. The validator also rejects Gulf's whole list in every register and a few spellings of its own
 * words (`kits.ts`); only these four lines are the table's. Drafts until a native speaker has read them.
 */
const REVIEW_STUDIO: Record<'msa' | 'egyptian' | 'levantine', { head: string[]; question: string; pitch: string; forward: string }> = {
    msa: {
        head: ['اليوم', 'الليلة', 'الآن', 'غداً', 'أمس'],
        question: 'هل تريد تطبيقها بنفسك خطوة بخطوة؟ 👀',
        pitch: 'شرحتُها خطوة بخطوة في الدورة، مع التطبيق العملي.',
        forward: '«أرسلها لصديقك الذي …»',
    },
    egyptian: {
        head: ['النهارده', 'الليلة', 'دلوقتي', 'بكره', 'امبارح'],
        question: 'عايز تطبّقها بنفسك خطوة بخطوة؟ 👀',
        pitch: 'شرحتها خطوة بخطوة في الكورس، مع التطبيق العملي.',
        forward: '«ابعتها لصاحبك اللي …»',
    },
    levantine: {
        head: ['اليوم', 'الليلة', 'هلق', 'بكرا', 'مبارح'],
        question: 'بدّك تطبّقها بحالك خطوة بخطوة؟ 👀',
        pitch: 'شرحتها خطوة بخطوة بالكورس، مع التطبيق العملي.',
        forward: '«ابعتها لرفيقك اللي …»',
    },
};

describe('the non-Gulf Arabic Studio lines, as 05 §2 drafts them (for a native speaker to read)', () => {
    for (const key of ['msa', 'egyptian', 'levantine'] as const) {
        it(`${key}: the time words, the fallback question and pitch, and the forward example`, () => {
            const s = KITS[key].studio;
            const want = REVIEW_STUDIO[key];
            assert.deepEqual([...s.timeWords.head], want.head);
            assert.equal(s.fallbackQuestion, want.question);
            assert.equal(s.coursePitch, want.pitch);
            assert.equal(s.forwardExample, want.forward);
        });
    }

    it('the Egyptian pitch and forward example are today\'s line, as the table says', () => {
        assert.equal(KITS.egyptian.studio.coursePitch, KITS.gulf.studio.coursePitch);
        assert.equal(KITS.egyptian.studio.forwardExample, KITS.gulf.studio.forwardExample);
    });
});

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

// ─── What the CSV import starts an unmatched row from (P15, R17) ───────────────────────────────

/**
 * The import fallback of every register (`importFallback`): the DM an imported row with no seed starts from, and its two public replies.
 * `{name}` and `{url}` are the offer's name and link (the page fills them), `{username}` the commenter (the webhook). Neutral: no course, no
 * coupon, no one's brand. The Gulf kit's is neutral too: the owner's own words are not a kit, they are `LEGACY_IMPORT_FALLBACK`
 * (`legacyCourseMappings.ts`) and are served to him alone. Drafts until a native speaker of each dialect has read them.
 */
const REVIEW_IMPORT: Record<'gulf' | 'msa' | 'egyptian' | 'levantine' | 'en', { dm: string; replies: string }> = {
    gulf: {
        dm: 'هلا {username}! 👋\nهذا رابط "{name}":\n🔗 {url}',
        replies: 'أرسلت لك الرابط والتفاصيل على الخاص يا {username}! 📩 | شيك على الخاص يا {username}، الرابط وصلك! 🚀',
    },
    msa: {
        dm: 'أهلاً بك {username}! 👋\nإليك رابط "{name}":\n🔗 {url}',
        replies: 'تم إرسال الرابط والتفاصيل إلى الرسائل الخاصة يا {username}! 📩 | تفقّد رسائلك الخاصة يا {username}، فقد وصلك الرابط! 🚀',
    },
    egyptian: {
        dm: 'أهلاً بيك {username}! 👋\nده لينك "{name}":\n🔗 {url}',
        replies: 'بعتلك اللينك والتفاصيل على الخاص يا {username}! 📩 | شوف الخاص يا {username}، اللينك وصلك! 🚀',
    },
    levantine: {
        dm: 'أهلاً فيك {username}! 👋\nهاد رابط "{name}":\n🔗 {url}',
        replies: 'بعتلك الرابط والتفاصيل عالخاص يا {username}! 📩 | شوف الخاص يا {username}، الرابط وصلك! 🚀',
    },
    en: {
        dm: 'Hi {username}! 👋\nHere is the link for "{name}":\n🔗 {url}',
        replies: 'Link and details sent to your DMs, {username}! 📩 | Check your messages, {username}, the link is there! 🚀',
    },
};

describe('the import fallback of every register, as drafted (for a native speaker to read)', () => {
    for (const key of KIT_KEYS) {
        it(`${key}: the DM and the two replies an unmatched imported row starts from`, () => {
            assert.deepEqual({ ...KITS[key].importFallback }, REVIEW_IMPORT[key]);
        });
    }

    it('the Gulf kit\'s is not the owner\'s: his coupon-for-a-course text is not in any kit', () => {
        for (const key of KIT_KEYS) assert.doesNotMatch(JSON.stringify(KITS[key].importFallback), /كوبون|coupon|لكورس|دورة|الدورة/i, key);
    });
});

// ─── The DM sales prompt (docs/DM_SALES_PLAN.md §3, S5) ──────────────────────────────────────

/**
 * The five lines a customer is sent WITHOUT a model reading their message (or after the guard refused its answer; the fifth is the one
 * follow-up nudge, S9), in every register, as drafted. `NAME` stands for how the creator is called. None names anyone, none addresses the
 * reader by gender, and none holds a link or a number. The Gulf column is the plan's own wording made generic; the other three are drafts for a native speaker to read (05 §2),
 * and the owner reads this table before the lines are merged.
 */
const REVIEW_SALES: Record<KitKey, { handoff: string; unsure: string; optOut: string; calm: string; nudge: string }> = {
    gulf: {
        handoff: 'أبلغت NAME برسالتك، والرد عليك راح يكون قريب إن شاء الله 🙏',
        unsure: 'هالمعلومة ما عندي فيها تأكيد، راح أسأل NAME وأرجع لك 🙏',
        optOut: 'تمام، ما راح نرسل لك رسائل ثانية. شكراً لوقتك 🙏',
        calm: 'نقدّر لو نتكلم بأسلوب محترم، ولو عندك أي سؤال يسعدنا نساعدك 🙏',
        nudge: 'لو عندك أي سؤال عن الرابط اللي أرسلناه لك، يسعدنا نساعدك 🙏',
    },
    msa: {
        handoff: 'أبلغتُ NAME برسالتك، وسيصلك الرد قريباً بإذن الله 🙏',
        unsure: 'لا أملك تأكيداً لهذه المعلومة، وسأسأل NAME وأعود إليك 🙏',
        optOut: 'حسناً، لن نرسل إليك رسائل أخرى. شكراً لوقتك 🙏',
        calm: 'نقدّر الحوار المحترم، وإن كان لديك أي سؤال فيسعدنا أن نساعدك 🙏',
        nudge: 'إن كان لديك أي سؤال حول الرابط الذي أرسلناه إليك، فيسعدنا أن نساعدك 🙏',
    },
    egyptian: {
        handoff: 'بلّغت NAME برسالتك، والرد هيوصلك قريب إن شاء الله 🙏',
        unsure: 'مش عندي تأكيد للمعلومة دي، هسأل NAME وأرجعلك 🙏',
        optOut: 'تمام، مش هنبعتلك رسايل تانية. شكراً لوقتك 🙏',
        calm: 'يا ريت نتكلم بأسلوب محترم، ولو عندك أي سؤال يسعدنا نساعدك 🙏',
        nudge: 'لو عندك أي سؤال عن الرابط اللي بعتناه ليك، يسعدنا نساعدك 🙏',
    },
    levantine: {
        handoff: 'بلّغت NAME برسالتك، والرد رح يوصلك قريباً إن شاء الله 🙏',
        unsure: 'ما عندي تأكيد لهالمعلومة، رح اسأل NAME وبرجعلك 🙏',
        optOut: 'تمام، ما رح نبعتلك رسائل تانية. شكراً لوقتك 🙏',
        calm: 'منقدّر لو نحكي بأسلوب محترم، ولو عندك أي سؤال بيسعدنا نساعدك 🙏',
        nudge: 'إذا عندك أي سؤال عن الرابط اللي بعتناه إلك، بيسعدنا نساعدك 🙏',
    },
    en: {
        handoff: 'I\'ve passed your message to NAME, and you\'ll hear back soon 🙏',
        unsure: 'I can\'t confirm that yet. I\'ll check with NAME and get back to you 🙏',
        optOut: 'Understood, we won\'t message you again. Thanks for your time 🙏',
        calm: 'Let\'s keep this respectful. If you have a question, I\'m glad to help 🙏',
        nudge: 'If you have any questions about the link we sent, we\'re happy to help 🙏',
    },
};

describe('the DM sales kit: what a customer is sent without a model, as drafted (for a native speaker to read)', () => {
    for (const key of KIT_KEYS) {
        it(`${key}: the hand-off, the "I can't confirm", the opt-out confirmation, the calm line and the follow-up nudge`, () => {
            const lines = KITS[key].sales.lines;
            const want = REVIEW_SALES[key];
            assert.equal(lines.handoff('NAME'), want.handoff);
            assert.equal(lines.unsure('NAME'), want.unsure);
            assert.equal(lines.optOut, want.optOut);
            assert.equal(lines.calm, want.calm);
            assert.equal(lines.nudge, want.nudge);
        });

        it(`${key}: names nobody but the creator it is given, and holds no link and no number: the guard has nothing to refuse in it`, () => {
            const lines = KITS[key].sales.lines;
            for (const text of [lines.handoff('الاسم'), lines.unsure('Sami'), lines.optOut, lines.calm, lines.nudge]) {
                const g = guardReply(text, { texts: ['الاسم', 'Sami'], prices: [] });
                assert.deepEqual(g.violations, [], text);
                assert.deepEqual(g.linksRemoved, [], text);
                assert.equal(g.womenEmojiRemoved, 0, text);
            }
            // The creator's name is the only thing the two named lines vary with.
            assert.equal(lines.handoff('A').replace('A', 'B'), lines.handoff('B'));
            assert.equal(lines.unsure('A').replace('A', 'B'), lines.unsure('B'));
        });
    }

    it('an Egyptian or MSA customer is told none of the Gulf words', () => {
        for (const key of ['egyptian', 'msa'] as const) {
            const lines = KITS[key].sales.lines;
            for (const text of [lines.handoff('X'), lines.unsure('X'), lines.optOut, lines.calm, lines.nudge]) assertNoGulfInEgyptianOrMsa(text, `${key} sales line`);
        }
    });

    it('every register has a line of each, in its own words: no register is left speaking another\'s', () => {
        for (const key of ['msa', 'egyptian', 'levantine', 'en'] as const) {
            for (const line of ['handoff', 'unsure', 'optOut', 'calm', 'nudge'] as const) {
                const text = (k: KitKey): string => { const l = KITS[k].sales.lines[line]; return typeof l === 'function' ? l('X') : l; };
                assert.notEqual(text(key), text('gulf'), `${key} ${line}`);
            }
        }
    });
});

/**
 * The two lines a customer is sent for a message with NO WORDS (a photo, a voice note, a mention in a story: `src/webhook/attachments.ts`),
 * in every register, as drafted. Sent without a model, in every `sales_mode`. None addresses the reader by gender, and none holds a link, a
 * number or a name. The Gulf column is the owner's wording; the other three are drafts for a native speaker to read (05 §2).
 */
const REVIEW_ATTACHMENTS: Record<KitKey, { media: string; mention: string }> = {
    gulf: {
        media: 'وصلني مرفقك 🙏 بس ما أقدر أفتح الصور والصوتيات والمقاطع هنا. يا ليت يكون سؤالك مكتوب، وأساعدك على طول.',
        mention: 'شكراً على الإشارة في قصتك 🙏 ولو عندك أي سؤال يسعدني أساعدك.',
    },
    msa: {
        media: 'وصلني مرفقك 🙏 لكنني لا أستطيع فتح الصور والرسائل الصوتية والمقاطع هنا. يسعدني أن أساعدك إذا وصلني سؤالك مكتوباً.',
        mention: 'شكراً على الإشارة في قصتك 🙏 وإن كان لديك أي سؤال فيسعدني أن أساعدك.',
    },
    egyptian: {
        media: 'وصلني المرفق 🙏 بس مش هقدر أفتح الصور والفويسات والفيديوهات هنا. يا ريت السؤال يكون مكتوب وأنا أساعدك على طول.',
        mention: 'شكراً على المنشن في الستوري 🙏 ولو عندك أي سؤال يسعدني أساعدك.',
    },
    levantine: {
        media: 'وصلني المرفق 🙏 بس ما بقدر افتح الصور والفويسات والفيديوهات هون. يا ريت يكون سؤالك مكتوب، وبساعدك فوراً.',
        mention: 'شكراً على المنشن بالستوري 🙏 ولو عندك أي سؤال بيسعدني ساعدك.',
    },
    en: {
        media: 'Got your attachment 🙏 I can\'t open photos, voice notes or videos here. If you type your question, I\'ll help right away.',
        mention: 'Thanks for the mention in your story 🙏 If you have a question, I\'m glad to help.',
    },
};

describe('the attachment lines: what a customer is sent for a message with no words, as drafted (for a native speaker to read)', () => {
    for (const key of KIT_KEYS) {
        it(`${key}: the "I can't open it" line and the story-mention thanks`, () => {
            assert.deepEqual({ ...KITS[key].attachments }, REVIEW_ATTACHMENTS[key]);
        });

        it(`${key}: holds no link, no number and no name: the guard has nothing to refuse in it`, () => {
            for (const text of Object.values(KITS[key].attachments)) {
                const g = guardReply(text, { texts: [], prices: [] });
                assert.deepEqual(g.violations, [], text);
                assert.deepEqual(g.linksRemoved, [], text);
                assert.equal(g.womenEmojiRemoved, 0, text);
            }
        });
    }

    it('an Egyptian or MSA customer is told none of the Gulf words', () => {
        for (const key of ['egyptian', 'msa'] as const) {
            for (const [name, text] of Object.entries(KITS[key].attachments)) assertNoGulfInEgyptianOrMsa(text, `${key} attachment line ${name}`);
        }
    });

    it('every register has its own words: no register is left speaking another\'s', () => {
        for (const key of ['msa', 'egyptian', 'levantine', 'en'] as const) {
            for (const line of ['media', 'mention'] as const) assert.notEqual(KITS[key].attachments[line], KITS.gulf.attachments[line], `${key} ${line}`);
        }
    });
});

/** Every string the sales prompt takes from a kit and says to the model, each function called with example words. */
function modelFacing(k: LanguageKit['sales']): string[] {
    return [
        k.ownerFallback, ...Object.values(k.headers), k.identity('N', 'role', 'niche'), k.noLink('Name', 'id', 'N'), k.noOffers('N'),
        ...Object.values(k.emoji), ...k.hours.days, k.hours.line('N', 'd', '09:00', '17:00', 'UTC'), k.hours.handoff('when'),
        ...k.rules('N'), k.conversation.stage('new'), k.conversation.qualifiers(1, 2), k.conversation.qualifiers(2, 2), k.conversation.linkSent('o'),
        k.conversation.linkNotSent, k.conversation.comment('kw', 'o'), k.conversation.comment('kw', null),
        k.offer.id('x'), k.offer.primary, k.offer.link, k.offer.priceLive('49', '2026-12-31'), k.offer.priceNone, k.offer.priceNote, k.offer.forWhom, k.offer.level,
        ...SALES_LEVELS.map((l) => k.offer.levels[l]), k.offer.outcomes, k.offer.facts, k.offer.includes, k.offer.faqs, k.offer.objection, k.offer.answer,
        k.offer.proof, ...PROOF_KINDS.map((p) => k.offer.proofKinds[p]), k.offer.source,
    ];
}

describe('the DM sales kit: what the prompt tells the model', () => {
    it('has every word of the prompt in every register, and none is blank', () => {
        for (const key of KIT_KEYS) {
            const k = KITS[key].sales;
            for (const line of modelFacing(k)) assert.ok(line.trim().length > 0, `${key} has a blank line`);
            assert.equal(k.hours.days.length, 7, `${key}: seven days`);
            assert.equal(k.rules('N').length, 12, `${key}: twelve rules`);
            assert.deepEqual(Object.keys(k.emoji).sort(), ['light', 'none', 'rich']);
        }
    });

    it('the four Arabic registers share what is said to the model; only the customer lines are dialect', () => {
        for (const key of ['msa', 'egyptian', 'levantine'] as const) {
            assert.deepEqual(modelFacing(KITS[key].sales), modelFacing(KITS.gulf.sales), key);
        }
        assert.notDeepEqual(modelFacing(KITS.en.sales), modelFacing(KITS.gulf.sales), 'English has its own');
    });

    it('names the creator in the rules that need a person: an unanswerable question, an offer with no link', () => {
        for (const key of KIT_KEYS) {
            const rules = KITS[key].sales.rules('CREATOR');
            assert.ok(rules[2]!.includes('CREATOR'), `${key}: rule 3`);
            assert.ok(rules[6]!.includes('CREATOR'), `${key}: rule 7`);
        }
    });

    it('writes the model\'s own fields as the schema spells them, in every register: a renamed value would leave a rule that names nothing', () => {
        for (const key of KIT_KEYS) {
            const text = KITS[key].sales.rules('X').join('\n');
            for (const token of ['next_action', 'send_link', 'handoff', 'handoff_reason', 'unsure', 'close', 'offer_id', 'quick_replies', 'intent', 'stage']) {
                assert.ok(text.includes(token), `${key}: "${token}"`);
            }
        }
    });

    it('asks for no emoji that shows a woman or a girl, at every level that allows emoji', () => {
        for (const key of KIT_KEYS) {
            const { light, rich, none } = KITS[key].sales.emoji;
            assert.ok(/woman or a girl|امرأة أو فتاة/.test(light), `${key} light`);
            assert.ok(/woman or a girl|امرأة أو فتاة/.test(rich), `${key} rich`);
            assert.ok(/no emoji|أي إيموجي/i.test(none), `${key} none`);
        }
    });
});
