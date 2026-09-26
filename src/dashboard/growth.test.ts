/**
 * The Growth & SEO hub (#/growth, GROWTH.md §5) and the composer's Instagram reach fields (§4).
 *
 * Loaded the same way as screens.test.ts and help.test.ts: the REAL dashboard files in a
 * `node:vm` context with a fake DOM, so these test what ships. The claims pinned here are the
 * ones a screenshot cannot check:
 *
 *   - every state renders something true: full data, a missing permission (the banner names the
 *     exact scopes), nothing synced yet, an account under 100 followers, a viewer, a failed read;
 *   - "not measured" is never drawn as 0, and sorts last in both directions;
 *   - best times land on the tenant's local weekday and hour, including across midnight and the
 *     week's edge, and a half-hour zone maps every hour to exactly one cell;
 *   - the coach's actions are ordered by the impact/effort chips they show;
 *   - the keywords and composer payloads are exactly what the API contract names.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = any;
type Translate = (key: string, params?: Record<string, unknown>) => string;

interface FakeEl {
    id: string;
    value: string;
    checked: boolean;
    disabled: boolean;
    innerHTML: string;
    textContent: string;
    dataset: Record<string, string>;
    classList: { toggle(n: string, on?: boolean): void; add(n: string): void; remove(n: string): void; contains(n: string): boolean };
    setAttribute(n: string, v: string): void;
    removeAttribute(n: string): void;
    getAttribute(n: string): string | null;
    focus(): void;
    closest(): null;
    contains(): boolean;
    querySelector(): null;
    querySelectorAll(): never[];
}

function fakeEl(id: string, props: Record<string, unknown> = {}): FakeEl {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el: FakeEl = {
        id, value: '', checked: false, disabled: false, innerHTML: '', textContent: '', dataset: {},
        classList: {
            toggle: (n, on) => { if (on === undefined ? !classes.has(n) : on) classes.add(n); else classes.delete(n); },
            add: (n) => { classes.add(n); },
            remove: (n) => { classes.delete(n); },
            contains: (n) => classes.has(n),
        },
        setAttribute: (n, v) => { attrs.set(n, String(v)); },
        removeAttribute: (n) => { attrs.delete(n); },
        getAttribute: (n) => (attrs.has(n) ? (attrs.get(n) as string) : null),
        focus: () => {},
        closest: () => null,
        contains: () => false,
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    return Object.assign(el, props);
}

function unref<T>(handle: T): T {
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
}

interface FakeStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    keys(): string[];
}

function fakeStorage(): FakeStorage {
    const map = new Map<string, string>();
    return {
        getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
        setItem: (k, v) => { map.set(k, String(v)); },
        removeItem: (k) => { map.delete(k); },
        keys: () => [...map.keys()],
    };
}

/** `new FormData(form)` for a fake form: the fields a real one would have read. */
class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields?: Record<string, unknown> } | null) {
        this.fields = (form && form.fields) || {};
    }
    get(name: string): unknown {
        return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null;
    }
}

interface Loaded {
    Page: Json;
    UI: Json;
    Charts: Json;
    I18N: Json;
    t: Translate;
    dom: Map<string, FakeEl>;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    toasts: Array<{ message: string; type?: string }>;
    confirms: Json[];
    copied: string[];
    hash: Record<string, string>;
    storage: FakeStorage;
    app: Json;
    host(id: string, props?: Record<string, unknown>): FakeEl;
    run<T>(code: string): T;
}

/**
 * The shared dashboard files plus one page, in `lang`. `page` is the global the page defines.
 * `app` overrides the stubbed App — its role checks and session, mostly.
 */
function load(files: string[], page: string, lang: 'ar' | 'en' = 'ar', app: Json = {}): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const confirms: Json[] = [];
    const copied: string[] = [];
    const hash: Record<string, string> = {};
    const storage = fakeStorage();
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
    const appStub: Json = {
        currentTheme: () => 'auto', navigate: noop, currentPage: 'growth',
        session: { tenantId: 't1' },
        hashParam: (name: string) => hash[name] || '',
        canOperate: () => true, canAdminister: () => true,
        go: noop, goWithQuery: noop,
        ...app,
    };
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
            location: { hash: '' },
        },
        Intl, console, clearTimeout, clearInterval,
        // The charts read colours from the tokens; the builders' fallbacks stand in here.
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => unref(setTimeout(fn, ms)),
        setInterval: (fn: () => void, ms?: number) => unref(setInterval(fn, ms)),
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang, clipboard: { writeText: (text: string) => { copied.push(text); return Promise.resolve(); } } },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: (_icon: string, title: string, body: string) => `<div class="empty-state">${title} ${body || ''}</div>`, confirm: (o: Json) => { confirms.push(o); } },
        App: appStub,
        FormData: FakeFormData,
        localStorage: storage,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/motion.js', 'dashboard/js/charts.js', ...files]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
    run(`I18N.lang = ${JSON.stringify(lang)};`);
    const got = run<Json>(`({ Page: ${page}, UI, Charts, I18N, t })`);
    const toasts: Array<{ message: string; type?: string }> = [];
    got.UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    const host = (id: string, props: Record<string, unknown> = {}): FakeEl => {
        const el = fakeEl(id, props);
        dom.set(id, el);
        return el;
    };
    host('page-container');
    return { ...got, dom, api, calls, toasts, confirms, copied, hash, storage, app: appStub, host, run };
}

const loadGrowth = (lang: 'ar' | 'en' = 'ar', app: Json = {}): Loaded => load(['dashboard/js/pages/growth.js'], 'GrowthPage', lang, app);

/** Let promise chains run out. */
async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A promise this test resolves by hand, for anything that must be seen in flight. */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const minutesAgo = (n: number): string => new Date(NOW - n * 60 * 1000).toISOString();

// ─── Fixtures: the shapes GROWTH.md §3 names ───────────────────────────────────────────────
const TYPES = ['REELS', 'CAROUSEL_ALBUM', 'IMAGE'];

/** 30 posts with every metric: reels do best on views, carousels on saves, one FB video in 3. */
function fullPosts(): Json[] {
    return Array.from({ length: 30 }, (_, i) => {
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
                avg_watch_time_ms: type === 'REELS' ? 3000 + i * 10 : null,
            },
            engagement_rate: Math.round(((likes + (i % 4) + 4) / reach) * 10000) / 10000,
        };
    });
}

function trendDays(n: number, followers: boolean): Json[] {
    return Array.from({ length: n }, (_, i) => ({
        day: new Date(NOW - (n - 1 - i) * DAY).toISOString().slice(0, 10),
        reach: 500 + i * 10, views: 800 + i * 20, followers: followers ? 1200 + i : null,
    }));
}

const fullStatus = (): Json => ({ instagram: 'ok', facebook: 'ok', tiktok: 'unavailable', missing: [], lastSync: minutesAgo(90) });

const fullOverview = (): Json => ({
    kpis: { followers: 1240, followers_delta: 32, reach: 33243, views: 59455, engagement_rate: 0.053, saves: 205, shares: 149, profile_visits: 400 },
    trend: trendDays(28, true),
    best_times: null,
    top_posts: [],
    by_type: [
        { type: 'REELS', posts: 10, avg_views: 128, avg_engagement: 0.019 },
        { type: 'CAROUSEL_ALBUM', posts: 10, avg_views: 39, avg_engagement: 0.123 },
    ],
    audience_split: { reach: { followers: 17, non_followers: 1704 }, views: { followers: 144, non_followers: 2202 } },
});

const fullSettings = (): Json => ({
    keywords: ['ذكاء اصطناعي', 'برومبت'],
    hashtag_sets: [{ name: 'الذكاء الاصطناعي', tags: ['الذكاء_الاصطناعي', 'برومبت', 'AI'] }],
    competitors: ['ai.arabic'],
    audience: { countries: ['SA'], languages: ['ar'], timezone: 'Asia/Riyadh' },
});

