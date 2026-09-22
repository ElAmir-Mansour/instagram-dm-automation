/**
 * The button primitives: `UI.button`, `UI.actionBusy`, and `Admin.runConfirm`.
 *
 * Three things here are load-bearing enough to be worth testing rather than reading.
 *
 * 1. `UI.button` writes a `class` attribute from caller-supplied words. Doing that by
 *    interpolation (`btn-${variant}`) would be a hole straight through the escaping
 *    contract in `components.js`, because `class="btn btn-x" onload="..."` is a perfectly
 *    good attribute string. It uses lookup tables instead, and the tables have a null
 *    prototype — a plain `{}` answers `'constructor'` with a function, so `TABLE[v] ||
 *    fallback` on an object literal would happily write `class="btn function Object() {
 *    [native code] }"` for a variant read off a server payload.
 *
 * 2. `UI.actionBusy` returns `null` when the element is already in flight, and every
 *    caller is written as `if (!restore) return;`. If it ever returned a restore function
 *    there instead, every one of those guards would silently stop guarding and the
 *    double-submit bugs they were added for would come back with no visible symptom.
 *
 * 3. `Admin.runConfirm` decides whether the confirmation dialog closes. It used to close
 *    unconditionally and *then* run the action, which is why the whole class of
 *    confirm-gated destructive actions had no in-flight feedback. The rule now is: close on
 *    success, stay open on failure with the reason inside it. A regression either way is
 *    invisible in a screenshot.
 *
 * Loaded the same way as escaping.test.ts and charts.test.ts: the REAL dashboard files in a
 * `node:vm` context, so these test what ships rather than a copy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

/** The bits of a DOM element these three functions actually touch. */
interface FakeEl {
    id: string;
    innerHTML: string;
    disabled: boolean;
    offsetWidth: number;
    style: Record<string, string>;
    readonly textContent: string;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    removeAttribute(name: string): void;
}

interface UiApi {
    button(options?: Record<string, unknown>): { toString(): string };
    actionBusy(el: unknown, label?: string): (() => void) | null;
    buttonSpinner(label?: string): string;
    closeModal(): void;
    toast(message: string, type?: string): void;
}

interface AdminApi {
    _pending: (() => unknown) | null;
    runConfirm(el?: unknown): unknown;
}

interface Loaded {
    UI: UiApi;
    Admin: AdminApi;
    html: (strings: TemplateStringsArray, ...values: unknown[]) => { toString(): string };
    /** Whatever `document.getElementById` should answer with. */
    dom: Map<string, FakeEl>;
    closed: { count: number };
    toasts: Array<{ message: string; type?: string }>;
}

function fakeEl(id: string, innerHTML = '', width = 120): FakeEl {
    const attrs = new Map<string, string>();
    return {
        id,
        innerHTML,
        disabled: false,
        offsetWidth: width,
        style: {},
        get textContent(): string { return this.innerHTML.replace(/<[^>]*>/g, '').trim(); },
        setAttribute(name: string, value: string): void { attrs.set(name, String(value)); },
        getAttribute(name: string): string | null {
            const v = attrs.get(name);
            return v === undefined ? null : v;
        },
        removeAttribute(name: string): void { attrs.delete(name); },
    };
}

function load(): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, FakeEl>();
    const stubEl = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [],
    };
    const ctx: Record<string, unknown> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...stubEl }),
            body: { ...stubEl }, head: { ...stubEl },
            documentElement: { ...stubEl, lang: 'ar', dir: 'rtl' },
            getElementById: (id: string) => dom.get(id) ?? null,
            activeElement: null,
        },
        window: {
            addEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop }),
            location: { hash: '' },
        },
        Intl, console, setTimeout, clearTimeout,
        requestAnimationFrame: (f: () => void) => f(),
        I18N: { lang: 'ar', locale: () => 'ar-u-nu-latn-ca-gregory', t: (k: string) => k, strings: { ar: {}, en: {} } },
        t: (k: string) => k,
        navigator: { language: 'ar' },
        CSS: { escape: (v: string) => String(v) },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(readFileSync('dashboard/js/components.js', 'utf8'), ctx, { filename: 'components.js' });
    vm.runInContext(readFileSync('dashboard/js/pages/admin_common.js', 'utf8'), ctx, { filename: 'admin_common.js' });

    const { UI, Admin, html } = vm.runInContext('({ UI, Admin, html })', ctx) as Pick<Loaded, 'UI' | 'Admin' | 'html'>;

    // `closeModal` and `toast` both reach for real DOM this sandbox does not have, and both
    // are the OUTCOME being asserted rather than machinery under test, so they are recorded.
    const closed = { count: 0 };
    const toasts: Array<{ message: string; type?: string }> = [];
    UI.closeModal = (): void => { closed.count += 1; };
    UI.toast = (message: string, type?: string): void => { toasts.push({ message, type }); };

    return { UI, Admin, html, dom, closed, toasts };
}

