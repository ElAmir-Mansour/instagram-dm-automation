/**
 * The language and register kits (docs/onboarding/05 §2, P8): the text a tenant's agents say, one record per Arabic register
 * (`gulf`, `msa`, `egyptian`, `levantine`) and one for English, so no line of it lives in a builder.
 *
 * A builder asks `kitFor(context.language)` and reads the field it needs. The Gulf kit is today's text *word for word*: the
 * owner speaks it, his output is pinned byte for byte by the goldens, and every other kit is a translation of it. Each of
 * the other kits is a draft until a native speaker of that dialect has read it (05 §2: the Egyptian and Levantine lines in
 * particular), and the table in `kits.test.ts` lists every line so that review is a read of one file.
 *
 * **What a kit holds today (P8: the DM bot and the comment replies):**
 *   - `dm`              the fixed rules the DM bot is given after the tenant's persona and knowledge base;
 *   - `offerNouns`      what an offer of each kind is called in rule 2 (`offerNoun`);
 *   - `disclosure`      the first line of an automated DM (Meta's policy requires one);
 *   - `starterPersona`  the persona a new tenant's agent row starts with;
 *   - `commentFallback` the public reply that replaces an undeliverable DM.
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

export interface LanguageKit {
    key: KitKey;
    lang: Lang;
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

/** The words that make a kit a register: rule 1 and the public reply. */
const arabic = (key: ArabicRegister, friendly: string, commentFallback: CommentFallbackLines): LanguageKit => ({
    key,
    lang: ARABIC.lang,
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
        }),

    msa: arabic('msa',
        'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة بالعربية الفصحى البسيطة.',
        {
            lead: 'لم نتمكن من مراسلتك في الخاص 🙏',
            bio: 'الرابط في البايو 🔗',
            link: (url) => `هذا هو الرابط: ${url}`,
            none: 'راسلنا وسنرسل لك التفاصيل',
        }),

    egyptian: arabic('egyptian',
        'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة المصرية البسيطة.',
        {
            lead: 'معرفناش نبعتلك على الخاص 🙏',
            bio: 'اللينك في البايو 🔗',
            link: (url) => `ده اللينك: ${url}`,
            none: 'ابعتلنا وهنبعتلك التفاصيل',
        }),

    levantine: arabic('levantine',
        'يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة الشامية البسيطة.',
        {
            lead: 'ما قدرنا نبعتلك عالخاص 🙏',
            bio: 'الرابط بالبايو 🔗',
            link: (url) => `هاد الرابط: ${url}`,
            none: 'راسلنا ومنبعتلك التفاصيل',
        }),

    // English has no register, and none of its lines is a translation of the owner's: they say the same thing in plain English.
    en: {
        key: 'en',
        lang: 'en',
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

/** The public reply for an undeliverable DM, in the kit's words (`errors.ts` decides which of the three applies). */
export function commentFallback(kit: LanguageKit, variant: { isFacebook: boolean; link: string | undefined }): string {
    const lines = kit.commentFallback;
    if (!variant.isFacebook) return `${lines.lead} ${lines.bio}`;
    return `${lines.lead} ${variant.link ? lines.link(variant.link) : lines.none}`;
}
