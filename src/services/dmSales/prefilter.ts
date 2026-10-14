/**
 * What is decided BEFORE the model sees a message (docs/DM_SALES_PLAN.md §6). Pure.
 *
 * A person asking for their money back, threatening to report, telling the bot to stop, or insulting it must not be answered with sales
 * text, and must not wait on a model that might. So the message is read first, for a short list of words in Arabic (فصحى, Gulf and
 * Egyptian, plus the Levantine and Maghrebi words that overlap) and English, and one of four things is decided:
 *
 *   refund      → handoff, reason `refund`       استرجاع، استرداد، فلوسي، رجعوا الفلوس، refund, money back, chargeback
 *   complaint   → handoff, reason `complaint`    شكوى، نصب، احتيال، نصابين، بلاغ، محامي، scam, fraud, complaint, lawyer
 *   opt_out     → opt-out                        وقف، توقف، لا تراسلني، ما ابي رسايل، بطلوا تبعتولي، stop, unsubscribe, don't message me
 *   abuse       → handoff, reason `abuse`        directed insults and profanity (S6 answers the first with one calm line, pauses on the second)
 *
 * Precedence: refund, complaint, opt-out, abuse. A person who asks for a refund AND says stop needs the owner (the handoff pauses the
 * bot as an opt-out does), so it is a handoff whose `also` carries `opt_out`: S6 records the opt-out too. `also` lists every other
 * thing the message said, so nothing it matched is lost to the first.
 *
 * **Recall over precision, with limits.** A false positive costs a handoff (a person reads one message); a miss costs a refund request
 * answered with a pitch. So refund and complaint words match anywhere in the message, as a word (with the one-letter prefixes Arabic
 * glues on: والنصب, للاسترجاع). The two that are ordinary words in other sentences are narrower:
 *
 *   - **stop** is an opt-out only as the whole message («وقف», "STOP", "stop please"), or inside a phrase that says what to stop
 *     («توقفوا عن مراسلتي», "stop messaging me"), or as a negation of contact («لا تراسلني», «ما ابي رسايل», «متبعتليش»). "I can't stop
 *     thinking about it" and «كيف أوقف الاشتراك» are questions, and go to the model.
 *   - **insults** are directed («يا غبي», «انت نصاب», "you idiot") or unmistakable («خرا», "asshole"); «سؤال غبي» ("a silly question") and
 *     "fucking great" are not hits.
 *
 * Words are matched after folding: lower case, Arabic letters unified (أإآ→ا, ى→ي, ة→ه, marks and tatweel out: `normalizeArabic`), stretched
 * letters collapsed («فلوووسي»), apostrophes dropped ("don't" is "dont"), and everything that is not a letter or digit a separator.
 */
import { normalizeArabic } from '../../utils/arabic.js';

export type PrefilterSignal = 'refund' | 'complaint' | 'opt_out' | 'abuse';

export type PrefilterDecision =
    | { action: 'pass' }
    | { action: 'handoff'; reason: 'refund' | 'complaint' | 'abuse'; matched: string; also: PrefilterSignal[] }
    | { action: 'opt_out'; matched: string; also: PrefilterSignal[] };

/** A message longer than this is read up to here: no real request to stop is hidden after four thousand characters. */
const MAX_CHARS = 4000;

