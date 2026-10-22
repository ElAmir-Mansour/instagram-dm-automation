/**
 * The Meta ads policy check: a deterministic, bilingual pre-flight for ad copy (research R12).
 *
 * Meta reviews every ad automatically and can reject it — or restrict the ad account after repeated
 * rejections — for wording that sounds harmless to us: an income figure, "passive income", a
 * guaranteed job, or a question that points at the reader's debts. This module reads the text of
 * a draft (primary text, headline, greeting, ice breakers, a post's caption) BEFORE anything is sent
 * to Meta and says which words are the problem, why Meta rejects them, and what to write instead.
 *
 * Design:
 *   - Pure and synchronous: no DB, no network, no clock. The same text always gives the same answer,
 *     so the dashboard can call it on every keystroke and the server can call it again, as the
 *     gate, before a create op. (An LLM drafts compliant copy elsewhere; this list is the gate.)
 *   - Matching runs on NORMALISED text, so dressing a phrase up does not get it past the check:
 *     tatweel («اكـــسب»), alef forms («إحصل»), diacritics, ta marbuta/ha, alef maksura/ya, Arabic-
 *     Indic and Persian digits, Persian kaf/yeh, zero-width and bidi characters, case and runs of
 *     whitespace are all folded away first. The fold keeps a map back to the ORIGINAL text, and every
 *     finding's [start, end) points into what the person typed, which is what the UI highlights.
 *   - Word boundaries are Unicode lookarounds, not `\b`: JavaScript's `\b` only knows [A-Za-z0-9_],
 *     so every Arabic letter looks like a non-word character to it (same reason as keywordMatches).
 *   - Arabic patterns are written in their natural spelling and folded with the same rules as the
 *     text when they are compiled, so a pattern cannot silently fail to match because it was typed
 *     with a ta marbuta where the text now has a ha.
 *
 * The rule list is versioned: bump POLICY_VERSION when a rule is added, removed or its pattern is
 * loosened or tightened, so a stored "checked at policy v1" can tell whether it is stale.
 *
 * Severity: `block` means Meta's own standards name it (02-policy-limits §3.2-3.3) and the draft
 * cannot be created; `warn` means it is borderline or can change the ad's category, and the owner
 * must read it and confirm.
 */
import { normalizeArabicWithMap } from '../../utils/arabic.js';

/** Bump when the rule list or any pattern changes. */
export const POLICY_VERSION = 1;

export type PolicySeverity = 'block' | 'warn';

export type PolicyRuleId =
    | 'income_figure'      // block: a money amount with a period or an earn verb
    | 'passive_income'     // block: passive income, financial freedom
    | 'get_rich'           // block: get rich quick, become a millionaire
    | 'no_effort'          // block: no effort, while you sleep, easy money
    | 'quit_job'           // block: quit your job, replace your salary
    | 'guaranteed'         // block: guaranteed results, 100% guaranteed, risk-free
    | 'job_promise'        // block: get a job, guaranteed job
    | 'personal_attribute' // block: "you" + an attribute (debt, unemployed, religion, health, age...) or "your debt"
    | 'you_question'       // warn: «هل أنت …؟» / "are you …?" about anything else
    | 'certificate'        // warn: «شهادة معتمدة» can make the ad an EMPLOYMENT special-category ad
    | 'limited_time';      // warn: "limited time" when no date appears in the same field

export interface PolicyFinding {
    ruleId: PolicyRuleId;
    severity: PolicySeverity;
    /** The field name the caller passed, e.g. 'primaryText', 'headline', 'iceBreakers.0.title', 'caption'. */
    field: string;
    /** UTF-16 offsets into the ORIGINAL (un-normalised) text of that field, [start, end). */
    start: number;
    end: number;
    /** `original.slice(start, end)`. */
    match: string;
    explain: { ar: string; en: string };
    rewrite: { ar: string; en: string };
}

export interface PolicyResult {
    version: number;
    /** True iff at least one finding has severity 'block'. */
    blocked: boolean;
    findings: PolicyFinding[];
}

export interface PolicyRuleText {
    id: PolicyRuleId;
    severity: PolicySeverity;
    explain: { ar: string; en: string };
    rewrite: { ar: string; en: string };
}

// ---------------------------------------------------------------------------
// Rule texts (what the owner reads). Arabic is Modern Standard Arabic. The rewrites teach one idea:
// sell the skill, not the money, and talk about the topic, not about the person.
// ---------------------------------------------------------------------------

