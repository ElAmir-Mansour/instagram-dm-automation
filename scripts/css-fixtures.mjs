#!/usr/bin/env node
/**
 * Fixture pages for comparing what two stylesheets make every element compute.
 *
 *   node scripts/css-fixtures.mjs --out <dir> [--old <git-ref>] [--only <fixture>]
 *
 * Run from the repository root. <git-ref> defaults to main.
 *
 * `scripts/css-declmap.mjs` proves a refactor equivalent from the stylesheet (and the markup's
 * class sources). This is the second, independent proof: REAL markup, rendered by the shipped
 * page modules in a `node:vm` sandbox the way src/dashboard/*.test.ts load them, with the fixture
 * data those tests use, written as static pages a browser can style with either stylesheet.
 *
 * Writes into <dir>:
 *   *.html            one page per screen state: `<html lang="ar" dir="rtl">`, the shell from
 *                     dashboard/index.html with no scripts, the rendered page (and its modal) inlined,
 *                     icons hydrated to the <svg> lucide would draw, and
 *                     `<link id="css-under-test" href="file:///<dir>/styles.new.css">`.
 *   styles.old.css    dashboard/css/styles.css at <git-ref>
 *   styles.new.css    the working tree's dashboard/css/styles.css
 *   tokens.css        the working tree's dashboard/css/tokens.css
 *   computed-dump.js  run in a fixture page: every element's computed style, by a stable path
 *   compare.js        run in a fixture page: swaps #css-under-test between old and new, dumps both
 *                     under data-theme dark and light, returns the differences (at most 200)
 *
 * It prints a coverage table: for each selector of the Studio section of the stylesheet (and of
 * the shared-pattern block), which fixtures contain an element it matches by class, and it lists
 * the Studio selectors no fixture exercises. It also checks the markup model css-declmap.mjs relies
 * on: every class list a fixture renders must be one that model says can exist.
 *
 * Nothing here starts a server or opens a browser.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parseCss, requiredClasses, scanMarkup, styledSources, shareWitness } from './css-declmap.mjs';

// ─── Arguments ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const OUT = arg('--out');
const OLD_REF = arg('--old', 'main');
if (!OUT) {
    console.error('usage: node scripts/css-fixtures.mjs --out <dir> [--old <git-ref>]');
    process.exit(2);
}
const outDir = resolve(OUT);
mkdirSync(outDir, { recursive: true });
const fileUrl = (name) => pathToFileURL(`${outDir}/${name}`).href;

// ─── The sandbox ────────────────────────────────────────────────────────────
// What index.html loads eagerly, in its order (icons.js and app.js excepted: the icons are
// hydrated statically below, and app.js boots the whole shell).
const SHARED = ['dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/components.js', 'dashboard/js/motion.js', 'dashboard/js/charts.js', 'dashboard/js/pages/admin_common.js'];

class FakeFormData {
    constructor(form) { this.fields = (form && form.fields) || {}; }
    get(name) { return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null; }
}

function fakeStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        key: (i) => [...map.keys()][i] ?? null,
        get length() { return map.size; },
    };
}

/**
 * The shared files plus `files`, in a context whose document hands out a fake element for ANY id
 * (and for `[data-region="x"]`), recording when each one's innerHTML was last written, so regions a
 * page paints after its first render can be spliced back into the page it rendered.
 */
