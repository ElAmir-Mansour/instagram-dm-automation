#!/usr/bin/env node
/**
 * The voice guard (identity B3): the words the product never says, searched for in the copy it ships.
 *
 * docs/brand/IDENTITY.md §7 ("Never") and DESIGN.md §7 ("Don't") name them: "Pro" outside the name, Premium, Powered by, instant,
 * guaranteed, AI-powered, bot, revolutionary, all-in-one, magic, viral, growth hack, supercharge, unlimited, "trusted by", "ManyChat
 * alternative", and the Arabic of each (فوراً، مضمون، ذكي، بوت، ثوري، متكامل، سحري، تريند، ضاعف، بلا حدود). A voice rule that lives only
 * in a document is read once; this makes it fail a build.
 *
 * WHAT IS SCANNED, and nothing else:
 *   - Both dashboard dictionaries (`dashboard/js/i18n.ar.js`, `i18n.en.js`): every VALUE, evaluated, so a key written twice is read the
 *     way the browser reads it, and the comments around the keys (which discuss these words) are never copy.
 *   - Every `public/*.html` and the dashboard shell (`dashboard/index.html`): the text nodes and the attributes a
 *     reader or a crawler sees (`<title>`, the description / og / twitter meta, `alt`, `title`, `aria-label`, `placeholder`) and the
 *     JSON-LD blocks. NOT HTML comments (the claim ledger in landing.html explains what the page may not say, so it names every word on
 *     this list), NOT `<style>`, NOT the page's scripts (code, not copy).
 *
 * THE NAME IS ALLOWED. "AutoReply Pro" and «أوتوريبلاي برو» are the registered name (Meta, TikTok, Google OAuth, /terms, titles); they
 * are taken out of the text before any rule runs, so "Pro" is banned only when it stands anywhere else: a plan, a tier, a feature.
 *
 * A LIMIT STATED IS ALLOWED: "not guaranteed", "no guarantee", «لا نضمن», «بلا ضمان», «غير مضمون». DESIGN.md asks every page to "say what
 * is NOT promised", and a guard that bans the honest sentence would push the copy to hide it. Only the three words a limit is naturally
 * written with (guaranteed, instant, unlimited, and their Arabic) are negatable, and only when a negator stands DIRECTLY before the
 * word (at most a filler such as "be" or "always"): a window any wider lets "not just fast, guaranteed" through.
 *
 * EVERYTHING ELSE IS ON `ALLOWED`: a sentence that has to say the word, each with a reason. An entry names a file, a rule and the text
 * it covers, so it cannot excuse a second use; and an entry that no longer matches anything FAILS, so the list can only shrink by being
 * cleaned, never rot (the same shape as ownerMarkerScan.test.ts). Three kinds are on it today: a legal page's body (DESIGN.md: legal
 * pages stay put), the subject of the landing's sample infographic (a comparison of two AI ideas, not a claim about the product), and
 * Telegram's own object (@BotFather makes a "bot", and its username must end in "bot").
 *
 * What it does not do: judge a claim. «سريع» or "fast" is unbanned and may still be false. landingTruth.test.ts owns the truth of the
 * landing page; this owns the vocabulary. Clario is not on this list on purpose: landingTruth.test.ts and ownerMarkerScan.test.ts
 * already scan every public file and every dashboard file for it, with no allow-list.
 *
 * Usage: `npm run check:voice` (exits 1 and prints file:line for each hit). The pure functions are exported for voice.test.mjs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/** The dictionaries the guard reads, one per language. */
export const DICT_FILES = { ar: 'dashboard/js/i18n.ar.js', en: 'dashboard/js/i18n.en.js' };
/** The directory whose `*.html` the guard reads. */
export const PUBLIC_DIR = 'public';
/** The dashboard shell: its `<title>` and description are copy B3 owns. (`dashboard/eid.html` is the owner's own promotion, his voice and not the product's.) */
export const SHELL_PAGES = ['dashboard/index.html'];

// ─── The name ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The registered name in both scripts. Taken out of the text before the rules run (see the header). */
export const NAME_PATTERNS = [
    /AutoReply[\s ]*Pro\b/gi,
    // After normalisation: the wordmark's space may be a no-break space, a ZWNJ or an RLM.
    /اوتوريبلاي[\s ‌‎‏]*برو(?![\p{L}])/gu,
];
const NAME_MASK = '⁣';

// ─── Arabic text, folded for matching ──────────────────────────────────────────────────────────────────────────────────

