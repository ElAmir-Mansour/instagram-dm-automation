#!/usr/bin/env node
/**
 * The glossary guard (UX plan U5, WA-2 / SA-20): one name per concept, in both languages, checked.
 *
 * The 2026-11-27 UX research found one thing called tenant, workspace, client and account; "campaign" meaning both a keyword reply
 * and an ad; the DM bot called "agent" and «الوكيل»; Instagram spelled two ways in Arabic; «مربوط» and «متصل» for one state; four
 * ways to say a thing needs the owner. A glossary that lives only in a document is read once; this makes it fail a build.
 *
 * THE GLOSSARY (decided 2026-11-28; the retired words are the RULES below):
 *
 *   concept                      English                  Arabic                              retired
 *   a tenant, as a person sees   Workspace                «مساحة العمل»                       tenant, client; «مستأجر»; «مالك الحساب»
 *   comment automation           Keyword reply            «ردّ تلقائي» / «الردود التلقائية»   campaign, «حملة»  (ads keep both words)
 *   the DM bot                   assistant                «المساعد»                           agent, «الوكيل»
 *   Instagram                    Instagram                «إنستجرام» (the majority: 300 to 84) «إنستغرام»
 *   something the owner must do  Needs you                «بحاجة إليك»                        «يحتاج إليك», «تحتاج إليك», «بانتظارك»
 *   connected                    Connected                «متصل»                              «مربوط»
 *   the reels page               Reels                    «الريلز»                            Monteur / «المونتير» (as a PAGE or TAB name)
 *   the log page                 Log                      «السجل»                             "Activity Log", «سجل النشاط»
 *
 * WHAT IS SCANNED, and nothing else:
 *   - Both dashboard dictionaries (`dashboard/js/i18n.ar.js`, `i18n.en.js`): every VALUE, evaluated, as check-voice.mjs reads them.
 *   - `dashboard/js/help-content.js`: every string under an `ar` or an `en` key, in that language. The Arabic Help is being rewritten
 *     into فصحى (SA-08) with this same glossary; until it lands, ONE entry on `ALLOWED` ("help pending SA-08") covers the whole file.
 *     The PR that finishes the Help deletes that entry, and the guard then fails if the Help still breaks a rule, and fails if the
 *     entry is left behind (a stale entry is a failure).
 *
 * SOME RULES ARE SCOPED. `keys` names the dictionary keys a rule applies to; `exceptKeys` names the ones it never applies to:
 *   - «العميل» is the right word for the people who message you; it is retired only where it means a workspace (the admin ads and
 *     tenant screens), so that rule lists those keys.
 *   - "campaign" / «حملة» is the right word for ads (the Ads screens, the Boost card), so its rule excepts the ads key families.
 *   - "Monteur" still names the tool inside sentences ("how the Monteur scored this moment"); only the PAGE and TAB names became
 *     "Reels", so that rule lists those keys.
 *
 * EVERYTHING ELSE IS ON `ALLOWED`: a sentence that has to say the word, each with a reason. An entry names a file, a rule and a key
 * (a prefix), so it cannot excuse a second use; and an entry that no longer matches anything FAILS, so the list can only shrink by
 * being cleaned (the same shape as check-voice.mjs).
 *
 * What it does not do: tell a social account from a workspace in «الحساب» / "account" (they are the same word, and the glossary
 * keeps "account" for social accounts and logins), or judge grammar. It pins the retired words; reading the copy is still a person's job.
 *
 * Usage: `npm run check:glossary` (exits 1 and prints file:line for each hit). The pure functions are exported for check-glossary.test.mjs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { DICT_FILES, dictionaryEntries, foldArabic } from './check-voice.mjs';

export { DICT_FILES };
/** The Help Center's articles (both languages). */
export const HELP_FILE = 'dashboard/js/help-content.js';
/** The language each dictionary is in. */
const DICT_LANG = { [DICT_FILES.ar]: 'ar', [DICT_FILES.en]: 'en' };

// ─── The rules ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const AR_LEFT = '(?<![\\p{L}])';
const AR_RIGHT = '(?![\\p{L}])';
/** Arabic clitics on a word: و/ف, then ب/ل/ك, then ال («والحملة», «للحملة», «بالوكيل»). May be empty. */
const AR_CLITIC = '(?:[وف]?(?:[بلك]?(?:ال)?|لل))';
/** A folded Arabic word: an optional clitic, one of `stems`, flanked by non-letters. The pattern is folded too. */
const ar = (stems) => new RegExp(foldArabic(`${AR_LEFT}${AR_CLITIC}(?:${stems})${AR_RIGHT}`), 'u');
/** An English word or phrase, whole-word and case-insensitive. */
const en = (src) => new RegExp(`(?<![{\\p{L}\\p{N}_-])(?:${src})(?![\\p{L}\\p{N}_{])`, 'iu');
const NEVER = /(?!x)x/;