export const POLICY_RULES: ReadonlyArray<PolicyRuleText> = [
    {
        id: 'income_figure', severity: 'block',
        explain: {
            ar: 'ترفض ميتا الإعلانات التي تَعِد بمبلغ محدد من الدخل، لأنها تُعدّ وعدًا بمكسب مالي غير واقعي.',
            en: 'Meta rejects ads that promise a specific amount of income; it reads as an unrealistic financial claim.',
        },
        rewrite: {
            ar: 'تعلّم مهارة [اسم المهارة] خطوة بخطوة بمشاريع عملية.',
            en: 'Learn [skill] step by step with hands-on projects.',
        },
    },
    {
        id: 'passive_income', severity: 'block',
        explain: {
            ar: 'عبارات الدخل السلبي والحرية المالية تَعِد بالمال مقابل جهد ضئيل، وهذا من الممارسات التجارية المحظورة في سياسات ميتا.',
            en: 'Passive-income and financial-freedom wording promises money for little effort, which Meta\'s commercial-practices policy prohibits.',
        },
        rewrite: {
            ar: 'اذكر ما سيتقنه المتعلم، مثل: «ابنِ أول وكيل ذكاء اصطناعي لك خلال أسبوعين».',
            en: 'Say what the learner will be able to do, e.g. "Build your first AI agent in two weeks".',
        },
    },
    {
        id: 'get_rich', severity: 'block',
        explain: {
            ar: 'الثراء السريع ووعد التحول إلى مليونير من مخططات الربح السريع التي تحظرها ميتا.',
            en: 'Get-rich-quick wording is a scheme Meta prohibits, however it is phrased.',
        },
        rewrite: {
            ar: 'بِع المهارة لا الثروة: «تعلّم أساسيات لغة Go بمشاريع حقيقية».',
            en: 'Sell the skill, not the wealth: "Learn the basics of Go with real projects".',
        },
    },
    {
        id: 'no_effort', severity: 'block',
        explain: {
            ar: 'الوعد بنتائج بلا مجهود يوحي بمكسب كبير مقابل جهد ضئيل أو معدوم، وترفضه ميتا.',
            en: 'Promising results without effort suggests a large reward for minimal work, which Meta rejects.',
        },
        rewrite: {
            ar: 'كن صريحًا في المجهود المطلوب: «دروس قصيرة وتطبيقات عملية تناسب المبتدئين».',
            en: 'Be honest about the effort: "Short lessons and hands-on practice made for beginners".',
        },
    },
    {
        id: 'quit_job', severity: 'block',
        explain: {
            ar: 'دعوة المشاهد إلى ترك وظيفته أو استبدال راتبه تُقرأ وعدًا بدخل بديل مضمون، وهذا مرفوض.',
            en: 'Telling people to quit their job or replace their salary reads as a promise of replacement income, which Meta rejects.',
        },
        rewrite: {
            ar: 'ركّز على المهارة: «طوّر مهاراتك في البرمجة بجانب عملك».',
            en: 'Focus on the skill: "Build your programming skills alongside your job".',
        },
    },
    {
        id: 'guaranteed', severity: 'block',
        explain: {
            ar: 'لا تسمح ميتا بضمان النتائج أو الأرباح، لأن أي ضمان من هذا النوع لا يمكن إثباته.',
            en: 'Meta does not allow guaranteed results or returns; such a guarantee cannot be substantiated.',
        },
        rewrite: {
            ar: 'صِف ما تتضمنه الدورة بدل ضمان النتيجة: «دروس عملية ودعم مباشر طوال الدورة».',
            en: 'Describe what is included instead of guaranteeing an outcome: "Hands-on lessons and live support throughout".',
        },
    },
    {
        id: 'job_promise', severity: 'block',
        explain: {
            ar: 'وعد الحصول على وظيفة أو التوظيف المضمون محظور، وقد ينقل الإعلان إلى فئة التوظيف الخاصة المقيَّدة.',
            en: 'Promising a job, or guaranteed hiring, is prohibited and can push the ad into the restricted employment category.',
        },
        rewrite: {
            ar: 'اذكر المهارات التي ستُكتسب لا الوظيفة: «تعلّم المهارات التي يحتاج إليها مطوّر الذكاء الاصطناعي».',
            en: 'Name the skills gained, not the job: "Learn the skills an AI developer needs".',
        },
    },
    {
        id: 'personal_attribute', severity: 'block',
        explain: {
            ar: 'لا يجوز أن يُظهر الإعلان معرفةً بصفات شخصية للمخاطَب، كالدَّين أو البطالة أو الحالة الصحية أو الدين أو العمر.',
            en: 'An ad must not assert or imply personal attributes of the person seeing it, such as debt, unemployment, health, religion or age.',
        },
        rewrite: {
            ar: 'خاطِب الموضوع لا الشخص: «تعلّم إدارة الميزانية الشخصية خطوة بخطوة».',
            en: 'Talk about the topic, not the person: "Learn personal budgeting step by step".',
        },
    },
    {
        id: 'you_question', severity: 'warn',
        explain: {
            ar: 'السؤال الموجَّه إلى القارئ بصيغة «هل أنت …؟» قد يعدّه المراجع إيحاءً بصفة شخصية عنه، وهذا حدّي في سياسات ميتا.',
            en: 'A question aimed at the reader ("Are you …?") can be read as implying a personal attribute; reviewers apply this pattern broadly.',
        },
        rewrite: {
            ar: 'حوّل السؤال إلى عرض: «تعلّم Go بمشاريع عملية من الصفر».',
            en: 'Turn the question into an offer: "Learn Go from scratch with hands-on projects".',
        },
    },
    {
        id: 'certificate', severity: 'warn',
        explain: {
            ar: 'ذكر شهادة معتمدة قد يجعل ميتا تعدّ الإعلان من فئة التوظيف الخاصة، وهذه الفئة تقيّد الاستهداف.',
            en: 'Mentioning a certified or accredited certificate can make Meta treat the ad as an employment ad, which restricts targeting.',
        },
        rewrite: {
            ar: 'اذكر ما ستناله فعلًا: «شهادة إتمام الدورة»، وركّز على المشاريع العملية.',
            en: 'Say what the learner actually gets: "a certificate of completion", and focus on the hands-on projects.',
        },
    },
    {
        id: 'limited_time', severity: 'warn',
        explain: {
            ar: 'العرض «لفترة محدودة» دون تاريخ انتهاء قد يُعدّ ضغطًا مضلِّلًا على القارئ.',
            en: '"Limited time" without an end date can read as misleading pressure.',
        },
        rewrite: {
            ar: 'اذكر تاريخ الانتهاء صراحةً: «العرض ساري حتى 30 أكتوبر».',
            en: 'State the end date: "Offer valid until 30 October".',
        },
    },
];