function stubGrowth(s: Loaded, over: { status?: Json; overview?: Json; posts?: Json[]; settings?: Json } = {}): void {
    s.api.getGrowthStatus = () => Promise.resolve(over.status ?? fullStatus());
    s.api.getGrowthOverview = () => Promise.resolve(over.overview ?? fullOverview());
    s.api.getGrowthPosts = () => Promise.resolve({ posts: over.posts ?? fullPosts() });
    s.api.getGrowthSettings = () => Promise.resolve({ settings: over.settings ?? fullSettings() });
    s.api.getGrowthCompetitors = () => Promise.resolve([]);
}

async function renderPage(s: Loaded): Promise<string> {
    await s.Page.render();
    await settle();
    const markup = s.dom.get('page-container')!.innerHTML;
    s.Page.destroy();
    return markup;
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

/** A string as `esc()` writes it into markup, so copy with "&" or quotes can be looked for. */
const escaped = (text: string): string => text.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('GrowthPage — every state renders something true', () => {
    it('full data: eight KPI cards, the trend line, who sees you, best times, by type and the posts', async () => {
        const s = loadGrowth('en');
        stubGrowth(s);
        const page = await renderPage(s);

        assert.equal(count(page, 'class="stat-card surface growth-kpi'), 8, 'followers, reach, views, ER, saves, shares, watch time, skip rate');
        assert.ok(page.includes('1,240'), 'followers');
        assert.ok(page.includes('<bdi class="ltr-text" dir="ltr">+32</bdi>'), 'the delta keeps its sign, isolated');
        assert.ok(page.includes('5.3%'), 'a ratio of 0.053 reads as 5.3%');
        assert.ok(page.includes('class="chart-line-path"'), 'a real line');
        assert.ok(page.includes(`aria-label="${s.t('growth.trend.label', { metric: 'Views', days: '28 days' })}"`));
        assert.ok(page.includes('id="growth-audience"'));
        assert.ok(page.includes(s.t('growth.audience.mostlyNew', { pct: 99 })), '1,704 of 1,721 is 99% new people');
        assert.ok(page.includes(s.t('growth.audience.leverNew')));
        assert.ok(page.includes('id="growth-heat"'));
        assert.equal(count(page, '<th scope="row">'), 7, 'a row per weekday');
        assert.ok(page.includes(s.t('growth.types.verdict', { best: 'Reel', worst: 'Carousel', ratio: '3.3' })), '128 vs 39');
        assert.equal(count(page, 'class="log-card growth-post-card"'), 25, 'the first page of 30');
        assert.ok(page.includes(s.t('growth.posts.more', { n: '5', total: '30' })));
        assert.ok(page.includes(s.t('growth.posts.viewsBy')), 'two platforms measured: the split is shown');
        assert.equal(page.includes('growth-permission-banner'), false, 'nothing missing, no banner');
        assert.ok(page.includes('data-action="growth:generateCoach"'), 'the coach is offered');
        assert.ok(page.includes('class="btn btn-primary"'), 'with the one primary button on the page');
        assert.equal(count(page, 'btn-primary'), 1);
    });

    it('permission missing: a one-screen fix naming both scopes, the Help link, and dashes that say why', async () => {
        const s = loadGrowth('en');
        const likesOnly = fullPosts().slice(0, 6).map((p) => ({
            ...p, platform: 'instagram',
            metrics: { views: null, reach: null, likes: 2, comments: 0, saved: null, shares: null, avg_watch_time_ms: null },
            engagement_rate: null,
        }));
        stubGrowth(s, {
            status: { instagram: 'missing_permission', facebook: 'missing_permission', tiktok: 'unavailable', missing: ['instagram_manage_insights', 'read_insights'], lastSync: minutesAgo(300) },
            overview: { kpis: { followers: 36, followers_delta: null, reach: null, views: null, engagement_rate: null, saves: null, shares: null }, trend: [], best_times: null, by_type: [{ type: 'IMAGE', posts: 6, avg_views: null, avg_engagement: null }] },
            posts: likesOnly,
        });
        const page = await renderPage(s);

        assert.ok(page.includes('id="growth-permission-banner"'));
        assert.ok(page.includes('<code dir="ltr">instagram_manage_insights</code>'));
        assert.ok(page.includes('<code dir="ltr">read_insights</code>'));
        assert.ok(page.includes(s.t('growth.scope.igInsights')));
        assert.ok(page.includes('href="#/help/growth#permissions"'), 'the Help article');
        assert.ok(page.includes('href="#/settings"'), 'an owner is sent to the token');
        for (const step of ['step1', 'step2', 'step3', 'step4']) assert.ok(page.includes(escaped(s.t(`growth.banner.${step}`))), step);
        assert.ok(page.includes(s.t('growth.kpi.locked')), 'a missing number says why');
        assert.equal(page.includes('class="chart-line-path"'), false, 'no line drawn from nothing');
        assert.ok(page.includes(s.t('growth.trend.locked')));
        assert.ok(page.includes(s.t('growth.coach.lockedNote')), 'the coach says what it cannot see');
        assert.ok(page.includes(s.t('growth.best.basisInteractions', { posts: s.t('growth.posts.count', { count: 6, n: '6' }) })),
            'best times fall back to likes and comments, and say so');
        assert.ok(page.includes(s.t('growth.banner.tiktok')));
        // Six posts × views, reach, saves, shares, watch time and skip rate: all unmeasured, all dashes. The
        // comments column is a real 0 and stays one: measured zero and "not measured" differ.
        assert.equal(count(page, '<td class="cell-num">—</td>'), 36, 'no unmeasured value is drawn as 0');
        assert.equal(count(page, '<span class="growth-er is-missing">—</span>'), 12, 'nor a rate, in the table or the cards');
    });

    it('permission missing, as an operator: the fix is the owner’s, so there is no Settings button', async () => {
        const s = loadGrowth('en', { canAdminister: () => false });
        stubGrowth(s, { status: { instagram: 'missing_permission', facebook: 'ok', missing: ['instagram_manage_insights'], lastSync: null } });
        const page = await renderPage(s);
        assert.ok(page.includes(s.t('growth.banner.fixLeadViewer')));
        assert.equal(page.includes('href="#/settings"'), false);
    });

    it('no data yet: every region says "not synced" and what to press, and nothing is drawn', async () => {
        const s = loadGrowth('en');
        stubGrowth(s, {
            status: { instagram: 'ok', facebook: 'ok', tiktok: 'not_connected', missing: [], lastSync: null },
            overview: { kpis: { followers: null, followers_delta: null, reach: null, views: null, engagement_rate: null, saves: null, shares: null }, trend: [], best_times: null, by_type: [] },
            posts: [],
            settings: { keywords: [], hashtag_sets: [], competitors: [], audience: {} },
        });
        const page = await renderPage(s);
        assert.ok(page.includes(s.t('growth.sync.never')));
        assert.ok(page.includes(s.t('growth.kpi.notSynced')));
        assert.ok(page.includes(s.t('growth.trend.notSynced')));
        assert.ok(page.includes(s.t('growth.posts.notSyncedTitle')));
        assert.ok(page.includes(s.t('growth.best.empty')));
        assert.ok(page.includes(s.t('growth.types.empty')));
        assert.equal(page.includes('id="growth-audience"'), false, 'no split without numbers');
        assert.equal(page.includes('growth-tiktok-note'), false, 'TikTok not connected: nothing to say');
        assert.equal(page.includes('class="chart-line'), false);
    });

    it('under 100 followers: a calm note where Instagram withholds the series, not an error', async () => {
        const s = loadGrowth('en');
        stubGrowth(s, { overview: { ...fullOverview(), kpis: { ...fullOverview().kpis, followers: 36, followers_delta: null }, trend: trendDays(28, false) } });
        await s.Page.render();
        await settle();
        const page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes(s.t('growth.small.delta')), 'the followers card');
        assert.ok(page.includes('class="chart-line-path"'), 'the trend is drawn from views, which exist');
        s.Page.trendMetric = 'followers';
        const trend = String(s.Page.trendMarkup());
        assert.ok(trend.includes(s.t('growth.small.series')));
        assert.equal(trend.includes('class="chart-line'), false, 'no empty axes');
        assert.equal(trend.includes('error'), false);
        s.Page.destroy();
    });

    it('a failed overview is one error panel; the posts beside it still render', async () => {
        const s = loadGrowth('en');
        stubGrowth(s);
        s.api.getGrowthOverview = () => Promise.reject(Object.assign(new Error('Gateway timeout'), { status: 504 }));
        const page = await renderPage(s);
        assert.ok(page.includes('data-error-host'));
        assert.ok(page.includes('data-error-retry="data"'));
        assert.ok(count(page, 'class="log-card growth-post-card"') > 0, 'posts are their own region');
    });

    it('loading: the skeleton is the page’s shape, and a range change re-skeletons only the data', async () => {
        const s = loadGrowth('en');
        assert.ok(String(s.Page.skeleton()).includes('role="status"'));
        stubGrowth(s);
        await s.Page.render();
        const summary = s.host('growth-summary');
        const later = deferred<Json>();
        s.api.getGrowthOverview = () => later.promise;
        s.Page.setDays({ dataset: { days: '7' } });
        assert.ok(summary.innerHTML.includes('skel'), 'shapes while the numbers load');
        assert.equal(s.calls.filter((c) => c.method === 'getGrowthOverview').pop()!.args[0], 7);
        later.resolve(fullOverview());
        await settle();
        assert.equal(summary.innerHTML.includes('skel'), false);
        assert.ok(summary.innerHTML.includes('growth-kpis'));
        assert.equal(JSON.parse(s.storage.getItem('growth:prefs') || '{}').days, 7, 'the range is remembered in this browser');
        s.Page.destroy();
    });

    it('a viewer gets one honest empty state and no requests at all', async () => {
        const s = loadGrowth('en', { canOperate: () => false });
        const page = await renderPage(s);
        assert.ok(page.includes(s.t('growth.viewer.title')));
        assert.equal(s.calls.length, 0);
    });

    it('SEO & reach is a second view of the same route, painted from what is loaded', async () => {
        const s = loadGrowth('en');
        stubGrowth(s);
        await s.Page.render();
        const before = s.calls.length;
        s.hash.tab = 'seo';
        s.Page.onHashChange();
        await settle();
        const page = s.dom.get('page-container')!.innerHTML;
        assert.ok(page.includes('id="growth-keywords"') && page.includes('id="growth-hashtags"') && page.includes('id="growth-competitors"'));
        assert.ok(/id="growth-tab-seo"[^>]*aria-current="page"/.test(page));
        assert.deepEqual(s.calls.slice(before).map((c) => c.method), ['getGrowthCompetitors'], 'only the competitors are fetched');
        s.Page.destroy();
    });
});