const render = (options: Record<string, unknown>): string => String(load().UI.button(options));

// ─────────────────────────────────────────────────────────────────────────────

describe('UI.button — the markup', () => {
    it('defaults to a secondary button of type="button"', () => {
        const out = render({ label: 'Save' });
        assert.match(out, /type="button"/);
        assert.match(out, /class="btn btn-secondary"/);
        assert.match(out, /Save<\/button>/);
    });

    it('type="button" is the default because the alternative submits the enclosing form', () => {
        // A <button> with no type is type="submit". Half the buttons in this dashboard sit
        // inside a modal <form>, so an omitted type is a form submission nobody asked for.
        assert.match(render({}), /type="button"/);
        assert.match(render({ type: 'submit' }), /type="submit"/);
        assert.match(render({ type: 'reset' }), /type="reset"/);
    });

    it('maps each variant to the class the stylesheet actually defines', () => {
        assert.match(render({ variant: 'primary' }), /class="btn btn-primary"/);
        assert.match(render({ variant: 'secondary' }), /class="btn btn-secondary"/);
        assert.match(render({ variant: 'danger' }), /class="btn btn-danger"/);
        assert.match(render({ variant: 'ghost' }), /class="btn btn-ghost"/);
    });

    it('composes size, full-width and extra classes', () => {
        const out = render({ variant: 'primary', size: 'sm', full: true, className: 'mbs-4' });
        assert.match(out, /class="btn btn-primary btn-sm btn-full mbs-4"/);
        // 'md' is the default size and contributes no class.
        assert.match(render({ size: 'md' }), /class="btn btn-secondary"/);
    });

    it('writes data-action, ids, focus keys and the accessible name', () => {
        const out = render({
            action: 'campaigns:confirmDelete',
            id: 'kill-it',
            focusKey: 'campaign-delete-7',
            ariaLabel: 'Delete the campaign',
            title: 'Delete',
        });
        assert.match(out, /data-action="campaigns:confirmDelete"/);
        assert.match(out, /id="kill-it"/);
        assert.match(out, /data-focus-key="campaign-delete-7"/);
        assert.match(out, /aria-label="Delete the campaign"/);
        assert.match(out, /title="Delete"/);
    });

    it('omits every optional attribute rather than emitting an empty one', () => {
        const out = render({ label: 'x' });
        for (const attr of ['data-action', 'id=', 'data-focus-key', 'aria-label', 'title=', 'aria-busy', 'disabled']) {
            assert.ok(!out.includes(attr), `expected no ${attr} in ${out}`);
        }
    });

    it('renders the icon before the label, as the lucide placeholder the rest of the app uses', () => {
        const out = render({ icon: 'trash-2', label: 'Delete' });
        assert.match(out, /<i data-lucide="trash-2" aria-hidden="true"><\/i> Delete/);
    });
});

