/**
 * The Monteur page (#/monteur, MONTEUR.md §5 and §9 B): the review queue, the sources, the
 * settings card with its first-run setup, the folder pick, polling, and the lessons.
 *
 * Loaded like growth.test.ts and help.test.ts: the REAL shipped files in a `node:vm` context
 * with a fake DOM. The backend is being built in parallel, so every response here is a
 * fixture in exactly the shapes §5 names — which is what these tests pin: the page sends
 * what the contract says and renders what it returns. The claims a screenshot cannot check:
 *
 *   - times are the TENANT's: next run, the Approve slot and the override are all read and
 *     shown in `MonteurView.timezone`, not in the zone of the machine running the dashboard;
 *   - polling happens only while something is pending, at 5 s, at 3 s during a folder pick
 *     (for at most five minutes), and never while the tab is hidden;
 *   - a clip being typed into keeps its row signature, so a poll never rebuilds it;
 *   - the PUT is `{ monteur: … }` and nothing else, and a server problem lands on its field;
 *   - the page is routed, in the sidebar, in the Studio's tab bar, at cache version 8.1.
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
    offsetWidth: number;
    style: Record<string, string>;
    classes: Set<string>;
    classList: { toggle(n: string, on?: boolean): void; add(n: string): void; remove(n: string): void; contains(n: string): boolean };
    setAttribute(n: string, v: string): void;
    removeAttribute(n: string): void;
    getAttribute(n: string): string | null;
    focus(): void;
    closest(): null;
    contains(): boolean;
    querySelector(): null;
    querySelectorAll(): never[];
    remove(): void;
}

function fakeEl(id: string, props: Record<string, unknown> = {}): FakeEl {
    const attrs = new Map<string, string>();
    const classes = new Set<string>();
    const el: FakeEl = {
        id, value: '', checked: false, disabled: false, innerHTML: '', textContent: '', dataset: {},
        offsetWidth: 100, style: {}, classes,
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
        remove: () => {},
    };
    return Object.assign(el, props);
}

/** `new FormData(form)` for a fake form. */
class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields?: Record<string, unknown> } | null) {
        this.fields = (form && form.fields) || {};
    }
    get(name: string): unknown {
        return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null;
    }
}

interface Timer { id: number; fn: () => void; ms: number }

interface Loaded {
    Page: Json;
    UI: Json;
    I18N: Json;
    t: Translate;
    dom: Map<string, FakeEl>;
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    toasts: Array<{ message: string; type?: string }>;
    confirms: Json[];
    /** Every timer the page (and the shared files) set, in the page's own realm. */
    timers: Timer[];
    listeners: Record<string, Array<() => void>>;
    doc: Json;
    app: Json;
    host(id: string, props?: Record<string, unknown>): FakeEl;
    run<T>(code: string): T;
}

/** The shared dashboard files plus `files`, in `lang`. Timers are recorded, never run by themselves. */
function load(files: string[], page: string, lang: 'ar' | 'en' = 'en', app: Json = {}): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const confirms: Json[] = [];
    const timers: Timer[] = [];
    const listeners: Record<string, Array<() => void>> = {};
    let nextTimer = 1;
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
    const location = { hash: '#/monteur' };
    const appStub: Json = {
        currentTheme: () => 'auto', navigate: noop, currentPage: 'monteur',
        hashParam: () => '', canOperate: () => true, canAdminister: () => true,
        go: noop, goWithQuery: noop,
        ...app,
    };
    const doc: Json = {
        ...stub,
        addEventListener: (type: string, fn: () => void) => { (listeners[type] ||= []).push(fn); },
        removeEventListener: (type: string, fn: () => void) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
        createElement: () => ({ ...stub }),
        body: { ...stub }, head: { ...stub },
        documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
        getElementById: (id: string) => dom.get(id) ?? null,
        activeElement: null,
        visibilityState: 'visible',
    };
    const ctx: Json = {
        document: doc,
        window: {
            addEventListener: noop, removeEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop }),
            location,
        },
        location,
        history: { replaceState: noop },
        Intl, console,
        setTimeout: (fn: () => void, ms?: number) => { const id = nextTimer++; timers.push({ id, fn, ms: Number(ms) || 0 }); return id; },
        clearTimeout: (id: number) => { const at = timers.findIndex((x) => x.id === id); if (at !== -1) timers.splice(at, 1); },
        setInterval: () => 0, clearInterval: noop,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: {
            emptyState: (_icon: string, title: string, body: string) => `<div class="empty-state">${title} ${body || ''}</div>`,
            confirm: (o: Json) => { confirms.push(o); },
        },
        App: appStub,
        FormData: FakeFormData,
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of ['dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js', ...files]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    const run = <T>(code: string): T => vm.runInContext(code, ctx) as T;
    run(`I18N.lang = ${JSON.stringify(lang)};`);
    const got = run<Json>(`({ Page: ${page}, UI, I18N, t })`);
    const toasts: Array<{ message: string; type?: string }> = [];
    got.UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    const host = (id: string, props: Record<string, unknown> = {}): FakeEl => {
        const el = fakeEl(id, props);
        dom.set(id, el);
        return el;
    };
    host('page-container');
    return { ...got, dom, api, calls, toasts, confirms, timers, listeners, doc, app: appStub, host, run };
}

const loadMonteur = (lang: 'ar' | 'en' = 'en', app: Json = {}): Loaded => load(['dashboard/js/pages/monteur.js'], 'MonteurPage', lang, app);

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const NOW = Date.now();
const minutesAgo = (n: number): string => new Date(NOW - n * 60 * 1000).toISOString();

// ─── Fixtures: the shapes MONTEUR.md §5 names ──────────────────────────────────────────────
const RIYADH_NEXT_RUN = '2030-01-15T04:00:00.000Z';   // 07:00 in Riyadh (UTC+3)
const RIYADH_NEXT_SLOT = '2030-01-15T16:00:00.000Z';  // 19:00 in Riyadh

function clip(over: Json = {}): Json {
    return {
        id: 'c1', source_id: 's1', source_name: 'lesson-4.mp4', rank: 1, status: 'review',
        start: 83.2, end: 118.5, duration: 35.3,
        title: 'الفرق بين رأي وشغل منجز',
        hook: 'أغلب الناس يسألون الذكاء الاصطناعي سؤال، والمحترف يعطيه هدف',
        why: 'Opens on a bold claim, one idea, and the payoff lands at 30 s.',
        // §6.1: rank = 3·hook + alone + payoff + send = 16, and the score shown is round(16 / 1.8).
        score: 9,
        topic: 'الفرق بين السؤال والهدف', hook_type: 'promise', scores: { hook: 3, alone: 3, payoff: 2, send: 2 },
        tiktok_privacy: 'SELF_ONLY',
        copy: {
            // §6.1: first line, body, a free-form ask ending in «keyword», hashtags. Never cta.instagramAsk.
            caption: 'هدف بدل سؤال\n\nوش أول أداة بتجربها؟ «برومبت»\n#ذكاء_اصطناعي',
            tiktok_caption: 'هدف بدل سؤال — رابطه في البايو #ذكاء_اصطناعي',
            hashtags: ['ذكاء_اصطناعي'], keyword: 'برومبت', variants: ['البرومبت'], keyword_create: true,
            dm: 'هلا {username}\nهذا الرابط', alt_text: 'رجل أمام حاسوب',
        },
        video_url: '/api/uploads/v1', cover_url: '/api/uploads/p1',
        scheduled_time: null, error: null, created_at: '2026-09-27T08:00:00.000Z',
        ...over,
    };
}

function settings(over: Json = {}): Json {
    return {
        enabled: true, folder: '/Users/elamir/Videos/Reels', run_at: '07:00', videos_per_run: 1, reels_per_video: 2,
        platforms: ['instagram', 'facebook', 'tiktok'], post_at: ['19:00', '21:00'], min_seconds: 20, max_seconds: 45,
        ...over,
    };
}

function monteurView(over: Json = {}): Json {
    return {
        settings: settings(),
        timezone: 'Asia/Riyadh',
        next_run: RIYADH_NEXT_RUN,
        last_scan: { at: minutesAgo(180), added: 2, skipped: 1, missing: false },
        worker: { online: true, lastSeen: minutesAgo(0.3), name: 'Studio Mac' },
        pending: { scan: false, folder_pick: false },
        next_slot: RIYADH_NEXT_SLOT,
        sources: [
            { id: 's1', name: 'lesson-4.mp4', path: '/Users/elamir/Videos/Reels/lesson-4.mp4', duration: 912.4, status: 'done', error: null, clips: 2, created_at: minutesAgo(170), updated_at: minutesAgo(160) },
            { id: 's2', name: 'q-and-a.mov', path: '/Users/elamir/Videos/Reels/q-and-a.mov', duration: 60.5, status: 'no_clips', error: null, clips: 0, created_at: minutesAgo(900), updated_at: minutesAgo(890) },
            { id: 's3', name: 'broken.mkv', path: '/Users/elamir/Videos/Reels/broken.mkv', duration: null, status: 'failed', error: 'ffprobe could not read the file', clips: 0, created_at: minutesAgo(1000), updated_at: minutesAgo(990) },
        ],
        clips: [clip(), clip({ id: 'c2', rank: 2, title: 'ثلاث أدوات تكفيك', score: 7 })],
        lessons: {
            lessons: [
                { rule: 'Open on the result, not the question.', evidence: 'Hooks with a number kept 2x more viewers past 3 s.' },
                { rule: 'Keep it under 40 seconds.', evidence: 'Reels over 45 s had half the completion.' },
            ],
            summary: 'Short reels that open on a result travel furthest.',
            basis: { posts: 14, from: '2026-09-01T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z' },
            created_at: minutesAgo(60 * 24 * 2), model: 'gemini-2.5-flash', status: 'done', error: null,
        },
        ...over,
    };
}

/** Nothing configured and nothing ever run: the first-run setup. */
function firstRunView(over: Json = {}): Json {
    return monteurView({
        settings: settings({ enabled: false, folder: null }),
        next_run: null, last_scan: null, sources: [], clips: [], lessons: null,
        ...over,
    });
}

const studioSettings = (): Json => ({
    settings: {
        cta: { instagramAsk: 'اكتب "{keyword}" بالتعليقات ويوصلك الرابط', tiktokLine: 'رابطه في البايو' },
        voice: { language: 'ar' },
        schedule: { timezone: 'Asia/Riyadh', slots: ['13:00'] },
    },
});

function stub(s: Loaded, view: Json = monteurView()): void {
    s.api.getMonteur = () => Promise.resolve(view);
    s.api.getStudioSettings = () => Promise.resolve(studioSettings());
}

async function renderPage(s: Loaded): Promise<string> {
    await s.Page.render();
    await settle();
    return s.dom.get('page-container')!.innerHTML;
}

/** The page's own poll timer, or undefined when it has none. */
const pollTimer = (s: Loaded): Timer | undefined => s.timers.find((x) => x.id === s.Page._timer);

async function firePoll(s: Loaded): Promise<void> {
    const timer = pollTimer(s);
    assert.ok(timer, 'a poll is scheduled');
    s.timers.splice(s.timers.indexOf(timer), 1);
    timer.fn();
    await settle();
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;
const tagOf = (markup: string, id: string): string => (markup.match(new RegExp(`<[a-z]+[^>]*\\sid="${id}"[^>]*>`)) || [''])[0];
const escaped = (text: string): string => text.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c] as string));
const countCalls = (s: Loaded, method: string): number => s.calls.filter((c) => c.method === method).length;

