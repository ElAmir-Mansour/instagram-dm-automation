/**
 * The draft assist on the wizard's first step (P24): `dashboard/js/pages/welcome_draft.js`, plugged into the wizard through its own seam. The REAL
 * files (the wizard, the draft client, the assist, the dictionaries) run in a `node:vm` context against a small in-memory form, and the drafts are made
 * by the server's own `validateDraft` and `toDraftView` from the engine's fixtures, so the page and the server cannot drift apart without this failing.
 *
 * What is pinned, because each is a way the assist hurts somebody:
 *   - NEVER over what they typed: a suggestion exists only for a field that is empty at that moment, typing takes it away at once, and "Use this" on a
 *     field that was typed in since the list was drawn does nothing. There is no button that replaces text;
 *   - nothing reaches the profile: "Use this" fills the form's field and the wizard's own autosave takes it from there (Next confirms it);
 *   - the draft is data: every value (a name, a niche, a quote from a bio) reaches the page as escaped text and a field through `.value`;
 *   - the states: no draft, being made (and "Start without waiting"), ready, no AI key (a short note and what code found), unreadable, and "no draft
 *     here" (an older server or a finished wizard), which is the plain form with nothing said;
 *   - 375 px in both languages: every string exists in both, and the stylesheet lets a long value wrap and stacks the buttons on a phone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { defaultProfile } from '../services/profile/defaults.js';
import { WIZARD_STEPS } from '../services/onboardingWizard.js';
import type { DraftRow } from '../services/onboarding/draftStore.js';
import { emptyUsage, type FetchedBundle, type ResultColumn, type SourcesStatus } from '../services/onboarding/draftTypes.js';
import { toDraftView } from '../services/onboarding/draftView.js';
import { okBusiness, okVoice, STORE_CANDIDATES, STORE_SOURCES, storeSignals } from '../services/onboarding/fixtures/draftAnswers.js';
import { validateDraft } from '../services/onboarding/validateDraft.js';

// ─── Drafts, made by the server ─────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 14, 9, 0, 0);
const at = (ms: number): Date => new Date(NOW + ms);
const ok = { state: 'ok', via: 'x', kind: null, retryable: false, message: null, ms: 5, counts: {} } as const;
const STATUS: SourcesStatus = { instagram: { ...ok }, website: { ...ok }, youtube: { ...ok, state: 'skipped', kind: 'no_input' }, typed: { ...ok, state: 'skipped', kind: 'no_input' } };
const bundle = (): FetchedBundle => ({
    version: 1, sources: STORE_SOURCES, candidates: STORE_CANDIDATES, signals: storeSignals(),
    facts: { handle: 'noor.perfumes', handleMismatch: false, igName: null, followers: 1, mediaCount: 1, siteHost: null, site: null, brand: null, logos: [], socialLinks: {}, youtube: null, knownUrls: [], knownEmails: [], knownPhones: [], keywordsInUse: [] },
});
const CODE: ResultColumn['code'] = { handle: 'noor.perfumes', handleMismatch: false, igName: null, followers: 1, mediaCount: 1, siteHost: null, site: null, brand: null, logos: [], socialLinks: {}, youtube: null };
const ctx = { sources: STORE_SOURCES, signals: storeSignals(), candidates: STORE_CANDIDATES, code: { brand: { primary: '#7B3F61', accent: '#E0A458' }, socials: { handle: 'noor.perfumes', site: 'https://noor-perfumes.example/', links: {} } } };
const row = (over: Partial<DraftRow>): DraftRow => ({
    id: '00000000-0000-4000-8000-000000000001', creator_id: '00000000-0000-4000-8000-000000000100', origin: 'wizard', requested_by: null,
    inputs: { instagram: 'noor.perfumes', website: null, youtube: null, about: null, via: 'discovery' }, inputs_hash: 'h', prompt_version: 'profile_draft_v1', status: 'queued',
    attempts: 0, next_attempt_at: null, lease_until: null, lease_owner: null, sources: null, sources_status: null, draft: null, partial: false, usage: emptyUsage(),
    error: null, error_kind: null, created_at: at(-60_000), updated_at: at(-1_000), finished_at: null, ...over,
});
const wire = (r: DraftRow) => JSON.parse(JSON.stringify(toDraftView(r, { audience: 'tenant', nowMs: NOW })));
const final = (voice: unknown = okVoice(), business: unknown = okBusiness()): ResultColumn => ({ stage: 'final', result: validateDraft({ voice, business }, ctx), code: CODE, models: {}, promptVersion: 'profile_draft_v1' });

const READY = (voice?: unknown, business?: unknown) => wire(row({ status: 'ready', sources: bundle(), sources_status: STATUS, draft: final(voice, business), finished_at: at(0), updated_at: at(0) }));
const WORKING = (status: 'queued' | 'fetching' | 'drafting' = 'drafting') => wire(row({ status, sources: status === 'drafting' ? bundle() : null, lease_owner: 'x', lease_until: at(200_000) }));
const RETRYING = () => wire(row({ status: 'drafting', sources: bundle(), attempts: 1, next_attempt_at: at(40_000), error_kind: 'timeout', error: 'slow' }));
const NEEDS_KEY = () => wire(row({ status: 'failed', sources: bundle(), sources_status: STATUS, draft: { stage: 'prefill', result: validateDraft({}, ctx), code: CODE, models: {}, promptVersion: 'profile_draft_v1' } as ResultColumn, error_kind: 'no_provider', error: 'No AI provider has a key.', finished_at: at(0), updated_at: at(0) }));
const NO_SOURCE = () => wire(row({ status: 'failed', error_kind: 'no_source', error: 'Nothing could be read.', finished_at: at(0), updated_at: at(0) }));

// ─── The sandbox: the real files, and a form that remembers what is done to it ──────────────────

function element(initial: string[] = []): Record<string, any> {
    const classes = new Set(initial);
    const handlers: Record<string, Array<() => void>> = {};
    return {
        classes, handlers, value: '', checked: false, textContent: '', innerHTML: '', disabled: false, style: {}, dataset: {}, offsetWidth: 120,
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), toggle: () => false, contains: (c: string) => classes.has(c) },
        setAttribute: () => undefined, getAttribute: () => null, removeAttribute: () => undefined, focus() { (this as any).focused = true; },
        addEventListener(type: string, fn: () => void) { (handlers[type] ??= []).push(fn); }, removeEventListener: () => undefined, remove: () => undefined,
        querySelector: () => null, querySelectorAll: () => [], closest: () => null, contains: () => false, appendChild: () => undefined,
    };
}

interface Net { posts: Array<{ path: string; method: string; body: any }>; answer: (path: string, method: string, body: any) => unknown }

/** What `load` hands back: the page's globals (untyped: they are plain JavaScript), and the handles on the fake page around them. */
interface Loaded {
    WelcomePage: any;
    WelcomeDraft: any;
    DraftClient: any;
    UI: any;
    html: any;
    t: (key: string) => string;
    el: Record<string, Record<string, any>>;
    kinds: Record<string, Record<string, any>>;
    net: Net;
    saves: string[];
    announced: string[];
    flush: () => Promise<void>;
    sandbox: Record<string, any>;
    advance: (ms: number) => Promise<void>;
}

