#!/usr/bin/env node
/**
 * The register guard (UX plan U5, research SA-08): the Arabic Help is Modern Standard Arabic (فصحى), never a dialect.
 *
 * The Help was written in a light Gulf register («وش يسوّي لك»). The product's Arabic is one language, فصحى, for the screens and
 * the Help alike (docs/UX_AND_BRAND_PLAN_2026-12.md §3), so a dialect word in an Arabic Help string fails the build, the way
 * check-voice.mjs fails a banned word: a register that lives only in a plan is read once.
 *
 * WHAT IS SCANNED: every Arabic string of `dashboard/js/help-content.js` (titles, summaries, section titles, every block of every
 * body), read through the real object, so the English next to it and the comments around it are never copy. Only the Help: the
 * dictionaries have their own pass (SA-08's second half) and carry colloquial strings of their own until it lands.
 *
 * HOW A WORD IS MATCHED: whole word, after marks and tatweel are dropped and every alef is a plain alef. Alef maqsura is NOT folded
 * to yeh here (check-voice.mjs does fold it): «سوى» («except») is فصحى and «يسوّي» is not, and folding would make them one word.
 * A word may carry the clitics و / ف and ب / ل / ك («باللي», «وعشان»).
 *
 * THE LIST is a list of words that are not فصحى at all (Gulf, Levantine, Egyptian). A word that is both a dialect word and a real
 * word is left off, or matched only in its dialect shape: «حق» is a noun («حق الوصول», a right) and is flagged only with a
 * pronoun («حقي», «حقك») or as the possessive between two definite nouns («الرابط حق الدورة»); «قاعدة» is a rule and is never touched.
 * Anything else that has to stay (a dialect word quoted on purpose) goes on ALLOWED, with a reason; an entry that matches nothing
 * FAILS, so the list only shrinks.
 *
 * Usage: `npm run check:register` (exits 1 and prints slug#section, the word and the sentence). The functions are exported for
 * check-register.test.mjs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const HELP_FILE = 'dashboard/js/help-content.js';

/** Arabic with marks and tatweel dropped and alefs unified. Alef maqsura and teh marbuta stay as written. */
export function plain(s) {
    return s
        .replace(/[ً-ٰٟۖ-ۭ]/g, '')
        .replace(/ـ/g, '')
        .replace(/[أإآٱ]/g, 'ا');
}

const L = '(?<![\\p{L}\\p{M}])';
const R = '(?![\\p{L}\\p{M}])';
const CLITIC = '(?:[وف]?[بلك]?)';