/** A button `UI.actionBusy` can hold. */
const button = (id: string, dataset: Record<string, string> = {}): FakeEl => fakeEl(id, { dataset, innerHTML: 'Go', textContent: 'Go' });

// ─────────────────────────────────────────────────────────────────────────────────────────
describe('Monteur — the status strip', () => {
    it('says it is on, the next run in the TENANT’s zone, the last run, and that the worker is online', async () => {
        const s = loadMonteur('en');
        stub(s);
        const page = await renderPage(s);
        assert.ok(tagOf(page, 'mt-run-pill').includes('health-fresh'));
        assert.ok(page.includes(s.t('monteur.run.on')));
        // 04:00Z is 07:00 in Riyadh, whatever zone this machine is in.
        const when = s.Page.zoneLabel(RIYADH_NEXT_RUN);
        assert.match(when, /07:00/);
        assert.match(when, /\(Riyadh\)/);
        assert.ok(page.includes(escaped(s.t('monteur.run.next', { when }))));
        assert.ok(page.includes(s.t('monteur.run.added', { count: 2, n: '2' })));
        assert.ok(page.includes(s.t('monteur.run.skipped', { count: 1, n: '1' })));
        assert.ok(tagOf(page, 'mt-worker-pill').includes('health-fresh'));
        assert.ok(page.includes('Studio Mac'));
        assert.ok(!page.includes('id="mt-worker-offline"'), 'no offline notice while it runs');
        const run = tagOf(page, 'mt-run-now');
        assert.ok(run.includes('data-action="monteur:runNow"') && !/\sdisabled\b/.test(run));
        s.Page.destroy();
    });

    it('offline: grey, and it says the jobs wait for the worker, with a re-check and the install guide', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ worker: { online: false, lastSeen: minutesAgo(200), name: 'Studio Mac' }, pending: { scan: true, folder_pick: false } }));
        const page = await renderPage(s);
        assert.ok(tagOf(page, 'mt-worker-pill').includes('health-off'));
        assert.ok(page.includes('id="mt-worker-offline"'));
        assert.ok(page.includes(escaped(s.t('monteur.worker.jobsWait', { name: 'Studio Mac' }))));
        assert.ok(page.includes(s.t('monteur.run.waiting', { name: 'Studio Mac' })), 'the queued scan waits for it');
        assert.ok(page.includes('data-action="monteur:checkWorker"'));
        assert.ok(page.includes('href="#/help/worker#install"'));
        assert.ok(/\sdisabled\b/.test(tagOf(page, 'mt-run-now')), 'a run is already queued');
        s.Page.destroy();
    });

    it('off, or with no folder, it says so instead of a next run — and Run now needs a folder', async () => {
        const off = loadMonteur('en');
        stub(off, monteurView({ settings: settings({ enabled: false }), next_run: null }));
        const offPage = await renderPage(off);
        assert.ok(tagOf(offPage, 'mt-run-pill').includes('health-off'));
        assert.ok(offPage.includes(escaped(off.t('monteur.run.offNote'))));
        off.Page.destroy();

        const none = loadMonteur('en');
        stub(none, monteurView({ settings: settings({ folder: null }), next_run: null }));
        const nonePage = await renderPage(none);
        assert.ok(nonePage.includes(none.t('monteur.run.noFolder')));
        assert.ok(/\sdisabled\b/.test(tagOf(nonePage, 'mt-run-now')));
        none.Page.destroy();
    });

    it('Run now POSTs /run, says whether it runs now or waits, and polls; a 409 is "choose a folder"', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.host('mt-status');
        s.api.runMonteur = () => Promise.resolve({ job: { id: 'j1', kind: 'monteur_scan', status: 'pending' } });
        s.api.getMonteur = () => Promise.resolve(monteurView({ pending: { scan: true, folder_pick: false } }));
        await s.Page.runNow(button('mt-run-now'));
        await settle();
        assert.equal(countCalls(s, 'runMonteur'), 1);
        assert.ok(s.toasts.some((x) => x.message === s.t('monteur.run.started')));
        assert.ok(s.dom.get('mt-status')!.innerHTML.includes(s.t('monteur.run.scanning', { name: 'Studio Mac' })));
        assert.equal(pollTimer(s)?.ms, 5000);

        s.api.runMonteur = () => Promise.reject(Object.assign(new Error('Set monteur.folder first'), { status: 409 }));
        await s.Page.runNow(button('mt-run-now-2'));
        assert.ok(s.toasts.some((x) => x.type === 'error' && x.message === s.t('monteur.run.noFolderToast')));
        s.Page.destroy();
    });

    it('the API client calls exactly the routes of MONTEUR.md §5', async () => {
        // The real api.js, in a context of its own whose fetch records what it was asked.
        const seen: Array<{ path: string; method: string; body: string | undefined }> = [];
        const ctx: Json = {
            console,
            t: (key: string) => key,
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
            fetch: (url: string, options: Json = {}) => {
                seen.push({ path: String(url).replace(/^\/api/, ''), method: options.method || 'GET', body: options.body });
                return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('{}') });
            },
        };
        vm.createContext(ctx);
        vm.runInContext(`${readFileSync('dashboard/js/api.js', 'utf8')}\nglobalThis.__client = API;`, ctx, { filename: 'dashboard/js/api.js' });
        const client = ctx.__client;
        const call = async (name: string, ...args: Json[]): Promise<void> => { await client[name](...args); };
        await call('getMonteur');
        await call('runMonteur');
        await call('pickMonteurFolder');
        await call('retryMonteurSource', 's/1');
        await call('updateMonteurClip', 'c1', { title: 'x' });
        await call('approveMonteurClip', 'c1', { scheduled_time: '2030-01-15T17:30:00.000Z' });
        await call('approveMonteurClip', 'c1');
        await call('rejectMonteurClip', 'c1');
        await call('refreshMonteurLessons');
        await call('saveStudioSettings', { monteur: { enabled: true } });
        assert.deepEqual(seen, [
            { path: '/studio/monteur', method: 'GET', body: undefined },
            { path: '/studio/monteur/run', method: 'POST', body: undefined },
            { path: '/studio/monteur/pick-folder', method: 'POST', body: undefined },
            { path: '/studio/monteur/sources/s%2F1/retry', method: 'POST', body: undefined },
            { path: '/studio/monteur/clips/c1', method: 'PATCH', body: '{"title":"x"}' },
            { path: '/studio/monteur/clips/c1/approve', method: 'POST', body: '{"scheduled_time":"2030-01-15T17:30:00.000Z"}' },
            { path: '/studio/monteur/clips/c1/approve', method: 'POST', body: '{}' },
            { path: '/studio/monteur/clips/c1/reject', method: 'POST', body: undefined },
            { path: '/studio/monteur/lessons/refresh', method: 'POST', body: undefined },
            { path: '/studio/settings', method: 'PUT', body: '{"monteur":{"enabled":true}}' },
        ]);
    });
});

