/**
 * The shared patterns of the UX foundation, part B (`UI.pageHeader`, `UI.card`, `UI.emptyState`, `UI.confirm`, the toast's
 * action and `UI.undoToast`, `UI.tabs`, `UI.secretField`, `UI.field`, `UI.filterBar`, `UI.table`, `UI.pager`), loaded the way
 * buttons.test.ts and escaping.test.ts load the dashboard: the REAL files in a `node:vm` context, so these test what ships.
 *
 * What a screenshot cannot show, and what they pin:
 *
 *   - **nothing a server sent becomes markup.** A hostile string goes in every slot a builder has (title, label, hint, error, cell,
 *     chip, tab) and comes out as text; a class name derived from a word comes from a null-prototype table, so `constructor` and
 *     `__proto__` are not tones; a `javascript:` link is not a link;
 *   - **the old callers did not change.** `Admin.emptyState(icon, title, body)` draws byte for byte what it always drew,
 *     `Admin.confirm` / `Admin.runConfirm` / `Admin._pending` are the same behaviour under the old names, and
 *     `UI.toast(message, 'error')` still means what it meant;
 *   - **the secret field never stands for a value it does not show.** Saved, it has no input at all; it shows the last four characters
 *     and no more; the typed value is gone from the page once it is sent; the random value comes from the CSPRNG, never `Math.random`;
 *   - **Undo is real.** The promise settles `true` for Undo and `false` for everything else, no earlier than six seconds, and a failed
 *     `onUndo` does not turn into a delete;
 *   - **the discard question is no longer the browser's.** It is `UI.confirm` drawn over the modal; Escape answers it, and answering "no"
 *     leaves the modal and what is typed in it alone;
 *   - **the keyboard follows the page's direction**: in Arabic, the left arrow is the NEXT tab.
 *
 * The DOM here is small and honest: elements with children, attributes, classes and listeners, and a clock the test moves by hand.
 * It does not parse markup, so a builder's output is read as the string it is, and the handlers get the elements they would get.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Listener = (e: Json) => void;

// ─── The fake DOM ────────────────────────────────────────────────────────────────────────────

/** One compound selector: `tag#id.class[attr][attr="v"]`. */
function matchesCompound(n: FakeNode, compound: string): boolean {
    const m = /^([a-z0-9-]+)?((?:[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(compound);
    if (!m) return false;
    if (m[1] && m[1].toLowerCase() !== n.tag.toLowerCase()) return false;
    for (const part of m[2]!.match(/[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\]/g) ?? []) {
        if (part.startsWith('#')) { if (n.id !== part.slice(1)) return false; }
        else if (part.startsWith('.')) { if (!n.classes.has(part.slice(1))) return false; }
        else {
            const kv = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part)!;
            const have = n.getAttribute(kv[1]!);
            if (have === null) return false;
            if (kv[2] !== undefined && have !== kv[2]) return false;
        }
    }
    return true;
}

/** A selector list, with descendant combinators (whitespace) — enough for what the builders ask. */
function matchesSelector(n: FakeNode, selector: string): boolean {
    return selector.split(',').map((s) => s.trim()).filter(Boolean).some((one) => {
        const chain = one.split(/\s+/);
        if (!matchesCompound(n, chain[chain.length - 1]!)) return false;
        let at: FakeNode | null = n.parent;
        for (let i = chain.length - 2; i >= 0; i--) {
            while (at && !matchesCompound(at, chain[i]!)) at = at.parent;
            if (!at) return false;
            at = at.parent;
        }
        return true;
    });
}

class FakeNode {
    children: FakeNode[] = [];
    parent: FakeNode | null = null;
    attrs: Record<string, string> = {};
    classes = new Set<string>();
    handlers: Record<string, Listener[]> = {};
    textContent = '';
    innerHTML = '';
    outerHTML = '';
    value = '';
    type = '';
    dir = '';
    disabled = false;
    onclick: unknown = null;
    offsetWidth = 0;
    style: Record<string, string> = {};
    classList = {
        add: (c: string) => { this.classes.add(c); },
        remove: (c: string) => { this.classes.delete(c); },
        contains: (c: string) => this.classes.has(c),
        toggle: (c: string, force?: boolean) => { if (force === undefined ? !this.classes.has(c) : force) this.classes.add(c); else this.classes.delete(c); },
    };
    constructor(public tag: string, public doc: FakeDoc, public id = '') {}
    get className(): string { return [...this.classes].join(' '); }
    set className(v: string) { this.classes = new Set(v.split(/\s+/).filter(Boolean)); }
    get dataset(): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(this.attrs)) {
            if (k.startsWith('data-')) out[k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
        }
        return out;
    }
    get offsetParent(): object | null { return this.isConnected() ? {} : null; }
    isConnected(): boolean {
        let n: FakeNode | null = this;
        while (n) { if (n === this.doc.body) return true; n = n.parent; }
        return false;
    }
    setAttribute(k: string, v: string): void { if (k === 'id') this.id = String(v); this.attrs[k] = String(v); }
    getAttribute(k: string): string | null {
        if (k === 'id') return this.id || null;
        return k in this.attrs ? this.attrs[k]! : null;
    }
    removeAttribute(k: string): void { delete this.attrs[k]; }
    hasAttribute(k: string): boolean { return k in this.attrs; }
    appendChild(c: FakeNode): FakeNode { c.parent = this; this.children.push(c); return c; }
    remove(): void {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter((x) => x !== this);
        this.parent = null;
    }
    contains(n: FakeNode | null): boolean {
        let at = n;
        while (at) { if (at === this) return true; at = at.parent; }
        return false;
    }
    all(): FakeNode[] { return this.children.flatMap((c) => [c, ...c.all()]); }
    querySelector(sel: string): FakeNode | null { return this.all().find((n) => matchesSelector(n, sel)) ?? null; }
    querySelectorAll(sel: string): FakeNode[] { return this.all().filter((n) => matchesSelector(n, sel)); }
    closest(sel: string): FakeNode | null {
        let at: FakeNode | null = this;
        while (at) { if (matchesSelector(at, sel)) return at; at = at.parent; }
        return null;
    }
    addEventListener(type: string, fn: Listener): void { (this.handlers[type] ??= []).push(fn); }
    removeEventListener(type: string, fn: Listener): void { this.handlers[type] = (this.handlers[type] ?? []).filter((f) => f !== fn); }
    fire(type: string, extra: Json = {}): void {
        for (const fn of [...(this.handlers[type] ?? [])]) fn({ target: this, preventDefault() {}, ...extra });
    }
    click(): void { this.fire('click'); }
    focus(): void { this.doc.activeElement = this; }
}

class FakeDoc {
    body = new FakeNode('body', this);
    documentElement = new FakeNode('html', this);
    activeElement: FakeNode | null = null;
    listeners: Record<string, Listener[]> = {};
    createElement(tag: string): FakeNode { return new FakeNode(tag, this); }
    getElementById(id: string): FakeNode | null { return this.body.all().find((n) => n.id === id) ?? null; }
    querySelector(): null { return null; }
    contains(n: FakeNode | null): boolean { return !!n && n.isConnected(); }
    addEventListener(type: string, fn: Listener): void { (this.listeners[type] ??= []).push(fn); }
    removeEventListener(type: string, fn: Listener): void { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
    /** A key (or anything) at the document, the way the capture listeners see it. Returns whether it was prevented. */
    fire(type: string, extra: Json = {}): boolean {
        let prevented = false;
        for (const fn of [...(this.listeners[type] ?? [])]) fn({ target: this.activeElement ?? this.body, preventDefault() { prevented = true; }, ...extra });
        return prevented;
    }
    /** An element in the page, found by id. */
    add(tag: string, id: string, parent: FakeNode = this.body): FakeNode {
        const n = this.createElement(tag);
        n.id = id;
        parent.appendChild(n);
        return n;
    }
}

/** A clock the test moves by hand. */
class Timers {
    now = 0;
    private seq = 0;
    private queue: Array<{ id: number; at: number; fn: () => void }> = [];
    set = (fn: () => void, ms = 0): number => { const id = ++this.seq; this.queue.push({ id, at: this.now + ms, fn }); return id; };
    clear = (id: number): void => { this.queue = this.queue.filter((t) => t.id !== id); };
    pending(): number { return this.queue.length; }
    advance(ms: number): void {
        const until = this.now + ms;
        for (;;) {
            const next = this.queue.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (!next) break;
            this.queue = this.queue.filter((t) => t !== next);
            this.now = next.at;
            next.fn();
        }
        this.now = until;
    }
}

// ─── Loading the real files ──────────────────────────────────────────────────────────────────

interface Loaded {
    UI: Json;
    Admin: Json;
    html: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    SafeHtml: new (value: string) => object;
    doc: FakeDoc;
    timers: Timers;
    replaced: unknown[][];
    logs: unknown[][];
    window: Json;
    /** The two live regions, and the modal, as index.html has them. */
    alerts: FakeNode;
    status: FakeNode;
    overlay: FakeNode;
    content: FakeNode;
}

interface LoadOptions {
    dir?: 'rtl' | 'ltr';
    crypto?: boolean;
    app?: Json;
    getComputedStyle?: (el: FakeNode) => { direction: string };
    nativeConfirm?: () => boolean;
    regions?: boolean;
    /** What `navigator.clipboard.writeText` receives. */
    clipboard?: string[];
}

function load(options: LoadOptions = {}): Loaded {
    const doc = new FakeDoc();
    doc.documentElement.dir = options.dir ?? 'rtl';
    const timers = new Timers();
    const replaced: unknown[][] = [];
    const logs: unknown[][] = [];
    const window: Json = {
        addEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        location: { hash: '#/campaigns' },
        history: { state: null, replaceState: (...args: unknown[]) => { replaced.push(args); } },
    };
    const ctx: Record<string, unknown> = {
        document: doc,
        window,
        Intl, setTimeout: timers.set, clearTimeout: timers.clear, URLSearchParams,
        console: { log() {}, warn: (...a: unknown[]) => { logs.push(a); }, error: (...a: unknown[]) => { logs.push(a); } },
        requestAnimationFrame: (f: () => void) => f(),
        I18N: { lang: 'ar', locale: () => 'ar-u-nu-latn-ca-gregory', t: (k: string) => k, strings: { ar: {}, en: {} } },
        // The key and its parameters, so a test can read both.
        t: (k: string, p?: Record<string, unknown>) => (p ? `${k}|${Object.entries(p).map(([a, b]) => `${a}=${String(b)}`).join(',')}` : k),
        navigator: { language: 'ar', clipboard: options.clipboard ? { writeText: (v: string) => { options.clipboard!.push(v); return Promise.resolve(); } } : undefined },
        CSS: { escape: (v: string) => String(v) },
    };
    if (options.crypto) ctx.crypto = webcrypto;
    if (options.app) ctx.App = options.app;
    if (options.getComputedStyle) ctx.getComputedStyle = options.getComputedStyle;
    if (options.nativeConfirm) ctx.confirm = options.nativeConfirm;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const file of ['dashboard/js/components.js', 'dashboard/js/pages/admin_common.js']) {
        vm.runInContext(readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    const { UI, Admin, html, SafeHtml } = vm.runInContext('({ UI, Admin, html, SafeHtml })', ctx) as Pick<Loaded, 'UI' | 'Admin' | 'html' | 'SafeHtml'>;

    const withRegions = options.regions !== false;
    const alerts = withRegions ? doc.add('div', 'toast-alerts') : new FakeNode('div', doc);
    const status = doc.add('div', 'toast-container');
    const overlay = doc.add('div', 'modal-overlay');
    const content = doc.add('div', 'modal-content', overlay);
    return { UI, Admin, html, SafeHtml, doc, timers, replaced, logs, window, alerts, status, overlay, content };
}

const PAYLOAD = '<img src=x onerror=alert(document.cookie)>';
const BREAKOUT = '"><script>alert(1)</script><x y="';

/** No live tag, handler or script address in `out`, however it was reached. */
function assertInert(out: string, label = 'markup'): void {
    assert.ok(!out.includes('<img src=x'), `${label}: no live img tag`);
    assert.ok(!out.includes('<script'), `${label}: no live script tag`);
    assert.ok(!/"\s*>\s*<(script|img|x)\b/i.test(out), `${label}: nothing broke out of an attribute`);
    assert.ok(!/javascript:/i.test(out), `${label}: no javascript: address`);
    assert.ok(!/\son[a-z]+\s*=/i.test(out.replace(/&lt;[^<>]*/g, '')), `${label}: no live event handler`);
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** An object built inside the sandbox has the sandbox's Object.prototype: compare it by what it holds. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('UI.pageHeader', () => {
    it('draws the title, the line under it, the back link, the actions and the help link', () => {
        const { UI, html } = load();
        const out = String(UI.pageHeader({
            title: 'Ahmed Studio',
            subtitle: 'Where this tenant stands',
            back: { label: 'Tenants', href: '#/tenants' },
            actions: html`<button class="btn btn-primary">Save</button>`,
            help: 'worker#security',
        }));
        assert.match(out, /<header class="ui-page-head">/);
        assert.match(out, /<h2 class="ui-page-head-title" dir="auto">Ahmed Studio<\/h2>/);
        assert.match(out, /<p class="ui-page-head-subtitle" dir="auto">Where this tenant stands<\/p>/);
        assert.match(out, /<a class="btn btn-ghost btn-sm ui-page-back" href="#\/tenants">\s*<i data-lucide="arrow-left" aria-hidden="true"><\/i> Tenants<\/a>/);
        assert.match(out, /<div class="ui-page-head-actions"><button class="btn btn-primary">Save<\/button><\/div>/);
        assert.match(out, /href="#\/help\/worker#security"/);
    });

    it('a back control can be an action as well as a link, and the heading level can be nested', () => {
        const { UI } = load();
        const out = String(UI.pageHeader({ title: 'Draft', level: 3, back: { label: 'Back', action: 'studio:back', data: { id: 7 } } }));
        assert.match(out, /<h3 class="ui-page-head-title"/);
        assert.match(out, /data-action="studio:back"/);
        assert.match(out, /data-id="7"/);
    });

    it('draws only what it was given', () => {
        const { UI } = load();
        const out = String(UI.pageHeader({ title: 'Only a title' }));
        assert.ok(!out.includes('ui-page-head-subtitle') && !out.includes('ui-page-head-actions') && !out.includes('ui-page-back'));
    });

    it('a heading level that is not one of the allowed names is an h2 (the table has no prototype)', () => {
        const { UI } = load();
        for (const level of ['constructor', '__proto__', 'script', 9, 'h1']) {
            assert.match(String(UI.pageHeader({ title: 'T', level })), /<h2 class="ui-page-head-title"/, String(level));
        }
    });

    it('escapes every slot, and a javascript: back link is not a link', () => {
        const { UI } = load();
        const out = String(UI.pageHeader({
            title: PAYLOAD, subtitle: BREAKOUT, actions: PAYLOAD,
            back: { label: PAYLOAD, href: 'javascript:alert(1)' },
        }));
        assertInert(out, 'page header');
        assert.ok(out.includes('&lt;img src=x onerror=alert('), 'the payload is there, as text');
        assert.ok(!out.includes('ui-page-back'), 'no back link was drawn for an unsafe address');
    });
});

describe('UI.card', () => {
    it('is one head over one body, the title naming the section', () => {
        const { UI, html } = load();
        const out = String(UI.card({ id: 'k', title: 'Webhook', actions: html`<a class="btn">Edit</a>`, body: html`<p>Healthy</p>` }));
        assert.match(out, /<section class="surface ui-card" id="k" aria-labelledby="k-title">/);
        assert.match(out, /<div class="card-head">\s*<h2 class="card-title" id="k-title" dir="auto">Webhook<\/h2>/);
        assert.match(out, /<div class="card-head-actions"><a class="btn">Edit<\/a><\/div>/);
        assert.match(out, /<div class="card-body"><p>Healthy<\/p><\/div>/);
    });

    it('a tone is an edge class AND a glyph in the title, so it never rests on colour alone', () => {
        const { UI } = load();
        for (const [tone, icon] of [['info', 'info'], ['success', 'check-circle'], ['warning', 'alert-triangle'], ['danger', 'alert-circle']] as const) {
            const out = String(UI.card({ title: 'T', tone, body: 'x' }));
            assert.match(out, new RegExp(`class="surface ui-card ui-card--${tone}"`), tone);
            assert.match(out, new RegExp(`<i data-lucide="${icon}" aria-hidden="true"></i> T`), `${tone}: the glyph`);
        }
    });

    it('a tone that is not in the table is no tone: constructor and __proto__ are not classes', () => {
        const { UI } = load();
        for (const tone of ['constructor', '__proto__', 'toString', '" onload="x', 'purple']) {
            const out = String(UI.card({ title: 'T', tone, body: 'x' }));
            assert.match(out, /<section class="surface ui-card"/, tone);
            assert.ok(!out.includes('function') && !out.includes('onload'), tone);
        }
    });

    it('is solid in a grid, and has no label or head without a title or actions', () => {
        const { UI } = load();
        const solid = String(UI.card({ title: 'T', solid: true, body: 'x' }));
        assert.match(solid, /class="surface surface--solid ui-card"/);
        const bare = String(UI.card({ body: 'x' }));
        assert.ok(!bare.includes('card-head') && !bare.includes('aria-labelledby'));
    });

    it('escapes a title and a body that is a string; markup passes as markup', () => {
        const { UI } = load();
        const out = String(UI.card({ title: PAYLOAD, body: BREAKOUT, actions: PAYLOAD }));
        assertInert(out, 'card');
        assert.ok(out.includes('&lt;img src=x'));
    });
});

describe('UI.emptyState', () => {
    it('carries ONE next step: a button that dispatches, or a link', () => {
        const { UI } = load();
        const button = String(UI.emptyState({ icon: 'inbox', title: 'No campaigns yet', body: 'A campaign answers a keyword.', action: { label: 'New campaign', action: 'campaigns:create', icon: 'plus' } }));
        assert.match(button, /<div class="empty-state-actions">/);
        assert.match(button, /<button type="button" class="btn btn-primary" data-action="campaigns:create">/);
        assert.match(button, /<i data-lucide="plus" aria-hidden="true"><\/i> New campaign/);
        const link = String(UI.emptyState({ title: 'T', action: { label: 'Open', href: '#/campaigns' } }));
        assert.match(link, /<a class="btn btn-primary" href="#\/campaigns">Open<\/a>/);
    });

    it('a secondary is quieter, and the help article is the standard help link', () => {
        const { UI } = load();
        const out = String(UI.emptyState({
            title: 'T', action: { label: 'Go', action: 'a:b' },
            secondary: { label: 'Skip', href: '#/posts' }, help: { target: 'faq#setup', label: 'Setting up' },
        }));
        assert.match(out, /<a class="btn btn-ghost" href="#\/posts">Skip<\/a>/);
        assert.match(out, /class="help-link" href="#\/help\/faq#setup"/);
        assert.ok(out.indexOf('btn-primary') < out.indexOf('btn-ghost'), 'the next step comes first');
    });

    it('an action that names neither a handler nor a safe link draws nothing, not a dead button', () => {
        const { UI } = load();
        for (const action of [{ label: 'Go' }, { label: 'Go', href: 'javascript:alert(1)' }, { label: 'Go', href: '//evil.example.com' }, {}]) {
            assert.ok(!String(UI.emptyState({ title: 'T', action })).includes('empty-state-actions'), JSON.stringify(action));
        }
    });

    it('an unknown variant is the secondary look, never a class built from the word', () => {
        const { UI } = load();
        const out = String(UI.emptyState({ title: 'T', action: { label: 'Go', action: 'a:b', variant: 'constructor' } }));
        assert.match(out, /class="btn btn-secondary"/);
        assert.ok(!out.includes('function'));
    });

    it('escapes every slot', () => {
        const { UI } = load();
        const out = String(UI.emptyState({
            icon: BREAKOUT, title: PAYLOAD, body: BREAKOUT,
            action: { label: PAYLOAD, action: BREAKOUT, data: { id: PAYLOAD } },
            secondary: { label: PAYLOAD, href: `#/x?q=${BREAKOUT}` },
        }));
        assertInert(out, 'empty state');
    });

    /** What `Admin.emptyState` drew before it delegated: the template, character for character. */
    const legacy = (html: any, icon: unknown, title: unknown, body: unknown): string => String(html` ${''}`).slice(0, 0) + String(html`
            <div class="empty-state">
                <i data-lucide="${icon}" aria-hidden="true"></i>
                <h3>${title}</h3>
                ${body ? html`<p dir="auto">${body}</p>` : ''}
            </div>
        `);

    it('Admin.emptyState(icon, title, body) is unchanged for every existing caller', () => {
        const { Admin, UI, html } = load();
        for (const [icon, title, body] of [
            ['inbox', 'No campaigns yet', 'Create one to start.'],
            ['inbox', 'No campaigns yet', ''],
            ['users', 'Nobody', undefined],
            [PAYLOAD, PAYLOAD, BREAKOUT],
        ] as const) {
            assert.equal(String(Admin.emptyState(icon, title, body)), legacy(html, icon, title, body), `${icon}/${title}`);
            assert.equal(String(UI.emptyState({ icon, title, body })), legacy(html, icon, title, body), `UI: ${icon}/${title}`);
        }
    });

    it('Admin.emptyState takes the optional next step as a fourth argument', () => {
        const { Admin } = load();
        const out = String(Admin.emptyState('inbox', 'Nothing yet', 'Body', { action: { label: 'Create', action: 'x:y' } }));
        assert.match(out, /data-action="x:y"/);
        assert.match(out, /<h3>Nothing yet<\/h3>/);
    });
});

describe('UI.confirm', () => {
    function shown(l: Loaded): string[] {
        const out: string[] = [];
        l.UI.showModal = (markup: unknown): void => { out.push(String(markup)); };
        return out;
    }

    it('draws the styled dialog: the consequence, a danger button that is a verb, the way out', () => {
        const l = load();
        const out = shown(l);
        l.UI.confirm({ title: 'Delete campaign?', body: 'It stops answering.', hint: 'This cannot be undone.', confirmLabel: 'Delete', onConfirm: () => {} });
        const markup = out[0]!;
        assert.match(markup, /<h2 class="modal-title">Delete campaign\?<\/h2>/);
        assert.match(markup, /<p class="modal-body-text" dir="auto">It stops answering\.<\/p>/);
        assert.match(markup, /<p class="form-hint">This cannot be undone\.<\/p>/);
        assert.match(markup, /<button type="button" class="btn btn-secondary" data-action="ui:closeModal">common\.cancel<\/button>/);
        assert.match(markup, /class="btn btn-danger" id="admin-confirm-btn"\s+data-action="ui:runConfirm"/);
        assert.match(markup, /<i data-lucide="trash-2" aria-hidden="true"><\/i> Delete/);
        assert.ok(!markup.includes('disabled'), 'no gate, no disabled button');
    });

    it('tone "primary" is for what is consequential and destroys nothing; anything else is danger', () => {
        const l = load();
        const out = shown(l);
        l.UI.confirm({ title: 'T', body: 'B', tone: 'primary', confirmIcon: 'refresh-cw' });
        l.UI.confirm({ title: 'T', body: 'B', tone: 'constructor' });
        assert.match(out[0]!, /class="btn btn-primary" id="admin-confirm-btn"/);
        assert.match(out[0]!, /data-lucide="refresh-cw"/);
        assert.match(out[1]!, /class="btn btn-danger" id="admin-confirm-btn"/);
    });

    it('a typed-echo gate disables the button until the exact text is typed', () => {
        const l = load();
        const out = shown(l);
        l.UI.confirm({ title: 'T', body: 'B', requireText: 'ahmed-studio', onConfirm: () => {} });
        assert.match(out[0]!, /data-expect="ahmed-studio"/);
        assert.match(out[0]!, /data-input="ui:gateConfirm"/);
        assert.match(out[0]!, /data-action="ui:runConfirm" disabled/);
        const btn = l.doc.add('button', 'admin-confirm-btn');
        btn.disabled = true;
        const input = { value: ' ahmed-studio ', dataset: { expect: 'ahmed-studio' } };
        l.UI.gateConfirm(input);
        assert.equal(btn.disabled, false, 'surrounding spaces do not count against it');
        input.value = 'ahmed-studi';
        l.UI.gateConfirm(input);
        assert.equal(btn.disabled, true);
    });

    it('escapes the title, the body, the hint and the text it asks for', () => {
        const l = load();
        const out = shown(l);
        l.UI.confirm({ title: PAYLOAD, body: BREAKOUT, hint: PAYLOAD, confirmLabel: PAYLOAD, requireText: BREAKOUT });
        assertInert(out[0]!, 'confirm');
    });

    it('Admin.confirm is UI.confirm: the same dialog, the same pending callback, the same names', () => {
        const l = load();
        const out = shown(l);
        const opts = { title: 'T', body: 'B', hint: 'H', confirmLabel: 'Revoke', requireText: 'x', onConfirm: () => 'ran' };
        l.Admin.confirm(opts);
        l.UI.confirm(opts);
        assert.equal(out[0], out[1], 'identical markup');
        assert.equal(l.UI._confirmPending, opts.onConfirm);
        assert.equal(l.Admin._pending, opts.onConfirm, 'Admin._pending reads the same variable');
        const other = (): void => {};
        l.Admin._pending = other;
        assert.equal(l.UI._confirmPending, other, 'and writes it');
        for (const name of ['confirm', 'gateConfirm', 'runConfirm', 'regateConfirm', 'clearConfirmError', 'showConfirmError']) {
            assert.equal(typeof l.Admin[name], 'function', `Admin.${name}`);
        }
    });

    it('Admin.runConfirm runs what UI.confirm stored, and closes after success', async () => {
        const l = load();
        shown(l);
        let closed = 0;
        l.UI.closeModal = (): void => { closed += 1; };
        let ran = 0;
        l.Admin.confirm({ title: 'T', body: 'B', onConfirm: () => { ran += 1; return Promise.resolve(); } });
        const btn = l.doc.add('button', 'admin-confirm-btn');
        await l.Admin.runConfirm(btn);
        assert.equal(ran, 1);
        assert.equal(closed, 1);
        assert.equal(l.UI._confirmPending, null, 'a confirmed action is not left to run twice');
    });

    it('components.js no longer calls the browser\'s confirm()', () => {
        const src = readFileSync('dashboard/js/components.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/\bwindow\.confirm\(/.test(src), 'no window.confirm(');
        assert.ok(!/(^|[^.\w])confirm\(\s*t\(/.test(src), 'no confirm(t(…))');
        assert.ok(!/!\s*confirm\(/.test(src), 'no !confirm(…)');
    });
});

describe('the discard question, drawn over the modal (UI.confirm with stack)', () => {
    /** A modal with one guarded field, edited. */
    function dirtyModal(l: Loaded): FakeNode {
        const field = l.doc.add('textarea', 'dm-template', l.content);
        field.setAttribute('data-guard-dirty', '');
        field.value = 'before';
        l.UI._guardBaseline = new Map([['dm-template', 'before']]);
        field.value = 'before, and more I typed';
        field.focus();
        return field;
    }

    it('an unedited modal closes at once, with no question', () => {
        const l = load({ nativeConfirm: () => { throw new Error('the browser\'s confirm() was called'); } });
        let closed = 0;
        l.UI.closeModal = (): void => { closed += 1; };
        l.UI.requestCloseModal();
        assert.equal(closed, 1);
        assert.equal(l.UI._confirmLayer, null);
    });

    it('an edited one asks with UI.confirm over it, not with the browser, and leaves the modal and its field alone', () => {
        const l = load({ nativeConfirm: () => { throw new Error('the browser\'s confirm() was called'); } });
        const field = dirtyModal(l);
        let closed = 0;
        l.UI.closeModal = (): void => { closed += 1; };

        l.UI.requestCloseModal();

        assert.equal(closed, 0, 'nothing closed yet');
        assert.ok(l.UI._confirmLayer, 'the question is open');
        const layer = l.doc.body.children.find((c) => c.classes.has('confirm-layer'));
        assert.ok(layer, 'a layer of its own is on the page');
        assert.equal(layer.children[0]?.getAttribute('role'), 'alertdialog');
        assert.equal(layer.children[0]?.getAttribute('aria-modal'), 'true');
        assert.equal(l.overlay.getAttribute('inert'), '', 'the modal beneath cannot be reached');
        assert.match(layer.children[0]!.innerHTML, /ui\.discard\.title/);
        assert.match(layer.children[0]!.innerHTML, /common\.discardConfirm/);
        assert.match(layer.children[0]!.innerHTML, /ui\.discard\.keep/);
        assert.match(layer.children[0]!.innerHTML, /data-action="ui:cancelConfirm"/);
        assert.equal(field.value, 'before, and more I typed', 'what was typed is untouched');
        assert.notEqual(l.doc.activeElement, field, 'focus moved into the question');
    });

    it('asks once: a second request while it is open does not stack another', () => {
        const l = load();
        dirtyModal(l);
        l.UI.closeModal = (): void => {};
        l.UI.requestCloseModal();
        const first = l.UI._confirmLayer;
        l.UI.requestCloseModal();
        assert.equal(l.UI._confirmLayer, first);
        assert.equal(l.doc.body.children.filter((c) => c.classes.has('confirm-layer')).length, 1);
    });

    it('Escape answers "no": the question closes, the modal is as it was and focus goes back to the field', () => {
        const l = load();
        const field = dirtyModal(l);
        let closed = 0;
        l.UI.closeModal = (): void => { closed += 1; };
        const before = l.doc.listeners.keydown?.length ?? 0;
        l.UI.requestCloseModal();
        assert.equal(l.doc.listeners.keydown?.length, before + 1, 'the question listens for keys while it is open');

        const prevented = l.doc.fire('keydown', { key: 'Escape' });

        assert.equal(prevented, true);
        assert.equal(l.UI._confirmLayer, null);
        assert.equal(l.doc.body.children.some((c) => c.classes.has('confirm-layer')), false, 'the layer is gone');
        assert.equal(l.overlay.getAttribute('inert'), null, 'the modal is reachable again');
        assert.equal(closed, 0, 'and still open');
        assert.equal(l.doc.activeElement, field, 'focus returned to what the person was editing');
        assert.equal(field.value, 'before, and more I typed');
        assert.equal(l.doc.listeners.keydown?.length, before, 'and stops when it closes');
    });

    it('the modal\'s own Escape does not also fire while the question is open', () => {
        const l = load();
        dirtyModal(l);
        // The modal installs its capture listener when it opens; here it is the one the real showModal writes.
        l.UI.showModal('<p>x</p>');
        l.UI._guardBaseline = new Map([['dm-template', 'before']]);
        l.UI.requestCloseModal();
        const layers = () => l.doc.body.children.filter((c) => c.classes.has('confirm-layer')).length;
        assert.equal(layers(), 1);
        l.doc.fire('keydown', { key: 'Escape' });
        assert.equal(layers(), 0, 'one Escape answered the question and did not ask another');
    });

    it('Tab stays inside the question', () => {
        const l = load();
        dirtyModal(l);
        l.UI.closeModal = (): void => {};
        l.UI.requestCloseModal();
        const box = l.UI._confirmLayer.layer.children[0] as FakeNode;
        const first = l.doc.add('button', 'first', box);
        const last = l.doc.add('button', 'last', box);
        box.querySelectorAll = (): FakeNode[] => [first, last]; // the fake has no :not(); this is the focusable set
        last.focus();
        assert.equal(l.doc.fire('keydown', { key: 'Tab', shiftKey: false }), true);
        assert.equal(l.doc.activeElement, first, 'forward from the last wraps to the first');
        assert.equal(l.doc.fire('keydown', { key: 'Tab', shiftKey: true }), true);
        assert.equal(l.doc.activeElement, last, 'back from the first wraps to the last');
    });

    it('the scrim answers "no" too', () => {
        const l = load();
        dirtyModal(l);
        l.UI.closeModal = (): void => {};
        l.UI.requestCloseModal();
        const layer = l.UI._confirmLayer.layer as FakeNode;
        layer.children[0]!.fire('click', { target: layer.children[0] });
        assert.ok(l.UI._confirmLayer, 'a click inside the dialog is not a click on the scrim');
        layer.fire('click', { target: layer });
        assert.equal(l.UI._confirmLayer, null);
    });

    it('the discard button closes the modal and the question together, and runs the real closeModal once', async () => {
        const l = load();
        dirtyModal(l);
        l.UI.requestCloseModal();
        const discard = l.doc.add('button', 'admin-confirm-btn', l.UI._confirmLayer.layer.children[0] as FakeNode);

        await l.UI.runConfirm(discard);

        assert.equal(l.UI._confirmLayer, null, 'the question is gone');
        assert.ok(l.overlay.classes.has('hidden'), 'and so is the modal');
        assert.equal(l.UI._guardBaseline, null);
        assert.equal(l.doc.body.children.some((c) => c.classes.has('confirm-layer')), false);
    });

    it('closing the modal some other way (navigation) takes the question with it', () => {
        const l = load();
        dirtyModal(l);
        l.UI.requestCloseModal();
        assert.ok(l.UI._confirmLayer);
        l.UI.closeModal();
        assert.equal(l.UI._confirmLayer, null);
        assert.equal(l.doc.body.children.some((c) => c.classes.has('confirm-layer')), false);
        assert.equal(l.overlay.getAttribute('inert'), null);
    });

    it('cancelConfirm clears what the question would have run', () => {
        const l = load();
        dirtyModal(l);
        l.UI.requestCloseModal();
        assert.equal(typeof l.UI._confirmPending, 'function');
        l.UI.cancelConfirm();
        assert.equal(l.UI._confirmPending, null);
        assert.equal(l.UI._confirmLayer, null);
    });
});

describe('UI.toast', () => {
    const toastsIn = (n: FakeNode): FakeNode[] => n.children;
    const text = (t: FakeNode): string => t.querySelector('span')!.textContent;

    it('keeps its old signature: a string second argument is the type', () => {
        const l = load();
        l.UI.toast('Saved');
        l.UI.toast('Nope', 'error');
        const saved = toastsIn(l.status)[0]!;
        assert.equal(saved.className, 'toast success');
        assert.equal(text(saved), 'Saved');
        assert.equal(saved.querySelector('i')!.getAttribute('data-lucide'), 'check-circle');
        const nope = toastsIn(l.alerts)[0]!;
        assert.equal(nope.className, 'toast error', 'an error goes to the role="alert" region');
        assert.equal(nope.querySelector('i')!.getAttribute('data-lucide'), 'alert-circle');
        assert.equal(toastsIn(l.status).length, 1, 'and not also to the polite one');
    });

    it('has four tones, each with its own glyph, and only errors are announced assertively', () => {
        const l = load();
        for (const type of ['success', 'info', 'warning', 'error']) l.UI.toast(`m-${type}`, { type });
        const icons = [...toastsIn(l.status), ...toastsIn(l.alerts)].map((t) => `${t.className}:${t.querySelector('i')!.getAttribute('data-lucide')}`).sort();
        assert.deepEqual(icons, [
            'toast error:alert-circle', 'toast info:info', 'toast success:check-circle', 'toast warning:alert-triangle',
        ]);
        assert.deepEqual(toastsIn(l.alerts).map(text), ['m-error']);
    });

    it('falls back to the polite region when the page has no alert region', () => {
        const l = load({ regions: false });
        l.UI.toast('Nope', 'error');
        assert.equal(toastsIn(l.status).length, 1);
        assert.equal(toastsIn(l.status)[0]!.className, 'toast error');
    });

    it('a type that is not one of the four becomes info: it never reaches the class attribute', () => {
        const l = load();
        for (const type of ['constructor', '__proto__', BREAKOUT, 'danger']) l.UI.toast('x', { type });
        assert.deepEqual(toastsIn(l.status).map((t) => t.className), ['toast info', 'toast info', 'toast info', 'toast info']);
    });

    it('is text: a message, even one holding markup, is a text node', () => {
        const l = load();
        l.UI.toast(PAYLOAD);
        assert.equal(text(toastsIn(l.status)[0]!), PAYLOAD);
        assert.equal(toastsIn(l.status)[0]!.querySelector('span')!.getAttribute('dir'), 'auto');
        assert.equal(toastsIn(l.status)[0]!.innerHTML, '', 'nothing was written as markup');
    });

    it('stays 4.5 s, a warning 7 s, an error 9 s', () => {
        const l = load();
        l.UI.toast('ok');
        l.UI.toast('warn', { type: 'warning' });
        l.UI.toast('bad', 'error');
        const alive = (): number => [l.status, l.alerts].flatMap((r) => r.children).filter((t) => !t.classes.has('is-leaving')).length;
        assert.equal(alive(), 3);
        l.timers.advance(4499); assert.equal(alive(), 3);
        l.timers.advance(1); assert.equal(alive(), 2, 'success went at 4.5 s');
        l.timers.advance(2499); assert.equal(alive(), 2);
        l.timers.advance(1); assert.equal(alive(), 1, 'warning went at 7 s');
        l.timers.advance(1999); assert.equal(alive(), 1);
        l.timers.advance(1); assert.equal(alive(), 0, 'error went at 9 s');
    });

    it('hovering holds it and leaving gives it its whole time again', () => {
        const l = load();
        l.UI.toast('hold me');
        const t = toastsIn(l.status)[0]!;
        l.timers.advance(3000);
        t.fire('pointerenter');
        l.timers.advance(60_000);
        assert.ok(!t.classes.has('is-leaving'), 'held');
        t.fire('pointerleave');
        l.timers.advance(4499);
        assert.ok(!t.classes.has('is-leaving'));
        l.timers.advance(1);
        assert.ok(t.classes.has('is-leaving'));
    });

    it('draws an action button, and pressing it runs it once and dismisses the toast', async () => {
        const l = load();
        let pressed = 0;
        const handle = l.UI.toast('Campaign deleted', { type: 'info', action: { label: 'Undo', onClick: () => { pressed += 1; } } });
        const t = toastsIn(l.status)[0]!;
        const action = t.querySelector('.toast-action')!;
        assert.equal(action.textContent, 'Undo');
        assert.equal(action.type, 'button');
        const order = t.children.map((c) => c.className || c.tag);
        assert.deepEqual(order, ['i', 'span', 'toast-action', 'modal-close'], 'message, then the action, then close');

        action.click();

        assert.equal(pressed, 1);
        assert.ok(t.classes.has('is-leaving'));
        assert.equal(await handle.closed, 'action');
        l.timers.advance(400);
        assert.equal(toastsIn(l.status).length, 0, 'removed after the exit');
        action.click();
        assert.equal(pressed, 2, 'a second click on a removed button is the button\'s own business, but the toast is not shown twice');
    });

    it('a toast with an action stays at least 6 s, whatever duration it asked for', () => {
        const l = load();
        l.UI.toast('Short', { action: { label: 'Undo', onClick: () => {} }, duration: 1000 });
        const t = toastsIn(l.status)[0]!;
        l.timers.advance(5999);
        assert.ok(!t.classes.has('is-leaving'), 'still there at 5.999 s');
        l.timers.advance(1);
        assert.ok(t.classes.has('is-leaving'));
    });

    it('a longer duration is honoured, and one that is not a number is ignored', () => {
        const l = load();
        l.UI.toast('Long', { duration: 12_000 });
        l.UI.toast('Odd', { duration: Number.NaN });
        const [long, odd] = toastsIn(l.status);
        l.timers.advance(4500);
        assert.ok(odd!.classes.has('is-leaving') && !long!.classes.has('is-leaving'));
        l.timers.advance(7500);
        assert.ok(long!.classes.has('is-leaving'));
    });

    it('an action without a label or a function is not drawn', () => {
        const l = load();
        l.UI.toast('a', { action: { label: 'Undo' } });
        l.UI.toast('b', { action: { onClick: () => {} } });
        for (const t of toastsIn(l.status)) assert.equal(t.querySelector('.toast-action'), null);
    });

    it('the close button dismisses it, and says so', async () => {
        const l = load();
        const handle = l.UI.toast('x');
        const t = toastsIn(l.status)[0]!;
        t.querySelector('.modal-close')!.click();
        assert.ok(t.classes.has('is-leaving'));
        assert.equal(await handle.closed, 'dismissed');
    });

    it('says "expired" when it runs out, and an action that throws is reported and still dismisses', async () => {
        const l = load();
        const gone = l.UI.toast('x');
        l.timers.advance(4500);
        assert.equal(await gone.closed, 'expired');
        l.timers.advance(400);
        const handle = l.UI.toast('y', { action: { label: 'Go', onClick: () => { throw new Error('boom'); } } });
        toastsIn(l.status)[0]!.querySelector('.toast-action')!.click();
        assert.equal(await handle.closed, 'action');
        assert.ok(l.logs.some((entry) => String(entry[0]).includes('Toast action failed')));
    });

    it('draws nothing, and says so, when the page has no toast region', () => {
        const l = load();
        l.status.remove();
        l.alerts.remove();
        assert.equal(l.UI.toast('x'), null);
        assert.equal(l.UI.toast('x', 'error'), null);
    });
});

describe('UI.undoToast', () => {
    const actionOf = (l: Loaded): FakeNode => l.status.children[0]!.querySelector('.toast-action')!;

    it('settles true when the person presses Undo, after running onUndo', async () => {
        const l = load();
        let undone = 0;
        const result = l.UI.undoToast('Deleted', { onUndo: () => { undone += 1; } });
        assert.equal(actionOf(l).textContent, 'ui.undo');
        actionOf(l).click();
        assert.equal(await result, true);
        assert.equal(undone, 1);
    });

    it('settles false when it expires: the decision stands and the caller carries it out', async () => {
        const l = load();
        let undone = 0;
        const result = l.UI.undoToast('Deleted', { onUndo: () => { undone += 1; } });
        l.timers.advance(5999);
        let settled = false;
        void result.then(() => { settled = true; });
        await flush();
        assert.equal(settled, false, 'not before six seconds');
        l.timers.advance(1);
        assert.equal(await result, false);
        assert.equal(undone, 0);
    });

    it('settles false when it is dismissed: closing the message is not undoing the action', async () => {
        const l = load();
        const result = l.UI.undoToast('Deleted', { onUndo: () => {} });
        l.status.children[0]!.querySelector('.modal-close')!.click();
        assert.equal(await result, false);
    });

    it('the window is never under six seconds, and a longer one is honoured', async () => {
        const l = load();
        const short = l.UI.undoToast('a', { seconds: 1, onUndo: () => {} });
        const long = l.UI.undoToast('b', { seconds: 10, onUndo: () => {} });
        const [a, b] = l.status.children;
        l.timers.advance(5999);
        assert.ok(!a!.classes.has('is-leaving'));
        l.timers.advance(1);
        assert.ok(a!.classes.has('is-leaving'));
        assert.equal(await short, false);
        l.timers.advance(3999);
        assert.ok(!b!.classes.has('is-leaving'));
        l.timers.advance(1);
        assert.equal(await long, false);
    });

    it('a failed onUndo is said out loud and is still "undone": better a row left than a surprise delete', async () => {
        const l = load();
        const result = l.UI.undoToast('Deleted', { onUndo: () => { throw new Error('could not restore'); } });
        actionOf(l).click();
        assert.equal(await result, true);
        assert.deepEqual(l.alerts.children.map((t) => t.querySelector('span')!.textContent), ['could not restore']);

        const asynchronous = l.UI.undoToast('Deleted', { onUndo: () => Promise.reject(new Error('later')) });
        l.status.children.at(-1)!.querySelector('.toast-action')!.click();
        assert.equal(await asynchronous, true);
        await flush();
        assert.ok(l.alerts.children.some((t) => t.querySelector('span')!.textContent === 'later'));
    });

    it('with no toast region there is nothing to undo from: it settles false at once', async () => {
        const l = load();
        l.status.remove();
        assert.equal(await l.UI.undoToast('Deleted', { onUndo: () => {} }), false);
    });

    it('takes a label of its own and a tone', () => {
        const l = load();
        l.UI.undoToast('Archived', { label: 'Bring it back', type: 'success', onUndo: () => {} });
        assert.equal(actionOf(l).textContent, 'Bring it back');
        assert.equal(l.status.children[0]!.className, 'toast success');
    });
});

describe('UI.tabs', () => {
    const items = [
        { key: 'queue', label: 'Queue', icon: 'calendar' },
        { key: 'live', label: 'Live', count: 3 },
        { key: 'draft', label: 'Draft' },
    ];

    it('link mode is navigation: anchors with a query parameter and aria-current on the current one', () => {
        const { UI } = load();
        const out = String(UI.tabs(items, { mode: 'link', current: 'live', route: '#/posts', param: 'view', label: 'Posts' }));
        assert.match(out, /^<nav class="ui-tabs ui-tabs--link" aria-label="Posts" data-keydown="ui:tabsKey">/);
        assert.match(out, /<a class="ui-tab" data-ui-tab href="#\/posts\?view=queue">/);
        assert.match(out, /<a class="ui-tab" data-ui-tab href="#\/posts\?view=live" aria-current="page">/);
        assert.equal((out.match(/aria-current="page"/g) ?? []).length, 1, 'exactly one is current');
        assert.ok(!out.includes('aria-pressed') && !out.includes('<button'), 'a link tab is not a toggle');
        assert.match(out, /<i data-lucide="calendar" aria-hidden="true"><\/i><span>Queue<\/span>/);
        assert.match(out, /<span class="ui-tab-count"><bdi class="ltr-text" dir="ltr">3<\/bdi><\/span>/);
    });

    it('toggle mode is a view switch: buttons with aria-pressed, no href, no navigation', () => {
        const { UI } = load();
        const out = String(UI.tabs(items, { mode: 'toggle', current: 'live', action: 'posts:setView', label: 'View' }));
        assert.match(out, /^<div class="ui-tabs ui-tabs--toggle" role="group" aria-label="View" data-keydown="ui:tabsKey">/);
        assert.match(out, /<button type="button" class="ui-tab" data-ui-tab aria-pressed="true" data-action="posts:setView" data-key="live">/);
        assert.match(out, /<button type="button" class="ui-tab" data-ui-tab aria-pressed="false" data-action="posts:setView" data-key="queue">/);
        assert.ok(!out.includes('href=') && !out.includes('aria-current'), 'a toggle is not a link');
    });

    it('the two modes carry different classes: they look different', () => {
        const { UI } = load();
        const link = String(UI.tabs(items, { mode: 'link', route: '#/a', param: 'v' }));
        const toggle = String(UI.tabs(items, { mode: 'toggle', action: 'a:b' }));
        assert.ok(link.includes('ui-tabs--link') && !link.includes('ui-tabs--toggle'));
        assert.ok(toggle.includes('ui-tabs--toggle') && !toggle.includes('ui-tabs--link'));
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /\.ui-tabs--link \.ui-tab\[aria-current='page'\] \{[^}]*border-block-end-color: var\(--accent\)/, 'link tabs are underlined');
        assert.match(css, /\.ui-tabs--toggle \{[^}]*border-radius: var\(--radius-pill\)/, 'toggles are pills in a track');
    });

    it('an item names its own destination or action, and a link with no usable address is left out', () => {
        const { UI } = load();
        const link = String(UI.tabs([
            { key: 'a', label: 'A', href: '#/studio?tab=settings' },
            { key: 'b', label: 'B', href: 'javascript:alert(1)' },
            { key: 'c', label: 'C', href: '/dashboard/x' },
            { key: 'd', label: 'D' },
        ], { mode: 'link', current: 'a' }));
        assert.match(link, /href="#\/studio\?tab=settings" aria-current="page"/);
        assert.match(link, /href="\/dashboard\/x"/);
        assert.ok(!link.includes('javascript') && !link.includes('>B<') && !link.includes('>D<'));
        const toggle = String(UI.tabs([{ key: 'a', label: 'A', action: 'x:one' }, { key: 'b', label: 'B', disabled: true }], { mode: 'toggle', action: 'x:two' }));
        assert.match(toggle, /data-action="x:one" data-key="a"/);
        assert.match(toggle, /data-action="x:two" data-key="b" disabled/);
    });

    it('encodes a key into the address, and escapes every label', () => {
        const { UI } = load();
        const out = String(UI.tabs([{ key: 'a&b="c"', label: PAYLOAD }, { key: BREAKOUT, label: BREAKOUT, count: PAYLOAD }], { mode: 'link', route: '#/x', param: 'v', label: PAYLOAD }));
        assertInert(out, 'tabs');
        assert.match(out, /href="#\/x\?v=a%26b%3D%22c%22"/);
        const toggle = String(UI.tabs([{ key: BREAKOUT, label: PAYLOAD }], { mode: 'toggle', action: BREAKOUT, label: PAYLOAD }));
        assertInert(toggle, 'toggle tabs');
    });

    describe('the arrow keys', () => {
        /** Three tabs in a host the delegated handler would be given, the second one disabled when asked. */
        function strip(l: Loaded, disabledMiddle = false): { host: FakeNode; tabs: FakeNode[] } {
            const host = l.doc.add('nav', 'tabs');
            host.setAttribute('data-keydown', 'ui:tabsKey');
            const tabs = ['a', 'b', 'c'].map((id) => {
                const tab = l.doc.add('a', id, host);
                tab.setAttribute('data-ui-tab', '');
                return tab;
            });
            if (disabledMiddle) tabs[1]!.setAttribute('aria-disabled', 'true');
            return { host, tabs };
        }
        const press = (l: Loaded, host: FakeNode, from: FakeNode, key: string): boolean => {
            let prevented = false;
            l.UI.tabsKey(host, { key, target: from, preventDefault() { prevented = true; } });
            return prevented;
        };

        it('in Arabic (right to left) the LEFT arrow is the next tab and the right arrow the previous', () => {
            const l = load({ dir: 'rtl' });
            const { host, tabs } = strip(l);
            assert.equal(press(l, host, tabs[0]!, 'ArrowLeft'), true);
            assert.equal(l.doc.activeElement, tabs[1]);
            press(l, host, tabs[1]!, 'ArrowLeft');
            assert.equal(l.doc.activeElement, tabs[2]);
            press(l, host, tabs[2]!, 'ArrowRight');
            assert.equal(l.doc.activeElement, tabs[1], 'right goes back');
        });

        it('in English (left to right) it is the other way round', () => {
            const l = load({ dir: 'ltr' });
            const { host, tabs } = strip(l);
            press(l, host, tabs[0]!, 'ArrowRight');
            assert.equal(l.doc.activeElement, tabs[1]);
            press(l, host, tabs[1]!, 'ArrowLeft');
            assert.equal(l.doc.activeElement, tabs[0]);
        });

        it('wraps at both ends, and Home and End are the first and last in reading order in either direction', () => {
            for (const dir of ['rtl', 'ltr'] as const) {
                const l = load({ dir });
                const { host, tabs } = strip(l);
                const next = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
                const previous = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
                press(l, host, tabs[2]!, next);
                assert.equal(l.doc.activeElement, tabs[0], `${dir}: past the last is the first`);
                press(l, host, tabs[0]!, previous);
                assert.equal(l.doc.activeElement, tabs[2], `${dir}: before the first is the last`);
                press(l, host, tabs[1]!, 'End');
                assert.equal(l.doc.activeElement, tabs[2], `${dir}: End`);
                press(l, host, tabs[1]!, 'Home');
                assert.equal(l.doc.activeElement, tabs[0], `${dir}: Home`);
            }
        });

        it('the element\'s own computed direction beats the document\'s', () => {
            const l = load({ dir: 'rtl', getComputedStyle: () => ({ direction: 'ltr' }) });
            const { host, tabs } = strip(l);
            press(l, host, tabs[0]!, 'ArrowRight');
            assert.equal(l.doc.activeElement, tabs[1], 'laid out left to right inside a right-to-left page');
        });

        it('skips a disabled tab, ignores other keys, and leaves the key alone when it does not use it', () => {
            const l = load({ dir: 'ltr' });
            const { host, tabs } = strip(l, true);
            press(l, host, tabs[0]!, 'ArrowRight');
            assert.equal(l.doc.activeElement, tabs[2], 'the disabled one is passed over');
            l.doc.activeElement = null;
            assert.equal(press(l, host, tabs[0]!, 'Enter'), false);
            assert.equal(press(l, host, tabs[0]!, 'ArrowDown'), false);
            assert.equal(l.doc.activeElement, null, 'nothing moved');
            assert.equal(press(l, host, l.doc.add('span', 'outside'), 'ArrowRight'), false, 'a key from outside a tab is not ours');
        });

        it('is wired through the delegated keydown handler', () => {
            const { UI } = load();
            assert.equal(typeof UI._actions.ui.tabsKey, 'function');
            const src = readFileSync('dashboard/js/components.js', 'utf8');
            assert.match(src, /document\.addEventListener\('keydown', \(e\) => UI\._dispatch\(e, 'data-keydown'\)\)/);
        });
    });
});

describe('UI.secretField', () => {
    const saved = (extra: Json = {}): Json => ({
        id: 'meta-token', label: 'Meta token',
        status: { saved: true, last4: 'ab12', source: 'db' },
        onReplace: () => {}, onRemove: () => {}, ...extra,
    });

    it('saved: says what is stored, with the last four, and has NO input at all', () => {
        const { UI } = load();
        const out = String(UI.secretField(saved()));
        assert.match(out, /<span>ui\.secret\.saved<\/span> <bdi class="ltr-text" dir="ltr">••••ab12<\/bdi> <span class="ui-secret-source">· ui\.secret\.source\.db<\/span>/);
        assert.ok(!out.includes('<input'), 'there is nothing to clear and save over a value that is stored');
        assert.ok(!/\svalue=/.test(out), 'and no value attribute');
        assert.match(out, /id="meta-token-replace"/);
        assert.match(out, /id="meta-token-remove"/);
        assert.match(out, /data-action="ui:secretReplace"/);
        assert.match(out, /data-action="ui:secretRemove"/);
        assert.match(out, /ui\.secret\.writeOnly/);
        assert.match(out, /role="group" aria-labelledby="meta-token-label"/);
    });

    it('draws only the last four characters, whatever it was given', () => {
        const { UI } = load();
        const out = String(UI.secretField(saved({ status: { saved: true, last4: 'sk-live-ABCDEFGH-cdef', source: 'env' } })));
        assert.ok(out.includes('••••cdef'));
        assert.ok(!out.includes('ABCDEFGH') && !out.includes('sk-live'), 'no more of it than the four');
        assert.match(out, /ui\.secret\.source\.env/);
        const none = String(UI.secretField(saved({ status: { saved: true } })));
        assert.ok(!none.includes('•'), 'no last4: no mask at all, rather than a made-up one');
    });

    it('a source that is not db or env says nothing about where it came from', () => {
        const { UI } = load();
        for (const source of ['constructor', '__proto__', BREAKOUT, undefined]) {
            const out = String(UI.secretField(saved({ status: { saved: true, last4: '1234', source } })));
            assert.ok(!out.includes('ui-secret-source'), String(source));
        }
    });

    it('not saved: says so, and shows an input that is empty, a password field, and not offered for autofill', () => {
        const { UI } = load();
        const out = String(UI.secretField({ id: 'k', label: 'Key', status: { saved: false }, onReplace: () => {} }));
        assert.match(out, /ui\.secret\.notSet/);
        assert.match(out, /<input class="field field-mono" id="k" type="password" dir="ltr" autocomplete="new-password"/);
        assert.ok(!/\svalue=/.test(out));
        assert.ok(!out.includes('ui:secretReplace') && !out.includes('ui:secretRemove'), 'nothing to replace or remove yet');
        assert.ok(!out.includes('ui:secretCancel'), 'and nothing to go back to');
        assert.match(out, /aria-labelledby="k-label" aria-describedby="k-hint k-error"/);
        assert.match(out, /id="k-hint"/);
        assert.match(out, /id="k-error" role="alert"/);
    });

    it('no onRemove, no Remove; generate adds Generate and Copy to the input', () => {
        const { UI } = load();
        const out = String(UI.secretField(saved({ onRemove: undefined })));
        assert.ok(!out.includes('ui:secretRemove'));
        const editing = String(UI.secretField(saved({ editing: true, generate: true })));
        assert.match(editing, /data-action="ui:secretGenerate"/);
        assert.match(editing, /data-action="ui:secretCopy"/);
        assert.match(editing, /data-action="ui:secretCancel"/, 'a saved value can be left as it is');
        assert.ok(!editing.includes('ui:secretReplace'), 'Replace is what opened this');
        const plain = String(UI.secretField(saved({ editing: true })));
        assert.ok(!plain.includes('ui:secretGenerate'));
    });

    it('escapes the label, the hint and the last four', () => {
        const { UI } = load();
        const out = String(UI.secretField(saved({ label: PAYLOAD, hint: BREAKOUT, id: BREAKOUT, status: { saved: true, last4: PAYLOAD, source: 'db' } })));
        assertInert(out, 'secret field');
    });

    /** A field as the page holds it: a host with the input and the message node the handlers look for. */
    function field(l: Loaded, options: Json): { host: FakeNode; input: FakeNode; note: FakeNode; save: FakeNode } {
        l.UI.secretField(options);
        const host = l.doc.add('div', `${options.id}-field`);
        host.setAttribute('data-ui-id', options.id);
        const input = l.doc.add('input', options.id, host);
        const note = l.doc.add('p', `${options.id}-error`, host);
        note.setAttribute('data-ui-secret-error', '');
        const save = l.doc.add('button', `${options.id}-save`, host);
        return { host, input, note, save };
    }

    it('Replace opens the field for typing (and only then does an input exist); Cancel closes it again', () => {
        const l = load();
        l.UI.secretField(saved());
        const host = l.doc.add('div', 'meta-token-field');
        host.setAttribute('data-ui-id', 'meta-token');
        const replace = l.doc.add('button', 'meta-token-replace', host);

        l.UI.secretReplace(replace);
        assert.match(host.outerHTML, /<input class="field field-mono" id="meta-token" type="password"/, 'now there is an input');
        assert.match(host.outerHTML, /ui:secretCancel/);
        assert.ok(!host.outerHTML.includes('ui:secretReplace'));

        l.UI.secretCancel(replace);
        assert.ok(!host.outerHTML.includes('<input'), 'closed again, with nothing in the page');
        assert.match(host.outerHTML, /ui:secretReplace/);
    });

    it('Save refuses an empty value, and a value that is only spaces, without calling onReplace', async () => {
        const l = load();
        let sent = 0;
        const f = field(l, saved({ editing: true, onReplace: () => { sent += 1; } }));
        for (const typed of ['', '   \n ']) {
            f.input.value = typed;
            await l.UI.secretSave(f.save);
            assert.equal(sent, 0);
            assert.equal(f.note.textContent, 'ui.secret.empty');
            assert.equal(f.input.getAttribute('aria-invalid'), 'true');
            assert.equal(f.input.getAttribute('aria-describedby'), 'meta-token-hint meta-token-error');
            assert.equal(l.doc.activeElement, f.input, 'focus goes to the field that needs it');
        }
    });

    it('Save sends the trimmed value, wipes it from the page, and redraws as saved with its last four', async () => {
        const l = load();
        const sent: string[] = [];
        const f = field(l, saved({ editing: true, onReplace: (v: string) => { sent.push(v); return Promise.resolve(); } }));
        f.input.value = '  sk-new-value-9f3a \n';

        await l.UI.secretSave(f.save);

        assert.deepEqual(sent, ['sk-new-value-9f3a']);
        assert.equal(f.input.value, '', 'the typed value is gone from the page');
        assert.match(f.host.outerHTML, /••••9f3a/);
        assert.ok(!f.host.outerHTML.includes('sk-new-value'), 'and only its last four are ever drawn');
        assert.ok(!f.host.outerHTML.includes('<input'));
    });

    it('a refusal stays inline, in the field, and the value is kept so the retry is one press', async () => {
        const l = load();
        const f = field(l, saved({ editing: true, onReplace: () => Promise.reject(new Error('Meta said no')) }));
        f.input.value = 'candidate-value';

        await l.UI.secretSave(f.save);

        assert.equal(f.note.textContent, 'Meta said no');
        assert.equal(f.input.value, 'candidate-value');
        assert.equal(f.save.disabled, false, 'the button came back');
        assert.equal(f.host.outerHTML, '', 'and nothing was redrawn');
    });

    it('a synchronous throw from onReplace is the same inline refusal', async () => {
        const l = load();
        const f = field(l, saved({ editing: true, onReplace: () => { throw new Error('bad shape'); } }));
        f.input.value = 'v';
        await l.UI.secretSave(f.save);
        assert.equal(f.note.textContent, 'bad shape');
    });

    it('Remove asks first, names what stops working, and removes only when confirmed', () => {
        const l = load();
        let removed = 0;
        l.UI.secretField(saved({ onRemove: () => { removed += 1; } }));
        const host = l.doc.add('div', 'meta-token-field');
        host.setAttribute('data-ui-id', 'meta-token');
        const remove = l.doc.add('button', 'meta-token-remove', host);
        const markup: string[] = [];
        l.UI.showModal = (m: unknown): void => { markup.push(String(m)); };

        l.UI.secretRemove(remove);

        assert.equal(removed, 0, 'nothing is removed by pressing Remove');
        assert.match(markup[0]!, /ui\.secret\.removeTitle/);
        assert.match(markup[0]!, /ui\.secret\.removeBody/);
        assert.match(markup[0]!, /class="btn btn-danger" id="admin-confirm-btn"/);
        (l.UI._confirmPending as () => void)();
        assert.equal(removed, 1);
    });

    it('Generate fills the input from the CSPRNG (hex, 32 bytes by default) and shows it so it can be copied', () => {
        const l = load({ crypto: true });
        const f = field(l, saved({ editing: true, generate: true }));
        const gen = l.doc.add('button', 'g', f.host);
        f.input.type = 'password';

        l.UI.secretGenerate(gen);
        const first = f.input.value;
        assert.match(first, /^[0-9a-f]{64}$/);
        assert.equal(f.input.type, 'text', 'visible once, so it can be copied before it is saved');
        l.UI.secretGenerate(gen);
        assert.notEqual(f.input.value, first, 'two generations differ');

        const small = field(l, saved({ id: 'k2', editing: true, generate: { bytes: 16 } }));
        l.UI.secretGenerate(l.doc.add('button', 'g2', small.host));
        assert.match(small.input.value, /^[0-9a-f]{32}$/);
    });

    it('a random value is never Math.random: with no CSPRNG it refuses', () => {
        const l = load();
        assert.throws(() => l.UI.randomSecret(32));
        assert.ok(!String(l.UI.randomSecret).includes('Math.random'));
        const l2 = load({ crypto: true });
        assert.equal(String(l2.UI.randomSecret(1000)).length, 256, 'bounded at 128 bytes');
        assert.equal(String(l2.UI.randomSecret(1)).length, 32, 'and no fewer than 16');
    });

    it('Copy puts the value on the clipboard and says so', async () => {
        const copied: string[] = [];
        const l = load({ clipboard: copied });
        const f = field(l, saved({ editing: true, generate: true }));
        f.input.value = 'copy-me';
        l.UI.secretCopy(l.doc.add('button', 'c', f.host));
        await flush();
        assert.deepEqual(copied, ['copy-me']);
        assert.deepEqual(l.status.children.map((t) => t.querySelector('span')!.textContent), ['common.copied']);

        f.input.value = '';
        l.UI.secretCopy(l.doc.add('button', 'c2', f.host));
        await flush();
        assert.equal(copied.length, 1, 'nothing to copy, nothing copied');
    });
});

describe('UI.field', () => {
    it('wires the label, the hint and the control together', () => {
        const { UI, html } = load();
        const out = String(UI.field({
            id: 'camp-name', label: 'Name', hint: 'Shown only to you',
            control: ({ attrs }: Json) => html`<input class="field" name="name" ${attrs}>`,
        }));
        assert.match(out, /<label class="form-label" for="camp-name">Name<\/label>/);
        assert.match(out, /<input class="field" name="name"  id="camp-name" aria-describedby="camp-name-hint">/);
        assert.match(out, /<p class="form-hint" id="camp-name-hint">Shown only to you<\/p>/);
        assert.ok(!out.includes('aria-invalid'), 'no error, no invalid state');
        assert.match(out, /class="ui-field-error hidden" id="camp-name-error"/);
    });

    it('with an error the control is invalid and points at the hint AND the error, which has a glyph and is announced', () => {
        const { UI, html } = load();
        const out = String(UI.field({
            id: 'f', label: 'L', hint: 'H', error: 'Too short',
            control: ({ attrs }: Json) => html`<input class="field" ${attrs}>`,
        }));
        assert.match(out, /aria-describedby="f-hint f-error" aria-invalid="true"/);
        assert.match(out, /<p class="ui-field-error" id="f-error" role="alert" data-ui-field-error><i data-lucide="alert-circle" aria-hidden="true"><\/i> <span dir="auto">Too short<\/span><\/p>/);
        assert.match(out, /class="form-group ui-field has-error"/);
    });

    it('the optional marker is the dictionary\'s, in the label', () => {
        const { UI } = load();
        const out = String(UI.field({ id: 'f', label: 'Nickname', optional: true, control: ({ attrs }: Json) => attrs }));
        assert.match(out, /Nickname <span class="label-optional">common\.optional<\/span><\/label>/);
        assert.ok(!String(UI.field({ id: 'f', label: 'N', control: ({ attrs }: Json) => attrs })).includes('label-optional'));
    });

    it('markup as a control gets the wiring added to its first control tag', () => {
        const { UI, html } = load();
        const out = String(UI.field({ id: 'f', label: 'L', hint: 'H', error: 'Bad', control: html`<input class="field" name="n" aria-invalid="false">` }));
        assert.match(out, /<input class="field" name="n" id="f" aria-describedby="f-hint f-error" aria-invalid="true">/);
        assert.equal((out.match(/aria-invalid/g) ?? []).length, 1, 'what the control said about itself is replaced');
    });

    it('merges with a description the control already has, and keeps an id it already carries (the label follows it)', () => {
        const { UI, html } = load();
        const out = String(UI.field({ label: 'L', hint: 'H', control: html`<textarea id="mine" aria-describedby="elsewhere"></textarea>` }));
        assert.match(out, /<label class="form-label" for="mine">/);
        assert.match(out, /<textarea id="mine" aria-describedby="elsewhere mine-hint"><\/textarea>/);
        assert.match(out, /<p class="form-hint" id="mine-hint">/);
    });

    it('handles a select, a self-closing input, and a control it cannot find', () => {
        const { UI, html } = load();
        assert.match(String(UI.field({ id: 's', label: 'L', error: 'E', control: html`<select class="select"><option>1</option></select>` })),
            /<select class="select" id="s" aria-describedby="s-error" aria-invalid="true">/);
        assert.match(String(UI.field({ id: 'i', label: 'L', control: html`<input class="field" />` })), /<input class="field" id="i" \/>|<input class="field" id="i"\/>/);
        const custom = String(UI.field({ id: 'c', label: 'L', control: html`<div role="textbox"></div>` }));
        assert.match(custom, /<div role="textbox"><\/div>/, 'left as it was: pass a function to wire such a control');
    });

    it('draws a string control as text, never as markup', () => {
        const { UI } = load();
        const out = String(UI.field({ id: 'f', label: 'L', control: PAYLOAD }));
        assertInert(out, 'string control');
        assert.ok(out.includes('&lt;img src=x'));
    });

    it('escapes the label, hint, error and id', () => {
        const { UI, html } = load();
        const out = String(UI.field({
            id: BREAKOUT, label: PAYLOAD, hint: BREAKOUT, error: PAYLOAD,
            control: html`<input class="field" value="${PAYLOAD}">`,
        }));
        assertInert(out, 'field');
    });

    it('a function control gets what it needs to wire itself', () => {
        const { UI, html } = load();
        let got: Json = {};
        UI.field({ id: 'z', label: 'L', hint: 'H', error: 'E', control: (wire: Json) => { got = wire; return html`<input ${wire.attrs}>`; } });
        assert.equal(got.id, 'z');
        assert.equal(got.describedBy, 'z-hint z-error');
        assert.equal(got.invalid, true);
    });

    describe('after the fact: setFieldError and clearFieldError', () => {
        /** A rendered field: the wrapper, its control and the message node. */
        function rendered(l: Loaded): { host: FakeNode; control: FakeNode; note: FakeNode; text: FakeNode } {
            const host = l.doc.add('div', 'w');
            host.setAttribute('data-ui-field', '');
            host.className = 'form-group ui-field';
            const control = l.doc.add('input', 'name', host);
            control.setAttribute('aria-describedby', 'name-hint');
            const note = l.doc.add('p', 'name-error', host);
            note.setAttribute('data-ui-field-error', '');
            note.className = 'ui-field-error hidden';
            const text = l.doc.add('span', 'msg', note);
            return { host, control, note, text };
        }

        it('shows the message, marks the control invalid, keeps the hint and adds the error, and moves focus there', () => {
            const l = load();
            const { host, control, note, text } = rendered(l);
            assert.equal(l.UI.setFieldError(control, 'Already used'), true);
            assert.equal(text.textContent, 'Already used');
            assert.ok(!note.classes.has('hidden'));
            assert.ok(host.classes.has('has-error'));
            assert.equal(control.getAttribute('aria-invalid'), 'true');
            assert.equal(control.getAttribute('aria-describedby'), 'name-hint name-error');
            assert.equal(l.doc.activeElement, control);
        });

        it('asking twice does not list the error twice, and focus can be left alone', () => {
            const l = load();
            const { host, control } = rendered(l);
            l.UI.setFieldError(host, 'one');
            l.UI.setFieldError(host, 'two', { focus: false });
            assert.equal(control.getAttribute('aria-describedby'), 'name-hint name-error');
        });

        it('clearing takes it all back', () => {
            const l = load();
            const { host, control, note, text } = rendered(l);
            l.UI.setFieldError(control, 'x');
            assert.equal(l.UI.clearFieldError(control), true);
            assert.equal(text.textContent, '');
            assert.ok(note.classes.has('hidden'));
            assert.ok(!host.classes.has('has-error'));
            assert.equal(control.getAttribute('aria-invalid'), null);
            assert.equal(control.getAttribute('aria-describedby'), 'name-hint');
        });

        it('says false when it is not inside a UI.field', () => {
            const l = load();
            const stray = l.doc.add('input', 'stray');
            assert.equal(l.UI.setFieldError(stray, 'x'), false);
            assert.equal(l.UI.clearFieldError(stray), false);
            assert.equal(l.UI.setFieldError(null, 'x'), false);
        });

        it('the message is set as text, never as markup', () => {
            const l = load();
            const { control, text } = rendered(l);
            l.UI.setFieldError(control, PAYLOAD);
            assert.equal(text.textContent, PAYLOAD);
            assert.equal(text.innerHTML, '');
        });
    });
});

describe('UI.filterBar', () => {
    const chips = [{ key: '', label: 'All' }, { key: 'failed', label: 'Failed' }, { key: 'sent', label: 'Sent', count: 9 }];

    it('draws the search, the chips with their counts and the sort, from `value`', () => {
        const { UI } = load();
        const out = String(UI.filterBar({
            id: 'cf', search: { label: 'Search campaigns', placeholder: 'A keyword…' }, chips,
            counts: { '': 40, failed: 3 },
            sort: { label: 'Sort by', options: [{ key: 'recent', label: 'Newest' }, { key: 'name', label: 'Name' }] },
            value: { q: 'sale', filter: 'failed', sort: 'name' },
        }));
        assert.match(out, /<div class="filter-bar ui-filter" role="group" aria-label="ui\.filter\.label" data-ui-id="cf">/);
        assert.match(out, /<label class="sr-only" for="cf-search">Search campaigns<\/label>/);
        assert.match(out, /<input class="field" type="search" id="cf-search" value="sale" dir="auto"\s+placeholder="A keyword…"/);
        assert.match(out, /aria-pressed="true" data-action="ui:filterChip" data-key="failed" data-focus-key="cf-chip-failed">Failed <span class="ui-chip-count"><bdi class="ltr-text" dir="ltr">3<\/bdi><\/span>/);
        assert.match(out, /aria-pressed="false" data-action="ui:filterChip" data-key="" data-focus-key="cf-chip-">All <span class="ui-chip-count"><bdi class="ltr-text" dir="ltr">40<\/bdi>/);
        assert.match(out, /data-key="sent"[^>]*>Sent <span class="ui-chip-count"><bdi class="ltr-text" dir="ltr">9<\/bdi>/, 'a chip may carry its own count');
        assert.match(out, /<select class="select" id="cf-sort" data-change="ui:filterSort">/);
        assert.match(out, /<option value="name" selected>Name<\/option>/);
        assert.match(out, /<option value="recent">Newest<\/option>/);
        assert.equal((out.match(/aria-pressed="true"/g) ?? []).length, 1, 'one chip at a time');
    });

    it('with no value the first chip with an empty key is the pressed one, and only what was asked for is drawn', () => {
        const { UI } = load();
        const out = String(UI.filterBar({ id: 'x', chips }));
        assert.match(out, /aria-pressed="true" data-action="ui:filterChip" data-key=""/);
        assert.ok(!out.includes('<input') && !out.includes('<select'));
        const chipless = String(UI.filterBar({ id: 'y', search: true }));
        assert.match(chipless, /placeholder="common\.search"/);
        assert.ok(!chipless.includes('ui-filter-chips'));
    });

    it('a count it does not have is not drawn, and a chip key like "constructor" does not read the prototype', () => {
        const { UI } = load();
        const out = String(UI.filterBar({ id: 'x', chips: [{ key: 'constructor', label: 'C' }, { key: 'plain', label: 'P' }], counts: {} }));
        assert.ok(!out.includes('ui-chip-count'));
        assert.ok(!out.includes('function'));
    });

    it('escapes every slot', () => {
        const { UI } = load();
        const out = String(UI.filterBar({
            id: BREAKOUT, label: PAYLOAD, chipsLabel: PAYLOAD,
            search: { label: PAYLOAD, placeholder: BREAKOUT },
            chips: [{ key: BREAKOUT, label: PAYLOAD, count: PAYLOAD }],
            sort: { label: PAYLOAD, options: [{ key: BREAKOUT, label: PAYLOAD }] },
            value: { q: BREAKOUT, filter: BREAKOUT, sort: BREAKOUT },
        }));
        assertInert(out, 'filter bar');
    });

    it('a chip press calls onChange with the whole next value, and the sort and search follow', () => {
        const l = load();
        const calls: Json[] = [];
        l.UI.filterBar({ id: 'cf', search: true, chips, sort: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], value: { q: 'sale', filter: '', sort: 'a' }, onChange: (v: Json) => calls.push(v), debounceMs: 0, hash: false });
        const host = l.doc.add('div', 'h');
        host.setAttribute('data-ui-id', 'cf');
        const chip = l.doc.add('button', 'c', host);
        chip.setAttribute('data-key', 'failed');
        const select = l.doc.add('select', 'sel', host);
        const search = l.doc.add('input', 'q', host);

        l.UI.filterChip(chip);
        select.value = 'b';
        l.UI.filterSort(select);
        search.value = 'summer';
        l.UI.filterSearch(search);

        assert.deepEqual(plain(calls), [
            { q: 'sale', filter: 'failed', sort: 'a' },
            { q: 'sale', filter: 'failed', sort: 'b' },
            { q: 'summer', filter: 'failed', sort: 'b' },
        ]);
    });

    it('typing is debounced: one call, with the last text, after 250 ms of quiet', () => {
        const l = load();
        const calls: Json[] = [];
        l.UI.filterBar({ id: 'cf', search: true, value: { q: '' }, onChange: (v: Json) => calls.push(v), hash: false });
        const host = l.doc.add('div', 'h');
        host.setAttribute('data-ui-id', 'cf');
        const search = l.doc.add('input', 'q', host);
        for (const [i, text] of ['s', 'su', 'sum'].entries()) {
            search.value = text;
            l.UI.filterSearch(search);
            l.timers.advance(i === 2 ? 0 : 100);
        }
        assert.equal(calls.length, 0, 'nothing yet');
        l.timers.advance(249);
        assert.equal(calls.length, 0);
        l.timers.advance(1);
        assert.deepEqual(plain(calls), [{ q: 'sum', filter: '', sort: '' }]);
    });

    it('what onChange receives is a copy: changing it does not change the bar', () => {
        const l = load();
        let got: Json = {};
        l.UI.filterBar({ id: 'cf', chips, value: { q: 'a', filter: '', sort: '' }, onChange: (v: Json) => { got = v; }, hash: false });
        const host = l.doc.add('div', 'h');
        host.setAttribute('data-ui-id', 'cf');
        const chip = l.doc.add('button', 'c', host);
        chip.setAttribute('data-key', 'failed');
        l.UI.filterChip(chip);
        got.q = 'tampered';
        l.UI.filterChip(chip);
        assert.equal(got.q, 'a');
    });

    it('a page that re-renders replaces its entry; a pending search of the old one does not fire', () => {
        const l = load();
        const first: Json[] = [];
        const second: Json[] = [];
        l.UI.filterBar({ id: 'cf', search: true, value: { q: '' }, onChange: (v: Json) => first.push(v), hash: false });
        const host = l.doc.add('div', 'h');
        host.setAttribute('data-ui-id', 'cf');
        const search = l.doc.add('input', 'q', host);
        search.value = 'typed';
        l.UI.filterSearch(search);
        l.UI.filterBar({ id: 'cf', search: true, value: { q: '' }, onChange: (v: Json) => second.push(v), hash: false });
        l.timers.advance(1000);
        assert.deepEqual(first, [], 'the replaced entry\'s timer was cancelled');
        assert.equal(l.UI._sharedOrder.filter((id: string) => id === 'cf').length, 1, 'and it is one entry, not two');
    });

    it('an error in the page\'s onChange is shown, not swallowed or thrown into a timer', () => {
        const l = load();
        l.UI.filterBar({ id: 'cf', chips, value: {}, onChange: () => { throw new Error('render failed'); }, hash: false });
        const host = l.doc.add('div', 'h');
        host.setAttribute('data-ui-id', 'cf');
        const chip = l.doc.add('button', 'c', host);
        chip.setAttribute('data-key', 'failed');
        assert.doesNotThrow(() => l.UI.filterChip(chip));
        assert.deepEqual(l.alerts.children.map((t) => t.querySelector('span')!.textContent), ['render failed']);
    });

    describe('the hash', () => {
        function press(l: Loaded, key: string, value: Json = {}): void {
            l.UI.filterBar({ id: 'cf', chips, value, onChange: () => {} });
            const host = l.doc.add('div', `h-${key}`);
            host.setAttribute('data-ui-id', 'cf');
            const chip = l.doc.add('button', `c-${key}`, host);
            chip.setAttribute('data-key', key);
            l.UI.filterChip(chip);
        }

        it('is mirrored with replaceState when the router has hashParams, keeping the other parameters', () => {
            const l = load({ app: { hashParams: () => ({ campaign: '3', filter: 'old' }) } });
            l.window.location.hash = '#/campaigns?campaign=3&filter=old';
            press(l, 'failed', { q: 'sale' });
            assert.equal(l.replaced.length, 1);
            assert.equal(l.replaced[0]![2], '#/campaigns?campaign=3&q=sale&filter=failed');
        });

        it('reads hashParams as URLSearchParams too, and a cleared value leaves the address', () => {
            const l = load({ app: { hashParams: () => new URLSearchParams('campaign=3&q=old&filter=failed') } });
            l.window.location.hash = '#/campaigns?campaign=3&q=old&filter=failed';
            press(l, '', { q: '' });
            assert.equal(l.replaced[0]![2], '#/campaigns?campaign=3');
        });

        it('with nothing left it is the bare route', () => {
            const l = load({ app: { hashParams: () => ({}) } });
            l.window.location.hash = '#/campaigns?filter=failed';
            press(l, '', { q: '' });
            assert.equal(l.replaced[0]![2], '#/campaigns');
        });

        it('is not touched when there is no App.hashParams, when the page opts out, or when nothing changed', () => {
            const none = load();
            press(none, 'failed');
            assert.deepEqual(none.replaced, []);

            const noParams = load({ app: {} });
            press(noParams, 'failed');
            assert.deepEqual(noParams.replaced, []);

            const out = load({ app: { hashParams: () => ({}) } });
            out.UI.filterBar({ id: 'cf', chips, value: {}, onChange: () => {}, hash: false });
            const host = out.doc.add('div', 'h');
            host.setAttribute('data-ui-id', 'cf');
            const chip = out.doc.add('button', 'c', host);
            chip.setAttribute('data-key', 'failed');
            out.UI.filterChip(chip);
            assert.deepEqual(out.replaced, []);

            const same = load({ app: { hashParams: () => ({}) } });
            same.window.location.hash = '#/campaigns?filter=failed';
            press(same, 'failed');
            assert.deepEqual(same.replaced, [], 'the address already says it');
        });

        it('a router that throws does not break the filter', () => {
            const l = load({ app: { hashParams: () => { throw new Error('no router'); } } });
            const calls: Json[] = [];
            l.UI.filterBar({ id: 'cf', chips, value: {}, onChange: (v: Json) => calls.push(v) });
            const host = l.doc.add('div', 'h');
            host.setAttribute('data-ui-id', 'cf');
            const chip = l.doc.add('button', 'c', host);
            chip.setAttribute('data-key', 'failed');
            l.UI.filterChip(chip);
            assert.equal(calls.length, 1);
        });
    });
});

describe('UI.table', () => {
    const columns = [
        { key: 'name', label: 'Name', sortable: true },
        { key: 'sent', label: 'Sent', sortable: true, align: 'end' },
        { key: 'status', label: 'Status', card: 'badge', render: (r: Json) => `[${r.status}]` },
        { key: 'id', label: 'Id', card: false },
    ];
    const rows = [
        { id: 'a', name: 'Beta', sent: 10, status: 'ok' },
        { id: 'b', name: 'alpha', sent: 9, status: 'failed' },
        { id: 'c', name: 'Gamma', sent: null, status: 'ok' },
    ];
    const names = (out: string): string[] => [...out.matchAll(/<tr><td dir="auto">([^<]*)<\/td>/g)].map((m) => m[1]!);

    it('draws a header, the rows and the same rows again as cards, CSS showing one of the two', () => {
        const { UI } = load();
        const out = String(UI.table({ id: 't', caption: 'Campaigns', columns, rows }));
        assert.match(out, /<div class="ui-table" data-ui-id="t">/);
        assert.match(out, /<div class="table-wrapper log-table">\s*<table class="data-table ui-table-grid">\s*<caption class="sr-only">Campaigns<\/caption>/);
        assert.match(out, /<th scope="col">Name<\/th>/);
        assert.match(out, /<th scope="col" class="cell-num">Sent<\/th>/);
        assert.match(out, /<ul class="log-cards" aria-label="Campaigns">/);
        assert.equal((out.match(/<li class="log-card">/g) ?? []).length, 3);
        assert.equal((out.match(/<tr><td/g) ?? []).length, 3);
    });

    it('a card has the first column as its title, the badge column at its end, and the rest as label and value, minus card:false', () => {
        const { UI } = load();
        const out = String(UI.table({ columns, rows: [rows[0]] }));
        const card = /<li class="log-card">([\s\S]*?)<\/li>/.exec(out)![1]!;
        assert.match(card, /<div class="log-card-head">\s*<span>Beta<\/span>\s*<span>\[ok\]<\/span>\s*<\/div>/);
        assert.match(card, /<dl class="ui-card-fields"><div class="ui-card-field"><dt class="text-meta">Sent<\/dt><dd>10<\/dd><\/div><\/dl>/);
        assert.ok(!card.includes('Id'), 'a column marked card:false is not in the card');
        assert.ok(!/\sid="/.test(out), 'a cell carries no id, because the rows are drawn twice');
    });

    it('sortable headers are buttons only with an onSort, and aria-sort says which one is sorted', () => {
        const { UI } = load();
        const plain = String(UI.table({ columns, rows, sort: { key: 'sent', dir: 'desc' } }));
        assert.ok(!plain.includes('ui-sort'), 'no handler, no buttons');
        assert.match(plain, /<th scope="col" aria-sort="descending" class="cell-num">Sent<\/th>/, 'but the order the rows are in is still said');
        assert.ok(!plain.includes('aria-sort="none"'));

        const live = String(UI.table({ id: 't', columns, rows, sort: { key: 'name', dir: 'asc' }, onSort: () => {} }));
        assert.match(live, /<th scope="col" aria-sort="ascending"><button type="button" class="ui-sort" data-action="ui:tableSort" data-key="name">Name<i data-lucide="chevron-up" aria-hidden="true"><\/i><\/button><\/th>/);
        assert.match(live, /<th scope="col" aria-sort="none" class="cell-num"><button type="button" class="ui-sort" data-action="ui:tableSort" data-key="sent">Sent<i data-lucide="chevrons-up-down" aria-hidden="true"><\/i>/);
        assert.match(live, /<th scope="col">Status<\/th>/, 'a column that cannot be sorted has no aria-sort');
        const desc = String(UI.table({ id: 't', columns, rows, sort: { key: 'name', dir: 'desc' }, onSort: () => {} }));
        assert.match(desc, /aria-sort="descending"><button[^>]*data-key="name">Name<i data-lucide="chevron-down"/);
    });

    it('sorts the rows: text by the locale, numbers as numbers, an empty value last in either direction', () => {
        const { UI } = load();
        const sort = (dir: string, key = 'name'): string[] => names(String(UI.table({ columns, rows, sort: { key, dir } })));
        assert.deepEqual(sort('asc'), ['alpha', 'Beta', 'Gamma'], 'case does not decide it');
        assert.deepEqual(sort('desc'), ['Gamma', 'Beta', 'alpha']);
        assert.deepEqual(sort('asc', 'sent'), ['alpha', 'Beta', 'Gamma'], '9 before 10, and null last');
        assert.deepEqual(sort('desc', 'sent'), ['Beta', 'alpha', 'Gamma'], 'null still last');
        const many = [{ name: 'item 10' }, { name: 'item 9' }, { name: 'item 100' }];
        assert.deepEqual(names(String(UI.table({ columns: [{ key: 'name', label: 'N', sortable: true }], rows: many, sort: { key: 'name', dir: 'asc' } }))), ['item 9', 'item 10', 'item 100'], 'numeric collation');
    });

    it('is stable, honours sortValue, and leaves server-sorted rows and unsortable columns as they came', () => {
        const { UI } = load();
        const tied = [{ name: 'x', n: 1, k: 'first' }, { name: 'x', n: 1, k: 'second' }, { name: 'x', n: 0, k: 'third' }];
        const cols = [{ key: 'k', label: 'K', render: (r: Json) => r.k }, { key: 'n', label: 'N', sortable: true }];
        const order = (sort: Json): string[] => [...String(UI.table({ columns: cols, rows: tied, sort })).matchAll(/<tr><td>([a-z]+)<\/td>/g)].map((m) => m[1]!);
        assert.deepEqual(order({ key: 'n', dir: 'asc' }), ['third', 'first', 'second'], 'ties keep their order');
        assert.deepEqual(order({ key: 'n', dir: 'desc' }), ['first', 'second', 'third']);
        assert.deepEqual(order({ key: 'n', dir: 'desc', server: true }), ['first', 'second', 'third'], 'server: as given');
        assert.deepEqual(order({ key: 'k', dir: 'asc' }), ['first', 'second', 'third'], 'k is not sortable');
        const dated = [{ at: '2026-02-01' }, { at: '2026-01-01' }];
        const byDate = String(UI.table({ columns: [{ key: 'at', label: 'At', sortable: true, sortValue: (r: Json) => new Date(r.at), render: (r: Json) => r.at }], rows: dated, sort: { key: 'at', dir: 'asc' } }));
        assert.ok(byDate.indexOf('2026-01-01') < byDate.indexOf('2026-02-01'));
        assert.deepEqual(dated.map((r) => r.at), ['2026-02-01', '2026-01-01'], 'the caller\'s array is not reordered');
    });

    it('pressing a header: a new column starts ascending, the same one flips', () => {
        const l = load();
        const calls: Json[] = [];
        l.UI.table({ id: 't', columns, rows, sort: { key: 'name', dir: 'asc' }, onSort: (s: Json) => calls.push(s) });
        const host = l.doc.add('div', 'h');
        host.setAttribute('data-ui-id', 't');
        const header = (key: string): FakeNode => {
            const b = l.doc.add('button', `b-${key}-${host.children.length}`, host);
            b.setAttribute('data-key', key);
            return b;
        };
        l.UI.tableSort(header('name'));
        l.UI.tableSort(header('sent'));
        l.UI.table({ id: 't', columns, rows, sort: { key: 'name', dir: 'desc' }, onSort: (s: Json) => calls.push(s) });
        l.UI.tableSort(header('name'));
        assert.deepEqual(plain(calls), [{ key: 'name', dir: 'desc' }, { key: 'sent', dir: 'asc' }, { key: 'name', dir: 'asc' }]);
    });

    it('draws a value as text, an empty one as a dash, and a render\'s markup as markup', () => {
        const { UI, html } = load();
        const out = String(UI.table({
            columns: [
                { key: 'a', label: 'A' }, { key: 'b', label: 'B' },
                { key: 'c', label: 'C', render: (r: Json) => html`<b>${r.c}</b>` },
                { key: 'd', label: 'D', render: (r: Json) => r.d },
            ],
            rows: [{ a: PAYLOAD, b: null, c: PAYLOAD, d: BREAKOUT }],
        }));
        assertInert(out, 'table');
        assert.match(out, /<td dir="auto">&lt;img src=x/);
        assert.match(out, /<td dir="auto">—<\/td>/);
        assert.match(out, /<td><b>&lt;img src=x[^<]*<\/b><\/td>/, 'a render\'s own markup is kept and its data is not');
    });

    it('escapes the header labels, the caption and a column key', () => {
        const { UI } = load();
        const out = String(UI.table({
            id: BREAKOUT, caption: PAYLOAD,
            columns: [{ key: BREAKOUT, label: PAYLOAD, sortable: true, className: BREAKOUT }],
            rows: [{ [BREAKOUT]: PAYLOAD }], onSort: () => {},
        }));
        assertInert(out, 'table headers');
    });

    it('with no rows it draws the empty state alone, never a header over nothing', () => {
        const { UI, html } = load();
        const state = String(UI.table({ columns, rows: [], empty: { icon: 'inbox', title: 'No campaigns yet', action: { label: 'New', action: 'c:new' } } }));
        assert.match(state, /<div class="ui-table ui-table--empty"/);
        assert.match(state, /<h3>No campaigns yet<\/h3>/);
        assert.match(state, /data-action="c:new"/);
        assert.ok(!state.includes('<table') && !state.includes('log-cards') && !state.includes('<th'));
        assert.match(String(UI.table({ columns, rows: [], empty: html`<p class="mine">Nothing matches</p>` })), /<p class="mine">Nothing matches<\/p>/);
        assert.match(String(UI.table({ columns, rows: [], empty: 'No rows' })), /<p class="table-empty-cell">No rows<\/p>/);
        assert.match(String(UI.table({ columns, rows: [] })), /<p class="table-empty-cell">ui\.table\.empty<\/p>/, 'never silence');
        assert.match(String(UI.table({ columns })), /ui\.table\.empty/, 'rows missing is empty too');
        assertInert(String(UI.table({ columns, rows: [], empty: { title: PAYLOAD, body: BREAKOUT } })), 'empty');
        assertInert(String(UI.table({ columns, rows: [], empty: PAYLOAD })), 'empty text');
    });

    it('is a table on a desk and cards on a phone: the stylesheet shows exactly one at 768px', () => {
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /\.log-cards \{ display: none;/);
        assert.match(css, /@media \(max-width: 768px\) \{[\s\S]*?\.log-table \{ display: none; \}\s*\.log-cards \{ display: flex; \}/);
        assert.match(css, /ul\.log-cards \{ list-style: none; \}/);
    });
});

describe('UI.pager', () => {
    it('draws nothing for one page, none, or nonsense', () => {
        const { UI } = load();
        for (const total of [0, 1, -3, Number.NaN, undefined, 'x']) assert.equal(String(UI.pager({ page: 1, total })), '', String(total));
        assert.equal(String(UI.pager({})), '');
    });

    it('is the pager Activity draws: Previous, the position, Next, with stable ids', () => {
        const { UI } = load();
        const out = String(UI.pager({ id: 'jobs', page: 2, total: 9 }));
        assert.match(out, /<nav class="pagination" aria-label="ui\.pager\.label" data-ui-id="jobs">/);
        assert.match(out, /<button type="button" class="page-btn" id="jobs-prev"\s+data-action="ui:pagerGo" data-page="1">\s*<i data-lucide="chevron-left" aria-hidden="true"><\/i> ui\.pager\.prev/);
        assert.match(out, /<span class="page-position">ui\.pager\.position\|page=2,total=9<\/span>/);
        assert.match(out, /id="jobs-next"\s+data-action="ui:pagerGo" data-page="3">\s*ui\.pager\.next <i data-lucide="chevron-right"/);
        assert.ok(!out.includes('disabled'));
    });

    it('disables Previous on the first page and Next on the last, and clamps a page that is out of range', () => {
        const { UI } = load();
        assert.match(String(UI.pager({ id: 'p', page: 1, total: 3 })), /id="p-prev" disabled/);
        assert.match(String(UI.pager({ id: 'p', page: 3, total: 3 })), /id="p-next" disabled/);
        const clamped = String(UI.pager({ id: 'p', page: 99, total: 3 }));
        assert.match(clamped, /page=3,total=3/);
        assert.match(clamped, /id="p-next" disabled/);
        assert.match(String(UI.pager({ id: 'p', page: -4, total: 3 })), /page=1,total=3/);
        assert.match(String(UI.pager({ id: 'p', page: 'two', total: 3 })), /page=1,total=3/);
    });

    it('escapes its label and id', () => {
        const { UI } = load();
        assertInert(String(UI.pager({ id: BREAKOUT, label: PAYLOAD, page: 1, total: 4 })), 'pager');
    });

    it('a press calls onPage with the page asked for, and nothing outside 1..total', () => {
        const l = load();
        const pages: number[] = [];
        l.UI.pager({ id: 'jobs', page: 2, total: 4, onPage: (n: number) => pages.push(n) });
        const host = l.doc.add('nav', 'h');
        host.setAttribute('data-ui-id', 'jobs');
        const go = (n: string): void => {
            const b = l.doc.add('button', `b${host.children.length}`, host);
            b.setAttribute('data-page', n);
            l.UI.pagerGo(b);
        };
        for (const n of ['1', '3', '4', '0', '5', '-1', '2.5', 'x', '']) go(n);
        assert.deepEqual(pages, [1, 3, 4]);
    });

    it('has no handler, no entry, or a bad element: it does nothing', () => {
        const l = load();
        l.UI.pager({ id: 'quiet', page: 1, total: 3 });
        const host = l.doc.add('nav', 'h');
        host.setAttribute('data-ui-id', 'quiet');
        const b = l.doc.add('button', 'b', host);
        b.setAttribute('data-page', '2');
        assert.doesNotThrow(() => l.UI.pagerGo(b));
        const orphan = l.doc.add('button', 'o');
        orphan.setAttribute('data-page', '2');
        assert.doesNotThrow(() => l.UI.pagerGo(orphan));
    });
});

describe('the callback registry', () => {
    it('is bounded, newest first to stay, and an id that was evicted finds nothing', () => {
        const l = load();
        for (let i = 0; i < 150; i++) l.UI.pager({ id: `p${i}`, page: 1, total: 2, onPage: () => {} });
        assert.equal(l.UI._sharedOrder.length, 120);
        assert.equal(Object.keys(l.UI._shared).length, 120);
        const old = l.doc.add('nav', 'old');
        old.setAttribute('data-ui-id', 'p0');
        const fresh = l.doc.add('nav', 'fresh');
        fresh.setAttribute('data-ui-id', 'p149');
        assert.equal(l.UI._recall(l.doc.add('b', 'x', old)), null);
        assert.ok(l.UI._recall(l.doc.add('b', 'y', fresh)));
    });

    it('is a table with no prototype: an id like "constructor" is not an entry', () => {
        const l = load();
        const host = l.doc.add('nav', 'h');
        for (const id of ['constructor', '__proto__', 'toString']) {
            host.setAttribute('data-ui-id', id);
            assert.equal(l.UI._recall(host), null, id);
        }
    });

    it('its tables have no prototype, so a word read off a payload is never a function', () => {
        const { UI } = load();
        for (const name of ['_TOAST_TONES', '_CARD_TONES', '_HEADING_TAGS', '_SECRET_SOURCES', '_ALIGN']) {
            assert.equal(Object.getPrototypeOf(UI[name]), null, name);
            assert.equal(UI[name].constructor, undefined, name);
            assert.equal(UI[name].__proto__, undefined, name);
        }
    });
});

describe('the section in components.js', () => {
    const src = readFileSync('dashboard/js/components.js', 'utf8');

    it('is ONE section, titled, at the end of the UI object', () => {
        assert.equal((src.match(/Shared patterns \(UX foundation\)\n/g) ?? []).length, 1, 'one heading');
        const at = src.indexOf('    // Shared patterns (UX foundation)');
        const closes = src.indexOf('\n};\n\nUI.registerActions(\'ui\'');
        assert.ok(at > 0 && closes > at, 'the section runs to the end of the object');
        const between = src.slice(at, closes);
        for (const name of ['pageHeader', 'card', 'emptyState', 'confirm', 'undoToast', 'tabs', 'secretField', 'field', 'filterBar', 'table', 'pager']) {
            assert.match(between, new RegExp(`\\n    ${name}\\(`), `${name} is in the section`);
        }
    });

    it('writes no inline handler and builds no class name by interpolation', () => {
        const at = src.indexOf('    // Shared patterns (UX foundation)');
        const section = src.slice(at, src.indexOf('\n};\n\nUI.registerActions(\'ui\''))
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert.ok(!/\son(click|change|input|submit|keydown|load|error)\s*=/.test(section), 'no inline on* attribute');
        assert.ok(!/btn-\$\{/.test(section), 'no btn-${…}');
        assert.ok(!/ui-card--\$\{|ui-tabs--\$\{|toast \$\{(?!type)/.test(section), 'no tone class built from a word');
    });
});

describe('both languages carry every key the section asks for', () => {
    it('ui.* keys exist in the Arabic and the English dictionary', () => {
        const used = new Set<string>();
        for (const file of ['dashboard/js/components.js']) {
            for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'(ui\.[a-zA-Z0-9_.]+)'/g)) used.add(m[1]!);
        }
        for (const m of readFileSync('dashboard/js/components.js', 'utf8').matchAll(/'(ui\.secret\.source\.[a-z]+)'/g)) used.add(m[1]!);
        assert.ok(used.size >= 15, `${used.size} keys`);
        for (const lang of ['ar', 'en']) {
            const dictionary = readFileSync(`dashboard/js/i18n.${lang}.js`, 'utf8');
            for (const key of used) assert.ok(new RegExp(`^\\s+'${key.replace(/\./g, '\\.')}':`, 'm').test(dictionary), `${lang}: ${key}`);
        }
    });
});