/** `id`, a `why` that names the فصحى word, and `words`: alternatives, as regex source over `plain` text. `bare`: no clitic may stand before it («فورا» is ف + فورا, not ف + ورا). */
export const MARKERS = [
    { id: 'wesh', why: '«وش / ايش / شو» -> «ماذا»', words: 'وش|ويش|ايش|اش|شو|ايه' },
    { id: 'shlon', why: '«شلون / كيفك» -> «كيف»', words: 'شلون|شلونك|شلونها|كيفك' },
    { id: 'leish', why: '«ليش / ليه» -> «لماذا»', words: 'ليش|ليه|لييش|لیش' },
    { id: 'wein', why: '«وين» -> «أين»', words: 'وين|فين' },
    { id: 'zay', why: '«زي» -> «مثل»', words: 'زي|زيي|زيهم|زيك' },
    { id: 'eshan', why: '«عشان / علشان» -> «لأن» أو «من أجل»', words: 'عشان|علشان|عشانك|عشانه' },
    { id: 'haq', why: '«حقي / حقك / الرابط حق الدورة» -> «لي / لك / رابط الدورة»', words: 'حقي|حقك|حقتي|حقتك' },
    { id: 'want', why: '«يبي / يبغى / أبي / تبي» -> «يريد / أريد / تريد»', words: 'يبي|يبغي|يبغى|ابي|ابغي|ابغى|تبي|تبغي|تبغى|نبي|نبغي|يبون|يبغون|تبون|بغيت|يبيله|يبيلها|يبيلك|يبيله|يبيها|يبيه|ودي|وده|ودك' },
    { id: 'elli', why: '«اللي» -> «الذي / التي / الذين» (أو «ما»)', words: 'اللي|اللى|للي' },
    { id: 'mu', why: '«مو / مب / موب / مش» -> «ليس / لا»', words: 'مو|مب|موب|مش|مافي|فيش' },
    { id: 'yemdi', why: '«ما يمديك / يمديك» -> «لا يمكنك»', words: 'يمديك|يمدي|يمديني|تمدي|يمدينا|يمديه|يمدينا' },
    { id: 'shay', why: '«شي / شيّ» -> «شيء»', words: 'شي|شيي|شئ' },
    { id: 'bas', why: '«بس» -> «فقط / لكن»', words: 'بس|بسّ' },
    { id: 'kaman', why: '«كمان / برضه / برضو» -> «أيضاً»', words: 'كمان|برضه|برضو|برده|بردو' },
    { id: 'dem', why: '«هذي / هاذي / هادي / ذي / هيك / كده» -> «هذه / هكذا»', words: 'هذي|هاذي|هاذا|هادي|هادا|هاد|ذي|هيدا|هيدي|هيك|كده|كدا|كذا|هاي' },
    { id: 'dem-eg', why: '«ده / دي» -> «هذا / هذه»', bare: true, words: 'ده|دي' },
    { id: 'hal', why: '«هالـ» -> «هذا / هذه»', words: 'هال(?:شي|شيء|رسالة|رساله|حساب|رابط|خطوة|خطوه|كلمة|كلمه|صفحة|صفحه|بوست|منشور|فيديو|ريل|زر|خيار|تعليق|حملة|حمله|وقت|مرة|مره|مشكلة|مشكله|نوع|طريقة|طريقه|اشياء|الاشياء)' },
    { id: 'now', why: '«الحين / دحين / هسا / دلوقتي / هلق» -> «الآن»', words: 'الحين|دحين|دحينه|هسا|هسه|دلوقتي|دلوقت|هلق|هلأ' },
    { id: 'later', why: '«بعدين» -> «لاحقاً / بعد ذلك»', words: 'بعدين|بعدهين' },
    { id: 'always', why: '«دايما / دايم» -> «دائماً»', words: 'دايما|دايم|دايمه' },
    { id: 'sure', why: '«اكيد» -> «بالتأكيد»', words: 'اكيد|اكيده' },
    { id: 'little', why: '«شوية / شوي» -> «قليلاً»', words: 'شويه|شوية|شوي' },
    { id: 'much', why: '«كتير / واجد» -> «كثير»', words: 'كتير|واجد' },
    { id: 'do', why: '«يسوّي / سوّي / نسوي» -> «يفعل / يصنع / يجري»', words: '[ينتا]سو(?:ي|ون|ين)|اسوي|سوي|سويت|سوينا|سويتها|سويتي' },
    { id: 'see', why: '«شوف / تشوف / شفت» -> «انظر / ترى / رأيت»', words: 'شوف|شوفي|شوفوا|[ينتا]شوف|شفت|شفنا|شفتها|شايف|شايفين' },
    { id: 'come', why: '«جاي / يجي / تجي» -> «قادم / يأتي / تأتي»', words: 'جاي|جايك|جايه|جايين|جاية|يجي|تجي|نجي|اجي|يجيك|يجيه|يجيها|يجيهم|يجيني|جيت|جينا' },
    { id: 'go', why: '«يروح / تروح / اروح» -> «يذهب / تذهب»', words: 'يروح|تروح|اروح|نروح|يروحون|تروحون|رحت' },
    { id: 'will-go', why: '«راح + فعل» -> «سوف / س»', words: 'راح(?=\\s+[ينتا]\\p{L}{2,})|رح(?=\\s+[ينتا]\\p{L}{2,})' },
    { id: 'instead', why: '«بدال» -> «بدلاً من»', words: 'بدال|بدالك|بدالي|بدالنا|بدالها|بدالهم|بداله' },
    { id: 'front', why: '«قدام / ورا / جوا / جوه» -> «أمام / وراء / داخل»', bare: true, words: 'قدام|ورا|جوا|جوه|برا|بره' },
    { id: 'sleep', why: '«نايم» -> «نائم»', words: 'نايم|نايمه|نايمين|صاحي|صاحيين' },
    { id: 'we-you', why: '«حنا / احنا / انتو / انتوا» -> «نحن / أنتم»', words: 'حنا|احنا|انتو|انتوا' },
    { id: 'ala', why: '«ع» وحدها -> «على»', bare: true, words: 'ع' },
    { id: 'nice', why: '«حلو / منيح» -> «جيد / جميل»', words: 'حلو|حلوه|حلوة|منيح|منيحه' },
    { id: 'again', why: '«مرة ثانية / مرة وحدة» -> «مرة أخرى / مرة واحدة»', words: '(?:مره|مرة)\\s+(?:ثانيه|ثانية|وحده|وحدة)' },
];

const MARKER_RES = MARKERS.map((m) => ({ ...m, re: new RegExp(`${L}${m.bare ? '' : CLITIC}(?:${m.words})${R}`, 'gu') }));

/** «الرابط حق الدورة»: «حق» between a definite noun and a definite noun is the possessive, not «a right». */
const POSSESSIVE_HAQ = new RegExp(`${L}ال\\p{L}+\\s+(حق)\\s+ال\\p{L}+`, 'gu');