const RULE_BY_ID = new Map<PolicyRuleId, PolicyRuleText>(POLICY_RULES.map(r => [r.id, r]));

// ---------------------------------------------------------------------------
// Normalisation with a map back to the original text
// ---------------------------------------------------------------------------

/**
 * Characters that are invisible or purely decorative: zero-width space/joiners, bidi marks and
 * isolates, the BOM, the soft hyphen and the word joiner. Removed BEFORE normalisation so that
 * «بدو​ن» (a zero-width space inside the word) is the word «بدون».
 */
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿­⁠]/;

/** What a finding's end offset may swallow after the last matched letter: marks the fold removed. */
const TRAILING_IGNORABLE = /[ـً-ٰٕ​-‏‪-‮⁦-⁩﻿­⁠]/;

/** One-to-one folds applied after normalizeArabic (so the offsets stay valid): digits, Farsi letters, number marks. */
function foldChar(c: string): string {
    const code = c.charCodeAt(0);
    if (code >= 0x0660 && code <= 0x0669) return String.fromCharCode(0x30 + code - 0x0660); // Arabic-Indic digits
    if (code >= 0x06F0 && code <= 0x06F9) return String.fromCharCode(0x30 + code - 0x06F0); // Persian digits
    switch (code) {
        case 0x066A: return '%'; // Arabic percent sign
        case 0x066B: return '.'; // Arabic decimal separator
        case 0x066C: return ','; // Arabic thousands separator
        case 0x06CC: case 0x06D2: return 'ي'; // Farsi yeh, yeh barree -> Arabic yeh
        case 0x06A9: return 'ك';              // Farsi kaf -> Arabic kaf
        case 0x06BE: case 0x06C1: return 'ه'; // heh doachashmee, heh goal -> heh
        case 0x2019: case 0x2018: return "'";      // curly apostrophes ("you’re")
        case 0xFF04: return '$';                   // full-width dollar sign
        default: return c;
    }
}

interface Normalised { text: string; map: number[] }

/** Normalised text for matching plus `map[i]` = index in `original` of normalised char i (final sentinel = original.length). */
function normaliseForPolicy(original: string): Normalised {
    // 1. Drop invisible characters, remembering where each kept character was.
    let stripped = '';
    const map1: number[] = [];
    for (let i = 0; i < original.length; i++) {
        const ch = original[i]!;
        if (INVISIBLE.test(ch)) continue;
        stripped += ch;
        map1.push(i);
    }
    map1.push(original.length);

    // 2. normalizeArabic's fold (tatweel, alef, ta marbuta, yeh, tashkeel, lower case, whitespace).
    const { text: folded, map: map2 } = normalizeArabicWithMap(stripped);

    // 3. One-to-one folds, then compose the two maps.
    let text = '';
    for (let i = 0; i < folded.length; i++) text += foldChar(folded[i]!);
    const map = map2.map(i => map1[i]!);
    return { text, map };
}