/** The dictionary key families of the ads product (and the Ads Help article, `help:ads`), where "campaign" / «حملة» is the right word. */
export const ADS_KEYS = ['ads.', 'adsCreate.', 'adsResults.', 'adsAdmin.', 'adsClient.', 'adsBuilder.', 'settings.ads.', 'boost.', 'nav.ads', 'page.ads', 'ops.ai.purpose.ads_', 'tenantLegal.', 'help:ads'];
/** The keys where «العميل» meant a workspace (an admin's view of the managed workspaces), so it is retired there. «قوائم العملاء» and «العملاء المحتملين» (the people who message you, lead ads) are the right word and stay. */
export const WORKSPACE_AS_CLIENT_KEYS = [
    'nav.tenants', 'nav.admin_ads', 'nav.tenant_detail', 'page.admin_ads.', 'tenantProfile.', 'meta.app.enabled', 'tenants.', 'tenantDetail.', 'invites.',
    'adsAdmin.count', 'adsAdmin.unavailableTitle', 'adsAdmin.loadFailed', 'adsAdmin.empty', 'adsAdmin.help.', 'adsAdmin.enabled.', 'adsAdmin.spend.', 'adsAdmin.ceiling.', 'adsAdmin.signoffs.revokeBody',
];
/** The keys that name the reels PAGE or TAB (or point at it), where "Monteur" became "Reels". */
export const MONTEUR_NAME_KEYS = ['nav.monteur', 'studio.tabs.monteur', 'monteur.status.label', 'monteur.viewer.title', 'monteur.loadFailed', 'monteur.setup.title', 'monteur.settings.saved', 'help.link.monteur', 'errors.CLIP_TIKTOK_LINE_MISSING'];

/**
 * One rule per retired word. `en` / `ar` are tested on the (folded, for Arabic) text of that language. `keys` limits a rule to the
 * dictionary keys that start with one of them; `exceptKeys` excludes those. `use` is the line printed with a hit.
 */
export const RULES = [
    { id: 'tenant', use: 'say "workspace" / «مساحة العمل»: the person reading it has a workspace, not a tenant', en: en('tenants?'), ar: ar('مستاجر|مستاجرين|مستاجرون|المستاجرين') },
    { id: 'account-owner', use: 'say "workspace owner" / «مالك مساحة العمل»: "account" is for social accounts and logins', en: en('account[\\s\\u00a0]+owners?'), ar: ar('(?:مالك|صاحب|مالكي|اصحاب)[\\s\\u00a0]+الحساب') },
    { id: 'client', use: 'say "workspace": a "client" is one of the people who message you, or an OAuth client, never a workspace', en: en('clients?'), ar: ar('عميل|عملاء|العميل|العملاء'), arKeys: WORKSPACE_AS_CLIENT_KEYS },
    { id: 'campaign', use: 'say "keyword reply" / «ردّ تلقائي»: "campaign" / «حملة» is for ads only', en: en('campaigns?'), ar: ar('حملة|حملات|حملتك|حملتي|حملته|حملتها'), exceptKeys: ADS_KEYS },
    { id: 'agent', use: 'say "assistant" / «المساعد» for the DM bot', en: en('agents?'), ar: ar('وكيل|وكلاء|الوكيل|الوكلاء') },
    { id: 'instagram', use: 'one Arabic spelling of Instagram: «إنستجرام», the majority (300 of 384 before the pass)', en: NEVER, ar: ar('انستغرام') },
    { id: 'connected', use: 'say «متصل» for connected: «مربوط» is retired (SA-20)', en: NEVER, ar: ar('مربوط|مربوطة|مربوطين|مربوطان|مربوطتين') },
    { id: 'needs-you', use: 'one word for "the owner must act": «بحاجة إليك» (it needs no gender agreement and matches «بحاجة إلى ردّ»)', en: NEVER, ar: new RegExp(foldArabic(`${AR_LEFT}(?:[يت]حتاج(?:ان)?|احتاجت|احتاجوا)[\\s\\u00a0]+اليك${AR_RIGHT}|${AR_LEFT}${AR_CLITIC}(?:بانتظارك|يحتاجك|تحتاجك)${AR_RIGHT}`), 'u') },
    { id: 'monteur-name', use: 'the page and tab are named "Reels" / «الريلز»', en: en('Monteur'), ar: ar('مونتير|المونتير'), keys: MONTEUR_NAME_KEYS },
    { id: 'log-name', use: 'one name for the page: "Log" / «السجل», not "Activity Log" / «سجل النشاط»', en: en('activity[\\s\\u00a0]+log'), ar: ar('سجل[\\s\\u00a0]+النشاط') },
];

