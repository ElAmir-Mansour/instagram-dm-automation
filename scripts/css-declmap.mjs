#!/usr/bin/env node
/**
 * Proves a stylesheet refactor changed nothing an element computes.
 *
 *   node scripts/css-declmap.mjs <old.css> <new.css> [--verbose] [--no-markup]
 *   node scripts/css-declmap.mjs --self-test [file.css]
 *   node scripts/css-declmap.mjs --changes --tags <tags.json> <old.css> <new.css> [<old2> <new2> …]
 *
 * The third form is for a pass that MEANS to change what renders: it lists every value that
 * changed, grouped by the decision that claims it, and fails on any nobody claimed. See
 * "Changes" below.
 *
 * Run from the repository root (the markup it reads is found relative to it).
 *
 *   e.g. git show main:dashboard/css/styles.css > /tmp/old.css
 *        node scripts/css-declmap.mjs /tmp/old.css dashboard/css/styles.css
 *
 * The dashboard has no build step and no CSS parser dependency, so this carries a small parser
 * for the subset `dashboard/css/styles.css` uses: style rules, one level of `@media`, and
 * `@keyframes`. No nesting, no `@supports`/`@layer`. It refuses input it does not understand
 * rather than guessing, and checks its own parse two ways: the rule count against a raw brace
 * count, and a whitespace-free round trip of the source with comments removed.
 *
 * Two checks; the exit code is non-zero if either fails.
 *
 *  1. THE MAP. Every rule is expanded to (context, single selector, property) → the value that
 *     declaration list ends on — the last one, unless an earlier one is `!important` and the
 *     later one is not. `.a, .b` expands to `.a` and `.b`, so folding shared declarations into a
 *     grouped rule leaves the map unchanged; so does merging two copies of a rule. The maps must
 *     be identical, with one allowance: entries of a selector that can match nothing — a class it
 *     requires appears nowhere in the .js/.html under dashboard/ or the .html under public/, neither
 *     whole nor as something a template or a `+` could build — are listed as dead, not differences.
 *
 *  2. THE ORDER. The map cannot see order, and order is half the cascade: two declarations of
 *     equal specificity on one element are decided by which comes later. So for every pair of
 *     winning declarations that could compete — same importance, same specificity, the same
 *     property or a shorthand/longhand of it (`padding` vs `padding-inline-start`, `background`
 *     vs `background-color`, `border` vs `border-color`, `inset` vs `inset-block-start`, `gap` vs
 *     `row-gap`…), media contexts that can hold at once (a top-level rule meets every one) — the
 *     relative order must be the same in both files. A pair whose order flipped is a CROSSING.
 *
 *     Provable exclusions: different pseudo-elements, element types or ids in the subject
 *     compound; media queries that cannot both match (a min-width above a max-width, hover vs
 *     no hover); values identical on every side the two share (swapping two declarations that say
 *     the same thing changes nothing).
 *
 *     And one that needs the markup: two class selectors only compete on an element carrying
 *     both subjects' classes. `scanMarkup` reads every class the dashboard can paint (see
 *     "Markup" below); a flipped pair whose classes no element can carry together is reported
 *     as "disjoint", not as a crossing. It rests on stated assumptions (API data does not spell a
 *     component class; a slot glued to a class name holds one word; a string used as an id or a
 *     lookup key is not a class), and scripts/css-fixtures.mjs checks it against real rendered
 *     markup. `--no-markup` turns it off: every flipped pair of equal specificity is then a
 *     crossing, however unrelated the two components — the literal form of the check, which a
 *     rule moved past a hundred unrelated rules can never pass.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ─── Parsing ────────────────────────────────────────────────────────────────

/** Replace comments with spaces of the same length, so offsets keep meaning. */
export function blankComments(src) {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < src.length) {
        const ch = src[i];
        if (quote) {
            out += ch;
            if (ch === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
            if (ch === quote) quote = null;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; out += ch; i++; continue; }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end < 0) throw new Error(`unterminated comment at offset ${i}`);
            out += src.slice(i, end + 2).replace(/[^\n]/g, ' ');
            i = end + 2;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/** Collapse whitespace runs outside strings; trim. */
export function normWs(s) {
    let out = '';
    let quote = null;
    let pendingSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            out += ch;
            if (ch === '\\') { out += s[++i] ?? ''; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (/\s/.test(ch)) { pendingSpace = true; continue; }
        if (pendingSpace && out.length) out += ' ';
        pendingSpace = false;
        if (ch === '"' || ch === "'") quote = ch;
        out += ch;
    }
    return out;
}

/** Split on a separator character at depth 0 (outside (), [] and strings). */
export function splitTop(s, sep) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
            cur += ch;
            if (ch === '\\') { cur += s[++i] ?? ''; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts;
}

/** Line starts per source text, computed once, so a line lookup is a binary search. */
const lineIndex = new Map();
function lineAt(src, offset) {
    let starts = lineIndex.get(src);
    if (!starts) {
        starts = [0];
        for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
        lineIndex.set(src, starts);
    }
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
}

/**
 * Parse the stylesheet. Returns
 *   { rules: [{ ctx, selectorText, selectors, decls: [{prop, value, important, offset}], start, open, close }],
 *     blocks: [{ kind: 'media'|'keyframes', prelude, start, open, close }] }
 * `ctx` is '' at top level, '@media <query>' or '@keyframes <name>'.
 */
export function parseCss(src) {
    const s = blankComments(src);
    const rules = [];
    const blocks = [];
    let i = 0;

    function readBody(open) {
        // From just after `{` to the matching `}` of a declaration block (no nested blocks).
        let quote = null;
        let depth = 0;
        for (let j = open + 1; j < s.length; j++) {
            const ch = s[j];
            if (quote) {
                if (ch === '\\') { j++; continue; }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            else if (ch === '{') throw new Error(`nested block inside a declaration list at line ${lineAt(src, j)}`);
            else if (ch === '}' && depth === 0) return j;
        }
        throw new Error(`unclosed declaration block opened at line ${lineAt(src, open)}`);
    }

    function parseDecls(open, close) {
        const body = s.slice(open + 1, close);
        const decls = [];
        let cursor = open + 1;
        for (const raw of splitTop(body, ';')) {
            const at = cursor;
            cursor += raw.length + 1;
            if (!raw.trim()) continue;
            const colon = raw.indexOf(':');
            if (colon < 0) throw new Error(`declaration without a colon at line ${lineAt(src, at)}: ${raw.trim()}`);
            const prop = raw.slice(0, colon).trim();
            let value = normWs(raw.slice(colon + 1));
            let important = false;
            const imp = value.match(/\s*!\s*important$/i);
            if (imp) { important = true; value = value.slice(0, imp.index).trim(); }
            if (!/^(--[\w-]+|-?[a-z][a-z0-9-]*)$/i.test(prop)) {
                throw new Error(`unexpected property name "${prop}" at line ${lineAt(src, at)}`);
            }
            const lead = raw.length - raw.trimStart().length;
            decls.push({ prop: prop.startsWith('--') ? prop : prop.toLowerCase(), value, important, offset: at + lead });
        }
        return decls;
    }

    function parseRuleList(from, until, ctx) {
        // Style rules between `from` and `until` (exclusive); returns the index after the list.
        let j = from;
        while (j < until) {
            while (j < until && /\s/.test(s[j])) j++;
            if (j >= until) break;
            if (s[j] === '}') return j;
            if (s[j] === '@') {
                if (ctx === '') return j;
                throw new Error(`nested at-rule at line ${lineAt(src, j)}`);
            }
            const open = s.indexOf('{', j);
            if (open < 0 || open > until) throw new Error(`selector without a block at line ${lineAt(src, j)}`);
            const selectorText = normWs(s.slice(j, open));
            if (!selectorText) throw new Error(`empty selector at line ${lineAt(src, j)}`);
            if (selectorText.includes('}') || selectorText.includes(';')) throw new Error(`stray text before a rule at line ${lineAt(src, j)}: ${selectorText}`);
            const close = readBody(open);
            rules.push({
                ctx,
                selectorText,
                selectors: splitTop(selectorText, ',').map((x) => normWs(x)),
                decls: parseDecls(open, close),
                start: j,
                open,
                close,
            });
            j = close + 1;
        }
        return j;
    }

    while (i < s.length) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) break;
        if (s[i] === '@') {
            const open = s.indexOf('{', i);
            const semi = s.indexOf(';', i);
            if (open < 0 || (semi >= 0 && semi < open)) throw new Error(`statement at-rule at line ${lineAt(src, i)} is not supported`);
            const prelude = normWs(s.slice(i, open));
            const m = prelude.match(/^@(media|keyframes|-webkit-keyframes)\s+(.+)$/i);
            if (!m) throw new Error(`unsupported at-rule "${prelude}" at line ${lineAt(src, i)}`);
            const kind = m[1].toLowerCase() === 'media' ? 'media' : 'keyframes';
            const ctx = kind === 'media' ? `@media ${m[2]}` : `@keyframes ${m[2]}`;
            const end = parseRuleList(open + 1, s.length, ctx);
            if (s[end] !== '}') throw new Error(`unclosed ${prelude} at line ${lineAt(src, i)}`);
            blocks.push({ kind, prelude, start: i, open, close: end });
            i = end + 1;
            continue;
        }
        if (s[i] === '}') throw new Error(`a '}' with nothing open at line ${lineAt(src, i)}`);
        i = parseRuleList(i, s.length, '');
        if (s[i] === '}') throw new Error(`a '}' with nothing open at line ${lineAt(src, i)}`);
    }
    return { rules, blocks, lineAt: (off) => lineAt(src, off) };
}