function harness({ files, lang = 'ar', hash = {}, app = {}, locationHash = '' }) {
    const noop = () => {};
    let seq = 0;
    const hosts = new Map();
    const api = {};
    const missing = [];
    const fakeEl = (id, tag = 'div') => {
        const attrs = new Map();
        const classes = new Set();
        let inner = '';
        const kids = [];
        const el = {
            id, value: '', checked: false, disabled: false, required: false, textContent: '', dataset: {}, style: {},
            children: kids, childNodes: kids, attributes: [], files: [], options: [], elements: [],
            scrollHeight: 0, scrollTop: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0, offsetWidth: 0, offsetHeight: 0,
            offsetParent: null, parentNode: null, parentElement: null, nodeType: 1, tagName: tag.toUpperCase(), writtenAt: 0,
            get innerHTML() { return inner; },
            set innerHTML(v) { inner = String(v); el.writtenAt = ++seq; },
            get className() { return attrs.get('class') || ''; },
            set className(v) { attrs.set('class', String(v)); },
            get type() { return attrs.get('type') || ''; },
            set type(v) { attrs.set('type', String(v)); },
            get firstElementChild() { return kids[0] || null; },
            /** What this element is as markup: for elements a page BUILDS (Motion.patchList rows). */
            get outerHTML() {
                const all = new Map(attrs);
                if (el.id) all.set('id', el.id);
                for (const [k, v] of Object.entries(el.dataset)) all.set(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v);
                const text = [...all].map(([k, v]) => ` ${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u0000/g, '')}"`).join('');
                return `<${tag}${text}>${kids.length ? kids.map((k) => k.outerHTML).join('') : inner}</${tag}>`;
            },
            // Class changes are recorded as well as applied, so compose() can replay them onto the
            // element's own start tag: `picker.classList.toggle('hidden', !open)` must show in the page.
            classOps: [],
            classList: {
                toggle: (n, on) => { const want = on === undefined ? !classes.has(n) : !!on; if (want) classes.add(n); else classes.delete(n); el.classOps.push([want ? 'add' : 'remove', n]); return want; },
                add: (...n) => { n.forEach((x) => { classes.add(x); el.classOps.push(['add', x]); }); },
                remove: (...n) => { n.forEach((x) => { classes.delete(x); el.classOps.push(['remove', x]); }); },
                contains: (n) => classes.has(n),
            },
            setAttribute: (n, v) => { attrs.set(n, String(v)); },
            getAttribute: (n) => (attrs.has(n) ? attrs.get(n) : null),
            removeAttribute: (n) => { attrs.delete(n); },
            hasAttribute: (n) => attrs.has(n),
            toggleAttribute: noop,
            addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
            focus: noop, blur: noop, click: noop, remove: noop, removeChild: noop, replaceChildren: noop,
            appendChild: (child) => { kids.push(child); child.parentNode = el; return child; },
            append: noop, prepend: noop, before: noop, after: noop, replaceWith: noop, select: noop, setSelectionRange: noop,
            insertAdjacentHTML(_where, markup) { el.innerHTML = inner + markup; },
            insertAdjacentElement: noop,
            closest: () => null, contains: () => false, matches: () => false,
            querySelector(sel) {
                // A region exists only once the markup holding it has been written.
                const region = /^\[data-region="([\w-]+)"\]$/.exec(sel);
                if (region && inner.includes(`data-region="${region[1]}"`)) return host(`region:${region[1]}`);
                return null;
            },
            querySelectorAll: () => [],
            getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }),
            scrollIntoView: noop, scrollTo: noop, scrollBy: noop,
            animate: () => ({ finished: Promise.resolve(), cancel: noop, onfinish: null }),
            getAnimations: () => [],
            showModal: noop, close: noop, reset: noop, submit: noop, requestSubmit: noop, checkValidity: () => true, reportValidity: () => true,
        };
        return el;
    };
    const host = (id) => {
        if (!hosts.has(id)) {
            const el = fakeEl(id);
            // An element the page looks up after painting it starts with the classes it was painted with.
            for (const root of ['page-container', 'modal-content']) {
                const markup = hosts.get(root) ? hosts.get(root).innerHTML : '';
                const t = markup && tagsOf(markup).find((x) => !x.close && new RegExp(`(^|\\s)id="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(x.attrs));
                const cls = t && /\sclass="([^"]*)"/.exec(t.attrs);
                if (cls) { cls[1].split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c)); el.classOps.length = 0; break; }
            }
            hosts.set(id, el);
        }
        return hosts.get(id);
    };
    const stub = fakeEl('');
    const appStub = {
        currentTheme: () => 'auto', navigate: noop, currentPage: '', session: { tenantId: 't1', role: 'owner' },
        hashParam: (name) => hash[name] || '',
        canOperate: () => true, canAdminister: () => true, isPlatformAdmin: () => true,
        go: noop, goWithQuery: noop, setInboxWaiting: noop, refreshNavCounts: noop, needsSetup: () => false,
        ...app,
    };
    const ctx = {
        document: {
            ...stub,
            createElement: (tag) => fakeEl('', String(tag || 'div').toLowerCase()),
            createElementNS: () => fakeEl(''),
            createTextNode: () => fakeEl(''),
            body: fakeEl('body'), head: fakeEl('head'),
            documentElement: { ...fakeEl('html'), lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id) => host(id),
            activeElement: null,
            visibilityState: 'visible',
            startViewTransition: undefined,
        },
        window: {
            addEventListener: noop, removeEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
            location: { hash: '', href: 'https://msg-response-auto.vercel.app/dashboard', origin: 'https://msg-response-auto.vercel.app', pathname: '/dashboard' },
            innerWidth: 1280, innerHeight: 900, scrollY: 0, scrollTo: noop,
        },
        location: { hash: locationHash, href: 'https://msg-response-auto.vercel.app/dashboard', origin: 'https://msg-response-auto.vercel.app' },
        Intl, console, URL, URLSearchParams, Blob: class {}, File: class {},
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; },
        setInterval: (fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; },
        clearTimeout, clearInterval,
        requestAnimationFrame: (f) => { f(0); return 0; }, cancelAnimationFrame: noop,
        queueMicrotask,
        navigator: { language: lang, languages: [lang], clipboard: { writeText: () => Promise.resolve() } },
        CSS: { escape: (v) => String(v), supports: () => true },
        API: new Proxy(api, {
            get: (target, prop) => (prop === 'token' ? 'tok' : prop in target
                ? target[prop]
                : (...args) => { missing.push(String(prop)); return Promise.reject(new Error(`API.${String(prop)} not stubbed`)); }),
        }),
        App: appStub,
        FormData: FakeFormData,
        localStorage: fakeStorage(),
        sessionStorage: fakeStorage(),
        lucide: { createIcons: noop },
        history: { replaceState: noop, pushState: noop },
        fetch: () => Promise.reject(new Error('no network in a fixture')),
    };
    ctx.globalThis = ctx;
    ctx.self = ctx;
    vm.createContext(ctx);
    for (const f of [...SHARED, ...files]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    const run = (code) => vm.runInContext(code, ctx);
    run(`I18N.lang = ${JSON.stringify(lang)};`);
    run('UI.toast = function () {}; Motion.announce = function () {};');
    // Keyed list rows are built as elements, not markup; serialise them the way the real
    // patchList would leave them in the page.
    run(`Motion.patchList = function (container, items, opts) {
        if (!container || !opts) return 0;
        var rows = items.map(function (item) {
            var el = opts.create();
            el.dataset.rowKey = String(opts.key(item));
            opts.update(el, item);
            el.dataset.rowSig = String(opts.signature(item));
            return el;
        });
        container.innerHTML = rows.map(function (el) { return el.outerHTML; }).join('');
        return rows.length;
    };`);
    host('page-container');
    return { ctx, run, api, hosts, host, hash, app: appStub, missing };
}

const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0)); };

// ─── Composing a page ───────────────────────────────────────────────────────
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

/** Tags of an HTML string: { name, start, end, close, selfClosing, attrs }. */
function tagsOf(markup) {
    const out = [];
    const re = /<(\/?)([a-zA-Z][\w:-]*)/g;
    let m;
    while ((m = re.exec(markup))) {
        let i = re.lastIndex, quote = null;
        for (; i < markup.length; i++) {
            const c = markup[i];
            if (quote) { if (c === quote) quote = null; continue; }
            if (c === '"' || c === "'") { quote = c; continue; }
            if (c === '>') break;
        }
        const attrs = markup.slice(re.lastIndex, i);
        out.push({ name: m[2].toLowerCase(), start: m.index, end: i + 1, close: m[1] === '/', selfClosing: /\/\s*$/.test(attrs), attrs });
        re.lastIndex = i + 1;
    }
    return out;
}

/** Replace the content of the element whose start tag carries `attr` (e.g. `id="x"`). */
function spliceInner(markup, attr, inner) {
    const tags = tagsOf(markup);
    const k = tags.findIndex((t) => !t.close && new RegExp(`(^|\\s)${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|/)`).test(t.attrs));
    if (k < 0) return null;
    const open = tags[k];
    if (VOID.has(open.name) || open.selfClosing) return null;
    let depth = 0;
    for (let j = k; j < tags.length; j++) {
        const t = tags[j];
        if (t.name !== open.name || t.selfClosing) continue;
        depth += t.close ? -1 : 1;
        if (depth === 0) return markup.slice(0, open.end) + inner + markup.slice(t.start);
    }
    return null;
}

const MODAL_IDS = new Set(['modal-content', 'modal-overlay', 'toast-container', 'page-title', 'page-subtitle', 'page-prelude']);

/** Replay recorded classList changes onto the start tag carrying `attr`. */
function applyClassOps(markup, attr, ops) {
    if (!ops.length) return markup;
    const tags = tagsOf(markup);
    const re = new RegExp(`(^|\\s)${attr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|/)`);
    const t = tags.find((x) => !x.close && re.test(x.attrs));
    if (!t) return markup;
    const m = /(\sclass=")([^"]*)(")/.exec(t.attrs);
    const classes = new Set(m ? m[2].split(/\s+/).filter(Boolean) : []);
    for (const [op, name] of ops) { if (op === 'add') classes.add(name); else classes.delete(name); }
    const value = [...classes].join(' ');
    const attrs = m ? t.attrs.replace(m[0], `${m[1]}${value}${m[3]}`) : `${t.attrs} class="${value}"`;
    return markup.slice(0, t.start) + `<${t.name}${attrs}>` + markup.slice(t.end);
}

/**
 * A region as a browser would hold it: `rootId`'s last write, with every region painted after it
 * spliced in and every recorded class change replayed.
 */
function composeFrom(h, rootId, exclude) {
    const root = h.host(rootId);
    let markup = root.innerHTML;
    const later = [...h.hosts.values()]
        .filter((x) => x.id && x.id !== rootId && !exclude.has(x.id) && x.writtenAt > root.writtenAt)
        .sort((a, b) => a.writtenAt - b.writtenAt);
    const attrOf = (x) => (x.id.startsWith('region:') ? `data-region="${x.id.slice(7)}"` : `id="${x.id}"`);
    for (const x of later) {
        const next = spliceInner(markup, attrOf(x), x.innerHTML);
        if (next !== null) markup = next;
    }
    for (const x of h.hosts.values()) if (x.id && x.id !== rootId && x.classOps.length) markup = applyClassOps(markup, attrOf(x), x.classOps);
    return markup;
}
const compose = (h) => composeFrom(h, 'page-container', MODAL_IDS);
const composeModal = (h) => composeFrom(h, 'modal-content', new Set(['page-container', 'modal-overlay', 'toast-container']));

/** `<i data-lucide>` as lucide draws it: an <svg> with its defaults, the <i>'s attributes, and its classes. */
function hydrateIcons(markup) {
    return markup.replace(/<i\b([^>]*\bdata-lucide="([^"]+)"[^>]*)>\s*<\/i>/g, (_m, attrText, name) => {
        const attrs = new Map();
        for (const a of attrText.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs.set(a[1], a[2] ?? '');
        const own = attrs.get('class') || '';
        attrs.delete('class');
        const named = [...attrs.keys()].some((k) => k.startsWith('aria-') || k === 'role' || k === 'title');
        const merged = { xmlns: 'http://www.w3.org/2000/svg', width: '24', height: '24', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-lucide': name, ...(named ? {} : { 'aria-hidden': 'true' }), ...Object.fromEntries(attrs) };
        const cls = ['lucide', `lucide-${name}`, ...own.split(/\s+/)].filter((c, i, all) => c && all.indexOf(c) === i).join(' ');
        const text = Object.entries(merged).map(([k, v]) => `${k}="${v}"`).join(' ');
        return `<svg ${text} class="${cls}"><path d="M4 12h16"></path></svg>`;
    });
}

const SHELL = readFileSync('dashboard/index.html', 'utf8');

/** A self-contained fixture page: the shell, no scripts, the page (and modal) inlined. */
function pageHtml({ title, nav, markup, modal = null, pageTitle = '' }) {
    let html = SHELL
        .replace(/<script\b[\s\S]*?<\/script>/g, '')
        .replace(/<link rel="(?:icon|manifest)"[^>]*>\n?/g, '')
        .replace(/<link rel="stylesheet" href="\/dashboard\/css\/tokens\.css[^"]*">/, `<link rel="stylesheet" href="${fileUrl('tokens.css')}">`)
        .replace(/<link rel="stylesheet" href="\/dashboard\/css\/styles\.css[^"]*">/, `<link id="css-under-test" rel="stylesheet" href="${fileUrl('styles.new.css')}">`)
        .replace(/<title>[^<]*<\/title>/, `<title>${title} — css fixture</title>`)
        .replace('<div id="login-screen" class="login-screen">', '<div id="login-screen" class="login-screen hidden">')
        .replace('<div id="app" class="app hidden">', '<div id="app" class="app">')
        .replace(/class="nav-item active"/g, 'class="nav-item"');
    if (nav) html = html.replace(`class="nav-item" data-page="${nav}"`, `class="nav-item active" data-page="${nav}"`);
    if (pageTitle) html = html.replace(/(<h1 id="page-title" class="page-title"[^>]*>)[^<]*(<\/h1>)/, `$1${pageTitle}$2`);
    const withPage = spliceInner(html, 'id="page-container"', `\n${markup}\n`);
    if (withPage === null) throw new Error('shell has no #page-container');
    html = withPage;
    if (modal !== null) {
        html = html.replace('<div id="modal-overlay" class="modal-overlay hidden">', '<div id="modal-overlay" class="modal-overlay">');
        const withModal = spliceInner(html, 'id="modal-content"', `\n${modal}\n`);
        if (withModal === null) throw new Error('shell has no #modal-content');
        html = withModal;
    }
    if (/<script\b/i.test(html)) throw new Error(`${title}: a script survived`);
    return hydrateIcons(html);
}

// ─── Fixture data (from the dashboard tests) ────────────────────────────────
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;
const minutesAgo = (n) => new Date(NOW - n * 60 * 1000).toISOString();
const ago = (ms) => new Date(NOW - ms).toISOString();
const isoDay = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().slice(0, 10);
const inDays = (n) => new Date(NOW + n * DAY).toISOString();

// Studio — src/dashboard/screens.test.ts
const studioStatus = (over = {}) => ({
    worker: { online: true, lastSeen: minutesAgo(0.3), name: 'Studio Mac' },
    lessons: { total: 34, indexed: 34, indexing: 0, failed: 0 },
    jobs: { pending: 0, claimed: 0 },
    tiktok: { audited: false, queued: 3 },
    ...over,
});
const studioLessons = () => ({
    lessons: [
        { id: 'l1', lesson_no: '1.1', section_no: 1, section_title: 'Chapter 1 - Prompting', title: 'Goals, not questions', status: 'indexed', summary: 's', moments_count: 12 },
        { id: 'l2', lesson_no: '1.2', section_no: 1, section_title: 'Chapter 1 - Prompting', title: 'Role and context', status: 'indexed', summary: 's', moments_count: 14 },
        { id: 'l3', lesson_no: '2.1', section_no: 2, section_title: 'Chapter 2 - NotebookLM', title: 'Grounded answers', status: 'indexed', summary: 's', moments_count: 20 },
        { id: 'l4', lesson_no: '2.2', section_no: 2, section_title: 'Chapter 2 - NotebookLM', title: 'Audio overviews', status: 'indexed', summary: 's', moments_count: 18 },
        { id: 'l5', lesson_no: 'I.1', section_no: null, section_title: null, title: 'Welcome', status: 'new', summary: null, moments_count: 0 },
    ],
});
/** Every slide kind: the tests' eight, plus a stat. */
const studioCarousel = () => ({
    id: 'GoalsNotQuestions',
    accent: '#FF6B6B',
    keyword: 'برومبت',
    slides: [
        { kind: 'cover', kicker: 'قبل ما تلوم الأداة', title: 'اعطه هدف بدل سؤال', highlight: 'هدف', subtitle: 'الفرق بين رأي وشغل منجز', shot: { name: 'm-mo1' } },
        { kind: 'point', n: 1, title: 'ابدأ بالنتيجة', body: 'قل له وش تبي تستلم في النهاية.', tip: 'النتيجة أولاً' },
        { kind: 'list', title: 'ثلاث أدوات', items: [{ icon: '🔎', text: 'بحث' }, { text: 'كود' }, { text: 'صور', sub: 'أداة للصور' }] },
        { kind: 'compare', title: 'قبل وبعد', left: { label: 'سؤال', items: ['رأي', 'عام'] }, right: { label: 'هدف', items: ['تقرير', 'مخصص'] } },
        { kind: 'steps', title: 'بالخطوات', steps: [{ title: 'الدور' }, { title: 'المهمة', body: 'وش المطلوب' }, { title: 'الصيغة' }] },
        { kind: 'prompt', title: 'انسخ البرومبت', label: 'انسخ', prompt: 'أنت [الدور]. المطلوب: [المهمة].' },
        { kind: 'stat', value: '٣×', label: 'أسرع من البحث اليدوي', body: 'في تجربة الدرس' },
        { kind: 'shot', title: 'النتيجة الحقيقية', shot: { name: 'm-mo2' }, caption: 'من الدرس' },
        { kind: 'cta', promise: 'شرحته خطوة بخطوة' },
    ],
    captions: {
        instagram: 'اكتب "برومبت" بالتعليقات ويوصلك الرابط',
        tiktokTitle: 'هدف بدل سؤال',
        tiktok: 'الكورس كامل — رابطه في البايو',
    },
});
const studioDraft = (over = {}) => ({
    id: 'd1',
    status: 'ready',
    input: { lessonIds: ['l1'], angle: 'auto', slides: 9 },
    carousel: studioCarousel(),
    shots: {
        'm-mo1': { lessonId: 'l1', t: 42, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'The vague answer' },
        'm-mo2': { lessonId: 'l1', t: 90, zoom: 1.3, focusX: 0.5, focusY: 0.5, desc: 'The report' },
    },
    campaign: { keyword: 'برومبت', variants: ['البرومبت'], dm: 'هلا {username} 👋', create: true },
    render: {
        ig: Array.from({ length: 9 }, (_, i) => `https://cdn.test/ig-${i + 1}.jpg`),
        tt: Array.from({ length: 9 }, (_, i) => `https://cdn.test/tt-${i + 1}.jpg`),
        rendered_at: minutesAgo(5),
        job_id: 'j1',
    },
    schedule: null,
    error: null,
    created_at: '2026-09-20T10:00:00.000Z',
    updated_at: '2026-09-20T10:05:00.000Z',
    ...over,
});
const studioMoments = () => ({
    lesson: { id: 'l1', lesson_no: '1.1', title: 'Goals, not questions', status: 'indexed', notes: { summary: 's', points: [], prompts: [], tools: [], demos: [] } },
    moments: [
        { id: 'mo1', lesson_id: 'l1', t: 42, description: 'The vague answer', kind: 'ui', clean: true, thumb_url: '/api/uploads/t1' },
        { id: 'mo2', lesson_id: 'l1', t: 90, description: 'The report', kind: 'result', clean: true, thumb_url: '/api/uploads/t2' },
        { id: 'mo3', lesson_id: 'l1', t: 120.5, description: 'The finished report, full screen', kind: 'result', clean: true, thumb_url: '/api/uploads/t3' },
    ],
});
const studioSettings = (over = {}) => ({
    brand: {
        name: 'Agentic AI', signature: { latin: 'AGENTIC AI', local: 'بالعربي' },
        palette: ['#FF6B6B', '#7C5CFF', '#22C55E'],
        colors: { ink: '#0B0B10', paper: '#F5F5F7', muted: '#8A8A99' },
        fonts: { display: 'Cairo', mono: 'JetBrains Mono' }, direction: 'rtl', theme: 'dark-grid',
    },
    voice: { language: 'ar', guide: 'Short lines.', digits: 'arabic-indic' },
    product: { name: 'The course', url: 'https://example.com/course?ref=1', facts: ['34 lessons', '5h40'], dmBullets: ['Lifetime access', 'Certificate'] },
    cta: {
        instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك الرابط',
        tiktokLine: 'رابطه في البايو',
        dmTemplate: 'هلا {username}\n{question}\n{pitch}\n{url}\n{bullets}',
        slide: { igAsk: 'a', igSub: 'b', save: 'c', ttHeadline: 'd', ttPill: 'e', ttSub: 'f', follow: 'g', swipe: 'h' },
    },
    schedule: { timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] },
    library: { root: '/Users/elamir/Desktop/AI Course' },
    examples: [{ id: 'Approved' }],
    ...over,
});
const studioWorkers = () => ({
    workers: [
        { id: 'w1', name: 'Studio Mac', created_at: '2026-09-01T10:00:00.000Z', last_seen_at: minutesAgo(0.3), revoked_at: null },
        { id: 'w2', name: 'Old laptop', created_at: '2026-08-01T10:00:00.000Z', last_seen_at: '2026-08-20T10:00:00.000Z', revoked_at: '2026-08-21T10:00:00.000Z' },
    ],
});

function stubStudio(api, { status = studioStatus(), drafts, settings = studioSettings() } = {}) {
    api.getStudioStatus = () => Promise.resolve(status);
    api.getStudioLessons = () => Promise.resolve(studioLessons());
    api.getStudioDrafts = () => Promise.resolve({ drafts });
    api.getStudioSettings = () => Promise.resolve({ settings });
    api.getStudioSlots = () => Promise.resolve({ slots: ['2026-09-26T10:00:00.000Z', '2026-09-26T18:00:00.000Z'] });
    api.getStudioLesson = () => Promise.resolve(studioMoments());
    api.getStudioWorkers = () => Promise.resolve(studioWorkers());
    api.getTikTokConnection = () => Promise.resolve(tiktokConnection());
}

const everyDraftState = () => [
    studioDraft(),
    studioDraft({ id: 'd2', status: 'rendering', render: null }),
    studioDraft({ id: 'd3', status: 'scheduled', schedule: { scheduled_time: '2026-09-26T10:00:00.000Z', tiktok: 'queue' } }),
    studioDraft({ id: 'd4', status: 'failed', render: null, error: 'Gemini timed out after 90s' }),
    studioDraft({ id: 'd5', status: 'generating', carousel: null, render: null }),
];

// ─── The fixtures ───────────────────────────────────────────────────────────
const FIXTURES = [];
const fixture = (name, fn) => FIXTURES.push({ name, fn });

const studioFiles = ['dashboard/js/pages/studio.js'];

fixture('studio-home', async () => {
    const h = harness({ files: studioFiles });
    stubStudio(h.api, { drafts: everyDraftState() });
    h.run("StudioPage.selected = ['l1'];");
    await h.run('StudioPage.render()');
    await settle();
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

fixture('studio-home-limit', async () => {
    const h = harness({ files: studioFiles });
    stubStudio(h.api, { drafts: everyDraftState() });
    h.run("StudioPage.selected = ['l1', 'l2', 'l3'];");
    await h.run('StudioPage.render()');
    await settle();
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

fixture('studio-home-generating', async () => {
    const h = harness({ files: studioFiles });
    stubStudio(h.api, { drafts: everyDraftState() });
    h.run("StudioPage.selected = ['l1']; StudioPage.generating = true; StudioPage.genStartedAt = Date.now() - 42000;");
    await h.run('StudioPage.render()');
    await settle();
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

async function studioEditor(draft) {
    const h = harness({ files: studioFiles, hash: { draft: draft.id } });
    stubStudio(h.api, { drafts: everyDraftState() });
    h.api.getStudioDraft = () => Promise.resolve({ draft, lessons: [{ id: 'l1', lesson_no: '1.1', title: 'Goals, not questions' }] });
    await h.run('StudioPage.render()');
    await settle();
    return h;
}

fixture('studio-editor', async () => {
    const h = await studioEditor(studioDraft());
    // An unsaved edit: the save bar says so.
    h.run("StudioPage.work.carousel.slides[1].title += ' الآن'; StudioPage.paintSaveBar();");
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

fixture('studio-editor-readonly', async () => {
    const h = await studioEditor(studioDraft({ id: 'd3', status: 'scheduled', schedule: { scheduled_time: '2026-09-26T10:00:00.000Z', tiktok: 'queue' } }));
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

fixture('studio-settings', async () => {
    const h = harness({ files: studioFiles, hash: { tab: 'settings' } });
    stubStudio(h.api, { drafts: everyDraftState() });
    await h.run('StudioPage.render()');
    await settle();
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

// Monteur — src/dashboard/monteur.test.ts
const monteurClip = (over = {}) => ({
    id: 'c1', source_id: 's1', source_name: 'lesson-4.mp4', rank: 1, status: 'review',
    start: 83.2, end: 118.5, duration: 35.3,
    title: 'الفرق بين رأي وشغل منجز',
    hook: 'أغلب الناس يسألون الذكاء الاصطناعي سؤال، والمحترف يعطيه هدف',
    why: 'Opens on a bold claim, one idea, and the payoff lands at 30 s.',
    score: 9,
    topic: 'الفرق بين السؤال والهدف', hook_type: 'promise', scores: { hook: 3, alone: 3, payoff: 2, send: 2 },
    tiktok_privacy: 'SELF_ONLY',
    copy: {
        caption: 'هدف بدل سؤال\n\nوش أول أداة بتجربها؟ «برومبت»\n#ذكاء_اصطناعي',
        tiktok_caption: 'هدف بدل سؤال — رابطه في البايو #ذكاء_اصطناعي',
        hashtags: ['ذكاء_اصطناعي'], keyword: 'برومبت', variants: ['البرومبت'], keyword_create: true,
        dm: 'هلا {username}\nهذا الرابط', alt_text: 'رجل أمام حاسوب',
    },
    video_url: '/api/uploads/v1', cover_url: '/api/uploads/p1',
    scheduled_time: null, error: null, created_at: '2026-09-27T08:00:00.000Z',
    ...over,
});
const monteurView = () => ({
    settings: {
        enabled: true, folder: '/Users/elamir/Videos/Reels', run_at: '07:00', videos_per_run: 1, reels_per_video: 2,
        platforms: ['instagram', 'facebook', 'tiktok'], post_at: ['19:00', '21:00'], min_seconds: 20, max_seconds: 45,
    },
    timezone: 'Asia/Riyadh',
    next_run: '2030-01-15T04:00:00.000Z',
    last_scan: { at: minutesAgo(180), added: 2, skipped: 1, missing: false },
    worker: { online: true, lastSeen: minutesAgo(0.3), name: 'Studio Mac' },
    pending: { scan: false, folder_pick: false },
    next_slot: '2030-01-15T16:00:00.000Z',
    sources: [
        { id: 's1', name: 'lesson-4.mp4', path: '/Users/elamir/Videos/Reels/lesson-4.mp4', duration: 912.4, status: 'done', error: null, clips: 2, created_at: minutesAgo(170), updated_at: minutesAgo(160) },
        { id: 's2', name: 'q-and-a.mov', path: '/Users/elamir/Videos/Reels/q-and-a.mov', duration: 60.5, status: 'no_clips', error: null, clips: 0, created_at: minutesAgo(900), updated_at: minutesAgo(890) },
        { id: 's3', name: 'broken.mkv', path: '/Users/elamir/Videos/Reels/broken.mkv', duration: null, status: 'failed', error: 'ffprobe could not read the file', clips: 0, created_at: minutesAgo(1000), updated_at: minutesAgo(990) },
    ],
    clips: [
        monteurClip(),
        monteurClip({ id: 'c2', rank: 2, title: 'ثلاث أدوات تكفيك', score: 7 }),
        monteurClip({ id: 'c3', rank: 3, status: 'scheduled', title: 'مجدول', scheduled_time: inDays(1) }),
        monteurClip({ id: 'c4', rank: 4, status: 'failed', title: 'تعثر', error: 'Render failed: out of disk' }),
    ],
    lessons: {
        lessons: [
            { rule: 'Open on the result, not the question.', evidence: 'Hooks with a number kept 2x more viewers past 3 s.' },
            { rule: 'Keep it under 40 seconds.', evidence: 'Reels over 45 s had half the completion.' },
        ],
        summary: 'Short reels that open on a result travel furthest.',
        basis: { posts: 14, from: '2026-09-01T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' },
        created_at: minutesAgo(60 * 24 * 2), model: 'gemini-2.5-flash', status: 'done', error: null,
    },
});

fixture('monteur', async () => {
    const h = harness({ files: ['dashboard/js/pages/monteur.js'] });
    h.api.getMonteur = () => Promise.resolve(monteurView());
    h.api.getStudioSettings = () => Promise.resolve({ settings: { cta: { instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك الرابط', tiktokLine: 'رابطه في البايو' }, voice: { language: 'ar' }, schedule: { timezone: 'Asia/Riyadh', slots: ['13:00'] } } });
    await h.run('MonteurPage.render()');
    await settle();
    const markup = compose(h);
    h.run('MonteurPage.destroy()');
    return { nav: 'monteur', markup };
});

// TikTok — the shapes src/routes/tiktok.ts answers with
const BASE = 'https://msg-response-auto.vercel.app';
const tiktokConnection = () => ({
    appConfigured: true,
    redirectUri: `${BASE}/api/tiktok/callback`,
    connection: {
        connected: true, status: 'active', displayName: 'agentic.ai', avatarUrl: null, scopes: ['user.info.basic', 'video.upload'],
        canUpload: true, canDirectPost: false, accessExpiresAt: inDays(1), refreshExpiresAt: inDays(300), lastRefreshedAt: minutesAgo(30),
        lastError: null, connectedAt: '2026-09-01T10:00:00.000Z', directPostEnabled: false, audited: false, postMode: 'inbox',
    },
    inbox: { pending: 2, limit: 5 },
});
const tiktokApp = () => ({
    clientKey: { set: true, source: 'database', value: 'awx1234567' },
    clientSecret: { set: true, source: 'database', preview: 'ab•••••yz' },
    publicBaseUrl: { saved: BASE, effective: BASE },
    verification: { filename: 'tiktokABCDEF.txt', set: true, url: `${BASE}/tiktokABCDEF.txt` },
    register: { redirectUri: `${BASE}/api/tiktok/callback`, webhookUrl: `${BASE}/api/tiktok/webhook`, termsUrl: `${BASE}/terms`, privacyUrl: `${BASE}/privacy`, websiteUrl: `${BASE}/` },
    scopes: ['user.info.basic', 'video.upload'],
    directPostEnabled: false,
    audited: false,
});

// Posts — src/dashboard/screens.test.ts, growth.test.ts, wave3.test.ts
const scheduledPosts = () => [
    { id: 'p1', platform: 'both', post_type: 'image', status: 'PENDING', caption: 'منشور الصباح — نصيحة اليوم', media_url: 'https://cdn.test/a.jpg', scheduled_time: inDays(1), created_at: minutesAgo(600) },
    { id: 'p2', platform: 'instagram', post_type: 'carousel', status: 'PENDING', caption: 'ثلاث أدوات تكفيك', media_url: 'https://cdn.test/1.jpg', media_urls: ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg', 'https://cdn.test/3.jpg'], scheduled_time: inDays(2), meta_options: { alt_texts: ['الأولى', '', 'الثالثة'], collaborators: ['partner'] }, created_at: minutesAgo(500) },
    { id: 'p3', platform: 'tiktok', post_type: 'video', status: 'IN_INBOX', caption: 'هدف بدل سؤال', media_url: 'https://cdn.test/v.mp4', scheduled_time: ago(3 * 3600 * 1000), group_id: 'g1', created_at: minutesAgo(400) },
    { id: 'p4', platform: 'facebook', post_type: 'video', status: 'FAILED', caption: 'فيديو لم يُنشر', media_url: 'https://cdn.test/v2.mp4', scheduled_time: ago(DAY), error_log: '(#100) The video could not be processed', created_at: minutesAgo(3000) },
    { id: 'p5', platform: 'both', post_type: 'video', status: 'PENDING', caption: 'قيد المعالجة', media_url: 'https://cdn.test/v3.mp4', cover_url: 'https://cdn.test/cover.jpg', scheduled_time: ago(2 * 3600 * 1000), external_publish_id: 'IGC:1789', error_log: 'Instagram is still processing the video; the next sweep publishes it.', created_at: minutesAgo(200) },
    { id: 'p6', platform: 'instagram', post_type: 'image', status: 'PUBLISHED', caption: 'نُشر أمس', media_url: 'https://cdn.test/b.jpg', scheduled_time: ago(2 * DAY), published_post_id: '1789', permalink: 'https://www.instagram.com/p/X1/', created_at: minutesAgo(4000) },
];

fixture('posts-composer', async () => {
    const h = harness({ files: ['dashboard/js/pages/posts.js'] });
    h.api.getScheduledPosts = () => Promise.resolve(scheduledPosts());
    h.api.getLivePosts = () => Promise.resolve([]);
    h.api.getTikTokConnection = () => Promise.resolve(tiktokConnection());
    h.api.getTikTokCreatorInfo = () => Promise.resolve({ postMode: 'inbox', audited: false, creator: null });
    await h.run('PostsPage.render()');
    await settle();
    h.run('PostsPage.showCreateModal()');
    await settle();
    const markup = compose(h);
    const modal = composeModal(h);
    h.run('PostsPage.destroy && PostsPage.destroy()');
    return { nav: 'posts', markup, modal };
});

// Growth — src/dashboard/growth.test.ts
const TYPES = ['REELS', 'CAROUSEL_ALBUM', 'IMAGE'];
const growthPosts = () => Array.from({ length: 30 }, (_, i) => {
    const fb = i % 3 === 2;
    const type = fb ? 'VIDEO' : TYPES[i % 3];
    const views = type === 'REELS' ? 2000 + i * 37 : type === 'VIDEO' ? 4000 + i * 11 : 600 + i * 13;
    const reach = Math.round(views * 0.7);
    const likes = Math.round(reach * 0.04);
    return {
        id: `p${i}`, platform: fb ? 'facebook' : 'instagram', media_id: `m${i}`, media_type: type,
        permalink: fb ? `https://www.facebook.com/p/${i}` : `https://www.instagram.com/p/X${i}/`,
        caption: `المنشور رقم ${i}\nالسطر الثاني`, thumbnail_url: `https://cdn.test/t${i}.jpg`,
        published_at: new Date(NOW - (i + 1) * 0.9 * DAY).toISOString(),
        metrics: {
            views, reach, likes, comments: i % 4, saved: type === 'CAROUSEL_ALBUM' ? 20 : 3, shares: type === 'REELS' ? 9 : 1,
            avg_watch_time_ms: type === 'REELS' ? 3000 + i * 10 : null, skip_rate: type === 'REELS' ? 40 + i : null,
        },
        engagement_rate: Math.round(((likes + (i % 4) + 4) / reach) * 10000) / 10000,
    };
});
const trendDays = (n) => Array.from({ length: n }, (_, i) => ({ day: new Date(NOW - (n - 1 - i) * DAY).toISOString().slice(0, 10), reach: 500 + i * 10, views: 800 + i * 20, followers: 1200 + i }));
const bestTimes = () => ({ cells: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, hr) => ({ weekday: d, hour: hr, avg: (d * 7 + hr * 3) % 50, posts: (d + hr) % 3 }))).flat(), max: 49 });
const growthOverview = () => ({
    kpis: { followers: 1240, followers_delta: 32, reach: 33243, views: 59455, engagement_rate: 0.053, saves: 205, shares: 149, profile_visits: 400, avg_watch_time_ms: 4200, skip_rate: 0.41 },
    trend: trendDays(28),
    best_times: bestTimes(),
    top_posts: [],
    by_type: [
        { type: 'REELS', posts: 10, avg_views: 128, avg_engagement: 0.019 },
        { type: 'CAROUSEL_ALBUM', posts: 10, avg_views: 39, avg_engagement: 0.123 },
    ],
    audience_split: { reach: { followers: 17, non_followers: 1704 }, views: { followers: 144, non_followers: 2202 } },
});
const growthSettings = () => ({
    keywords: ['ذكاء اصطناعي', 'برومبت'],
    hashtag_sets: [{ name: 'الذكاء الاصطناعي', tags: ['الذكاء_الاصطناعي', 'برومبت', 'AI'] }],
    competitors: ['ai.arabic'],
    audience: { countries: ['SA'], languages: ['ar'], timezone: 'Asia/Riyadh' },
    goal_followers: 10000,
});
function stubGrowth(api) {
    api.getGrowthStatus = () => Promise.resolve({ instagram: 'ok', facebook: 'ok', tiktok: 'unavailable', missing: [], lastSync: minutesAgo(90) });
    api.getGrowthOverview = () => Promise.resolve(growthOverview());
    api.getGrowthPosts = () => Promise.resolve({ posts: growthPosts() });
    api.getGrowthSettings = () => Promise.resolve({ settings: growthSettings() });
    api.getGrowthCompetitors = () => Promise.resolve([{ username: 'ai.arabic', followers: 5400, media_count: 210, recent: { posts: 8, avg_likes: 120, avg_comments: 9 } }]);
}
for (const tab of ['performance', 'seo']) {
    fixture(`growth-${tab}`, async () => {
        const h = harness({ files: ['dashboard/js/pages/growth.js'], hash: tab === 'seo' ? { tab: 'seo' } : {} });
        stubGrowth(h.api);
        await h.run('GrowthPage.render()');
        await settle();
        const markup = compose(h);
        h.run('GrowthPage.destroy()');
        return { nav: 'growth', markup };
    });
}

// Help — src/dashboard/help.test.ts
fixture('help-article', async () => {
    const h = harness({ files: ['dashboard/js/help-content.js', 'dashboard/js/pages/help.js'], locationHash: '#/help/worker', app: { isAdmin: () => false } });
    await h.run('HelpPage.render()');
    await settle();
    const markup = compose(h);
    h.run('HelpPage.destroy && HelpPage.destroy()');
    return { nav: 'help', markup };
});

// Inbox — src/dashboard/reading.test.ts
const threads = () => [
    { id: '1', username: 'sara_dev', platform: 'instagram', instagram_user_id: '1784', is_bot_active: false, last_message_direction: 'inbound', last_message_at: ago(60000), last_message_text: 'كم السعر؟' },
    { id: '2', username: 'omar', platform: 'facebook', instagram_user_id: '9921', is_bot_active: false, last_message_direction: 'outbound', last_message_at: ago(120000), last_message_text: 'تم' },
    { id: '3', username: 'lina', platform: 'instagram', instagram_user_id: '5530', is_bot_active: true, last_message_direction: 'inbound', last_message_at: ago(2 * DAY), last_message_text: 'مرحبا' },
];
const messages = () => [
    { id: 'm1', direction: 'inbound', text: 'السلام عليكم، كم سعر الكورس؟', created_at: ago(2 * DAY) },
    { id: 'm2', direction: 'outbound', sender: 'ai', text: 'وعليكم السلام! هذا الرابط 👇', created_at: ago(2 * DAY - 60000),
        raw_payload: JSON.stringify({ quick_replies: [{ title: 'التفاصيل', payload: 'x' }, { title: 'السعر', payload: 'y' }] }) },
    { id: 'm3', direction: 'inbound', text: 'شكراً، وهل فيه شهادة؟', created_at: ago(120000) },
    { id: 'm4', direction: 'outbound', sender: 'operator', text: 'نعم، شهادة إتمام.', created_at: ago(60000) },
];
fixture('inbox', async () => {
    const h = harness({ files: ['dashboard/js/pages/inbox.js'] });
    h.api.getConversations = () => Promise.resolve({ data: threads(), pagination: { total: 3 } });
    h.api.getConversationMessages = () => Promise.resolve(messages());
    h.run('InboxPage.render()');
    await settle();
    h.run("InboxPage.selectThread('1')");
    await settle();
    const markup = compose(h);
    h.run('InboxPage.destroy()');
    return { nav: 'inbox', markup };
});

// Overview — src/dashboard/reading.test.ts
const week = () => [10, 12, 14, 8, 16, 12, 12].map((sent, i) => ({ day: isoDay(6 - i), sent, failed: i === 6 ? 2 : i === 2 ? 4 : 0 }));
fixture('overview', async () => {
    const h = harness({ files: ['dashboard/js/pages/overview.js'] });
    h.api.getStats = () => Promise.resolve({ activeCampaigns: 3, totalInteractions: 900, successRate: 96, sent: 800 });
    h.api.getInteractions = () => Promise.resolve({ data: [
        { status: 'FAILED', error_log: '(#10) Outside the allowed window', trigger_keyword: 'سعر', username: 'sara_dev', platform: 'instagram', timestamp: ago(1000) },
        { status: 'SENT', trigger_keyword: 'برومبت', username: 'omar', platform: 'facebook', timestamp: ago(5000) },
    ], pagination: { total: 2 } });
    h.api.getTokenStatus = () => Promise.resolve({ status: 'valid', isActive: true, type: 'PAGE', expiresAt: 0 });
    h.api.getScheduledPosts = () => Promise.resolve(scheduledPosts());
    h.api.getConversations = () => Promise.resolve({ data: threads() });
    h.api.getDailyStats = () => Promise.resolve(week());
    h.api.getGrowthOverview = () => Promise.resolve(growthOverview());
    h.api.getGrowthSettings = () => Promise.resolve({ settings: growthSettings() });
    h.run('OverviewPage.render()');
    await settle();
    const markup = compose(h);
    h.run('OverviewPage.destroy && OverviewPage.destroy()');
    return { nav: 'overview', markup };
});

// Campaigns
const campaigns = () => [
    { id: 'c1', trigger_keyword: 'برومبت', keyword_variants: ['البرومبت'], match_mode: 'word', dm_template: 'هلا {username} 👋 هذا الرابط', public_reply_template: 'أرسلنا لك رسالة 📩', is_active: true, post_id: null, platform: 'both', total_interactions: 42, sent_count: 40, failed_count: 2, created_at: minutesAgo(9000) },
    { id: 'c2', trigger_keyword: 'سعر', keyword_variants: [], match_mode: 'substring', dm_template: 'السعر في الرابط', public_reply_template: '', is_active: false, post_id: '1789', platform: 'instagram', total_interactions: 0, sent_count: 0, failed_count: 0, created_at: minutesAgo(12000) },
];
fixture('campaigns-create', async () => {
    const h = harness({ files: ['dashboard/js/pages/campaigns.js'] });
    h.api.getCampaigns = () => Promise.resolve(campaigns());
    h.api.getLivePosts = () => Promise.resolve([]);
    await h.run('CampaignsPage.render()');
    await settle();
    h.run('CampaignsPage.showCreateModal()');
    await settle();
    const markup = compose(h);
    const modal = composeModal(h);
    h.run('CampaignsPage.destroy && CampaignsPage.destroy()');
    return { nav: 'campaigns', markup, modal };
});

// Settings — src/dashboard/wave2-settings.test.ts, media-storage.test.ts
fixture('settings', async () => {
    const h = harness({ files: ['dashboard/js/pages/settings.js'], app: { isAdmin: () => true } });
    h.api.getTokenStatus = () => Promise.resolve({ status: 'valid', isActive: true, type: 'PAGE', expiresAt: 0, dataAccessExpiresAt: Math.floor((NOW + 60 * DAY) / 1000), scopes: ['instagram_basic', 'instagram_manage_comments', 'pages_messaging', 'pages_manage_engagement'], pageId: '1000', instagramPageId: '1784', facebookPageId: '1000' });
    h.api.getWebhookToken = () => Promise.resolve({ configuredInDatabase: true, length: 32, preview: 've•••me', webhookUrl: `${BASE}/webhook` });
    h.api.getTikTokConnection = () => Promise.resolve(tiktokConnection());
    h.api.getTikTokAppSettings = () => Promise.resolve(tiktokApp());
    // src/dashboard/media-storage.test.ts CONNECTED
    h.api.getMediaStorage = () => Promise.resolve({
        backend: 'supabase', bucket: 'media',
        url: { value: 'https://abcd1234.supabase.co', source: 'database' },
        key: { set: true, source: 'database', kind: 'secret', preview: 'sb_•••••OP' },
        env: { url: false, key: false },
        connection: { ok: true, bucketExists: true, public: true, created: false },
        usage: { storage: { files: 12, bytes: 283115520 }, database: { files: 0, bytes: 0 }, queuedDeletions: 0, tierBytes: 1024 ** 3 },
    });
    h.api.getSiteSettings = () => Promise.resolve({ whatsappNumber: '966500000000', contactEmail: 'hello@example.com', source: { whatsappNumber: 'database', contactEmail: 'default' } });
    await h.run('SettingsPage.render()');
    await settle();
    const markup = compose(h);
    h.run('SettingsPage.destroy && SettingsPage.destroy()');
    return { nav: 'settings', markup };
});

// ─── More states, for coverage of what this refactor moved ─────────────────
fixture('studio-home-setup', async () => {
    // Worker offline, no library folder, no drafts, and a plan in every run state.
    const h = harness({ files: studioFiles });
    stubStudio(h.api, {
        drafts: [],
        status: studioStatus({ worker: { online: false, lastSeen: minutesAgo(600), name: 'Studio Mac' }, lessons: { total: 0, indexed: 0, indexing: 0, failed: 0 } }),
        settings: studioSettings({ library: { root: '' } }),
    });
    h.api.getStudioLessons = () => Promise.resolve({ lessons: [] });
    await h.run('StudioPage.render()');
    await settle();
    h.run(`StudioPage.plan = { status: 'ready', error: null, proposals: [
        { key: 'p1', keep: true, run: 'idle', title: 'هدف بدل سؤال', rationale: 'Opens on the result.', angle: 'auto', slot: '2026-09-26T10:00:00.000Z', lessonIds: ['l1'], idea: '', draftId: '', error: '' },
        { key: 'p2', keep: true, run: 'writing', title: 'ثلاث أدوات', rationale: '', angle: 'list', slot: null, lessonIds: [], draftId: '', error: '' },
        { key: 'p3', keep: true, run: 'done', title: 'قبل وبعد', rationale: '', angle: 'compare', slot: null, lessonIds: [], draftId: 'd9', error: '' },
        { key: 'p4', keep: true, run: 'failed', title: 'تعثر', rationale: '', angle: 'auto', slot: null, lessonIds: [], draftId: '', error: 'Gemini timed out' },
        { key: 'p5', keep: false, run: 'idle', title: 'مستبعد', rationale: '', angle: 'auto', slot: null, lessonIds: [], draftId: '', error: '' },
    ] };`);
    h.run('StudioPage.paintHome()');
    await settle();
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

fixture('studio-editor-problems', async () => {
    // The TikTok tab, a render older than the edits, and a save the server refused.
    const draft = studioDraft({ status: 'rendering', updated_at: minutesAgo(1) });
    const h = await studioEditor(draft);
    h.run(`StudioPage.previewTab = 'tt';
        StudioPage.takeSaveFailure({ body: { problems: ['[2:point].title is longer than 36 characters', '[4:compare].items[1] is empty', 'instagram caption must carry the keyword', 'the carousel needs at least 5 slides'] } });
        StudioPage.paintEditor();`);
    await settle();
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

fixture('studio-shot-picker', async () => {
    const h = await studioEditor(studioDraft());
    await h.run('StudioPage.openShots(7)');
    await settle();
    const markup = compose(h);
    const modal = composeModal(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup, modal };
});

fixture('studio-settings-token', async () => {
    const h = harness({ files: studioFiles, hash: { tab: 'settings' } });
    stubStudio(h.api, { drafts: [] });
    await h.run('StudioPage.render()');
    await settle();
    h.run(`StudioPage.newWorker = { worker: { id: 'w3', name: 'New Mac' }, token: 'stw_9f3c1a7e5b2d4c6a8e0f1b3d5c7a9e1f' }; StudioPage.paintWorkers();`);
    const markup = compose(h);
    h.run('StudioPage.destroy()');
    return { nav: 'studio', markup };
});

for (const [name, id] of [['posts-edit-carousel', 'p2'], ['posts-edit-tiktok', 'p3'], ['posts-edit-video', 'p5']]) {
    fixture(name, async () => {
        const h = harness({ files: ['dashboard/js/pages/posts.js'] });
        h.api.getScheduledPosts = () => Promise.resolve(scheduledPosts());
        h.api.getLivePosts = () => Promise.resolve([]);
        h.api.getTikTokConnection = () => Promise.resolve(tiktokConnection());
        h.api.getTikTokCreatorInfo = () => Promise.resolve({ postMode: 'inbox', audited: false, creator: null });
        await h.run('PostsPage.render()');
        await settle();
        h.run(`PostsPage.showEditModal(${JSON.stringify(id)})`);
        await settle();
        const markup = compose(h);
        const modal = composeModal(h);
        h.run('PostsPage.destroy && PostsPage.destroy()');
        return { nav: 'posts', markup, modal };
    });
}

for (const [name, live] of [['campaigns-picker', [
    { id: '1789_1', platform: 'instagram', caption: 'هدف بدل سؤال', media_url: 'https://cdn.test/a.jpg', timestamp: ago(DAY) },
    { id: '1789_2', platform: 'facebook', caption: '', media_url: null, timestamp: ago(2 * DAY) },
]], ['campaigns-picker-empty', []]]) fixture(name, async () => {
    const h = harness({ files: ['dashboard/js/pages/campaigns.js'] });
    h.api.getCampaigns = () => Promise.resolve(campaigns());
    h.api.getLivePosts = () => Promise.resolve(live);
    await h.run('CampaignsPage.render()');
    await settle();
    h.run('CampaignsPage.showCreateModal()');
    await h.run("CampaignsPage.openPostPicker(document.getElementById('campaign-post-picker-btn'))");
    await settle();
    const markup = compose(h);
    const modal = composeModal(h);
    return { nav: 'campaigns', markup, modal };
});

fixture('overview-quiet', async () => {
    // A day with nothing in it: the empty table row, the empty strip.
    const h = harness({ files: ['dashboard/js/pages/overview.js'] });
    h.api.getStats = () => Promise.resolve({ activeCampaigns: 0, totalInteractions: 0, successRate: 0, sent: 0 });
    h.api.getInteractions = () => Promise.resolve({ data: [], pagination: { total: 0 } });
    h.api.getTokenStatus = () => Promise.resolve({ status: 'valid', isActive: true, type: 'PAGE', expiresAt: 0 });
    h.api.getScheduledPosts = () => Promise.resolve([]);
    h.api.getConversations = () => Promise.resolve({ data: [] });
    h.api.getDailyStats = () => Promise.resolve([]);
    h.api.getGrowthOverview = () => Promise.resolve({});
    h.api.getGrowthSettings = () => Promise.resolve({});
    h.run('OverviewPage.render()');
    await settle();
    const markup = compose(h);
    h.run('OverviewPage.destroy && OverviewPage.destroy()');
    return { nav: 'overview', markup };
});

fixture('inbox-empty', async () => {
    // Nothing selected, and a filter nothing matches.
    const h = harness({ files: ['dashboard/js/pages/inbox.js'], hash: { filter: 'waiting' } });
    h.api.getConversations = () => Promise.resolve({ data: threads().map((x) => ({ ...x, is_bot_active: true })), pagination: { total: 3 } });
    h.run('InboxPage.render()');
    await settle();
    const markup = compose(h);
    h.run('InboxPage.destroy()');
    return { nav: 'inbox', markup };
});

fixture('ai-settings', async () => {
    const h = harness({ files: ['dashboard/js/pages/ai_settings.js'] });
    h.api.getAiSettings = () => Promise.resolve({ is_active: true, model: 'gemini-2.5-flash', temperature: 0.4, system_prompt: 'أنت مساعد.', knowledge_base: 'الكورس ٣٤ درس.' });
    h.run('AiSettingsPage.render()');
    await settle();
    const markup = compose(h);
    h.run('AiSettingsPage.destroy && AiSettingsPage.destroy()');
    return { nav: 'ai_settings', markup };
});

fixture('analytics', async () => {
    // src/dashboard/wave3.test.ts
    const h = harness({ files: ['dashboard/js/pages/analytics.js'] });
    h.api.getStats = () => Promise.resolve({ totalInteractions: 40, sent: 30, failed: 10, successRate: 75, uniqueUsersReached: 12, instagramCount: 30, facebookCount: 10 });
    h.api.getDailyStats = () => Promise.resolve([]);
    h.api.getCampaignStats = () => Promise.resolve([{ id: 'c1', trigger_keyword: 'price', total_triggers: 4, sent_count: 3, failed_count: 1 }]);
    h.api.getFailureReasons = () => Promise.resolve({ days: 30, total: 13, reasons: [
        { reason_code: '190', count: 8, sample: 'Private Reply Failed: Error validating access token (Code: 190)', last_at: '2026-09-26T08:00:00.000Z' },
        { reason_code: 'recipient_cap', count: 5, sample: 'Skipped: recipient already received an automated DM within 24 hours.', last_at: '2026-09-27T08:00:00.000Z' },
    ] });
    await h.run('AnalyticsPage.render()');
    await settle();
    const markup = compose(h);
    h.run('AnalyticsPage.destroy && AnalyticsPage.destroy()');
    return { nav: 'analytics', markup };
});

fixture('help-faq', async () => {
    const h = harness({ files: ['dashboard/js/help-content.js', 'dashboard/js/pages/help.js'], locationHash: '#/help/faq', app: { isAdmin: () => false } });
    await h.run('HelpPage.render()');
    await settle();
    // A search that finds nothing, in the list beside the article.
    h.run("HelpPage.query = 'zzqx'; HelpPage.paintList && HelpPage.paintList();");
    const markup = compose(h);
    return { nav: 'help', markup };
});

fixture('monteur-first-run', async () => {
    const h = harness({ files: ['dashboard/js/pages/monteur.js'] });
    const view = monteurView();
    h.api.getMonteur = () => Promise.resolve({ ...view, settings: { ...view.settings, enabled: false, folder: null }, next_run: null, last_scan: null, sources: [], clips: [], lessons: null });
    h.api.getStudioSettings = () => Promise.resolve({ settings: { cta: {}, voice: { language: 'ar' }, schedule: { timezone: 'Asia/Riyadh', slots: [] } } });
    await h.run('MonteurPage.render()');
    await settle();
    const markup = compose(h);
    h.run('MonteurPage.destroy()');
    return { nav: 'monteur', markup };
});

// ─── The browser half ───────────────────────────────────────────────────────
/**
 * The dump, as source, so computed-dump.js and compare.js share one definition. Every element in
 * document order, keyed by its tag + index chain from <html>; every enumerable computed property
 * but the volatile ones; and for ::before/::after their content, display and size.
 */
const DUMP_SOURCE = String.raw`function cssDump(doc) {
    doc = doc || document;
    var win = doc.defaultView;
    var VOLATILE = { '-webkit-locale': 1 };
    function key(el) {
        var parts = [];
        for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
            var i = e.parentElement ? Array.prototype.indexOf.call(e.parentElement.children, e) : 0;
            parts.unshift(e.tagName.toLowerCase() + ':' + i);
        }
        return parts.join('>');
    }
    var out = {};
    var all = doc.querySelectorAll('*');
    for (var n = 0; n < all.length; n++) {
        var el = all[n];
        var cs = win.getComputedStyle(el);
        var rec = {};
        for (var i = 0; i < cs.length; i++) {
            var p = cs[i];
            if (!VOLATILE[p]) rec[p] = cs.getPropertyValue(p);
        }
        ['::before', '::after'].forEach(function (pe) {
            var c = win.getComputedStyle(el, pe);
            rec[pe + ' content'] = c.content;
            rec[pe + ' display'] = c.display;
            rec[pe + ' inline-size'] = c.inlineSize;
            rec[pe + ' block-size'] = c.blockSize;
        });
        out[key(el)] = rec;
    }
    return out;
}`;

function dumpScript() {
    return `/*
 * computed-dump.js — paste into a fixture page (DevTools console, or a javascript tool).
 * Evaluates to { elements, properties, dump } for the stylesheet the page currently links,
 * and leaves window.cssDump(doc) behind for reuse. Generated by scripts/css-fixtures.mjs.
 */
(function () {
    ${DUMP_SOURCE.replace(/\n/g, '\n    ')}
    window.cssDump = cssDump;
    for (const a of document.getAnimations()) { try { a.pause(); a.currentTime = 0; } catch (e) { /* not seekable */ } }
    var dump = cssDump(document);
    var keys = Object.keys(dump);
    return { elements: keys.length, properties: keys.length ? Object.keys(dump[keys[0]]).length : 0, dump: dump };
}());
`;
}

function compareScript() {
    return `/*
 * compare.js — paste into a fixture page. Loads styles.old.css then styles.new.css into
 * #css-under-test, dumps every element's computed style under each, for data-theme dark and
 * light, at the window's own width and in same-document iframes at 375 / 800 / 1280 px, and
 * evaluates to the differences: { page, runs: [...], differences, list: [{ where, path, property,
 * old, new }] } with the list capped at 200. Animations are paused at t=0 before each dump so a
 * running sweep is not a difference. Generated by scripts/css-fixtures.mjs.
 */
(async function () {
    var OLD = ${JSON.stringify(fileUrl('styles.old.css'))};
    var NEW = ${JSON.stringify(fileUrl('styles.new.css'))};
    ${DUMP_SOURCE.replace(/\n/g, '\n    ')}
    function frame(win) { return new Promise(function (r) { win.requestAnimationFrame(function () { win.requestAnimationFrame(r); }); }); }
    function load(doc, href) {
        var link = doc.getElementById('css-under-test');
        if (!link) return Promise.reject(new Error('no #css-under-test link'));
        if (link.href === href && link.sheet) return Promise.resolve();
        return new Promise(function (resolve, reject) {
            link.onload = function () { resolve(); };
            link.onerror = function () { reject(new Error('could not load ' + href)); };
            link.setAttribute('href', href);
        });
    }
    function freeze(doc) {
        (doc.getAnimations ? doc.getAnimations() : []).forEach(function (a) { try { a.pause(); a.currentTime = 0; } catch (e) { /* not seekable */ } });
    }
    var list = [];
    var total = 0;
    var runs = [];
    async function run(doc, where) {
        var win = doc.defaultView;
        var restore = doc.documentElement.getAttribute('data-theme');
        for (var theme of ['dark', 'light']) {
            doc.documentElement.setAttribute('data-theme', theme);
            await load(doc, OLD); await frame(win); freeze(doc);
            var a = cssDump(doc);
            await load(doc, NEW); await frame(win); freeze(doc);
            var b = cssDump(doc);
            var n = 0;
            var keys = Object.keys(a);
            for (var k of new Set(keys.concat(Object.keys(b)))) {
                var x = a[k] || {}, y = b[k] || {};
                for (var p of new Set(Object.keys(x).concat(Object.keys(y)))) {
                    if (x[p] === y[p]) continue;
                    n++; total++;
                    if (list.length < 200) list.push({ where: where + ' ' + theme, path: k, property: p, old: x[p], new: y[p] });
                }
            }
            runs.push({ where: where + ' ' + theme, elements: keys.length, differences: n });
        }
        if (restore === null) doc.documentElement.removeAttribute('data-theme'); else doc.documentElement.setAttribute('data-theme', restore);
    }
    var source = '<!DOCTYPE html>' + document.documentElement.outerHTML;
    await run(document, 'window ' + window.innerWidth + 'px');
    for (var width of [375, 800, 1280]) {
        var frameEl = document.createElement('iframe');
        frameEl.style.cssText = 'position:absolute;inset-block-start:0;inset-inline-start:-99999px;border:0;block-size:900px;inline-size:' + width + 'px';
        var ready = new Promise(function (r) { frameEl.onload = r; });
        frameEl.srcdoc = source;
        document.body.appendChild(frameEl);
        await ready;
        try { await run(frameEl.contentDocument, 'iframe ' + width + 'px'); }
        catch (e) { runs.push({ where: 'iframe ' + width + 'px', error: String(e && e.message || e) }); }
        frameEl.remove();
    }
    return { page: location.pathname.split('/').pop(), runs: runs, differences: total, list: list };
}());
`;
}

// ─── Coverage: which fixtures exercise which selectors ──────────────────────
/** Elements of an HTML string: { tag, id, classes:Set, attrs:Map, parent, prev }. */
function elementsOf(markup) {
    const root = { tag: '#root', classes: new Set(), attrs: new Map(), children: [], parent: null };
    const stack = [root];
    const all = [];
    for (const t of tagsOf(markup.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length)))) {
        if (t.close) {
            for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === t.name) { stack.length = i; break; }
            continue;
        }
        const attrs = new Map();
        for (const a of t.attrs.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
        const parent = stack[stack.length - 1];
        const el = { tag: t.name, id: attrs.get('id') || '', classes: new Set((attrs.get('class') || '').split(/\s+/).filter(Boolean)), attrs, children: [], parent, prev: parent.children[parent.children.length - 1] || null };
        parent.children.push(el);
        all.push(el);
        if (!VOID.has(t.name) && !t.selfClosing && t.name !== 'script' && t.name !== 'style') stack.push(el);
    }
    return all;
}

/** Split a complex selector into [compound, combinator] pairs, subject last. */
function compounds(sel) {
    const out = [];
    let depth = 0, quote = null, cur = '', comb = null;
    const push = () => { if (cur.trim()) { out.push({ text: cur.trim(), comb }); comb = null; } cur = ''; };
    for (let i = 0; i < sel.length; i++) {
        const c = sel[i];
        if (quote) { cur += c; if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") { quote = c; cur += c; continue; }
        if (c === '(' || c === '[') depth++;
        if (c === ')' || c === ']') depth--;
        if (depth === 0 && /[\s>+~]/.test(c)) {
            if (cur.trim()) push();
            if (c !== ' ' && c !== '\n' && c !== '\t') comb = c;
            else if (comb === null && out.length) comb = comb ?? ' ';
            continue;
        }
        cur += c;
    }
    push();
    return out;
}

/** Does `el` match one compound? State pseudo-classes (:hover, :focus-visible…) count as matching. */
function matchesCompound(el, text) {
    let flat = '';
    let depth = 0;
    const nots = [];
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (text.startsWith(':not(', i) && depth === 0) {
            let d = 0, j = i + 4;
            for (; j < text.length; j++) { if (text[j] === '(') d++; else if (text[j] === ')') { d--; if (d === 0) break; } }
            nots.push(text.slice(i + 5, j));
            i = j;
            continue;
        }
        if (c === '(') depth++;
        if (depth === 0) flat += c;
        if (c === ')') depth--;
    }
    flat = flat.replace(/::?[\w-]+(\([^)]*\))?/g, (m) => (/^::/.test(m) || /^:(before|after)$/.test(m) ? '' : m));
    const type = (flat.match(/^([a-zA-Z][\w-]*)/) || [])[1];
    if (type && type.toLowerCase() !== el.tag) return false;
    for (const m of flat.matchAll(/\.([\w-]+)/g)) if (!el.classes.has(m[1])) return false;
    for (const m of flat.matchAll(/#([\w-]+)/g)) if (el.id !== m[1]) return false;
    for (const m of text.matchAll(/\[([\w:-]+)(?:([~|^$*]?=)['"]?([^'"\]]*)['"]?)?\]/g)) {
        const v = el.attrs.get(m[1].toLowerCase());
        if (v === undefined) return false;
        if (m[2] === '=' && v !== m[3]) return false;
        if (m[2] === '~=' && !v.split(/\s+/).includes(m[3])) return false;
        if (m[2] === '^=' && !v.startsWith(m[3])) return false;
        if (m[2] === '*=' && !v.includes(m[3])) return false;
    }
    if (/:first-child\b/.test(flat) && el.prev) return false;
    if (/:empty\b/.test(flat) && el.children.length) return false;
    for (const n of nots) if (n.split(',').some((alt) => /^[.#[\w]/.test(alt.trim()) && !/[\s>+~]/.test(alt.trim()) && matchesCompound(el, alt.trim()))) return false;
    return true;
}

function matchesSelector(el, sel) {
    const parts = compounds(sel);
    const step = (node, k) => {
        if (!matchesCompound(node, parts[k].text)) return false;
        if (k === 0) return true;
        const comb = parts[k].comb || ' ';
        if (comb === '>') return !!node.parent && node.parent.tag !== '#root' && step(node.parent, k - 1);
        if (comb === '+') return !!node.prev && step(node.prev, k - 1);
        if (comb === '~') { for (let s = node.prev; s; s = s.prev) if (step(s, k - 1)) return true; return false; }
        for (let a = node.parent; a && a.tag !== '#root'; a = a.parent) if (step(a, k - 1)) return true;
        return false;
    };
    return step(el, parts.length - 1);
}

function coverage(written) {
    const css = readFileSync('dashboard/css/styles.css', 'utf8');
    const parsed = parseCss(css);
    const start = css.indexOf('/* ─── Shared patterns');
    const studioStart = css.indexOf('Carousel Studio (#/studio)');
    const studioEnd = css.indexOf('/* ─── Help Center (#/help)');
    if (start < 0 || studioStart < 0 || studioEnd < 0) throw new Error('coverage: section banners not found');
    const trees = written.map((w) => ({ name: w.name, els: elementsOf(w.html) }));
    const rows = [];
    const seen = new Set();
    for (const r of parsed.rules) {
        if (r.start < start || r.start > studioEnd || r.ctx.startsWith('@keyframes')) continue;
        const section = r.start < studioStart ? 'patterns' : 'studio';
        for (const sel of r.selectors) {
            const key = `${r.ctx}|${sel}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const hits = trees.filter((t) => t.els.some((el) => matchesSelector(el, sel))).map((t) => t.name);
            rows.push({ section, ctx: r.ctx, sel, hits, line: parsed.lineAt(r.start) });
        }
    }
    return rows;
}

/** Every class list a fixture renders must be one the markup model says can exist. */
function modelCheck(written) {
    const markup = scanMarkup(styledSources());
    const bad = new Map();
    for (const w of written) {
        for (const el of elementsOf(w.html)) {
            if (el.classes.size < 2) continue;
            // The shell (index.html) is an origin too; lucide's own classes are added to every icon.
            const need = new Set([...el.classes].filter((c) => c !== 'lucide' && !c.startsWith('lucide-')));
            if (need.size < 2) continue;
            if (!shareWitness(need, markup)) {
                const k = [...need].sort().join(' ');
                if (!bad.has(k)) bad.set(k, new Set());
                bad.get(k).add(w.name);
            }
        }
    }
    return bad;
}

// ─── Write everything ───────────────────────────────────────────────────────
async function main() {
    const only = arg('--only');
    const written = [];
    for (const f of FIXTURES) {
        if (only && f.name !== only) continue;
        let result;
        try {
            result = await f.fn();
        } catch (err) {
            console.error(`✗ ${f.name}: ${err && err.stack || err}`);
            process.exitCode = 1;
            continue;
        }
        const html = pageHtml({ title: f.name, nav: result.nav, markup: result.markup, modal: result.modal ?? null, pageTitle: result.pageTitle || '' });
        writeFileSync(`${outDir}/${f.name}.html`, html);
        written.push({ name: f.name, html, bytes: html.length });
    }
    writeFileSync(`${outDir}/styles.new.css`, readFileSync('dashboard/css/styles.css', 'utf8'));
    writeFileSync(`${outDir}/tokens.css`, readFileSync('dashboard/css/tokens.css', 'utf8'));
    writeFileSync(`${outDir}/styles.old.css`, execFileSync('git', ['show', `${OLD_REF}:dashboard/css/styles.css`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    writeFileSync(`${outDir}/computed-dump.js`, dumpScript());
    writeFileSync(`${outDir}/compare.js`, compareScript());
    console.log(`fixtures in ${outDir}:`);
    for (const w of written) console.log(`   ${w.name}.html (${(w.bytes / 1024).toFixed(0)} KB)`);
    console.log('   styles.old.css (' + OLD_REF + '), styles.new.css, tokens.css, computed-dump.js, compare.js');

    // Coverage of the sections this refactor touched.
    const rows = coverage(written);
    const width = Math.min(70, Math.max(...rows.map((r) => (r.ctx ? r.ctx.length + 1 : 0) + r.sel.length)));
    console.log(`\ncoverage — selector → fixtures holding an element it matches (state pseudo-classes count as matching):`);
    for (const r of rows) {
        const label = `${r.ctx ? `${r.ctx} ` : ''}${r.sel}`;
        console.log(`   ${r.section === 'patterns' ? 'P' : 'S'} L${String(r.line).padEnd(5)} ${label.length > width ? label.slice(0, width - 1) + '…' : label.padEnd(width)}  ${r.hits.length ? r.hits.join(', ') : '—'}`);
    }
    const gaps = rows.filter((r) => r.hits.length === 0);
    const studioRows = rows.filter((r) => r.section === 'studio');
    console.log(`\n${studioRows.length - gaps.filter((r) => r.section === 'studio').length} of ${studioRows.length} Studio-section selectors exercised; ${rows.filter((r) => r.section === 'patterns' && r.hits.length).length} of ${rows.filter((r) => r.section === 'patterns').length} shared-pattern selectors exercised.`);
    console.log(`not exercised by any fixture (${gaps.length}):`);
    for (const r of gaps) console.log(`   ${r.section === 'patterns' ? 'P' : 'S'} L${r.line} ${r.ctx ? `${r.ctx} ` : ''}${r.sel}`);

    const bad = modelCheck(written);
    if (bad.size) {
        console.log(`\n✗ ${bad.size} rendered class list(s) the markup model in css-declmap.mjs says cannot exist:`);
        for (const [k, where] of bad) console.log(`   ${k}   (${[...where].join(', ')})`);
        process.exitCode = 1;
    } else {
        console.log('\n✓ markup model: every class list the fixtures render is one css-declmap.mjs knows can exist');
    }
    return written;
}

await main();
