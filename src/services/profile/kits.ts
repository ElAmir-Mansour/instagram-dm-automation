/**
 * The language and register kits (docs/onboarding/05 §2, P8): the text a tenant's agents say, one record per Arabic register
 * (`gulf`, `msa`, `egyptian`, `levantine`) and one for English, so no line of it lives in a builder.
 *
 * A builder asks `kitFor(context.language)` and reads the field it needs. The Gulf kit is today's text *word for word*: the
 * owner speaks it, his output is pinned byte for byte by the goldens, and every other kit is a translation of it. Each of
 * the other kits is a draft until a native speaker of that dialect has read it (05 §2: the Egyptian and Levantine lines in
 * particular), and the table in `kits.test.ts` lists every line so that review is a read of one file.
 *
 * **What a kit holds today (P8: the DM bot and the comment replies; P9: the Studio's writer):**
 *   - `dm`              the fixed rules the DM bot is given after the tenant's persona and knowledge base;
 *   - `offerNouns`      what an offer of each kind is called in rule 2 (`offerNoun`);
 *   - `disclosure`      the first line of an automated DM (Meta's policy requires one);
 *   - `starterPersona`  the persona a new tenant's agent row starts with;
 *   - `commentFallback` the public reply that replaces an undeliverable DM;
 *   - `studio`          the words the carousel writer checks and falls back on: the time words a TikTok caption must not use,
 *                       the question and pitch a DM falls back to, and the example a reel's "who to send it to" line gives.
 *
 * **Extending it (P9-P12).** Add the field to `LanguageKit` and fill it in for all five records: the `Record<KitKey, ...>`
 * will not compile until every register has it, so a register cannot be left speaking another's text by omission. Put the
 * Gulf value first and keep it identical to what the builder writes today.
 *
 * Only a register that is about *how Arabic is spoken* belongs in a register record. What depends on the language alone
 * (the knowledge-base header, the rules every Arabic register shares) is written once in `ARABIC` and spread, so the four
 * records say only where they differ.
 *
 * Pure: nothing here reads a database or a clock.
 */
import type { ArabicRegister, Lang, OfferKind } from './types.js';

/** A kit is keyed by the Arabic register, or `en` for English (which has no register). */
export type KitKey = ArabicRegister | 'en';

/** Every kit, in the order the records below list them. */
export const KIT_KEYS = ['gulf', 'msa', 'egyptian', 'levantine', 'en'] as const satisfies readonly KitKey[];

/** The kinds of offer a kit has a noun for: the rest (coaching, community, event, other, a mix, none) are all "offers". */
export type NounKind = 'course' | 'program' | 'product' | 'service' | 'other';

/** The public reply that replaces a DM Meta would not deliver: the lead, then what the person should do. */
export interface CommentFallbackLines {
    /** "We could not message you privately" and the emoji: every variant starts with it, a space, then one of the three below. */
    lead: string;
    /** Instagram does not make links in comments clickable, so it points to the bio. */
    bio: string;
    /** Facebook does, so it carries the campaign's link. */
    link: (url: string) => string;
    /** The DM held no link: ask them to write to us. */
    none: string;
}

/** What the Studio's writer says and checks in one register (P9). */
export interface StudioLines {
    timeWords: {
        /** The five the prompt names to the model ("No time words (…)"). */
        head: readonly string[];
        /**
         * Every word the validator rejects in a TikTok caption: a post that goes out later than planned must not say "today".
         * A register other than Gulf rejects the Gulf list as well as its own, so what Gulf validation caught it still catches.
         */
        all: readonly string[];
    };
    /** The example the Monteur's copy gives for the line naming who to send a reel to, quotes included: «ابعتها لصاحبك اللي …». */
    forwardExample: string;
    /** The question a DM opens with, for a model that left it empty twice. */
    fallbackQuestion: string;
    /**
     * The pitch a DM falls back to for a COURSE: "I explain it step by step in the course". Any other kind of offer has none
     * (`fallbackPitch`), and `buildDm` drops the empty line.
     */
    coursePitch: string;
}