describe('UI.button — the class attribute cannot be written by a caller', () => {
    it('falls back to secondary for a variant that is not in the table', () => {
        assert.match(render({ variant: 'nonsense' }), /class="btn btn-secondary"/);
    });

    it('cannot be used to break out of the class attribute', () => {
        const out = render({ variant: 'x" onload="alert(1)', size: 'y" onerror="alert(2)' });
        assert.match(out, /class="btn btn-secondary"/);
        assert.ok(!out.includes('onload'), 'no onload survived');
        assert.ok(!out.includes('onerror'), 'no onerror survived');
    });

    /**
     * The one that a plain object literal gets wrong. `{}.constructor` is a function, so
     * `TABLE['constructor'] || fallback` returns it and `String()`s it into the markup.
     * The tables have a null prototype for exactly this.
     */
    it('is immune to inherited Object properties used as variant / size / type names', () => {
        for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
            const out = render({ variant: key, size: key, type: key });
            assert.match(out, /class="btn btn-secondary"/, `variant "${key}" leaked a class`);
            assert.match(out, /type="button"/, `type "${key}" leaked a type`);
            assert.ok(!out.includes('native code'), `variant "${key}" leaked a function body`);
            assert.ok(!out.includes('function'), `variant "${key}" leaked a function`);
        }
    });

    it('never emits an inline event handler, whatever it is fed', () => {
        // Zero inline on* handlers is a CSP precondition for this dashboard, not a style
        // rule. A handler can only appear if a payload closes the attribute it is in, so
        // the signature to look for is a LITERAL quote followed by one — the escaped form
        // (`&quot; onclick=&quot;`) is inert text and must not be mistaken for a hit.
        const payloads = {
            label: '" onclick="steal()',
            action: '" onmouseover="steal()',
            ariaLabel: '" onfocus="steal()',
            title: '" onblur="steal()',
            icon: '" onerror="steal()',
            id: '" onload="steal()',
            focusKey: '" onwheel="steal()',
            className: '" onpointerdown="steal()',
        };
        const out = render({ variant: 'primary', ...payloads, data: { id: '" onauxclick="steal()' } });

        assert.ok(!/"\s*on[a-z]+\s*=/i.test(out), `an attribute was closed early: ${out}`);
        for (const [field, payload] of Object.entries(payloads)) {
            assert.ok(!out.includes(payload), `${field} reached the markup unescaped`);
        }
        assert.ok(out.includes('&quot;'), 'the quotes were escaped rather than dropped');
    });
});