describe('Monteur — the review queue', () => {
    it('a review card: the video with its cover as poster, title, hook, why, score, editable copy, Approve and Reject', async () => {
        const s = loadMonteur('en');
        stub(s);
        const page = await renderPage(s);
        assert.match(page, /<video src="\/api\/uploads\/v1" poster="\/api\/uploads\/p1" controls playsinline preload="metadata"/);
        assert.ok(page.includes('الفرق بين رأي وشغل منجز'));
        assert.ok(page.includes('أغلب الناس يسألون الذكاء الاصطناعي سؤال'));
        assert.ok(page.includes(escaped('Opens on a bold claim, one idea, and the payoff lands at 30 s.')));
        assert.ok(page.includes('<bdi class="ltr-text" dir="ltr">9/10</bdi>'));
        assert.ok(page.includes('<bdi class="ltr-text" dir="ltr">1:23–1:58</bdi>'), 'where in the video, isolated');
        for (const field of ['title', 'caption', 'tiktok_caption', 'keyword']) {
            const tag = tagOf(page, `mt-clip-c1-${field}`);
            assert.ok(tag.includes('data-input="monteur:clipField"') && tag.includes(`data-field="${field}"`), field);
        }
        // Approve always makes sure a campaign answers the keyword: shown as a fact, not a choice.
        assert.equal(tagOf(page, 'mt-clip-c1-create'), '', 'no keyword_create checkbox');
        // Approve names the server's next free slot, in the tenant's zone.
        const label = s.t('monteur.clip.approveAt', { when: s.Page.zoneTime(RIYADH_NEXT_SLOT) });
        assert.match(s.Page.zoneTime(RIYADH_NEXT_SLOT), /19:00/);
        assert.ok(page.includes(escaped(label)));
        assert.ok(tagOf(page, 'mt-clip-c1-approve-btn').includes('btn-primary'));
        assert.ok(tagOf(page, 'mt-clip-c1-reject').includes('data-action="monteur:reject"'));
        assert.ok(page.includes(s.t('monteur.clip.goesTo', { platforms: 'Instagram, Facebook, and TikTok' })));
        assert.ok(page.includes(escaped(s.t('monteur.clip.campaignDm', { keyword: 'برومبت' }))));
        // §6.1: the caption carries «keyword» in a free-form ask, and that is what is checked.
        assert.ok(page.includes(s.t('studio.captions.has')));
        assert.ok(!page.includes(s.t('studio.captions.missing')), 'no false warning on a §6.1 caption');
        assert.equal(count(page, 'class="monteur-clip surface"'), 2, 'two to review');
        assert.ok(page.includes(s.t('monteur.queue.count', { count: 2, n: '2' })));
        s.Page.destroy();
    });

    it('rendering and failed clips show their state, with no editing; a failed one can be dismissed', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({
            clips: [
                clip({ id: 'r1', status: 'rendering', video_url: null, cover_url: null }),
                clip({ id: 'f1', status: 'failed', video_url: null, error: 'Remotion ran out of memory' }),
            ],
        }));
        const page = await renderPage(s);
        assert.ok(page.includes(s.t('monteur.clip.state.rendering')));
        assert.ok(page.includes(s.t('monteur.clip.rendering', { name: 'Studio Mac' })));
        assert.ok(page.includes('Remotion ran out of memory'));
        assert.ok(tagOf(page, 'mt-clip-f1-reject').includes('data-action="monteur:reject"'));
        assert.ok(!page.includes('id="mt-clip-r1-title"') && !page.includes('id="mt-clip-f1-title"'), 'nothing editable');
        assert.ok(!tagOf(page, 'mt-working-group').includes('hidden'));
        assert.ok(page.includes(s.t('monteur.queue.emptyRendering')), 'the empty queue says reels are on their way');
        assert.equal(pollTimer(s)?.ms, 5000, 'a rendering clip keeps the page polling');
        s.Page.destroy();

        const off = loadMonteur('en');
        stub(off, monteurView({ worker: { online: false, lastSeen: null, name: null }, clips: [clip({ id: 'r1', status: 'rendering' })] }));
        const offPage = await renderPage(off);
        assert.ok(offPage.includes(off.t('monteur.clip.renderWaiting', { name: off.t('monteur.worker.fallbackName') })));
        off.Page.destroy();
    });

    it('a title edit warns that the video is re-rendered, blocks Approve until saved, and PATCHes the title alone', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        const warn = s.host('mt-clip-c1-warn');
        const savebar = s.host('mt-clip-c1-savebar');
        const approve = s.host('mt-clip-c1-approve');
        const sigBefore = s.Page.rowSignature('review', s.Page.clipById('c1'));
        s.Page.clipField(fakeEl('mt-clip-c1-title', { dataset: { clip: 'c1', field: 'title' }, value: '  عنوان جديد  ' }));
        assert.ok(warn.innerHTML.includes(s.t('monteur.clip.rerender', { name: 'Studio Mac' })));
        assert.ok(savebar.innerHTML.includes('id="mt-clip-c1-save"'));
        assert.match(approve.innerHTML, /id="mt-clip-c1-approve-btn"[^>]*disabled/);
        // What a poll compares is the server's state, which typing does not change.
        assert.equal(s.Page.rowSignature('review', s.Page.clipById('c1')), sigBefore);

        s.api.updateMonteurClip = (_id: Json, body: Json) => Promise.resolve({ ...clip(), title: body.title, status: 'rendering' });
        await s.Page.saveClip(fakeEl('mt-clip-c1-form', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        const patch = s.calls.find((c) => c.method === 'updateMonteurClip')!;
        assert.equal(patch.args[0], 'c1');
        assert.deepEqual(JSON.parse(JSON.stringify(patch.args[1])), { title: 'عنوان جديد' });
        assert.ok(s.toasts.some((x) => x.message === s.t('monteur.clip.savedRerender', { name: 'Studio Mac' })));
        assert.equal(s.Page.clipById('c1').status, 'rendering');
        assert.notEqual(s.Page.rowSignature('working', s.Page.clipById('c1')), sigBefore);
        assert.equal(pollTimer(s)?.ms, 5000, 'the re-render is polled for');
        s.Page.destroy();
    });

    it('a caption-only edit does not warn and sends only the copy that changed', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        const warn = s.host('mt-clip-c1-warn');
        s.Page.clipField(fakeEl('mt-clip-c1-tiktok_caption', { dataset: { clip: 'c1', field: 'tiktok_caption' }, value: 'نص جديد — رابطه في البايو' }));
        assert.equal(warn.innerHTML, '');
        assert.deepEqual(JSON.parse(JSON.stringify(s.Page.clipPatch(s.Page.clipById('c1'), s.Page.edits.c1))), { copy: { tiktok_caption: 'نص جديد — رابطه في البايو' } });
        assert.equal(s.Page.rerenders({ copy: { caption: 'x' } }), false);
        assert.equal(s.Page.rerenders({ copy: { keyword: 'x' } }), true);
        s.Page.destroy();
    });

    it('a keyword edit re-checks the caption for «keyword» — never the cta.instagramAsk template — and refuses two words', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        const check = s.host('mt-clip-c1-caption-check');
        const follows = s.host('mt-clip-c1-follows');
        const variants = s.host('mt-clip-c1-variants');
        s.Page.clipField(fakeEl('mt-clip-c1-keyword', { dataset: { clip: 'c1', field: 'keyword' }, value: 'كورس' }));
        // The caption was left alone, so the save carries «برومبت» → «كورس» into it (clips.ts): that is what is checked.
        assert.ok(check.innerHTML.includes(s.t('studio.captions.has')) && check.innerHTML.includes('«كورس»'));
        assert.ok(!check.innerHTML.includes(escaped('اكتب "كورس" بالتعليقات')), 'the Studio template is not the Monteur’s ask');
        assert.ok(follows.innerHTML.includes(s.t('monteur.clip.keywordFollows', { from: '«برومبت»', to: '«كورس»' })));
        assert.ok(variants.innerHTML.includes(s.t('monteur.clip.variantsCleared')), 'the old spellings are cleared by the save');
        // Edit the caption too, dropping the ask: now it IS missing, and the save is refused before the round trip.
        s.Page.clipField(fakeEl('mt-clip-c1-caption', { dataset: { clip: 'c1', field: 'caption' }, value: 'هدف بدل سؤال' }));
        assert.ok(check.innerHTML.includes(s.t('studio.captions.missing')));
        assert.equal(follows.innerHTML, '', 'nothing follows into a caption that was edited');
        s.host('mt-clip-c1-error');
        await s.Page.saveClip(fakeEl('mt-clip-c1-form', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        assert.equal(countCalls(s, 'updateMonteurClip'), 0);
        assert.ok(s.dom.get('mt-clip-c1-error')!.innerHTML.includes(escaped(s.t('monteur.clip.captionAsk', { keyword: '«كورس»' }))));
        s.Page.clipField(fakeEl('mt-clip-c1-caption', { dataset: { clip: 'c1', field: 'caption' }, value: clip().copy.caption }));
        s.Page.clipField(fakeEl('mt-clip-c1-keyword', { dataset: { clip: 'c1', field: 'keyword' }, value: 'كورس كامل' }));
        s.host('mt-clip-c1-error');
        await s.Page.saveClip(fakeEl('mt-clip-c1-form', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        assert.equal(countCalls(s, 'updateMonteurClip'), 0);
        assert.ok(s.dom.get('mt-clip-c1-error')!.innerHTML.includes(escaped(s.t('studio.keywordOneWord'))));
        s.Page.destroy();
    });

    it('Approve with no override sends {} and takes the server’s slot; the toast says when; the view is re-read', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        const reads = countCalls(s, 'getMonteur');
        s.api.approveMonteurClip = () => Promise.resolve({ clip: clip({ status: 'scheduled', scheduled_time: RIYADH_NEXT_SLOT }), scheduled_time: RIYADH_NEXT_SLOT });
        await s.Page.approve(fakeEl('mt-clip-c1-approve', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        await settle();
        const call = s.calls.find((c) => c.method === 'approveMonteurClip')!;
        assert.deepEqual([call.args[0], JSON.parse(JSON.stringify(call.args[1]))], ['c1', {}]);
        assert.ok(s.toasts.some((x) => x.message === s.t('monteur.clip.approved', { when: s.Page.zoneTime(RIYADH_NEXT_SLOT) })));
        assert.equal(countCalls(s, 'getMonteur'), reads + 1, 'the next free slot is the server’s to say');
        s.Page.destroy();
    });

    it('the override is tenant wall time: 20:30 in Riyadh is sent as 17:30Z; a past time is refused locally', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        const region = s.host('mt-clip-c1-approve');
        s.Page.toggleOverride('c1');
        assert.ok(region.innerHTML.includes('type="datetime-local"'));
        assert.ok(region.innerHTML.includes(`value="${s.Page.toZoneInput(RIYADH_NEXT_SLOT, 'Asia/Riyadh')}"`), 'opens on the next free slot');
        assert.equal(s.Page.toZoneInput(RIYADH_NEXT_SLOT, 'Asia/Riyadh'), '2030-01-15T19:00');
        s.Page.overrideInput(fakeEl('mt-clip-c1-time', { dataset: { clip: 'c1' }, value: '2030-01-15T20:30' }));
        assert.deepEqual(JSON.parse(JSON.stringify(s.Page.readApprove('c1'))), { ok: true, body: { scheduled_time: '2030-01-15T17:30:00.000Z' } });
        s.Page.overrideInput(fakeEl('mt-clip-c1-time', { dataset: { clip: 'c1' }, value: '2020-01-01T10:00' }));
        s.host('mt-clip-c1-error');
        await s.Page.approve(fakeEl('mt-clip-c1-approve', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        assert.equal(countCalls(s, 'approveMonteurClip'), 0);
        assert.ok(s.dom.get('mt-clip-c1-error')!.innerHTML.includes(escaped(s.t('studio.schedule.inPast'))));
        s.Page.destroy();
    });

    it('Reject asks first, then POSTs /reject and the reel leaves the queue', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.Page.reject('c1');
        assert.equal(s.confirms.length, 1);
        assert.equal(s.confirms[0].title, s.t('monteur.clip.rejectTitle'));
        assert.equal(s.confirms[0].body, s.t('monteur.clip.rejectBody', { title: 'الفرق بين رأي وشغل منجز' }));
        assert.equal(countCalls(s, 'rejectMonteurClip'), 0, 'nothing is sent before the confirm');
        s.api.rejectMonteurClip = () => Promise.resolve(clip({ status: 'rejected' }));
        await s.confirms[0].onConfirm();
        assert.equal(countCalls(s, 'rejectMonteurClip'), 1);
        assert.equal(s.Page.clipById('c1'), null);
        assert.ok(s.toasts.some((x) => x.message === s.t('monteur.clip.rejected')));
        s.Page.destroy();
    });

    it('escapes what comes from the server: a title, a source name, an error', async () => {
        const s = loadMonteur('en');
        const evil = '<img src=x onerror=alert(1)>';
        stub(s, monteurView({
            clips: [clip({ title: evil, source_name: evil }), clip({ id: 'f1', status: 'failed', error: evil })],
            sources: [{ id: 's9', name: evil, path: evil, duration: 10, status: 'failed', error: evil, clips: 0, created_at: minutesAgo(1) }],
        }));
        const page = await renderPage(s);
        assert.equal(page.includes('<img src=x'), false);
        assert.ok(page.includes('&lt;img src=x onerror=alert(1)&gt;'));
        s.Page.destroy();
    });
});

describe('Monteur — sources', () => {
    it('lists each video with its status chip; only a failed one has Retry, and Retry re-polls', async () => {
        const s = loadMonteur('en');
        stub(s);
        const page = await renderPage(s);
        assert.ok(page.includes('lesson-4.mp4') && page.includes('q-and-a.mov') && page.includes('broken.mkv'));
        for (const state of ['done', 'no_clips', 'failed']) assert.ok(page.includes(s.t(`monteur.source.state.${state}`)), state);
        assert.ok(page.includes('ffprobe could not read the file'));
        assert.ok(page.includes(s.t('monteur.source.reels', { count: 2, n: '2' })));
        assert.ok(page.includes('<bdi class="ltr-text" dir="ltr">15:12</bdi>'), 'the length, as m:ss');
        assert.equal(count(page, 'data-action="monteur:retrySource"'), 1);
        assert.ok(tagOf(page, 'mt-source-s3-retry').includes('aria-label="Retry: broken.mkv"'));
        assert.equal(pollTimer(s), undefined, 'nothing in flight, nothing polled');

        s.host('mt-sources');
        s.host('mt-sources-list');
        s.api.retryMonteurSource = () => Promise.resolve({ id: 's3', name: 'broken.mkv', path: '/x/broken.mkv', duration: null, status: 'transcribing', error: null, clips: 0, created_at: minutesAgo(1000) });
        await s.Page.retrySource(button('mt-source-s3-retry', { id: 's3' }));
        assert.equal(countCalls(s, 'retryMonteurSource'), 1);
        assert.ok(s.dom.get('mt-sources-list')!.innerHTML.includes(s.t('monteur.source.state.transcribing')));
        assert.equal(pollTimer(s)?.ms, 5000, 'a transcribing video is pending');
        s.Page.destroy();
    });
});

describe('Monteur — settings', () => {
    it('first run: the settings open as the 3-step setup above everything, its switch ON and unsaved', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView());
        const page = await renderPage(s);
        assert.equal(s.Page.setup, true);
        assert.equal(count(page, '<li class="setup-step'), 3);
        assert.ok(page.includes(s.t('monteur.setup.source')) && page.includes(s.t('monteur.setup.times')) && page.includes(s.t('monteur.setup.numbers')));
        assert.ok(page.indexOf('id="mt-settings"') < page.indexOf('id="mt-queue"'), 'the setup comes before the (empty) queue');
        assert.ok(tagOf(page, 'mt-queue').includes('hidden'), 'nothing to review under a first run');
        assert.ok(tagOf(page, 'mt-enabled').includes('checked'), 'the setup is there to start the daily run');
        assert.ok(page.includes(s.t('monteur.setup.save')));
        for (const id of ['mt-source-folder', 'mt-source-course', 'mt-mode-review', 'mt-mode-auto', 'mt-folder', 'mt-pick-folder', 'mt-run_at', 'mt-videos_per_run', 'mt-reels_per_video', 'mt-post_at-0', 'mt-min_seconds', 'mt-max_seconds', 'mt-platform-instagram', 'mt-platform-facebook', 'mt-platform-tiktok']) {
            assert.ok(tagOf(page, id), id);
        }
        s.Page.destroy();
    });

    it('once set up, the card collapses to a one-line summary with Edit; ranges and times are isolated', async () => {
        const s = loadMonteur('en');
        stub(s);
        const page = await renderPage(s);
        assert.equal(s.Page.setup, false);
        assert.ok(tagOf(page, 'mt-settings-toggle').includes('aria-expanded="false"'));
        assert.ok(tagOf(page, 'mt-settings-body').includes('hidden'));
        assert.ok(!page.includes('id="mt-settings-form"'));
        assert.ok(page.indexOf('id="mt-sources"') < page.indexOf('id="mt-settings"'), 'below the queue and the videos');
        const summary = String(s.Page.summaryMarkup());
        assert.ok(summary.includes('<bdi class="ltr-text" dir="ltr">20–45</bdi>'));
        assert.ok(summary.includes('<bdi class="ltr-text" dir="ltr">19:00, 21:00</bdi>'));
        assert.ok(summary.includes(s.t('monteur.summary.reels', { count: 2, n: '2' })));
        const settingsHost = s.host('mt-settings');
        s.Page.toggleSettings();
        assert.ok(settingsHost.innerHTML.includes('aria-expanded="true"') && settingsHost.innerHTML.includes('id="mt-settings-form"'));
        s.Page.destroy();
    });

    it('Save PUTs { monteur } with the whole section — numbers as numbers, trimmed, no empty times — and ends the setup', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView());
        await renderPage(s);
        s.host('mt-settings-savebar');
        const set = (key: string, value: string, extra: Record<string, string> = {}): void => {
            s.Page.setting(fakeEl(`mt-${key}`, { dataset: { key, ...extra }, value }));
        };
        set('folder', '  /Users/elamir/Videos/Reels  ');
        set('run_at', '06:30');
        set('videos_per_run', '3');
        set('post_at', '20:00', { item: '0' });
        s.Page.setting(fakeEl('mt-platform-facebook', { dataset: { key: 'platform', platform: 'facebook' }, checked: false }));
        s.api.saveStudioSettings = (body: Json) => Promise.resolve({ settings: { ...studioSettings().settings, monteur: body.monteur } });
        s.api.getMonteur = () => Promise.resolve(monteurView());
        await s.Page.saveSettings(fakeEl('mt-settings-form'), { preventDefault() {} });
        await settle();
        const put = s.calls.find((c) => c.method === 'saveStudioSettings')!;
        assert.deepEqual(JSON.parse(JSON.stringify(put.args[0])), {
            monteur: {
                enabled: true, source: 'folder', mode: 'review', brain: 'gemini', style: 'classic', human: true, folder: '/Users/elamir/Videos/Reels', run_at: '06:30', videos_per_run: 3, reels_per_video: 2,
                platforms: ['instagram', 'tiktok'], post_at: ['20:00', '21:00'], min_seconds: 20, max_seconds: 45,
            },
        });
        assert.equal(Object.keys(put.args[0]).length, 1, 'no other section is sent');
        assert.equal(s.Page.setup, false);
        assert.ok(s.toasts.some((x) => x.message === s.t('monteur.settings.saved')));
        s.Page.destroy();
    });

    it('checks §1’s ranges before the round trip, and puts each problem beside its field', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.Page.settingsOpen = true;
        const host = s.host('mt-settings');
        s.Page.setting(fakeEl('mt-videos_per_run', { dataset: { key: 'videos_per_run' }, value: '11' }));
        s.Page.setting(fakeEl('mt-max_seconds', { dataset: { key: 'max_seconds' }, value: '20' }));
        s.Page.setting(fakeEl('mt-post_at-1', { dataset: { key: 'post_at', item: '1' }, value: '19:00' }));
        s.Page.setting(fakeEl('mt-folder', { dataset: { key: 'folder' }, value: 'Videos/Reels' }));
        await s.Page.saveSettings(fakeEl('mt-settings-form'), { preventDefault() {} });
        assert.equal(countCalls(s, 'saveStudioSettings'), 0, 'refused locally, nothing sent');
        const markup = host.innerHTML;
        assert.ok(tagOf(markup, 'mt-videos_per_run').includes('aria-invalid="true"'));
        assert.ok(markup.includes(s.t('monteur.err.range', { min: 1, max: 10 })));
        assert.ok(markup.includes(escaped(s.t('monteur.err.maxAboveMin', { min: 20 }))));
        assert.ok(markup.includes('id="mt-post_at-1-problems"') && markup.includes(s.t('monteur.err.timeTwice')));
        assert.ok(markup.includes(escaped(s.t('monteur.err.folder'))));
        s.Page.destroy();
    });

    it('a 400’s problems go to the fields they name — monteur.post_at[1] → the second time — and the rest above Save', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.Page.settingsOpen = true;
        const host = s.host('mt-settings');
        s.Page.setting(fakeEl('mt-run_at', { dataset: { key: 'run_at' }, value: '08:00' }));
        const problems = ['monteur.post_at[1] must be a time like 13:00', 'monteur.max_seconds must be more than monteur.min_seconds', '"monteur" could not be merged'];
        s.api.saveStudioSettings = () => Promise.reject(Object.assign(new Error('3 problems with these settings.'), { status: 400, body: { error: '3 problems with these settings.', problems } }));
        await s.Page.saveSettings(fakeEl('mt-settings-form'), { preventDefault() {} });
        assert.deepEqual([...s.Page.fieldProblems.keys()], ['post_at.1', 'max_seconds']);
        assert.deepEqual([...s.Page.generalProblems], ['"monteur" could not be merged']);
        const markup = host.innerHTML;
        assert.ok(tagOf(markup, 'mt-post_at-1').includes('aria-invalid="true"'));
        assert.ok(markup.includes('3 problems with these settings.'));
        assert.equal(s.Page.problemKey('run_at must be a time'), 'run_at');
        assert.equal(s.Page.problemKey('brand.name is required'), '', 'another section is not this form’s field');
        s.Page.destroy();
    });
});