export interface LanguageKit {
    key: KitKey;
    lang: Lang;
    studio: StudioLines;
    dm: {
        /** The heading above the agent's knowledge base. */
        knowledgeHeader: string;
        /** The heading above the fixed rules. */
        rulesHeader: string;
        /** Rule 1: the replies are friendly, interactive and written in this register. */
        friendly: string;
        /** Rule 2: when asked for the offers, answer with buttons or cards. `noun` is `offerNoun(kit, offerKind)`. */
        offers: (noun: string) => string;
        /** Rule 3: Meta's character limits. */
        limits: string;
        /** The language Gemini's response schema asks the reply to be written in. */
        schemaLanguage: 'Arabic' | 'English';
    };
    offerNouns: Record<NounKind, string>;
    disclosure: string;
    starterPersona: string;
    commentFallback: CommentFallbackLines;
}

// ─── What every Arabic register shares ───────────────────────────────────────────────────────

/** Instructions to the model, not words a customer reads, so the four registers share one wording of them. */
const ARABIC = {
    lang: 'ar' as const,
    dm: {
        knowledgeHeader: '=== قاعدة المعرفة المتاحة لديك (Knowledge Base) ===',
        rulesHeader: '=== تعليمات إضافية مهمة ===',
        offers: (noun: string): string =>
            `إذا طلب المستخدم ${noun} أو معلومات تواصل، استخدم خيار "quick_reply" أو "carousel" لتقديمها بشكل تفاعلي ومنظم بدلاً من مجرد سرد روابط نصية.`,
        limits: 'التزم تماماً بحدود الحروف: عناوين الأزرار والـ quick replies لا تتجاوز 20 حرفاً. عناوين الكروت لا تتجاوز 80 حرفاً.',
        schemaLanguage: 'Arabic' as const,
    },
    offerNouns: { course: 'كورسات', program: 'برامج', product: 'منتجات', service: 'خدمات', other: 'عروضًا' } satisfies Record<NounKind, string>,
    disclosure: '🤖 رد آلي من المساعد الذكي',
    starterPersona: 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.',
};

/**
 * Today's list of time words, as the Studio's writer checked them before P9 (Gulf, with the spelling variants and the
 * Gulf-only «الحين», «هالحين», «هالأسبوع»). The Gulf kit is this list, in this order: its first five are what the prompt names.
 */
const GULF_TIME_WORDS: readonly string[] = Object.freeze([
    'اليوم', 'الليلة', 'الليله', 'الحين', 'هالحين', 'الآن', 'الان', 'بكرة', 'بكره', 'غداً', 'غدا',
    'أمس', 'امس', 'البارحة', 'البارحه', 'هالأسبوع', 'هالاسبوع', 'هذا الأسبوع', 'هذا الاسبوع',
    'الأسبوع الجاي', 'الاسبوع الجاي', 'هالشهر', 'قريباً', 'قريبا',
]);

/**
 * A register other than Gulf: the Gulf list (what was rejected before is still rejected) plus the words this register says.
 * `head` is the five the prompt names; `own` is any more it should reject. Duplicates are dropped, the Gulf order kept.
 */
const timeWordsOf = (head: readonly string[], own: readonly string[] = []): StudioLines['timeWords'] => ({
    head: Object.freeze([...head]),
    all: Object.freeze([...new Set([...GULF_TIME_WORDS, ...head, ...own])]),
});

/** The words that make a kit a register: rule 1, the public reply, and what the Studio's writer says and checks. */
const arabic = (key: ArabicRegister, friendly: string, commentFallback: CommentFallbackLines, studio: StudioLines): LanguageKit => ({
    key,
    lang: ARABIC.lang,
    studio,
    dm: { ...ARABIC.dm, friendly },
    offerNouns: { ...ARABIC.offerNouns },
    disclosure: ARABIC.disclosure,
    starterPersona: ARABIC.starterPersona,
    commentFallback,
});

// ─── The kits ────────────────────────────────────────────────────────────────────────────────

