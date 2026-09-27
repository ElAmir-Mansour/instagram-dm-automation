#!/usr/bin/env node
/**
 * Builds dashboard/js/icons.js: the Lucide icons the dashboard actually uses, and nothing else.
 *
 * The dashboard used to load the whole Lucide UMD from cdn.jsdelivr.net on every first visit:
 * 398KB (93KB gzipped) of JavaScript, a third-party round trip, for roughly a hundred icons.
 * icons.js carries only those icons plus a small `lucide.createIcons` that renders them the
 * way lucide@0.577.0 does, so nothing in the markup, the CSS or `UI.icons()` changes.
 *
 * Nothing here is guessed. The icon data is read out of the pinned UMD itself, after checking
 * it against the same SRI hash index.html used to load it with, so a byte-different download
 * fails the build instead of shipping. And a name the collector below misses is not a broken
 * icon at runtime: icons.js loads the full UMD (same URL, same SRI) the first time it meets a
 * name it does not carry, and says which names in the console. That is the signal to add them.
 *
 * Where names come from (dashboard/**\/*.{js,html}, and any public/ page that loads the
 * dashboard's scripts):
 *   1. `data-lucide="name"` literals.
 *   2. `data-lucide="${expr}"`: the literals `expr` can evaluate to (ternary branches,
 *      `a.icon || 'file-text'`), and one hop into a table or helper it indexes or calls
 *      (`this.CALLOUTS[kind]`, `this.privacyIcon(level)`).
 *   3. `setAttribute('data-lucide', expr)`.
 *   4. Keys and variables named `icon` or `…Icon` (`icon: 'x'`, `confirmIcon: 'y'`,
 *      `const icon = cond ? 'a' : 'b'`, `icon="x"`).
 *   5. Positional parameters named `icon` or `…Icon`: for `tab(key, href, icon, label)`, the
 *      third argument of every `tab(…)` call.
 *   6. EXTRA, below: the hand-kept list for anything the rules above cannot see.
 *
 * Only literals in a RESULT position count (after `?`, `:`, `||`, `??`, `=`, `=>`, `return`,
 * or the whole expression), so `key === 'video' ? 'film' : 'image'` yields film and image,
 * not video. Every name found must exist in lucide@0.577.0 or the build fails: a typo in an
 * icon name used to render nothing, silently.
 *
 * Usage:
 *   node scripts/build-icons.mjs            write dashboard/js/icons.js
 *   node scripts/build-icons.mjs --check    exit 1 if dashboard/js/icons.js is not what this would write
 *   node scripts/build-icons.mjs --audit    also list icon-shaped Lucide names in the source that were
 *                                           NOT collected, to review for EXTRA
 *   --file <path>                           write or check another path (the tests use this)
 *
 * The UMD is read from node_modules/lucide when that is installed at 0.577.0, otherwise
 * downloaded once into node_modules/.cache/ and verified against the SRI hash every time.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The pin. These three values were index.html's <script> tag until icons.js replaced it. */
export const LUCIDE_VERSION = '0.577.0';
export const LUCIDE_URL = `https://cdn.jsdelivr.net/npm/lucide@${LUCIDE_VERSION}/dist/umd/lucide.min.js`;
export const LUCIDE_SRI = 'sha384-orgVf2eX2+m1zKAOIi09hD0W6GtVhoOUmqDK+sysYB2JTZ4vS86j4jm+X7a4Nnei';

export const OUT = 'dashboard/js/icons.js';

/**
 * Names the rules cannot see. Each needs a reason; an entry here is a place the collector
 * could be taught instead.
 */
export const EXTRA = Object.freeze([]);

/**
 * Icon-shaped literals that DO sit in an icon position but are not icons. The build fails on
 * any collected name Lucide does not have, so a non-icon has to be named here, with a reason.
 */
export const IGNORE = Object.freeze({});

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with', 'typeof', 'await', 'new']);

// ─── Source scanning ────────────────────────────────────────────────────────

function walk(dir) {
    const out = [];
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (['.js', '.html'].includes(extname(p))) out.push(p);
    }
    return out;
}