describe('Monteur — Choose folder', () => {
    it('POSTs pick-folder, says a window opened on the worker, polls every 3 s, and lands the folder in the form', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView());
        await renderPage(s);
        const note = s.host('mt-pick-status');
        s.host('mt-status');
        s.host('mt-folder');
        s.api.pickMonteurFolder = () => Promise.resolve({ job: { id: 'j2', kind: 'pick_folder' } });
        s.api.getMonteur = () => Promise.resolve(firstRunView({ pending: { scan: false, folder_pick: true } }));
        await s.Page.pickFolder(button('mt-pick-folder'));
        assert.equal(countCalls(s, 'pickMonteurFolder'), 1);
        assert.ok(note.innerHTML.includes(s.t('monteur.folder.opened', { name: 'Studio Mac' })));
        assert.equal(pollTimer(s)?.ms, 3000);
        await firePoll(s);
        assert.equal(pollTimer(s)?.ms, 3000, 'still 3 s while the window is open');

        s.api.getMonteur = () => Promise.resolve(firstRunView({ settings: settings({ enabled: false, folder: '/Users/elamir/Movies/Drop' }) }));
        await firePoll(s);
        assert.equal(s.Page.pick, null);
        assert.equal(s.Page.pickNote.kind, 'set');
        assert.equal(s.Page.work.folder, '/Users/elamir/Movies/Drop', 'into the form…');
        assert.equal(JSON.parse(s.Page._baseline).folder, '/Users/elamir/Movies/Drop', '…and its baseline: it is saved');
        assert.equal(s.dom.get('mt-folder')!.value, '/Users/elamir/Movies/Drop');
        assert.equal(s.Page.work.enabled, true, 'the other unsaved choice is kept');
        assert.equal(s.Page.setup, true, 'a folder landing does not end the setup');
        assert.ok(s.toasts.some((x) => x.message === s.t('monteur.folder.setToast', { folder: '/Users/elamir/Movies/Drop' })));
        assert.equal(pollTimer(s), undefined, 'nothing pending any more');
        s.Page.destroy();
    });

    it('gives up the 3 s polling after five minutes; offline, it says the window opens when the worker is back', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView({ worker: { online: false, lastSeen: minutesAgo(30), name: 'Studio Mac' } }));
        await renderPage(s);
        const note = s.host('mt-pick-status');
        s.host('mt-status');
        s.api.pickMonteurFolder = () => Promise.resolve({ job: { id: 'j2' } });
        s.api.getMonteur = () => Promise.resolve(firstRunView({ worker: { online: false, lastSeen: minutesAgo(30), name: 'Studio Mac' }, pending: { scan: false, folder_pick: true } }));
        await s.Page.pickFolder(button('mt-pick-folder'));
        assert.ok(note.innerHTML.includes(s.t('monteur.folder.openWhenBack', { name: 'Studio Mac' })));
        s.Page.pick.startedAt = Date.now() - 5 * 60 * 1000 - 1;
        assert.equal(s.Page.pollDelay(), 5000, 'past five minutes: the ordinary 5 s, since the pick is still pending');
        await firePoll(s);
        assert.equal(s.Page.pick, null);
        assert.equal(s.Page.pickNote.kind, 'timeout');
        s.Page.destroy();
    });
});

describe('Monteur — polling', () => {
    it('polls only while something is pending, and names each kind of pending', () => {
        const s = loadMonteur('en');
        const v = (over: Json): Json => s.Page.normalizeView(monteurView({ clips: [], sources: [], lessons: null, ...over }));
        assert.equal(s.Page.isPending(v({})), false);
        assert.equal(s.Page.isPending(v({ pending: { scan: true, folder_pick: false } })), true);
        assert.equal(s.Page.isPending(v({ pending: { scan: false, folder_pick: true } })), true);
        for (const status of ['transcribing', 'transcribed', 'picking', 'rendering']) {
            assert.equal(s.Page.isPending(v({ sources: [{ id: 'x', status }] })), true, status);
        }
        for (const status of ['done', 'no_clips', 'failed']) {
            assert.equal(s.Page.isPending(v({ sources: [{ id: 'x', status }] })), false, status);
        }
        assert.equal(s.Page.isPending(v({ clips: [clip({ status: 'rendering' })] })), true);
        assert.equal(s.Page.isPending(v({ clips: [clip({ status: 'review' })] })), false);
        assert.equal(s.Page.isPending(v({ lessons: { status: 'running' } })), true);
    });

    it('a hidden tab asks nothing and parks; becoming visible resumes at once', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip({ id: 'r1', status: 'rendering' })] }));
        await renderPage(s);
        s.host('mt-status');
        const reads = countCalls(s, 'getMonteur');
        s.doc.visibilityState = 'hidden';
        await firePoll(s);
        assert.equal(countCalls(s, 'getMonteur'), reads, 'no request while hidden');
        assert.equal(s.Page._parked, true);
        assert.equal(pollTimer(s), undefined, 'and no timer ticking behind it');
        s.doc.visibilityState = 'visible';
        for (const fn of s.listeners.visibilitychange || []) fn();
        await settle();
        assert.equal(countCalls(s, 'getMonteur'), reads + 1);
        assert.equal(pollTimer(s)?.ms, 5000);
        s.Page.destroy();
        assert.equal((s.listeners.visibilitychange || []).length, 0, 'destroy() removes the listener');
    });

    it('a poll that finishes a render moves the clip into review; a stale answer from before a navigation paints nothing', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip({ id: 'r1', status: 'rendering' })] }));
        await renderPage(s);
        const review = s.host('mt-review-list');
        s.host('mt-working-list');
        s.host('mt-queue');
        s.host('mt-status');
        s.api.getMonteur = () => Promise.resolve(monteurView({ clips: [clip({ id: 'r1', status: 'review' })] }));
        await firePoll(s);
        assert.ok(review.innerHTML.includes('id="mt-clip-r1-title"'));
        assert.equal(pollTimer(s), undefined);

        let resolve!: (v: Json) => void;
        s.api.getMonteur = () => new Promise((r) => { resolve = r; });
        const pending = s.Page.refresh(s.Page._seq);
        s.Page.destroy();
        review.innerHTML = 'untouched';
        resolve(monteurView({ clips: [] }));
        await pending;
        await settle();
        assert.equal(review.innerHTML, 'untouched');
    });
});