/**
 * Arabic folded the way a reader folds it: no short vowels, tanween, shadda or dagger alef, no tatweel, every hamza-carrying alef a
 * plain alef, alef maqsura a yeh. A banned stem is written once, bare («فورا»), and finds «فوراً», «فَورًا» and «فـــورا» alike.
 * The same folding as src/utils/arabic.ts uses for keyword matching, kept here so a plain `node` script needs no TypeScript.
 */
export function foldArabic(s) {
    return s
        .replace(/[ً-ٰٟ]/g, '')
        .replace(/ـ/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ى/g, 'ي');
}

/** The text with the registered name masked, so "Pro" can be banned everywhere else. Folded for Arabic. */
export function withoutName(text) {
    let out = foldArabic(text);
    for (const re of NAME_PATTERNS) out = out.replace(re, NAME_MASK);
    return out;
}

// ─── The rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Arabic clitics that sit on a word: و/ف, then ب/ل/ك, then ال («وبالفوري», «للمضمون»). May be empty. */
const AR_CLITIC = '(?:[وف]?(?:[بلك]?(?:ال)?|لل))';
const AR_LEFT = '(?<![\\p{L}])';
const AR_RIGHT = '(?![\\p{L}])';
/** Endings a banned stem takes: feminine, accusative, the plural. */
const AR_END = 'ة|ه|ا|ات|ين|ون';
/** A folded Arabic word: an optional clitic, one stem of `stems`, then one of `suffixes`; flanked by non-letters. */
// The pattern is folded too (`foldArabic`), so a stem may be written with its alef maqsura or hamza («على الفور») and still meet the folded text.
const ar = (stems, suffixes = '') => new RegExp(foldArabic(`${AR_LEFT}${AR_CLITIC}(?:${stems})${suffixes ? `(?:${suffixes})?` : ''}${AR_RIGHT}`), 'u');
/** An English word or phrase, whole-word and case-insensitive. */
const en = (src, flags = 'i') => new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${src})(?![\\p{L}\\p{N}_])`, `${flags}u`);

/**
 * One rule per word IDENTITY.md §7 / DESIGN.md §7 forbid. `en` / `ar` are tested on the folded text; `negatable` rules are allowed
 * when a negator stands directly before the word (the product stating a limit). `why` is the line printed with a hit.
 */
export const RULES = [
    { id: 'pro', why: '"Pro" is the name, never a plan, a tier or a feature', en: en('Pro', ''), ar: ar('برو') },
    { id: 'premium', why: 'no tier language: there is no plan to be premium over', en: en('Premium'), ar: ar('بريميوم|بريمييوم') },
    { id: 'powered-by', why: '"Powered by" sells someone else\'s name on our page', en: en('Powered[\\s\\u00a0]+by'), ar: ar('مدعوم[\\s\\u00a0]+من|بدعم[\\s\\u00a0]+من') },
    { id: 'instant', why: 'queues and sweeps are not minute-exact: say when, not "instantly"', negatable: true, en: en('instant(?:ly)?'), ar: ar('فورا|فوري|فورية|على[\\s\\u00a0]+الفور', AR_END) },
    { id: 'guaranteed', why: 'nothing here is guaranteed: Meta decides what is delivered', negatable: true, en: en('guarantee[ds]?|guaranteeing'), ar: ar('مضمون|ضمان|نضمن|نضمنه|يضمن|نضمنها', AR_END) },
    { id: 'ai-powered', why: 'name what the tool does, not that it is "AI-powered" or "smart"', en: en('AI[\\s\\u00a0-]+(?:powered|driven|based)|smart[\\s\\u00a0]+(?:bot|assistant|reply|replies)'), ar: ar('ذكي', AR_END) },
    { id: 'ai-powered-ar', why: 'name what the tool does, not that it is powered by AI', en: en('(?!x)x'), ar: ar('(?:مدعوم|يعمل|تعمل|مدفوع)[\\s\\u00a0]+ب(?:ال)?ذكاء[\\s\\u00a0]+(?:ال)?اصطناعي', 'ة') },
    { id: 'bot', why: 'it is a reply you wrote once, not a "bot"', en: en('(?:chat[\\s\\u00a0-]?)?bots?'), ar: ar('بوت', AR_END) },
    { id: 'revolutionary', why: 'hype', en: en('revolution(?:ary|ize|ise|izes|ises|ized|ised|izing|ising)'), ar: ar('ثوري|ثورة|يحدث[\\s\\u00a0]+ثورة', AR_END) },
    { id: 'all-in-one', why: 'hype: say which things it does', en: en('all[\\s\\u00a0-]+in[\\s\\u00a0-]+one'), ar: ar('متكامل|الكل[\\s\\u00a0]+في[\\s\\u00a0]+واحد', AR_END) },
    { id: 'magic', why: 'hype', en: en('magic(?:al|ally)?'), ar: ar('سحري|سحر', AR_END) },
    { id: 'viral', why: 'a promise about other people\'s feeds', en: en('viral(?:ly)?|go(?:ing)?[\\s\\u00a0]+viral'), ar: ar('تريند|ترند|تراند|فيرال', AR_END) },
    { id: 'growth-hack', why: 'hype', en: en('growth[\\s\\u00a0-]+hack(?:s|er|ers|ing)?'), ar: ar('(?:هاك|اختراق)(?:ات)?[\\s\\u00a0]+(?:ال)?نمو') },
    { id: 'supercharge', why: 'hype: "Supercharge your engagement" is DESIGN.md\'s own counter-example', en: en('supercharg(?:e|es|ed|ing)|turbocharg(?:e|es|ed|ing)'), ar: ar('ضاعف|ضاعفي|ضاعفوا|يضاعف|تضاعف|نضاعف|اضاعف') },
    { id: 'unlimited', why: 'every quota here has a ceiling: name it', negatable: true, en: en('unlimited'), ar: ar('بلا[\\s\\u00a0]+حدود|بدون[\\s\\u00a0]+حدود|غير[\\s\\u00a0]+محدود|لا[\\s\\u00a0]+محدود', AR_END) },
    { id: 'trusted-by', why: 'no logo walls, no "trusted by": there is no one to cite', en: en('trusted[\\s\\u00a0]+by'), ar: ar('موثوق[\\s\\u00a0]+من|يثق[\\s\\u00a0]+بنا') },
    { id: 'manychat', why: 'we are not a "ManyChat alternative"', en: en('ManyChat[\\s\\u00a0]+(?:alternative|competitor|killer)|alternative[\\s\\u00a0]+to[\\s\\u00a0]+ManyChat'), ar: ar('بديل[\\s\\u00a0]+(?:ال)?مانيشات|بديل[\\s\\u00a0]+مني[\\s\\u00a0]*شات') },
];

/** Fillers that may stand between a negator and the word without making room for a claim: "not be guaranteed", "not always instant". */
const FILLER_EN = '(?:(?:be|been|being|always|necessarily|fully|ever|a|an|any|really|truly)[\\s\\u00a0]+){0,2}';
const FILLER_AR = '(?:(?:يكون|تكون|يكن|تكن|دائما|بالضرورة|اي|أي)[\\s\\u00a0]+){0,2}';
/** A negator directly before the word: the product stating a limit rather than making a claim. */
const NEGATOR_EN = new RegExp(`(?:(?<![\\p{L}])(?:not|no|never|nor|without|cannot|nothing|neither)|n['’]t)[\\s\\u00a0]+${FILLER_EN}$`, 'iu');
const NEGATOR_AR = new RegExp(foldArabic(`(?<![\\p{L}])[وف]?(?:لا|ليس|ليست|لن|لم|غير|بلا|بدون|دون|لسنا|لست)[\\s\\u00a0]+${FILLER_AR}$`), 'u');

/** Whether the text just before `index` ends in a negator (see the header): the match is a limit being stated. */
function negatedBefore(text, index) {
    const before = text.slice(Math.max(0, index - 40), index);
    return NEGATOR_EN.test(before) || NEGATOR_AR.test(before);
}

/**
 * The rules a piece of copy breaks.
 * @param {string} text one piece of copy: a dictionary value, a text node, an attribute
 * @returns {{ rule: string, word: string, why: string, index: number }[]}
 */
export function violations(text) {
    const t = withoutName(text);
    const hits = [];
    for (const rule of RULES) {
        for (const re of [rule.en, rule.ar]) {
            const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
            for (const m of t.matchAll(g)) {
                if (rule.negatable && negatedBefore(t, m.index)) continue;
                hits.push({ rule: rule.id, word: m[0], why: rule.why, index: m.index });
            }
        }
    }
    return hits;
}

// ─── The dictionaries ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Every `key: value` of a dictionary source, each with the line its key starts on. A value that is not a string is skipped. */
export function dictionaryEntries(source, file) {
    const sandbox = {};
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: file });
    const lang = Object.keys(sandbox.I18N_DICT ?? {})[0];
    const dict = (lang && sandbox.I18N_DICT[lang]) ?? {};
    const lineOf = new Map();
    source.split('\n').forEach((line, i) => {
        const m = line.match(/^\s*'([^']+)'\s*:/);
        if (m) lineOf.set(m[1], i + 1);
    });
    return Object.entries(dict)
        .filter(([, v]) => typeof v === 'string')
        .map(([key, text]) => ({ file, line: lineOf.get(key) ?? 0, where: key, text }));
}