/** Serialise a parse back to text (used by the round-trip self-check). */
export function serialize(parsed) {
    const items = [
        ...parsed.rules.map((r) => ({ at: r.start, r })),
        ...parsed.blocks.map((b) => ({ at: b.start, b })),
    ].sort((a, b) => a.at - b.at);
    let out = '';
    const openBlocks = [];
    for (const it of items) {
        while (openBlocks.length && it.at > openBlocks[openBlocks.length - 1].close) { out += '}'; openBlocks.pop(); }
        if (it.b) { out += `${it.b.prelude}{`; openBlocks.push(it.b); continue; }
        const r = it.r;
        out += `${r.selectorText}{${r.decls.map((d) => `${d.prop}:${d.value}${d.important ? '!important' : ''}`).join(';')}}`;
    }
    while (openBlocks.length) { out += '}'; openBlocks.pop(); }
    return out;
}

/** The parser's checks on itself. Throws on a mismatch; returns counts. */
export function selfCheck(src) {
    const parsed = parseCss(src);
    const stripped = blankComments(src).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => m.replace(/[{}]/g, ' '));
    const braces = (stripped.match(/\{/g) || []).length;
    const closes = (stripped.match(/\}/g) || []).length;
    const counted = parsed.rules.length + parsed.blocks.length;
    if (braces !== closes) throw new Error(`brace imbalance: ${braces} '{' vs ${closes} '}'`);
    if (counted !== braces) throw new Error(`parsed ${parsed.rules.length} rules + ${parsed.blocks.length} at-rule blocks = ${counted}, but the source opens ${braces} blocks`);
    // Round trip: the source minus comments and minus ALL whitespace and the trailing `;` of each
    // block must equal the serialisation under the same normalisation.
    const squash = (t) => t.replace(/\s+/g, '').replace(/;+\}/g, '}').replace(/;;+/g, ';');
    const a = squash(blankComments(src));
    const b = squash(serialize(parsed));
    if (a !== b) {
        let k = 0;
        while (k < a.length && a[k] === b[k]) k++;
        throw new Error(`round trip differs at squashed offset ${k}: source «${a.slice(k - 40, k + 40)}» vs parse «${b.slice(k - 40, k + 40)}»`);
    }
    const decls = parsed.rules.reduce((n, r) => n + r.decls.length, 0);
    return { parsed, rules: parsed.rules.length, blocks: parsed.blocks.length, decls, braces };
}

// ─── Selectors ──────────────────────────────────────────────────────────────

const LEGACY_PSEUDO_ELEMENTS = new Set(['before', 'after', 'first-line', 'first-letter']);

/** Specificity [a, b, c] of one complex selector. */
export function specificity(sel) {
    let a = 0, b = 0, c = 0;
    let i = 0;
    const n = sel.length;
    const readIdent = () => {
        let start = i;
        while (i < n && /[\w\-\\]/.test(sel[i])) { if (sel[i] === '\\') i++; i++; }
        return sel.slice(start, i);
    };
    const readParens = () => {
        // sel[i] === '('; returns inner text, leaves i after ')'
        let depth = 0;
        const start = i + 1;
        let quote = null;
        for (; i < n; i++) {
            const ch = sel[i];
            if (quote) { if (ch === '\\') { i++; continue; } if (ch === quote) quote = null; continue; }
            if (ch === '"' || ch === "'") { quote = ch; continue; }
            if (ch === '(') depth++;
            else if (ch === ')') { depth--; if (depth === 0) { i++; return sel.slice(start, i - 1); } }
        }
        throw new Error(`unbalanced parentheses in selector ${sel}`);
    };
    const maxOf = (list) => {
        let best = [0, 0, 0];
        for (const part of splitTop(list, ',')) {
            const sp = specificity(part.trim());
            if (cmpSpec(sp, best) > 0) best = sp;
        }
        return best;
    };
    while (i < n) {
        const ch = sel[i];
        if (ch === '#') { i++; readIdent(); a++; continue; }
        if (ch === '.') { i++; readIdent(); b++; continue; }
        if (ch === '[') {
            let quote = null;
            for (; i < n; i++) {
                const q = sel[i];
                if (quote) { if (q === '\\') { i++; continue; } if (q === quote) quote = null; continue; }
                if (q === '"' || q === "'") { quote = q; continue; }
                if (q === ']') { i++; break; }
            }
            b++;
            continue;
        }
        if (ch === ':') {
            if (sel[i + 1] === ':') {
                i += 2; readIdent();
                if (sel[i] === '(') readParens();
                c++;
                continue;
            }
            i++;
            const name = readIdent().toLowerCase();
            if (LEGACY_PSEUDO_ELEMENTS.has(name)) { c++; continue; }
            if (sel[i] === '(') {
                const inner = readParens();
                if (name === 'where') continue;
                if (['is', 'not', 'has', 'matches', '-webkit-any', '-moz-any'].includes(name)) {
                    const sp = maxOf(inner);
                    a += sp[0]; b += sp[1]; c += sp[2];
                    continue;
                }
                if (name === 'nth-child' || name === 'nth-last-child') {
                    b++;
                    const of = inner.match(/\sof\s(.+)$/);
                    if (of) { const sp = maxOf(of[1]); a += sp[0]; b += sp[1]; c += sp[2]; }
                    continue;
                }
                b++;
                continue;
            }
            b++;
            continue;
        }
        if (ch === '*') { i++; continue; }
        if (/[a-zA-Z_\\-]/.test(ch)) { readIdent(); c++; continue; }
        // combinators, whitespace, `|`
        i++;
    }
    return [a, b, c];
}