// ─── What is scanned ───────────────────────────────────────────────────────────────────────────────────────────────────

const startsWithAny = (where, prefixes) => prefixes.some((p) => where.startsWith(p));

/** Whether `rule` applies to a piece of copy for `lang` found at `where` (a dictionary key, or `help:<slug>#<section>`). */
function ruleApplies(rule, lang, where) {
    const keys = lang === 'ar' ? (rule.arKeys ?? rule.keys) : rule.keys;
    if (keys && !startsWithAny(where, keys)) return false;
    if (rule.exceptKeys && startsWithAny(where, rule.exceptKeys)) return false;
    return true;
}

/** Every string of Help, with its language and where it is. Strings outside an `ar` / `en` key (ids, icons, slugs) are not copy. */
export function helpEntries(source, file = HELP_FILE) {
    const sandbox = {};
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const help = vm.runInContext(`${source}\n;HelpContent`, sandbox, { filename: file });
    const lineOf = (text) => {
        const i = source.indexOf(text.slice(0, 40));
        return i < 0 ? 0 : 1 + (source.slice(0, i).match(/\n/g) ?? []).length;
    };
    const out = [];
    // A `[[slug#section|label]]` link: the target is an id (the slug `campaigns` is not copy); only the label is read.
    const unlink = (text) => text.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[[^\]|]*\]\]/g, '');
    const walk = (node, lang, where) => {
        if (typeof node === 'string') {
            if (lang) out.push({ file, line: lineOf(node), where, lang, text: unlink(node) });
        } else if (Array.isArray(node)) node.forEach((n) => walk(n, lang, where));
        else if (node && typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) walk(v, k === 'ar' || k === 'en' ? k : lang, where);
        }
    };
    for (const a of help.articles ?? []) {
        out.push(...[['title', a.title], ['summary', a.summary]].flatMap(([part, v]) => ['ar', 'en'].filter((l) => typeof v?.[l] === 'string').map((l) => ({ file, line: lineOf(v[l]), where: `help:${a.slug}.${part}`, lang: l, text: v[l] }))));
        for (const s of a.sections ?? []) {
            for (const l of ['ar', 'en']) if (typeof s.title?.[l] === 'string') out.push({ file, line: lineOf(s.title[l]), where: `help:${a.slug}#${s.id}`, lang: l, text: s.title[l] });
            walk(s.body, undefined, `help:${a.slug}#${s.id}`);
        }
    }
    for (const g of help.groups ?? []) for (const l of ['ar', 'en']) if (typeof g.title?.[l] === 'string') out.push({ file, line: lineOf(g.title[l]), where: `help:group.${g.id}`, lang: l, text: g.title[l] });
    return out;
}

/** Every `{ file, line, where, lang, text }` the guard reads, from `root` (the repo). `read` is injectable for the tests. */
export function collectCopy(root = '.', read = (p) => readFileSync(p, 'utf8')) {
    const pieces = [];
    for (const file of Object.values(DICT_FILES)) pieces.push(...dictionaryEntries(read(join(root, file)), file).map((p) => ({ ...p, lang: DICT_LANG[file] })));
    pieces.push(...helpEntries(read(join(root, HELP_FILE)), HELP_FILE));
    return pieces;
}

/** The rules a piece of copy breaks. */
export function violations(text, lang, where = '') {
    const t = lang === 'ar' ? foldArabic(text) : text;
    const hits = [];
    for (const rule of RULES) {
        if (!ruleApplies(rule, lang, where)) continue;
        const re = rule[lang];
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        for (const m of t.matchAll(g)) hits.push({ rule: rule.id, word: m[0], use: rule.use, index: m.index });
    }
    return hits;
}

/** Every finding for a list of pieces, before the allow-list. */
export function scanPieces(pieces) {
    return pieces.flatMap((p) => violations(p.text, p.lang, p.where).map((v) => ({ file: p.file, line: p.line, where: p.where, lang: p.lang, rule: v.rule, word: v.word, use: v.use, text: p.text })));
}