describe('Monteur — lessons', () => {
    it('shows the rules, their evidence, the summary and when they were written; Refresh now runs the Analyst', async () => {
        const s = loadMonteur('en');
        stub(s);
        const page = await renderPage(s);
        assert.ok(page.includes('Open on the result, not the question.'));
        assert.ok(page.includes('Hooks with a number kept 2x more viewers past 3 s.'));
        assert.ok(page.includes('Short reels that open on a result travel furthest.'));
        assert.ok(page.includes(s.t('monteur.lessons.basis', { count: 14, n: '14' })));
        assert.ok(tagOf(page, 'mt-lessons-refresh').includes('data-action="monteur:refreshLessons"'));
        assert.equal(page.includes('gemini-2.5-flash'), false, 'the model is plumbing, not copy');

        const card = s.host('mt-lessons');
        let resolve!: (v: Json) => void;
        s.api.refreshMonteurLessons = () => new Promise((r) => { resolve = r; });
        const done = s.Page.refreshLessons();
        assert.ok(card.innerHTML.includes(s.t('monteur.lessons.running')), 'says what it is doing while it runs');
        assert.match(tagOf(card.innerHTML, 'mt-lessons-refresh'), /\sdisabled\b/);
        resolve({ lessons: [{ rule: 'Post at 19:00.', evidence: 'Best reach.' }], summary: null, basis: { posts: 6, from: null, to: null }, created_at: new Date().toISOString(), model: 'm', status: 'done', error: null });
        await done;
        assert.ok(card.innerHTML.includes('Post at 19:00.'));
        assert.ok(s.toasts.some((x) => x.message === s.t('monteur.lessons.done')));
        s.Page.destroy();
    });

    it('with no lessons yet, it says when they will come rather than showing an empty list', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ lessons: null }));
        const page = await renderPage(s);
        assert.ok(page.includes(s.t('monteur.lessons.empty')));
        assert.ok(page.includes(escaped(s.t('monteur.lessons.emptyBody'))));
        s.Page.destroy();
    });
});

describe('Monteur — other states', () => {
    it('a viewer gets one honest empty state and no requests at all', async () => {
        const s = loadMonteur('en', { canOperate: () => false });
        const page = await renderPage(s);
        assert.ok(page.includes(s.t('monteur.viewer.title')));
        assert.equal(s.calls.length, 0);
    });

    it('a 404 with no error body is a server without the routes yet; any other failure says what the server said', async () => {
        const s = loadMonteur('en');
        const errHost = s.host('mt-load-error');
        s.api.getMonteur = () => Promise.reject(Object.assign(new Error('Not found'), { status: 404, body: null }));
        s.api.getStudioSettings = () => Promise.resolve(studioSettings());
        await renderPage(s);
        assert.ok(errHost.innerHTML.includes(escaped(s.t('monteur.notDeployed'))));
        assert.equal(pollTimer(s), undefined);

        const t2 = loadMonteur('en');
        const host2 = t2.host('mt-load-error');
        t2.api.getMonteur = () => Promise.reject(Object.assign(new Error('No active creator found'), { status: 404, body: { error: 'No active creator found' } }));
        t2.api.getStudioSettings = () => Promise.resolve(studioSettings());
        await renderPage(t2);
        assert.ok(host2.innerHTML.includes('No active creator found'));
    });

    it('a tenant switch drops every view, edit and pick', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.Page.clipField(fakeEl('mt-clip-c1-title', { dataset: { clip: 'c1', field: 'title' }, value: 'x' }));
        s.Page.pick = { startedAt: Date.now(), before: null };
        s.Page.resetTenantState();
        assert.equal(s.Page.view, null);
        assert.deepEqual(Object.keys(s.Page.edits), []);
        assert.equal(s.Page.pick, null);
        assert.equal(pollTimer(s), undefined);
    });
});

describe('Monteur — time zones', () => {
    it('reads a wall time in the tenant’s zone, either side of a daylight-saving change', () => {
        const s = loadMonteur('en');
        const P = s.Page;
        assert.equal(P.fromZoneInput('2030-01-15T20:30', 'Asia/Riyadh'), '2030-01-15T17:30:00.000Z');
        assert.equal(P.fromZoneInput('2030-03-09T12:00', 'America/New_York'), '2030-03-09T17:00:00.000Z', 'EST, the day before');
        assert.equal(P.fromZoneInput('2030-03-10T12:00', 'America/New_York'), '2030-03-10T16:00:00.000Z', 'EDT, the day of');
        assert.equal(P.fromZoneInput('2030-03-10T01:30', 'America/New_York'), '2030-03-10T06:30:00.000Z', 'before the jump');
        assert.equal(P.fromZoneInput('2030-11-03T12:00', 'America/New_York'), '2030-11-03T17:00:00.000Z', 'EST again');
        assert.equal(P.fromZoneInput('2030-06-01T00:15', 'Asia/Kolkata'), '2030-05-31T18:45:00.000Z', 'a half-hour zone');
        assert.equal(P.fromZoneInput('', 'Asia/Riyadh'), null);
        assert.equal(P.fromZoneInput('tomorrow', 'Asia/Riyadh'), null);
        for (const [iso, zone] of [['2030-01-15T17:30:00.000Z', 'Asia/Riyadh'], ['2030-07-04T23:00:00.000Z', 'America/New_York'], ['2030-12-31T21:00:00.000Z', 'Europe/London']]) {
            assert.equal(P.fromZoneInput(P.toZoneInput(iso, zone), zone), iso, `${zone} round trip`);
        }
    });

    it('formats in the tenant’s zone, 24-hour, and falls back to the browser’s zone for one it cannot read', () => {
        const s = loadMonteur('en');
        s.Page.view = s.Page.normalizeView(monteurView({ timezone: 'Asia/Riyadh' }));
        assert.match(s.Page.zoneTime('2030-01-15T21:05:00.000Z'), /00:05/, 'past midnight in Riyadh, 24-hour');
        assert.equal(s.Page.zone(), 'Asia/Riyadh');
        s.Page.view.timezone = 'Mars/Olympus';
        assert.equal(s.Page.zone(), s.Page.deviceZone());
        const ar = loadMonteur('ar');
        ar.Page.view = ar.Page.normalizeView(monteurView());
        assert.match(ar.Page.zoneLabel(RIYADH_NEXT_RUN), /07:00/);
        assert.match(ar.Page.zoneLabel(RIYADH_NEXT_RUN), /الرياض/);
    });
});

describe('Monteur — every string in Arabic and English, and the page wired into the shell', () => {
    it('has every key the page asks for, in both dictionaries, with Arabic’s plural forms', () => {
        const s = loadMonteur('ar');
        const strings = s.I18N.strings as Record<string, Record<string, string>>;
        const keys = new Set<string>(['nav.monteur', 'page.monteur.subtitle', 'studio.tabs.monteur']);
        const src = readFileSync('dashboard/js/pages/monteur.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of src.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)) keys.add(m[1]!);
        for (const state of s.Page.SOURCE_STATES) keys.add(`monteur.source.state.${state}`);
        for (const state of s.Page.CLIP_STATES) keys.add(`monteur.clip.state.${state}`);
        for (const p of s.Page.PLATFORMS) keys.add(`monteur.platform.${p}`);
        for (const type of s.Page.HOOK_TYPES) keys.add(`monteur.clip.hookType.${type}`);
        const missing: string[] = [];
        for (const key of keys) {
            for (const lang of ['ar', 'en']) {
                const dict = strings[lang]!;
                if (dict[key] === undefined && dict[`${key}_other`] === undefined) missing.push(`${lang}:${key}`);
            }
        }
        assert.deepEqual(missing, []);
        assert.ok(keys.size > 180, `checked ${keys.size} keys`);
        for (const family of ['monteur.queue.count', 'monteur.run.added', 'monteur.summary.reels', 'monteur.source.reels', 'monteur.lessons.basis']) {
            for (const form of ['zero', 'one', 'two', 'few', 'many', 'other']) assert.ok(strings.ar![`${family}_${form}`], `ar:${family}_${form}`);
        }
        assert.equal(s.t('monteur.queue.count', { count: 2, n: '2' }), 'ريلان للمراجعة');
        assert.equal(s.t('nav.monteur'), 'المونتير');
    });

    it('route: App.pages.monteur loads monteur.js, and #/monteur is the Monteur', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /monteur: \{ src: 'monteur', page: \(\) => MonteurPage \}/);
        const s = load(['dashboard/js/app.js'], 'App');
        const App = s.Page;
        assert.equal(App.pages.monteur.src, 'monteur');
        assert.equal(App.pages.monteur.adminOnly, undefined, 'for every operator, not the admin group');
        for (const hash of ['#/monteur', '#/monteur?x=1']) {
            (s.run<Json>('location')).hash = hash;
            assert.equal(App.pageFromHash(), 'monteur', hash);
        }
    });

    it('sidebar: its own item right under Studio, preloaded by its hash; the Studio tab bar links to it', () => {
        const index = readFileSync('dashboard/index.html', 'utf8');
        const item = index.match(/<a href="#\/monteur" class="nav-item" data-page="monteur">[\s\S]*?<\/a>/);
        assert.ok(item, 'the nav item exists');
        assert.match(item[0], /data-lucide="scissors"/);
        assert.match(item[0], /data-i18n="nav\.monteur">المونتير</);
        const at = (needle: string): number => index.indexOf(needle);
        assert.ok(at('data-page="studio"') < at('data-page="monteur"') && at('data-page="monteur"') < at('data-page="inbox"'));
        assert.match(index, /var PAGES = \[[^\]]*'monteur'/);

        // Both tab bars list the same three links in the same order, and each marks its own.
        const hrefs = (markup: string): string[] => [...markup.matchAll(/<a class="btn btn-sm btn-ghost" href="([^"]+)"/g)].map((m) => m[1]!);
        const studio = load(['dashboard/js/pages/studio.js'], 'StudioPage');
        const studioTabs = String(studio.Page.tabsMarkup('home'));
        const monteur = loadMonteur('en');
        const monteurTabs = String(monteur.Page.toolbarMarkup());
        assert.deepEqual(hrefs(studioTabs), ['#/studio', '#/monteur', '#/studio?tab=settings']);
        assert.deepEqual(hrefs(monteurTabs), hrefs(studioTabs));
        assert.match(monteurTabs, /href="#\/monteur"\s+aria-current="page"/);
        assert.doesNotMatch(studioTabs, /href="#\/monteur"\s+aria-current/);
    });

    it('ships at cache version 12.5: ASSET_VERSION, every ?v= in the shell, and the pages that pin the stylesheet', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        const index = readFileSync('dashboard/index.html', 'utf8');
        const version = (app.match(/ASSET_VERSION: '([\d.]+)'/) || [])[1];
        assert.equal(version, '12.5');
        const refs = [...index.matchAll(/\?v=([\w.]+)/g)].map((m) => m[1]);
        assert.ok(refs.length >= 11, `${refs.length} refs`);
        assert.deepEqual([...new Set(refs)], ['12.5']);
        for (const page of ['public/landing.html', 'public/privacy.html', 'public/data-deletion.html', 'public/pricing.html', 'public/terms.html', 'dashboard/eid.html']) {
            assert.deepEqual([...new Set([...readFileSync(page, 'utf8').matchAll(/\?v=([\w.]+)/g)].map((m) => m[1]))], ['12.5'], page);
        }
    });
});

