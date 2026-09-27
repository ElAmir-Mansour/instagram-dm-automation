/**
 * The reading screens after UX wave 2 — Overview, Inbox, Analytics, and the Growth parts the
 * morning question reads (docs/UX_AUDIT_2026-09-27.md §1 SH3, §2).
 *
 * Loaded like the other dashboard tests: the REAL shipped files in a `node:vm` context with a
 * fake DOM, so these test what ships. The claims pinned here are the ones a screenshot cannot
 * check: which number a tile reads, the order alerts land in, where a link goes, what the poll
 * does when nothing changes, and that nothing unmeasured is drawn as a number.
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
    innerHTML: string;
    textContent: string;
    dataset: Record<string, string>;
    classList: { toggle(n: string, on?: boolean): void; add(n: string): void; remove(n: string): void; contains(n: string): boolean };
    setAttribute(n: string, v: string): void;
    removeAttribute(n: string): void;
    getAttribute(n: string): string | null;
    insertAdjacentHTML(where: string, markup: string): void;
    focus(): void;
    closest(): null;
    contains(): boolean;
    querySelector(sel: string): FakeEl | null;
    querySelectorAll(): never[];
    [k: string]: unknown;
}

function fakeEl(id: string, dom: Map<string, FakeEl>, props: Record<string, unknown> = {}): FakeEl {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el: FakeEl = {
        id, value: '', innerHTML: '', textContent: '', dataset: {}, children: [],
        scrollHeight: 0, scrollTop: 0, clientHeight: 0,
        classList: {
            toggle: (n, on) => { if (on === undefined ? !classes.has(n) : on) classes.add(n); else classes.delete(n); },
            add: (n) => { classes.add(n); },
            remove: (n) => { classes.delete(n); },
            contains: (n) => classes.has(n),
        },
        setAttribute: (n, v) => { attrs.set(n, String(v)); },
        removeAttribute: (n) => { attrs.delete(n); },
        getAttribute: (n) => (attrs.has(n) ? (attrs.get(n) as string) : null),
        insertAdjacentHTML: (_where, markup) => { el.innerHTML += markup; },
        focus: () => {},
        closest: () => null,
        contains: () => false,
        // `[data-region="x"]` resolves to the host registered as `region:x`, which is all the
        // Overview asks of its container.
        querySelector: (sel: string) => {
            const m = /^\[data-region="([a-z]+)"\]$/.exec(sel);
            return m ? dom.get(`region:${m[1]}`) ?? null : null;
        },
        querySelectorAll: () => [],
    };
    return Object.assign(el, props);
}

function fakeStorage() {
    const map = new Map<string, string>();
    return {
        getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
        setItem: (k: string, v: string) => { map.set(k, String(v)); },
        removeItem: (k: string) => { map.delete(k); },
    };
}

interface Loaded {
    pages: Json;
    UI: Json;
    t: Translate;
    dom: Map<string, FakeEl>;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    hash: Record<string, string>;
    waiting: number[];
    announced: string[];
    storage: ReturnType<typeof fakeStorage>;
    host(id: string, props?: Record<string, unknown>): FakeEl;
}

function load(lang: 'ar' | 'en' = 'en', app: Json = {}): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const hash: Record<string, string> = {};
    const waiting: number[] = [];
    const storage = fakeStorage();
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '', textContent: '',
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
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        Intl, console, clearTimeout, URLSearchParams,
        // The charts read colours from the tokens; the builders' fallbacks stand in here.
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        clearInterval,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop === 'token' ? 'tok' : prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: (_i: string, title: string, body: string) => `<div class="empty-state">${title} ${body || ''}</div>`, confirm: noop },
        App: {
            currentTheme: () => 'auto', navigate: noop, session: { tenantId: 't1' },
            hashParam: (name: string) => hash[name] || '',
            canOperate: () => true, canAdminister: () => true, go: noop, goWithQuery: noop,
            setInboxWaiting: (n: number) => { waiting.push(n); },
            ...app,
        },
        localStorage: storage,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/motion.js', 'dashboard/js/charts.js',
        'dashboard/js/pages/overview.js', 'dashboard/js/pages/inbox.js', 'dashboard/js/pages/analytics.js', 'dashboard/js/pages/growth.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext('({ pages: { Overview: OverviewPage, Inbox: InboxPage, Analytics: AnalyticsPage, Growth: GrowthPage }, UI, t, Motion })', ctx);
    const announced: string[] = [];
    got.Motion.announce = (m: unknown) => { announced.push(String(m)); };
    got.UI.toast = noop;
    const host = (id: string, props: Record<string, unknown> = {}): FakeEl => {
        const el = fakeEl(id, dom, props);
        dom.set(id, el);
        return el;
    };
    host('page-container');
    return { pages: got.pages, UI: got.UI, t: got.t, dom, api, calls, hash, waiting, announced, storage, host };
}

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const ok = (value: unknown) => ({ status: 'fulfilled', value });
const failed = (message: string) => ({ status: 'rejected', reason: new Error(message) });
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const isoDay = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '').replace(/\s+/g, ' ').trim();

/** Seven days of the daily series, today last: 84 sent, 6 failed. */
const week = (): Json[] => [10, 12, 14, 8, 16, 12, 12].map((sent, i) => ({ day: isoDay(6 - i), sent, failed: i === 6 ? 2 : i === 2 ? 4 : 0 }));

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('Overview — today, not all-time (O4 O5 O6 O12)', () => {
    it('tiles: sent today, failed today, waiting for you, active campaigns — no all-time success rate', () => {
        const s = load();
        const threads = { data: [
            { id: 'a', is_bot_active: false, last_message_direction: 'inbound', last_message_at: ago(3 * 3600 * 1000) },
            { id: 'b', is_bot_active: false, last_message_direction: 'inbound', last_message_at: ago(2 * DAY) },
            { id: 'c', is_bot_active: false, last_message_direction: 'outbound', last_message_at: ago(60000) },
            { id: 'd', is_bot_active: true, last_message_direction: 'inbound', last_message_at: ago(60000) },
        ] };
        const markup = String(s.pages.Overview.renderStats({ activeCampaigns: 3, totalInteractions: 900, successRate: 96, sent: 800 }, ok(week()), ok(threads)));
        const words = text(markup);
        for (const key of ['overview.stat.sentToday', 'overview.stat.failedToday', 'overview.stat.waiting', 'overview.stat.campaigns']) {
            assert.ok(words.includes(s.t(key)), key);
        }
        assert.ok(!words.includes(s.t('overview.stat.successRate')), 'the all-time rate is Analytics’');
        assert.match(markup, /id="stat-sent-today">12</);
        assert.match(markup, /class="stat-value text-danger" id="stat-failed-today">2</, 'a failure today is red');
        assert.ok(words.includes(s.t('overview.stat.inWeek', { n: '84' })), 'the week is the sub-line');
        assert.match(markup, /class="stat-value text-warning" id="stat-waiting">2</, 'AI off + customer spoke last: two');
        assert.ok(words.includes(s.t('overview.stat.waitingOldest', { age: '2d' })), 'the oldest wait, as a duration');
    });

    it('a failed series or thread list is "—" with the reason, never 0', () => {
        const s = load();
        const markup = String(s.pages.Overview.renderStats({ activeCampaigns: 1 }, failed('down'), failed('down')));
        assert.match(markup, /id="stat-sent-today">—</);
        assert.match(markup, /id="stat-waiting">—</);
        assert.ok(text(markup).includes(s.t('overview.stat.waitingUnknown')));
    });

    it('one chart — the 7-day strip — with "7 days: 84 sent · 6 failed (7%)" and no split bar', () => {
        const s = load();
        const hostEl = s.host('region:charts');
        s.pages.Overview.renderCharts(ok(week()));
        assert.ok(hostEl.innerHTML.includes('chart-grid--one'));
        assert.equal((hostEl.innerHTML.match(/class="chart-card surface"/g) || []).length, 1);
        assert.ok(text(hostEl.innerHTML).includes('7 days: 84 sent · 6 failed (7%)'));
        assert.ok(!hostEl.innerHTML.includes(s.t('overview.chart.status')), 'the split lives on Analytics');
    });
});