/** Maps a normalised [s, e) back onto the original text, covering the marks the fold removed after the last letter. */
function toOriginalSpan(original: string, map: number[], s: number, e: number): [number, number] {
    const start = map[s]!;
    const last = map[e - 1]!;
    const cp = original.codePointAt(last) ?? 0;
    let end = last + (cp > 0xFFFF ? 2 : 1);
    while (end < original.length && TRAILING_IGNORABLE.test(original[end]!)) end++;
    return [start, end];
}

// ---------------------------------------------------------------------------
// Pattern building blocks
// ---------------------------------------------------------------------------

/** A letter or digit (any script) or underscore: what a word is made of. */
const L = '[\\p{L}\\p{N}_]';
/** Start / end of a word. JS `\b` cannot do this for Arabic, so: Unicode lookarounds. */
const S = `(?<!${L})`;
const E = `(?!${L})`;
/** Optional Arabic definite article and the optional one-letter conjunction prefix (و / ف). */
const AL = '(?:ال)?';
const P = '(?:و|ف)?';
/** One token (no whitespace or sentence punctuation), used for "within N tokens" gaps. A gap never crosses a sentence mark. */
const W = '[^\\s.,;:!?؟،…«»"()\\[\\]{}]+';

/**
 * Folds an Arabic pattern the way the text is folded (alef forms, ta marbuta, alef maksura,
 * tashkeel, tatweel) WITHOUT lower-casing: that would turn `\P{L}` into `\p{L}`.
 */