/** The dialect words in one piece of Arabic: `{ rule, word, why, index }` in the text as `plain` makes it. */
export function dialectHits(text) {
    const t = plain(text);
    const hits = [];
    for (const m of MARKER_RES) {
        for (const x of t.matchAll(m.re)) hits.push({ rule: m.id, word: x[0].trim(), why: m.why, index: x.index });
    }
    for (const x of t.matchAll(POSSESSIVE_HAQ)) hits.push({ rule: 'haq', word: x[0], why: '«الرابط حق الدورة» -> «رابط الدورة»', index: x.index });
    return hits;
}

// ─── The Help's Arabic strings ──────────────────────────────────────────────────────────────────────────────────────────

/** Every Arabic string of the Help content, each with where it is: `slug#section`, `title`, `summary`, `group <id>`. */
export function helpArabic(source, file = HELP_FILE) {
    const sandbox = { globalThis: undefined };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const content = vm.runInContext(`${source}\n;HelpContent`, sandbox, { filename: file });
    const out = [];
    const walk = (value, where) => {
        if (typeof value === 'string') out.push({ file, where, text: value });
        else if (Array.isArray(value)) value.forEach((v) => walk(v, where));
        else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, where));
    };
    for (const g of content.groups ?? []) walk(g.title?.ar, `group ${g.id}`);
    for (const a of content.articles ?? []) {
        walk(a.title?.ar, `${a.slug} title`);
        walk(a.summary?.ar, `${a.slug} summary`);
        for (const s of a.sections ?? []) {
            walk(s.title?.ar, `${a.slug}#${s.id} title`);
            walk(s.body?.ar, `${a.slug}#${s.id}`);
        }
    }
    return out;
}

/** A line of the source for a piece of text, so a finding names one (the first 24 characters, as written; 0 when it cannot be found). */
export function lineOf(source, text) {
    const head = text.slice(0, 24);
    const at = source.indexOf(head);
    return at < 0 ? 0 : 1 + (source.slice(0, at).match(/\n/g) ?? []).length;
}

/**
 * Entries that excuse ONE word in ONE place, with a reason:
 *   where  `slug#section` (or a prefix of it)
 *   rule   the marker id
 *   text   the sentence it excuses (must hold it, and the word)
 *   reason why it has to stay
 */
export const ALLOWED = [];

const entryCovers = (e, f) => f.where.startsWith(e.where) && e.rule === f.rule && plain(f.text).includes(plain(e.text)) && plain(e.text).includes(plain(f.word));

/** What `findings` leave once `allowed` is applied, and the entries that covered nothing (a stale entry is a failure too). */
export function judge(findings, allowed = ALLOWED) {
    const used = new Set();
    const remaining = findings.filter((f) => {
        const covering = allowed.filter((e) => entryCovers(e, f));
        covering.forEach((e) => used.add(e));
        return covering.length === 0;
    });
    return { findings: remaining, stale: allowed.filter((e) => !used.has(e)) };
}

/** The verdict over the Help source: `{ findings, stale, pieces }`. */
export function scanHelp(source, allowed = ALLOWED, file = HELP_FILE) {
    const pieces = helpArabic(source, file);
    const findings = pieces.flatMap((p) => dialectHits(p.text).map((h) => ({ file, where: p.where, line: lineOf(source, p.text), rule: h.rule, word: h.word, why: h.why, text: p.text })));
    return { ...judge(findings, allowed), pieces };
}

function excerpt(text, word) {
    const t = text.replace(/\s+/g, ' ');
    const i = Math.max(0, t.indexOf(word) - 28);
    return `${i > 0 ? '…' : ''}${t.slice(i, i + 90 + word.length)}${i + 90 + word.length < t.length ? '…' : ''}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { findings, stale, pieces } = scanHelp(readFileSync(HELP_FILE, 'utf8'));
    if (findings.length || stale.length) {
        if (findings.length) {
            console.error(`register: ${findings.length} dialect word${findings.length === 1 ? '' : 's'} in the Arabic Help (UX plan U5, SA-08: the Help is فصحى)\n`);
            for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}] «${f.word}» in ${f.where}\n      ${excerpt(f.text, f.word)}\n      ${f.why}`);
            console.error('\nRewrite the sentence in فصحى. If a dialect word has to be quoted, add it to ALLOWED in scripts/check-register.mjs with a reason.');
        }
        for (const e of stale) console.error(`register: the ALLOWED entry for ${e.where} [${e.rule}] "${e.text}" matches nothing any more: delete it from scripts/check-register.mjs`);
        process.exit(1);
    }
    console.log(`register ok: ${pieces.length} Arabic strings of the Help, ${MARKERS.length} dialect rules, ${ALLOWED.length} allowed uses, none broken`);
}
