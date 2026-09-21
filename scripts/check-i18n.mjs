#!/usr/bin/env node
/**
 * Guards the dashboard's translation dictionaries.
 *
 * `I18N.t()` falls back: active language -> English -> the key itself. That fallback is
 * deliberate and good, but it makes two real bugs completely silent:
 *
 *   - A key in `en` but missing from `ar` renders **English text inside an Arabic RTL
 *     page**. Nothing errors. You only notice if you read Arabic and happen to look at
 *     that screen.
 *   - A key missing from BOTH renders the raw key — `posts.deleteTitle` — to the user.
 *     Visible, but only on the screen that uses it, which may be an admin screen nobody
 *     opens for weeks.
 *
 * Arabic is the primary language here, so `en`-without-`ar` is the failure, not the
 * reverse. Arabic legitimately has keys English does not: CLDR gives Arabic six plural
 * categories (zero/one/two/few/many/other) against English's two, so `_two`, `_few`,
 * `_many` and `_zero` variants are expected and are not treated as orphans.
 *
 * Three call surfaces are scanned: `t('literal')`, `data-i18n="key"`, and
 * `data-i18n-attr="attr:key,attr2:key2"`. Comments are stripped first — i18n.js documents
 * its own format with a literal `data-i18n-attr="aria-label:key,title:key"` example, which
 * an unstripped scan reads as a missing key called `key`.
 *
 * Template calls (`t(`nav.${page}`)`) and variable calls (`t(key)`) cannot be resolved
 * statically. For templates the static prefix is checked instead: at least one key must
 * exist under it, which catches a renamed namespace.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DASHBOARD = 'dashboard';
const I18N_FILE = 'dashboard/js/i18n.js';
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

/** Strip // and /* *\/ comments, and HTML comments. */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (['.js', '.html'].includes(extname(p))) out.push(p);
    }
    return out;
}

// ─── The dictionaries ───────────────────────────────────────────────────────
const lines = readFileSync(I18N_FILE, 'utf8').split('\n');
// Exactly four spaces: `        ar: { label: ... }` at the top is the LANGS config, not a
// dictionary, and matching it instead is how the first version of this reported 889-vs-0.
const iAr = lines.findIndex(l => /^ {4}ar: \{/.test(l));
const iEn = lines.findIndex(l => /^ {4}en: \{/.test(l));
if (iAr === -1 || iEn === -1) {
    console.error(`❌ could not locate the ar/en dictionaries in ${I18N_FILE}.`);
    process.exit(1);
}
const dictKeys = (from, to) => new Set(
    lines.slice(from, to).map(l => (l.match(/^\s+'([a-zA-Z0-9_.]+)':/) || [])[1]).filter(Boolean)
);
const AR = dictKeys(iAr, iEn);
const EN = dictKeys(iEn, lines.length);

// ─── Every key the UI asks for ──────────────────────────────────────────────
const used = new Map();       // key -> first file that uses it
const prefixes = new Map();   // static prefix of a template call -> first file
for (const file of walk(DASHBOARD)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) if (!used.has(m[1])) used.set(m[1], file);
    for (const m of src.matchAll(/data-i18n="([a-zA-Z0-9_.]+)"/g)) if (!used.has(m[1])) used.set(m[1], file);
    for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g)) {
        for (const pair of m[1].split(',')) {
            const key = pair.split(':')[1];
            if (key && /^[a-zA-Z0-9_.]+$/.test(key) && !used.has(key)) used.set(key, file);
        }
    }
    for (const m of src.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]*?)\$\{/g)) {
        if (m[1] && !prefixes.has(m[1])) prefixes.set(m[1], file);
    }
}

/** Does `key` resolve in `dict`, directly or as a pluralised family? */
const resolves = (dict, key) =>
    dict.has(key) || PLURAL_SUFFIXES.some(s => dict.has(`${key}_${s}`));

const fail = [];

// 1. A key missing from BOTH dictionaries renders as the raw key to the user.
for (const [key, file] of used) {
    if (!resolves(EN, key) && !resolves(AR, key)) {
        fail.push(`'${key}' is used in ${file} but exists in neither dictionary — the UI will render the raw key.`);
    }
}

// 2. A key in en but not ar renders English inside the Arabic page.
for (const key of EN) {
    if (!AR.has(key)) {
        fail.push(`'${key}' exists in en but not ar — Arabic users see the English string, silently.`);
    }
}

// 3. An ar-only key that is not a plural variant of something en has is probably a typo.
const enBases = new Set([...EN].map(k => {
    const m = k.match(new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join('|')})$`));
    return m ? m[1] : k;
}));
const arOnlyPlurals = [];
for (const key of AR) {
    if (EN.has(key)) continue;
    const m = key.match(new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join('|')})$`));
    if (m && enBases.has(m[1])) { arOnlyPlurals.push(key); continue; }
    fail.push(`'${key}' exists in ar only and is not a plural variant of any en key — likely a typo or a leftover.`);
}

// 4. A template call's namespace must still exist.
for (const [prefix, file] of prefixes) {
    const any = [...EN, ...AR].some(k => k.startsWith(prefix));
    if (!any) fail.push(`no key starts with '${prefix}' (template call in ${file}) — the namespace was probably renamed.`);
}

if (fail.length > 0) {
    console.error('\n❌ i18n check failed:\n');
    for (const f of fail.slice(0, 40)) console.error(`   • ${f}`);
    if (fail.length > 40) console.error(`   … and ${fail.length - 40} more`);
    console.error('');
    process.exit(1);
}

console.log(
    `✓ i18n: ${used.size} key(s) referenced, all resolve; ar ${AR.size} / en ${EN.size}; ` +
    `${arOnlyPlurals.length} Arabic plural variant(s) English does not need.`
);