/** Every file whose markup can reach `lucide.createIcons`, relative to the repo root. */
export function sourceFiles(root = ROOT) {
    const dashboard = walk(join(root, 'dashboard')).filter((f) => relative(root, f) !== OUT);
    // A public page counts only if it runs the dashboard's scripts (and so, icons.js).
    const pub = walk(join(root, 'public'))
        .filter((f) => f.endsWith('.html') && /src=["']\/dashboard\/js\//.test(readFileSync(f, 'utf8')));
    return [...dashboard, ...pub].map((f) => relative(root, f));
}

/** Index just past the string literal starting at `i` (src[i] is its quote). */
function skipString(src, i) {
    const q = src[i];
    i++;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (q === '`' && c === '$' && src[i + 1] === '{') { i = skipBalanced(src, i + 1); continue; }
        if (c === q) return i + 1;
        if (c === '\n' && q !== '`') return i; // an unterminated quote: give up on this line
        i++;
    }
    return i;
}

/** Index just past a // or /* comment starting at `i`, or `i` when there is none. */
function skipComment(src, i) {
    if (src[i] !== '/') return i;
    if (src[i + 1] === '/') { const end = src.indexOf('\n', i); return end === -1 ? src.length : end; }
    if (src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); return end === -1 ? src.length : end + 2; }
    return i;
}

/** Index just past the bracket that closes the one at `i`. */
function skipBalanced(src, i) {
    let depth = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
        const after = skipComment(src, i);
        if (after !== i) { i = after; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i + 1; }
        i++;
    }
    return i;
}

/**
 * The expression starting at `i`, up to a top-level `,` `;` or closing bracket, or a newline
 * the next line does not continue (a ternary split over lines continues with `?` or `:`).
 */
function readExpr(src, i) {
    const start = i;
    while (i < src.length) {
        const c = src[i];
        if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue; }
        const after = skipComment(src, i);
        if (after !== i) { i = after; continue; }
        if (c === '(' || c === '[' || c === '{') { i = skipBalanced(src, i); continue; }
        if (c === ',' || c === ';' || c === ')' || c === ']' || c === '}') break;
        if (c === '\n') {
            const before = src.slice(start, i).trimEnd();
            const next = src.slice(i + 1).match(/^\s*(\S\S?)/);
            const continues = /[?:=(|&+]$/.test(before) || (next && /^(\?|:|\|\||&&|\?\?)/.test(next[1]));
            if (!continues) break;
        }
        i++;
    }
    return src.slice(start, i);
}

/** The top-level arguments of the call whose `(` is at `open`. */
function readArgs(src, open) {
    const args = [];
    let i = open + 1;
    while (i < src.length) {
        while (/\s/.test(src[i] || '')) i++;
        if (src[i] === ')') break;
        const expr = readExpr(src, i);
        args.push(expr);
        i += expr.length;
        // readExpr stops on a newline it thinks ends the statement; inside an argument list
        // that is just layout, so keep reading until the separator.
        while (i < src.length && src[i] !== ',' && src[i] !== ')') {
            const more = readExpr(src, i + 1);
            args[args.length - 1] += src[i] + more;
            i += 1 + more.length;
        }
        if (src[i] === ',') i++;
        else break;
    }
    return args;
}

/**
 * Literals in `expr` that are values the expression can take, not things it compares against.
 * A literal counts when what precedes it is the start, `?`, `:`, `||`, `??`, `=`, `=>` or `return`.
 */