describe('GrowthPage — sorting and filtering the posts', () => {
    const p = (id: string, views: number | null, daysAgo: number, over: Json = {}): Json => ({
        id, platform: 'instagram', media_type: 'REELS', published_at: new Date(NOW - daysAgo * DAY).toISOString(),
        metrics: { views, reach: views === null ? null : views / 2 }, engagement_rate: null, ...over,
    });

    it('sorts by a column, with "not measured" last in BOTH directions and ties newest first', () => {
        const s = loadGrowth();
        const list = [p('a', 10, 3), p('b', null, 1), p('c', 30, 2), p('d', 10, 1)];
        const ids = (sorted: Json[]): string => sorted.map((x) => x.id).join(',');
        assert.equal(ids(s.Page.sortPosts(list, { key: 'views', dir: 'desc' })), 'c,d,a,b');
        assert.equal(ids(s.Page.sortPosts(list, { key: 'views', dir: 'asc' })), 'd,a,c,b', 'b has no views: last, not first');
        assert.equal(ids(s.Page.sortPosts(list, { key: 'published_at', dir: 'desc' })), 'b,d,c,a');
        assert.equal(ids(s.Page.sortPosts(list, { key: 'nonsense', dir: 'desc' })), 'c,d,a,b', 'an unknown key sorts by views');
        const watched = [p('w1', 1, 1, { metrics: { avg_watch_time_ms: 3200 } }), p('w2', 1, 1, { metrics: { ig_reels_avg_watch_time: 5100 } }), p('w3', 1, 1, { media_type: 'IMAGE' })];
        assert.equal(ids(s.Page.sortPosts(watched, { key: 'avg_watch', dir: 'desc' })), 'w2,w1,w3', 'either name of the watch-time metric');
    });

    it('filters by type and platform, and offers only the choices that exist', () => {
        const s = loadGrowth();
        const list = [p('r', 1, 1), p('c', 1, 1, { media_type: 'CAROUSEL_ALBUM' }), p('f', 1, 1, { platform: 'facebook', media_type: 'VIDEO' })];
        assert.deepEqual(plain(s.Page.filterPosts(list, { type: 'carousel', platform: 'all' })).map((x: Json) => x.id), ['c']);
        assert.deepEqual(plain(s.Page.filterPosts(list, { type: 'all', platform: 'facebook' })).map((x: Json) => x.id), ['f']);
        assert.deepEqual(plain(s.Page.filterPosts(list, { type: 'reel', platform: 'facebook' })), []);
        assert.deepEqual(plain(s.Page.presentKeys(list, 'type')), ['reel', 'carousel', 'video']);
        assert.deepEqual(plain(s.Page.presentKeys(list, 'platform')), ['instagram', 'facebook']);
        assert.equal(s.Page.typeKey('CAROUSEL_ALBUM'), 'carousel');
        assert.equal(s.Page.typeKey('something new'), 'other');
    });

    it('a header click sorts best-first, a second click flips it, and aria-sort says which', async () => {
        const s = loadGrowth('en');
        stubGrowth(s);
        await s.Page.render();
        const region = s.host('growth-posts');
        assert.deepEqual(plain(s.Page.sort), { key: 'views', dir: 'desc' });
        s.Page.sortBy('views');
        assert.deepEqual(plain(s.Page.sort), { key: 'views', dir: 'asc' });
        assert.ok(/aria-sort="ascending"[^>]*>\s*<button[^>]*id="growth-sort-views"/.test(region.innerHTML));
        s.Page.sortBy('reach');
        assert.deepEqual(plain(s.Page.sort), { key: 'reach', dir: 'desc' });
        assert.ok(/aria-sort="descending"[^>]*>\s*<button[^>]*id="growth-sort-reach"/.test(region.innerHTML));
        assert.ok(/aria-sort="none"[^>]*>\s*<button[^>]*id="growth-sort-views"/.test(region.innerHTML));

        s.Page.setFilter('type', 'carousel');
        const shown = s.Page.visiblePosts();
        assert.ok(shown.length > 0 && shown.every((x: Json) => x.media_type === 'CAROUSEL_ALBUM'));
        s.Page.setFilter('platform', 'facebook');
        assert.ok(region.innerHTML.includes(s.t('growth.posts.noMatchTitle')), 'no FB carousels: a way out, not a blank table');
        assert.ok(region.innerHTML.includes('data-action="growth:clearFilters"'));
        s.Page.clearFilters();
        assert.deepEqual(plain(s.Page.filter), { type: 'all', platform: 'all' });
        s.Page.destroy();
    });

    it('shows the coach’s "why it worked" note on the post it names, and on no other', () => {
        const s = loadGrowth('en');
        s.Page.coach = s.Page.normalizeCoach({
            summary: 'x',
            post_notes: [{ media_id: '1789', note: 'Opened on the result.' }, { media_id: '', note: 'no id' }, { note: 'no id either' }],
        });
        assert.equal(s.Page.coach.notes.length, 1, 'a note has to name a post');
        const post = { caption: 'c', platform: 'instagram', media_type: 'REELS' };
        const hit = String(s.Page.postIdentity({ ...post, media_id: '1789' }));
        const miss = String(s.Page.postIdentity({ ...post, media_id: '999' }));
        assert.ok(hit.includes('class="growth-post-note"') && hit.includes('Opened on the result.'));
        assert.equal(miss.includes('growth-post-note'), false);
        s.Page.coach = null;
        assert.equal(String(s.Page.postIdentity({ ...post, media_id: '1789' })).includes('growth-post-note'), false, 'no coach, no note');
    });

    it('draws the engagement bar from the reading start, and a missing rate as a dash with no bar', () => {
        const ar = loadGrowth('ar');
        const en = loadGrowth('en');
        const post = { engagement_rate: 0.02 };
        const rtl = String(ar.Page.erMarkup(post, 4));
        const ltr = String(en.Page.erMarkup(post, 4));
        assert.ok(rtl.includes('class="growth-bar-fill" x="50" y="0" width="50"'), '2% of a 4% best, filled from the right in Arabic');
        assert.ok(ltr.includes('class="growth-bar-fill" x="0" y="0" width="50"'));
        const none = String(en.Page.erMarkup({ engagement_rate: null }, 4));
        assert.equal(none.includes('growth-bar'), false);
        assert.ok(none.includes('—'));
        assert.equal(en.Page.formatRate(0.042), '4.2%', 'a ratio');
        assert.equal(en.Page.formatRate(1.2), '120%', 'a ratio above 1 on a tiny reach is still a ratio');
        assert.equal(en.Page.formatRate(null), '—');
        assert.equal(en.Page.formatSeconds(3240), '3.2s');
        assert.equal(ar.Page.formatSeconds(3240), '3.2 ث');
    });
});