export function cmpSpec(x, y) {
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The last compound of a complex selector: its element type, ids and pseudo-element. */
export function subjectOf(sel) {
    // Split on combinators at depth 0.
    const parts = [];
    let depth = 0, quote = null, cur = '';
    for (let i = 0; i < sel.length; i++) {
        const ch = sel[i];
        if (quote) { cur += ch; if (ch === '\\') { cur += sel[++i] ?? ''; continue; } if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (depth === 0 && /[\s>+~]/.test(ch)) { if (cur) parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur) parts.push(cur);
    const last = parts[parts.length - 1] || '';
    // Strip functional arguments before looking at the compound's own simple selectors.
    let flat = '';
    depth = 0;
    for (const ch of last) {
        if (ch === '(' || ch === '[') depth++;
        if (depth === 0) flat += ch;
        if (ch === ')' || ch === ']') depth--;
    }
    const type = (flat.match(/^([a-zA-Z][\w-]*)/) || [])[1]?.toLowerCase() || null;
    const ids = [...flat.matchAll(/#([\w-]+)/g)].map((m) => m[1]).sort();
    let pseudo = (flat.match(/::([\w-]+)/) || [])[1] || null;
    if (!pseudo) {
        const legacy = [...flat.matchAll(/(?<!:):([\w-]+)/g)].map((m) => m[1]).find((x) => LEGACY_PSEUDO_ELEMENTS.has(x));
        if (legacy) pseudo = legacy;
    }
    // A functional pseudo-element (::view-transition-new(*)) keeps its argument.
    if (pseudo) {
        const fm = last.match(new RegExp(`::?${pseudo}(\\([^)]*\\))?`));
        if (fm && fm[1]) pseudo += fm[1];
    }
    return { type, ids, pseudo };
}

/** False only when no element (or pseudo-element) can match both subjects. */
export function subjectsMayMeet(x, y) {
    if ((x.pseudo || '') !== (y.pseudo || '')) return false;
    if (x.type && y.type && x.type !== y.type) return false;
    if (x.ids.length && y.ids.length && x.ids.join('#') !== y.ids.join('#')) return false;
    return true;
}

// ─── Media contexts ─────────────────────────────────────────────────────────

function mediaConstraints(ctx) {
    const q = ctx.replace(/^@media\s+/, '');
    const c = { min: -Infinity, max: Infinity, feats: {} };
    for (const m of q.matchAll(/\(\s*([\w-]+)\s*:\s*([^)]+?)\s*\)/g)) {
        const [, f, v] = m;
        const px = v.match(/^(\d+(?:\.\d+)?)px$/);
        if (f === 'min-width' && px) c.min = Math.max(c.min, +px[1]);
        else if (f === 'max-width' && px) c.max = Math.min(c.max, +px[1]);
        else c.feats[f] = v;
    }
    if (/\bnot\b|,|\bor\b/.test(q)) c.opaque = true;
    return c;
}

/** False only when the two contexts can never apply at the same time. */
export function contextsMayMeet(x, y) {
    if (x === y) return true;
    if (x.startsWith('@keyframes') || y.startsWith('@keyframes')) return false;
    if (x === '' || y === '') return true;
    const a = mediaConstraints(x), b = mediaConstraints(y);
    if (a.opaque || b.opaque) return true;
    if (a.min > b.max || b.min > a.max) return false;
    for (const f of Object.keys(a.feats)) {
        if (f in b.feats && a.feats[f] !== b.feats[f] && ['hover', 'pointer', 'prefers-reduced-motion', 'prefers-color-scheme', 'any-hover'].includes(f)) return false;
    }
    return true;
}

// ─── Properties: what each declaration can set ──────────────────────────────

const BOX_SIDES = ['bs', 'be', 'is', 'ie'];
function sidesOf(part) {
    switch (part) {
        case undefined: case '': return BOX_SIDES;
        case 'top': return ['bs'];
        case 'bottom': return ['be'];
        case 'left': case 'right': return ['is', 'ie'];
        case 'block': return ['bs', 'be'];
        case 'inline': return ['is', 'ie'];
        case 'block-start': return ['bs'];
        case 'block-end': return ['be'];
        case 'inline-start': return ['is'];
        case 'inline-end': return ['ie'];
        default: return null;
    }
}
const SIDE_WORDS = 'top|bottom|left|right|block-start|block-end|inline-start|inline-end|block|inline';
const BORDER_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);

/** Value tokens at depth 0. */
function tokens(v) {
    return splitTop(v, ' ').map((t) => t.trim()).filter(Boolean);
}

/** Per-side values of a 1–4 value physical box shorthand; logical sides get every value they can take. */
function boxValues(vals) {
    if (vals.length < 1 || vals.length > 4) return null;
    const [t, r = t, bt = t, l = r] = vals;
    const lr = r === l ? [r] : [r, l];
    return { bs: [t], be: [bt], is: lr, ie: lr };
}
function pairValues(vals, first, second) {
    if (vals.length < 1 || vals.length > 2) return null;
    return { [first]: [vals[0]], [second]: [vals[1] ?? vals[0]] };
}

/**
 * Atoms a declaration sets, each with the list of values it may compute to there.
 * Returns Map(atom → string[] | null). null means "unknown value" (always a conflict).
 */
export function atomsOf(prop, value) {
    const out = new Map();
    const set = (atom, vals) => out.set(atom, vals);
    const p = prop.replace(/^-(webkit|moz|ms)-/, '');
    const cssWide = /^(inherit|initial|unset|revert|revert-layer)$/.test(value);
    let m;

    // margin / padding / scroll-margin / scroll-padding (and inset, whose longhands are top/left…)
    if ((m = p.match(new RegExp(`^(margin|padding|scroll-margin|scroll-padding|inset)(?:-(${SIDE_WORDS}))?$`)))) {
        const base = m[1], part = m[2];
        const sides = sidesOf(part);
        let per = null;
        if (!cssWide) {
            const v = tokens(value);
            if (!part) per = boxValues(v);
            else if (part === 'block') per = pairValues(v, 'bs', 'be');
            else if (part === 'inline') per = pairValues(v, 'is', 'ie');
            else if (v.length === 1) per = Object.fromEntries(sides.map((sd) => [sd, v]));
        }
        for (const sd of sides) set(`${base}:${sd}`, per ? per[sd] : null);
        return out;
    }
    if ((m = p.match(/^(top|bottom|left|right)$/))) {
        for (const sd of sidesOf(m[1])) set(`inset:${sd}`, cssWide ? null : [value]);
        return out;
    }
    // border family
    if ((m = p.match(new RegExp(`^border(?:-(${SIDE_WORDS}))?(?:-(width|style|color))?$`)))) {
        const sides = sidesOf(m[1]);
        const which = m[2] ? [m[2]] : ['width', 'style', 'color'];
        let vals = null;
        if (!cssWide) {
            if (m[2]) {
                const v = tokens(value);
                if (!m[1]) {
                    const per = boxValues(v);
                    if (per) { for (const sd of sides) set(`border-${m[2]}:${sd}`, per[sd]); return out; }
                } else if (m[1] === 'block' || m[1] === 'inline') {
                    const per = m[1] === 'block' ? pairValues(v, 'bs', 'be') : pairValues(v, 'is', 'ie');
                    if (per) { for (const sd of sides) set(`border-${m[2]}:${sd}`, per[sd]); return out; }
                } else if (v.length === 1) {
                    for (const sd of sides) set(`border-${m[2]}:${sd}`, v);
                    return out;
                }
                for (const sd of sides) set(`border-${m[2]}:${sd}`, null);
                return out;
            }
            // shorthand: <width> || <style> || <color>
            const v = tokens(value);
            const parsed = { width: 'medium', style: 'none', color: 'currentcolor' };
            let ok = v.length >= 1 && v.length <= 3;
            const rest = [];
            for (const t of v) {
                if (BORDER_STYLES.has(t)) parsed.style = t;
                else if (/^(thin|medium|thick|0|-?\d*\.?\d+(px|em|rem|%)?)$/.test(t) || /^calc\(/.test(t)) parsed.width = t;
                else rest.push(t);
            }
            if (rest.length > 1) ok = false;
            if (rest.length === 1) parsed.color = rest[0];
            vals = ok ? parsed : null;
        }
        for (const w of which) for (const sd of sides) set(`border-${w}:${sd}`, vals ? [vals[w]] : null);
        return out;
    }
    if (p === 'border-radius') {
        for (const c of ['ss', 'se', 'es', 'ee']) set(`radius:${c}`, null);
        const v = cssWide || value.includes('/') ? null : tokens(value);
        if (v && v.length === 1) for (const c of ['ss', 'se', 'es', 'ee']) set(`radius:${c}`, v);
        return out;
    }
    if ((m = p.match(/^border-(start|end)-(start|end)-radius$/))) {
        set(`radius:${m[1][0]}${m[2][0]}`, [value]);
        return out;
    }
    if ((m = p.match(/^border-(top|bottom)-(left|right)-radius$/))) {
        const row = m[1] === 'top' ? 's' : 'e';
        set(`radius:${row}s`, [value]); set(`radius:${row}e`, [value]);
        return out;
    }
    if (p === 'outline') { for (const w of ['width', 'style', 'color']) set(`outline-${w}`, null); return out; }
    if (p === 'gap' || p === 'grid-gap') {
        const v = cssWide ? null : tokens(value);
        const per = v ? pairValues(v, 'row', 'column') : null;
        set('row-gap', per ? per.row : null); set('column-gap', per ? per.column : null);
        return out;
    }
    if (p === 'grid-row-gap') { set('row-gap', [value]); return out; }
    if (p === 'grid-column-gap') { set('column-gap', [value]); return out; }
    if (p === 'overflow') {
        const v = cssWide ? null : tokens(value);
        const per = v ? pairValues(v, 'x', 'y') : null;
        set('overflow-x', per ? per.x : null); set('overflow-y', per ? per.y : null);
        return out;
    }
    if (p === 'overflow-inline') { set('overflow-x', [value]); return out; }
    if (p === 'overflow-block') { set('overflow-y', [value]); return out; }
    if (p === 'overscroll-behavior') {
        const v = cssWide ? null : tokens(value);
        const per = v ? pairValues(v, 'x', 'y') : null;
        set('overscroll-behavior-x', per ? per.x : null); set('overscroll-behavior-y', per ? per.y : null);
        return out;
    }
    if (p === 'overscroll-behavior-inline') { set('overscroll-behavior-x', [value]); return out; }
    if (p === 'overscroll-behavior-block') { set('overscroll-behavior-y', [value]); return out; }
    const SIZE = { 'width': 'size-inline', 'inline-size': 'size-inline', 'height': 'size-block', 'block-size': 'size-block',
        'min-width': 'min-inline', 'min-inline-size': 'min-inline', 'min-height': 'min-block', 'min-block-size': 'min-block',
        'max-width': 'max-inline', 'max-inline-size': 'max-inline', 'max-height': 'max-block', 'max-block-size': 'max-block' };
    if (SIZE[p]) { set(SIZE[p], [value]); return out; }
    const SHORT = {
        'background': ['background-color', 'background-image', 'background-position-x', 'background-position-y', 'background-size', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip'],
        'background-position': ['background-position-x', 'background-position-y'],
        'font': ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'line-height', 'font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position', 'font-kerning', 'font-size-adjust', 'font-feature-settings', 'font-optical-sizing', 'font-variation-settings'],
        'font-variant': ['font-variant-caps', 'font-variant-numeric', 'font-variant-ligatures', 'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position'],
        'flex': ['flex-grow', 'flex-shrink', 'flex-basis'],
        'flex-flow': ['flex-direction', 'flex-wrap'],
        'grid-template': ['grid-template-columns', 'grid-template-rows', 'grid-template-areas'],
        'grid': ['grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-columns', 'grid-auto-rows', 'grid-auto-flow'],
        'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
        'grid-row': ['grid-row-start', 'grid-row-end'],
        'grid-column': ['grid-column-start', 'grid-column-end'],
        'place-items': ['align-items', 'justify-items'],
        'place-content': ['align-content', 'justify-content'],
        'place-self': ['align-self', 'justify-self'],
        'transition': ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior'],
        'animation': ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state', 'animation-timeline', 'animation-composition'],
        'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
        'text-decoration': ['text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-decoration-thickness'],
        'white-space': ['white-space-collapse', 'text-wrap-mode'],
        'text-wrap': ['text-wrap-mode', 'text-wrap-style'],
        'columns': ['column-width', 'column-count'],
        'column-rule': ['column-rule-width', 'column-rule-style', 'column-rule-color'],
        'mask': ['mask-image', 'mask-position', 'mask-size', 'mask-repeat', 'mask-origin', 'mask-clip', 'mask-composite', 'mask-mode'],
        'container': ['container-name', 'container-type'],
        'contain-intrinsic-size': ['contain-intrinsic-inline-size', 'contain-intrinsic-block-size'],
        'text-emphasis': ['text-emphasis-style', 'text-emphasis-color'],
        'line-clamp': ['line-clamp'],
    };
    if (SHORT[p]) { for (const a of SHORT[p]) set(a, null); return out; }
    set(p, [value]);
    return out;
}

/**
 * True when swapping the order of two declarations on one element could change a computed
 * value: they share an atom and do not provably say the same thing there.
 */
export function propsConflict(d1, d2) {
    if (d1.prop === d2.prop && d1.value === d2.value) return false;
    const a = atomsOf(d1.prop, d1.value);
    const b = atomsOf(d2.prop, d2.value);
    for (const [atom, va] of a) {
        if (!b.has(atom)) continue;
        const vb = b.get(atom);
        if (!va || !vb || va.length !== 1 || vb.length !== 1 || va[0] !== vb[0]) return true;
    }
    return false;
}

// ─── Markup: which classes can share an element ─────────────────────────────
//
// Two class selectors of equal specificity compete only on an element that carries both
// subjects' classes. The stylesheet cannot say whether such an element exists; the markup can.
// Every class the dashboard paints enters through one of these, and this reads all of them:
//
//   origins   each `class="…"` attribute in index.html and the scripts, and each
//             `x.className = …`. A `${…}` slot made of literals (`${on ? 'is-on' : ''}`,
//             `html.raw(' is-wide')`, `a || 'b'`, nested templates) is expanded into every class
//             list it can produce. Any other slot is OPEN. Standing alone (`class="${cls}"`) it
//             can hold any number of FREE words; glued to text (`is-${state}`, `phone--${tab}`)
//             it is ONE class, matched by that prefix/suffix.
//   free      the words of every JS string literal outside class attributes (comments skipped):
//             anything that could reach an open slot through a variable. Left out: other
//             attribute values (ids, labels, icon names), selector lookups ('.x', '#x'), tag names,
//             string arguments of getElementById / querySelector(All) / closest / matches /
//             paint…() / markInvalid, and ids and keys by their context (`id: …`, `focusKey: …`,
//             `const titleId = …`, an aria-describedby list, what a …Id()/…Key() method returns).
//   anywhere  classes a `classList.add/toggle/replace` puts on whatever element it holds, and the
//             words icons.js adds to every generated <svg>.
//
// Two subjects may meet iff one expansion of one origin can carry every class either requires.
// The assumptions this rests on, each checked against rendered markup by css-fixtures.mjs:
//   1. API data never spells a component class ('studio-hint' is not a post status);
//   2. a slot glued to a class name holds one word;
//   3. a string used as an id, a key or a lookup is not also used as a class.

const TOKEN_RUN = /[A-Za-z0-9_-]+/g;
const OPEN = '\u0001';
const OPEN_BOTH = '\u0002';

/** Index after the `}` closing the slot whose `${` starts at `open`. */
function skipSlot(text, open) {
    let i = open + 2;
    let depth = 1;
    while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === "'" || ch === '"') {
            const q = ch; i++;
            while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
            i++; continue;
        }
        if (ch === '`') { i = skipTemplate(text, i); continue; }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return i;
}
function skipTemplate(text, open) {
    let i = open + 1;
    while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '$' && text[i + 1] === '{') { i = skipSlot(text, i); continue; }
        i++;
    }
    return i + 1;
}

/** Split an expression at a top-level operator; returns [left, right] or null. */
function splitOp(expr, op) {
    let depth = 0;
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === "'" || ch === '"') { const q = ch; i++; while (i < expr.length && expr[i] !== q) { if (expr[i] === '\\') i++; i++; } continue; }
        if (ch === '`') { i = skipTemplate(expr, i) - 1; continue; }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (depth === 0 && expr.startsWith(op, i)) return [expr.slice(0, i), expr.slice(i + op.length)];
    }
    return null;
}