function foldPattern(src: string): string {
    return src
        .replace(/[ـً-ٰٕ]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي');
}

function rx(src: string): RegExp {
    return new RegExp(foldPattern(src), 'giu');
}

interface Pattern {
    re: RegExp;
    /** A match whose normalised text satisfies this is not reported (used to tell "ready to learn about debt" from "in debt"). */
    skipIf?: RegExp;
}

function pat(src: string, skipIf?: RegExp): Pattern {
    return { re: rx(src), skipIf };
}

// -- Money -----------------------------------------------------------------

const SYM = '[$€£]';
const CUR_AR = '(?:(?:دولار|جنيه|ريال|درهم|دينار)(?:ا|ات)?|يورو)';
const CUR_EN = '(?:usd|dollars?|bucks|eur|euros?|gbp|sar|egp|aed|riyals?|dirhams?)';
const NUM = '(?<!\\d)\\d+(?:[.,]\\d+)*';
/** 10k, 5 thousand, 3 million, 5 آلاف, 2 مليون — directly after a number. */
const MAG = `(?:\\s?(?:k|m|thousand|million|الف|الاف|مليون|ملايين)${E})?`;
const AMOUNT = `(?:${SYM}\\s?${NUM}${MAG}|${NUM}${MAG}\\s?(?:${SYM}|(?:${CUR_EN}|${CUR_AR})${E})|(?:الف|الاف|مليون|ملايين|thousand|million)\\s+(?:${CUR_AR}|${CUR_EN})${E})`;
const PERIOD = '(?:'
    + 'يوميا|شهريا|اسبوعيا|سنويا'
    + '|(?:في|ل?كل)\\s+(?:ال)?(?:يوم|شهر|اسبوع|ساعه|سنه)'
    + '|بال(?:يوم|شهر|اسبوع|ساعه)'
    + '|/\\s?(?:day|d|week|wk|month|mo|hour|hr|year|yr)'
    + '|(?:a|per|each|every)\\s+(?:day|week|month|hour|year)'
    + '|in\\s+(?:a|one|1)\\s+(?:day|week|month|hour)'
    + '|daily|weekly|monthly|yearly'
    + `)${E}`;
const EARN_VERB = '(?:اكسب|اربح|تكسب|تربح|يكسب|يربح|نكسب|ربح|ارباح|كسب|حقق|earn(?:s|ed|ing)?|profits?|income|get\\s+paid|pocket)';
/**
 * A price is not an income: «اشترك بسعر 30 دولار شهريا», "Pay $50 a month". An amount-with-a-period
 * is skipped when a price word sits earlier in the same sentence (the earn-verb form is never skipped).
 */
const PRICE_WORD = '(?:بسعر|سعر|السعر|اشتراك|الاشتراك|اشترك|ادفع|تدفع|دفع|رسوم|تكلفه|تكلفتها|ثمن|تبدا|تبدأ|price|pay|paying|only|cost|costs|fee|fees|subscription|subscribe|starting|starts|plan)';
const NOT_A_PRICE = `(?<!(?<!${L})${PRICE_WORD}[^.!?؟\\n]{0,40})(?<!(?<!${L})ب\\s?)`;

// -- Personal attributes ---------------------------------------------------

/** "You" triggers: «هل أنت», «أنت», «هل تعاني», «هل لديك» … and "are you", "you're", "do you suffer". */
const TRIG_AR = `${S}${P}(?:هل\\s+)?(?:انت|انتي|انتم|انتما|تعاني|تعانين|تعانون|تشعر|تواجه|تعيش|عندك|لديك|معك|عليك)${E}`;
const TRIG_EN = `${S}(?:are\\s+you|you(?:'|’)re|you\\s+are|do\\s+you\\s+(?:suffer|struggle|have|feel|live|deal)|have\\s+you\\s+been|did\\s+you)${E}`;
/** Words that make the attribute unambiguous after "you" — allowed anywhere within four tokens. */
const ATTR_AR = `${S}${AL}(?:`
    + 'مديون\\p{L}{0,3}|مدين(?:ون|ين)?|ديون\\p{L}{0,3}|قروض\\p{L}{0,3}|عاطل\\p{L}{0,3}|بطاله|مفلس\\p{L}{0,3}|افلاس|فقير\\p{L}{0,3}|فقر|معسر\\p{L}{0,3}'
    + '|مريض\\p{L}{0,3}|مرض|مصاب\\p{L}{0,3}|اكتئاب|مكتئب\\p{L}{0,3}|سمنه|سمين\\p{L}{0,3}|بدين|وزن\\s+زائد'
    + '|اعزب|عازب\\p{L}{0,3}|ارمل\\p{L}{0,3}|متزوج\\p{L}{0,3}|مسلم\\p{L}{0,3}|مسيحي\\p{L}{0,3}|يهودي\\p{L}{0,3}|ملحد\\p{L}{0,3}'
    + '|معاق\\p{L}{0,3}|اعاق\\p{L}{0,3}|ذوي\\s+(?:ال)?(?:اعاق|احتياج)\\p{L}{0,3}|مدمن\\p{L}{0,3}|ادمان|مثلي\\p{L}{0,3}|مدخن\\p{L}{0,3}|سجين|سوابق\\p{L}{0,3}'
    + `)${E}`;
/** Words that are ordinary words too («دين» = debt or religion, «قلق» = worry): only right after "you" (one token at most). */
const ATTR_AR_STRICT = `${S}${AL}(?:دين|قلق\\p{L}{0,3}|مطلق(?:ه|ين)?)${E}`;
const ATTR_EN = `${S}(?:`
    + "debt(?:s|ed)?|in\\s+debt|indebted|unemployed|jobless|out\\s+of\\s+work|broke|bankrupt(?:cy)?|poverty|struggling\\s+financially|low[\\s-]income"
    + '|depress(?:ed|ion)|anxi(?:ous|ety)|diabet(?:ic|es)|overweight|obes(?:e|ity)|divorced|widowed|pregnant|disabled|disability|addict(?:ed|ion)?'
    + '|christian|muslim|jewish|hindu|buddhist|atheist|religio(?:n|us)|gay|lesbian|transgender|infertile|criminal\\s+record|ex-?convict'
    + '|\\d{1,3}[\\s-]*(?:years?|yrs?)[\\s-]*old'
    + `)${E}`;
const ATTR_EN_STRICT = `${S}(?:poor|sick|ill|fat|single|married)${E}`;
/** Possessive forms need no "you" word: «ديونك», «بطالتك», "your debt". */
const POSS_AR = `${S}${P}${AL}(?:ديون|قروض|بطال|افلاس|فقر|مرض|اكتئاب|قلق|سمن|وزن|ادمان|طلاق|اعاق|عزوب|ديان|عقيد|دين)(?:ه|ت)?(?:ك|كم|كي)${E}`;
const POSS_EN = `${S}your\\s+(?:debts?|unemployment|bankruptcy|poverty|illness|sickness|depression|anxiety|weight|religion|beliefs?|disabilit(?:y|ies)|addiction|divorce|credit\\s+score|financial\\s+(?:struggles?|troubles?|problems?|situation)|mental\\s+health|medical\\s+condition)${E}`;
/** A "you" sentence that is about wanting to learn, not asserting a state ("Are you ready to learn about debt?"). */
const INTENT = /(?:^|[^\p{L}])(?:ready|interested|looking|wondering|curious|want|wanna|eager|prepared|able|planning|thinking|مستعد|مهتم|ترغب|تريد|تبحث|جاهز|تتطلع)/u;

// -- Dates (for limited_time) ----------------------------------------------

const MONTHS_AR = 'يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر|كانون|شباط|اذار|نيسان|ايار|حزيران|تموز|ايلول|تشرين|جانفي|فيفري|افريل|ماي|جوان|جويليه|يوليوز|غشت|شتنبر|نونبر|دجنبر';
const MONTHS_EN_SAFE = 'january|february|april|june|july|august|september|october|november|december';
const MONTHS_EN_ALL = `${MONTHS_EN_SAFE}|may|march|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec`;
const WEEKDAYS = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|(?:ال)?(?:سبت|احد|اثنين|ثلاثاء|اربعاء|خميس|جمعه))';
const UNTIL = '(?:until|till|through|by|before|ends?|ending|valid\\s+until|حتي|الي|قبل|ينتهي|ستنتهي)';
const DATE_PATTERNS: RegExp[] = [
    rx('(?<!\\d)\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?(?!\\d)'),
    rx('(?<!\\d)\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}(?!\\d)'),
    rx('(?<!\\d)\\d{4}-\\d{2}-\\d{2}(?!\\d)'),
    rx(`${S}(?:${MONTHS_AR}|${MONTHS_EN_SAFE})${E}`),
    rx(`(?<!\\d)\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${MONTHS_EN_ALL})${E}`),
    rx(`${S}(?:${MONTHS_EN_ALL})\\.?\\s+\\d{1,2}(?!\\d)`),
    rx(`${S}${UNTIL}\\s+(?:the\\s+|يوم\\s+)?\\d{1,2}(?![\\p{L}\\p{N}%])`),
    rx(`${S}${UNTIL}\\s+(?:يوم\\s+)?${WEEKDAYS}${E}`),
];