export function resultLiterals(expr) {
    const out = [];
    for (const m of expr.matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`/g)) {
        const value = m[1] ?? m[2] ?? m[3] ?? '';
        const before = expr.slice(0, m.index).trimEnd();
        const result = before === ''
            || /(?:^|[^?])\?$/.test(before)       // ? but not ?.
            || /:$/.test(before)
            || /(?:\|\||\?\?)$/.test(before)
            || /(?:^|[^=!<>])=$/.test(before)     // = but not == === != <= >=
            || /=>$/.test(before)
            || /\breturn$/.test(before);
        if (result && NAME.test(value)) out.push(value);
    }
    return out;
}

/** Line number of `index` in `src`, for reporting where a name came from. */
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** The `{…}` body of the definition of `name` in `src` (a method, a table, a const), or ''. */
function definitionBody(src, name) {
    const re = new RegExp(`(?:^|[\\s,{;.])${name.replace(/\$/g, '\\$')}\\s*(?:\\([^()]*\\)\\s*\\{|[:=]\\s*(?:Object\\.freeze\\()?\\s*\\{)`, 'gm');
    const bodies = [];
    for (const m of src.matchAll(re)) {
        const open = m.index + m[0].length - 1;
        bodies.push(src.slice(open, skipBalanced(src, open)));
    }
    return bodies.join('\n');
}

/**
 * Every icon name the dashboard can render, with the first place each was seen.
 * Returns Map<name, 'file:line (rule)'>, sorted by name. EXTRA is included; IGNORE is not.
 */
export function collectIconNames(root = ROOT) {
    const found = new Map();
    const add = (name, where) => {
        if (!NAME.test(name) || Object.hasOwn(IGNORE, name)) return;
        if (!found.has(name)) found.set(name, where);
    };
    const files = sourceFiles(root).map((file) => ({ file, src: readFileSync(join(root, file), 'utf8') }));

    // Rule 5 needs every definition first: `tab(key, href, icon, label)` → tab takes an icon at 2.
    const positional = new Map(); // function name -> Set of icon parameter indexes
    const defRes = [
        /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(([^()]*)\)\s*\{/gm,                     // method(a, b) {   function f(a) {
        /(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s*)?\(([^()]*)\)\s*=>/gm,  // f = (a, b) =>    f: (a) =>
    ];
    for (const { src } of files) {
        for (const re of defRes) {
            for (const m of src.matchAll(re)) {
                if (KEYWORDS.has(m[1])) continue;
                if (/^\s*\{/.test(m[2])) continue; // an options object: rule 4 sees its `icon:` keys at the call
                m[2].split(',').forEach((param, index) => {
                    const id = param.split('=')[0].trim();
                    if (/^[A-Za-z_$]*[iI]con$/.test(id)) {
                        if (!positional.has(m[1])) positional.set(m[1], new Set());
                        positional.get(m[1]).add(index);
                    }
                });
            }
        }
    }

    for (const { file, src } of files) {
        const at = (index, rule) => `${file}:${lineOf(src, index)} (${rule})`;

        // 1. data-lucide="name"
        for (const m of src.matchAll(/data-lucide=(["'])([a-z0-9-]+)\1/g)) add(m[2], at(m.index, 'data-lucide'));

        // What an icon expression can be: its own literals, plus one hop into a table or
        // helper it indexes or calls (`this.CALLOUTS[kind]`, `icons[key]`, `this.privacyIcon(l)`).
        const names = (expr, index, rule) => {
            for (const name of resultLiterals(expr)) add(name, at(index, rule));
            for (const ref of expr.matchAll(/([A-Za-z_$][\w$]*)\s*[[(]/g)) {
                // Only when the lookup IS the value: `this.keywordRisk(k).risky ? …` reads a
                // property of the result, and the helper's other literals are not icons.
                const end = skipBalanced(expr, ref.index + ref[0].length - 1);
                if (/^\s*[.[(]/.test(expr.slice(end))) continue;
                if (KEYWORDS.has(ref[1]) || ref[1] === 't') continue;
                for (const name of resultLiterals(definitionBody(src, ref[1]))) add(name, at(index, `${rule} → ${ref[1]}`));
            }
        };

        // 2. data-lucide="${expr}"
        for (const m of src.matchAll(/data-lucide=(["'])\$\{/g)) {
            const open = m.index + m[0].length - 1;
            names(src.slice(open + 1, skipBalanced(src, open) - 1), m.index, 'data-lucide expression');
        }

        // 3. setAttribute('data-lucide', expr)
        for (const m of src.matchAll(/setAttribute\(\s*['"]data-lucide['"]\s*,/g)) {
            names(readExpr(src, m.index + m[0].length).trim(), m.index, 'setAttribute');
        }

        // 4. icon: …   confirmIcon: …   const icon = …   icon="…"
        for (const m of src.matchAll(/(?<![\w$])([A-Za-z_$]*[iI]con)\s*(:|=(?![=>]))\s*/g)) {
            names(readExpr(src, m.index + m[0].length).trim(), m.index, m[1]);
        }
        //    …and tables of them: `const icons = { all: 'layers', … }`, `STATE_ICONS: {…}`.
        for (const m of src.matchAll(/(?<![\w$])([A-Za-z_$]*(?:[iI]cons|ICONS))\s*[:=]\s*(?:Object\.freeze\(\s*)?\{/g)) {
            const open = m.index + m[0].length - 1;
            for (const name of resultLiterals(src.slice(open + 1, skipBalanced(src, open) - 1))) add(name, at(m.index, m[1]));
        }

        // 5. positional icon parameters
        for (const [fn, indexes] of positional) {
            const re = new RegExp(`(?<![\\w$])${fn.replace(/\$/g, '\\$')}\\s*\\(`, 'g');
            for (const m of src.matchAll(re)) {
                const open = m.index + m[0].length - 1;
                const close = skipBalanced(src, open);
                if (/^\s*(?:\{|=>)/.test(src.slice(close))) continue; // the definition itself
                const args = readArgs(src, open);
                for (const index of indexes) {
                    names((args[index] || '').trim(), m.index, `${fn}() argument ${index + 1}`);
                }
            }
        }
    }

    for (const name of EXTRA) add(name, 'EXTRA');
    return new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// ─── The pinned UMD ─────────────────────────────────────────────────────────

export const sri = (buf) => `sha384-${createHash('sha384').update(buf).digest('base64')}`;

/** The pinned UMD's bytes, verified. Downloads once into node_modules/.cache when needed. */
export async function loadUmd(root = ROOT) {
    const installed = join(root, 'node_modules/lucide/dist/umd/lucide.min.js');
    const cached = join(root, `node_modules/.cache/lucide-${LUCIDE_VERSION}/lucide.min.js`);
    for (const path of [installed, cached]) {
        if (!existsSync(path)) continue;
        const buf = readFileSync(path);
        if (sri(buf) === LUCIDE_SRI) return buf;
        if (path === cached) console.warn(`note: ${relative(root, path)} does not match the pinned SRI; downloading again.`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let buf;
    try {
        const res = await fetch(LUCIDE_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buf = Buffer.from(await res.arrayBuffer());
    } catch (err) {
        throw new Error(`could not download ${LUCIDE_URL}: ${err?.message ?? err}`);
    } finally {
        clearTimeout(timer);
    }
    if (sri(buf) !== LUCIDE_SRI) {
        throw new Error(`${LUCIDE_URL} does not match the pinned SRI ${LUCIDE_SRI} (got ${sri(buf)}). Refusing to build from it.`);
    }
    mkdirSync(dirname(cached), { recursive: true });
    const tmp = `${cached}.${process.pid}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, cached);
    return buf;
}

/** Lucide's own kebab-case → PascalCase (`toPascalCase` in the UMD), so aliases resolve as they did. */
export const pascal = (name) => {
    const camel = name.replace(/^([A-Z])|[\s-_]+(\w)/g, (m, first, next) => (next ? next.toUpperCase() : first.toLowerCase()));
    return camel.charAt(0).toUpperCase() + camel.slice(1);
};

/** The UMD's `icons` table (PascalCase name → icon node), evaluated in an empty context. */
export function umdIcons(buf) {
    const ctx = {};
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(buf.toString('utf8'), ctx, { filename: 'lucide.min.js' });
    if (!ctx.lucide || !ctx.lucide.icons) throw new Error('the UMD did not define lucide.icons');
    return ctx.lucide.icons;
}

// ─── Output ─────────────────────────────────────────────────────────────────

/** The runtime half of icons.js. It is plain text here so the generated file is reviewable. */
const RUNTIME = String.raw`
    var SVG_NS = 'http://www.w3.org/2000/svg';

    /* lucide@0.577.0's defaultAttributes, verbatim. */
    var DEFAULTS = {
        xmlns: SVG_NS,
        width: 24,
        height: 24,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 2,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round'
    };

    var own = Object.prototype.hasOwnProperty;
    var shim = { createIcons: createIcons, subset: Object.keys(ICONS) };
    var full = null;          /* the real lucide, once the fallback has loaded */
    var fallback = 'idle';    /* idle -> loading -> ready | failed; the UMD is fetched at most once */
    var queued = [];          /* elements waiting for the fallback */

    /* Lucide's toPascalCase: the full set is keyed by it, aliases included. */
    function pascal(name) {
        var camel = name.replace(/^([A-Z])|[\s-_]+(\w)/g, function (m, first, next) {
            return next ? next.toUpperCase() : first.toLowerCase();
        });
        return camel.charAt(0).toUpperCase() + camel.slice(1);
    }

    function iconNode(name) {
        if (own.call(ICONS, name)) return ICONS[name];
        if (full && full.icons && own.call(full.icons, pascal(name))) return full.icons[pascal(name)];
        return null;
    }

    /* Lucide's hasA11yProp: an element that names itself keeps its own semantics. */
    function hasA11y(attrs) {
        for (var key in attrs) {
            if (key.indexOf('aria-') === 0 || key === 'role' || key === 'title') return true;
        }
        return false;
    }

    function classNames(attrs) {
        return attrs && typeof attrs['class'] === 'string' ? attrs['class'].split(' ') : [];
    }

    /* Lucide's mergeClasses: non-empty, first occurrence wins, space-joined. */
    function mergeClasses(list) {
        return list.filter(function (c, i) { return !!c && c.trim() !== '' && list.indexOf(c) === i; }).join(' ').trim();
    }

    function build(tag, attrs, children) {
        var el = document.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(function (key) { el.setAttribute(key, String(attrs[key])); });
        (children || []).forEach(function (child) { el.appendChild(build(child[0], child[1], child[2])); });
        return el;
    }

    /* Lucide's replaceElement: the <i>'s own attributes win over the defaults, and the
       class is "lucide lucide-<name>" plus the element's classes. */
    function replace(el, node, extra) {
        var name = el.getAttribute('data-lucide');
        var mine = {};
        Array.prototype.forEach.call(el.attributes, function (a) { mine[a.name] = a.value; });
        var attrs = Object.assign({}, DEFAULTS, { 'data-lucide': name }, hasA11y(mine) ? {} : { 'aria-hidden': 'true' }, extra, mine);
        var cls = mergeClasses(['lucide', 'lucide-' + name].concat(classNames(mine), classNames(extra)));
        if (cls) attrs['class'] = cls;
        var svg = build('svg', attrs, node);
        if (el.parentNode) el.parentNode.replaceChild(svg, el);
        return svg;
    }

    function isPending(el) {
        return !!el && el.nodeType === 1 && el.namespaceURI !== SVG_NS
            && String(el.tagName).toLowerCase() !== 'svg' && el.getAttribute('data-lucide') != null;
    }

    function pendingIn(node, out) {
        if (!node) return;
        if (isPending(node)) out.push(node);
        if (typeof node.querySelectorAll !== 'function') return;
        Array.prototype.forEach.call(node.querySelectorAll('[data-lucide]'), function (el) {
            if (isPending(el) && out.indexOf(el) === -1) out.push(el);
        });
    }

    /**
     * lucide.createIcons({ nodes, root, attrs }).
     *
     * lucide@0.577.0 takes { root } and has no "nodes" option, so every UI.icons(node) call
     * the dashboard ever made rendered the whole document. Keep that: render inside the given
     * nodes first (which also covers a node not yet in the page), then the rest of the root,
     * so no icon that used to be drawn by someone else's call is left as an empty <i>.
     * Unlike 0.577, an icon that is already an <svg> is left alone instead of rebuilt.
     */
    function createIcons(options) {
        var opts = options || {};
        var extra = opts.attrs || {};
        var pending = [];
        Array.prototype.forEach.call(opts.nodes || [], function (node) { pendingIn(node, pending); });
        pendingIn(opts.root || document, pending);
        var missing = [];
        pending.forEach(function (el) {
            var node = iconNode(el.getAttribute('data-lucide'));
            if (node) {
                replace(el, node, extra);
            } else if (fallback === 'idle' || fallback === 'loading') {
                missing.push(el);
            } else if (fallback === 'ready') {
                /* Not in the full set either: what lucide itself says, and the <i> stays. */
                console.warn(el.outerHTML + ' icon name was not found in the provided icons object.');
            }
        });
        if (missing.length) loadFull(missing);
    }

    function topOf(el) {
        var node = el;
        while (node.parentNode) node = node.parentNode;
        return node;
    }

    /* A name this file does not carry: fetch the pinned full set once, then let it draw them. */
    function loadFull(elements) {
        elements.forEach(function (el) { if (queued.indexOf(el) === -1) queued.push(el); });
        if (fallback !== 'idle') return;
        fallback = 'loading';
        var names = [];
        queued.forEach(function (el) {
            var name = el.getAttribute('data-lucide');
            if (names.indexOf(name) === -1) names.push(name);
        });
        console.warn('[icons] not in the dashboard icon subset, loading the full Lucide set: ' + names.join(', ')
            + '. Add them to scripts/build-icons.mjs (EXTRA) and rebuild.');
        var script = document.createElement('script');
        script.setAttribute('src', FULL.src);
        script.setAttribute('integrity', FULL.integrity);
        script.setAttribute('crossorigin', 'anonymous');
        script.onload = function () {
            var real = window.lucide;
            window.lucide = shim; /* the UMD assigns window.lucide; this file stays the entry point */
            if (!real || real === shim || typeof real.createIcons !== 'function') { fallback = 'failed'; return; }
            full = real;
            fallback = 'ready';
            var roots = [];
            queued.forEach(function (el) {
                if (!isPending(el)) return;
                var root = topOf(el);
                if (roots.indexOf(root) === -1) roots.push(root);
            });
            queued = [];
            roots.forEach(function (root) {
                try { real.createIcons({ root: root }); } catch (err) { console.warn('Icon rendering failed:', err); }
            });
        };
        script.onerror = function () {
            fallback = 'failed';
            queued = [];
        };
        (document.head || document.documentElement).appendChild(script);
    }

    window.lucide = shim;
`;

/** icons.js for `names`, from the UMD's icon table. Deterministic: sorted, one icon per line. */
export function render(names, icons) {
    const missing = [...names].filter((n) => !Object.hasOwn(icons, pascal(n)));
    if (missing.length) {
        throw new Error(
            `not a lucide@${LUCIDE_VERSION} icon: ${missing.join(', ')}.\n` +
            `      Fix the name where it is used, or — if it is not an icon at all — add it to IGNORE in scripts/build-icons.mjs.`,
        );
    }
    const sorted = [...names].sort();
    const table = sorted.map((n) => `        ${JSON.stringify(n)}: ${JSON.stringify(icons[pascal(n)])}`).join(',\n');
    return `/**
 * icons.js — GENERATED by scripts/build-icons.mjs from lucide@${LUCIDE_VERSION}. Do not edit by hand:
 * run \`node scripts/build-icons.mjs\` after adding an icon, and CI's \`check:icon-subset\` fails
 * if this file is stale.
 *
 * The ${sorted.length} icons the dashboard uses, and a lucide.createIcons() that renders them exactly as
 * lucide@${LUCIDE_VERSION} does (same svg attributes, same classes, data-lucide kept for the CSS). A name
 * that is not here loads the full pinned UMD once, from the same URL and SRI hash index.html
 * used, and draws the rest with it — so a miss costs a download and a console warning, never
 * a blank icon.
 */
(function () {
    'use strict';

    var FULL = {
        src: ${JSON.stringify(LUCIDE_URL)},
        integrity: ${JSON.stringify(LUCIDE_SRI)}
    };

    /* name -> lucide icon node: [[tag, attrs], …] */
    var ICONS = {
${table}
    };
${RUNTIME}}());
`;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main(argv) {
    const check = argv.includes('--check');
    const audit = argv.includes('--audit');
    const fileAt = argv.indexOf('--file');
    const target = fileAt !== -1 && argv[fileAt + 1] ? resolve(argv[fileAt + 1]) : join(ROOT, OUT);
    const shown = relative(ROOT, target) || target;

    const found = collectIconNames();
    const names = [...found.keys()];

    if (check) {
        // Names first: this part needs no download, and it is the usual way the file goes stale.
        let current = '';
        try { current = readFileSync(target, 'utf8'); } catch { /* missing counts as stale */ }
        const block = current.match(/var ICONS = \{\n([\s\S]*?)\n {4}\};/);
        const have = new Set(block ? [...block[1].matchAll(/^ {8}"([a-z0-9-]+)":/gm)].map((m) => m[1]) : []);
        const added = names.filter((n) => !have.has(n));
        const removed = [...have].filter((n) => !found.has(n));
        if (!current || added.length || removed.length) {
            console.error(`\n❌ ${shown} is stale.\n`);
            if (!current) console.error(`   • it does not exist.`);
            for (const n of added) console.error(`   • '${n}' is used (${found.get(n)}) but is not in it.`);
            for (const n of removed) console.error(`   • '${n}' is in it but nothing uses it any more.`);
            console.error(`\n   Run: node scripts/build-icons.mjs\n`);
            process.exit(1);
        }
        const expected = render(names, umdIcons(await loadUmd()));
        if (expected !== current) {
            console.error(`\n❌ ${shown} is stale: it carries the right ${names.length} names, but its content is not what the build writes (a hand edit, or a changed runtime).\n\n   Run: node scripts/build-icons.mjs\n`);
            process.exit(1);
        }
        console.log(`✓ icon subset: ${shown} is current — ${names.length} icon(s) from lucide@${LUCIDE_VERSION}; EXTRA: ${EXTRA.length ? EXTRA.join(', ') : 'none'}.`);
        return;
    }

    const icons = umdIcons(await loadUmd());
    const out = render(names, icons);
    writeFileSync(target, out);
    const gz = (await import('node:zlib')).gzipSync(out).length;
    console.log(`✓ wrote ${shown}: ${names.length} icon(s), ${out.length} bytes (${gz} gzipped).`);
    console.log(`  EXTRA (hand-kept): ${EXTRA.length ? EXTRA.join(', ') : 'none'}`);

    if (audit) {
        // Every icon-shaped literal that happens to be a Lucide name but was not collected. Most
        // are words ('video', 'text', 'ghost'); anything here that IS rendered as an icon is a miss.
        const seen = new Map();
        for (const file of sourceFiles()) {
            const src = readFileSync(join(ROOT, file), 'utf8');
            for (const m of src.matchAll(/(['"`])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\1/g)) {
                if (found.has(m[2]) || !Object.hasOwn(icons, pascal(m[2]))) continue;
                if (!seen.has(m[2])) seen.set(m[2], []);
                seen.get(m[2]).push(`${file}:${lineOf(src, m.index)}`);
            }
        }
        console.log(`\n  audit: ${seen.size} Lucide-named literal(s) not collected — review for EXTRA:`);
        for (const [name, where] of [...seen].sort()) console.log(`    ${name.padEnd(22)} ${where.slice(0, 3).join('  ')}${where.length > 3 ? `  (+${where.length - 3})` : ''}`);
        console.log('\n  collected:');
        for (const [name, where] of found) console.log(`    ${name.padEnd(22)} ${where}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).catch((err) => {
        console.error(`\n❌ build-icons: ${err?.message ?? err}\n`);
        process.exit(1);
    });
}
