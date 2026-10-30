/**
 * The Help Center (#/help): the route, the search, deep links, both languages, and the
 * contextual "?" links other screens carry into it.
 *
 * Loaded like the other dashboard tests: the REAL shipped files in a `node:vm` context, so
 * these test what ships. Two claims here matter more than the rest, because each fails
 * silently in the browser:
 *
 *   - A deep link (`#/help/worker#security`) has to survive App's hash normalisation and
 *     land on its section. The router used to rewrite anything it did not recognise to the
 *     bare page name, which would throw the article and the section away on every reload.
 *   - Every contextual link must name an article and a section that exist. A "?" that opens
 *     the Help Center's front page instead of the answer looks like it works.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>;
type Translate = (key: string, params?: Record<string, unknown>) => string;

interface FakeEl {
    id: string;
    innerHTML: string;
    textContent: string;
    value: string;
    dataset: Record<string, string>;
    focused: number;
    scrolled: number;
    classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
    focus(): void;
    scrollIntoView(): void;
    querySelectorAll(): never[];
    querySelector(): null;
    closest(): null;
}

function fakeEl(id: string): FakeEl {
    const attrs = new Map<string, string>();
    const el: FakeEl = {
        id, innerHTML: '', textContent: '', value: '', dataset: {}, focused: 0, scrolled: 0,
        classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
        setAttribute: (n, v) => { attrs.set(n, String(v)); },
        getAttribute: (n) => (attrs.has(n) ? attrs.get(n)! : null),
        removeAttribute: (n) => { attrs.delete(n); },
        focus: () => { el.focused++; },
        scrollIntoView: () => { el.scrolled++; },
        querySelectorAll: () => [],
        querySelector: () => null,
        closest: () => null,
    };
    return el;
}

interface HelpApi {
    route: { slug: string; section: string };
    query: string;
    lastTarget: string;
    parseRoute(hash: string): { slug: string; section: string };
    render(): Promise<void>;
    onHashChange(): void;
    search(query: string): Array<{ slug: string; section: string; href: string; title: string }>;
    listMarkup(): { toString(): string };
    articleMarkup(article: Json): { toString(): string };
    sectionMarkup(article: Json, section: Json): { toString(): string };
    blockMarkup(block: unknown): { toString(): string };
    blockText(block: unknown): string;
    articles(): Json[];
}

interface Loaded {
    Help: HelpApi;
    UI: Json;
    t: Translate;
    I18N: { lang: string; strings: Record<string, Record<string, string>> };
    content: { articles: Json[]; groups: Json[]; popular: string[] };
    ctx: Json;
    dom: Map<string, FakeEl>;
    host(id: string): FakeEl;
    scrolls: number[];
    /** Run a script in the page's context and hand back its value. */
    run<T>(code: string): T;
}

function unref<T>(handle: T): T {
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
}

/** The dashboard's shared files plus `extra`, in a fresh context, in `lang`. */
function load(lang: 'ar' | 'en' = 'ar', hash = '#/help', extra: string[] = []): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const scrolls: number[] = [];
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
    const location = { hash };
    const ctx: Json = {
        document: {
            ...stub,
            createElement: () => ({ ...stub }),
            body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null,
            activeElement: null,
            visibilityState: 'visible',
        },
        window: {
            addEventListener: noop, removeEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop }),
            location,
            scrollTo: (x: number, y: number) => { scrolls.push(y); void x; },
        },
        location,
        history: { replaceState: noop },
        Intl, console, clearTimeout, clearInterval,
        setTimeout: (fn: () => void, ms?: number) => unref(setTimeout(fn, ms)),
        setInterval: (fn: () => void, ms?: number) => unref(setInterval(fn, ms)),
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: { token: 'test' },
        Admin: { emptyState: () => '', confirm: noop },
        App: { currentTheme: () => 'auto', navigate: noop, isAdmin: () => false, canAdminister: () => true, hashParam: () => '' },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js',
        'dashboard/js/motion.js',
        'dashboard/js/help-content.js',
        'dashboard/js/pages/help.js',
        ...extra,
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
    run(`I18N.lang = ${JSON.stringify(lang)};`);
    const loaded = run<{ Help: HelpApi; UI: Json; t: Translate; I18N: Loaded['I18N']; content: Loaded['content'] }>(
        '({ Help: HelpPage, UI, t, I18N, content: HelpContent })'
    );
    loaded.UI.toast = noop;
    const host = (id: string): FakeEl => {
        const el = fakeEl(id);
        dom.set(id, el);
        return el;
    };
    host('page-container');
    return { ...loaded, ctx, dom, host, scrolls, run };
}