/** The message as a list of folded words. */
export function words(text: string): string[] {
    const folded = normalizeArabic(text.slice(0, MAX_CHARS).normalize('NFKC'))
        .replace(/[‌-‏‪-‮]/g, '')
        .replace(/['’`]/g, '')
        .replace(/(\p{L})\1{2,}/gu, '$1');
    return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** A phrase, folded the way a message is. */
const phrase = (p: string): string[] => words(p);

const ARABIC_LETTER = /\p{Script=Arabic}/u;
/** What Arabic glues to the front of a word: and, so, with, to, like, "the", and their pairs. */
const CLITICS = ['و', 'ف', 'ب', 'ل', 'ك', 'ال', 'وال', 'بال', 'لل', 'فال', 'كال', 'ولل', 'وب', 'ول'] as const;

function sameWord(word: string, wanted: string, clitic: boolean): boolean {
    if (word === wanted) return true;
    return clitic && ARABIC_LETTER.test(wanted) && CLITICS.some((c) => word === c + wanted);
}

/** Is `wanted` (a phrase, as words) in `tokens`, in a row? The first word may carry a clitic; the rest are exact. */
function hasPhrase(tokens: readonly string[], wanted: readonly string[]): boolean {
    if (wanted.length === 0) return false;
    for (let i = 0; i + wanted.length <= tokens.length; i++) {
        if (wanted.every((w, j) => sameWord(tokens[i + j]!, w, j === 0))) return true;
    }
    return false;
}

/** The first of `phrases` that `tokens` hold, as written in the list, or null. */
function firstOf(tokens: readonly string[], phrases: readonly (readonly string[])[]): string | null {
    const hit = phrases.find((p) => hasPhrase(tokens, p));
    return hit ? hit.join(' ') : null;
}

const list = (...entries: string[]): readonly (readonly string[])[] => entries.map(phrase).filter((p) => p.length > 0);

// ─── Refund ──────────────────────────────────────────────────────────────────────────────────

const REFUND = list(
    // فصحى
    'استرجاع', 'استرجع', 'استرداد', 'استرد', 'ارجاع المبلغ', 'ارجاع الاموال', 'ارجاع الفلوس', 'اعادة المبلغ', 'اعادة الاموال', 'رد المبلغ', 'رد الاموال',
    'اموالي', 'استرجاع المبلغ',
    // خليجي ومصري
    'فلوسي', 'رد الفلوس', 'ردوا الفلوس', 'ردولي الفلوس', 'رجع الفلوس', 'رجعوا الفلوس', 'رجعولي الفلوس', 'رجعلي الفلوس', 'ارجع الفلوس', 'ارجعوا الفلوس',
    'ارجعولي الفلوس', 'رجع المبلغ', 'رجعوا المبلغ', 'ارجعوا المبلغ', 'ريفند',
    // English
    'refund', 'refunds', 'refunded', 'money back', 'want my money', 'give me my money', 'get my money', 'return my money', 'where is my money',
    'chargeback', 'charge back', 'dispute the charge', 'dispute this charge',
);

// ─── Complaint ───────────────────────────────────────────────────────────────────────────────

const COMPLAINT = list(
    // فصحى
    'شكوى', 'شكاوى', 'اشتكي', 'اشتكيكم', 'ساشتكي', 'سأشتكي', 'نصب', 'نصاب', 'نصابين', 'نصابه', 'احتيال', 'محتال', 'محتالين', 'غشاشين', 'غش', 'سرقه', 'سارق',
    'سارقين', 'بلاغ', 'ابلاغ', 'ابلغ عنكم', 'سابلغ عنكم', 'رفع قضية', 'رفع دعوى', 'ارفع قضية', 'سارفع قضية', 'محامي', 'حماية المستهلك', 'كذابين', 'كذاب',
    // خليجي ومصري
    'حرامي', 'حرامية', 'هشتكي', 'هشتكيكم', 'بشتكي', 'بشتكيكم', 'هبلغ عنكم', 'بابلغ عنكم', 'هرفع قضية', 'برفع قضية', 'هرفع دعوى', 'برفع دعوى', 'هقدم شكوى',
    'نصبتوا', 'نصبتم', 'نصبوا علي', 'تنصبوا', 'ضحكتوا علي', 'ضحكتوا عليا', 'ضحكتم علي', 'ضحكوا علي',
    // English
    'complaint', 'complaints', 'complain', 'complaining', 'scam', 'scams', 'scammer', 'scammers', 'scammed', 'fraud', 'fraudulent', 'rip off', 'ripoff',
    'ripped off', 'cheated', 'report you', 'report this', 'legal action', 'lawyer', 'consumer protection', 'sue you', 'trading standards',
);

// ─── Abuse ───────────────────────────────────────────────────────────────────────────────────

const ABUSE = list(
    // Directed: «سؤال غبي» ("a silly question") is said politely all the time, «يا غبي» never is.
    'يا غبي', 'يا غبيه', 'انت غبي', 'انتي غبيه', 'انتم اغبياء', 'يا اغبياء', 'يا كلب', 'يا كلاب', 'انت كلب', 'يا حمار', 'يا حمير', 'انت حمار', 'يا حيوان', 'انت حيوان',
    'يا خنزير', 'يا وسخ', 'يا قذر', 'انت قذر', 'ابن الكلب', 'ابن الحرام', 'ابن الحرمه',
    // Unmistakable on their own.
    'حقير', 'حقيره', 'حقيرين', 'حقيرون', 'زفت', 'خرا', 'خره', 'تفو', 'اخرس', 'اخرسوا', 'يلعن', 'يلعنكم', 'لعنه الله عليكم', 'عرص', 'شرموط', 'شرموطه', 'خول', 'كسمك', 'كس امك', 'كس امكم',
    'ابن المتناكه',
    // English
    'fuck you', 'fuck off', 'fuck u', 'fuck your', 'shut the fuck up', 'go fuck', 'piece of shit', 'bitch', 'asshole', 'bastard', 'scumbag', 'dumbass', 'go to hell',
    'shut up', 'stfu', 'screw you', 'you idiot', 'you idiots', 'you moron', 'you morons', 'such an idiot', 'idiots', 'morons', 'you are stupid', 'youre stupid',
    'you are an idiot', 'youre an idiot',
);

// ─── Opt-out ─────────────────────────────────────────────────────────────────────────────────

/** "Stop", alone or with only politeness around it. */
const STOP_WORDS: ReadonlySet<string> = new Set(
    ['stop', 'unsubscribe', 'ستوب', 'وقف', 'وقفوا', 'توقف', 'توقفوا', 'ايقاف', 'اوقف', 'اوقفوا'].flatMap((w) => words(w)),
);
const FILLERS: ReadonlySet<string> = new Set([
    'please', 'pls', 'plz', 'thanks', 'thank', 'you', 'now', 'all', 'it', 'ok', 'okay', 'messages', 'message', 'messaging', 'texting', 'dms', 'dm', 'me',
    ...['من', 'فضلك', 'فضلكم', 'لو', 'سمحت', 'سمحتوا', 'سمحتم', 'تكرمت', 'تكرمتوا', 'ارجوك', 'ارجوكم', 'شكرا', 'الان', 'دلوقتي', 'الحين', 'الرسائل', 'الرسايل', 'رسايل', 'رسائل', 'عني', 'خلاص', 'يا', 'اخي', 'اخ', 'استاذ',
        'معليش', 'عفوا', 'والله', 'ياخي', 'بقي', 'بس', 'كل', 'شي', 'شيء'].flatMap((w) => words(w)),
]);

/** Phrases that say what to stop, or that contact is unwelcome. The negations built from a verb are below. */
const OPT_OUT_PHRASES = list(
    'stop messaging', 'stop texting', 'stop sending', 'stop contacting', 'stop dming', 'stop dm', 'dont message me', 'do not message me', 'dont text me', 'do not text me',
    'dont contact me', 'do not contact me', 'dont dm me', 'unsubscribe', 'opt out', 'optout', 'leave me alone', 'remove me from', 'take me off', 'no more messages', 'no more dms',
    'توقف عن مراسلتي', 'توقفوا عن مراسلتي', 'توقف عن ارسال', 'توقفوا عن ارسال', 'وقف الرسايل', 'وقفوا الرسايل', 'وقف الرسائل', 'وقفوا الرسائل', 'ايقاف الرسائل', 'ايقاف الرسايل',
    'الغاء الاشتراك', 'الغاء اشتراكي', 'الغي اشتراكي', 'احذفني من', 'شيلني من', 'امسحني من', 'سيبني في حالي', 'سيبوني في حالي', 'خلوني في حالي', 'خلني في حالي',
    'فكني منكم', 'فكوني منكم', 'كفايه رسايل', 'كفايه رسائل', 'بطل تبعتلي', 'بطلوا تبعتولي', 'بطلوا ترسلوا', 'بطل ترسل', 'بطل تراسلني', 'بطلوا تراسلوني',
);

/** «لا» / «ما» / «مش»: the negations that, before a verb of contact or a wish for messages, say "do not". */
const NEGATIONS: ReadonlySet<string> = new Set(['لا', 'ما', 'مش', 'مو', 'ماني', 'مب', 'لن'].flatMap((w) => words(w)));
/** Verbs that mean contacting me: after a negation, unmistakable. «متبعتليش» already holds its own negation. */
const CONTACT_STRONG: ReadonlySet<string> = new Set(
    ['تراسلني', 'تراسلوني', 'تزعجني', 'تزعجوني', 'تضايقني', 'تضايقوني', 'تكلمني', 'تكلموني', 'تتصل', 'تتصلوا', 'تتصلي'].flatMap((w) => words(w)),
);
const CONTACT_NEGATED: ReadonlySet<string> = new Set(
    ['متبعتليش', 'ماتبعتليش', 'متبعتلنيش', 'متبعتوليش', 'ماتبعتوليش', 'متراسلنيش', 'متراسلونيش', 'ماتراسلنيش', 'متكلمنيش', 'ماتكلمنيش', 'متتصلش', 'ماتتصلش'].flatMap((w) => words(w)),
);
/** Verbs of sending, which are only about contact when a word for messages follows: «لا ترسل لي الرابط» is not a request to stop. */
const CONTACT_WEAK: ReadonlySet<string> = new Set(
    ['ترسل', 'ترسلوا', 'ترسلي', 'تبعتلي', 'تبعتولي', 'ترسلولي', 'تبعت', 'تبعتوا', 'تبعتلنا'].flatMap((w) => words(w)),
);
/** What may stand between a wish or a verb of sending and the word for messages: «ما ابي اي رسايل», «لا ترسل لي رسائل». Nothing else: «ما ابي ابعت رسالة» is not a stop. */
const MIDDLE: ReadonlySet<string> = new Set(
    ['اي', 'ايه', 'كل', 'اكتر', 'اكثر', 'المزيد', 'مزيد', 'تاني', 'ثاني', 'لي', 'الي', 'لنا', 'عندي', 'بعد'].flatMap((w) => words(w)),
);
const WISHES: ReadonlySet<string> = new Set(
    ['ابي', 'ابغي', 'ابغى', 'اريد', 'عايز', 'عاوز', 'عايزه', 'عاوزه', 'بدي', 'احتاج', 'نفسي', 'ودي'].flatMap((w) => words(w)),
);
const MESSAGES: ReadonlySet<string> = new Set(
    ['رسايل', 'رسائل', 'رساله', 'رسالات', 'مراسله', 'تواصل', 'اتصالات', 'اشعارات', 'ايميلات', 'اعلانات', 'messages', 'dms', 'texts', 'emails'].flatMap((w) => words(w)),
);

/** «لاتراسلني»: a negation glued to its verb, as people type it, read as two words. */
function unglue(tokens: readonly string[]): string[] {
    return tokens.flatMap((t) => {
        for (const neg of ['لا', 'ما']) {
            const rest = t.startsWith(neg) ? t.slice(neg.length) : '';
            if (rest.length >= 4 && (CONTACT_STRONG.has(rest) || CONTACT_WEAK.has(rest))) return [neg, rest];
        }
        return [t];
    });
}

/** A negation, then (within a few words) a verb of contact, or a wish and then (within a few words) a word for messages. Returns what matched, or null. */
function negatedContact(raw: readonly string[]): string | null {
    const tokens = unglue(raw);
    for (let i = 0; i < tokens.length; i++) {
        const word = tokens[i]!;
        if (CONTACT_NEGATED.has(word)) return word;
        // «ولا تراسلني»: the negation may carry the «و» or «ف» of the sentence before it.
        if (!NEGATIONS.has(word) && !NEGATIONS.has(word.replace(/^[وف]/, ''))) continue;
        const window = tokens.slice(i + 1, i + 5);
        const strong = window.find((w) => CONTACT_STRONG.has(w));
        if (strong) return `${word} ${strong}`;
        for (let p = i + 1; p < Math.min(tokens.length, i + 5); p++) {
            if (!WISHES.has(tokens[p]!) && !CONTACT_WEAK.has(tokens[p]!)) continue;
            const said = messageAfter(tokens, p);
            if (said) return `${word} ${tokens[p]} ${said}`;
        }
    }
    return null;
}

/** The word for messages right after position `p`, past at most two of `MIDDLE`, or null. */
function messageAfter(tokens: readonly string[], p: number): string | null {
    let k = p + 1;
    while (k < tokens.length && k <= p + 2 && MIDDLE.has(tokens[k]!)) k++;
    const word = tokens[k];
    return word !== undefined && MESSAGES.has(word) ? word : null;
}

/** The whole message is "stop", perhaps with a please. */
function bareStop(tokens: readonly string[]): string | null {
    if (tokens.length === 0 || tokens.length > 5) return null;
    const stop = tokens.find((t) => STOP_WORDS.has(t));
    if (!stop) return null;
    return tokens.every((t) => STOP_WORDS.has(t) || FILLERS.has(t)) ? stop : null;
}

function optOutOf(tokens: readonly string[]): string | null {
    return bareStop(tokens) ?? firstOf(tokens, OPT_OUT_PHRASES) ?? negatedContact(tokens);
}

/**
 * What to do with this message before the model reads it. `pass` is the common answer: nothing in it needs a person or a stop.
 * Never throws: a message that is not text passes.
 */
export function prefilter(message: unknown): PrefilterDecision {
    if (typeof message !== 'string' || !message.trim()) return { action: 'pass' };
    const tokens = words(message);
    if (tokens.length === 0) return { action: 'pass' };

    const found: { signal: PrefilterSignal; matched: string }[] = [];
    const refund = firstOf(tokens, REFUND);
    if (refund) found.push({ signal: 'refund', matched: refund });
    const complaint = firstOf(tokens, COMPLAINT);
    if (complaint) found.push({ signal: 'complaint', matched: complaint });
    const optOut = optOutOf(tokens);
    if (optOut) found.push({ signal: 'opt_out', matched: optOut });
    const abuse = firstOf(tokens, ABUSE);
    if (abuse) found.push({ signal: 'abuse', matched: abuse });

    const first = found[0];
    if (!first) return { action: 'pass' };
    const also = found.slice(1).map((f) => f.signal);
    if (first.signal === 'opt_out') return { action: 'opt_out', matched: first.matched, also };
    return { action: 'handoff', reason: first.signal, matched: first.matched, also };
}