describe('GrowthPage — building the best-times heat map', () => {
    const empty = (): Json[] => Array.from({ length: 7 }, () => Array(24).fill(null));
    const AT = Date.parse('2026-09-20T12:00:00Z');

    it('moves a UTC grid into Riyadh time, across midnight and across the end of the week', () => {
        const s = loadGrowth();
        const grid = empty();
        grid[0][22] = 5; // Sunday 22:00 UTC is Monday 01:00 in Riyadh
        grid[6][23] = 2; // Saturday 23:00 UTC is Sunday 02:00: the week wraps
        grid[3][9] = 1;  // Wednesday 09:00 UTC is Wednesday 12:00
        const map = s.Page.buildHeatmap(grid, { from: 'UTC', to: 'Asia/Riyadh', now: AT });
        assert.equal(map.cells[1][1], 5);
        assert.equal(map.cells[0][2], 2);
        assert.equal(map.cells[3][12], 1);
        assert.equal(map.cells[0][22], null, 'nothing left behind at the UTC position');
        assert.equal(map.max, 5);
        assert.deepEqual(plain(map.top), [{ day: 1, hour: 1, value: 5 }, { day: 0, hour: 2, value: 2 }, { day: 3, hour: 12, value: 1 }]);
        assert.equal(map.empty, false);
    });

    it('is the identity in the same zone, and empty when nothing was measured', () => {
        const s = loadGrowth();
        const grid = empty();
        grid[4][21] = 7;
        const same = s.Page.buildHeatmap(grid, { from: 'Asia/Riyadh', to: 'Asia/Riyadh', now: AT });
        assert.equal(same.cells[4][21], 7);
        assert.equal(s.Page.buildHeatmap(empty(), { now: AT }).empty, true);
        assert.equal(s.Page.buildHeatmap(null, { now: AT }).empty, true);
        assert.equal(s.Page.buildHeatmap([[0, 0], 'junk'], { now: AT }).empty, true, 'zeros and junk are not a pattern');
    });

    it('maps every hour to exactly one cell in a half-hour zone', () => {
        const s = loadGrowth();
        const ones = Array.from({ length: 7 }, () => Array(24).fill(1));
        const map = s.Page.buildHeatmap(ones, { from: 'UTC', to: 'Asia/Kolkata', now: AT });
        const flat = map.cells.flat();
        assert.equal(flat.length, 168);
        assert.ok(flat.every((v: Json) => v === 1), 'no hour doubled up, none lost');
    });

    it('builds the grid from our own posts, in the tenant’s time zone, by views where they exist', () => {
        const s = loadGrowth();
        const posts = [
            { published_at: '2026-09-20T18:00:00Z', metrics: { views: 100, likes: 1 } }, // Sunday 21:00 Riyadh
            { published_at: '2026-09-20T18:40:00Z', metrics: { views: 300, likes: 9 } }, // the same hour
            { published_at: '2026-09-22T10:05:00Z', metrics: { views: 50 } },            // Tuesday 13:00
            { published_at: 'not a date', metrics: { views: 999 } },
        ];
        const own = s.Page.postsHeatGrid(posts, 'Asia/Riyadh');
        assert.equal(own.basis, 'views');
        assert.equal(own.posts, 3);
        assert.equal(own.grid[0][21], 200, 'the average of the two posts in that hour');
        assert.equal(own.grid[2][13], 50);
        assert.equal(own.grid[0][18], null);
        const noViews = s.Page.postsHeatGrid([
            { published_at: '2026-09-20T18:00:00Z', metrics: { views: null, likes: 2, comments: 1 } },
        ], 'Asia/Riyadh');
        assert.equal(noViews.basis, 'interactions', 'insights locked: likes and comments still make a map');
        assert.equal(noViews.grid[0][21], 3);
    });

    it('renders hours in document order, so Arabic runs from the right, and labels local time', async () => {
        const s = loadGrowth('ar');
        stubGrowth(s);
        await s.Page.render();
        const best = String(s.Page.bestTimesMarkup());
        assert.equal(/<table class="growth-heat"[^>]*dir=/.test(best), false, 'no direction override: RTL comes from the page');
        assert.ok(best.indexOf('<span class="sr-only">00:00</span>') < best.indexOf('<span class="sr-only">23:00</span>'));
        assert.ok(best.includes(s.t('growth.best.zone', { zone: s.Page.zoneLabel('Asia/Riyadh') })), 'the tenant’s zone, named');
        assert.ok(best.includes('id="growth-best-basis"'), 'and "based on your posts"');
        assert.equal(s.Page.heatLevel(null, 10), 0);
        assert.equal(s.Page.heatLevel(2, 10), 1);
        assert.equal(s.Page.heatLevel(6, 10), 3);
        assert.equal(s.Page.heatLevel(10, 10), 4);
        s.Page.destroy();
    });

    it('falls back to the browser’s zone, and says so, when the tenant has none', () => {
        const s = loadGrowth('en');
        s.Page.settings = s.Page.normalizeSettings({ audience: { timezone: 'Not/AZone' } });
        const tz = s.Page.tenantZone();
        assert.equal(tz.own, false);
        s.Page.settings = s.Page.normalizeSettings({ audience: { timezone: 'Asia/Dubai' } });
        assert.deepEqual(plain(s.Page.tenantZone()), { zone: 'Asia/Dubai', own: true });
    });
});