/** Top-level ternary: [cond, a, b] or null. */
function splitTernary(expr) {
    let depth = 0, q = -1;
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i];
        if (ch === "'" || ch === '"') { const qq = ch; i++; while (i < expr.length && expr[i] !== qq) { if (expr[i] === '\\') i++; i++; } continue; }
        if (ch === '`') { i = skipTemplate(expr, i) - 1; continue; }
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
        else if (depth === 0 && ch === '?' && expr[i + 1] !== '.' && expr[i + 1] !== '?' && expr[i - 1] !== '?') {
            if (q < 0) { q = i; let nest = 0; depth = 0;
                for (let j = i + 1; j < expr.length; j++) {
                    const c = expr[j];
                    if (c === "'" || c === '"') { const qq = c; j++; while (j < expr.length && expr[j] !== qq) { if (expr[j] === '\\') j++; j++; } continue; }
                    if (c === '`') { j = skipTemplate(expr, j) - 1; continue; }
                    if ('([{'.includes(c)) depth++;
                    else if (')]}'.includes(c)) depth--;
                    else if (depth === 0 && c === '?' && expr[j + 1] !== '.' && expr[j + 1] !== '?' && expr[j - 1] !== '?') nest++;
                    else if (depth === 0 && c === ':') { if (nest === 0) return [expr.slice(0, q), expr.slice(q + 1, j), expr.slice(j + 1)]; nest--; }
                }
                return null;
            }
        }
    }
    return null;
}

/**
 * Every string a slot expression can render. Unknown parts (a variable, a call) are the OPEN
 * marker, so `html\` ${cls}\`` renders ` \u0001` — a separate class — and `is-${state}` renders
 * `is-\u0001` — one class with a known prefix. Past `budget` combinations it gives up and returns
 * a marker that means both.
 */
