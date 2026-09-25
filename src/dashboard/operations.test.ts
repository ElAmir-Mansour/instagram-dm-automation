/**
 * Operations — the Gemini key section (#/operations, platform admin only).
 *
 * Loaded like screens.test.ts: the REAL dashboard files in a `node:vm` context with a fake DOM,
 * so these test what ships. The claims pinned here are the ones a screenshot cannot check:
 *
 *   - the section says which key is answering, and never shows a key — only the server's
 *     masked hint of a saved one;
 *   - no key at all reads as the outage it is, not as an empty form;
 *   - Save sends the pasted key once, trimmed, and a spent-quota caveat survives the re-render
 *     that follows, instead of living in a toast that is gone in 4.5s;
 *   - Remove asks first, and says which of the two outcomes it will be: back to the server's
 *     GEMINI_API_KEY, or no key at all.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Translate = (key: string, params?: Record<string, unknown>) => string;

interface GeminiStatus { source: 'database' | 'env' | null; preview: string | null; envFallback: boolean }

interface OpsApi {
    gemini: GeminiStatus | null;
    geminiError: Error | null;
    geminiNotice: string[] | null;
    render(): Promise<void>;
    renderGeminiKey(notice?: string[] | null): { toString(): string };
    saveGeminiKey(form: unknown, event: { preventDefault(): void }): Promise<void>;
    removeGeminiKey(): void;
}

class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields?: Record<string, unknown> } | null) {
        this.fields = (form && form.fields) || {};
    }
    get(name: string): unknown {
        return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null;
    }
}

function load() {
    const noop = (): void => {};
    const stubEl = (): Record<string, unknown> => ({
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '', textContent: '',
    });
    const container = stubEl();
    const api: Record<string, (...args: unknown[]) => unknown> = {};
    const toasts: Array<{ message: string; type?: string }> = [];
    const confirms: Array<Record<string, unknown>> = [];

    const ctx: Record<string, unknown> = {
        document: {
            ...stubEl(),
            createElement: () => stubEl(),
            body: stubEl(), head: stubEl(),
            documentElement: { ...stubEl(), lang: 'ar', dir: 'rtl' },
            getElementById: (id: string) => (id === 'page-container' ? container : null),
            activeElement: null,
            visibilityState: 'visible',
        },
        window: {
            addEventListener: noop, removeEventListener: noop,
            matchMedia: () => ({ matches: false, addEventListener: noop }),
            location: { hash: '' },
        },
        Intl, console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: 'ar' },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop in target
                ? target[prop]
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        App: { session: { tenantId: null }, currentTheme: () => 'auto', navigate: noop, isAdmin: () => true },
        FormData: FakeFormData,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js',
        'dashboard/js/motion.js',
        'dashboard/js/pages/admin_common.js',
        'dashboard/js/pages/operations.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    const { OperationsPage, UI, Admin, t, I18N } = vm.runInContext('({ OperationsPage, UI, Admin, t, I18N })', ctx) as {
        OperationsPage: OpsApi; UI: Record<string, unknown>; Admin: Record<string, unknown>;
        t: Translate; I18N: { lang: string };
    };
    UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    Admin.confirm = (opts: Record<string, unknown>) => { confirms.push(opts); };
    return { Ops: OperationsPage, t, I18N, api, toasts, confirms, container };
}

/** A form whose submit button `UI.formBusy` can disable and restore. */
function fakeForm(apiKey: unknown) {
    const button = { disabled: false, innerHTML: 'Check and save', querySelectorAll: () => [], getAttribute: () => null };
    return { fields: { apiKey }, button, querySelector: (sel: string) => (sel === 'button[type="submit"]' ? button : null) };
}

const event = { preventDefault: () => {} };
const SAVED: GeminiStatus = { source: 'database', preview: 'AIz•••••••••••••89', envFallback: true };