// ─── Round 2: the review's findings (D-numbers) and the API additions ──────────────────────
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

const approveOf = (page: string, id: string): string =>
    (page.match(new RegExp(`<form class="monteur-approve" id="mt-clip-${id}-approve"[\\s\\S]*?</form>`)) || [''])[0];

describe('Monteur — review fixes', () => {
    it('D1/D4: a §6.1 caption passes on «keyword» alone; one without the keyword is flagged', () => {
        const s = loadMonteur('en');
        s.Page.studio = studioSettings().settings;
        s.Page.view = s.Page.normalizeView(monteurView());
        const ok = s.Page.checksFor(s.Page.clipById('c1'));
        assert.deepEqual({ ...ok.ig }, { ok: true, line: '«برومبت»' });
        s.Page.view.clips[0].copy.caption = 'هدف بدل سؤال\n\nوش أول أداة بتجربها؟\n#ذكاء_اصطناعي';
        assert.equal(s.Page.checksFor(s.Page.clipById('c1')).ig.ok, false);
        assert.equal(s.Page.checksFor(s.Page.clipById('c1')).tt.line, 'رابطه في البايو', 'TikTok still checks cta.tiktokLine');
    });

    it('D2: a Windows UNC or drive path is a full path, as the server says; a relative one is not', () => {
        const s = loadMonteur('en');
        const folderProblem = (folder: string): boolean => s.Page.localProblems({ ...settings(), folder }).some((p: Json) => p.key === 'folder');
        assert.equal(folderProblem('\\\\NAS\\Videos\\Monteur'), false);
        assert.equal(folderProblem('C:\\Users\\me\\Videos'), false);
        assert.equal(folderProblem('/Users/me/Videos'), false);
        assert.equal(folderProblem('Videos/Reels'), true);
    });

    it('D3: leaving during Run now’s re-read starts no poll and paints nothing', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.host('mt-status');
        s.api.runMonteur = () => Promise.resolve({ job: { id: 'j1' } });
        const read = deferred<Json>();
        s.api.getMonteur = () => read.promise;
        const done = s.Page.runNow(button('mt-run-now'));
        await settle();
        s.Page.destroy();
        s.app.currentPage = 'posts';
        const container = s.dom.get('page-container')!;
        container.innerHTML = 'the posts page';
        read.resolve(monteurView({ pending: { scan: true, folder_pick: false } }));
        await done;
        await settle();
        assert.equal(pollTimer(s), undefined, 'no poll under the new page');
        assert.equal(container.innerHTML, 'the posts page');
    });

    it('D3: the same for Approve and for Save, while another clip is still rendering', async () => {
        for (const which of ['approve', 'save']) {
            const s = loadMonteur('en');
            stub(s, monteurView({ clips: [clip(), clip({ id: 'r1', status: 'rendering' })] }));
            await renderPage(s);
            s.host('mt-status');
            s.host('mt-settings');
            s.host('mt-settings-savebar');
            s.api.approveMonteurClip = () => Promise.resolve({ clip: clip({ status: 'scheduled', scheduled_time: RIYADH_NEXT_SLOT }), scheduled_time: RIYADH_NEXT_SLOT });
            s.api.saveStudioSettings = (body: Json) => Promise.resolve({ settings: { ...studioSettings().settings, monteur: body.monteur } });
            const read = deferred<Json>();
            s.api.getMonteur = () => read.promise;
            const done = which === 'approve'
                ? s.Page.approve(fakeEl('mt-clip-c1-approve', { dataset: { clip: 'c1' } }), { preventDefault() {} })
                : s.Page.saveSettings(fakeEl('mt-settings-form'), { preventDefault() {} });
            await settle();
            s.Page.destroy();
            s.app.currentPage = 'posts';
            read.resolve(monteurView({ clips: [clip({ id: 'r1', status: 'rendering' })] }));
            await done;
            await settle();
            assert.equal(pollTimer(s), undefined, which);
        }
    });

    it('D5: what is typed in the time override survives the next poll', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip(), clip({ id: 'r1', status: 'rendering' })] }));
        await renderPage(s);
        s.host('mt-queue');
        const region = s.host('mt-clip-c1-approve');
        s.Page.toggleOverride('c1');
        s.Page.overrideInput(fakeEl('mt-clip-c1-time', { dataset: { clip: 'c1' }, value: '2030-01-15T20:30' }));
        region.innerHTML = 'being typed in';
        s.Page.refreshQueue();
        assert.equal(region.innerHTML, 'being typed in');
        s.Page.destroy();
    });

    it('D5: an Approve in flight is not replaced by a poll, even when the next slot moves', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.host('mt-queue');
        const region = s.host('mt-clip-c1-approve');
        const post = deferred<Json>();
        s.api.approveMonteurClip = () => post.promise;
        const done = s.Page.approve(fakeEl('mt-clip-c1-approve', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        region.innerHTML = 'busy Approve';
        s.Page.view.next_slot = '2030-01-15T18:00:00.000Z';
        s.Page.refreshQueue();
        assert.equal(region.innerHTML, 'busy Approve');
        post.resolve({ clip: clip({ status: 'scheduled', scheduled_time: RIYADH_NEXT_SLOT }), scheduled_time: RIYADH_NEXT_SLOT });
        await done;
        s.Page.destroy();
    });

    it('the TikTok caption counts to 2200: a video caption goes out as post_info.title', async () => {
        const s = loadMonteur('en');
        stub(s);
        const page = await renderPage(s);
        assert.equal(s.Page.TIKTOK_CAPTION_MAX, 2200);
        assert.ok(tagOf(page, 'mt-clip-c1-tiktok_caption-count').includes('data-max="2200"'));
        s.Page.destroy();
    });

    it('a re-render during Refresh now does not leave the lessons card stuck on "running"', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        const card = s.host('mt-lessons');
        const call = deferred<Json>();
        s.api.refreshMonteurLessons = () => call.promise;
        const done = s.Page.refreshLessons();
        await s.Page.render();
        await settle();
        call.resolve({ lessons: [{ rule: 'Post at 19:00.', evidence: 'x' }], summary: null, basis: { posts: 6 }, created_at: new Date().toISOString(), status: 'done', error: null });
        await done;
        assert.ok(!card.innerHTML.includes(s.t('monteur.lessons.running')));
        assert.ok(card.innerHTML.includes('Post at 19:00.'));
        s.Page.destroy();
    });

    it('turning the daily run on needs a folder: the setup cannot be saved without one', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView());
        await renderPage(s);
        s.host('mt-settings');
        await s.Page.saveSettings(fakeEl('mt-settings-form'), { preventDefault() {} });
        assert.equal(countCalls(s, 'saveStudioSettings'), 0);
        assert.deepEqual([...s.Page.fieldProblems.keys()], ['folder']);
        assert.ok(s.dom.get('mt-settings')!.innerHTML.includes(escaped(s.t('monteur.err.folderRequired'))));
        assert.equal(s.Page.setup, true);
        s.Page.destroy();
    });

    it('a poll already in flight when Choose folder is pressed cannot end the new pick', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView());
        await renderPage(s);
        s.host('mt-status');
        s.host('mt-pick-status');
        const old = deferred<Json>();
        s.api.getMonteur = () => old.promise;
        const reading = s.Page.refresh(s.Page._seq);
        s.api.pickMonteurFolder = () => Promise.resolve({ job: { id: 'j2' } });
        await s.Page.pickFolder(button('mt-pick-folder'));
        old.resolve(firstRunView());
        await reading;
        await settle();
        assert.ok(s.Page.pick, 'the pick is still open');
        assert.equal(s.Page.pickNote, null);
        assert.equal(pollTimer(s)?.ms, 3000);
        s.Page.destroy();
    });

    it('§6.1 sibling rule: with a reel from the same video already on that day, Approve promises no time', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({
            clips: [
                clip(),
                clip({ id: 'k1', status: 'scheduled', scheduled_time: '2030-01-15T18:00:00.000Z' }),
                clip({ id: 'o1', source_id: 's2', title: 'من فيديو آخر' }),
            ],
        }));
        const page = await renderPage(s);
        assert.ok(approveOf(page, 'c1').includes(s.t('monteur.clip.approveNextDay')));
        assert.ok(approveOf(page, 'c1').includes(escaped(s.t('monteur.clip.siblingDay', { day: s.Page.zoneDay(RIYADH_NEXT_SLOT) }))));
        assert.ok(approveOf(page, 'o1').includes(escaped(s.t('monteur.clip.approveAt', { when: s.Page.zoneTime(RIYADH_NEXT_SLOT) }))), 'another video keeps the slot');
        s.Page.destroy();
    });
});

