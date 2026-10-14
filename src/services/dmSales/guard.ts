/**
 * What the sales bot may not say, checked on what it did say (docs/DM_SALES_PLAN.md §6). Pure.
 *
 * The model is asked never to write a link, a price, a discount or a number of its own, and it is trusted to do none of that: this is
 * the check on the answer. Four things, in the order `guardReply` does them:
 *
 *   1. **Links.** Every URL, domain and address the model wrote is taken out (`stripLinks`). The only link a customer ever receives is
 *      the one the server adds from the offer's own `url` when the reply says `send_link`. A link the model wrote may be invented,
 *      altered, or point somewhere that earns the owner nothing.
 *   2. **Women in emoji.** An emoji that shows a woman or a girl is taken out (`stripWomenEmoji`): the rule that no content shows
 *      them holds for a model's emoji as for a picture.
 *   3. **Money.** A number that names an amount of money (beside a currency, or after "price") must be a price the owner has made live
 *      (`price.ts`: typed, with a valid-until date that has not passed), in that currency. This is the strict check, and it is stricter
 *      than the next one on purpose: "49" may be in the data as a lesson count, and the reply must still not say "49 dollars" when the
 *      live price is 349. A price the owner typed with no date, or whose date has passed, is not a price the bot may say, even if it
 *      sits in the knowledge base.
 *   4. **Numbers.** Every other number must be in the data the model was shown (`ClaimFacts.texts`: what a person typed, never the
 *      fixed rules). A discount, a coupon and "free" are words the same way: they may be said only if the data says them.
 *
 * What it does not do: judge tone, superlatives or urgency (the prompt asks, and the eval harness reads); and read a number spelled
 * out, except beside a currency («خمسين دولار», "fifty dollars"), which it treats as a price that cannot be live. A violation is a
 * reason to ask the model once more with a correction and, failing that, to send the kit's safe line and hand off (S6); this module
 * only reports.
 */
import { normalizeArabic } from '../../utils/arabic.js';
import type { LivePrice } from './price.js';
import { canonNumber, extractNumbers, graphemes, normalizeDigits, numberSpans } from './text.js';

/** What the reply is checked against. */
export interface ClaimFacts {
    /**
     * Everything the model was shown that a person typed: the persona, the voice guide, each offer's text, the FAQ, the knowledge base,
     * the hours. A number or a discount word in any of it may be said. The fixed rules are not in it ("three sentences" is no fact).
     */
    texts: readonly string[];
    /** The prices that may be stated now: one per offer whose price is typed and has a valid-until date that has not passed. */
    prices: readonly LivePrice[];
}

export type ViolationKind = 'number' | 'price' | 'discount' | 'coupon' | 'free';

export interface Violation {
    kind: ViolationKind;
    /** What was found, as written in the reply (a number, or a number with its currency). */
    found: string;
}

// ─── Links ───────────────────────────────────────────────────────────────────────────────────

/** Where a domain ends and a path begins; the endings that make a bare word a web address. */
const TLDS = 'com|net|org|io|dev|ai|co|me|app|tv|ly|link|shop|store|site|online|info|biz|xyz|page|to|gl|be|sa|ae|eg|kw|qa|bh|om|jo|us|uk|edu|gov';