/** True when the (normalised) text names a date or a deadline. */
function hasDate(normalised: string): boolean {
    return DATE_PATTERNS.some(re => { re.lastIndex = 0; return re.test(normalised); });
}

// ---------------------------------------------------------------------------
// The patterns, per rule. Written in natural spelling; folded when compiled.
// ---------------------------------------------------------------------------

const PATTERNS: Record<PolicyRuleId, Pattern[]> = {
    income_figure: [
        // «اكسب 500$ يومياً», «اربح حتى 5000 ريال», "earn up to $500 a day"
        pat(`${S}${P}${EARN_VERB}${E}(?:\\s+${W}){0,2}?\\s*${AMOUNT}(?:\\s*${PERIOD})?`),
        // «500$ يوميا», "$10k/month", «٢٠٠ دولار في اليوم» — unless it is a price
        pat(`${NOT_A_PRICE}${AMOUNT}\\s*${PERIOD}`),
    ],
    passive_income: [
        pat(`${S}${P}${AL}دخل\\s+${AL}(?:سلبي|سلبيه|بدون\\s+مجهود)${E}`),
        pat(`${S}${P}${AL}دخل\\s+${AL}اضافي\\s+${AL}ثابت${E}`),
        pat(`${S}${P}${AL}حريه\\s+${AL}ماليه${E}`),
        pat(`${S}${P}${AL}استقلال\\s+${AL}مالي${E}`),
        pat(`${S}(?:passive|residual)\\s+income${E}`),
        pat(`${S}financial\\s+(?:freedom|independence)${E}`),
    ],
    get_rich: [
        pat(`${S}${P}${AL}ثراء\\s+${AL}سريع${E}`),
        pat(`${S}${P}${AL}ربح\\s+${AL}سريع${E}`),
        pat(`${S}${P}(?:اصبح|تصبح|ستصبح|كن|اجعل\\s+نفسك)\\s+(?:مليونير|مليارديرا?)(?:ا|ه)?${E}`),
        pat(`${S}get[\\s-]+rich(?:[\\s-]+quick)?${E}`),
        pat(`${S}rich[\\s-]+quick${E}`),
        pat(`${S}(?:become|be|become\\s+a|be\\s+a)\\s+(?:a\\s+)?(?:millionaire|billionaire)${E}`),
    ],
    no_effort: [
        pat(`${S}${P}(?:بدون|بلا|دون)\\s+(?:اي\\s+)?(?:مجهود|جهد)${E}`),
        pat(`${S}${P}انت\\s+(?:نائم|نايم)(?:ا|ه)?${E}`),
        pat(`${S}(?:no|zero|minimal|without(?:\\s+any)?)\\s+effort${E}`),
        pat(`${S}while\\s+you\\s+sleep${E}`),
        pat(`${S}easy\\s+money${E}`),
        pat(`${S}effortless(?:ly)?\\s+(?:income|money|profits?)${E}`),
    ],
    quit_job: [
        pat(`${S}${P}(?:اترك|اتركي|اتركوا|تترك|ودع|ودعي)\\s+(?:وظيفتك|وظيفتكم|عملك|الوظيفه)${E}`),
        pat(`${S}${P}(?:استقل|استقيل|تستقيل|استقيلي|استقيلوا)\\s+من\\s+(?:وظيفتك|وظيفتكم|عملك|الوظيفه)${E}`),
        pat(`${S}${P}بديلا?\\s+(?:لل?|عن\\s+(?:ال)?)(?:راتب|وظيف|دخل)\\p{L}*`),
        pat(`${S}${P}وداعا\\s+(?:لل|ل)(?:وظيف|راتب)\\p{L}*`),
        pat(`${S}(?:quit|quitting|leave|leaving)\\s+(?:your|the|that)\\s+(?:day\\s+)?(?:job|9\\s?(?:to|-)\\s?5)${E}`),
        pat(`${S}replace\\s+(?:your\\s+)?(?:salary|income|job|9\\s?(?:to|-)\\s?5)${E}`),
        pat(`${S}fire\\s+your\\s+boss${E}`),
        pat(`${S}(?:goodbye|bye|farewell)\\s+(?:to\\s+)?(?:your\\s+)?(?:boss|9\\s?(?:to|-)\\s?5|job)${E}`),
    ],
    guaranteed: [
        // «ربح مضمون», «نتائج مضمونة», «نتائج 100% مضمونة». «مضمون الدورة» (what the program contains) is NOT a guarantee.
        pat(`${S}${P}${AL}(?:نتايج|نتائج|ربح|ارباح|عائد|عوائد|دخل|نجاح|مكسب|مكاسب|فوز|شفاء)\\s+(?:100\\s*%\\s*)?مضمون(?:ه|ات|ين|ا)?${E}`),
        pat(`${S}مضمون(?:ه|ات|ين)?\\s*100\\s*%`),
        pat(`(?<!\\d)100\\s*%\\s*(?:مضمون(?:ه|ات|ين)?${E}|ضمان${E})`),
        pat(`${S}ضمان\\s+100\\s*%`),
        pat(`${S}${P}(?:نضمن|اضمن|نضمنلك)\\s+(?:لك\\s+)?${AL}(?:نجاح|ربح|نتايج|نتائج|دخل|عائد)${E}`),
        pat(`${S}guaranteed${E}(?!\\s+(?:job|employment|hire|hiring|placement))`),
        pat(`${S}risk[\\s-]*free${E}`),
        pat(`(?<!\\d)100\\s*%\\s*(?:guarantee[ds]?|sure|safe|certain)${E}`),
        pat(`${S}guarantee[sd]?\\s+(?:you\\s+)?(?:success|results?|income|profits?|returns?)${E}`),
    ],
    job_promise: [
        pat(`${S}${P}(?:س?[اتين]حصل\\p{L}*|حصل\\p{L}*)\\s+علي\\s+(?:${AL}وظيف\\p{L}*|${AL}توظيف${E}|فرصه\\s+عمل${E})`),
        pat(`${S}${P}${AL}(?:وظيفه|وظايف|وظائف|توظيف)\\s+مضمون(?:ه|ات|ين|ا)?${E}`),
        pat(`${S}(?:فرصه|فرص)\\s+عمل\\s+مضمون(?:ه|ات)?${E}`),
        pat(`${S}ضمان\\s+${AL}(?:وظيفه|توظيف)${E}`),
        pat(`${S}${P}(?:نوظفك|سنوظفك|نضمن\\s+(?:لك\\s+)?(?:وظيفه|توظيف))${E}`),
        pat(`${S}get\\s+hired${E}`),
        pat(`${S}land\\s+(?:a|an|your|the)\\s+(?:dream\\s+)?(?:job|role|position)${E}`),
        pat(`${S}(?:get|find|secure)\\s+(?:a|your)\\s+(?:dream\\s+)?job${E}`),
        pat(`${S}guaranteed\\s+(?:job|employment|hire|hiring|placement)${E}`),
        pat(`${S}job\\s+(?:guarantee|placement)${E}`),
    ],
    personal_attribute: [
        // "you" + an unambiguous attribute within four tokens
        pat(`${TRIG_AR}(?:\\s+${W}){0,4}?\\s+${ATTR_AR}`, INTENT),
        pat(`${TRIG_EN}(?:\\s+${W}){0,4}?\\s+${ATTR_EN}`, INTENT),
        // "you" + an ambiguous word, immediately after "you" (at most one token between)
        pat(`${TRIG_AR}(?:\\s+${W}){0,1}?\\s+${ATTR_AR_STRICT}`, INTENT),
        pat(`${TRIG_EN}(?:\\s+${W}){0,1}?\\s+${ATTR_EN_STRICT}`, INTENT),
        pat(`${S}${P}هل\\s+عمرك${E}`),
        pat(`${S}عمرك\\s+\\d{1,3}${E}`),
        // possessives need no "you" word
        pat(POSS_AR),
        pat(POSS_EN),
    ],
    you_question: [
        // The clause, up to the question mark, capped at nine tokens so a long text is not swallowed.
        pat(`${S}${P}هل\\s+(?:انت|انتي|انتم|انتما)${E}(?:\\s+${W}){0,8}\\s*[؟?]?`),
        pat(`${S}are\\s+you${E}(?:\\s+${W}){0,8}\\s*\\??`),
    ],
    certificate: [
        pat(`${S}${AL}(?:شهاده|شهادات)\\s+(?:(?:ال)?(?:دوليه|رسميه|اكاديميه)\\s+)?(?:معتمد\\p{L}{0,2}|معترف\\s+بها|موثق\\p{L}{0,2}|مصدق\\p{L}{0,2})${E}`),
        pat(`${S}${AL}(?:دوره|دورات|برنامج|كورس)\\s+معتمد\\p{L}{0,2}${E}`),
        pat(`${S}certified${E}`),
        pat(`${S}accredited${E}`),
        pat(`${S}(?:official|recognized|recognised)\\s+certificat(?:e|ion)${E}`),
    ],
    limited_time: [
        pat(`${S}(?:ل?فتره|لمده|لوقت|لايام)\\s+محدود\\p{L}{0,2}${E}`),
        pat(`${S}${AL}(?:عرض|عروض|فرصه|فرص|خصم|سعر)\\s+${AL}محدود\\p{L}{0,2}${E}`),
        pat(`${S}limited[\\s-]+(?:time|offer|period)${E}`),
    ],
};