function load(options: { lang?: 'ar' | 'en'; assist?: boolean; net?: (path: string, method: string, body: any) => unknown } = {}): Loaded {
    const lang = options.lang ?? 'en';
    const noop = (): void => {};
    const ids = ['welcome-root', 'welcome-form', 'welcome-assist', 'welcome-suggest', 'welcome-name', 'welcome-niche', 'welcome-offer', 'welcome-url', 'welcome-price', 'welcome-country',
        'welcome-timezone', 'welcome-draft-handle', 'welcome-draft-site', 'welcome-save', 'welcome-next', 'welcome-title'];
    const el: Record<string, Record<string, any>> = Object.fromEntries(ids.map((id) => [id, element()]));
    // The page repaints the whole panel with one assignment and the list alone with another: a repaint of the panel makes the list's last write stale.
    let panelHtml = '';
    Object.defineProperty(el['welcome-assist']!, 'innerHTML', { get: () => panelHtml, set: (v: string) => { panelHtml = v; el['welcome-suggest']!.innerHTML = ''; } });
    el['login-screen'] = element(); el.app = element(['hidden']); el['invite-screen'] = element(['hidden']); el['welcome-screen'] = element(['hidden']);
    const kinds: Record<string, Record<string, any>> = {};
    const saves: string[] = [];
    const announced: string[] = [];
    const net: Net = { posts: [], answer: options.net ?? (() => ({ draft: null })) };
    const timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let tick = 0;
    let nextTimer = 1;

    const API = {
        token: 't', setToken: noop, clearToken: noop,
        request: async (path: string, init: { method?: string; body?: string } = {}) => {
            const method = init.method ?? 'GET';
            const body = init.body ? JSON.parse(init.body) : undefined;
            net.posts.push({ path, method, body });
            const answer = net.answer(path, method, body);
            if (answer instanceof Error) throw answer;
            return answer;
        },
        saveOnboardingStep: (step: string, body: unknown) => { saves.push(`${step}:${JSON.stringify(body)}`); return Promise.resolve({}); },
    };
    const sandbox: Record<string, any> = {
        document: {
            ...element(), createElement: () => element(), body: element(), head: element(), documentElement: { ...element(), lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => el[id] ?? null, activeElement: null, currentScript: null, visibilityState: 'visible',
            querySelector: (selector: string) => {
                const m = /input\[name="kind"\]\[value="([a-z]+)"\]/.exec(selector);
                return m ? (kinds[m[1]!] ??= element()) : null;
            },
            querySelectorAll: () => [], contains: () => true, addEventListener: noop,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' }, scrollTo: noop, innerHeight: 800 },
        location: { hash: '', pathname: '/dashboard', search: '' }, history: { replaceState: noop, pushState: noop }, localStorage: { getItem: () => null, setItem: noop, removeItem: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        Intl, console, setTimeout, clearTimeout, URL, URLSearchParams, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang, userAgent: 'Mozilla/5.0 Chrome/120' }, crypto: { getRandomValues: (a: Uint8Array) => a }, CSS: { escape: (v: string) => String(v) },
        API, Motion: { announce: (m: string) => announced.push(m), transition: (f: () => void) => { f(); return Promise.resolve(); }, markSkeleton: noop },
        // The form's controls as the wizard reads them from `FormData(form)`: by name, from the elements above.
        FormData: class {
            private readonly entries: Array<[string, string]>;
            constructor() {
                const checked = Object.entries(kinds).find(([, r]) => r.checked);
                this.entries = [
                    ['name', el['welcome-name']!.value], ['niche', el['welcome-niche']!.value], ['offerName', el['welcome-offer']!.value], ['offerUrl', el['welcome-url']!.value],
                    ['price', el['welcome-price']!.value], ['country', el['welcome-country']!.value], ['timezone', el['welcome-timezone']!.value || 'UTC'], ['orderVia', 'url'],
                    ...(checked ? [['kind', checked[0]] as [string, string]] : []),
                ];
            }
            forEach(cb: (value: string, key: string) => void): void { this.entries.forEach(([k, v]) => cb(v, k)); }
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const files = ['dashboard/js/i18n.js', `dashboard/js/i18n.${lang}.js`, 'dashboard/js/components.js', 'dashboard/js/pages/welcome.js', 'dashboard/js/pages/draft_client.js',
        ...(options.assist === false ? [] : ['dashboard/js/pages/welcome_draft.js']), 'dashboard/js/app.js'];
    for (const file of files) vm.runInContext(readFileSync(file, 'utf8'), sandbox, { filename: file });
    vm.runInContext(`I18N.lang = '${lang}'`, sandbox);

    // The page-module loader of the real app fetches a script; here the files are already in.
    vm.runInContext(`
        App.loadPageModule = async (name) => (name === 'draft_client' ? DraftClient : name === 'welcome_draft' && typeof WelcomeDraft !== 'undefined' ? WelcomeDraft : null);
        globalThis.__timers = null;
    `, sandbox);
    // The draft client polls with timers the test turns by hand.
    const fakeTimers = {
        set: (fn: () => void, ms: number) => { const id = nextTimer++; timers.push({ at: tick + ms, fn, id }); return id; },
        clear: (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    };
    sandbox.__fakeTimers = fakeTimers;
    vm.runInContext(`{ const real = DraftClient.create; DraftClient.create = (o) => real(Object.assign({ timers: __fakeTimers, visible: () => true }, o || {})); }`, sandbox);

    const out = vm.runInContext('({ WelcomePage, UI, html, DraftClient, t, WelcomeDraft: typeof WelcomeDraft === "undefined" ? null : WelcomeDraft })', sandbox) as Record<string, any>;
    const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
    return {
        WelcomePage: out.WelcomePage, WelcomeDraft: out.WelcomeDraft, DraftClient: out.DraftClient, UI: out.UI, html: out.html, t: out.t as (key: string) => string,
        el, kinds, net, saves, announced, flush, sandbox,
        async advance(ms: number) {
            const end = tick + ms;
            for (;;) {
                const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
                if (!due) break;
                timers.splice(timers.indexOf(due), 1);
                tick = Math.max(tick, due.at);
                due.fn();
                await flush();
            }
            tick = end;
        },
    };
}

const plain = <T,>(v: unknown): T => JSON.parse(JSON.stringify(v === undefined ? null : v)) as T;

const ORDER = WIZARD_STEPS.map((s) => ({ ...s }));
const onboarding = (over: Record<string, unknown> = {}): Record<string, any> => ({
    status: 'in_progress', step: 'about', order: ORDER, steps: {}, filledBy: null, profile: defaultProfile({ lang: 'ar' }), version: 1, stored: true, missing: [],
    hints: { name: '', instagramUsername: 'nourshop', websiteUrl: 'https://nour.example' }, canEdit: true, draft: null, ...over,
});

/** The wizard on its first step, painted, with the assist attached and the draft read. */
async function openFirstStep(s: Loaded, onb = onboarding()): Promise<Record<string, any>> {
    const P = s.WelcomePage;
    P.defineSteps();
    const state = P.freshState();
    state.phase = 'ready';
    state.onb = onb;
    state.step = 'about';
    state.values = P.STEPS.about.initial(onb, false);
    P.state = state;
    // Paint as the wizard does: the markup, then the step's `after`.
    s.el['welcome-root']!.innerHTML = String(P.view(state));
    P.STEPS.about.after(s.el['welcome-root'], state);
    await s.flush();
    return state;
}

const panel = (s: Loaded): string => String(s.el['welcome-assist']!.innerHTML);
const suggest = (s: Loaded): string => {
    const written = String(s.el['welcome-suggest']!.innerHTML);
    if (written) return written;
    const inside = /<div id="welcome-suggest"[^>]*>([\s\S]*)<\/div>\s*$/.exec(panel(s).trim());
    return inside ? inside[1]! : '';
};
const serve = (view: unknown) => (path: string, method: string) => (path === '/onboarding/draft' && method === 'GET' ? { draft: view } : new Error(`unhandled ${method} ${path}`));

const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';

/** A ready draft whose every value and quote is `PAYLOAD`. The server's validator takes angle brackets out, so this is made on the wire, as a hostile or broken server could send it. */
function hostileReady(): any {
    const view = READY();
    const profile = view.draft.profile;
    profile.identity.display_name = { ar: PAYLOAD, en: PAYLOAD };
    profile.identity.niche = PAYLOAD;
    profile.identity.country = 'SA';
    profile.offers = [{ name: PAYLOAD, url: 'https://noor-perfumes.example/p', price: PAYLOAD, primary: true }];
    for (const path of Object.keys(view.draft.provenance)) view.draft.provenance[path] = { source: 'bio', evidence: PAYLOAD, confidence: 'high' };
    view.draft.flags = [{ path: 'identity.niche', kind: 'removed_from_text', detail: PAYLOAD }];
    return view;
}

function assertInert(markup: string, label: string): void {
    assert.ok(!markup.includes('<img src=x'), `${label}: no live img tag`);
    assert.ok(!markup.includes('<script'), `${label}: no live script tag`);
    assert.ok(!/\son[a-z]+\s*=/i.test(markup.replace(/&lt;[^<>]*/g, '')), `${label}: no live handler`);
    assert.ok(!/javascript:/i.test(markup), `${label}: no javascript: address`);
}

// ─── The seam ───────────────────────────────────────────────────────────────────────────────────

describe('the assist plugs into the wizard\'s seam and the wizard works without it', () => {
    it('the first step carries an assist and a wiring hook, and the others do not', () => {
        const s = load();
        s.WelcomePage.defineSteps();
        assert.equal(typeof s.WelcomePage.STEPS.about.assist, 'function');
        assert.equal(typeof s.WelcomePage.STEPS.about.after, 'function');
        assert.equal(s.WelcomePage.STEPS.voice.assist, undefined);
    });

    it('the panel is above the form and outside it, so typing in it can neither submit nor autosave the step', async () => {
        const s = load({ net: serve(null) });
        await openFirstStep(s);
        const markup = String(s.el['welcome-root']!.innerHTML);
        assert.ok(markup.indexOf('id="welcome-assist"') > -1 && markup.indexOf('id="welcome-assist"') < markup.indexOf('id="welcome-form"'));
        const formAt = markup.indexOf('id="welcome-form"');
        assert.equal(markup.slice(formAt).includes('welcome-assist'), false);
    });

    it('without the file the wizard is the plain form it was: no panel, no error', () => {
        const s = load({ assist: false });
        s.WelcomePage.defineSteps();
        const onb = onboarding();
        const state = s.WelcomePage.freshState();
        state.phase = 'ready'; state.onb = onb; state.step = 'about'; state.values = s.WelcomePage.STEPS.about.initial(onb, false);
        assert.equal(String(s.WelcomePage.view(state)).includes('welcome-assist'), false);
        assert.doesNotThrow(() => s.WelcomePage.STEPS.about.after(s.el['welcome-root'], state));
        assert.equal(s.WelcomePage.STEPS.about.assist(state), '');
    });

    it('is registered as a module that is not a route, and the wizard loads it on start without ever failing for it', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /welcome_draft: \{ src: 'welcome_draft', page: \(\) => WelcomeDraft, routable: false \}/);
        const welcome = readFileSync('dashboard/js/pages/welcome.js', 'utf8');
        assert.match(welcome, /await this\.loadAssist\(\);\s*await this\.load\(\);/);
        assert.match(welcome, /catch \{ \/\* the plain form \*\/ \}/);
    });

    it('leaving the wizard stops the polling and forgets the draft', async () => {
        const s = load({ net: serve(WORKING()) });
        await openFirstStep(s);
        assert.ok(s.WelcomeDraft.client);
        s.WelcomePage.destroy();
        assert.equal(s.WelcomeDraft.client, null);
        assert.equal(s.WelcomeDraft.s.phase, 'idle');
    });
});

// ─── No draft yet ───────────────────────────────────────────────────────────────────────────────

describe('"Fill it for me": starting', () => {
    it('with no draft it offers the two fields, filled in with what the operator typed, and the button', async () => {
        const s = load({ net: serve(null) });
        await openFirstStep(s);
        const html = panel(s);
        assert.match(html, /Fill it in for me/);
        assert.match(html, /value="nourshop"/);
        assert.match(html, /value="https:\/\/nour\.example"/);
        assert.match(html, /data-action="welcomeDraft:start"/);
        assert.match(html, /Fill it for me/);
        assert.equal(s.WelcomeDraft.s.phase, 'none');
    });

    it('sends BOTH fields as they are now (an emptied one is a real "not this one") and then shows it being made', async () => {
        const s = load({ net: (path, method) => (method === 'GET' ? { draft: null } : path === '/onboarding/draft' ? { draft: WORKING('queued'), reused: false } : { draft: WORKING('queued') }) });
        await openFirstStep(s);
        s.el['welcome-draft-handle']!.value = '@noor.perfumes';
        s.el['welcome-draft-site']!.value = '';
        await s.WelcomeDraft.start();
        const post = s.net.posts.find((p) => p.method === 'POST' && p.path === '/onboarding/draft')!;
        assert.deepEqual(post.body, { instagram: '@noor.perfumes', website: '' });
        assert.equal(s.WelcomeDraft.s.phase, 'working');
        assert.match(panel(s), /Reading your accounts/);
        assert.match(panel(s), /Start without waiting/);
    });

    it('a start that is refused says why, in words, and keeps the fields', async () => {
        const refusal = (status: number, body: unknown) => Object.assign(new Error('refused'), { status, body });
        for (const [err, expected] of [
            [refusal(400, { code: 'INVALID_INPUT', field: 'instagram' }), /does not look like an Instagram name/],
            [refusal(400, { code: 'INVALID_INPUT', field: 'website' }), /does not look like a website address/],
            [refusal(400, { code: 'NO_INPUTS' }), /Give your Instagram name or your website first/],
            [refusal(429, { code: 'DRAFT_LIMIT' }), /enough suggestions today/],
            [Object.assign(new Error('x'), { isNetworkError: true }), /No connection/],
            [refusal(500, null), /That did not work/],
        ] as Array<[Error, RegExp]>) {
            const s = load({ net: (path, method) => (method === 'GET' ? { draft: null } : err) });
            await openFirstStep(s);
            s.el['welcome-draft-handle']!.value = 'nourshop';
            await s.WelcomeDraft.start();
            assert.match(panel(s), expected);
            assert.match(panel(s), /value="nourshop"/);
            assert.equal(s.WelcomeDraft.s.busy, false);
        }
    });
});

// ─── Being made ─────────────────────────────────────────────────────────────────────────────────

describe('while the draft is being made', () => {
    it('says what it is doing at each step, and when it is waiting out a failed try', async () => {
        const cases: Array<[unknown, RegExp]> = [[WORKING('queued'), /Reading your accounts/], [WORKING('fetching'), /Reading your accounts/], [WORKING('drafting'), /Writing suggestions/], [RETRYING(), /Trying again in a moment/]];
        for (const [view, expected] of cases) {
            const s = load({ net: serve(view) });
            await openFirstStep(s);
            assert.match(panel(s), expected);
        }
    });

    it('"Start without waiting" folds the panel to one line, leaves the form theirs, and brings the suggestions when they are ready', async () => {
        const server: { view: any } = { view: WORKING('drafting') };
        const s = load({ net: (path, method) => (method === 'GET' ? { draft: server.view } : new Promise(() => undefined) as never) });
        await openFirstStep(s);
        s.WelcomeDraft.skipWaiting();
        assert.equal(s.WelcomeDraft.s.compact, true);
        assert.equal(s.el['welcome-name']!.focused, true, 'focus goes to the form');
        assert.match(panel(s), /Still reading your accounts/);
        assert.doesNotMatch(panel(s), /Start without waiting/);
        server.view = READY();
        await s.advance(3_000);
        assert.equal(s.WelcomeDraft.s.compact, false);
        assert.equal(s.WelcomeDraft.s.phase, 'ready');
        assert.match(panel(s), /Here is what we found/);
        assert.ok(s.announced.includes('Suggestions are ready.'), 'a screen reader is told');
    });

    it('fires advance once for a draft nobody is working on, as the poll says', async () => {
        const s = load({ net: (path, method) => (method === 'GET' ? { draft: wire(row({ status: 'drafting', sources: bundle() })) } : new Promise(() => undefined) as never) });
        await openFirstStep(s);
        await s.advance(10_000);
        assert.equal(s.net.posts.filter((p) => p.path === '/onboarding/draft/advance').length, 1);
    });
});

// ─── Ready: suggestions, never over what they typed ─────────────────────────────────────────────

describe('a ready draft is suggestions, one per field, for the fields that are empty', () => {
    it('suggests each empty field, named as the form names it, with where it came from', async () => {
        const s = load({ net: serve(READY()) });
        await openFirstStep(s);
        const html = suggest(s);
        assert.match(html, /What do you do\?/);
        assert.match(html, /shop/i);
        assert.match(html, /What is it about\? One line/);
        assert.match(html, /Your main offer/);
        assert.match(html, /From your Instagram bio|From one of your posts|From your website/);
        assert.match(html, /data-action="welcomeDraft:use"/);
        assert.match(html, /data-action="welcomeDraft:dismiss"/);
        assert.match(panel(s), /Anything you have already written stays as you wrote it/);
    });

    it('a field that already has something (the operator\'s name, what they typed, an earlier visit) is not offered over', async () => {
        const s = load({ net: serve(READY()) });
        const onb = onboarding({ hints: { name: 'Nour Shop', instagramUsername: 'nourshop', websiteUrl: '' }, steps: { about: { values: { niche: 'my own niche words', offerName: 'My own offer' } } } });
        await openFirstStep(s, onb);
        const fields = plain<Array<{ field: string }>>(s.WelcomeDraft.suggestionsFor(s.WelcomeDraft.s.view, s.WelcomePage.state.values, [])).map((x) => x.field);
        assert.equal(fields.includes('name'), false, 'the name the operator typed stays');
        assert.equal(fields.includes('niche'), false);
        assert.equal(fields.includes('offerName'), false);
        assert.ok(fields.includes('kind'));
    });

    it('typing in a field takes its suggestion away at once, and what was typed is never touched', async () => {
        const s = load({ net: serve(READY()) });
        await openFirstStep(s);
        assert.match(suggest(s), /What is it about\? One line/);
        s.el['welcome-niche']!.value = 'عطور';
        // The form's own input event, as the page wires it.
        for (const fn of s.el['welcome-form']!.handlers.input ?? []) fn();
        assert.doesNotMatch(suggest(s), /What is it about\? One line/);
        assert.equal(s.el['welcome-niche']!.value, 'عطور');
    });

    it('"Use this" puts the value in the empty field, lets the wizard save it, and the suggestion goes', async () => {
        const s = load({ net: serve(READY()) });
        const state = await openFirstStep(s);
        let saved = 0;
        const realSave = s.WelcomePage.scheduleSave.bind(s.WelcomePage);
        s.WelcomePage.scheduleSave = () => { saved += 1; realSave(); };
        s.WelcomeDraft.use('niche');
        assert.equal(s.el['welcome-niche']!.value, 'عطور شرقية وغربية أصلية');
        assert.equal(saved, 1, 'the wizard\'s own autosave');
        assert.doesNotMatch(suggest(s), /What is it about\? One line/);
        assert.equal(state.onb.profile.identity.niche, defaultProfile({ lang: 'ar' }).identity.niche, 'the profile is untouched: Next confirms it');
        assert.equal(s.net.posts.some((p) => p.method === 'PATCH'), false, 'nothing was sent to the profile');
        assert.ok(s.announced.includes('Added to the form.'));
        clearTimeout(s.WelcomePage._saveTimer);
    });

    it('"Use this" for a kind chooses its radio; for a country, its option', async () => {
        const s = load({ net: serve(READY(Object.assign(okVoice(), {}), okBusiness())) });
        await openFirstStep(s);
        s.WelcomeDraft.use('kind');
        assert.equal(s.kinds.shop?.checked, true);
        s.WelcomeDraft.use('country');
        assert.equal(s.el['welcome-country']!.value, 'SA');
        clearTimeout(s.WelcomePage._saveTimer);
    });

    it('does nothing for a field typed in since the list was drawn: there is no button that replaces text', async () => {
        const s = load({ net: serve(READY()) });
        await openFirstStep(s);
        s.el['welcome-niche']!.value = 'typed a moment ago';
        s.WelcomeDraft.use('niche');
        assert.equal(s.el['welcome-niche']!.value, 'typed a moment ago');
        assert.doesNotMatch(suggest(s), /What is it about\? One line/);
    });

    it('"Not this" dismisses a suggestion for good, and the others stay', async () => {
        const s = load({ net: serve(READY()) });
        await openFirstStep(s);
        s.WelcomeDraft.dismiss('niche');
        assert.doesNotMatch(suggest(s), /What is it about\? One line/);
        assert.match(suggest(s), /Your main offer/);
        // A field cannot be dismissed that the page does not have, and a name is not a way in.
        s.WelcomeDraft.dismiss('__proto__');
        assert.deepEqual(plain(s.WelcomeDraft.s.dismissed), ['niche']);
    });

    it('an offer\'s link is suggested only if it is an address and the person sells by link; a country only if it is on the list', async () => {
        const business = okBusiness();
        business.offers[0].url = 'https://noor-perfumes.example/products/oud-alleil';
        const s = load({ net: serve(READY(okVoice(), business)) });
        await openFirstStep(s);
        const suggestions = (values: Record<string, string>) => plain<Array<{ field: string }>>(s.WelcomeDraft.suggestionsFor(s.WelcomeDraft.s.view, values, [])).map((x) => x.field);
        assert.ok(suggestions({}).includes('offerUrl'));
        assert.equal(suggestions({ orderVia: 'dm' }).includes('offerUrl'), false, 'a person who sells by message has no link to give');
        const view = READY();
        view.draft.profile.offers[0].url = 'javascript:alert(1)';
        view.draft.profile.identity.country = 'ZZ';
        const fields = plain<Array<{ field: string }>>(s.WelcomeDraft.suggestionsFor(view, {}, [])).map((x) => x.field);
        assert.equal(fields.includes('offerUrl'), false);
        assert.equal(fields.includes('country'), false);
    });

    it('a field the checker doubted says so: "check this one"', async () => {
        const view = READY();
        view.draft.flags.push({ path: 'offers[0].url', kind: 'offer_offdomain_url', detail: 'other.example' });
        const s = load({ net: serve(view) });
        await openFirstStep(s);
        const items = plain<Array<{ field: string; check: boolean }>>(s.WelcomeDraft.suggestionsFor(view, {}, []));
        assert.equal(items.find((x) => x.field === 'offerUrl')!.check, true);
        assert.equal(items.find((x) => x.field === 'niche')!.check, false);
        assert.match(suggest(s), /Please check this one before you use it/);
    });

    it('a partial draft says so, and a draft with nothing for the empty fields says that', async () => {
        const partial = READY();
        partial.partial = true;
        const s1 = load({ net: serve(partial) });
        await openFirstStep(s1);
        assert.match(panel(s1), /We could only read part of it/);
        const s2 = load({ net: serve(READY({}, {})) });
        await openFirstStep(s2);
        assert.match(suggest(s2), /Nothing more to suggest/);
    });

    it('a prefill (no assistant answered) has nothing for these fields, even if one carried a value for one', async () => {
        const s = load({ net: serve(NEEDS_KEY()) });
        await openFirstStep(s);
        assert.deepEqual(plain(s.WelcomeDraft.suggestionsFor(s.WelcomeDraft.s.view, {}, [])), []);
        // Not only because the code-made prefill happens not to have them: a value in the prefill column is not a suggestion either.
        const view = NEEDS_KEY();
        assert.ok(view.prefill && !view.draft, 'the key-less view carries the prefill column');
        view.prefill.profile.identity.niche = 'عطور';
        view.prefill.touched.push('identity.niche');
        assert.ok(s.DraftClient.fieldsOf(view).some((f: { key: string }) => f.key === 'identity.niche'), 'the client does read it');
        assert.deepEqual(plain(s.WelcomeDraft.suggestionsFor(view, {}, [])), []);
        view.draft = view.prefill;
        assert.equal(plain<unknown[]>(s.WelcomeDraft.suggestionsFor(view, {}, [])).length, 1, 'the same column as a draft would be');
    });
});

// ─── No key, nothing read, nothing here ─────────────────────────────────────────────────────────

describe('when there is no draft to show', () => {
    it('no AI key: a short "we\'ll fill this in later" and what was found without one, and nothing to suggest', async () => {
        const s = load({ net: serve(NEEDS_KEY()) });
        await openFirstStep(s);
        const html = panel(s);
        assert.match(html, /not switched on yet, so we will fill this in later/);
        assert.match(html, /What we found without it:/);
        assert.match(html, /@noor\.perfumes/);
        assert.match(html, /#7B3F61 #E0A458/);
        assert.doesNotMatch(html, /welcomeDraft:use/);
        assert.doesNotMatch(html, /No AI provider|no_provider|api key/i, 'the provider is never named');
    });

    it('nothing could be read: one sentence, and the two fields again to try other details', async () => {
        const s = load({ net: serve(NO_SOURCE()) });
        await openFirstStep(s);
        assert.match(panel(s), /We could not read anything from those/);
        assert.match(panel(s), /id="welcome-draft-handle"/);
    });

    it('any other failure: one sentence and the way to try again', async () => {
        const failed = wire(row({ status: 'failed', error_kind: 'timeout', error: 'slow', finished_at: at(0), updated_at: at(0) }));
        const s = load({ net: serve(failed) });
        await openFirstStep(s);
        assert.match(panel(s), /We could not make suggestions this time/);
        assert.match(panel(s), /welcomeDraft:start/);
    });

    it('a server with no such route, a wizard that is over, a database without the table: the plain form, and nothing said', async () => {
        for (const err of [Object.assign(new Error('Not found'), { status: 404 }), Object.assign(new Error('x'), { status: 409, body: { code: 'ONBOARDING_COMPLETED' } }), Object.assign(new Error('x'), { status: 500 }), Object.assign(new Error('x'), { isNetworkError: true })]) {
            const s = load({ net: () => err });
            await openFirstStep(s);
            assert.equal(s.WelcomeDraft.s.phase, 'off');
            assert.equal(panel(s), '');
        }
    });

    it('a draft replaced by a newer one starts again from the fields', async () => {
        const s = load({ net: serve(wire(row({ status: 'superseded', finished_at: at(0) }))) });
        await openFirstStep(s);
        assert.equal(s.WelcomeDraft.s.phase, 'none');
    });
});

// ─── The draft is data ──────────────────────────────────────────────────────────────────────────

describe('what a draft says reaches the page as text, and a field as a value', () => {
    it('a payload in every drafted value, in the quote and in the operator\'s hints is inert, in every state of the panel', async () => {
        const view = hostileReady();
        for (const v of [view, WORKING(), NEEDS_KEY(), NO_SOURCE()]) {
            const s = load({ net: serve(v) });
            await openFirstStep(s, onboarding({ hints: { name: '', instagramUsername: PAYLOAD, websiteUrl: '"><script>alert(1)</script>' } }));
            assertInert(panel(s) + suggest(s), String(v.status));
            if (v === view) assert.match(suggest(s), /&lt;img src=x/, 'the payload is on the page, as text');
        }
    });

    it('a markup value goes into the field as the string it is', async () => {
        const s = load({ net: serve(hostileReady()) });
        await openFirstStep(s);
        assert.match(suggest(s), /&lt;img src=x/);
        s.WelcomeDraft.use('niche');
        assert.equal(s.el['welcome-niche']!.value, PAYLOAD);
        clearTimeout(s.WelcomePage._saveTimer);
    });

    it('the module writes markup only through the page\'s own escaper and puts values in fields only through `.value` and `.checked`', () => {
        const source = readFileSync('dashboard/js/pages/welcome_draft.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.doesNotMatch(source, /\beval\s*\(|new Function|document\.write|insertAdjacentHTML|outerHTML/);
        for (const line of source.split('\n').filter((l) => /innerHTML\s*=/.test(l))) assert.match(line, /innerHTML = esc\(/, line.trim());
        assert.doesNotMatch(source, /\.setAttribute\(/);
    });
});

// ─── Phones, and both languages ─────────────────────────────────────────────────────────────────

describe('375 px, in Arabic and English', () => {
    const KEYS = [
        'title', 'lead', 'handle', 'site', 'start', 'starting', 'privacy', 'reading', 'writing', 'retrying', 'skip', 'skipHint', 'later', 'readyTitle', 'readyLead', 'partial', 'nothing', 'use', 'dismiss',
        'check', 'used', 'readyAnnounce', 'noKey', 'found', 'noSource', 'failed', 'src.bio', 'src.post', 'src.site', 'src.youtube', 'src.typed', 'src.guess', 'err.instagram', 'err.website', 'err.none',
        'err.limit', 'err.network', 'err.generic',
    ];

    for (const lang of ['ar', 'en'] as const) {
        it(`${lang}: every string the assist can say exists, the panel is the page's language and direction, and the values keep their own`, async () => {
            const s = load({ lang, net: serve(READY()) });
            await openFirstStep(s);
            for (const key of KEYS) assert.notEqual(s.t(`welcome.draft.${key}`), `welcome.draft.${key}`, `${lang} welcome.draft.${key}`);
            // Every value is isolated in its own direction, so an Arabic niche beside an English sentence (or the reverse) keeps its punctuation.
            for (const match of suggest(s).matchAll(/welcome-suggest-value"><bdi dir="auto">/g)) assert.ok(match[0]);
            assert.ok((suggest(s).match(/<bdi dir="auto">/g) ?? []).length >= 3);
            assert.match(panel(s), lang === 'ar' ? /[؀-ۿ]/ : /Here is what we found/);
        });
    }

    it('the stylesheet lets a long value wrap, keeps the suggestion inside the column and gives the buttons the full width on a phone', () => {
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /\.welcome-suggest \{[^}]*overflow-wrap: anywhere/);
        assert.match(css, /\.welcome-suggest \{[^}]*min-inline-size: 0/);
        // Mobile first, like the rest of the wizard: full width and a tap target by default, side by side from 40rem.
        assert.match(css, /\.welcome-suggest-actions \.btn \{ min-block-size: var\(--tap-target\); flex: 1 1 100%; \}/);
        assert.match(css, /@media \(min-width: 40rem\) \{[^@]*\.welcome-suggest-actions \.btn \{ flex: 0 1 auto; \}/);
        const block = css.slice(css.indexOf('.welcome-assist {'), css.indexOf('/* The bar sticks to the bottom'));
        assert.doesNotMatch(block, /\b(?:margin|padding|border)-(?:left|right)\b|\b(?:left|right):/, 'logical properties only, so it mirrors');
        assert.doesNotMatch(block, /#[0-9a-fA-F]{3,6}\b|rgb\(/, 'colours come from the tokens');
    });
});