function slotValues(expr, budget = 256) {
    let e = expr.trim();
    for (;;) {
        if (!(e.startsWith('(') && e.endsWith(')'))) break;
        let depth = 0, wraps = true;
        for (let i = 0; i < e.length; i++) { if (e[i] === '(') depth++; else if (e[i] === ')') { depth--; if (depth === 0 && i < e.length - 1) { wraps = false; break; } } }
        if (!wraps) break;
        e = e.slice(1, -1).trim();
    }
    if (/^'(?:\\.|[^'\\])*'$/.test(e) || /^"(?:\\.|[^"\\])*"$/.test(e)) return [e.slice(1, -1).replace(/\\(.)/g, (m, c) => unescape1(c))];
    const tagged = e.match(/^(?:html(?:\.raw)?)?`/);
    if (tagged && skipTemplate(e, tagged[0].length - 1) === e.length) {
        // A (possibly html-tagged) template: its chunks and each slot's values, in combination.
        let strings = [''];
        let i = tagged[0].length, chunk = '';
        const flush = () => { strings = strings.map((x) => x + chunk); chunk = ''; };
        while (i < e.length - 1) {
            if (e[i] === '\\') { chunk += unescape1(e[i + 1]); i += 2; continue; }
            if (e[i] === '$' && e[i + 1] === '{') {
                flush();
                const end = skipSlot(e, i);
                const vals = slotValues(e.slice(i + 2, end - 1), budget);
                const next = [];
                for (const x of strings) for (const v of vals) next.push(x + v);
                strings = next.length > budget ? [OPEN_BOTH] : next;
                i = end; continue;
            }
            chunk += e[i]; i++;
        }
        flush();
        return [...new Set(strings)];
    }
    if (/^(true|false|null|undefined|-?\d+(\.\d+)?)$/.test(e)) return [e === 'null' || e === 'undefined' || e === 'false' ? '' : e];
    const raw = e.match(/^html\.raw\(([\s\S]*)\)$/);
    if (raw && splitOp(raw[1], ',') === null) return slotValues(raw[1], budget);
    const tern = splitTernary(e);
    if (tern) return [...new Set([...slotValues(tern[1], budget), ...slotValues(tern[2], budget)])];
    for (const op of ['||', '??']) {
        const sp = splitOp(e, op);
        if (sp) return [...new Set([...slotValues(sp[0], budget), ...slotValues(sp[1], budget)])];
    }
    const and = splitOp(e, '&&');
    if (and) return ['', ...slotValues(and[1], budget)];
    return [OPEN];
}

/**
 * Expand a class value (text with `${…}` slots) into class lists. Each alternative is
 * { tokens:Set, patterns:[[prefix, suffix]], open:boolean }. A marker standing alone is an OPEN
 * slot (any number of free words); a marker glued to text is one class matched by its prefix
 * and suffix — a slot glued to a class name holds one word (`is-${state}`, `phone--${tab}`).
 */
function expandClassValue(value) {
    return slotValues('`' + value + '`').map((str) => {
        const alt = { tokens: new Set(), patterns: [], open: false };
        for (const tok of str.split(/\s+/).filter(Boolean)) {
            if (!tok.includes(OPEN) && !tok.includes(OPEN_BOTH)) { alt.tokens.add(tok); continue; }
            const both = tok.includes(OPEN_BOTH);
            const t = tok.replaceAll(OPEN_BOTH, OPEN);
            const pre = t.slice(0, t.indexOf(OPEN)), post = t.slice(t.lastIndexOf(OPEN) + 1);
            if (both || (!pre && !post)) alt.open = true;
            if (pre || post) alt.patterns.push([pre, post]);
        }
        return alt;
    });
}

/** One escaped character: the whitespace escapes are whitespace, anything else is itself. */
function unescape1(ch) {
    return ch === undefined ? '' : 'ntrfv'.includes(ch) ? ' ' : ch;
}

/** String literals of a JS source, with the text just before each. Comments are skipped. */
function jsStringLiterals(text) {
    const out = [];
    let i = 0;
    let prevSignificant = '';
    const regexAllowed = () => prevSignificant === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(prevSignificant) || /\b(return|typeof|case|in|of|delete|void|throw|new)$/.test(prevSignificant);
    const lexTemplate = (open) => {
        // Chunks of the template; recurse into slots for nested literals.
        let j = open + 1, chunk = '', chunkStart = j, afterSlot = false;
        const before = text.slice(Math.max(0, open - 80), open);
        while (j < text.length && text[j] !== '`') {
            if (text[j] === '\\') { chunk += unescape1(text[j + 1]); j += 2; continue; }
            if (text[j] === '$' && text[j + 1] === '{') {
                out.push({ value: chunk, before, gluedStart: afterSlot, gluedEnd: true, at: chunkStart });
                const end = skipSlot(text, j);
                for (const lit of jsStringLiterals(text.slice(j + 2, end - 1))) out.push(lit);
                chunk = ''; j = end; chunkStart = j; afterSlot = true; continue;
            }
            chunk += text[j]; j++;
        }
        out.push({ value: chunk, before, gluedStart: afterSlot, gluedEnd: false, at: chunkStart });
        return j + 1;
    };
    while (i < text.length) {
        const ch = text[i];
        if (ch === '/' && text[i + 1] === '/') { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl; continue; }
        if (ch === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
        if (ch === "'" || ch === '"') {
            let j = i + 1, v = '';
            while (j < text.length && text[j] !== ch && text[j] !== '\n') { if (text[j] === '\\') { v += unescape1(text[j + 1]); j += 2; continue; } v += text[j]; j++; }
            out.push({ value: v, before: text.slice(Math.max(0, i - 80), i), gluedStart: false, gluedEnd: false, quoted: true, at: i + 1 });
            i = j + 1; prevSignificant = 'x'; continue;
        }
        if (ch === '`') { i = lexTemplate(i); prevSignificant = 'x'; continue; }
        if (ch === '/' && regexAllowed()) {
            // Regex literal: skip to the closing slash (respecting classes and escapes).
            let j = i + 1, inClass = false;
            while (j < text.length && text[j] !== '\n') {
                if (text[j] === '\\') { j += 2; continue; }
                if (text[j] === '[') inClass = true;
                else if (text[j] === ']') inClass = false;
                else if (text[j] === '/' && !inClass) break;
                j++;
            }
            i = j + 1;
            while (/[a-z]/i.test(text[i] || '')) i++;
            prevSignificant = 'x';
            continue;
        }
        if (!/\s/.test(ch)) {
            if (/[\w$]/.test(ch)) {
                let j = i; while (j < text.length && /[\w$]/.test(text[j])) j++;
                prevSignificant = text.slice(i, j); i = j; continue;
            }
            prevSignificant = ch;
        }
        i++;
    }
    return out;
}

const LOOKUP_CALL = /(?:getElementById|querySelector|querySelectorAll|closest|matches|getAttribute|hasAttribute|paint\w*|markInvalid)\(\s*$/;
/**
 * A literal that is an id or a key, never a class: `id: …`, `focusKey: …`, `const titleId = …`,
 * an entry of an aria-describedby list, or what a `…Id()` / `…Key()` / `…FileName()` method returns.
 */
const ID_OR_KEY = /(?:\b(?:id|key|for|action|icon|href|src)|Id|Key|Ids|Keys)\s*[:=]\s*$|\b(?:described|labelledby|labelledBy)\s*=\s*\[[^;]*$|\w(?:Id|Key|FileName)\([^)]*\)\s*\{[^}]*\breturn\b[^;]*$/;
const NON_CLASS_ATTR = /\b(?:id|for|name|href|src|role|type|value|lang|dir|alt|title|placeholder|aria-[\w-]+|data-[\w-]+)="(?:\$\{[^}\n]*\}|[^"\n])*"/g;