export const KITS: Readonly<Record<KitKey, LanguageKit>> = Object.freeze({
    // Today's text, word for word (the owner's, pinned by __golden__/elamir).
    gulf: arabic('gulf',
        'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللغة العربية الفصحى أو بلهجة سهلة ومناسبة.',
        {
            lead: 'ما قدرنا نرسل لك على الخاص 🙏',
            bio: 'الرابط في البايو 🔗',
            link: (url) => `هذا الرابط: ${url}`,
            none: 'راسلنا على الخاص ونرسل لك التفاصيل',
        },
        {
            timeWords: { head: Object.freeze(GULF_TIME_WORDS.slice(0, 5)), all: GULF_TIME_WORDS },
            forwardExample: '«ابعتها لصاحبك اللي …»',
            fallbackQuestion: 'تبي تطبّقها بنفسك خطوة بخطوة؟ 👀',
            coursePitch: 'شرحتها خطوة بخطوة في الكورس، مع التطبيق العملي.',
        }),

    msa: arabic('msa',
        'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة بالعربية الفصحى البسيطة.',
        {
            lead: 'لم نتمكن من مراسلتك في الخاص 🙏',
            bio: 'الرابط في البايو 🔗',
            link: (url) => `هذا هو الرابط: ${url}`,
            none: 'راسلنا وسنرسل لك التفاصيل',
        },
        {
            // Every head word is already on the Gulf list; the weeks ahead and the month are MSA's own.
            timeWords: timeWordsOf(['اليوم', 'الليلة', 'الآن', 'غداً', 'أمس'], ['الأسبوع القادم', 'الاسبوع القادم', 'هذا الشهر']),
            forwardExample: '«أرسلها لصديقك الذي …»',
            fallbackQuestion: 'هل تريد تطبيقها بنفسك خطوة بخطوة؟ 👀',
            coursePitch: 'شرحتُها خطوة بخطوة في الدورة، مع التطبيق العملي.',
        }),

    egyptian: arabic('egyptian',
        'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة المصرية البسيطة.',
        {
            lead: 'معرفناش نبعتلك على الخاص 🙏',
            bio: 'اللينك في البايو 🔗',
            link: (url) => `ده اللينك: ${url}`,
            none: 'ابعتلنا وهنبعتلك التفاصيل',
        },
        {
            timeWords: timeWordsOf(['النهارده', 'الليلة', 'دلوقتي', 'بكره', 'امبارح'], ['النهاردة', 'دلوقت', 'أمبارح', 'الأسبوع ده', 'الاسبوع ده', 'الشهر ده']),
            forwardExample: '«ابعتها لصاحبك اللي …»',
            fallbackQuestion: 'عايز تطبّقها بنفسك خطوة بخطوة؟ 👀',
            coursePitch: 'شرحتها خطوة بخطوة في الكورس، مع التطبيق العملي.',
        }),

    levantine: arabic('levantine',
        'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة الشامية البسيطة.',
        {
            lead: 'ما قدرنا نبعتلك عالخاص 🙏',
            bio: 'الرابط بالبايو 🔗',
            link: (url) => `هاد الرابط: ${url}`,
            none: 'راسلنا ومنبعتلك التفاصيل',
        },
        {
            timeWords: timeWordsOf(['اليوم', 'الليلة', 'هلق', 'بكرا', 'مبارح'], ['هلأ', 'هالإسبوع', 'هالشهر']),
            forwardExample: '«ابعتها لرفيقك اللي …»',
            fallbackQuestion: 'بدّك تطبّقها بحالك خطوة بخطوة؟ 👀',
            coursePitch: 'شرحتها خطوة بخطوة بالكورس، مع التطبيق العملي.',
        }),

    // English has no register, and none of its lines is a translation of the owner's: they say the same thing in plain English.
    en: {
        key: 'en',
        lang: 'en',
        studio: {
            timeWords: {
                head: Object.freeze(['today', 'tonight', 'tomorrow', 'yesterday', 'this week']),
                all: Object.freeze(['today', 'tonight', 'tomorrow', 'yesterday', 'this week', 'next week', 'this month', 'right now']),
            },
            forwardExample: '"Send this to the friend who …"',
            fallbackQuestion: 'Want to try this yourself, step by step? 👀',
            coursePitch: 'I walk through it step by step in the course.',
        },
        dm: {
            knowledgeHeader: '=== Knowledge base available to you ===',
            rulesHeader: '=== Additional important instructions ===',
            friendly: 'Your replies must be friendly and interactive, written in simple, natural English.',
            offers: (noun) =>
                `If the user asks for ${noun} or contact details, use the "quick_reply" or "carousel" option to present them in an interactive, organized way instead of just listing text links.`,
            limits: 'Keep strictly to the character limits: button titles and quick-reply titles must not exceed 20 characters. Card titles must not exceed 80 characters.',
            schemaLanguage: 'English',
        },
        offerNouns: { course: 'courses', program: 'programs', product: 'products', service: 'services', other: 'offers' },
        disclosure: '🤖 Automated reply from the AI assistant',
        starterPersona: 'You are a smart assistant who answers followers\' questions in English.',
        commentFallback: {
            lead: 'We couldn\'t message you privately 🙏',
            bio: 'The link is in our bio 🔗',
            link: (url) => `Here's the link: ${url}`,
            none: 'Send us a message and we\'ll share the details.',
        },
    },
});

