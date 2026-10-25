/**
 * The shared loader for tests of the dashboard's REAL JavaScript.
 *
 * The dashboard has no build step and no module system: every file is a classic script that declares globals (`const UI`, `const App`,
 * `const Attention` ...) in a page that has a DOM. A test of one of them therefore has to do what the browser does: evaluate the
 * shipped file, in a context that has those globals and a document. Each suite used to carry its own copy of that (fake elements, a
 * `document` stub, a list of files, the `vm.createContext` dance), and each copy drifted: buttons.test.ts, handoff.test.ts and
 * i18n-split.test.ts all grew a slightly different one. This is the reusable one, for the suites that follow it.
 *
 * `loadDashboard()` evaluates, in a fresh `node:vm` context and in the order index.html loads them:
 *   i18n.js, the catalogue for `lang` (i18n.ar.js | i18n.en.js), components.js, attention.js, motion.js,
 *   then app.js when `app: true`, then whatever else `files` names (a page module, admin_common.js ...).
 * What it hands back is the context plus the things a test needs to look at and drive: the fake document, the elements by id, the
 * window's and the document's listeners, every scroll, every replaceState, every announcement, every native confirm.
 *
 * What it deliberately is NOT: a browser. There is no layout, no real focus, no CSS and no network. `FakeEl` records what was done
 * to it (`focusCalls`, `attrs`, `classes`) and answers the few queries the shell makes; a test that needs more says so by adding to
 * `FakeEl` here, once, rather than stubbing it in its own file. Anything that needs real layout is verified live (constitution VI).
 *
 * Nothing here touches the network, a database or a secret: the context has no `fetch` and `API` is a stub that rejects.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Test code addresses dashboard globals that have no types (they are plain JavaScript): `Json` is the honest name for that.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

type Listener = (event: Json) => unknown;
const noop = (): void => {};

/** The slice of a DOM element the dashboard's shell and components actually use, recording what is done to it. */
export class FakeEl {
    readonly attrs = new Map<string, string>();
    readonly classes = new Set<string>();
    readonly listeners = new Map<string, Listener[]>();
    readonly children: FakeEl[] = [];
    readonly focusCalls: unknown[] = [];
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    innerHTML = '';
    textContent = '';
    value = '';
    disabled = false;
    checked = false;
    hidden = false;
    isConnected = true;
    offsetParent: unknown = {};
    offsetWidth = 120;
    offsetHeight = 40;
    parentNode: FakeEl | null = null;
    /** Set by a script or link element's owner (`head`) so a test can drive the load. */
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    rel = '';
    href = '';
    src = '';
    lang = '';
    dir = '';
    readonly classList = {
        add: (...names: string[]): void => { names.forEach((n) => this.classes.add(n)); },
        remove: (...names: string[]): void => { names.forEach((n) => this.classes.delete(n)); },
        toggle: (name: string, force?: boolean): boolean => {
            const on = force === undefined ? !this.classes.has(name) : force;
            if (on) this.classes.add(name); else this.classes.delete(name);
            return on;
        },
        contains: (name: string): boolean => this.classes.has(name),
    };

    constructor(public id = '', public readonly tag = 'div') {}