describe('Monteur — API additions', () => {
    it('a failed clip offers Retry (POST /rerender) beside Dismiss, and is polled once it renders again', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip({ id: 'f1', status: 'failed', error: 'Remotion ran out of memory' })] }));
        const page = await renderPage(s);
        assert.ok(tagOf(page, 'mt-clip-f1-rerender').includes('data-action="monteur:rerender"'));
        assert.ok(tagOf(page, 'mt-clip-f1-reject').includes('data-action="monteur:reject"'), 'Dismiss stays');
        s.api.rerenderMonteurClip = () => Promise.resolve(clip({ id: 'f1', status: 'rendering', error: null }));
        await s.Page.rerenderClip(button('mt-clip-f1-rerender', { clip: 'f1' }));
        assert.equal(countCalls(s, 'rerenderMonteurClip'), 1);
        assert.equal(s.Page.clipById('f1').status, 'rendering');
        assert.equal(pollTimer(s)?.ms, 5000);
        s.Page.destroy();
    });

    it('lessons.last_run: a failed refresh is said, and the rules in use stay on screen; a running one is polled', async () => {
        const s = loadMonteur('en');
        const lessons = { ...monteurView().lessons, last_run: { status: 'failed', error: 'Gemini quota exceeded', created_at: minutesAgo(30) } };
        stub(s, monteurView({ lessons }));
        const page = await renderPage(s);
        assert.ok(page.includes('Open on the result, not the question.'));
        assert.ok(page.includes(escaped(s.t('monteur.lessons.lastFailed', { when: s.t('common.ago', { value: s.t('common.minutes', { n: '30' }) }), message: 'Gemini quota exceeded' }))));
        s.Page.destroy();
        const running = s.Page.normalizeView(monteurView({ clips: [], sources: [], lessons: { ...lessons, last_run: { status: 'running', error: null, created_at: minutesAgo(1) } } }));
        assert.equal(s.Page.isPending(running), true);
    });

    it('last_scan.error: a refused folder says why', async () => {
        const s = loadMonteur('en');
        const why = 'The folder is outside the allowed roots; pick it with Choose folder.';
        stub(s, monteurView({ last_scan: { at: minutesAgo(10), added: 0, skipped: 0, missing: false, error: why } }));
        const page = await renderPage(s);
        assert.ok(page.includes(escaped(s.t('monteur.run.lastFailed', { when: s.t('common.ago', { value: s.t('common.minutes', { n: '10' }) }), error: why }))));
        s.Page.destroy();
    });

    it('TikTok SELF_ONLY is said beside Approve; nothing when the clip posts publicly', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip(), clip({ id: 'p1', tiktok_privacy: 'PUBLIC_TO_EVERYONE' })] }));
        const page = await renderPage(s);
        assert.ok(approveOf(page, 'c1').includes(escaped(s.t('monteur.clip.tiktokSelfOnly'))));
        assert.ok(!approveOf(page, 'p1').includes(escaped(s.t('monteur.clip.tiktokSelfOnly'))));
        s.Page.destroy();
        const flagged = loadMonteur('en');
        stub(flagged, monteurView({ tiktok_privacy: 'SELF_ONLY', clips: [clip({ tiktok_privacy: undefined })] }));
        const flaggedPage = await renderPage(flagged);
        assert.ok(flaggedPage.includes(escaped(flagged.t('monteur.clip.tiktokSelfOnly'))), 'MonteurView.tiktok_privacy says so too');
        flagged.Page.destroy();
        const off = loadMonteur('en');
        stub(off, monteurView({ tiktok_privacy: null, clips: [clip({ tiktok_privacy: null })] }));
        const offPage = await renderPage(off);
        assert.ok(!offPage.includes(escaped(off.t('monteur.clip.tiktokSelfOnly'))), 'TikTok off: nothing to say');
        off.Page.destroy();
    });

    it('a keyword needs 4+ letters before the round trip, and a refused one shows the server’s message', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.host('mt-clip-c1-error');
        s.Page.clipField(fakeEl('mt-clip-c1-keyword', { dataset: { clip: 'c1', field: 'keyword' }, value: 'كود' }));
        await s.Page.saveClip(fakeEl('mt-clip-c1-form', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        assert.equal(countCalls(s, 'updateMonteurClip'), 0);
        assert.ok(s.dom.get('mt-clip-c1-error')!.innerHTML.includes(escaped(s.t('monteur.clip.keywordShort', { min: 4 }))));
        assert.equal(s.Page.letterCount('كـــود'), 3, 'tatweel is not a letter');
        assert.equal(s.Page.letterCount('دورة'), 4);
        s.Page.clipField(fakeEl('mt-clip-c1-keyword', { dataset: { clip: 'c1', field: 'keyword' }, value: 'دورة' }));
        const said = '«دورة» is already the keyword of the campaign “Course”.';
        s.api.updateMonteurClip = () => Promise.reject(Object.assign(new Error(said), { status: 409, body: { error: said } }));
        await s.Page.saveClip(fakeEl('mt-clip-c1-form', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        assert.ok(s.dom.get('mt-clip-c1-error')!.innerHTML.includes(escaped(said)));
        s.Page.destroy();
    });

    it('shows the scores, the hook type and the topic compactly, and links the TikTok cut when there is one', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip({ tiktok_video_url: '/api/uploads/tt1' }), clip({ id: 'c2', scores: undefined, hook_type: undefined, topic: undefined })] }));
        const page = await renderPage(s);
        assert.equal(s.t('monteur.clip.scores', { hook: 3, alone: 3, payoff: 2, send: 2 }), 'Hook 3 · Alone 3 · Payoff 2 · Send 2');
        assert.ok(page.includes(s.t('monteur.clip.scores', { hook: 3, alone: 3, payoff: 2, send: 2 })));
        assert.ok(page.includes(s.t('monteur.clip.hookType.promise')));
        assert.ok(page.includes('الفرق بين السؤال والهدف'));
        assert.match(page, /<a class="monteur-tt-link" href="\/api\/uploads\/tt1" target="_blank" rel="noopener"/);
        assert.equal(count(page, 'class="text-meta monteur-scores"'), 1, 'no empty line for a clip without scores');
        s.Page.destroy();
    });

    it('the client POSTs /clips/:id/rerender', async () => {
        const seen: string[] = [];
        const ctx: Json = {
            console, t: (key: string) => key,
            localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
            fetch: (url: string, options: Json = {}) => { seen.push(`${options.method || 'GET'} ${url}`); return Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve('{}') }); },
        };
        vm.createContext(ctx);
        vm.runInContext(`${readFileSync('dashboard/js/api.js', 'utf8')}\nglobalThis.__client = API;`, ctx);
        await ctx.__client.rerenderMonteurClip('c/1');
        assert.deepEqual(seen, ['POST /api/studio/monteur/clips/c%2F1/rerender']);
    });
});

describe('Monteur — Approve’s answers (backend round 2)', () => {
    it('a same-day 409 says why, without the field path, and opens the time picker', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.host('mt-clip-c1-error');
        const approveRegion = s.host('mt-clip-c1-approve');
        const said = 'scheduled_time: another reel from this video is already on Tue 15 Jan. Choose another day.';
        s.api.approveMonteurClip = () => Promise.reject(Object.assign(new Error(said), { status: 409, body: { error: said } }));
        await s.Page.approve(fakeEl('mt-clip-c1-approve', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        const error = s.dom.get('mt-clip-c1-error')!.innerHTML;
        assert.ok(error.includes('another reel from this video is already on Tue 15 Jan. Choose another day.'));
        assert.ok(!error.includes('scheduled_time:'), 'the path is not shown beside its own field');
        assert.ok(error.includes(s.t('monteur.clip.pickAnotherTime')));
        assert.equal(s.Page.overrides.c1.open, true);
        assert.ok(approveRegion.innerHTML.includes('type="datetime-local"'));
        s.Page.destroy();
    });

    it('a keyword inside a live campaign’s is shown as the server said it', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.host('mt-clip-c1-error');
        const said = 'copy.keyword: «برومبت» sits inside the active keyword «البرومبتات». Change the reel\'s keyword.';
        s.api.approveMonteurClip = () => Promise.reject(Object.assign(new Error(said), { status: 409, body: { error: said } }));
        await s.Page.approve(fakeEl('mt-clip-c1-approve', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        assert.ok(s.dom.get('mt-clip-c1-error')!.innerHTML.includes(escaped('«برومبت» sits inside the active keyword «البرومبتات». Change the reel\'s keyword.')));
        assert.notEqual(s.Page.overrides.c1 && s.Page.overrides.c1.open, true, 'not a time problem');
        assert.equal(s.Page.plainMessage('Error: something'), 'Error: something', 'only a field path is dropped');
        s.Page.destroy();
    });

    it('the campaign line names the keyword before Approve, and the toast says whether Approve made or reused a campaign', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip(), clip({ id: 'e1', copy: { ...clip().copy, keyword_create: false } })] }));
        const page = await renderPage(s);
        // Only the server knows at Approve time whether a campaign still answers the keyword, so
        // the line before it is the same either way: keyword_create is informational (§5).
        for (const id of ['c1', 'e1']) {
            assert.ok(approveOf(page, id).includes(escaped(s.t('monteur.clip.campaignDm', { keyword: 'برومبت' }))), id);
            assert.ok(!approveOf(page, id).includes(escaped(s.t('monteur.clip.campaignToo', { keyword: 'برومبت' }))), id);
        }
        s.api.approveMonteurClip = () => Promise.resolve({
            clip: clip({ status: 'scheduled', scheduled_time: RIYADH_NEXT_SLOT }), scheduled_time: RIYADH_NEXT_SLOT,
            campaign: { id: 'k9', trigger_keyword: 'برومبت', created: false },
        });
        await s.Page.approve(fakeEl('mt-clip-c1-approve', { dataset: { clip: 'c1' } }), { preventDefault() {} });
        await settle();
        assert.ok(s.toasts.some((x) => x.message.includes(s.t('monteur.clip.campaignReused', { keyword: 'برومبت' }))));
        const noMeta = loadMonteur('en');
        stub(noMeta, monteurView({ settings: settings({ platforms: ['tiktok'] }) }));
        const noMetaPage = await renderPage(noMeta);
        assert.ok(!noMetaPage.includes(escaped(noMeta.t('monteur.clip.campaignDm', { keyword: 'برومبت' }))), 'TikTok alone: no DM campaign');
        noMeta.Page.destroy();
        s.Page.destroy();
    });

    it('the PATCH never sends keyword_create', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.Page.clipField(fakeEl('mt-clip-c1-keyword', { dataset: { clip: 'c1', field: 'keyword' }, value: 'كورسات' }));
        assert.deepEqual(JSON.parse(JSON.stringify(s.Page.clipPatch(s.Page.clipById('c1'), s.Page.edits.c1))), { copy: { keyword: 'كورسات' } });
        s.Page.destroy();
    });
});