describe('Overview — the briefing (O7 O8 O10 O11)', () => {
    it('sorts danger → warning → info, counts them, and links the waiting alert to the filtered inbox with the oldest wait', () => {
        const s = load();
        const O = s.pages.Overview;
        const alerts = O.sortAlerts(O.buildAlerts(
            { activeCampaigns: 0 },
            ok({ data: [{ timestamp: new Date().toISOString() }] }),
            failed('token check timed out'),
            ok([]),
            ok({ data: [{ is_bot_active: false, last_message_direction: 'inbound', last_message_at: ago(5 * 3600 * 1000) }] }),
            ok(week()),
        ));
        // Pushed as: token unknown (warning), failed today (danger), waiting (warning), no campaign (info).
        assert.deepEqual(plain(alerts.map((a: Json) => a.level)), ['danger', 'warning', 'warning', 'info']);
        assert.equal(alerts[1].title, s.t('overview.alert.tokenUnknown'), 'stable within a level');
        const at = new Date('2026-09-27T14:05:00');
        const markup = String(O.renderBriefing(alerts, at));
        assert.ok(markup.includes(s.t('overview.attentionCount', { count: 4 })), 'the heading counts');
        assert.ok(markup.includes(s.t('overview.asOf', { time: s.UI.formatTime(at) })), 'as of HH:MM');
        assert.ok(markup.includes('data-action="overview:refresh"'));
        assert.match(markup, /data-target="inbox" data-query="filter=waiting"/);
        assert.ok(markup.includes(s.t('overview.alert.waitingOldest', { age: '5h' })));
    });

    it('a FAILED row in the recent table carries its reason as a second line', () => {
        const s = load();
        const markup = String(s.pages.Overview.renderRecent([
            { status: 'FAILED', error_log: '(#10) Outside the allowed window', trigger_keyword: 'x', timestamp: ago(1000) },
            { status: 'SENT', error_log: 'stale', trigger_keyword: 'y', timestamp: ago(1000) },
        ]));
        assert.match(markup, /<span class="cell-note" dir="auto">\(#10\) Outside the allowed window<\/span>/);
        assert.equal((markup.match(/cell-note/g) || []).length, 1, 'only on a failure');
    });

    it('re-reads on return to the tab only after five minutes, and feeds the nav count', async () => {
        const s = load();
        for (const r of ['briefing', 'growth', 'stats', 'charts', 'recent', 'busy']) s.host(`region:${r}`);
        s.api.getStats = () => Promise.resolve({ activeCampaigns: 2 });
        s.api.getInteractions = () => Promise.resolve({ data: [] });
        s.api.getTokenStatus = () => Promise.resolve({ status: 'valid' });
        s.api.getScheduledPosts = () => Promise.resolve([]);
        s.api.getConversations = () => Promise.resolve({ data: [{ is_bot_active: false, last_message_direction: 'inbound', last_message_at: ago(60000) }] });
        s.api.getDailyStats = () => Promise.resolve(week());
        s.api.getGrowthOverview = () => Promise.resolve({ kpis: {}, trend: [] });
        s.api.getGrowthSettings = () => Promise.resolve({ settings: { goal_followers: 10000 } });
        const O = s.pages.Overview;
        O.render();
        await settle();
        assert.deepEqual(plain(s.calls.filter((c) => c.method === 'getConversations').map((c) => c.args[0])), [{ limit: 100 }]);
        assert.deepEqual(plain(s.calls.filter((c) => c.method === 'getGrowthOverview').map((c) => c.args[0])), [14]);
        assert.deepEqual(s.waiting, [1], 'SH3: the count reaches the nav');
        const before = s.calls.length;
        O.onVisibilityChange();
        assert.equal(s.calls.length, before, 'fresh: nothing re-read');
        O._renderedAt = Date.now() - O.STALE_MS - 1;
        O.onVisibilityChange();
        await settle();
        assert.ok(s.calls.length > before, 'stale: the page re-reads itself');
        O.destroy();
    });
});

describe('Overview — the content region (O1 + G1)', () => {
    const trend = (views: Array<number | null>, followers: Array<number | null> = []): Json[] =>
        views.map((v, i) => ({ day: isoDay(views.length - 1 - i), views: v, reach: null, followers: followers[i] ?? null }));

    it('views this week against last week, followers of the goal, the skip rate in its band, and the coach’s first action', () => {
        const s = load();
        s.storage.setItem('growth:coach:t1', JSON.stringify({
            at: new Date().toISOString(), days: 28,
            result: { actions: [
                { title: 'Post two carousels', impact: 'low', effort: 'low' },
                { title: 'Cut the first second of every reel', impact: 'high', effort: 'med' },
            ] },
        }));
        const views = [100, 100, 100, 100, 100, 100, 100, 150, 150, 150, 150, 150, 100, 110];
        const followers = [140, 141, 141, 142, 143, 143, 144, 146, 147, 148, 149, 150, 152, 154];
        const markup = String(s.pages.Overview.renderGrowth(
            ok({ kpis: { followers: 154, skip_rate: 83 }, trend: trend(views, followers) }),
            ok({ settings: { goal_followers: 10000, goal_views: 1000000 } }),
        ));
        const words = text(markup);
        assert.match(markup, /id="overview-views"[\s\S]*?class="stat-value">960</, 'this week: the last seven days');
        assert.ok(markup.includes('stat-trend is-up') && markup.includes('trending-up'));
        assert.ok(words.includes('+37%'), '960 against 700');
        assert.ok(words.includes(s.t('overview.growth.vsPrev', { n: '700' })));
        assert.ok(words.includes('154 of 10,000'));
        assert.ok(words.includes('+10 in 7 days'), '154 now, 144 seven days before');
        assert.match(markup, /id="overview-skip"[\s\S]*?class="stat-value text-danger">83%</, 'above 70 is the danger band');
        assert.ok(words.includes(s.t('growth.kpi.skipBand.danger')));
        assert.ok(words.includes('Do this first: Cut the first second of every reel'), 'the plan’s #1, as Growth numbers it');
        assert.match(markup, /data-action="app:navigate" data-target="growth"/);
    });

    it('draws nothing it did not measure, and says why the whole region is empty when the read failed', () => {
        const s = load();
        const none = String(s.pages.Overview.renderGrowth(ok({ kpis: { followers: null, skip_rate: null }, trend: trend([null, null]) }), ok({ settings: {} })));
        assert.equal((none.match(/class="stat-value">—</g) || []).length, 3);
        assert.ok(text(none).includes(s.t('overview.growth.noData')));
        assert.ok(text(none).includes(s.t('overview.growth.noPlan')), 'no stored plan: says how to get one');
        assert.ok(!/\b0\b/.test(text(none).replace(/\d+ days?/g, '')), 'no zeros standing in for nothing');

        const down = String(s.pages.Overview.renderGrowth(failed('Growth is asleep'), failed('x')));
        assert.ok(text(down).includes(s.t('overview.growth.unavailable', { reason: 'Growth is asleep' })));
        const partial = String(s.pages.Overview.renderGrowth(ok({ kpis: { followers: 36, skip_rate: 40 }, trend: trend([5, 5]) }), ok({ settings: {} })));
        assert.ok(text(partial).includes(s.t('overview.growth.noPrev')), 'two days: nothing to compare with');
        assert.ok(text(partial).includes(s.t('growth.small.delta')), 'under 100 followers Instagram keeps the change back');
        assert.match(partial, /class="stat-value text-success">40%</);
        assert.ok(!/36 of/.test(text(partial)), 'no goal read: no "of" line');
    });

    it('asks nothing of Growth for a viewer', () => {
        const s = load('en', { canOperate: () => false });
        assert.equal(s.pages.Overview.canSeeGrowth(), false);
        assert.ok(!String(s.pages.Overview.skeleton()).includes('growth-strip'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('Inbox — find → read → reply → resolve (SH3 I1 I2 I3 I7 I9 I12)', () => {
    const rows = (): Json[] => [
        { id: '1', username: 'sara_dev', is_bot_active: false, last_message_direction: 'inbound', last_message_at: ago(60000), last_message_text: 'price?' },
        { id: '2', username: 'omar', is_bot_active: false, last_message_direction: 'outbound', last_message_at: ago(120000), last_message_text: 'done' },
        { id: '3', username: 'lina', is_bot_active: true, last_message_direction: 'inbound', last_message_at: ago(180000), last_message_text: 'hi' },
    ];

    it('filters All · Needs reply · AI paused, seeded from #/inbox?filter=waiting', () => {
        const s = load();
        const I = s.pages.Inbox;
        s.hash.filter = 'waiting';
        assert.equal(I.filterFromHash(), 'waiting');
        s.hash.filter = 'nonsense';
        assert.equal(I.filterFromHash(), 'all', 'the hash is data: anything else is All');
        I.threads = rows();
        I.filter = 'waiting';
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['1']);
        I.filter = 'paused';
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['1', '2']);
        I.filter = 'all';
        assert.equal(I.visibleThreads().length, 3);
        assert.ok(String(I.layout()).includes('data-action="inbox:setFilter" data-filter="waiting"'));
    });

    it('asks for 100, says how many need a reply and "Showing 100 of N", and feeds the nav count', async () => {
        const s = load();
        const I = s.pages.Inbox;
        const count = s.host('inbox-count');
        s.api.getConversations = () => Promise.resolve({ data: rows(), pagination: { total: 250 } });
        await I.loadThreads();
        assert.deepEqual(plain(s.calls[0]!.args[0]), { limit: 100 });
        assert.equal(text(count.innerHTML), '1 needs a reply · Showing 3 of 250 — search to reach the rest.');
        assert.deepEqual(s.waiting, [1]);
        I.destroy();
    });

    it('searches the server once typing pauses, and keeps the loaded threads that match on their last message', async () => {
        const s = load();
        const I = s.pages.Inbox;
        I.threads = rows();
        s.api.getConversations = (p: Json) => Promise.resolve({ data: p.search ? [{ id: '9', username: 'sara_old', is_bot_active: true, last_message_at: ago(40 * DAY) }] : [] });
        I.handleSearch('sara');
        assert.equal(s.calls.length, 0, 'debounced');
        await new Promise((r) => setTimeout(r, I.SEARCH_DEBOUNCE_MS + 30));
        await settle();
        assert.deepEqual(plain(s.calls.map((c) => c.args[0])), [{ limit: 100, search: 'sara' }]);
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['1', '9'], 'last month’s Sara is findable now');
        I.handleSearch('price');
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['1'], 'the message text still matches locally');
        I.destroy();
    });

    it('backs the poll off 5s → 15s → 30s while nothing changes, and back to 5s on a change or focus', () => {
        const s = load();
        const I = s.pages.Inbox;
        const list = rows();
        I.total = 3;
        assert.equal(I.pollDelay(), 5000);
        for (let i = 0; i < 4; i++) I.noteListChange(list);
        assert.equal(I.pollDelay(), 15000, 'three idle ticks after the first read');
        for (let i = 0; i < 3; i++) I.noteListChange(list);
        assert.equal(I.pollDelay(), 30000);
        I.noteListChange([{ ...list[0], last_message_at: new Date().toISOString() }, ...list.slice(1)]);
        assert.equal(I.pollDelay(), 5000, 'a new message resets it');
        for (let i = 0; i < 6; i++) I.noteListChange(list);
        I.resetBackoff();
        assert.equal(I.pollDelay(), 5000, 'so does the operator looking again');
        I.destroy();
    });

    it('dates a thread: HH:MM today, "Yesterday HH:MM", else a short date', () => {
        const s = load();
        const I = s.pages.Inbox;
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30);
        const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 5);
        const old = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 9, 9, 5);
        assert.equal(I.threadTime(today.toISOString()), s.UI.formatTime(today.toISOString()));
        assert.equal(I.threadTime(yesterday.toISOString()), `Yesterday ${s.UI.formatTime(yesterday.toISOString())}`);
        assert.equal(I.threadTime(old.toISOString()), s.UI.formatDate(old.toISOString()));
    });

    it('an empty inbox says when conversations appear and links to the DM troubleshooting', () => {
        const s = load();
        const I = s.pages.Inbox;
        const none = String(I.emptyMarkup('none'));
        assert.ok(none.includes(s.t('inbox.emptyHint')));
        assert.ok(none.includes('href="#/help/troubleshooting#dms"'));
        assert.ok(String(I.emptyMarkup('waiting')).includes(s.t('inbox.noWaiting')));
    });

    it('the stale strip carries a Retry, and a return to the tab after a failure says so at once', async () => {
        const s = load();
        const I = s.pages.Inbox;
        const strip = s.host('threads-stale');
        s.api.getConversations = () => Promise.reject(Object.assign(new Error('offline'), { isNetworkError: true }));
        await I.loadThreads(true, { loud: true, notice: true });
        assert.equal(strip.dataset.state, 'stale', 'one failure on return is enough');
        assert.ok(strip.innerHTML.includes('data-action="inbox:retryThreads"'));
        s.api.getConversations = () => Promise.resolve({ data: [], pagination: { total: 0 } });
        await I.retryThreads();
        assert.equal(strip.dataset.state, undefined);
        assert.ok(s.announced.includes(s.t('inbox.reconnected')));
        I.destroy();
    });
});

describe('Inbox — the thread (I4 I5 I6)', () => {
    it('says "AI replies: off" in words, keeps the consequence under the composer, and offers "Hand back to AI"', async () => {
        const s = load();
        const I = s.pages.Inbox;
        const pane = s.host('chat-pane-container');
        const thread = { id: 'c1', username: 'sara', is_bot_active: false, last_message_direction: 'inbound' };
        I.threads = [thread];
        I.renderChatShell(thread);
        assert.ok(pane.innerHTML.includes(`id="ai-state" aria-hidden="true">${s.t('inbox.aiOff')}<`));
        assert.ok(pane.innerHTML.includes('aria-describedby="composer-hint"'));
        assert.ok(pane.innerHTML.includes(s.t('inbox.composerHintOff')));
        assert.ok(pane.innerHTML.includes('data-action="inbox:handBack" data-id="c1"'));
        const on = String(I.composerHintMarkup({ id: 'c1', is_bot_active: true }));
        assert.ok(on.includes(s.t('inbox.composerHint')) && !on.includes('handBack'));

        s.api.toggleConversationBot = () => Promise.resolve({ ok: true });
        await I.handBack('c1');
        assert.deepEqual(plain(s.calls.map((c) => [c.method, ...c.args])), [['toggleConversationBot', 'c1', true]]);
        assert.equal(thread.is_bot_active, true);
        assert.ok(s.announced.includes(s.t('inbox.handedBack')));
        I.destroy();
    });

    it('puts a divider where the day changes, and only there', () => {
        const s = load();
        const I = s.pages.Inbox;
        const log = s.host('chat-messages-container');
        s.host('chat-messages-loading');
        const now = new Date();
        const at = (d: number, h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, h).toISOString();
        I.renderMessages([
            { id: 1, direction: 'inbound', text: 'a', created_at: at(3, 9) },
            { id: 2, direction: 'outbound', text: 'b', created_at: at(3, 10) },
            { id: 3, direction: 'inbound', text: 'c', created_at: at(1, 9) },
            { id: 4, direction: 'inbound', text: 'd', created_at: at(0, 0) },
        ], true);
        assert.equal((log.innerHTML.match(/class="chat-day"/g) || []).length, 3);
        assert.ok(log.innerHTML.includes(`<span>${s.t('inbox.yesterday')}</span>`));
        assert.ok(log.innerHTML.includes(`<span>${s.t('common.today')}</span>`));
        I.renderMessages([{ id: 5, direction: 'outbound', text: 'e', created_at: new Date().toISOString() }], false);
        assert.equal((log.innerHTML.match(/class="chat-day"/g) || []).length, 3, 'same day: no second "Today"');
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('Analytics (A3 A4 A6 A7 A8)', () => {
    it('splits the platforms over IG + FB and always to 100', () => {
        const s = load();
        const A = s.pages.Analytics;
        const split = A.platformSplit(1, 7);
        assert.deepEqual([split.igPct, split.fbPct], [13, 87], '12.5% and 87.5% rounded apart would be 13 + 88 = 101');
        assert.deepEqual([A.platformSplit(5, 0).igPct, A.platformSplit(5, 0).fbPct], [100, 0]);
        assert.deepEqual([A.platformSplit(0, 0).igPct, A.platformSplit(0, 0).fbPct], [0, 0]);
    });

    it('sorts campaigns by sent, rates each in bands, and links a keyword to its activity', () => {
        const s = load();
        const markup = String(s.pages.Analytics.campaignsMarkup([
            { id: 'c-low', trigger_keyword: 'تم', total_triggers: 50, sent_count: 10, failed_count: 40 },
            { id: 'c-top', trigger_keyword: 'price', total_triggers: 40, sent_count: 39, failed_count: 1 },
            { trigger_keyword: 'orphan', total_triggers: 1, sent_count: 0, failed_count: 0 },
        ]));
        assert.ok(markup.indexOf('price') < markup.indexOf('تم'), 'most sent first');
        assert.ok(markup.includes('<td class="cell-num text-success">98%</td>'));
        assert.ok(markup.includes('<td class="cell-num text-danger">20%</td>'));
        assert.ok(markup.includes('<td class="cell-num ">—</td>'), 'nothing attempted: no rate');
        assert.match(markup, /data-action="app:navigate" data-target="activity" data-query="campaign=c-top"/);
        assert.ok(markup.includes(`aria-label="${s.t('analytics.openInActivity', { keyword: 'price' })}"`));
        assert.ok(!/data-query="campaign=[^"]*"[^>]*>orphan/.test(markup), 'no id, no link');
    });

    it('puts a total and the busiest weekday above the 30-day strip', () => {
        const s = load();
        const rows = Array.from({ length: 14 }, (_, i) => ({ day: `2026-09-${String(7 + i).padStart(2, '0')}`, sent: i % 7 === 5 ? 20 : 2, failed: 0 }));
        rows[0]!.failed = 5;
        const line = s.pages.Analytics.summary30(rows);
        const busiest = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date('2026-09-12'));
        assert.equal(line, `30 days: 64 sent · 5 failed (7%) · busiest day ${busiest}`, 'the weekday of the 20s, summed over the window');
        assert.equal(s.pages.Analytics.summary30([{ day: '2026-09-01', sent: 0, failed: 0 }]), '');
    });

    it('a panel’s Retry re-asks for that panel alone', async () => {
        const s = load();
        const A = s.pages.Analytics;
        const strip = s.host('analytics-strip');
        s.api.getDailyStats = () => Promise.resolve([{ day: '2026-09-25', sent: 3, failed: 1 }]);
        await A.retryPanel('strip');
        assert.deepEqual(plain(s.calls.map((c) => c.method)), ['getDailyStats']);
        assert.ok(strip.innerHTML.includes('id="analytics-summary"'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('Growth — goals, bands, freshness (G1 G2 G4 G5 G12 G14)', () => {
    function growth(settings: Json = { goal_followers: 10000, goal_views: 1000000 }): Loaded {
        const s = load();
        const G = s.pages.Growth;
        G.settings = G.normalizeSettings({ keywords: [], ...settings });
        G.overview = { kpis: { followers: 154, followers_delta: 3, views: 14009, skip_rate: 83 }, trend: [] };
        G.status = G.normalizeStatus({ instagram: 'ok', facebook: 'ok', missing: [], lastSync: ago(3600 * 1000) });
        G.days = 28;
        return s;
    }

    it('shows "154 of 10,000" and "14,009 of 1,000,000" from the settings, with a way to change them', () => {
        const s = growth();
        const G = s.pages.Growth;
        const followers = String(G.kpiCard({ key: 'followers', icon: 'users' }));
        const views = String(G.kpiCard({ key: 'views', icon: 'eye' }));
        assert.ok(text(followers).includes('154 of 10,000'));
        assert.ok(text(views).includes('14,009 of 1,000,000'));
        assert.ok(followers.includes('data-action="growth:editGoal" data-goal="followers"'));
        assert.ok(!String(G.kpiCard({ key: 'reach', icon: 'target' })).includes('growth-goal'), 'only the two goals');
        G.overview.kpis.followers = null;
        assert.ok(text(G.kpiCard({ key: 'followers', icon: 'users' })).includes('— of 10,000'), 'unmeasured is a dash');
        G.settings = G.normalizeSettings({});
        assert.ok(!String(G.kpiCard({ key: 'views', icon: 'eye' })).includes('growth-goal'), 'no goal read: no line');
    });

    it('bands the skip rate: above 70 danger, 50–70 warning, below success', () => {
        const s = growth();
        const G = s.pages.Growth;
        assert.deepEqual(plain([83, 70, 50, 49.9, null].map((v) => G.skipBand(v))), ['danger', 'warning', 'warning', 'success', null]);
        const card = String(G.kpiCard({ key: 'skip_rate', icon: 'skip-forward' }));
        assert.match(card, /class="stat-value text-danger">83%</);
        assert.ok(text(card).includes(s.t('growth.kpi.skipBand.danger')));
    });

    it('turns "last synced" amber past 26 hours and red past 50', () => {
        const s = growth();
        const G = s.pages.Growth;
        assert.ok(!String(G.lastSyncMarkup()).includes('text-warning'));
        G.status.lastSync = ago(30 * 3600 * 1000);
        assert.ok(String(G.lastSyncMarkup()).includes('class="text-meta text-warning"'));
        G.status.lastSync = ago(51 * 3600 * 1000);
        assert.ok(String(G.lastSyncMarkup()).includes('class="text-meta text-danger"'));
    });

    it('hoists the plan’s first action under the toolbar, and says when a sync is newer than the plan', () => {
        const s = growth();
        const G = s.pages.Growth;
        assert.equal(String(G.doFirstMarkup()), '', 'no plan, no line');
        G.coach = G.normalizeCoach({ summary: 's', actions: [{ title: 'Later', impact: 'low' }, { title: 'First', impact: 'high', effort: 'low' }] });
        G.coachState = 'ready';
        G.coachAt = ago(2 * 3600 * 1000);
        assert.ok(text(G.doFirstMarkup()).includes('Do this first: First'));
        assert.ok(String(G.coachMarkup()).includes('id="growth-plan-older"'), 'synced an hour ago, plan two hours old');
        G.coachAt = new Date().toISOString();
        assert.ok(!String(G.coachMarkup()).includes('id="growth-plan-older"'));
    });

    it('saves the goals alone, and refuses what is not a whole number above zero under the field', async () => {
        const s = growth();
        const G = s.pages.Growth;
        s.hash.tab = 'seo';
        const region = s.host('growth-goals');
        s.api.saveGrowthSettings = (body: Json) => Promise.resolve({ settings: { keywords: [], ...body } });
        s.host('growth-goal-followers-input', { value: '0' });
        s.host('growth-goal-views-input', { value: '2,000,000' });
        assert.equal(await G.saveGoals(null, { preventDefault: () => {} }), false);
        assert.equal(s.calls.length, 0, 'nothing sent');
        assert.ok(region.innerHTML.includes('id="growth-goal-followers-error"'));
        assert.ok(!region.innerHTML.includes('id="growth-goal-views-error"'));
        assert.equal(s.dom.get('growth-goal-followers-input')!.getAttribute('aria-invalid'), 'true');

        s.host('growth-goal-followers-input', { value: '١٢٠٠٠' });
        s.host('growth-goal-views-input', { value: '2,000,000' });
        assert.equal(await G.saveGoals(null, { preventDefault: () => {} }), true);
        assert.deepEqual(JSON.parse(JSON.stringify(s.calls.map((c) => c.args[0]))), [{ goal_followers: 12000, goal_views: 2000000 }]);
        assert.equal(G.settings.goal_followers, 12000);
        G.destroy();
    });

    it('the phone’s sort select announces what it did and never contradicts the headers', () => {
        const s = growth();
        const G = s.pages.Growth;
        G.posts = [];
        G.sort = { key: 'views', dir: 'asc' };
        G.sortFromSelect('views');
        assert.deepEqual(JSON.parse(JSON.stringify(G.sort)), { key: 'views', dir: 'asc' }, 'the header’s direction stands');
        G.sortFromSelect('reach');
        assert.deepEqual(JSON.parse(JSON.stringify(G.sort)), { key: 'reach', dir: 'desc' });
        assert.equal(s.announced.pop(), s.t('growth.posts.sortedAnnounce', { column: s.t('growth.metric.reach'), dir: s.t('growth.posts.desc') }));
    });
});