describe('Charts.lineChart — the trend', () => {
    const days = (vals: Array<number | null>): Json[] => vals.map((value, i) => ({ day: `2026-09-${String(10 + i).padStart(2, '0')}`, value }));

    it('refuses to draw fewer than two measured days', () => {
        const s = loadGrowth('en');
        assert.ok(String(s.Charts.lineChart(days([5, null, null]), { emptyMessage: 'none' })).includes('class="chart-empty"'));
    });

    it('breaks the line at a gap instead of inventing a slope, and dots a lone day', () => {
        const s = loadGrowth('en');
        const svg = String(s.Charts.lineChart(days([1, null, 3, 4]), { label: 'Views' }));
        const d = (svg.match(/class="chart-line-path" d="([^"]+)"/) || [])[1] || '';
        assert.equal(count(d, 'M'), 1, 'one run of two or more days');
        assert.equal(count(svg, 'class="chart-line-dot"'), 2, 'the lone first day, and the latest');
        assert.ok(svg.includes('<td>—</td>'), 'the gap is in the screen-reader table as a dash');
    });

    it('runs toward the reading edge: oldest at the start, mirrored in Arabic', () => {
        const x0 = (lang: 'ar' | 'en'): number => {
            const s = loadGrowth(lang);
            const svg = String(s.Charts.lineChart(days([1, 2, 3, 4]), {}));
            return Number(((svg.match(/class="chart-line-path" d="M([\d.]+),/) || [])[1]));
        };
        assert.ok(x0('en') < 300, 'first day on the left in English');
        assert.ok(x0('ar') > 300, 'and on the right in Arabic');
    });

    it('starts the axis at zero and rounds its top', () => {
        const s = loadGrowth('en');
        assert.equal(s.Charts.niceCeil(37), 40);
        assert.equal(s.Charts.niceCeil(1234), 1500);
        assert.equal(s.Charts.niceCeil(3), 4);
        assert.equal(s.Charts.niceCeil(0), 10);
    });
});

describe('GrowthPage — the AI Growth Coach', () => {
    const answer = (): Json => ({
        summary: '٩٩٪ من الوصول أشخاص جدد.',
        wins: ['الريلز تحصل على ثلاثة أضعاف المشاهدات', '', '  '],
        problems: ['متوسط المشاهدة ٣ ثوانٍ'],
        actions: [
            { title: 'Low low', why: 'w', how: 'h', effort: 'low', impact: 'low' },
            { title: 'High high', why: 'w', how: 'h', effort: 'high', impact: 'high' },
            { title: 'High low', why: 'w', how: 'h', effort: 'low', impact: 'high' },
            { title: 'Medium', why: 'w', how: 'h', effort: 'low', impact: 'medium' },
            { why: 'no title and no how' },
        ],
        experiments: [{ hypothesis: 'نص على الشاشة يرفع المشاهدة', how: 'ريلان', measure: 'متوسط المشاهدة' }, {}],
    });

    it('normalises the answer: empties dropped, "medium" read as med, unknown levels as none', () => {
        const s = loadGrowth();
        const c = plain(s.Page.normalizeCoach(answer()));
        assert.deepEqual(c.wins, ['الريلز تحصل على ثلاثة أضعاف المشاهدات']);
        assert.equal(c.actions.length, 4);
        assert.equal(c.actions[3].impact, 'med');
        assert.equal(c.experiments.length, 1);
        assert.equal(s.Page.level('huge'), null);
        assert.deepEqual(plain(s.Page.normalizeCoach(null)), { summary: '', wins: [], problems: [], actions: [], experiments: [], notes: [] });
    });

    it('orders actions by the chips they show: impact first, then the least effort', () => {
        const s = loadGrowth();
        const order = plain(s.Page.prioritize(s.Page.normalizeCoach(answer()).actions)).map((a: Json) => a.title);
        assert.deepEqual(order, ['High low', 'High high', 'Medium', 'Low low']);
    });

    it('renders a plan: summary, wins, problems, numbered actions with chips, experiments, and the caveat', () => {
        const s = loadGrowth('en');
        s.Page.coach = s.Page.normalizeCoach(answer());
        s.Page.coachState = 'ready';
        s.Page.coachAt = new Date().toISOString();
        s.Page.days = 28;
        const m = String(s.Page.coachMarkup());
        assert.ok(m.includes('٩٩٪ من الوصول أشخاص جدد.'));
        assert.ok(m.includes('dir="auto"'), 'written in the tenant’s language, so its direction is its own');
        assert.ok(m.indexOf('High low') < m.indexOf('High high') && m.indexOf('High high') < m.indexOf('Low low'));
        assert.ok(m.includes(`${s.t('growth.coach.impact')}: ${s.t('growth.coach.level.high')}`));
        assert.ok(m.includes('<span class="chip chip-accent">'), 'high impact and low effort stand out');
        assert.ok(m.includes(s.t('growth.coach.hypothesis')) && m.includes(s.t('growth.coach.measure')));
        assert.ok(m.includes(s.t('growth.coach.disclaimer')));
        assert.ok(m.includes('href="#/help/growth#coach"'));
        assert.equal(m.includes('btn-primary'), false, 'regenerating is secondary');
    });

    it('shows the three stages while it writes, and a Try again after a failure', () => {
        const s = loadGrowth('en');
        s.Page.coachState = 'loading';
        s.Page.coachStartedAt = Date.now();
        s.Page.coachStage = 0;
        const loading = String(s.Page.coachMarkup());
        assert.ok(loading.includes('aria-busy="true"'));
        assert.equal(count(loading, 'class="studio-stage '), 3);
        assert.ok(loading.includes('studio-stage is-current') && loading.includes(s.t('growth.coach.stage.read')));
        assert.ok(loading.includes(s.t('growth.coach.leave')));
        s.Page.coachState = 'error';
        s.Page.coachError = new Error('Gemini is busy');
        const failed = String(s.Page.coachMarkup());
        assert.ok(failed.includes(s.t('growth.coach.failed', { message: 'Gemini is busy' })));
        assert.ok(failed.includes(s.t('growth.coach.retry')));
    });

    it('generates: one POST with the range, the stages on screen, then the plan, kept for this tenant only', async () => {
        const s = loadGrowth('en');
        s.Page.days = 28;
        const region = s.host('growth-coach');
        const reply = deferred<Json>();
        s.api.growthCoach = () => reply.promise;
        const run = s.Page.generateCoach();
        assert.equal(s.Page.coachState, 'loading');
        assert.ok(region.innerHTML.includes('id="growth-coach-stages"'));
        s.Page.generateCoach();
        assert.equal(s.calls.filter((c) => c.method === 'growthCoach').length, 1, 'a second click while it writes does nothing');
        assert.deepEqual(plain(s.calls[0]!.args[0]), { days: 28 });
        reply.resolve(answer());
        await run;
        assert.equal(s.Page.coachState, 'ready');
        assert.ok(region.innerHTML.includes('High low'));
        const saved = JSON.parse(s.storage.getItem('growth:coach:t1') || 'null');
        assert.equal(saved.days, 28);

        const other = loadGrowth('en', { session: { tenantId: 't2' } });
        other.storage.setItem('growth:coach:t1', JSON.stringify(saved));
        other.Page.restoreCoach();
        assert.equal(other.Page.coachState, 'idle', 'another tenant’s plan is not shown');
        other.app.session = { tenantId: 't1' };
        other.Page.restoreCoach();
        assert.equal(other.Page.coachState, 'ready');
    });

    it('a tenant switch mid-write retires the answer; an empty answer is a failure, not a blank plan', async () => {
        const s = loadGrowth('en');
        const reply = deferred<Json>();
        s.api.growthCoach = () => reply.promise;
        const run = s.Page.generateCoach();
        s.Page.resetTenantState();
        reply.resolve(answer());
        await run;
        assert.equal(s.Page.coachState, 'idle');
        assert.equal(s.storage.getItem('growth:coach:t1'), null);

        s.api.growthCoach = () => Promise.resolve({ summary: '', actions: [] });
        await s.Page.generateCoach();
        assert.equal(s.Page.coachState, 'error');
        assert.equal(s.Page.coachError.message, s.t('growth.coach.emptyAnswer'));
    });
});

describe('GrowthPage — the keywords payload', () => {
    /** The page with its settings loaded and the keywords region and its inputs present. */
    async function seo(lang: 'ar' | 'en' = 'en'): Promise<Loaded> {
        const s = loadGrowth(lang);
        stubGrowth(s);
        s.hash.tab = 'seo';
        await s.Page.render();
        s.host('growth-keywords');
        s.host('growth-hashtags');
        s.host('growth-competitors');
        return s;
    }
    const puts = (s: Loaded): Json[] => s.calls.filter((c) => c.method === 'saveGrowthSettings').map((c) => plain(c.args[0]));

    it('adding a keyword PUTs the whole settings with the keyword appended — nothing else changed', async () => {
        const s = await seo();
        s.api.saveGrowthSettings = (body: Json) => Promise.resolve({ settings: body });
        s.host('growth-keyword-input', { value: '  وكيل   ذكي ' });
        await s.Page.addKeyword(null, { preventDefault: () => {} });
        assert.deepEqual(puts(s), [{
            keywords: ['ذكاء اصطناعي', 'برومبت', 'وكيل ذكي'],
            hashtag_sets: [{ name: 'الذكاء الاصطناعي', tags: ['الذكاء_الاصطناعي', 'برومبت', 'AI'] }],
            competitors: ['ai.arabic'],
            audience: { countries: ['SA'], languages: ['ar'], timezone: 'Asia/Riyadh' },
        }]);
        assert.ok(s.dom.get('growth-keywords')!.innerHTML.includes('وكيل ذكي'), 'shown as a chip');
        s.Page.destroy();
    });

    it('refuses a duplicate the way the webhook would see it — hamza, # and all — and sends nothing', async () => {
        const s = await seo();
        s.api.saveGrowthSettings = (body: Json) => Promise.resolve({ settings: body });
        for (const typed of ['#برومبت', 'ذكاء أصطناعي', '   ']) {
            s.host('growth-keyword-input', { value: typed });
            await s.Page.addKeyword(null, { preventDefault: () => {} });
        }
        assert.equal(puts(s).length, 0);
        assert.equal(s.dom.get('growth-keyword-input')!.getAttribute('aria-invalid'), 'true', 'the field is marked, with the reason');
        const tooLong = s.Page.checkKeyword([], 'ك'.repeat(61));
        assert.equal(tooLong.ok, false);
        const full = s.Page.checkKeyword(Array.from({ length: 30 }, (_, i) => `k${i}`), 'new');
        assert.equal(full.message, s.t('growth.keywords.full', { max: 30 }));
        s.Page.destroy();
    });

    it('removing PUTs the list without it; a failed save puts it back and says so', async () => {
        const s = await seo();
        s.api.saveGrowthSettings = () => Promise.reject(new Error('Database is asleep'));
        await s.Page.removeKeyword({ dataset: { index: '0' } });
        assert.deepEqual(puts(s)[0].keywords, ['برومبت']);
        assert.deepEqual(plain(s.Page.settings.keywords), ['ذكاء اصطناعي', 'برومبت'], 'rolled back');
        assert.equal(s.toasts[0]!.type, 'error');
        assert.ok(s.toasts[0]!.message.includes('Database is asleep'));
        s.Page.destroy();
    });

    it('Suggest POSTs the topic and shows the answers as AI ideas to verify, with Add or "in the list"', async () => {
        const s = await seo();
        s.api.suggestGrowthKeywords = () => Promise.resolve({
            keywords: [{ term: 'برومبت', why: 'قصيرة' }, { term: 'ذكاء اصطناعي للطلاب', why: 'نية واضحة' }, 'NotebookLM', { why: 'no term' }],
            hashtags: ['#طلاب', 'AI', 'not valid!'],
        });
        s.host('growth-topic-input', { value: ' برومبتات  للطلاب ' });
        await s.Page.suggestKeywords(null, { preventDefault: () => {} });
        assert.deepEqual(s.calls.filter((c) => c.method === 'suggestGrowthKeywords').map((c) => c.args[0]), ['برومبتات للطلاب']);
        const region = s.dom.get('growth-keywords')!.innerHTML;
        assert.ok(region.includes(s.t('growth.suggest.aiLabel')), 'labelled as ideas, not search volume');
        assert.ok(region.includes(s.t('growth.suggest.inList')), 'an idea already saved says so');
        assert.ok(region.includes(`aria-label="${s.t('growth.suggest.addNamed', { keyword: 'ذكاء اصطناعي للطلاب' })}"`));
        assert.deepEqual(plain(s.Page.suggest.hashtags), ['طلاب', 'AI'], 'hashtags cleaned: no #, no punctuation');
        assert.equal(s.Page.suggest.keywords.length, 3);

        s.api.saveGrowthSettings = (body: Json) => Promise.resolve({ settings: body });
        await s.Page.addSuggested({ dataset: { index: '1' } });
        assert.deepEqual(puts(s)[0].keywords, ['ذكاء اصطناعي', 'برومبت', 'ذكاء اصطناعي للطلاب']);
        s.Page.destroy();
    });

    it('the API client sends exactly the contract: PUT /growth/settings with the body, POST /keywords/suggest with { topic }', async () => {
        const sent: Array<{ url: string; method: string; body: unknown }> = [];
        const ctx: Json = {
            console, t: (k: string) => k,
            localStorage: { getItem: () => 'token', setItem: () => {}, removeItem: () => {} },
            fetch: (url: string, opts: Json) => {
                sent.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
                return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('{}') });
            },
        };
        vm.createContext(ctx);
        vm.runInContext(readFileSync('dashboard/js/api.js', 'utf8'), ctx, { filename: 'api.js' });
        const API = vm.runInContext('API', ctx) as Json;
        await API.suggestGrowthKeywords('برومبتات');
        await API.saveGrowthSettings({ keywords: ['a'], hashtag_sets: [], competitors: [], audience: {} });
        await API.getGrowthOverview(28);
        await API.getGrowthPosts(90, 'views');
        await API.growthCoach({ days: 7 });
        await API.syncGrowth();
        assert.deepEqual(sent, [
            { url: '/api/growth/keywords/suggest', method: 'POST', body: { topic: 'برومبتات' } },
            { url: '/api/growth/settings', method: 'PUT', body: { keywords: ['a'], hashtag_sets: [], competitors: [], audience: {} } },
            { url: '/api/growth/overview?days=28', method: 'GET', body: undefined },
            { url: '/api/growth/posts?days=90&sort=views', method: 'GET', body: undefined },
            { url: '/api/growth/coach', method: 'POST', body: { days: 7 } },
            { url: '/api/growth/sync', method: 'POST', body: undefined },
        ]);
    });
});

describe('GrowthPage — hashtag sets and competitors', () => {
    it('cleans hashtags: no #, any script, letters digits and _ only, deduped, capped', () => {
        const s = loadGrowth();
        assert.deepEqual(plain(s.Page.normTags('#الذكاء_الاصطناعي, #AI ،برومبت #AI  bad-tag   #')), ['الذكاء_الاصطناعي', 'AI', 'برومبت']);
        assert.equal(s.Page.normTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 30);
        assert.equal(s.Page.tagsText(['a', 'ب']), '#a #ب');
    });

    it('checks a set: a name, a unique one, and at least one hashtag', () => {
        const s = loadGrowth('en');
        const sets = [{ name: 'AI', tags: ['ai'] }];
        assert.equal(s.Page.checkSet(sets, -1, '', '#a').message, s.t('growth.sets.nameRequired'));
        assert.equal(s.Page.checkSet(sets, -1, 'ai', '#a').ok, false, 'names are compared normalised');
        assert.equal(s.Page.checkSet(sets, 0, 'AI', '#b #c').ok, true, 'editing a set may keep its own name');
        assert.equal(s.Page.checkSet(sets, -1, 'New', '!!').message, s.t('growth.sets.tagsRequired'));
    });

    it('copies a set as "#a #b", and flags a set longer than five', async () => {
        const s = loadGrowth('en');
        stubGrowth(s, { settings: { ...fullSettings(), hashtag_sets: [{ name: 'Long', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }] } });
        s.hash.tab = 'seo';
        await s.Page.render();
        await s.Page.copySet({ dataset: { index: '0' } });
        assert.deepEqual(s.copied, ['#a #b #c #d #e #f']);
        assert.ok(String(s.Page.hashtagsMarkup()).includes(s.t('growth.sets.tooMany', { max: 5 })));
        s.Page.destroy();
    });

    it('reads competitors in any shape the API sends, missing permission included, and averages likes + comments', () => {
        const s = loadGrowth('en');
        assert.equal(s.Page.readCompetitors({ status: 'missing_permission' }).missing, true);
        assert.equal(s.Page.readCompetitors({ error: 'missing_permission' }).missing, true);
        assert.equal(s.Page.readCompetitors([{ username: 'a' }, { nope: 1 }]).list.length, 1);
        assert.equal(s.Page.readCompetitors({ competitors: [{ username: 'b' }] }).list.length, 1);
        const stats = s.Page.competitorStats({ followers: 1000, media_count: 50, recent: [{ like_count: 30, comments_count: 10 }, { like_count: 10, comments_count: 0 }] });
        assert.equal(stats.avg, 25);
        assert.equal(stats.rate, 0.025);
        assert.equal(s.Page.normalizeUsername('https://instagram.com/Some.User/'), 'some.user');
        assert.equal(s.Page.normalizeUsername('@Some_User'), 'some_user');
    });

    it('a Business Discovery refusal is a notice with the fix, not an error panel', async () => {
        const s = loadGrowth('en');
        stubGrowth(s);
        s.api.getGrowthCompetitors = () => Promise.reject(Object.assign(new Error('Forbidden'), { status: 403, body: { error: 'missing_permission' } }));
        s.hash.tab = 'seo';
        await s.Page.render();
        const region = s.host('growth-competitors');
        await s.Page.loadCompetitors();
        assert.equal(s.Page.competitorsState, 'missing');
        assert.ok(region.innerHTML.includes('id="growth-competitors-missing"'));
        assert.equal(region.innerHTML.includes('data-error-host'), false);
        s.Page.destroy();
    });
});

// ─── The composer (posts.js): alt text, collaborators, trial reels ───────────────────────
const loadPosts = (lang: 'ar' | 'en' = 'ar'): Loaded => load(['dashboard/js/pages/posts.js'], 'PostsPage', lang);

const readySlide = (id: string, url: string, alt?: string): Json => ({ id, file: null, name: '', url, thumb: '', status: 'ready', error: '', ...(alt === undefined ? {} : { alt }) });

function fakeForm(fields: Record<string, unknown>, id?: string): Json {
    const button = { disabled: false, innerHTML: '' };
    return { fields, dataset: { id }, querySelector: () => button };
}

const submitEvent = { preventDefault: (): void => {} };

function capture(s: Loaded): Json[] {
    const sent: Json[] = [];
    s.api.createScheduledPost = (body: Json) => { sent.push(plain(body)); return Promise.resolve({ id: 'n1', platform: body.platform, status: 'PENDING' }); };
    s.api.updateScheduledPost = (_id: Json, body: Json) => { sent.push(plain(body)); return Promise.resolve({}); };
    return sent;
}

describe('PostsPage — Instagram reach fields in the composer payload', () => {
    const base = { caption: 'نص', media_url: 'https://cdn.test/a.jpg', cover_url: '', scheduled_time: '2027-03-04T18:20' };

    it('an image to Instagram sends alt_text and collaborators, cleaned; no trial_reel, no alt_texts', async () => {
        const s = loadPosts();
        const sent = capture(s);
        await s.Page.handleCreate(fakeForm({
            ...base, platform: 'instagram', post_type: 'image',
            alt_text: '  شاشة   محادثة مع وكيل ذكي ', collaborators: '@Partner.One, friend_ai @partner.one',
            trial_reel: 'on',
        }), submitEvent);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].alt_text, 'شاشة محادثة مع وكيل ذكي');
        assert.deepEqual(sent[0].collaborators, ['partner.one', 'friend_ai'], 'no @, lowercased, deduped');
        assert.equal('trial_reel' in sent[0], false, 'a trial is for reels only');
        assert.equal('alt_texts' in sent[0], false);
    });

    it('nothing Instagram-only rides along to Facebook, TikTok, or a story', async () => {
        const s = loadPosts();
        const sent = capture(s);
        const fields = { ...base, alt_text: 'وصف', collaborators: '@a', trial_reel: 'on', trial_graduation: 'MANUAL' };
        await s.Page.handleCreate(fakeForm({ ...fields, platform: 'facebook', post_type: 'image' }), submitEvent);
        await s.Page.handleCreate(fakeForm({ ...fields, platform: 'instagram', post_type: 'story' }), submitEvent);
        for (const body of sent) {
            for (const key of ['alt_text', 'alt_texts', 'collaborators', 'trial_reel']) assert.equal(key in body, false, `${body.platform}/${body.post_type}: ${key}`);
        }
        assert.deepEqual(plain(s.Page.reachVisibility('tiktok', 'video')), { alt: false, alts: false, collab: false, trial: false });
        assert.deepEqual(plain(s.Page.reachVisibility('both', 'video')), { alt: false, alts: false, collab: true, trial: true });
    });

    it('a carousel sends alt_texts aligned with media_urls after a move, "" for a slide left empty', async () => {
        const s = loadPosts();
        const sent = capture(s);
        s.Page.resetSlides(null);
        s.Page._slides.main.push(readySlide('s1', 'https://cdn.test/1.jpg', 'الأولى'), readySlide('s2', 'https://cdn.test/2.jpg'), readySlide('s3', 'https://cdn.test/3.jpg', 'الثالثة'));
        s.Page.moveSlide('main', 's3', -1);
        await s.Page.handleCreate(fakeForm({ ...base, platform: 'both', post_type: 'carousel' }), submitEvent);
        assert.deepEqual(sent[0].media_urls, ['https://cdn.test/1.jpg', 'https://cdn.test/3.jpg', 'https://cdn.test/2.jpg']);
        assert.deepEqual(sent[0].alt_texts, ['الأولى', 'الثالثة', ''], 'slide for slide');

        s.Page.resetSlides(null);
        s.Page._slides.main.push(readySlide('t1', 'https://cdn.test/1.jpg'), readySlide('t2', 'https://cdn.test/2.jpg'));
        await s.Page.handleCreate(fakeForm({ ...base, platform: 'instagram', post_type: 'carousel' }), submitEvent);
        assert.equal('alt_texts' in sent[1], false, 'no alt text at all: the field is left out');

        s.Page._slides.main[0].alt = 'وصف';
        await s.Page.handleCreate(fakeForm({ ...base, platform: 'facebook', post_type: 'carousel' }), submitEvent);
        assert.equal('alt_texts' in sent[2], false, 'Facebook alone takes no alt texts');
    });

    it('a reel sends trial_reel with its graduation, MANUAL unless the operator chose otherwise', async () => {
        const s = loadPosts();
        const sent = capture(s);
        const reel = { ...base, media_url: 'https://cdn.test/r.mp4', platform: 'instagram', post_type: 'video', trial_reel: 'on' };
        await s.Page.handleCreate(fakeForm(reel), submitEvent);
        await s.Page.handleCreate(fakeForm({ ...reel, trial_graduation: 'SS_PERFORMANCE' }), submitEvent);
        await s.Page.handleCreate(fakeForm({ ...reel, trial_graduation: 'EVERYONE_NOW' }), submitEvent);
        await s.Page.handleCreate(fakeForm({ ...reel, trial_reel: null }), submitEvent);
        assert.deepEqual(sent.map((b) => b.trial_reel || null), [
            { graduation: 'MANUAL' }, { graduation: 'SS_PERFORMANCE' }, { graduation: 'MANUAL' }, null,
        ]);
    });

    it('more than three collaborators, or a bad username, stops the post on that field', async () => {
        const s = loadPosts('en');
        const sent = capture(s);
        s.host('post-form-error');
        const field = s.host('post-collaborators');
        await s.Page.handleCreate(fakeForm({ ...base, platform: 'instagram', post_type: 'image', collaborators: '@a, @b, @c, @d' }), submitEvent);
        assert.ok(s.dom.get('post-form-error')!.innerHTML.includes(s.t('posts.reach.collabTooMany', { n: 4 })));
        assert.equal(field.getAttribute('aria-invalid'), 'true');
        await s.Page.handleCreate(fakeForm({ ...base, platform: 'instagram', post_type: 'image', collaborators: '@good, bad name!' }), submitEvent);
        assert.ok(s.dom.get('post-form-error')!.innerHTML.includes(s.t('posts.reach.collabInvalid', { name: '@name!' })));
        await s.Page.handleCreate(fakeForm({ ...base, platform: 'instagram', post_type: 'image', alt_text: 'x'.repeat(201) }), submitEvent);
        assert.ok(s.dom.get('post-form-error')!.innerHTML.includes(s.t('posts.reach.altTooLong', { max: 200 })));
        assert.equal(sent.length, 0);
        assert.deepEqual(plain(s.Page.parseCollaborators(' @A ,a  b ')), { list: ['a', 'b'], invalid: [], count: 2 });
    });

    it('editing starts from what the row saved — per-slide alt text, collaborators, the trial — and sends it back', async () => {
        const s = loadPosts('en');
        const sent = capture(s);
        s.host('modal-overlay');
        const modal = s.host('modal-content');
        const urls = ['https://cdn.test/a.jpg', 'https://cdn.test/b.jpg'];
        s.Page.posts = [{
            id: 'c1', platform: 'instagram', post_type: 'carousel', status: 'PENDING', caption: 'c',
            media_url: urls[0], media_urls: urls, scheduled_time: '2027-03-04T18:20:00.000Z',
            meta_options: { alt_texts: ['first slide', 'second slide'], collaborators: ['partner'] },
        }];
        s.Page.showEditModal('c1');
        assert.deepEqual(s.Page._slides.main.map((x: Json) => x.alt), ['first slide', 'second slide']);
        assert.ok(modal.innerHTML.includes('value="@partner"'));
        assert.ok(modal.innerHTML.includes('value="first slide"'), 'each slide’s field, filled');
        assert.ok(modal.innerHTML.includes('href="#/help/seo#alt-text" target="_blank"'), 'Learn more, in a new tab: this is a modal');
        await s.Page.handleEdit(fakeForm({ ...base, platform: 'instagram', post_type: 'carousel', collaborators: '@partner' }, 'c1'), submitEvent);
        assert.deepEqual(sent[0].alt_texts, ['first slide', 'second slide']);
        assert.deepEqual(sent[0].collaborators, ['partner']);
    });

    it('each field has its own "Learn more" into the SEO article', () => {
        const s = loadPosts('en');
        s.Page.resetSlides(null);
        const m = String(s.Page.reachFields(null));
        for (const section of ['alt-text', 'collabs', 'trial-reels']) assert.ok(m.includes(`href="#/help/seo#${section}"`), section);
        assert.ok(m.includes('maxlength="200"'));
        assert.ok(m.includes('name="trial_graduation" value="MANUAL" checked'), 'the manual graduation is the default');
    });
});