// ─── Choosing a kit ──────────────────────────────────────────────────────────────────────────

/**
 * The kit a surface speaks in: English for English, else the Arabic register (`msa` when the surface says none: the neutral
 * Arabic, and the register a profile with Arabic and no register would be read as).
 */
export function kitFor(language: { code: Lang; register: ArabicRegister | null }): LanguageKit {
    return language.code === 'en' ? KITS.en : KITS[language.register ?? 'msa'];
}

/** The kit for a language alone, for text that does not depend on the register (the disclosure, the starter persona). */
export function kitForLang(lang: Lang): LanguageKit {
    return lang === 'en' ? KITS.en : KITS.msa;
}

/**
 * What an offer of this kind is called in the kit's language: course, program, product and service have a noun, and anything
 * else (a coaching call, a community, an event, a mix of kinds, no offer at all) is "offers".
 */
export function offerNoun(kit: LanguageKit, offerKind: OfferKind | 'mixed' | null): string {
    switch (offerKind) {
        case 'course': return kit.offerNouns.course;
        case 'program': return kit.offerNouns.program;
        case 'product': return kit.offerNouns.product;
        case 'service': return kit.offerNouns.service;
        default: return kit.offerNouns.other;
    }
}

/**
 * The English noun the Studio's prompts use for what the creator sells, in the singular: "whose course is «…»", "what the
 * program gives on this topic". The Studio's instructions to the model are English whatever language it writes the carousel in, so
 * this is one record and not a line of any kit. Course, program, product and service have a noun, and anything else (a coaching
 * call, a community, an event, a mix of kinds, no offer at all) is an "offer", as `offerNoun` does for the DM bot.
 */
export function offerNounSingular(offerKind: OfferKind | 'mixed' | null): string {
    switch (offerKind) {
        case 'course': return 'course';
        case 'program': return 'program';
        case 'product': return 'product';
        case 'service': return 'service';
        default: return 'offer';
    }
}

/**
 * The pitch a DM falls back to when the model left it empty twice. Only a course has one («شرحتها خطوة بخطوة في الكورس»): saying
 * "in the course" about a perfume would be false, so a product, a service, a program, or a mix of kinds gets the empty string,
 * and `buildDm` drops the line it would have filled.
 */
export function fallbackPitch(kit: LanguageKit, offerKind: OfferKind | 'mixed' | null): string {
    return offerKind === 'course' ? kit.studio.coursePitch : '';
}

/** The public reply for an undeliverable DM, in the kit's words (`errors.ts` decides which of the three applies). */
export function commentFallback(kit: LanguageKit, variant: { isFacebook: boolean; link: string | undefined }): string {
    const lines = kit.commentFallback;
    if (!variant.isFacebook) return `${lines.lead} ${lines.bio}`;
    return `${lines.lead} ${variant.link ? lines.link(variant.link) : lines.none}`;
}