/** Read class sources from `[file, text]` pairs. */
export function scanMarkup(sources) {
    const origins = [];
    const free = { tokens: new Set(), patterns: [] };
    const anywhere = { tokens: new Set(), prefixes: new Set() };
    for (const [file, text] of sources) {
        const isScript = file.endsWith('.js');
        // Class attributes → origins; their values are then blanked so they are not free words.
        let blanked = '';
        let from = 0;
        const re = /\bclass="/g;
        let m;
        while ((m = re.exec(text))) {
            const start = m.index + m[0].length;
            let j = start;
            while (j < text.length && text[j] !== '"') {
                if (text[j] === '$' && text[j + 1] === '{') { j = skipSlot(text, j); continue; }
                j++;
            }
            origins.push({ file, at: m.index, alts: expandClassValue(text.slice(start, j)) });
            blanked += text.slice(from, start) + text.slice(start, j).replace(/[^\n`'"${}]/g, ' ');
            from = j;
            re.lastIndex = j + 1;
        }
        blanked += text.slice(from);
        if (!isScript) continue;
        blanked = blanked.replace(NON_CLASS_ATTR, (x) => x.replace(/[^\n`'"${}]/g, ' '));
        // className assignments are origins as well.
        for (const cm of blanked.matchAll(/\.className\s*=\s*(`(?:\\.|\$\{[^}]*\}|[^`\\])*`|'[^'\n]*'|"[^"\n]*"|[^;\n]+)/g)) {
            const rhs = cm[1].trim();
            const q = rhs[0];
            const value = q === '`' || q === "'" || q === '"' ? rhs.slice(1, -1) : '${' + rhs + '}';
            origins.push({ file, at: cm.index, alts: expandClassValue(value) });
        }
        for (const cm of blanked.matchAll(/classList\.(?:add|toggle|replace)\(([^)]*)\)/g)) {
            const arg = cm[1];
            if (!/^\s*['"`]/.test(arg)) { anywhere.tokens.add('*'); continue; }
            for (const lit of jsStringLiterals(arg)) for (const t of lit.value.matchAll(TOKEN_RUN)) anywhere.tokens.add(t[0]);
        }
        const literals = jsStringLiterals(blanked);
        if (/icons\.js$/.test(file)) {
            for (const lit of literals) for (const t of lit.value.matchAll(TOKEN_RUN)) {
                anywhere.tokens.add(t[0]);
                if (t[0].endsWith('-')) anywhere.prefixes.add(t[0]);
            }
        }
        for (const lit of literals) {
            if (LOOKUP_CALL.test(lit.before) || ID_OR_KEY.test(lit.before)) continue;
            const v = lit.value;
            for (const t of v.matchAll(TOKEN_RUN)) {
                const before = v[t.index - 1];
                if (before === '.' || before === '#') continue;
                if (before === '<' || (before === '/' && v[t.index - 2] === '<')) continue; // a tag name
                const tok = t[0];
                const atStart = t.index === 0, atEnd = t.index + tok.length === v.length;
                free.tokens.add(tok);
                // Text glued to a slot, or a quoted fragment meant for concatenation.
                if ((atEnd && lit.gluedEnd) || (lit.quoted && atEnd && tok.endsWith('-'))) free.patterns.push([tok, '', file, lit.at]);
                if ((atStart && lit.gluedStart) || (lit.quoted && atStart && tok.startsWith('-'))) free.patterns.push(['', tok, file, lit.at]);
            }
        }
    }
    const seen = new Set();
    free.patterns = free.patterns.filter(([a, b]) => { const k = `${a}\u0000${b}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { origins, free, anywhere };
}

function matchesPattern(tok, [pre, post]) {
    return tok.length > pre.length + post.length && tok.startsWith(pre) && tok.endsWith(post);
}
function isFree(tok, markup) {
    return markup.free.tokens.has(tok) || markup.free.patterns.some((p) => matchesPattern(tok, p));
}
function isAnywhere(tok, markup) {
    const a = markup.anywhere;
    if (a.tokens.has('*') || a.tokens.has(tok)) return true;
    for (const p of a.prefixes) if (tok.startsWith(p)) return true;
    return false;
}

/**
 * Can one alternative carry every token in `need`? A literal or the open slot covers any number;
 * a glued slot is ONE class, so each pattern covers at most one token (a small matching).
 */
function altCarries(alt, need, markup) {
    const rest = need.filter((t) => !alt.tokens.has(t) && !(alt.open && isFree(t, markup)));
    if (rest.length === 0) return true;
    if (rest.length > alt.patterns.length) return false;
    const used = new Array(alt.patterns.length).fill(false);
    const assign = (k) => {
        if (k === rest.length) return true;
        for (let i = 0; i < alt.patterns.length; i++) {
            if (used[i] || !matchesPattern(rest[k], alt.patterns[i])) continue;
            used[i] = true;
            if (assign(k + 1)) return true;
            used[i] = false;
        }
        return false;
    };
    return assign(0);
}

/** Can one element carry every class in `tokens`? Returns the witness origin, or null. */
export function shareWitness(tokens, markup) {
    const need = [...tokens].filter((t) => !isAnywhere(t, markup));
    if (need.length === 0) return { file: '(any element)', at: 0 };
    for (const o of markup.origins) {
        for (const alt of o.alts) if (altCarries(alt, need, markup)) return o;
    }
    return null;
}
export function mayShareElement(tokens, markup) {
    return shareWitness(tokens, markup) !== null;
}

/** The classes a subject compound requires (not those only named inside :not()/:is()…). */
export function subjectClasses(sel) {
    const parts = [];
    let depth = 0, quote = null, cur = '';
    for (let i = 0; i < sel.length; i++) {
        const ch = sel[i];
        if (quote) { cur += ch; if (ch === '\\') { cur += sel[++i] ?? ''; continue; } if (ch === quote) quote = null; continue; }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth--;
        if (depth === 0 && /[\s>+~]/.test(ch)) { if (cur) parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur) parts.push(cur);
    const last = parts[parts.length - 1] || '';
    let flat = '';
    depth = 0;
    for (const ch of last) {
        if (ch === '(' || ch === '[') depth++;
        if (depth === 0) flat += ch;
        if (ch === ')' || ch === ']') depth--;
    }
    return [...flat.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
}

// ─── Dead selectors ─────────────────────────────────────────────────────────
//
// A selector is dead when a class it requires appears nowhere in dashboard/**/*.{js,html} or
// public/**/*.html — neither as a whole word, nor as something a dynamic construction could
// build: text glued to a template slot (`studio-state-${…}`, `${…}-active`), a quoted fragment
// concatenated with `+` (`'is-' + x`). Removing a dead selector removes map entries nothing
// could ever match, so the comparison reports those separately instead of as differences.

/** Every file the dead-selector search reads. */
export function presenceSources(root = '.') {
    const files = [];
    const walk = (dir, ok) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(full, ok);
            else if (ok(e.name)) files.push(full);
        }
    };
    walk(`${root}/dashboard`, (n) => n.endsWith('.js') || n.endsWith('.html'));
    walk(`${root}/public`, (n) => n.endsWith('.html'));
    return files.map((f) => [f, readFileSync(f, 'utf8')]);
}

export function tokenPresence(sources) {
    const words = new Set();
    const prefixes = new Set();
    const suffixes = new Set();
    for (const [, text] of sources) {
        for (const m of text.matchAll(/[A-Za-z0-9_-]+/g)) words.add(m[0]);
        for (const m of text.matchAll(/([A-Za-z0-9_-]+)\$\{/g)) prefixes.add(m[1]);
        for (const m of text.matchAll(/\}([A-Za-z0-9_-]+)/g)) suffixes.add(m[1]);
        for (const m of text.matchAll(/([A-Za-z0-9_-]+)['"`]\s*\+/g)) prefixes.add(m[1]);
        for (const m of text.matchAll(/\+\s*['"`]([A-Za-z0-9_-]+)/g)) suffixes.add(m[1]);
    }
    return {
        /** null when present; otherwise why it is absent */
        absent(tok) {
            if (words.has(tok)) return null;
            for (const p of prefixes) if (tok.length > p.length && tok.startsWith(p)) return null;
            for (const sfx of suffixes) if (tok.length > sfx.length && tok.endsWith(sfx)) return null;
            return `.${tok} appears nowhere, whole or built`;
        },
    };
}

/** Every class a selector requires (in any compound; not those only inside :not()/:is()…). */
export function requiredClasses(sel) {
    let flat = '';
    let depth = 0;
    for (const ch of sel) {
        if (ch === '(' || ch === '[') depth++;
        if (depth === 0) flat += ch;
        if (ch === ')' || ch === ']') depth--;
    }
    return [...flat.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
}

/** Why a selector can match nothing, or null. */
export function deadReason(sel, presence) {
    for (const tok of requiredClasses(sel)) {
        const why = presence.absent(tok);
        if (why) return why;
    }
    return null;
}

// ─── The map ────────────────────────────────────────────────────────────────

/**
 * Winners: Map(key → { ctx, sel, prop, value, important, order, spec, subject, line, ruleLine }).
 * `order` is the declaration's index in source order, shared by every selector of a grouped rule.
 */
export function declMap(parsed) {
    const map = new Map();
    let order = 0;
    for (const r of parsed.rules) {
        for (const d of r.decls) {
            order++;
            for (const sel of r.selectors) {
                const key = `${r.ctx}\u0001${sel}\u0001${d.prop}`;
                const prev = map.get(key);
                if (prev && prev.important && !d.important) continue;
                map.set(key, {
                    key, ctx: r.ctx, sel, prop: d.prop, value: d.value, important: d.important,
                    order, line: parsed.lineAt(d.offset), ruleLine: parsed.lineAt(r.start),
                });
            }
        }
    }
    for (const w of map.values()) {
        w.spec = w.ctx.startsWith('@keyframes') ? [0, 0, 0] : specificity(w.sel);
        w.subject = w.ctx.startsWith('@keyframes') ? null : subjectOf(w.sel);
    }
    return map;
}

function diffMaps(oldMap, newMap, presence = null, dead = []) {
    const diffs = [];
    for (const [k, o] of oldMap) {
        const n = newMap.get(k);
        const why = !n && presence && !o.ctx.startsWith('@keyframes') ? deadReason(o.sel, presence) : null;
        if (why) dead.push({ key: k, old: o, why });
        else if (!n) diffs.push({ kind: 'removed', key: k, old: o });
        else if (n.value !== o.value || n.important !== o.important) diffs.push({ kind: 'changed', key: k, old: o, new: n });
    }
    for (const [k, n] of newMap) if (!oldMap.has(k)) diffs.push({ kind: 'added', key: k, new: n });
    return diffs;
}

/** Winners whose order relative to the rest changed (not on the longest order-preserving run). */
function movedKeys(oldMap, newMap) {
    const common = [...oldMap.values()].filter((o) => newMap.has(o.key)).sort((x, y) => x.order - y.order);
    const seq = common.map((o) => newMap.get(o.key).order);
    // Longest non-decreasing subsequence (ties are declarations sharing a grouped rule).
    const tails = [], tailIdx = [], prev = new Array(seq.length).fill(-1);
    for (let i = 0; i < seq.length; i++) {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] <= seq[i]) lo = mid + 1; else hi = mid; }
        tails[lo] = seq[i]; tailIdx[lo] = i;
        prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const keep = new Set();
    for (let i = tailIdx[tails.length - 1]; i !== undefined && i >= 0; i = prev[i]) keep.add(common[i].key);
    return common.filter((o) => !keep.has(o.key)).map((o) => o.key);
}

/**
 * Pairs of competing winners whose relative order differs between the two files.
 *
 * Every inverted pair has at least one member off the longest order-preserving run (two members
 * of that run keep their order by construction), so only pairs that involve a `moved` winner
 * need looking at. That is what keeps this linear-ish instead of quadratic over ~6,000 winners.
 */
function crossings(oldMap, newMap, moved, markup = null, disjoint = [], { bothValues = false } = {}) {
    const buckets = new Map();
    const entries = new Map();
    for (const o of oldMap.values()) {
        const n = newMap.get(o.key);
        if (!n || o.ctx.startsWith('@keyframes')) continue;
        const entry = { o, n, atoms: atomsOf(o.prop, o.value), buckets: [] };
        entries.set(o.key, entry);
        for (const atom of entry.atoms.keys()) {
            const b = `${o.important ? '!' : ''}${o.spec.join(',')}\u0001${atom}`;
            if (!buckets.has(b)) buckets.set(b, []);
            buckets.get(b).push(entry);
            entry.buckets.push(b);
        }
    }
    const seen = new Set();
    const out = [];
    for (const key of moved) {
        const x = entries.get(key);
        if (!x) continue;
        for (const b of x.buckets) {
            for (const y of buckets.get(b)) {
                if (y === x) continue;
                const so = Math.sign(x.o.order - y.o.order);
                const sn = Math.sign(x.n.order - y.n.order);
                if (so === sn) continue;
                const pairKey = x.o.key < y.o.key ? `${x.o.key}\u0002${y.o.key}` : `${y.o.key}\u0002${x.o.key}`;
                if (seen.has(pairKey)) continue;
                seen.add(pairKey);
                if (!contextsMayMeet(x.o.ctx, y.o.ctx)) continue;
                if (!subjectsMayMeet(x.o.subject, y.o.subject)) continue;
                // The map check proves the values are unchanged, so conflict is judged on the old ones.
                // A deliberate change (--changes) may have changed one of them: judge both sides.
                if (!propsConflict(x.o, y.o) && !(bothValues && propsConflict(x.n, y.n))) continue;
                const pair = x.o.order < y.o.order ? { a: x, b: y } : { a: y, b: x };
                if (markup) {
                    const need = new Set([...subjectClasses(x.o.sel), ...subjectClasses(y.o.sel)]);
                    if (!mayShareElement(need, markup)) { disjoint.push(pair); continue; }
                }
                out.push(pair);
            }
        }
    }
    return out.sort((p, q) => p.a.o.order - q.a.o.order || p.b.o.order - q.b.o.order);
}

/** The same check without the shortcut, for testing the shortcut. */
export function crossingsExhaustive(oldMap, newMap, markup = null, disjoint = []) {
    return crossings(oldMap, newMap, [...oldMap.keys()], markup, disjoint);
}

function describe(w) {
    const ctx = w.ctx ? `${w.ctx} ` : '';
    return `${ctx}${w.sel} { ${w.prop}: ${w.value}${w.important ? ' !important' : ''} } (line ${w.line})`;
}

/** The files whose markup styles.css paints: the shell and every script that writes markup. */
export function styledSources(root = '.') {
    const files = [`${root}/dashboard/index.html`];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = `${dir}/${e.name}`;
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.js')) files.push(full);
        }
    };
    walk(`${root}/dashboard/js`);
    return files.map((f) => [f, readFileSync(f, 'utf8')]);
}

export function compare(oldSrc, newSrc, { markup = null, presence = null, bothValues = false } = {}) {
    const oldCheck = selfCheck(oldSrc);
    const newCheck = selfCheck(newSrc);
    const oldMap = declMap(oldCheck.parsed);
    const newMap = declMap(newCheck.parsed);
    const moved = movedKeys(oldMap, newMap);
    const disjoint = [];
    const found = crossings(oldMap, newMap, moved, markup, disjoint, { bothValues });
    const dead = [];
    const diffs = diffMaps(oldMap, newMap, presence, dead);
    return { oldCheck, newCheck, oldMap, newMap, diffs, dead, moved, crossings: found, disjoint };
}

// ─── Changes: the report for a DELIBERATE visual pass ──────────────────────
//
//   node scripts/css-declmap.mjs --changes --tags <tags.json> <old.css> <new.css> [<old2> <new2> …]
//
// The same map, read the other way round: instead of proving nothing changed, it lists every
// (context, selector, property) whose final value did, and requires each one to be claimed by
// a tag — a decision of the pass, stated as the selectors, properties and values it may touch:
//
//   { "decisions": { "1": "Inner panels at --radius-md …", … },
//     "tags": [ { "decision": 1, "sel": [".badge"], "prop": ["border-radius"],
//                 "to": ["var(--radius-pill)"] }, … ],
//     "crossings": [ { "a": ".empty-state", "b": ".loader", "prop": "padding", "why": "…" } ],
//     "outranked": [ { "sel": ".studio-section-head", "by": ".monteur-queue .studio-section-head", "why": "…" } ] }
//
// A tag matches a change when its `sel` lists the selector (or its `selRe` matches it), its
// `prop` lists the property (or `propRe` matches it), its `ctx` — if given — lists the media
// context ('' is top level), and its `to` / `from` — if given — list the new / old value, with
// null for "absent" (removed / added). So a tag names what a decision may produce, and a value
// nobody decided on stays UNTAGGED. Untagged changes and unexplained crossings fail the run.
//
// The order check runs too, judging a flipped pair on its old AND new values. And one more
// report, informational: a changed or added winner that another rule outranks (higher
// specificity, !important, or equal specificity and later), outside :hover/:active/:focus…/
// :disabled/:checked states — a context override of the same component, or a type-only rule
// (`.data-table td`) over a class the markup writes on that element. That is where a change
// can be ineffective, or only partly effective; see certainlyOverrides().

const STATE_PSEUDO = /:(hover|active|focus|focus-visible|focus-within|disabled|checked|enabled|visited|target|placeholder-shown)\b/;

/** The changed entries: { kind, key, ctx, sel, prop, old, new, line }. */
export function changedEntries(r) {
    const out = [];
    for (const d of r.diffs) {
        const w = d.new || d.old;
        out.push({
            kind: d.kind, key: d.key, ctx: w.ctx, sel: w.sel, prop: w.prop,
            old: d.old ? d.old.value + (d.old.important ? ' !important' : '') : null,
            new: d.new ? d.new.value + (d.new.important ? ' !important' : '') : null,
            line: d.new ? d.new.line : d.old.line,
            oldLine: d.old ? d.old.line : null,
        });
    }
    return out;
}

function listed(list, v) { return Array.isArray(list) ? list.includes(v) : list === v; }

/** The tags claiming a change (usually one). */
export function tagsFor(change, tags) {
    return tags.filter((t) => {
        if (t.ctx !== undefined && !listed(t.ctx, change.ctx)) return false;
        const selOk = (t.sel && listed(t.sel, change.sel)) || (t.selRe && new RegExp(t.selRe).test(change.sel));
        if (!selOk) return false;
        const propOk = (t.prop && listed(t.prop, change.prop)) || (t.propRe && new RegExp(t.propRe).test(change.prop));
        if (!propOk) return false;
        if (t.to !== undefined && !listed(t.to, change.new)) return false;
        if (t.from !== undefined && !listed(t.from, change.old)) return false;
        return true;
    });
}

/**
 * The element type a class origin is written on (`<td class="…">` → 'td'), or null when the
 * markup does not say (a className assignment, a `<${tag}` template).
 */
function originTag(o, texts) {
    const text = texts.get(o.file);
    if (!text) return null;
    const lt = text.lastIndexOf('<', o.at);
    if (lt < 0) return null;
    const head = text.slice(lt, o.at);
    if (head.replace(/\$\{[^}]*\}/g, '').includes('>')) return null;
    const m = head.match(/^<([a-zA-Z][\w-]*)\b/);
    return m ? m[1].toLowerCase() : null;
}

/** Every class a selector requires OUTSIDE its subject compound: its ancestors' and siblings'. */
function contextClasses(sel) {
    const own = new Set(subjectClasses(sel));
    return requiredClasses(sel).filter((c) => !own.has(c));
}

/**
 * Could `v` really override `w`? Two shapes are worth a line, and both are read LITERALLY
 * (a class attribute that spells the classes out, no slot needed) — an open `${…}` slot can
 * carry any free word, which is the right assumption for proving nothing moved and the wrong
 * one for finding a change that is really overridden: that report is all noise.
 *
 *   1. a refinement: v's subject requires every class w's does, plus context (`.monteur-queue
 *      .studio-section-head` over `.studio-section-head`, a media query's copy of a rule);
 *   2. a type-only subject (`.data-table td`) over a class written on that element type, whose
 *      context classes are written in the same file as that class attribute.
 * Ids are matched against the tag's literal id="…".
 */
function certainlyOverrides(w, v, markup, texts) {
    const wc = subjectClasses(w.sel), vc = subjectClasses(v.sel);
    if (wc.length && vc.length) return wc.every((c) => vc.includes(c));
    if (!wc.length || vc.length) return false;
    const type = v.subject.type;
    if (!type && !v.subject.ids.length) return false;
    const ctx = contextClasses(v.sel);
    for (const o of markup.origins) {
        if (type && originTag(o, texts) !== type) continue;
        const text = texts.get(o.file) || '';
        if (v.subject.ids.length) {
            const end = text.indexOf('>', o.at);
            const tag = text.slice(text.lastIndexOf('<', o.at), end < 0 ? undefined : end);
            if (!v.subject.ids.every((id) => tag.includes(`id="${id}"`))) continue;
        }
        if (!ctx.every((c) => new RegExp(`(^|[^\\w-])${c.replace(/[-]/g, '\\-')}($|[^\\w-])`).test(text))) continue;
        for (const alt of o.alts) if (wc.every((t) => alt.tokens.has(t))) return true;
    }
    return false;
}

/** Changed or added winners that another winner outranks on an element the markup certainly builds. */
export function outranked(r, markup, sources = null) {
    const texts = new Map(sources || []);
    const byAtom = new Map();
    const entries = [];
    for (const w of r.newMap.values()) {
        if (w.ctx.startsWith('@keyframes')) continue;
        const e = { w, atoms: atomsOf(w.prop, w.value) };
        entries.push(e);
        for (const atom of e.atoms.keys()) {
            if (!byAtom.has(atom)) byAtom.set(atom, []);
            byAtom.get(atom).push(e);
        }
    }
    const beats = (v, w) => (v.important !== w.important ? v.important
        : cmpSpec(v.spec, w.spec) > 0 || (cmpSpec(v.spec, w.spec) === 0 && v.order > w.order));
    const out = [];
    for (const d of r.diffs) {
        if (!d.new || d.new.ctx.startsWith('@keyframes')) continue;
        const w = d.new;
        const seen = new Set();
        for (const atom of atomsOf(w.prop, w.value).keys()) {
            for (const { w: v } of byAtom.get(atom) || []) {
                if (v === w || seen.has(v.key) || STATE_PSEUDO.test(v.sel)) continue;
                seen.add(v.key);
                if (!beats(v, w)) continue;
                if (!contextsMayMeet(w.ctx, v.ctx) || !subjectsMayMeet(w.subject, v.subject)) continue;
                if (!propsConflict(w, v)) continue;
                if (markup && !certainlyOverrides(w, v, markup, texts)) continue;
                out.push({ w, v });
            }
        }
    }
    return out;
}

function changesMain(argv) {
    const ti = argv.indexOf('--tags');
    if (ti < 0 || !argv[ti + 1]) {
        console.error('usage: node scripts/css-declmap.mjs --changes --tags <tags.json> <old.css> <new.css> [<old2> <new2> …] [--no-markup] [--verbose]');
        return 2;
    }
    const spec = JSON.parse(readFileSync(argv[ti + 1], 'utf8'));
    const files = argv.filter((a, i) => !a.startsWith('--') && i !== ti + 1);
    if (!files.length || files.length % 2) {
        console.error('--changes takes pairs of files: <old.css> <new.css> …');
        return 2;
    }
    const verbose = argv.includes('--verbose');
    const sources = argv.includes('--no-markup') ? null : styledSources();
    const markup = sources ? scanMarkup(sources) : null;
    const presence = tokenPresence(presenceSources());
    const decisions = spec.decisions || {};
    const groups = new Map(Object.keys(decisions).map((k) => [k, []]));
    const untagged = [];
    const unexplained = [];
    const explained = [];
    const notes = [];
    let total = 0;
    for (let f = 0; f < files.length; f += 2) {
        const [oldFile, newFile] = [files[f], files[f + 1]];
        const r = compare(readFileSync(oldFile, 'utf8'), readFileSync(newFile, 'utf8'), { markup, presence, bothValues: true });
        const label = newFile;
        if (r.dead.length) for (const d of r.dead) untagged.push({ file: label, kind: 'removed', ctx: d.old.ctx, sel: d.old.sel, prop: d.old.prop, old: d.old.value, new: null, line: d.old.line, why: `dead: ${d.why}` });
        for (const c of changedEntries(r)) {
            total++;
            c.file = label;
            const hit = tagsFor(c, spec.tags || []);
            const ds = [...new Set(hit.map((t) => String(t.decision)))];
            if (ds.length === 1) {
                if (!groups.has(ds[0])) groups.set(ds[0], []);
                groups.get(ds[0]).push(c);
            } else if (ds.length > 1) {
                c.why = `claimed by decisions ${ds.join(', ')}: a change must implement exactly one`;
                untagged.push(c);
            } else untagged.push(c);
        }
        for (const { a, b } of r.crossings) {
            const why = (spec.crossings || []).find((x) => {
                const pair = [x.a, x.b];
                return pair.includes(a.o.sel) && pair.includes(b.o.sel) && (!x.prop || x.prop === a.o.prop || x.prop === b.o.prop);
            });
            (why ? explained : unexplained).push({ file: label, a, b, why: why && why.why });
        }
        for (const n of outranked(r, markup, sources)) {
            const why = (spec.outranked || []).find((x) => listed(x.sel, n.w.sel) && listed(x.by, n.v.sel) && (!x.prop || listed(x.prop, n.w.prop)));
            notes.push({ file: label, ...n, why: why && why.why });
        }
    }
    const fmt = (c) => {
        const ctx = c.ctx ? `${c.ctx} ` : '';
        const sign = c.kind === 'added' ? '+' : c.kind === 'removed' ? '-' : '~';
        const val = c.kind === 'added' ? c.new : c.kind === 'removed' ? `${c.old}  (removed)` : `${c.old}  →  ${c.new}`;
        return `   ${sign} ${ctx}${c.sel} { ${c.prop}: ${val} }  ${c.file.replace(/^.*\//, '')}:${c.line}`;
    };
    console.log(`${spec.title || 'changes'}: ${total} (context, selector, property) entr${total === 1 ? 'y' : 'ies'} changed value, across ${files.length / 2} file pair(s)\n`);
    for (const [k, list] of [...groups].sort((x, y) => Number(x[0]) - Number(y[0]))) {
        console.log(`Decision ${k} — ${decisions[k] || '(no title)'}: ${list.length}`);
        for (const c of list) console.log(fmt(c));
        console.log('');
    }
    const counts = [...groups].sort((x, y) => Number(x[0]) - Number(y[0])).map(([k, l]) => `${k}: ${l.length}`).join(' · ');
    console.log(`per decision: ${counts} · untagged: ${untagged.length}`);
    if (untagged.length) {
        console.log(`\n✗ ${untagged.length} UNTAGGED change(s) — each is a regression until a decision claims it:`);
        for (const c of untagged) console.log(`${fmt(c)}${c.why ? `  [${c.why}]` : ''}`);
    }
    console.log(`\norder: ${unexplained.length + explained.length} crossing(s), ${explained.length} explained`);
    for (const x of explained) console.log(`   explained  ${describe(x.a.o)}  ×  ${describe(x.b.o)}\n              ${x.why}`);
    for (const x of unexplained) console.log(`   ✗ ${describe(x.a.o)} → new line ${x.a.n.line}\n     vs ${describe(x.b.o)} → new line ${x.b.n.line}`);
    const open = notes.filter((n) => !n.why);
    console.log(`\noutranked: ${notes.length} changed winner(s) a context override or a type-only rule beats where both match (${notes.length - open.length} explained)`);
    for (const n of notes) {
        if (n.why && !verbose) continue;
        console.log(`   ${describe(n.w)}\n     by ${describe(n.v)}${n.why ? `\n     ${n.why}` : ''}`);
    }
    if (!verbose && notes.length - open.length) console.log(`   (${notes.length - open.length} explained in the tags file; --verbose lists them)`);
    return untagged.length || unexplained.length ? 1 : 0;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main(argv) {
    if (argv.includes('--changes')) return changesMain(argv);
    const verbose = argv.includes('--verbose');
    const useMarkup = !argv.includes('--no-markup');
    const args = argv.filter((a) => !a.startsWith('--'));
    if (argv.includes('--self-test')) {
        const file = args[0] || 'dashboard/css/styles.css';
        const c = selfCheck(readFileSync(file, 'utf8'));
        console.log(`✓ ${file}: ${c.rules} rules + ${c.blocks} at-rule blocks = ${c.braces} blocks opened; ${c.decls} declarations; round trip identical`);
        return 0;
    }
    if (args.length !== 2) {
        console.error('usage: node scripts/css-declmap.mjs <old.css> <new.css> [--verbose] [--no-markup]\n       node scripts/css-declmap.mjs --self-test [file.css]\n       node scripts/css-declmap.mjs --changes --tags <tags.json> <old.css> <new.css> [<old2> <new2> …]');
        return 2;
    }
    const [oldFile, newFile] = args;
    const sources = useMarkup ? styledSources() : null;
    const markup = sources ? scanMarkup(sources) : null;
    const presence = tokenPresence(presenceSources());
    const r = compare(readFileSync(oldFile, 'utf8'), readFileSync(newFile, 'utf8'), { markup, presence });
    for (const [label, c, f] of [['old', r.oldCheck, oldFile], ['new', r.newCheck, newFile]]) {
        console.log(`${label}: ${f} — ${c.rules} rules + ${c.blocks} at-rule blocks (= ${c.braces} blocks opened), ${c.decls} declarations, round trip identical`);
    }
    console.log(`map: ${r.oldMap.size} (context, selector, property) entries old, ${r.newMap.size} new`);
    console.log(`moved: ${r.moved.length} winning declaration(s) changed position relative to the rest`);
    if (verbose) for (const k of r.moved) console.log(`   moved  ${describe(r.oldMap.get(k))}  →  line ${r.newMap.get(k).line}`);
    if (r.dead.length) {
        const sels = [...new Set(r.dead.map((d) => `${d.old.ctx ? d.old.ctx + ' ' : ''}${d.old.sel}  — ${d.why}`))];
        console.log(`dead: ${r.dead.length} entries removed for ${sels.length} selector(s) that can match nothing:`);
        for (const x of sels) console.log(`   ${x}`);
    }
    if (r.diffs.length) {
        console.log(`\n✗ ${r.diffs.length} map difference(s):`);
        for (const d of r.diffs.slice(0, 200)) {
            if (d.kind === 'removed') console.log(`   - removed  ${describe(d.old)}`);
            else if (d.kind === 'added') console.log(`   + added    ${describe(d.new)}`);
            else console.log(`   ~ changed  ${describe(d.old)}  →  ${d.new.value}${d.new.important ? ' !important' : ''} (line ${d.new.line})`);
        }
    } else {
        console.log(r.dead.length ? '✓ map: identical apart from the dead selectors above' : '✓ map: identical');
    }
    const raw = r.crossings.length + r.disjoint.length;
    console.log(`order: ${raw} competing pair(s) changed order (equal specificity, overlapping property and media, different values)`);
    if (markup) {
        console.log(`       ${r.disjoint.length} of them are between subjects no element carries together `
            + `(markup: ${markup.origins.length} class origins in ${sources.length} files)`);
        if (verbose) for (const { a, b } of r.disjoint) console.log(`   disjoint  ${describe(a.o)}  ×  ${describe(b.o)}`);
    }
    if (r.crossings.length) {
        console.log(markup
            ? `\n✗ ${r.crossings.length} crossing(s) — a declaration moved across a rule that can land on the same element:`
            : `\n✗ ${r.crossings.length} crossing(s) — --no-markup: every equal-specificity pair is assumed to share an element:`);
        for (const { a, b } of r.crossings.slice(0, 200)) {
            console.log(`   ${describe(a.o)} → new line ${a.n.line}\n     vs ${describe(b.o)} → new line ${b.n.line}`);
        }
    } else {
        console.log('✓ order: no crossing');
    }
    return r.diffs.length || r.crossings.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    process.exit(main(process.argv.slice(2)));
}