    get className(): string { return [...this.classes].join(' '); }
    set className(value: string) { this.classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c)); }

    setAttribute(name: string, value: unknown): void { this.attrs.set(name, String(value)); }
    getAttribute(name: string): string | null { return this.attrs.has(name) ? this.attrs.get(name)! : null; }
    removeAttribute(name: string): void { this.attrs.delete(name); }
    hasAttribute(name: string): boolean { return this.attrs.has(name); }

    addEventListener(type: string, fn: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    removeEventListener(type: string, fn: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn)); }

    appendChild(child: FakeEl): FakeEl { this.children.push(child); child.parentNode = this; return child; }
    remove(): void {
        this.isConnected = false;
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    focus(options?: unknown): void { this.focusCalls.push(options ?? null); }
    blur = noop;
    closest(): null { return null; }
    contains(other: unknown): boolean { return other === this; }
    querySelector(): null { return null; }
    querySelectorAll(): never[] { return []; }
    getBoundingClientRect(): Record<string, number> { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

export interface LoadOptions {
    /** The interface language: picks the catalogue and `I18N.lang`. Default 'en', so assertions can read the words. */
    lang?: 'ar' | 'en';
    /** The initial `location.hash`. */
    hash?: string;
    /** Evaluate app.js (`App`). */
    app?: boolean;
    /** More dashboard files to evaluate after the shared ones, in order (`dashboard/js/pages/inbox.js` ...). */
    files?: string[];
    /** Extra globals, or overrides of the default ones (`API`, `Admin`, `HealthStrip`). Put in the context BEFORE any file runs. */
    globals?: Record<string, unknown>;
}

export interface Dashboard {
    ctx: Json;
    /** Evaluate an expression in the page's global scope: `h.run('App')` reads a `const App` that is not a property of the context. */
    run<T = Json>(code: string): T;
    UI: Json;
    Attention: Json;
    Motion: Json;
    I18N: Json;
    /** `App`, when loaded with `app: true`. */
    App: Json;
    t: (key: string, params?: Record<string, unknown>) => string;
    /** The fake `document`, and the window and location the files see. */
    document: Json;
    window: Json;
    location: { hash: string; pathname: string };
    /** The element registered under `id`, created on first use. `init` is assigned onto it. */
    el(id: string, init?: Partial<FakeEl>): FakeEl;
    dom: Map<string, FakeEl>;
    head: FakeEl;
    /** `window`'s and `document`'s listeners by event type, and a way to fire them. */
    listeners: { window: Map<string, Array<{ fn: Listener; capture: boolean }>>; document: Map<string, Array<{ fn: Listener; capture: boolean }>> };
    fire(target: 'window' | 'document', type: string, event?: Record<string, unknown>): void;
    /** Every `window.scrollTo(...)` argument, every URL given to `history.replaceState`, and every `Motion.announce` text. */
    scrolls: Json[];
    replaced: string[];
    announcements: string[];
    /** The browser's own confirm(): what it was asked, and what it answers next. */
    native: { confirms: string[]; answer: boolean };
    /** Evaluate one more dashboard file in this context. */
    evalFile(path: string): void;
}

/** Let promises and zero-delay timers settle. */
export async function settle(rounds = 8): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export function loadDashboard(options: LoadOptions = {}): Dashboard {
    const lang = options.lang ?? 'en';
    const dom = new Map<string, FakeEl>();
    const scrolls: Json[] = [];
    const replaced: string[] = [];
    const announcements: string[] = [];
    const native = { confirms: [] as string[], answer: true };
    const listeners = {
        window: new Map<string, Array<{ fn: Listener; capture: boolean }>>(),
        document: new Map<string, Array<{ fn: Listener; capture: boolean }>>(),
    };
    const listen = (bucket: Map<string, Array<{ fn: Listener; capture: boolean }>>) => ({
        addEventListener: (type: string, fn: Listener, capture?: unknown): void => {
            bucket.set(type, [...(bucket.get(type) ?? []), { fn, capture: capture === true || (typeof capture === 'object' && capture !== null && (capture as { capture?: boolean }).capture === true) }]);
        },
        removeEventListener: (type: string, fn: Listener): void => {
            bucket.set(type, (bucket.get(type) ?? []).filter((l) => l.fn !== fn));
        },
    });

    const el = (id: string, init: Partial<FakeEl> = {}): FakeEl => {
        let found = dom.get(id);
        if (!found) { found = new FakeEl(id); dom.set(id, found); }
        Object.assign(found, init);
        return found;
    };

    const location = { hash: options.hash ?? '', pathname: '/dashboard', search: '', origin: 'https://example.test', reload: noop };
    const html = new FakeEl('html', 'html');
    html.lang = lang;
    html.dir = lang === 'ar' ? 'rtl' : 'ltr';
    const head = new FakeEl('head', 'head');
    const body = new FakeEl('body', 'body');
    // An element appended to the body under an id (the announcer's live region) can then be found by it, as in a browser.
    const bodyAppend = body.appendChild.bind(body);
    body.appendChild = (child: FakeEl): FakeEl => { if (child.id) dom.set(child.id, child); return bodyAppend(child); };

    const document: Json = {
        ...listen(listeners.document),
        title: '',
        documentElement: html,
        head,
        body,
        activeElement: null as FakeEl | null,
        visibilityState: 'visible',
        startViewTransition: undefined,
        getElementById: (id: string): FakeEl | null => dom.get(id) ?? null,
        createElement: (tag: string): FakeEl => new FakeEl('', String(tag).toLowerCase()),
        createTextNode: (text: string): FakeEl => { const n = new FakeEl('', '#text'); n.textContent = text; return n; },
        querySelector: (): null => null,
        querySelectorAll: (): never[] => [],
        contains: (node: FakeEl | null): boolean => !!node && node.isConnected !== false,
    };

    const history = {
        replaceState: (_state: unknown, _title: string, url?: string): void => {
            // The address changes and `hashchange` does NOT fire: that is the whole point of replaceState, and what the router relies on.
            replaced.push(String(url));
            const at = String(url).indexOf('#');
            location.hash = at === -1 ? '' : String(url).slice(at);
        },
        pushState: noop,
    };

    const window: Json = {
        ...listen(listeners.window),
        location,
        history,
        document,
        matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
        scrollTo: (arg: unknown): void => { scrolls.push(arg); },
        innerWidth: 1280,
        innerHeight: 900,
    };

    const storage = new Map<string, string>();
    const unref = <T>(handle: T): T => { (handle as { unref?: () => void }).unref?.(); return handle; };
    const ctx: Json = {
        document, window, location, history,
        Intl, console, URL, URLSearchParams, queueMicrotask,
        setTimeout: (fn: () => void, ms?: number) => unref(setTimeout(fn, ms)),
        setInterval: (fn: () => void, ms?: number) => unref(setInterval(fn, ms)),
        clearTimeout, clearInterval,
        requestAnimationFrame: (f: (t: number) => void): number => { f(0); return 0; },
        cancelAnimationFrame: noop,
        navigator: { language: lang, languages: [lang] },
        localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, String(v)); }, removeItem: (k: string) => { storage.delete(k); } },
        sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        CSS: { escape: (v: string) => String(v) },
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        lucide: { createIcons: noop },
        confirm: (message: string): boolean => { native.confirms.push(String(message)); return native.answer; },
        // No network in a test, and no API: a file that calls it without the test having stubbed it fails loudly.
        API: new Proxy({}, { get: (_target, prop) => (prop === 'token' ? 'test-token' : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
        ...(options.globals ?? {}),
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    const evalFile = (path: string): void => { vm.runInContext(readFileSync(path, 'utf8'), ctx, { filename: path }); };
    const run = <T = Json>(code: string): T => vm.runInContext(code, ctx) as T;

    const files = [
        'dashboard/js/i18n.js', `dashboard/js/i18n.${lang}.js`,
        'dashboard/js/components.js', 'dashboard/js/attention.js', 'dashboard/js/motion.js',
        ...(options.app ? ['dashboard/js/app.js'] : []),
        ...(options.files ?? []),
    ];
    files.forEach(evalFile);
    run(`I18N.lang = ${JSON.stringify(lang)};`);

    const UI = run('UI');
    const Motion = run('Motion');
    // Icons are a lucide DOM walk: not what any of these suites is about.
    UI.icons = noop;

    // Spy on announcements without silencing them: the real announcer still writes its live region.
    const announce = Motion.announce.bind(Motion) as (message: unknown) => void;
    Motion.announce = (message: unknown): void => { announcements.push(String(message)); announce(message); };

    const fire = (target: 'window' | 'document', type: string, event: Record<string, unknown> = {}): void => {
        (listeners[target].get(type) ?? []).forEach(({ fn }) => fn(event));
    };

    return {
        ctx, run, UI, Motion,
        Attention: run('Attention'),
        I18N: run('I18N'),
        App: options.app ? run('App') : undefined,
        t: run('t'),
        document, window, location, el, dom, head, listeners, fire, scrolls, replaced, announcements, native, evalFile,
    };
}