describe('UI.button — escaping', () => {
    it('escapes the label as text', () => {
        const out = render({ label: '<img src=x onerror=alert(1)>' });
        assert.ok(!out.includes('<img'), 'no live img tag');
        assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
    });

    it('escapes every attribute value', () => {
        const out = render({ action: 'ns:m', data: { id: '"><script>alert(1)</script>' } });
        assert.ok(!out.includes('<script'), 'no live script tag');
        assert.match(out, /data-id="&quot;&gt;&lt;script&gt;/);
    });

    it('returns SafeHtml, so it nests inside html`` without being escaped again', () => {
        // This is the property that makes the factory adoptable at all: a call has to drop
        // into an existing `html` template beside hand-written markup. Returning a plain
        // string would come back as `&lt;button` and render the tag as visible text.
        const { UI, html } = load();
        const out = String(html`<div class="row-actions">${UI.button({ variant: 'danger', label: 'Delete' })}</div>`);
        assert.equal(
            out,
            '<div class="row-actions"><button type="button" class="btn btn-danger">Delete</button></div>',
        );
    });

    it('writes only the attributes it was given, with no blank filler in the tag', () => {
        const { UI } = load();
        assert.equal(
            String(UI.button({ variant: 'primary', icon: 'send', label: 'Publish', action: 'posts:publish', data: { id: 4 } })),
            '<button type="button" class="btn btn-primary" data-action="posts:publish" data-id="4">'
            + '<i data-lucide="send" aria-hidden="true"></i> Publish</button>',
        );
    });
});

describe('UI.button — data-* attributes', () => {
    it('emits well-formed data keys', () => {
        const out = render({ data: { id: 7, creator: 'abc', 'post-id': 'x' } });
        assert.match(out, /data-id="7"/);
        assert.match(out, /data-creator="abc"/);
        assert.match(out, /data-post-id="x"/);
    });

    it('drops null and undefined values rather than writing "null"', () => {
        const out = render({ data: { id: null, creator: undefined, keyword: '' } });
        assert.ok(!out.includes('data-id'), 'null dropped');
        assert.ok(!out.includes('data-creator'), 'undefined dropped');
        assert.match(out, /data-keyword=""/, 'empty string is a real value and is kept');
    });

    it('refuses a key that is not a data-* name, which is also what stops key injection', () => {
        // A key is written into the markup RAW (the regex is what makes that safe), so an
        // unfiltered key is a direct attribute injection rather than an escaping question.
        const out = render({ data: { focusKey: 'x', 'id" onclick="alert(1)': 'y', '': 'z' } });
        assert.ok(!out.includes('focusKey'), 'camelCase rejected');
        assert.ok(!out.includes('onclick'), 'a key cannot open a second attribute');
    });
});

describe('UI.button — the busy state', () => {
    it('busy renders the spinner, the aria state and the disabled attribute together', () => {
        const out = render({ variant: 'primary', label: 'Publish', icon: 'send', busy: true });
        assert.match(out, /aria-busy="true"/);
        assert.match(out, /disabled/);
        assert.match(out, /<span class="spinner spinner-sm spinner-inline">/);
        assert.match(out, /Publish/, 'the label stays, so the accessible name survives');
        assert.ok(!out.includes('data-lucide'), 'the icon is replaced by the spinner, not doubled');
    });

    it('busy always implies disabled — the CSS says non-interactive and the markup must agree', () => {
        assert.match(render({ busy: true, disabled: false }), /disabled/);
    });

    it('disabled on its own is not busy', () => {
        const out = render({ label: 'Save', disabled: true });
        assert.match(out, /disabled/);
        assert.ok(!out.includes('aria-busy'), 'not claiming to be working');
        assert.ok(!out.includes('spinner'), 'no spinner');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('UI.actionBusy — the double-submit guard', () => {
    it('returns a harmless no-op when there is no element, so callers need not branch', () => {
        const { UI } = load();
        const restore = UI.actionBusy(null);
        assert.equal(typeof restore, 'function');
        restore!(); // must not throw
    });

    /**
     * THE contract. Every caller is `const restore = UI.actionBusy(el); if (!restore) return;`
     * — if this ever returned a function for an in-flight element, all of them would keep
     * running and quietly stop guarding anything.
     */
    it('returns null when the element is already in flight', () => {
        const { UI } = load();
        const el = fakeEl('b', 'Delete');
        assert.notEqual(UI.actionBusy(el), null, 'the first call takes the button');
        assert.equal(UI.actionBusy(el), null, 'the second call is refused');
    });

    it('refuses an element that was already disabled for someone else’s reason', () => {
        const { UI } = load();
        const el = fakeEl('b', 'Delete');
        el.disabled = true;
        assert.equal(UI.actionBusy(el), null);
    });

    it('refuses an element carrying aria-busy even if it is not disabled', () => {
        // An <a> or a non-form control cannot be `disabled`; `aria-busy` is what holds it.
        const { UI } = load();
        const el = fakeEl('b', 'Delete');
        el.setAttribute('aria-busy', 'true');
        assert.equal(UI.actionBusy(el), null);
    });

    it('disables, marks busy, and swaps the label for a spinner', () => {
        const { UI } = load();
        const el = fakeEl('b', '<i data-lucide="trash-2"></i> Delete');
        UI.actionBusy(el);
        assert.equal(el.disabled, true);
        assert.equal(el.getAttribute('aria-busy'), 'true');
        assert.match(el.innerHTML, /<span class="spinner spinner-sm spinner-inline">/);
        assert.ok(!el.innerHTML.includes('data-lucide'), 'the icon is replaced, not joined');
    });

    /**
     * Both halves of this are load-bearing and they fix different things. Hiding the label
     * is what lets the width be held: a spinner BESIDE the label makes the button ~24px
     * wider, and `min-inline-size` is a minimum, so it cannot stop a button growing. Keeping
     * the label in the DOM is what stops the button losing its accessible name — a spinner
     * on its own is an unlabelled control.
     */
    it('keeps the label for assistive tech but takes it out of the box, so the width can hold', () => {
        const { UI } = load();
        const el = fakeEl('b', '<i data-lucide="trash-2"></i> Delete', 132);
        UI.actionBusy(el);
        assert.match(el.innerHTML, /<span class="sr-only">Delete<\/span>/, 'named, but not laid out');
        assert.equal(el.textContent, 'Delete', 'still reads as "Delete" to a screen reader');
    });

    it('pins the width with a LOGICAL property, because this dashboard is RTL-first', () => {
        const { UI } = load();
        const el = fakeEl('b', 'A much longer label than a spinner', 240);
        UI.actionBusy(el);
        assert.equal(el.style['min-inline-size'] ?? el.style.minInlineSize, '240px');
        assert.ok(!('width' in el.style), 'no physical width');
    });

    it('an explicit label is shown, like formBusy — the caller asked for a different verb', () => {
        const { UI } = load();
        const el = fakeEl('b', 'Delete');
        UI.actionBusy(el, 'Deleting…');
        assert.match(el.innerHTML, /<span>Deleting…<\/span>/, 'visible, not sr-only');
        assert.ok(!el.innerHTML.includes('sr-only'));
    });

    it('restore() puts the label, the state and the width back exactly as they were', () => {
        const { UI } = load();
        const el = fakeEl('b', '<i data-lucide="trash-2"></i> Delete');
        const before = el.innerHTML;
        const restore = UI.actionBusy(el);
        restore!();
        assert.equal(el.innerHTML, before);
        assert.equal(el.disabled, false);
        assert.equal(el.getAttribute('aria-busy'), null);
        assert.equal(el.style.minInlineSize, '');
        // And the button is takeable again, which is what makes a retry possible.
        assert.notEqual(UI.actionBusy(el), null);
    });

    it('takes an empty label for an icon-only control that is named by aria-label', () => {
        const { UI } = load();
        const iconOnly = fakeEl('b', '<i data-lucide="unlink"></i>');
        UI.actionBusy(iconOnly, '');
        assert.match(iconOnly.innerHTML, /spinner/);
        assert.ok(!iconOnly.innerHTML.includes('unlink'), 'the icon is gone while it works');
    });

    it('formBusy still shows its caller-chosen label, unchanged', () => {
        // `buttonSpinner` grew a second argument for `actionBusy`; the one-argument form
        // that every existing `formBusy` call relies on must render exactly as it did.
        const { UI } = load();
        assert.equal(
            UI.buttonSpinner('Saving…'),
            '<span class="spinner spinner-sm spinner-inline"></span><span>Saving…</span>',
        );
    });

    it('escapes the label it is handed', () => {
        const { UI } = load();
        const el = fakeEl('b', 'x');
        UI.actionBusy(el, '<img src=x onerror=alert(1)>');
        assert.ok(!el.innerHTML.includes('<img'), 'no live img tag');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('Admin.runConfirm — the dialog stays alive while the action runs', () => {
    /** A confirm dialog as it exists in the DOM at the moment the button is pressed. */
    function openDialog(l: Loaded): { btn: FakeEl; host: FakeEl } {
        const btn = fakeEl('admin-confirm-btn', '<i data-lucide="trash-2"></i> Delete');
        const host = fakeEl('admin-confirm-error', '');
        l.dom.set('admin-confirm-btn', btn);
        l.dom.set('admin-confirm-error', host);
        return { btn, host };
    }

    it('runs the action and closes on success — in that order', async () => {
        const l = load();
        const { btn } = openDialog(l);
        let sawBusy = false;
        let closedWhenCalled = -1;
        l.Admin._pending = (): Promise<void> => {
            closedWhenCalled = l.closed.count;
            sawBusy = btn.disabled && btn.getAttribute('aria-busy') === 'true';
            return Promise.resolve();
        };

        await l.Admin.runConfirm(btn);

        assert.equal(closedWhenCalled, 0, 'the dialog was still open when the action started');
        assert.ok(sawBusy, 'the confirm button was busy while the action ran');
        assert.equal(l.closed.count, 1, 'and closed once the action resolved');
    });

    it('a synchronous callback closes immediately, exactly as before', () => {
        const l = load();
        const { btn } = openDialog(l);
        let ran = 0;
        l.Admin._pending = (): void => { ran += 1; };

        l.Admin.runConfirm(btn);

        assert.equal(ran, 1);
        assert.equal(l.closed.count, 1);
    });

    /**
     * The optimistic callers (`posts.js: deletePostConfirmed`, `publishNowConfirmed`) remove
     * or grey their card synchronously and only then return a promise. That paint has to
     * happen before anything else, because it is the feedback the operator sees.
     */
    it('lets an optimistic caller paint before the dialog closes', async () => {
        const l = load();
        const { btn } = openDialog(l);
        const order: string[] = [];
        l.Admin._pending = (): Promise<void> => {
            order.push('painted');
            return Promise.resolve().then(() => { order.push('request-settled'); });
        };
        const original = l.UI.closeModal;
        l.UI.closeModal = (): void => { order.push('closed'); original(); };

        await l.Admin.runConfirm(btn);

        assert.deepEqual(order, ['painted', 'request-settled', 'closed']);
    });

    it('a second click while the request is out does nothing at all', async () => {
        const l = load();
        const { btn } = openDialog(l);
        let ran = 0;
        let release: (() => void) | null = null;
        l.Admin._pending = (): Promise<void> => {
            ran += 1;
            return new Promise<void>((resolve) => { release = resolve; });
        };

        const first = l.Admin.runConfirm(btn) as Promise<void>;
        l.Admin.runConfirm(btn); // the double-click
        l.Admin.runConfirm(btn); // and a third, for good measure
        assert.equal(ran, 1, 'the action ran exactly once');
        assert.equal(l.closed.count, 0, 'and nothing closed early');

        release!();
        await first;
        assert.equal(l.closed.count, 1);
    });

    it('keeps the dialog open on failure and puts the reason inside it', async () => {
        const l = load();
        const { btn, host } = openDialog(l);
        const before = btn.innerHTML;
        l.Admin._pending = (): Promise<void> => Promise.reject(new Error('Meta said no'));

        await l.Admin.runConfirm(btn);

        assert.equal(l.closed.count, 0, 'the dialog stayed open');
        assert.match(host.innerHTML, /Meta said no/, 'the reason is in the dialog');
        assert.match(host.innerHTML, /role="alert"/, 'and it is announced');
        assert.equal(btn.innerHTML, before, 'the button came back');
        assert.equal(btn.disabled, false);
        assert.equal(btn.getAttribute('aria-busy'), null);
    });

    it('a failure leaves the action retryable from the same button', async () => {
        const l = load();
        const { btn } = openDialog(l);
        let attempts = 0;
        l.Admin._pending = (): Promise<void> => {
            attempts += 1;
            return attempts === 1 ? Promise.reject(new Error('cold start')) : Promise.resolve();
        };

        await l.Admin.runConfirm(btn);
        assert.equal(l.closed.count, 0);

        await l.Admin.runConfirm(btn);
        assert.equal(attempts, 2, 'the callback was still there for the retry');
        assert.equal(l.closed.count, 1);
    });

    it('a synchronous throw is caught the same way', () => {
        const l = load();
        const { btn, host } = openDialog(l);
        l.Admin._pending = (): never => { throw new Error('bad id'); };

        l.Admin.runConfirm(btn);

        assert.equal(l.closed.count, 0);
        assert.match(host.innerHTML, /bad id/);
        assert.equal(btn.disabled, false);
    });

    it('escapes the error message, which can carry a Meta payload verbatim', () => {
        const l = load();
        const { btn, host } = openDialog(l);
        l.Admin._pending = (): never => { throw new Error('<img src=x onerror=alert(1)>'); };

        l.Admin.runConfirm(btn);

        assert.ok(!host.innerHTML.includes('<img'), 'no live img tag');
        assert.match(host.innerHTML, /&lt;img/);
    });

    it('falls back to a toast if the operator closed the dialog before the failure landed', async () => {
        const l = load();
        const { btn } = openDialog(l);
        l.Admin._pending = (): Promise<void> => {
            // Escape, mid-request: the dialog's nodes stop being findable.
            l.dom.delete('admin-confirm-error');
            return Promise.reject(new Error('too late'));
        };

        await l.Admin.runConfirm(btn);

        assert.equal(l.toasts.length, 1, 'the error was still said out loud');
        assert.equal(l.toasts[0]?.message, 'too late');
        assert.equal(l.toasts[0]?.type, 'error');
    });

    it('closes without complaint when there is nothing pending', () => {
        const l = load();
        openDialog(l);
        l.Admin._pending = null;

        l.Admin.runConfirm();

        assert.equal(l.closed.count, 1);
    });
});