/** Everything the page writes into a region, as text, with tags taken out. */
const textOf = (markup: string): string => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const REQUIRED = [
    'getting-started', 'onboarding', 'connect-meta', 'campaigns', 'dm-assistant', 'scheduling', 'growth', 'seo', 'tiktok', 'youtube', 'whatsapp', 'ads',
    'studio', 'worker', 'library', 'create', 'studio-schedule', 'studio-settings', 'monteur', 'infographics', 'explainers', 'ai-usage', 'troubleshooting', 'faq',
];

const ARABIC = /[\u0600-\u06FF]/g;
const LATIN = /[A-Za-z]/g;
const count = (s: string, re: RegExp): number => (s.match(re) || []).length;

// ─────────────────────────────────────────────────────────────────────────────

describe('Help Center — the route renders', () => {
    it('#/help paints the search box, every article in the list, and the front page', async () => {
        const s = load('ar', '#/help');
        await s.Help.render();
        const markup = s.dom.get('page-container')!.innerHTML;
        assert.match(markup, /<input[^>]+id="help-search"[^>]+data-input="help:search"/);
        assert.match(markup, /data-view="index"/);
        for (const a of s.content.articles) {
            assert.ok(markup.includes(`href="#/help/${a.slug}"`), `the list links to ${a.slug}`);
            assert.ok(markup.includes(a.title.ar), `the list names ${a.slug} in Arabic`);
        }
        assert.ok(markup.includes(s.t('help.welcome.title')));
        assert.equal(s.t('nav.help'), 'المساعدة');
    });

    it('is in the sidebar, right after Settings in the foot, and preloaded by its hash', () => {
        const index = readFileSync('dashboard/index.html', 'utf8');
        const item = index.match(/<a href="#\/help" class="nav-item" data-page="help">[\s\S]*?<\/a>/);
        assert.ok(item, 'the nav item exists');
        assert.match(item[0], /data-i18n="nav\.help">المساعدة</);
        // The foot of the sidebar (US6): Settings, then Help, after the job groups and the Administration group, before the account area.
        const at = (needle: string): number => index.indexOf(needle);
        assert.ok(at('data-page="settings"') < at('data-page="help"'));
        assert.ok(at('data-i18n="nav.group.admin"') < at('data-page="settings"'), 'the foot comes after the Administration group');
        assert.ok(at('data-page="help"') < at('id="nav-identity"'), 'and before the account area');
        // The inline preloader knows the page, and reads the first segment of a deep link.
        assert.match(index, /var PAGES = \[[^\]]*'help'/);
        assert.match(index, /split\(\/\[\\\/\?#\]\/\)\[0\]/);
        const s = load('en');
        assert.equal(s.t('nav.help'), 'Help');
    });

    it('App routes #/help and all its sub-paths to the help page', () => {
        const s = load('ar', '#/help', ['dashboard/js/app.js']);
        const App = s.run<Json>('App');
        assert.equal(App.pages.help.src, 'help');
        for (const hash of ['#/help', '#/help/', '#/help/worker', '#/help/worker#security', '#/help/worker/security', '#help']) {
            s.ctx.location.hash = hash;
            assert.equal(App.pageFromHash(), 'help', hash);
        }
        s.ctx.location.hash = '#/helpless';
        assert.equal(App.pageFromHash(), 'overview');
        s.ctx.location.hash = '#/tenant_detail?id=5';
        assert.equal(App.pageFromHash(), 'tenant_detail');
    });

    it('a hash change inside the help page is handed to it instead of rebuilding the page', () => {
        const s = load('ar', '#/help/worker', ['dashboard/js/app.js']);
        const App = s.run<Json>('App');
        const shown: string[] = [];
        App.show = (page: string) => { shown.push(page); };
        let handled = 0;
        App.pages.help = { src: 'help', page: () => ({ onHashChange: () => { handled++; } }) };
        App.currentPage = 'help';
        s.ctx.location.hash = '#/help/tiktok#bio';
        App.onHashChange();
        assert.equal(handled, 1);
        assert.deepEqual(shown, []);
        // From another page it is an ordinary navigation.
        App.currentPage = 'studio';
        App.onHashChange();
        assert.deepEqual(shown, ['help']);
    });

    it('a deep link survives sign-in: showApp keeps #/help/worker#security as it is', async () => {
        const s = load('ar', '#/help/worker#security', ['dashboard/js/app.js']);
        const App = s.run<Json>('App');
        s.host('login-screen');
        s.host('app');
        const replaced: string[] = [];
        s.ctx.history.replaceState = (_state: unknown, _title: string, url: string) => { replaced.push(url); };
        s.ctx.API.getMe = () => Promise.resolve({ userId: 'u', role: 'user', tenantId: 't', tenants: [{ id: 't' }] });
        App.applyChrome = () => {};
        const navigated: string[] = [];
        App.navigate = (page: string) => { navigated.push(page); return Promise.resolve(); };
        await App.showApp();
        assert.deepEqual(replaced, [], 'the deep link was not rewritten');
        assert.deepEqual(navigated, ['help']);
        // An unknown page is still normalised, and keeps its query as before.
        s.ctx.location.hash = '#/nowhere?x=1';
        await App.showApp();
        assert.deepEqual(replaced, ['#/overview?x=1']);
    });
});

describe('Help Center — search', () => {
    it('finds a word that only appears in an article’s body, and links to that section', () => {
        const s = load('en');
        const results = s.Help.search('launchctl');
        assert.ok(results.length >= 1);
        assert.equal(results[0]!.slug, 'worker');
        assert.equal(results[0]!.href, '#/help/worker#install');
    });

    it('ranks a title match first, and links to the article when its title says it all', () => {
        const s = load('ar');
        const results = s.Help.search('العامل');
        assert.equal(results[0]!.slug, 'worker');
        assert.equal(results[0]!.href, '#/help/worker');
    });

    it('normalises Arabic like the webhook: ة/ه, hamza forms, diacritics and tatweel', () => {
        const s = load('ar');
        // Array.from, not .map: an array made inside the vm has the other realm's prototype.
        const slugs = (q: string): string[] => Array.from(s.Help.search(q), (r) => r.slug);
        assert.ok(slugs('فهرسه').includes('library'), 'ه finds ة');
        assert.ok(slugs('الاعدادات').includes('studio-settings'), 'bare alef finds الإعدادات');
        assert.ok(slugs('الـعـامـل').includes('worker'), 'tatweel is ignored');
        assert.deepEqual(slugs('فهرسه'), slugs('فهرسة'));
    });

    it('needs every word to match, anywhere in the article', () => {
        const s = load('en');
        assert.equal(s.Help.search('worker zebra').length, 0);
        const both = Array.from(s.Help.search('caffeinate sleep'), (r) => r.slug);
        assert.deepEqual(both, ['worker']);
    });

    it('filters the list: only matching articles, each with a marked snippet', () => {
        const s = load('en');
        s.Help.query = 'caffeinate';
        const markup = s.Help.listMarkup().toString();
        assert.ok(markup.includes('href="#/help/worker#sleep"'));
        assert.match(markup, /<mark class="help-hit">caffeinate<\/mark>/);
        assert.equal(markup.includes('href="#/help/campaigns"'), false);
        assert.ok(markup.includes(s.t('help.search.results', { count: 1 })));
    });

    it('says so when nothing matches, and offers a way out', () => {
        const s = load('ar');
        s.Help.query = 'زززقققوووو';
        const markup = s.Help.listMarkup().toString();
        assert.ok(markup.includes(s.t('help.search.none', { query: 'زززقققوووو' })));
        assert.ok(markup.includes('data-action="help:clearSearch"'));
        assert.ok(markup.includes('href="#/help/troubleshooting"'));
    });

    it('typing repaints the list and nothing else', () => {
        const s = load('en');
        const list = s.host('help-list');
        const main = s.host('help-main');
        main.innerHTML = 'untouched';
        s.UI._actions.help.search({ value: 'tiktok' });
        assert.equal(s.Help.query, 'tiktok');
        assert.ok(list.innerHTML.includes('href="#/help/tiktok'));
        assert.equal(main.innerHTML, 'untouched');
    });

    it('escapes the query in what it paints back', () => {
        const s = load('en');
        s.Help.query = '<img src=x onerror=alert(1)>';
        const markup = s.Help.listMarkup().toString();
        assert.equal(markup.includes('<img'), false);
        assert.ok(markup.includes('&lt;img'));
    });
});

describe('Help Center — deep links', () => {
    it('reads the slug and the section, and drops anything that is not a plain slug', () => {
        const s = load();
        const cases: Array<[string, { slug: string; section: string }]> = [
            ['#/help/worker#security', { slug: 'worker', section: 'security' }],
            ['#/help/worker/security', { slug: 'worker', section: 'security' }],
            ['#/help/WORKER', { slug: 'worker', section: '' }],
            ['#/help', { slug: '', section: '' }],
            ['#/help/%3Cscript%3E', { slug: '', section: '' }],
            ['#/help/worker#a"b', { slug: 'worker', section: '' }],
            ['#/help/worker#%E0%A4%A', { slug: '', section: '' }],
            ['#/studio?tab=settings', { slug: '', section: '' }],
        ];
        for (const [hash, want] of cases) assert.deepEqual({ ...s.Help.parseRoute(hash) }, want, hash);
    });

    it('opens the right article and lands on the anchored section', async () => {
        const s = load('en', '#/help/worker#security');
        const section = s.host('help-s-security');
        await s.Help.render();
        const markup = s.dom.get('page-container')!.innerHTML;
        assert.match(markup, /data-view="article"/);
        assert.match(markup, /<h2 class="help-article-title" id="help-article-title" tabindex="-1">What is the worker\?<\/h2>/);
        assert.ok(markup.includes('id="help-s-security"'));
        assert.equal(s.Help.lastTarget, 'help-s-security');
        assert.equal(section.scrolled, 1, 'the section was scrolled into view');
        // A shareable link on every section heading.
        assert.ok(markup.includes('class="help-anchor" href="#/help/worker#security"'));
    });

    it('moves to another article in place, and puts focus on the new section', async () => {
        const s = load('ar', '#/help/worker');
        await s.Help.render();
        const before = s.dom.get('page-container')!.innerHTML;
        s.host('help-layout');
        const list = s.host('help-list');
        const main = s.host('help-main');
        const heading = s.host('help-h-bio');
        s.ctx.location.hash = '#/help/tiktok#bio';
        s.Help.onHashChange();
        assert.equal(s.dom.get('page-container')!.innerHTML, before, 'the page was not rebuilt');
        assert.ok(main.innerHTML.includes('id="help-s-bio"'));
        assert.ok(list.innerHTML.includes('href="#/help/tiktok" aria-current="page"'));
        assert.equal(s.Help.lastTarget, 'help-s-bio');
        assert.equal(heading.focused, 1);
    });

    it('owns scrolling while open, so Back lands on the section, and hands it back on leaving', async () => {
        // The browser restored the previous entry's scroll position AFTER the page had
        // scrolled to the section, so Back to #/help/worker#sleep showed the top of the page.
        const s = load('en', '#/help/worker#sleep');
        s.ctx.history.scrollRestoration = 'auto';
        await s.Help.render();
        assert.equal(s.ctx.history.scrollRestoration, 'manual');
        s.run<void>('HelpPage.destroy()');
        assert.equal(s.ctx.history.scrollRestoration, 'auto');
    });

    it('an unknown article shows every article and says so; an unknown section opens the top', async () => {
        const s = load('en', '#/help/no-such-article');
        await s.Help.render();
        const markup = s.dom.get('page-container')!.innerHTML;
        assert.match(markup, /data-view="index"/);
        assert.ok(markup.includes(s.t('help.notFound')));

        const t2 = load('en', '#/help/worker#no-such-section');
        await t2.Help.render();
        assert.equal(t2.Help.lastTarget, 'help-article-title');
        assert.deepEqual(t2.scrolls, [0]);
    });
});

describe('Help Center — every article in both languages', () => {
    it('has the twenty-four articles the Help Center promises, each slug once', () => {
        const s = load();
        const slugs = Array.from(s.content.articles, (a) => String(a.slug));
        assert.deepEqual(slugs, REQUIRED);
        assert.equal(new Set(slugs).size, slugs.length);
        for (const slug of slugs) assert.match(slug, /^[a-z0-9-]+$/);
    });

    it('gives every title, summary, section title and body in Arabic and in English', () => {
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            for (const a of s.content.articles) {
                for (const field of ['title', 'summary']) {
                    const value = String(a[field]?.[lang] || '');
                    assert.ok(value.trim(), `${a.slug}.${field}.${lang}`);
                }
                const ids = new Set<string>();
                for (const sec of a.sections) {
                    assert.match(sec.id, /^[a-z0-9-]+$/, `${a.slug}: section id`);
                    assert.equal(ids.has(sec.id), false, `${a.slug}#${sec.id} is unique`);
                    ids.add(sec.id);
                    assert.ok(String(sec.title?.[lang] || '').trim(), `${a.slug}#${sec.id} title.${lang}`);
                    const body = sec.body?.[lang];
                    assert.ok(Array.isArray(body) && body.length > 0, `${a.slug}#${sec.id} body.${lang}`);
                    const text = `${sec.title[lang]} ${s.Help.blockText(body)}`;
                    const arabic = count(text, ARABIC);
                    const latin = count(text, LATIN);
                    if (lang === 'ar') {
                        assert.ok(arabic > latin, `${a.slug}#${sec.id} reads as Arabic (${arabic} vs ${latin})`);
                    } else {
                        assert.ok(latin > arabic * 3, `${a.slug}#${sec.id} reads as English (${latin} vs ${arabic})`);
                    }
                }
                assert.ok(ids.size >= 1, `${a.slug} has sections`);
            }
        }
    });

    it('keeps every command identical in both languages', () => {
        const s = load();
        const codes = (blocks: unknown[]): string[] => Array.from(blocks)
            .filter((b): b is { code: string } => !!b && typeof b === 'object' && typeof (b as Json).code === 'string')
            .map((b) => b.code);
        for (const a of s.content.articles) {
            for (const sec of a.sections) {
                assert.deepEqual(codes(sec.body.ar), codes(sec.body.en), `${a.slug}#${sec.id}`);
            }
        }
    });

    it('resolves every [[link]] in the content to an article and section that exist', () => {
        const s = load();
        // Comments out first: the header documents the syntax with example links.
        const source = readFileSync('dashboard/js/help-content.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        const bySlug = new Map(s.content.articles.map((a) => [a.slug, a]));
        const links = [...source.matchAll(/\[\[([a-z0-9-]+)(?:#([a-z0-9-]+))?(?:\|[^\]]+)?\]\]/g)];
        assert.ok(links.length > 20, `found ${links.length} links`);
        for (const [, slug, section] of links) {
            const target = bySlug.get(slug!);
            assert.ok(target, `[[${slug}]] names an article`);
            if (section) assert.ok(target.sections.some((x: Json) => x.id === section), `[[${slug}#${section}]] names a section`);
        }
        for (const a of s.content.articles) {
            for (const r of a.related || []) assert.ok(bySlug.has(r), `${a.slug} → related ${r}`);
        }
        for (const p of s.content.popular) assert.ok(bySlug.has(p), `popular ${p}`);
        for (const a of s.content.articles) {
            assert.ok(s.content.groups.some((g) => g.id === a.group), `${a.slug} is in a known group`);
        }
    });

    it('renders every article in both languages with no markup left showing', () => {
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            for (const a of s.content.articles) {
                const markup = s.Help.articleMarkup(a).toString();
                const visible = textOf(markup);
                for (const leftover of ['**', '[[', ']]', '`']) {
                    assert.equal(visible.includes(leftover), false, `${lang}:${a.slug} shows ${leftover}`);
                }
                for (const sec of a.sections) assert.ok(markup.includes(`id="help-s-${sec.id}"`), `${lang}:${a.slug}#${sec.id}`);
                // The "was this helpful?" control was removed on 2026-09-27: it recorded
                // nothing and promised improvement (DESIGN.md §6).
                assert.equal(markup.includes('help:feedback'), false, `${lang}:${a.slug} still asks "was this helpful?"`);
            }
        }
    });

    it('renders every block of every article: a block kind the reader does not know would vanish from the page without a sound', () => {
        // `{ h: … }` did exactly that: 34 sub-headings in the Ads article were written, shipped, and never shown, because blockMarkup
        // fell through to '' for a kind it had no branch for. Nothing else noticed: the section still rendered, just without them.
        let blocks = 0;
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            for (const a of s.content.articles) {
                for (const sec of a.sections) {
                    for (const block of sec.body[lang] as unknown[]) {
                        blocks++;
                        assert.ok(String(s.Help.blockMarkup(block)).trim() !== '', `${lang}:${a.slug}#${sec.id} draws ${JSON.stringify(block).slice(0, 70)}`);
                    }
                }
            }
        }
        assert.ok(blocks > 1000, `${blocks} blocks were looked at`);
    });

    it('shows a sub-heading inside a section as a heading under the section’s own, in its place, in both languages', () => {
        const unescape = (v: string): string => v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
        for (const lang of ['ar', 'en'] as const) {
            const s = load(lang);
            let seen = 0;
            let written = 0;
            for (const a of s.content.articles) {
                for (const sec of a.sections) {
                    const body = sec.body[lang] as Json[];
                    // Spread into this realm's array: the content comes from the page's `vm`, and a deep equal compares prototypes.
                    const heads = [...body.filter((b) => b && typeof b === 'object' && typeof b.h === 'string').map((b) => b.h as string)];
                    written += heads.length;
                    const markup = String(s.Help.sectionMarkup(a, sec));
                    const drawn = [...markup.matchAll(/<h4 class="help-subhead">(.*?)<\/h4>/g)].map((m) => unescape(m[1]!));
                    assert.deepEqual(drawn, heads, `${lang}:${a.slug}#${sec.id} draws its sub-headings, in the order they were written`);
                    seen += drawn.length;
                    // Under the section's own <h3> and after it, never above.
                    if (heads.length) assert.ok(markup.indexOf('<h3 class="help-section-title"') < markup.indexOf('<h4 class="help-subhead">'), `${lang}:${a.slug}#${sec.id}`);
                }
            }
            // A scan that finds nothing would pass: the Ads article really does carry these.
            assert.ok(written >= 10, `${lang}: ${written} sub-headings are written`);
            assert.equal(seen, written, `${lang}: and every one of them is drawn`);
        }
    });

    it('escapes a sub-heading exactly as it escapes a paragraph: the same text gives the same inner markup, and none of it can inject', () => {
        const s = load('en');
        const hostile = '<img src=x onerror=alert(1)> **bold** `code` [[faq]] a & b';
        const inner = (markup: string, tag: string): string => markup.trim().replace(new RegExp(`^<${tag}[^>]*>`), '').replace(new RegExp(`</${tag}>$`), '');
        const heading = String(s.Help.blockMarkup({ h: hostile }));
        const paragraph = String(s.Help.blockMarkup(hostile));
        assert.match(heading.trim(), /^<h4 class="help-subhead">[\s\S]*<\/h4>$/);
        assert.equal(inner(heading, 'h4'), inner(paragraph, 'p'));
        assert.equal(heading.includes('<img'), false, 'no tag survives');
        assert.ok(heading.includes('&lt;img src=x onerror=alert(1)&gt;') && heading.includes('a &amp; b'));
        assert.ok(heading.includes('<strong>bold</strong>') && heading.includes('<code dir="ltr">code</code>'), 'it takes the same inline markup as the text under it');
        assert.ok(heading.includes('<a class="help-inline-link" href="#/help/faq">'), 'including a link to an article that exists');
    });

    it('searches what the page shows: a word only a sub-heading has finds its section', () => {
        // "Once unlocked" and «للقائمة» (in «ما يحدث للقائمة») are said nowhere else in the Ads article: before the heading was in the index, no search could land on it.
        for (const [lang, word] of [['en', 'unlocked'], ['ar', 'للقائمة']] as const) {
            const s = load(lang);
            const hit = Array.from(s.Help.search(word)).find((r) => r.slug === 'ads');
            assert.ok(hit, `${lang}: «${word}» finds the Ads article`);
            assert.equal(hit.section, 'customer-lists', `${lang}: and the section the heading is in`);
        }
        const s = load('en');
        assert.equal(s.Help.blockText({ h: 'A **bold** `code` heading' }), 'A bold code heading', 'plain text, without the inline markup');
    });

    it('writes no HTML into the content: everything is escaped, so markup would show as text', () => {
        const s = load();
        const strings: string[] = [];
        const walk = (v: unknown): void => {
            if (typeof v === 'string') strings.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(s.content);
        const offenders = strings.filter((x) => /<\/?[a-z][^>]*>/i.test(x));
        assert.deepEqual(offenders, []);
    });

    it('has every interface string it uses in both dictionaries', () => {
        const s = load();
        const source = readFileSync('dashboard/js/pages/help.js', 'utf8');
        const keys = new Set<string>(['nav.help', 'page.help.subtitle']);
        for (const m of source.matchAll(/t\('(help\.[a-zA-Z0-9_.]+)'/g)) keys.add(m[1]!);
        ['tip', 'note', 'warn'].forEach((k) => keys.add(`help.callout.${k}`));
        const missing: string[] = [];
        for (const key of keys) {
            for (const lang of ['ar', 'en']) {
                const dict = s.I18N.strings[lang]!;
                const found = dict[key] !== undefined || dict[`${key}_other`] !== undefined;
                if (!found) missing.push(`${lang}:${key}`);
            }
        }
        assert.deepEqual(missing, []);
    });

    it('has no "was this helpful?" control: it recorded nothing (removed 2026-09-27)', () => {
        const source = readFileSync('dashboard/js/pages/help.js', 'utf8');
        assert.equal(/help:feedback|feedbackMarkup|setFeedback/.test(source), false);
        const s = load();
        for (const lang of ['ar', 'en']) {
            const dict = s.I18N.strings[lang]!;
            assert.deepEqual(Object.keys(dict).filter((k) => k.startsWith('help.feedback.')), [], `${lang} still carries help.feedback keys`);
        }
    });
});

describe('Help Center — contextual links', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
    });
    const sources = files('dashboard/js').filter((f) => !f.endsWith('help-content.js'));
    const targets = (): Array<{ file: string; slug: string; section: string }> => sources.flatMap((file) => {
        const src = readFileSync(file, 'utf8');
        return [...src.matchAll(/UI\.helpLink\(\s*'([a-z0-9-]+)(?:#([a-z0-9-]+))?'/g)]
            .map((m) => ({ file, slug: m[1]!, section: m[2] || '' }));
    });

    it('points every UI.helpLink at an article, and a section, that exist', () => {
        const s = load();
        const found = targets();
        assert.ok(found.length >= 7, `found ${found.length}`);
        for (const { file, slug, section } of found) {
            const article = s.content.articles.find((a) => a.slug === slug);
            assert.ok(article, `${file}: ${slug} is an article`);
            if (section) assert.ok(article.sections.some((x: Json) => x.id === section), `${file}: ${slug}#${section} is a section`);
        }
        // No hand-built #/help/… link outside the Help Center that the scan above would miss.
        for (const file of sources.filter((f) => !f.endsWith('pages/help.js'))) {
            assert.equal(/href="#\/help\//.test(readFileSync(file, 'utf8')), false, `${file} links with UI.helpLink`);
        }
    });

    it('puts a link in each of the seven places that promised one', () => {
        const found = targets().map((x) => `${x.file.replace(/^.*\/js\//, '')} → ${x.slug}${x.section ? `#${x.section}` : ''}`);
        for (const want of [
            'pages/studio.js → worker',
            'pages/studio.js → library',
            'pages/studio.js → create#options',
            'pages/studio.js → studio-settings',
            'pages/settings.js → tiktok',
            'pages/posts.js → scheduling#carousels',
            'pages/campaigns.js → campaigns#matching',
        ]) {
            assert.ok(found.includes(want), `${want} (found: ${found.join(', ')})`);
        }
    });

    it('puts a link in each place the newer articles were written for', () => {
        const found = targets().map((x) => `${x.file.replace(/^.*\/js\//, '')} → ${x.slug}${x.section ? `#${x.section}` : ''}`);
        for (const want of [
            'pages/monteur.js → monteur',
            'pages/infographics.js → infographics',
            'pages/settings.js → youtube',
            'pages/ai_settings.js → dm-assistant',
            'pages/ai_settings.js → ai-usage',
            'pages/ice_breakers.js → dm-assistant#ice-breakers',
            'pages/whatsapp_card.js → whatsapp',
            'pages/meta_connect.js → connect-meta',
            'pages/overview.js → getting-started',
            'pages/ai_providers.js → ai-usage',
            'pages/invite_card.js → onboarding#invite',
            'pages/welcome.js → onboarding#after',
        ]) {
            assert.ok(found.includes(want), `${want} (found: ${found.join(', ')})`);
        }
    });

    it('keeps Help out of the public invite page and the setup steps: a setup that is not finished is sent back to the wizard from #/help', () => {
        // The invite page renders before there is a session (`#invite-screen`, a sibling of the login screen), so an article could not open from it.
        assert.equal(/UI\.helpLink\(/.test(readFileSync('dashboard/js/pages/invite.js', 'utf8')), false, 'the invite page links nowhere in Help');
        // `App.navigate` sends an owner whose setup is not completed to the wizard for EVERY page, Help included, so a link on an early step is dead.
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /if \(this\.mustOnboard\(\)\) \{\s*await this\.showWelcome\(\);\s*return;\s*\}/, 'the navigate gate');
        const welcome = readFileSync('dashboard/js/pages/welcome.js', 'utf8');
        assert.deepEqual([...welcome.matchAll(/UI\.helpLink\(\s*'([^']+)'/g)].map((m) => m[1]), ['onboarding#after'], 'the wizard links to Help once, from its last screen');
        // That screen paints its list only after `enterDone` has completed the setup (while it does, the card says it is finishing).
        const done = welcome.slice(welcome.indexOf('doneFields(state) {'), welcome.indexOf('// ─── The seam'));
        assert.ok(done.includes("UI.helpLink('onboarding#after'"), 'and it is inside the last screen');
        assert.match(welcome, /const finished = await API\.completeOnboarding\(\);[\s\S]*?onb\.status = 'completed';[\s\S]*?this\.state\.finishing = false;/, 'which is shown after completing');
    });

    it('renders them where they belong: the worker pill, the library, More options, TikTok, the composer, campaigns', () => {
        const s = load('ar', '#/studio', [
            'dashboard/js/pages/studio.js',
            'dashboard/js/pages/settings.js',
            'dashboard/js/pages/campaigns.js',
            'dashboard/js/pages/posts.js',
        ]);
        const pages = s.run<Json>('({ StudioPage, SettingsPage, CampaignsPage, PostsPage })');
        const pill = pages.StudioPage.workerMarkup({ online: false, lastSeen: null }, {}).toString();
        assert.match(pill, /id="studio-worker-pill"[\s\S]*?<a class="help-link help-link--icon studio-worker-help" href="#\/help\/worker" aria-label="ما هو العامل؟"/);
        const library = pages.StudioPage.libraryMarkup({ total: 3, indexed: 1 }).toString();
        assert.ok(library.includes('href="#/help/library"'));
        const more = pages.StudioPage.moreOptionsMarkup('lesson', pages.StudioPage.prefs()).toString();
        assert.match(more, /href="#\/help\/create#options" target="_blank" rel="noopener"/);
        const tiktok = pages.SettingsPage.tiktokSection({ tiktok: { appConfigured: false }, tiktokError: null, tiktokApp: null, tiktokAppError: null }).toString();
        assert.ok(tiktok.includes('href="#/help/tiktok"'));
        const inspector = pages.CampaignsPage.renderMatchInspector('', null).toString();
        assert.ok(inspector.includes('href="#/help/campaigns#matching"'));
        pages.PostsPage.resetSlides(null);
        const picker = pages.PostsPage.slidePicker('main').toString();
        assert.ok(picker.includes('href="#/help/scheduling#carousels"'));
        assert.equal(pages.PostsPage.slidePicker('tiktok').toString().includes('#/help/'), false);
    });

    it('UI.helpLink builds a safe link, and nothing at all for a target it cannot trust', () => {
        const s = load('en');
        const plain = s.UI.helpLink('worker#security', 'What is the worker?').toString();
        assert.match(plain, /^<a class="help-link" href="#\/help\/worker#security"><i data-lucide="circle-help" aria-hidden="true"><\/i><span>What is the worker\?<\/span><\/a>$/);
        const tab = s.UI.helpLink('faq', '', { newTab: true }).toString();
        assert.ok(tab.includes('target="_blank" rel="noopener"'));
        assert.ok(tab.includes(`<span>${s.t('help.link.learnMore')}</span>`));
        assert.ok(tab.includes(`<span class="sr-only"> ${s.t('help.link.newTab')}</span>`));
        const icon = s.UI.helpLink('worker', 'What is the worker?', { iconOnly: true }).toString();
        assert.ok(icon.includes('aria-label="What is the worker?"'));
        assert.equal(icon.includes('<span>'), false);
        for (const bad of ['', 'Worker', 'worker#', '../x', 'x"><script>alert(1)</script>', 'javascript:alert(1)']) {
            assert.equal(String(s.UI.helpLink(bad, 'x')), '', bad);
        }
    });
});