describe('StudioPage — the alt-text preview', () => {
    function phone(slides: Json[]): string {
        const s = load(['dashboard/js/pages/studio.js'], 'StudioPage', 'en');
        s.Page.work = { carousel: { slides, captions: { instagram: 'Line one' } } };
        s.Page._baseline = JSON.stringify(s.Page.work);
        s.Page.draft = { status: 'ready' };
        s.Page.settings = { brand: { name: 'Brand' }, voice: { language: 'ar' } };
        return String(s.Page.phoneMarkup('ig', ['https://cdn.test/1.jpg', 'https://cdn.test/2.jpg'], 0, 2));
    }

    it('shows the slide’s alt text under the phone and uses it as the image’s own alt', () => {
        const m = phone([{ kind: 'cover', title: 'T', altText: 'A chat window, and an agent writing a plan' }, { kind: 'cta' }]);
        assert.ok(m.includes('id="studio-alt-preview"'));
        assert.ok(m.includes('alt="A chat window, and an agent writing a plan"'));
        assert.ok(m.includes('href="#/help/seo#alt-text"'));
    });

    it('says when one slide has none while others do, and shows nothing when no slide carries any', () => {
        assert.ok(phone([{ kind: 'cover', title: 'T' }, { kind: 'cta', altText: 'x' }]).includes('No alt text for this slide.'));
        assert.equal(phone([{ kind: 'cover', title: 'T' }, { kind: 'cta' }]).includes('studio-alt-preview'), false);
    });
});