describe('Operations — the Gemini key section', () => {
    it('names the saved key by its masked hint, and offers to remove it', () => {
        const { Ops, t } = load();
        Ops.gemini = SAVED;
        const markup = String(Ops.renderGeminiKey());

        assert.ok(markup.includes(t('ops.gemini.fromDatabase')));
        // Isolated: a Latin hint inside Arabic copy reorders around its bullets otherwise.
        assert.ok(markup.includes(`<bdi class="ltr-text" dir="ltr">${SAVED.preview}</bdi>`));
        assert.ok(markup.includes('data-action="ops:removeGeminiKey"'));
        // The field only ever takes a new key: never prefilled, and masked while typed.
        const input = markup.match(/<input[^>]*id="gemini-key-input"[^>]*>/)?.[0] ?? '';
        assert.match(input, /type="password"/);
        assert.match(input, /autocomplete="new-password"/);
        assert.doesNotMatch(input, /\svalue=/);
    });

    it('says the server\'s key is answering, with nothing saved to remove', () => {
        const { Ops, t } = load();
        Ops.gemini = { source: 'env', preview: null, envFallback: true };
        const markup = String(Ops.renderGeminiKey());

        assert.ok(markup.includes(t('ops.gemini.fromEnv')));
        assert.ok(!markup.includes('ops:removeGeminiKey'));
    });

    it('reads as an outage when there is no key at all', () => {
        const { Ops, t } = load();
        Ops.gemini = { source: null, preview: null, envFallback: false };
        const markup = String(Ops.renderGeminiKey());

        assert.ok(markup.includes('role="alert"'));
        assert.ok(markup.includes(t('ops.gemini.none')));
    });

    it('says the status could not be read, rather than drawing an empty form', () => {
        const { Ops, t } = load();
        Ops.geminiError = new Error('HTTP 500');
        const markup = String(Ops.renderGeminiKey());

        assert.ok(markup.includes(t('ops.gemini.loadFailed', { message: 'HTTP 500' })));
        assert.ok(!markup.includes('gemini-key-form'));
    });

    it('is on the page the admin opens, under the tenant cards', async () => {
        const { Ops, api, container, t } = load();
        api.getAdminOps = () => Promise.resolve({ tenants: [] });
        api.getGeminiKey = () => Promise.resolve({ source: 'env', preview: null, envFallback: true });

        await Ops.render();
        const html = String(container.innerHTML);
        assert.ok(html.includes(t('ops.gemini.title')));
        assert.ok(html.indexOf(t('ops.tenantsTitle')) < html.indexOf(t('ops.gemini.title')));
    });

    it('still draws the rest of Operations when only the key status fails', async () => {
        const { Ops, api, container, t } = load();
        api.getAdminOps = () => Promise.resolve({ tenants: [] });
        api.getGeminiKey = () => Promise.reject(new Error('HTTP 500'));

        await Ops.render();
        const html = String(container.innerHTML);
        assert.ok(html.includes(t('ops.tenantsTitle')));
        assert.ok(html.includes(t('ops.gemini.loadFailed', { message: 'HTTP 500' })));
    });

    it('sends the pasted key once, trimmed, and re-renders so the field is empty again', async () => {
        const { Ops, api, toasts, t } = load();
        const sent: unknown[] = [];
        let renders = 0;
        api.saveGeminiKey = (key: unknown) => { sent.push(key); return Promise.resolve({ ...SAVED, quotaSpent: [] }); };
        Ops.render = async () => { renders += 1; };

        await Ops.saveGeminiKey(fakeForm('  AIzaSyD-pasted-0123456789\n'), event);

        assert.deepEqual(sent, ['AIzaSyD-pasted-0123456789']);
        assert.equal(renders, 1);
        assert.deepEqual(toasts, [{ message: t('ops.gemini.saved'), type: 'success' }]);
        assert.equal(Ops.geminiNotice, null, 'nothing to warn about');
    });

    it('does not send a blank paste, or a second one while the first is in flight', async () => {
        const { Ops, api } = load();
        let calls = 0;
        api.saveGeminiKey = () => { calls += 1; return new Promise(() => {}); };

        await Ops.saveGeminiKey(fakeForm('   '), event);
        const form = fakeForm('AIzaSyD-pasted-0123456789');
        void Ops.saveGeminiKey(form, event);
        await Ops.saveGeminiKey(form, event);

        assert.equal(calls, 1);
    });

    it('keeps a spent-quota caveat for the re-render, and shows the models isolated', async () => {
        const { Ops, api, t } = load();
        api.saveGeminiKey = () => Promise.resolve({ ...SAVED, quotaSpent: ['gemini-2.5-flash'] });
        Ops.render = async () => {};

        await Ops.saveGeminiKey(fakeForm('AIzaSyD-pasted-0123456789'), event);
        assert.deepEqual(Ops.geminiNotice, ['gemini-2.5-flash']);

        Ops.gemini = SAVED;
        const markup = String(Ops.renderGeminiKey(Ops.geminiNotice));
        assert.ok(markup.includes(t('ops.gemini.quotaSpent')));
        assert.match(markup, /<bdi[^>]*dir="ltr"[^>]*>gemini-2\.5-flash<\/bdi>/);
    });

    it('shows Google\'s refusal and keeps the paste, so a typo can be fixed', async () => {
        const { Ops, api, toasts } = load();
        let renders = 0;
        api.saveGeminiKey = () => Promise.reject(new Error('Google refused this key: API key not valid.'));
        Ops.render = async () => { renders += 1; };
        const form = fakeForm('AIzaSyD-typo-0123456789');

        await Ops.saveGeminiKey(form, event);

        assert.equal(renders, 0, 'no re-render, which would drop the paste');
        assert.equal(form.button.disabled, false, 'and the button works again');
        assert.deepEqual(toasts, [{ message: 'Google refused this key: API key not valid.', type: 'error' }]);
    });

    it('asks before removing, and says the server\'s key takes over', () => {
        const { Ops, confirms, t } = load();
        Ops.gemini = SAVED;
        Ops.removeGeminiKey();

        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, t('ops.gemini.removeBodyEnv'));
    });

    it('warns that removing leaves no key at all when the server has none', () => {
        const { Ops, confirms, t } = load();
        Ops.gemini = { ...SAVED, envFallback: false };
        Ops.removeGeminiKey();

        assert.equal(confirms[0]!.body, t('ops.gemini.removeBodyNone'));
    });

    it('reads in English too', () => {
        const { Ops, I18N, t } = load();
        I18N.lang = 'en';
        Ops.gemini = { source: 'env', preview: null, envFallback: true };
        const markup = String(Ops.renderGeminiKey());

        assert.ok(markup.includes('In use: the server’s key, GEMINI_API_KEY.'));
        assert.equal(t('ops.gemini.save'), 'Check and save');
    });
});