// ─── The public pages ──────────────────────────────────────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', times: '×', copy: '©', rarr: '→', larr: '←', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', shy: '' };

/** Entities decoded. An entity this does not know is left as written, which no rule matches, so it can only hide a word, never invent one. */
export function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** `<meta>` names and properties whose `content` is copy somebody reads. The rest (viewport, theme-color, a URL) is configuration. */
const COPY_META = /^(?:description|og:(?:title|description|image:alt|site_name)|twitter:(?:title|description|image:alt))$/i;
/** Attributes that carry copy on any element. */
const COPY_ATTRS = ['alt', 'title', 'aria-label', 'aria-description', 'placeholder'];

/** The 1-based line of an offset. */
const lineAt = (src, offset) => 1 + (src.slice(0, offset).match(/\n/g) ?? []).length;

/**
 * Every piece of copy a public page carries, with where it is.
 * Comments, `<style>` and the page's own scripts are blanked first (newlines kept, so line numbers hold); a JSON-LD script is copy.
 * @returns {{ file: string, line: number, where: string, text: string }[]}
 */
export function pageCopy(html, file) {
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    const src = html
        .replace(/<!--[\s\S]*?-->/g, blank)
        .replace(/<style\b[\s\S]*?<\/style>/gi, blank)
        .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs) => (/type\s*=\s*["']application\/ld\+json["']/i.test(attrs) ? m : blank(m)));
    const out = [];
    const push = (offset, where, raw) => {
        const text = decodeEntities(raw).replace(/[ \t\r\n]+/g, ' ').trim();
        if (text) out.push({ file, line: lineAt(src, offset), where, text });
    };
    let pos = 0;
    for (const tag of src.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
        if (tag.index > pos) push(pos, 'text', src.slice(pos, tag.index));
        pos = tag.index + tag[0].length;
        const [, closing, name, attrs] = tag;
        if (closing) continue;
        const attr = (n) => {
            const m = attrs.match(new RegExp(`(?:^|\\s)${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
            return m ? (m[1] ?? m[2]) : undefined;
        };
        if (name.toLowerCase() === 'meta') {
            const label = attr('name') ?? attr('property') ?? '';
            const content = attr('content');
            if (content !== undefined && COPY_META.test(label)) push(tag.index, `meta ${label}`, content);
            continue;
        }
        for (const a of COPY_ATTRS) {
            const v = attr(a);
            if (v !== undefined) push(tag.index, `${name} ${a}`, v);
        }
    }
    if (pos < src.length) push(pos, 'text', src.slice(pos));
    return out;
}

// ─── What is allowed ───────────────────────────────────────────────────────────────────────────────────────────────────

const REASON = {
    legal: 'a legal page\'s body: DESIGN.md §7 "Legal pages stay put" (brand work never edits their body text), and "access ends immediately" is a legal fact there, not a speed claim',
    sample: 'the subject of the landing\'s sample infographic ("Chatbot vs Agent", the owner\'s own post about two AI ideas), named so a reader can tell what the sample shows; not a claim about this product',
    limit: 'a limit stated, DESIGN.md §7 "Say what is NOT promised" ("No ... guarantee"); the negation is wider than the rule\'s one-word window',
    telegram: 'Telegram\'s own object, not a claim about this product: @BotFather creates a "bot", its token is called a bot token, and its username must end in "bot"; the operator\'s alert channel in Settings',
};

/**
 * Each entry excuses ONE rule in ONE place, with a reason.
 *   file    the file (or files) it applies to
 *   rule    the rule it excuses
 *   text    the sentence it excuses: the piece of copy must hold it (folded, case-insensitive) and the hit must be inside it
 *   key     for a dictionary: every key that starts with this
 *   reason  why: required
 * Every entry must still match something (see `judge`); an entry that matches nothing is a failure, so this list only shrinks.
 */
export const ALLOWED = [
    { file: 'public/data-deletion.html', rule: 'instant', text: 'فينتهي الوصول فوراً', reason: REASON.legal },
    { file: 'public/privacy.html', rule: 'instant', text: 'ويُحذف الاتصال المحفوظ فوراً', reason: REASON.legal },
    { file: 'public/privacy.html', rule: 'guaranteed', text: 'ضمان ألّا يُرَدّ على التعليق نفسه مرتين', reason: 'a legal page\'s body (see above); «ضمان» is the verb sense, "to ensure that the same comment is not answered twice", not a promise' },
    { file: 'public/terms.html', rule: 'instant', text: 'فيُلغى الوصول فوراً', reason: REASON.legal },
    { file: 'public/landing.html', rule: 'guaranteed', text: 'No uptime or delivery guarantee', reason: REASON.limit },
    { file: 'public/landing.html', rule: 'ai-powered', text: 'الوكيل الذكي', reason: REASON.sample },
    { file: 'public/landing.html', rule: 'bot', text: 'chatbots with agents', reason: REASON.sample },
    { file: 'public/landing.html', rule: 'bot', text: 'chatbot versus agent', reason: REASON.sample },
    { file: 'public/landing.html', rule: 'bot', text: 'Chatbot vs Agent', reason: REASON.sample },
    { file: Object.values(DICT_FILES), rule: 'bot', key: 'settings.notify.', reason: REASON.telegram },
];

const filesOf = (e) => (Array.isArray(e.file) ? e.file : [e.file]);
const fold = (t) => foldArabic(t).toLowerCase();
const entryCovers = (e, f) =>
    filesOf(e).includes(f.file) &&
    e.rule === f.rule &&
    (e.key !== undefined ? f.where.startsWith(e.key) : fold(f.text).includes(fold(e.text)) && fold(e.text).includes(fold(f.word)));

// ─── The scan ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every finding for a list of `{ file, line, where, text }` pieces of copy, before the allow-list. */
export function scanPieces(pieces) {
    return pieces.flatMap((p) => violations(p.text).map((v) => ({ file: p.file, line: p.line, where: p.where, rule: v.rule, word: v.word, why: v.why, text: p.text })));
}

/** What `findings` leave once `allowed` is applied, and which of `allowed` covered nothing (a stale entry is as much a failure as a hit). */
export function judge(findings, allowed = ALLOWED) {
    const used = new Set();
    const remaining = findings.filter((f) => {
        const covering = allowed.filter((e) => entryCovers(e, f));
        covering.forEach((e) => used.add(e));
        return covering.length === 0;
    });
    return { findings: remaining, stale: allowed.filter((e) => !used.has(e)) };
}

/** Everything the guard reads, from `root` (the repo): both dictionaries, every public page and the dashboard shell. `io` is injectable for the tests. */
export function collectCopy(root = '.', io = { read: (p) => readFileSync(p, 'utf8'), list: (d) => readdirSync(d) }) {
    const pieces = [];
    for (const file of Object.values(DICT_FILES)) pieces.push(...dictionaryEntries(io.read(join(root, file)), file));
    const pages = io.list(join(root, PUBLIC_DIR)).filter((n) => n.endsWith('.html')).sort().map((n) => `${PUBLIC_DIR}/${n}`);
    for (const file of [...pages, ...SHELL_PAGES]) pieces.push(...pageCopy(io.read(join(root, file)), file));
    return pieces;
}

/** The verdict over the repo at `root`: `{ findings, stale, pieces }`. */
export function scanRepo(root = '.', io, allowed = ALLOWED) {
    const pieces = collectCopy(root, io);
    return { ...judge(scanPieces(pieces), allowed), pieces };
}

function excerpt(text, word) {
    const i = Math.max(0, text.indexOf(word) - 28);
    const cut = text.slice(i, i + 90 + word.length).replace(/\s+/g, ' ');
    return `${i > 0 ? '…' : ''}${cut}${i + 90 + word.length < text.length ? '…' : ''}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const { findings, stale, pieces } = scanRepo('.');
    if (findings.length || stale.length) {
        if (findings.length) {
            console.error(`voice: ${findings.length} banned word${findings.length === 1 ? '' : 's'} in shipped copy (docs/brand/IDENTITY.md §7, DESIGN.md §7)\n`);
            for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}] «${f.word}» in ${f.where}\n      ${excerpt(f.text, f.word)}\n      ${f.why}`);
            console.error('\nRewrite the copy. The registered name "AutoReply Pro" is allowed, and so is a limit stated ("not guaranteed", «لا نضمن»).');
        }
        for (const e of stale) console.error(`voice: the ALLOWED entry for ${filesOf(e).join(', ')} [${e.rule}] ${e.key ?? `"${e.text}"`} matches nothing any more: delete it from scripts/check-voice.mjs`);
        process.exit(1);
    }
    const pages = new Set(pieces.filter((p) => !p.file.includes('i18n.')).map((p) => p.file));
    console.log(`voice ok: ${pieces.length} pieces of copy (${Object.keys(DICT_FILES).length} dictionaries, ${pages.size} pages), ${RULES.length} rules, ${ALLOWED.length} allowed uses, none broken`);
}