/** Rules in the order their findings sort when two start at the same offset. */
const RULE_ORDER: PolicyRuleId[] = POLICY_RULES.map(r => r.id);

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

interface RawSpan { ruleId: PolicyRuleId; start: number; end: number }

/** Union of overlapping spans of one rule (touching-but-not-overlapping spans stay separate). */
function mergeOverlaps(spans: RawSpan[]): RawSpan[] {
    const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: RawSpan[] = [];
    for (const s of sorted) {
        const last = merged[merged.length - 1];
        if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
        else merged.push({ ...s });
    }
    return merged;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
    return a.start < b.end && b.start < a.end;
}

function findRaw(normalised: string): RawSpan[] {
    const raw: RawSpan[] = [];
    for (const id of RULE_ORDER) {
        // "Limited time" is only a problem when the same field never says WHEN it ends.
        if (id === 'limited_time' && hasDate(normalised)) continue;
        const spans: RawSpan[] = [];
        for (const { re, skipIf } of PATTERNS[id]) {
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(normalised)) !== null) {
                if (m[0].length === 0) { re.lastIndex++; continue; }
                if (skipIf && skipIf.test(m[0])) continue;
                spans.push({ ruleId: id, start: m.index, end: m.index + m[0].length });
            }
        }
        raw.push(...mergeOverlaps(spans));
    }
    // A personal-attribute BLOCK covers the same sentence as the softer "you" question: report only the block.
    const blocks = raw.filter(r => r.ruleId === 'personal_attribute');
    return raw.filter(r => r.ruleId !== 'you_question' || !blocks.some(b => overlaps(r, b)));
}