// ─── What is allowed ───────────────────────────────────────────────────────────────────────────────────────────────────

const BOTH = Object.values(DICT_FILES);
const REASON = {
    oauth: 'an OAuth "client" (client key, client secret, client ID, the Google OAuth client): the provider\'s own word for the app credential, not a person or a workspace',
    agency: 'a real-world client of an agency ("a company that works for clients"): the visitor describing their own business, not a workspace',
    letter: 'the name of an Arabic letter, «التاء المربوطة» (the tied teh «ة»), explained as a matching rule: a grammar term, not a connection state',
    adAccount: 'the owner of the AD ACCOUNT, a Meta role that must accept the Custom Audience Terms: not the workspace owner',
    topic: 'the AI-agent topic itself, in an example or a diagram title (an "AI agent" is a thing the owner posts about), not this product\'s DM bot',
};

/**
 * Each entry excuses ONE rule in ONE place, with a reason.
 *   file     the file (or files) it applies to
 *   rule     the rule it excuses, or '*' for every rule (used only by the Help entry)
 *   key      a dictionary key, or the start of a family of keys
 *   reason   why: required
 * Every entry must still match something (see `judge`); an entry that matches nothing is a failure, so this list only shrinks.
 */
export const ALLOWED = [
    // OAuth credentials: "Client key", "Client secret", "Client ID", the Google OAuth client.
    { file: BOTH, rule: 'client', key: 'settings.tiktok.notConfiguredAdmin', reason: REASON.oauth },
    { file: BOTH, rule: 'client', key: 'settings.tiktok.return.exchange_failed', reason: REASON.oauth },
    { file: BOTH, rule: 'client', key: 'settings.tiktok.app.client', reason: REASON.oauth },
    { file: BOTH, rule: 'client', key: 'settings.youtube.', reason: REASON.oauth },
    // The agency visitor's own clients.
    { file: BOTH, rule: 'client', key: 'welcome.kind.agency.hint', reason: REASON.agency },
    // "AI agent" as a subject.
    { file: BOTH, rule: 'agent', key: 'growth.keywords.placeholder', reason: REASON.topic },
    { file: BOTH, rule: 'agent', key: 'posts.reach.altPlaceholder', reason: REASON.topic },
    { file: BOTH, rule: 'agent', key: 'infographics.diagram.loop', reason: REASON.topic },
    // The Help: the Google OAuth client, the AI-agent topic in two examples, an Arabic letter's name, and a Meta role.
    { file: HELP_FILE, rule: 'client', key: 'help:youtube', reason: REASON.oauth },
    { file: HELP_FILE, rule: 'agent', key: 'help:seo#alt-text', reason: REASON.topic },
    { file: HELP_FILE, rule: 'agent', key: 'help:ads#policy-check', reason: REASON.topic },
    { file: HELP_FILE, rule: 'connected', key: 'help:campaigns#matching', reason: REASON.letter },
    { file: HELP_FILE, rule: 'account-owner', key: 'help:ads#audiences', reason: REASON.adAccount },
];

const filesOf = (e) => (Array.isArray(e.file) ? e.file : [e.file]);
const entryCovers = (e, f) => filesOf(e).includes(f.file) && (e.rule === '*' || e.rule === f.rule) && f.where.startsWith(e.key);

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

/** The verdict over the repo at `root`: `{ findings, stale, pieces }`. */
export function scanRepo(root = '.', read, allowed = ALLOWED) {
    const pieces = collectCopy(root, read);
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
            console.error(`glossary: ${findings.length} retired word${findings.length === 1 ? '' : 's'} in shipped copy (UX plan U5, WA-2)\n`);
            for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}/${f.lang}] «${f.word}» in ${f.where}\n      ${excerpt(f.text, f.word)}\n      ${f.use}`);
            console.error('\nUse the glossary word (see the header of scripts/check-glossary.mjs). A sentence that really needs the old word goes on ALLOWED with a reason.');
        }
        for (const e of stale) console.error(`glossary: the ALLOWED entry for ${filesOf(e).join(', ')} [${e.rule}] ${e.key} matches nothing any more: delete it from scripts/check-glossary.mjs${e.reason.startsWith('help pending') ? ' (the Help is clean now: that is the point of this entry)' : ''}`);
        process.exit(1);
    }
    const helpPieces = pieces.filter((p) => p.file === HELP_FILE).length;
    console.log(`glossary ok: ${pieces.length - helpPieces} dictionary values + ${helpPieces} Help strings, ${RULES.length} rules, ${ALLOWED.length} allowed uses, none broken`);
}