// ─── Round 4: where the videos come from, and what happens to a ready reel ─────────────────
describe('Monteur — source and mode (MONTEUR.md §1)', () => {
    const radio = (key: string, value: string): FakeEl => fakeEl(`mt-${key}-${value}`, { dataset: { key }, value, checked: true });

    it('the settings card asks both, as radio groups, with the saved choice checked', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ settings: settings({ source: 'course', mode: 'auto' }) }));
        await renderPage(s);
        const form = String(s.Page.formMarkup());
        for (const [key, value] of [['source', 'folder'], ['source', 'course'], ['mode', 'review'], ['mode', 'auto']]) {
            const tag = tagOf(form, `mt-${key}-${value}`);
            assert.ok(tag.includes('type="radio"') && tag.includes(`name="mt-${key}"`) && tag.includes('data-change="monteur:setting"'), `${key}=${value}`);
            assert.equal(tag.includes('checked'), value === 'course' || value === 'auto', `${key}=${value} checked`);
        }
        for (const key of ['monteur.settings.source', 'monteur.settings.sourceFolder', 'monteur.settings.sourceCourse',
            'monteur.settings.mode', 'monteur.settings.modeReview', 'monteur.settings.modeAuto']) {
            assert.ok(form.includes(escaped(s.t(key))), key);
        }
        assert.ok(form.indexOf('id="mt-source"') < form.indexOf('id="mt-folder-group"'), 'the source comes before the folder');
        assert.ok(tagOf(form, 'mt-folder-group').includes('hidden'), 'no folder is asked for with the course library');
        s.Page.destroy();
    });

    it('reads a section with neither as the folder, reviewed', () => {
        const s = loadMonteur('en');
        const c = s.Page.normalizeConfig({ enabled: true, folder: '/v' });
        assert.deepEqual([c.source, c.mode], ['folder', 'review']);
        const odd = s.Page.normalizeConfig({ source: 'drive', mode: 'yolo' });
        assert.deepEqual([odd.source, odd.mode], ['folder', 'review']);
    });

    it('course and auto are saved as such, with the daily run on and no folder at all', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView());
        await renderPage(s);
        s.host('mt-settings-savebar');
        const group = s.host('mt-folder-group');
        s.Page.setting(radio('source', 'course'));
        assert.ok(group.classes.has('hidden'), 'the folder field goes');
        s.Page.setting(radio('mode', 'auto'));
        assert.deepEqual([...s.Page.stepStates()], [true, true, true], 'step 1 is done without a folder');
        s.api.saveStudioSettings = (body: Json) => Promise.resolve({ settings: { ...studioSettings().settings, monteur: body.monteur } });
        s.api.getMonteur = () => Promise.resolve(monteurView({ settings: settings({ source: 'course', mode: 'auto', folder: null }) }));
        await s.Page.saveSettings(fakeEl('mt-settings-form'), { preventDefault() {} });
        await settle();
        const put = s.calls.find((c) => c.method === 'saveStudioSettings');
        assert.ok(put, 'saved, not refused for want of a folder');
        const sent = JSON.parse(JSON.stringify(put!.args[0])).monteur;
        assert.deepEqual([sent.enabled, sent.source, sent.mode, sent.folder], [true, 'course', 'auto', null]);
        s.Page.setting(radio('source', 'folder'));
        assert.ok(!group.classes.has('hidden'), 'back to a folder, the field is back');
        s.Page.destroy();
    });

    it('still needs a folder to run daily from one', async () => {
        const s = loadMonteur('en');
        stub(s, firstRunView());
        await renderPage(s);
        s.host('mt-settings');
        s.Page.setting(radio('mode', 'auto'));
        await s.Page.saveSettings(fakeEl('mt-settings-form'), { preventDefault() {} });
        assert.equal(countCalls(s, 'saveStudioSettings'), 0);
        assert.deepEqual([...s.Page.fieldProblems.keys()], ['folder']);
        s.Page.destroy();
    });

    it('ignores a value that is neither choice', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.Page.setting(radio('source', 'dropbox'));
        s.Page.setting(radio('mode', 'sometimes'));
        assert.deepEqual([s.Page.work.source, s.Page.work.mode], ['folder', 'review']);
        s.Page.destroy();
    });

    it('course mode: the strip shows the next run, Run now needs no folder, and its 409 is "no lesson left"', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ settings: settings({ source: 'course', folder: null }) }));
        const page = await renderPage(s);
        assert.ok(!page.includes(s.t('monteur.run.noFolder')));
        assert.ok(page.includes(escaped(s.t('monteur.run.next', { when: s.Page.zoneLabel(RIYADH_NEXT_RUN) }))));
        assert.ok(!/\sdisabled\b/.test(tagOf(page, 'mt-run-now')), 'Run now works without a folder');
        assert.ok(!page.includes('monteur-folder-line'), 'no folder line in the summary');
        s.api.runMonteur = () => Promise.reject(Object.assign(new Error('Every lesson…'), { status: 409 }));
        await s.Page.runNow(button('mt-run-now'));
        assert.ok(s.toasts.some((x) => x.type === 'error' && x.message === s.t('monteur.run.noLessonsToast')));
        s.Page.destroy();
    });

    it('the summary says the videos come from the course library and reels are scheduled automatically', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ settings: settings({ source: 'course', mode: 'auto' }) }));
        const page = await renderPage(s);
        assert.ok(!page.includes('monteur-folder-line'), 'a folder still saved is not shown as where the videos come from');
        const summary = String(s.Page.summaryMarkup());
        assert.ok(summary.includes(s.t('monteur.summary.course')));
        assert.ok(summary.includes(s.t('monteur.summary.auto')));
        const plain = loadMonteur('en');
        stub(plain);
        await renderPage(plain);
        const plainSummary = String(plain.Page.summaryMarkup());
        assert.ok(!plainSummary.includes(plain.t('monteur.summary.course')) && !plainSummary.includes(plain.t('monteur.summary.auto')));
        s.Page.destroy();
        plain.Page.destroy();
    });

    it('an empty queue in course mode says when the next reels come, with no folder', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ settings: settings({ source: 'course', folder: null }), clips: [], sources: [] }));
        const page = await renderPage(s);
        assert.ok(page.includes(escaped(s.t('monteur.queue.emptyNext', { when: s.Page.zoneLabel(RIYADH_NEXT_RUN) }))));
        s.Page.destroy();
    });

    it('a reel auto mode could not schedule says why on its card', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ clips: [clip({ error: 'TikTok is not connected. <b>Connect it</b>' })] }));
        const page = await renderPage(s);
        const line = (page.match(/<p [^>]*id="mt-clip-c1-refused"[^>]*>[\s\S]*?<\/p>/) || [''])[0];
        assert.ok(line.includes(escaped(s.t('monteur.clip.autoRefused', { error: 'TikTok is not connected. <b>Connect it</b>' }))), line);
        assert.ok(!page.includes('<b>Connect it</b>'), 'escaped');
        s.Page.destroy();
    });

    it('says all of it in Arabic too', async () => {
        const s = loadMonteur('ar');
        stub(s, monteurView({ settings: settings({ source: 'course', mode: 'auto' }) }));
        await renderPage(s);
        const form = String(s.Page.formMarkup());
        for (const key of ['monteur.settings.source', 'monteur.settings.sourceCourse', 'monteur.settings.mode', 'monteur.settings.modeAuto']) {
            const text = s.t(key);
            assert.match(text, /[\u0600-\u06FF]/, key);
            assert.ok(form.includes(escaped(text)), key);
        }
        s.Page.destroy();
    });
});

describe('Monteur — who thinks: Gemini or Claude on the Mac (MONTEUR.md §6.3)', () => {
    const pick = (value: string): FakeEl => fakeEl('mt-brain', { dataset: { key: 'brain' }, value });

    it('the settings card asks it as a select, in both forms, with the saved choice selected', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ settings: settings({ brain: 'claude_mac' }) }));
        await renderPage(s);
        for (const form of [String(s.Page.formMarkup()), String(s.Page.setupMarkup())]) {
            const select = tagOf(form, 'mt-brain');
            assert.ok(select.startsWith('<select') && select.includes('data-change="monteur:setting"') && select.includes('data-key="brain"'), select);
            assert.match(form, /<option value="claude_mac" selected>/);
            assert.doesNotMatch(form, /<option value="gemini" selected>/);
            for (const key of ['monteur.settings.brain', 'monteur.settings.brainGemini', 'monteur.settings.brainClaude']) {
                assert.ok(form.includes(escaped(s.t(key))), key);
            }
        }
        s.Page.destroy();
    });

    it('reads a section saved before it existed, or an unknown value, as Gemini', () => {
        const s = loadMonteur('en');
        assert.equal(s.Page.normalizeConfig({ enabled: true }).brain, 'gemini');
        assert.equal(s.Page.normalizeConfig({ brain: 'gpt' }).brain, 'gemini');
        assert.equal(s.Page.normalizeConfig({ brain: 'claude_mac' }).brain, 'claude_mac');
    });

    it('sends the choice with the section, and ignores a value that is neither', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        s.Page.setting(pick('claude'));
        assert.equal(s.Page.work.brain, 'gemini');
        s.Page.setting(pick('claude_mac'));
        assert.equal(s.Page.work.brain, 'claude_mac');
        assert.equal(s.Page.settingsPayload().brain, 'claude_mac');
        s.Page.destroy();
    });

    it('says it in Arabic too', () => {
        const s = loadMonteur('ar');
        for (const key of ['monteur.settings.brain', 'monteur.settings.brainGemini', 'monteur.settings.brainClaude', 'monteur.settings.brainHint']) {
            assert.notEqual(s.t(key), key, key);
        }
        assert.match(s.t('monteur.settings.brainClaude'), /Claude/);
    });
});

describe('Monteur — the edit style: classic or paper (MONTEUR.md §6.2)', () => {
    const pick = (value: string): FakeEl => fakeEl('mt-style', { dataset: { key: 'style' }, value });
    const KEYS = ['monteur.settings.style', 'monteur.settings.styleClassic', 'monteur.settings.stylePaper', 'monteur.settings.styleHint'];

    it('the settings card asks it as a select labelled Edit style, in both forms, with the saved choice selected', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ settings: settings({ style: 'paper' }) }));
        await renderPage(s);
        assert.equal(s.t('monteur.settings.style'), 'Edit style');
        assert.match(s.t('monteur.settings.styleHint'), /Ali Abdaal style: unfolding cards, paper letters, drawn icons and black-and-white b-roll/);
        for (const form of [String(s.Page.formMarkup()), String(s.Page.setupMarkup())]) {
            const select = tagOf(form, 'mt-style');
            assert.ok(select.startsWith('<select') && select.includes('data-change="monteur:setting"') && select.includes('data-key="style"'), select);
            assert.match(form, /<option value="paper" selected>/);
            assert.doesNotMatch(form, /<option value="classic" selected>/);
            for (const key of KEYS) assert.ok(form.includes(escaped(s.t(key))), key);
        }
        s.Page.destroy();
    });

    it('reads a section saved before it existed, or an unknown value, as classic', () => {
        const s = loadMonteur('en');
        assert.equal(s.Page.normalizeConfig({ enabled: true }).style, 'classic');
        assert.equal(s.Page.normalizeConfig({ style: 'ali' }).style, 'classic');
        assert.equal(s.Page.normalizeConfig({ style: 'paper' }).style, 'paper');
    });

    it('sends the choice with the section, and ignores a value that is neither', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        assert.equal(s.Page.settingsPayload().style, 'classic');
        s.Page.setting(pick('Paper'));
        assert.equal(s.Page.work.style, 'classic');
        s.Page.setting(pick('paper'));
        assert.equal(s.Page.work.style, 'paper');
        assert.equal(s.Page.settingsPayload().style, 'paper');
        s.Page.destroy();
    });

    it('says it in Arabic too', () => {
        const s = loadMonteur('ar');
        for (const key of KEYS) {
            assert.notEqual(s.t(key), key, key);
            assert.match(s.t(key), /[\u0600-\u06FF]/, key);
        }
    });
});

describe('Monteur — human touches: camera cuts, doodles, highlights, transitions, freeze-frames (MONTEUR.md §6.2)', () => {
    const tick = (checked: boolean): FakeEl => fakeEl('mt-human', { dataset: { key: 'human' }, checked });
    const KEYS = ['monteur.settings.human', 'monteur.settings.humanHint'];

    it('the settings card asks it as a checkbox, in both forms, checked by default', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        assert.equal(s.t('monteur.settings.human'), 'Human touches (camera cuts, doodles, highlights, transitions, freeze-frames)');
        assert.match(s.t('monteur.settings.humanHint'), /only for videos of you talking to camera/);
        for (const form of [String(s.Page.formMarkup()), String(s.Page.setupMarkup())]) {
            const box = tagOf(form, 'mt-human');
            assert.ok(box.startsWith('<input') && box.includes('type="checkbox"') && box.includes('data-change="monteur:setting"') && box.includes('data-key="human"'), box);
            assert.ok(box.includes('checked'), 'on by default');
            assert.ok(box.includes('aria-describedby="mt-human-hint"'));
            for (const key of KEYS) assert.ok(form.includes(escaped(s.t(key))), key);
        }
        s.Page.destroy();
    });

    it('shows a saved off as unchecked, and reads a section saved before it existed as on', async () => {
        const s = loadMonteur('en');
        stub(s, monteurView({ settings: settings({ human: false }) }));
        await renderPage(s);
        assert.ok(!tagOf(String(s.Page.formMarkup()), 'mt-human').includes('checked'));
        assert.equal(s.Page.normalizeConfig({ enabled: true }).human, true);
        assert.equal(s.Page.normalizeConfig({ human: 'no' }).human, true);
        assert.equal(s.Page.normalizeConfig({ human: false }).human, false);
        s.Page.destroy();
    });

    it('sends the choice with the section', async () => {
        const s = loadMonteur('en');
        stub(s);
        await renderPage(s);
        assert.equal(s.Page.settingsPayload().human, true);
        s.Page.setting(tick(false));
        assert.equal(s.Page.work.human, false);
        assert.equal(s.Page.settingsPayload().human, false);
        s.Page.setting(tick(true));
        assert.equal(s.Page.settingsPayload().human, true);
        s.Page.destroy();
    });

    it('says it in Arabic too', () => {
        const s = loadMonteur('ar');
        for (const key of KEYS) {
            assert.notEqual(s.t(key), key, key);
            assert.match(s.t(key), /[\u0600-\u06FF]/, key);
        }
    });
});