/**
 * Checks ad copy against the policy list.
 *
 * `fields` maps a field name (as the UI knows it: 'primaryText', 'headline', 'greeting',
 * 'iceBreakers.0.title', 'caption' …) to its text; null, undefined and blank values are skipped.
 * Findings come back field by field in the order the fields were given, and by position within a field.
 */
export function checkPolicy(fields: Record<string, string | null | undefined>): PolicyResult {
    const findings: PolicyFinding[] = [];
    for (const [field, value] of Object.entries(fields)) {
        if (typeof value !== 'string' || value.trim() === '') continue;
        const { text, map } = normaliseForPolicy(value);
        if (!text) continue;
        const spans = findRaw(text)
            .sort((a, b) => a.start - b.start || RULE_ORDER.indexOf(a.ruleId) - RULE_ORDER.indexOf(b.ruleId));
        for (const span of spans) {
            const rule = RULE_BY_ID.get(span.ruleId) as PolicyRuleText;
            const [start, end] = toOriginalSpan(value, map, span.start, span.end);
            findings.push({
                ruleId: rule.id,
                severity: rule.severity,
                field,
                start,
                end,
                match: value.slice(start, end),
                explain: rule.explain,
                rewrite: rule.rewrite,
            });
        }
    }
    return { version: POLICY_VERSION, blocked: findings.some(f => f.severity === 'block'), findings };
}