// ─── Copy, routing, and the cache version ────────────────────────────────────────────────
describe('Growth — every string in Arabic and English, and the page wired into the shell', () => {
    it('has every key the page and the composer ask for, in both dictionaries', () => {
        const s = loadGrowth();
        const strings = s.I18N.strings as Record<string, Record<string, string>>;
        const keys = new Set<string>(['nav.growth', 'page.growth.subtitle']);
        const sources = ['dashboard/js/pages/growth.js', 'dashboard/js/pages/posts.js', 'dashboard/js/pages/studio.js']
            .map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
        for (const src of sources) {
            for (const m of src.matchAll(/\bt\('((?:growth|posts\.reach|help\.link|studio\.preview\.alt)[a-zA-Z0-9_.]*)'/g)) keys.add(m[1]!);
        }
        // The families built from a variable, spelled out.
        const P = s.Page;
        for (const d of P.KPI_DEFS) { keys.add(`growth.kpi.${d.key}`); keys.add(`growth.kpi.${d.key}.tip`); }
        for (const k of [...P.SORT_KEYS, ...P.TREND_METRICS]) keys.add(`growth.metric.${k}`);
        for (const k of P.TYPE_KEYS) keys.add(`growth.type.${k}`);
        for (const k of P.PLATFORM_KEYS) keys.add(`growth.platform.${k}`);
        for (const k of P.COACH_STAGES) keys.add(`growth.coach.stage.${k}`);
        for (const k of ['done', 'current', 'todo']) keys.add(`growth.coach.state.${k}`);
        for (const k of P.LEVELS) keys.add(`growth.coach.level.${k}`);
        for (const k of ['impact', 'effort']) keys.add(`growth.coach.${k}`);
        for (const k of [...Object.values(P.SCOPE_KEYS), 'other']) keys.add(`growth.scope.${k}`);
        const missing: string[] = [];
        for (const key of keys) {
            for (const lang of ['ar', 'en']) {
                const dict = strings[lang]!;
                if (dict[key] === undefined && dict[`${key}_other`] === undefined) missing.push(`${lang}:${key}`);
            }
        }
        assert.deepEqual(missing, []);
        assert.ok(keys.size > 250, `checked ${keys.size} keys`);
    });

    it('counts days and posts the way Arabic does', () => {
        const ar = loadGrowth('ar');
        const en = loadGrowth('en');
        assert.equal(ar.Page.daysText(7), '7 أيام');
        assert.equal(ar.Page.daysText(28), '28 يوماً');
        assert.equal(ar.Page.daysText(1), 'يوم واحد');
        assert.equal(en.Page.daysText(28), '28 days');
        assert.equal(ar.Page.postsText(1), 'منشور واحد');
        assert.equal(ar.Page.postsText(12), '12 منشوراً');
        assert.equal(en.Page.postsText(1), '1 post');
        assert.equal(ar.t('nav.growth'), 'النمو والتسويق');
        assert.equal(en.t('nav.growth'), 'Growth');
    });

    it('is a routed page, after Analytics in the nav, preloaded by its hash, at the new cache version', () => {
        const index = readFileSync('dashboard/index.html', 'utf8');
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /growth: \{ src: 'growth', page: \(\) => GrowthPage \}/);
        assert.match(index, /<a href="#\/growth" class="nav-item" data-page="growth">[\s\S]*?data-i18n="nav\.growth">النمو والتسويق</);
        const at = (needle: string): number => index.indexOf(needle);
        assert.ok(at('data-page="analytics"') < at('data-page="growth"') && at('data-page="growth"') < at('data-page="activity"'));
        assert.match(index, /var PAGES = \[[^\]]*'growth'/);
        const version = (app.match(/ASSET_VERSION: '([\d.]+)'/) || [])[1];
        assert.equal(version, '8.0');
        assert.deepEqual([...new Set([...index.matchAll(/\?v=([\w.]+)/g)].map((m) => m[1]))], ['8.0']);
    });
});