/** In the order they are tried: a markdown link first (its text is kept), then whatever looks like an address. */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\(\s*[^)\s]*\s*\)/g;
const SCHEME_URL = /\b(?:https?|ftp):\/\/[^\s<>«»"')\]]+/gi;
const WWW_URL = /\bwww\.[^\s<>«»"')\]]+/gi;
const BARE_DOMAIN = new RegExp(`(?<![\\p{L}\\p{N}@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})(?![\\p{L}\\p{N}-])(?:[/?#][^\\s<>«»"')\\]]*)?`, 'giu');
/** Any dotted name followed by a path is an address whatever its ending: `shop.example/offer`. */
const DOMAIN_WITH_PATH = /(?<![\p{L}\p{N}@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s<>«»"')\]]*/giu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu;

/** Punctuation a sentence puts after a link, which is not part of it. */
const TRAILING = /[.,;:!?؟،؛…]+$/;

/**
 * `text` without any link, and what was taken out. Tries, in this order, a markdown link (its words stay), a URL with a scheme, a
 * `www.` address, an email address, a dotted name followed by a path (`shop.example/offer`, whatever its ending) and a bare domain
 * with a common ending (`example.com`, `wa.me/…`, `bit.ly/…`). The
 * sentence's own punctuation after a link stays. Spaces left behind are tidied; nothing else is rewritten.
 */
export function stripLinks(text: string): { text: string; removed: string[] } {
    const removed: string[] = [];
    const take = (match: string): string => {
        const tail = TRAILING.exec(match)?.[0] ?? '';
        removed.push(tail ? match.slice(0, -tail.length) : match);
        return tail;
    };
    const out = text
        .replace(MARKDOWN_LINK, (whole: string, label: string) => {
            removed.push(whole);
            return label;
        })
        .replace(SCHEME_URL, take)
        .replace(WWW_URL, take)
        .replace(EMAIL, take)
        .replace(DOMAIN_WITH_PATH, take)
        .replace(BARE_DOMAIN, take);
    if (removed.length === 0) return { text, removed };
    return { text: tidy(out), removed };
}

/** What a removal leaves behind: a pair of brackets or quotes with nothing in it, spaces doubled or before punctuation, ragged line ends. */
function tidy(text: string): string {
    return text
        .replace(/\(\s*\)|\[\s*\]|<\s*>|«\s*»|“\s*”|"\s*"/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/ +([.,;:!?؟،؛…])/g, '$1')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ─── Emoji that show a woman ─────────────────────────────────────────────────────────────────

/** Code points that make an emoji a woman or a girl: the person emoji themselves, and the female sign that turns a role emoji into one. */
const WOMAN_CODE_POINTS: ReadonlySet<number> = new Set([
    0x1f469, // woman
    0x1f467, // girl
    0x1f478, // princess
    0x1f470, // person with veil
    0x1f9d5, // woman with headscarf
    0x1f930, // pregnant woman
    0x1f931, // breast-feeding
    0x1f483, // woman dancing
    0x1f936, // Mrs Claus
    0x1f46d, // women holding hands
    0x1f6ba, // women's room
    0x2640, // female sign: the ZWJ sequences "person ♀" (woman technologist, woman shrugging…)
]);

/** `text` without the emoji that show a woman or a girl, whole graphemes at a time (a joined sequence goes as one), and how many went. */
export function stripWomenEmoji(text: string): { text: string; removed: number } {
    let removed = 0;
    const kept = graphemes(text).filter((g) => {
        for (const ch of g) {
            if (WOMAN_CODE_POINTS.has(ch.codePointAt(0)!)) {
                removed += 1;
                return false;
            }
        }
        return true;
    });
    return removed === 0 ? { text, removed } : { text: tidy(kept.join('')), removed };
}

// ─── Words ───────────────────────────────────────────────────────────────────────────────────

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A word list as an alternation of normalised words (`normalizeArabic`: the same folding the reply gets). */
const alternation = (words: readonly string[]): string => words.map((w) => escape(normalizeArabic(w))).join('|');

/** A letter-glued prefix Arabic puts on a word: and, so, with/in, to/for, like, and "the". */
const PREFIX = '(?:[وفبلك]?(?:ال)?)';

/** Currency words, each with the ISO codes it can mean ("ريال" is the Saudi, Qatari, Omani and Yemeni one). */
const SAR_FAMILY = ['SAR', 'QAR', 'OMR', 'YER', 'IRR'] as const;
const CURRENCY_WORDS: Readonly<Record<string, readonly string[]>> = {
    'ريال': SAR_FAMILY, 'ريالا': SAR_FAMILY, 'ريالات': SAR_FAMILY,
    'دولار': ['USD', 'CAD', 'AUD', 'NZD', 'SGD'], 'دولارا': ['USD', 'CAD', 'AUD', 'NZD', 'SGD'], 'دولارات': ['USD', 'CAD', 'AUD', 'NZD', 'SGD'],
    'درهم': ['AED', 'MAD'], 'دراهم': ['AED', 'MAD'],
    'جنيه': ['EGP', 'GBP', 'SDG'], 'جنيها': ['EGP', 'GBP', 'SDG'], 'جنيهات': ['EGP', 'GBP', 'SDG'],
    'دينار': ['KWD', 'BHD', 'JOD', 'IQD', 'LYD', 'TND', 'DZD'], 'دينارا': ['KWD', 'BHD', 'JOD', 'IQD', 'LYD', 'TND', 'DZD'], 'دنانير': ['KWD', 'BHD', 'JOD', 'IQD', 'LYD', 'TND', 'DZD'],
    'يورو': ['EUR'], 'شيكل': ['ILS'], 'شيكلا': ['ILS'], 'ليره': ['TRY', 'LBP', 'SYP'], 'ليرات': ['TRY', 'LBP', 'SYP'], 'روبيه': ['INR', 'PKR'],
    'dollar': ['USD', 'CAD', 'AUD', 'NZD', 'SGD'], 'dollars': ['USD', 'CAD', 'AUD', 'NZD', 'SGD'], 'bucks': ['USD'],
    'riyal': SAR_FAMILY, 'riyals': SAR_FAMILY, 'dirham': ['AED', 'MAD'], 'dirhams': ['AED', 'MAD'],
    'pound': ['GBP', 'EGP', 'SDG'], 'pounds': ['GBP', 'EGP', 'SDG'], 'euro': ['EUR'], 'euros': ['EUR'],
    'dinar': ['KWD', 'BHD', 'JOD', 'IQD', 'LYD', 'TND', 'DZD'], 'dinars': ['KWD', 'BHD', 'JOD', 'IQD', 'LYD', 'TND', 'DZD'],
    'usd': ['USD'], 'sar': ['SAR'], 'sr': ['SAR'], 'aed': ['AED'], 'egp': ['EGP'], 'kwd': ['KWD'], 'qar': ['QAR'], 'omr': ['OMR'],
    'bhd': ['BHD'], 'jod': ['JOD'], 'eur': ['EUR'], 'gbp': ['GBP'], 'cad': ['CAD'], 'aud': ['AUD'], 'inr': ['INR'],
    // Not "try": «try 3 prompts» is no price, and the Turkish lira is spelled out («ليرة») by the people who sell in it.
};
const CURRENCY_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
    '$': ['USD', 'CAD', 'AUD', 'NZD', 'SGD'], '€': ['EUR'], '£': ['GBP', 'EGP'], '﷼': SAR_FAMILY, '₪': ['ILS'], '¥': ['JPY', 'CNY'], '₹': ['INR'],
};
/** "ر.س" and "د.إ" are the Saudi riyal and the Emirati dirham in the abbreviations people type. */
const CURRENCY_ABBREVIATIONS: Readonly<Record<string, readonly string[]>> = { 'ر.س': ['SAR'], 'ر س': ['SAR'], 'د.ا': ['AED'], 'د.ك': ['KWD'], 'ج.م': ['EGP'] };

const WORDS_ALT = alternation(Object.keys(CURRENCY_WORDS));
const SYMBOLS_CLASS = `[${Object.keys(CURRENCY_SYMBOLS).map(escape).join('')}]`;
const ABBREVIATIONS_ALT = alternation(Object.keys(CURRENCY_ABBREVIATIONS));
const CODES_BY_WORD = new Map<string, readonly string[]>([
    ...Object.entries(CURRENCY_WORDS).map(([w, c]) => [normalizeArabic(w), c] as const),
    ...Object.entries(CURRENCY_ABBREVIATIONS).map(([w, c]) => [normalizeArabic(w), c] as const),
]);

/** A currency right after a number: «49 دولار», "49 USD", "49$", "49 ر.س". */
const CURRENCY_AFTER = new RegExp(`^\\s*(?:[-–—(]\\s*)?(?:(?<symbol>${SYMBOLS_CLASS})|(?:ال)?(?<word>${WORDS_ALT}|${ABBREVIATIONS_ALT})(?![\\p{L}]))`, 'u');
/** A currency right before one: "$49", "USD 49", "SAR: 49". */
const CURRENCY_BEFORE = new RegExp(`(?:(?<symbol>${SYMBOLS_CLASS})|(?<![\\p{L}])(?<word>${WORDS_ALT}|${ABBREVIATIONS_ALT}))\\s*[:=-]?\\s*$`, 'u');

/** "price", «سعر», «تكلفة», «ثمن»: the words that say the number after them is an amount of money. */
const PRICE_WORDS = ['سعر', 'اسعار', 'تكلف', 'تكلفة', 'ثمن', 'رسوم', 'price', 'priced', 'cost', 'costs', 'costing', 'pay', 'paying', 'fee', 'fees'];
const PRICE_BEFORE = new RegExp(`(?<![\\p{L}])${PREFIX}(?:${alternation(PRICE_WORDS)})\\p{L}{0,3}(?:\\s+\\p{L}{1,6}){0,2}[\\s:=-]*$`, 'u');

/** A number followed by one of these is a count of something, not an amount: "5 lessons" after "price" is not a price. */
const UNIT_AFTER = new RegExp(`^\\s*${PREFIX}(?:${alternation([
    'درس', 'دروس', 'ساعه', 'ساعات', 'دقيقه', 'دقائق', 'دقايق', 'يوم', 'ايام', 'اسبوع', 'اسابيع', 'شهر', 'شهور', 'اشهر', 'سنه', 'سنوات', 'سنين',
    'طالب', 'طلاب', 'متدرب', 'خطوه', 'خطوات', 'مشروع', 'مشاريع', 'وحده', 'وحدات', 'فيديو', 'فيديوهات', 'محاضره', 'محاضرات', 'تقييم', 'نجوم', 'نجمه',
    'lesson', 'lessons', 'hour', 'hours', 'minute', 'minutes', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years',
    'student', 'students', 'step', 'steps', 'project', 'projects', 'module', 'modules', 'video', 'videos', 'star', 'stars', 'rating', 'ratings',
])})(?![\\p{L}])`, 'u');

/** Number words, so that «خمسين دولار» and "fifty dollars" cannot slip past a check that looks for digits. */
const NUMBER_WORDS = [
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
    'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
    'واحد', 'اثنين', 'اثنان', 'ثنتين', 'ثلاثه', 'تلاته', 'ثلاث', 'اربعه', 'اربع', 'خمسه', 'خمس', 'سته', 'ست', 'سبعه', 'سبع', 'ثمانيه', 'ثمان', 'تمانيه',
    'تسعه', 'تسع', 'عشره', 'عشر', 'عشرين', 'ثلاثين', 'تلاتين', 'اربعين', 'خمسين', 'ستين', 'سبعين', 'ثمانين', 'تمانين', 'تسعين', 'ميه', 'مايه', 'مئه', 'مائه',
    'مئتين', 'ميتين', 'الف', 'الاف', 'ثلاثمائه', 'خمسمائه',
];
const NUMBER_WORD_SET: ReadonlySet<string> = new Set(NUMBER_WORDS.map((w) => normalizeArabic(w)));

/** Words that turn a reply into a promise about price. Each is a claim only the data may make, so each is allowed only if the data says it. */
const WORD_CLAIMS: readonly { kind: 'discount' | 'coupon' | 'free'; pattern: RegExp }[] = [
    { kind: 'discount', pattern: new RegExp(`(?<![\\p{L}])${PREFIX}(?:${alternation(['خصم', 'خصومات', 'تخفيض', 'تخفيضات', 'discount', 'discounts', 'discounted'])})(?![\\p{L}])`, 'u') },
    { kind: 'coupon', pattern: new RegExp(`(?<![\\p{L}])(?:${PREFIX}(?:${alternation(['كوبون', 'كوبونات', 'بروموكود', 'بروميكود', 'فاوتشر', 'coupon', 'coupons', 'voucher', 'vouchers'])})|(?:كود|code) ?(?:الخصم|خصم|discount)|promo ?code|discount ?code)(?![\\p{L}])`, 'u') },
    // "feel free to ask" is the ordinary use of the word: it is not a price.
    { kind: 'free', pattern: new RegExp(`(?<![\\p{L}])(?:${PREFIX}(?:${alternation(['مجاني', 'مجانا', 'مجانيه', 'مجانية', 'بلاش'])})|(?<!feel )free(?! to\\b)(?! time\\b))(?![\\p{L}])`, 'u') },
];

// ─── The check ───────────────────────────────────────────────────────────────────────────────

/** Codes a piece of text names as a currency: its words, symbols and abbreviations, and any three-letter code in it that is a known one. */
function currencyCodesIn(text: string): Set<string> {
    const found = new Set<string>();
    const folded = normalizeArabic(text);
    for (const [word, codes] of CODES_BY_WORD) if (new RegExp(`(?<![\\p{L}])(?:ال)?${escape(word)}(?![\\p{L}])`, 'u').test(folded)) codes.forEach((c) => found.add(c));
    for (const [symbol, codes] of Object.entries(CURRENCY_SYMBOLS)) if (text.includes(symbol)) codes.forEach((c) => found.add(c));
    return found;
}

/** The live prices' currency, as codes: the owner's `currency` if set, else what the price text names. Empty when it names none. */
function livePriceCodes(price: LivePrice): Set<string> {
    return price.currency ? new Set([price.currency]) : currencyCodesIn(price.text);
}

interface Mention {
    /** The number, canonical. */
    value: string;
    /** The currencies it names, as codes. Empty when it is an amount only by the word "price". */
    codes: Set<string>;
    /** What a violation quotes: the number as written, with the currency or price word beside it (folded: it is for a log, not a customer). */
    found: string;
}

/** The number at `span`, as an amount of money, or null when nothing beside it says it is one. */
function moneyMention(ascii: string, span: { value: string; start: number; end: number }): Mention | null {
    const raw = ascii.slice(span.start, span.end);
    const after = normalizeArabic(ascii.slice(span.end, span.end + 40));
    const before = normalizeArabic(ascii.slice(Math.max(0, span.start - 40), span.start));
    const codesOf = (word: string | undefined, symbol: string | undefined): Set<string> =>
        new Set<string>(word ? CODES_BY_WORD.get(word) ?? [] : symbol ? CURRENCY_SYMBOLS[symbol] ?? [] : []);

    const afterHit = CURRENCY_AFTER.exec(after);
    if (afterHit) {
        return { value: span.value, codes: codesOf(afterHit.groups?.word, afterHit.groups?.symbol), found: `${raw} ${afterHit[0].trim()}` };
    }
    const beforeHit = CURRENCY_BEFORE.exec(before);
    if (beforeHit) {
        return { value: span.value, codes: codesOf(beforeHit.groups?.word, beforeHit.groups?.symbol), found: `${beforeHit[0].trim()} ${raw}` };
    }
    // «السعر 49», "price is 49": an amount, unless it is plainly a count ("5 lessons") or a percentage.
    const priceHit = PRICE_BEFORE.exec(before);
    if (priceHit && !UNIT_AFTER.test(after) && !/^\s*[%٪]/.test(after)) {
        return { value: span.value, codes: new Set(), found: `${priceHit[0].trim()} ${raw}` };
    }
    return null;
}

/** Does this mention equal one of the live prices: the amount, and the currency if the reply names one and the price does too? */
function isLive(mention: Mention, prices: readonly LivePrice[]): boolean {
    return prices.some((price) => {
        if (!price.amounts.includes(mention.value)) return false;
        const priced = livePriceCodes(price);
        if (mention.codes.size === 0 || priced.size === 0) return true;
        return [...mention.codes].some((c) => priced.has(c));
    });
}

/** The words of `text`, folded, for the spelled-out-number check. */
const wordsOf = (text: string): string[] => normalizeArabic(text).split(/[^\p{L}\p{N}$€£﷼]+/u).filter(Boolean);

/**
 * Every claim in `text` the data does not make. Links are taken out of it first (`stripLinks`), so the digits inside a URL are never
 * counted as numbers, whether or not the caller already cleaned it (`guardReply` does).
 */
export function checkClaims(raw: string, facts: ClaimFacts): Violation[] {
    const violations: Violation[] = [];
    const text = stripLinks(raw).text;
    const ascii = normalizeDigits(text);

    // What the data allows: its numbers (links out: a referral code's digits are not facts), and its own discount, coupon and free words.
    const dataTexts = facts.texts.map((t) => stripLinks(t).text);
    const allowed = new Set<string>(dataTexts.flatMap((t) => [...extractNumbers(t)]));
    for (const price of facts.prices) price.amounts.forEach((a) => allowed.add(canonNumber(a)));
    const dataFolded = normalizeArabic(dataTexts.join('\n'));

    const spans = numberSpans(text);
    const seen = new Set<string>();
    for (const span of spans) {
        const mention = moneyMention(ascii, span);
        if (mention) {
            if (!isLive(mention, facts.prices) && !seen.has(`price:${mention.found}`)) {
                seen.add(`price:${mention.found}`);
                violations.push({ kind: 'price', found: mention.found });
            }
            continue;
        }
        if (!allowed.has(span.value) && !seen.has(`number:${span.value}`)) {
            seen.add(`number:${span.value}`);
            violations.push({ kind: 'number', found: span.value });
        }
    }

    // A price in words: a number word within two words of a currency, with no digits to check.
    const words = wordsOf(text);
    words.forEach((word, i) => {
        if (!CODES_BY_WORD.has(word.replace(/^ال/, '')) && !CODES_BY_WORD.has(word) && !(word in CURRENCY_SYMBOLS)) return;
        const near = [...words.slice(Math.max(0, i - 2), i), ...words.slice(i + 1, i + 3)];
        const spelled = near.find((w) => NUMBER_WORD_SET.has(w) || NUMBER_WORD_SET.has(w.replace(/^و/, '')));
        if (spelled && !seen.has(`price:${spelled} ${word}`)) {
            seen.add(`price:${spelled} ${word}`);
            violations.push({ kind: 'price', found: `${spelled} ${word}` });
        }
    });

    const folded = normalizeArabic(text);
    for (const { kind, pattern } of WORD_CLAIMS) {
        const hit = pattern.exec(folded);
        if (hit && !pattern.test(dataFolded)) violations.push({ kind, found: hit[0] });
    }
    return violations;
}

export interface GuardedReply {
    /** The reply with its links and its women emoji taken out. Send this, never the model's own text. */
    text: string;
    /** What the data does not support. Empty means the reply may be sent. */
    violations: Violation[];
    ok: boolean;
    /** The links the model wrote, as it wrote them: logged, never sent. */
    linksRemoved: string[];
    womenEmojiRemoved: number;
}

/** A reply, cleaned and checked: links out, women emoji out, then every claim against the data. */
export function guardReply(text: string, facts: ClaimFacts): GuardedReply {
    const noLinks = stripLinks(text);
    const noWomen = stripWomenEmoji(noLinks.text);
    const violations = checkClaims(noWomen.text, facts);
    return { text: noWomen.text, violations, ok: violations.length === 0, linksRemoved: noLinks.removed, womenEmojiRemoved: noWomen.removed };
}
