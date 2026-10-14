/**
 * AI settings: the reply engine picker and the Gemini fallback switch (DM plan S3).
 *
 * The REAL `ai_settings.js` in a `node:vm` context, as screens.test.ts and wave2-settings.test.ts load it, in both languages: a
 * template that throws blanks the whole screen, and a string that exists in one language renders English inside the Arabic page.
 *
 * What is pinned: the picker offers exactly the engines the server runs; the fallback switch means something only for AI providers;
 * what is saved and tested is what is on screen; the hint about the "dm" route is only a hint (silent for anyone who cannot read the
 * layer's status, never an error) and is written as text; a test reply says which engine wrote it, with the server's words escaped.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { DM_ENGINES } from '../services/dmEngine.js';

type Json = Record<string, any>;
type Lang = 'ar' | 'en';

interface FakeEl {
    id: string;
    value: string;
    checked: boolean;
    disabled: boolean;
    innerHTML: string;
    textContent: string;
    scrollTop: number;
    scrollHeight: number;
    classes: Set<string>;
    classList: { toggle(name: string, force?: boolean): boolean; add(name: string): void; remove(name: string): void; contains(name: string): boolean };
    inserted: string[];
    insertAdjacentHTML(where: string, markup: string): void;
    querySelector(selector: string): unknown;
    focus(): void;
    setAttribute(): void;
    getAttribute(): null;
}

function fakeEl(id: string, over: Partial<FakeEl> = {}): FakeEl {
    const classes = new Set<string>();
    const el: FakeEl = {
        id, value: '', checked: false, disabled: false, innerHTML: '', textContent: '', scrollTop: 0, scrollHeight: 0, classes,
        classList: {
            toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : force; if (on) classes.add(name); else classes.delete(name); return on; },
            add: (name) => { classes.add(name); }, remove: (name) => { classes.delete(name); }, contains: (name) => classes.has(name),
        },
        inserted: [],
        insertAdjacentHTML(_where, markup) { this.inserted.push(markup); },
        querySelector: () => null, focus: () => {}, setAttribute: () => {}, getAttribute: () => null,
        ...over,
    };
    return el;
}

function load(lang: Lang, opts: { admin?: boolean; api?: Json } = {}) {
    const noop = (): void => {};
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
    const dom = new Map<string, FakeEl>();
    const adminCalls: number[] = [];
    const api: Json = {
        token: 'test',
        getAdminAi: async () => { adminCalls.push(1); return { purposes: [], providers: [] }; },
        ...(opts.api ?? {}),
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
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '#/ai_settings' } },
        location: { hash: '#/ai_settings', pathname: '/dashboard', origin: 'https://example.test' },
        Intl, console, clearTimeout, clearInterval, setTimeout, setInterval,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: api,
        App: { currentTheme: () => 'auto', navigate: noop, isAdmin: () => opts.admin ?? true },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        URLSearchParams,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js',
        'dashboard/js/motion.js',
        'dashboard/js/pages/ai_settings.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const pages = vm.runInContext('({ AiSettingsPage, UI, t })', ctx) as {
        AiSettingsPage: Json; UI: Json; t: (key: string, params?: Json) => string;
    };
    // The real toast needs a container this DOM does not have; what was said is the point.
    const toasts: { message: string; type?: string }[] = [];
    pages.UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    return { ...pages, dom, toasts, adminCalls, api };
}

/** The elements the form holds, as `loadSettings` and `saveSettings` find them by id. */
function mountForm(dom: Map<string, FakeEl>): void {
    for (const id of [
        'ai-active-toggle', 'system-prompt-text', 'knowledge-base-text', 'model-selector', 'temp-slider', 'temp-value', 'save-settings-btn',
        'ai-settings-error', 'engine-selector', 'gemini-fallback-toggle', 'fallback-block', 'engine-route-hint', 'ai-unsaved-note',
    ]) dom.set(id, fakeEl(id));
    dom.get('engine-selector')!.value = 'gemini';
    dom.get('gemini-fallback-toggle')!.checked = true;
    dom.get('fallback-block')!.classes.add('hidden');
    dom.get('engine-route-hint')!.classes.add('hidden');
}

const LANGS = ['ar', 'en'] as const;
/** Objects made inside the vm have another realm's prototypes, which `deepStrictEqual` refuses: compare what they say, not what they are. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const text = (markup: unknown) => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** What the page wraps a Latin name in so the sentence around it cannot reorder it (first-strong isolate). */
const iso = (value: string): string => `\u2068${value}\u2069`;

/** A `GET /api/admin/ai` body, cut to what the hint reads. */
const view = (dm: Json, providers: Json[] = [{ id: 'anthropic', label: 'Anthropic' }]) => ({
    providers,
    purposes: [{ purpose: 'onboarding_draft', resolved: { provider: 'anthropic', model: 'x', effort: 'high', source: 'default' } }, { purpose: 'dm', ...dm }],
});
const SAVED_ROUTE = view({ saved: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' }, resolved: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', source: 'saved' } });
const DEFAULT_ROUTE = view({ saved: null, resolved: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', source: 'default' } });
const NO_ROUTE = view({ saved: null, resolved: { error: { kind: 'no_provider', message: 'No AI provider is ready: save an API key for one in Operations → AI providers.' } } });

describe('AI settings — the engine picker', () => {
    for (const lang of LANGS) {
        it(`offers exactly the engines the server runs, Gemini first, with a label and a description (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const shell = String(AiSettingsPage.shell());
            const select = shell.match(/<select[^>]*\bid="engine-selector"[^>]*>([\s\S]*?)<\/select>/);
            assert.ok(select, 'the form has an engine picker');
            const offered = [...select![1]!.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]);
            assert.deepEqual(offered, [...DM_ENGINES], 'in the server\'s own list and order, so a third engine added there fails here');
            assert.ok(/<label[^>]*for="engine-selector"[^>]*>\s*([^<]*)/.test(shell) && shell.includes(t('ai.engine')), 'a label for it');
            assert.ok(shell.includes(t('ai.engineGemini')) && shell.includes(t('ai.engineProviders')));
            assert.ok(/id="engine-desc"/.test(shell) && shell.includes(t('ai.engineDesc')));
            assert.match(shell, /<select[^>]*\bid="engine-selector"[^>]*\baria-describedby="engine-desc engine-route-hint"/);
            assert.match(shell, /<select[^>]*\bid="engine-selector"[^>]*\bdata-change="ai:engineChanged"/, 'a change reaches the page');
            assert.equal(/ai\.engine|ai\.fallback|ai\.sandboxVia/.test(text(shell)), false, 'no raw key reaches the screen');
        });

        it(`carries the Gemini fallback switch: on, hidden until AI providers is picked, with a name for assistive technology (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const shell = String(AiSettingsPage.shell());
            assert.match(shell, /<div class="toggle-block hidden" id="fallback-block">/);
            assert.match(shell, /<input type="checkbox" id="gemini-fallback-toggle" data-change="ai:fallbackChanged" checked>/);
            assert.match(shell, /<label class="switch" for="gemini-fallback-toggle">\s*<span class="sr-only">[^<]*<\/span>/);
            assert.ok(shell.includes(t('ai.fallbackTitle')) && shell.includes(t('ai.fallbackDesc')) && shell.includes(t('ai.fallbackLabel')));
        });

        it(`has a polite status region for the route hint, hidden while there is nothing to say (${lang})`, () => {
            const { AiSettingsPage } = load(lang);
            assert.match(String(AiSettingsPage.shell()), /<p class="form-hint hidden" id="engine-route-hint" role="status" aria-live="polite"><\/p>/);
        });

        it(`names every string it shows in both languages, and keeps the model hint (${lang})`, () => {
            const { t } = load(lang);
            for (const key of [
                'ai.engine', 'ai.engineGemini', 'ai.engineProviders', 'ai.engineDesc', 'ai.engineNoRouteOn', 'ai.engineNoRouteOff', 'ai.engineDefaultRoute',
                'ai.engineSavedRoute', 'ai.fallbackTitle', 'ai.fallbackDesc', 'ai.fallbackLabel', 'ai.sandboxViaGemini', 'ai.sandboxViaProviders',
                'ai.sandboxViaFallback', 'ai.enableDesc', 'ai.sandboxDesc',
            ]) {
                const value = t(key, { provider: 'P', model: 'M', effort: 'E', reason: 'R' });
                assert.notEqual(value, key, `${key} is translated`);
                assert.equal(/\{\w+\}/.test(value), false, `${key} has no unfilled placeholder`);
            }
        });
    }

    it('no longer says the reply is always Gemini\'s: the switch is "using AI", and the sandbox runs the engine picked', () => {
        for (const lang of LANGS) {
            const { t } = load(lang);
            assert.equal(/Gemini/.test(t('ai.enableDesc')), false, `${lang} enableDesc`);
            assert.equal(/Gemini/.test(t('ai.sandboxDesc')), false, `${lang} sandboxDesc`);
        }
    });
});

describe('AI settings — loading and what counts as unsaved', () => {
    const settings = { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7 };

    it('fills the picker and the switch from the server, and shows the switch only for AI providers', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...settings, engine: 'providers', gemini_fallback: false }) } });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        assert.equal(dom.get('engine-selector')!.value, 'providers');
        assert.equal(dom.get('gemini-fallback-toggle')!.checked, false);
        assert.equal(dom.get('fallback-block')!.classes.has('hidden'), false);
    });

    it('reads a server that sends neither (an old one, a row from before v37) as Gemini with the fallback on, and keeps the switch hidden', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...settings }) } });
        mountForm(dom);
        dom.get('engine-selector')!.value = 'providers';
        dom.get('gemini-fallback-toggle')!.checked = false;
        await AiSettingsPage.loadSettings();
        assert.equal(dom.get('engine-selector')!.value, 'gemini');
        assert.equal(dom.get('gemini-fallback-toggle')!.checked, true);
        assert.equal(dom.get('fallback-block')!.classes.has('hidden'), true);
    });

    it('does not trust an engine it does not know: the picker shows Gemini, which is what would run', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...settings, engine: 'claude' }) } });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        assert.equal(dom.get('engine-selector')!.value, 'gemini');
    });

    it('counts a changed engine or switch as unsaved, as it counts the model and the temperature, and not as a draft to keep', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...settings, engine: 'gemini', gemini_fallback: true }) } });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        dom.get('engine-selector')!.value = 'providers';
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
        dom.get('engine-selector')!.value = 'gemini';
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        dom.get('gemini-fallback-toggle')!.checked = false;
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
        assert.equal(AiSettingsPage.isDirty(), false, 'the reload guard still only protects the two texts');
    });

    it('a screen without the picker (the elements are not there) reads and saves as it always did', () => {
        const { AiSettingsPage, dom } = load('en');
        for (const id of ['ai-active-toggle', 'model-selector', 'temp-slider']) dom.set(id, fakeEl(id));
        dom.get('model-selector')!.value = 'gemini-2.5-flash';
        dom.get('temp-slider')!.value = '0.7';
        dom.get('ai-active-toggle')!.checked = true;
        assert.deepEqual(plain(AiSettingsPage.currentSettings()), { is_active: true, model: 'gemini-2.5-flash', temperature: '0.7' });
        assert.equal(AiSettingsPage.engineValue(), 'gemini');
        assert.equal(AiSettingsPage.fallbackOn(), true);
    });
});

describe('AI settings — saving and testing what is on screen', () => {
    async function saved(over: (dom: Map<string, FakeEl>) => void) {
        const payloads: Json[] = [];
        const { AiSettingsPage, dom, toasts } = load('en', {
            api: {
                getAiSettings: async () => ({ is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7 }),
                saveAiSettings: async (payload: Json) => { payloads.push(payload); return {}; },
            },
        });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        over(dom);
        await AiSettingsPage.saveSettings({ querySelector: () => null }, { preventDefault() {} });
        return { payload: payloads[0]!, AiSettingsPage, toasts, dom };
    }

    it('sends the engine and the fallback switch with every save, as they are on screen', async () => {
        const { payload } = await saved((dom) => { dom.get('engine-selector')!.value = 'providers'; dom.get('gemini-fallback-toggle')!.checked = false; });
        assert.equal(payload.engine, 'providers');
        assert.equal(payload.gemini_fallback, false);
        assert.equal(payload.system_prompt, 'p');
        assert.equal(payload.model, 'gemini-2.5-flash');
    });

    it('sends Gemini and the fallback on for a form left alone: what is saved is never a default nobody saw', async () => {
        const { payload } = await saved(() => {});
        assert.equal(payload.engine, 'gemini');
        assert.equal(payload.gemini_fallback, true);
    });

    it('treats the form as saved afterwards: nothing is unsaved until the next change', async () => {
        const { AiSettingsPage, dom } = await saved((d) => { d.get('engine-selector')!.value = 'providers'; });
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        dom.get('engine-selector')!.value = 'gemini';
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
    });

    it('the sandbox sends the engine and the fallback on screen with the draft, so the test runs what is about to be saved', () => {
        const { AiSettingsPage, dom } = load('en');
        mountForm(dom);
        dom.get('system-prompt-text')!.value = 'draft';
        dom.get('knowledge-base-text')!.value = 'kb';
        dom.get('model-selector')!.value = 'gemini-2.5-flash';
        dom.get('temp-slider')!.value = '0.7';
        dom.get('engine-selector')!.value = 'providers';
        dom.get('gemini-fallback-toggle')!.checked = false;
        assert.deepEqual(plain(AiSettingsPage.sandboxPayload('hello')), {
            system_prompt: 'draft', knowledge_base: 'kb', user_message: 'hello', model: 'gemini-2.5-flash', temperature: 0.7,
            engine: 'providers', gemini_fallback: false,
        });
    });

    it('says which engine wrote a test reply, and that AI providers failed when Gemini answered instead', () => {
        for (const lang of LANGS) {
            const { AiSettingsPage, t } = load(lang);
            assert.equal(AiSettingsPage.sandboxVia({ text: 'x', engine: 'gemini' }), t('ai.sandboxViaGemini'));
            assert.equal(AiSettingsPage.sandboxVia({ text: 'x', engine: 'providers' }), t('ai.sandboxViaProviders'));
            assert.equal(AiSettingsPage.sandboxVia({ text: 'x', engine: 'gemini', fell_back: true, fallback_reason: 'budget' }), t('ai.sandboxViaFallback', { reason: iso('budget') }));
            assert.ok(AiSettingsPage.sandboxVia({ text: 'x', engine: 'gemini', fell_back: true, fallback_reason: 'budget' }).includes('budget'));
            assert.equal(AiSettingsPage.sandboxVia({ text: 'x' }), '', 'a server that does not say');
            assert.equal(AiSettingsPage.sandboxVia(null), '');
        }
    });

    it('escapes what the server says about a failure when it renders a test reply', async () => {
        const hostile = '<img src=x onerror=alert(1)>';
        const { AiSettingsPage, dom } = load('en', {
            api: { testAiSettings: async () => ({ message_type: 'text', text: 'ok <b>x</b>', engine: 'gemini', fell_back: true, fallback_reason: hostile }) },
        });
        mountForm(dom);
        const container = fakeEl('sandbox-messages-container', { querySelector: () => null });
        const input = fakeEl('sandbox-user-input', { value: 'hello' });
        dom.set('sandbox-messages-container', container);
        dom.set('sandbox-user-input', input);
        await AiSettingsPage.sendSandboxTest({ querySelector: () => null }, { preventDefault() {} });

        const shown = container.inserted.join('\n');
        assert.ok(shown.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the reason is shown, as text');
        assert.equal(/<img/i.test(shown), false, 'and is never markup');
        assert.equal(/<b>/i.test(shown), false, 'nor is the reply');
        assert.ok(shown.includes('form-hint text-warning'), 'a fallback is a warning, not a plain line (`.form-hint.text-warning` is the rule that colours it)');
    });
});

describe('AI settings — the hint about the "dm" route', () => {
    for (const lang of LANGS) {
        it(`says nothing when the route status is not there to read, and never throws (${lang})`, () => {
            const { AiSettingsPage } = load(lang);
            for (const nothing of [null, undefined, {}, { purposes: 'no' }, { purposes: [] }, { purposes: [{ purpose: 'onboarding_draft' }] }, { purposes: [{ purpose: 'dm' }] }]) {
                assert.equal(AiSettingsPage.routeHint(nothing, true), null, JSON.stringify(nothing));
            }
        });

        it(`warns when no provider can answer: with the fallback on it says Gemini answers meanwhile, with it off it says nothing is sent (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            assert.deepEqual(plain(AiSettingsPage.routeHint(NO_ROUTE, true)), { tone: 'warning', text: t('ai.engineNoRouteOn') });
            assert.deepEqual(plain(AiSettingsPage.routeHint(NO_ROUTE, false)), { tone: 'warning', text: t('ai.engineNoRouteOff') });
            assert.notEqual(t('ai.engineNoRouteOn'), t('ai.engineNoRouteOff'));
        });

        it(`warns when no route is saved and names the provider and model that would answer instead (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const hint = AiSettingsPage.routeHint(DEFAULT_ROUTE, true);
            assert.equal(hint.tone, 'warning');
            assert.equal(hint.text, t('ai.engineDefaultRoute', { provider: iso('Anthropic'), model: iso('claude-opus-5-5'), effort: iso('low') }));
            assert.ok(hint.text.includes(iso('Anthropic')) && hint.text.includes(iso('claude-opus-5-5')), 'each Latin name is isolated from the sentence around it');
        });

        it(`is a quiet line when a route is saved (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            assert.deepEqual(plain(AiSettingsPage.routeHint(SAVED_ROUTE, true)), {
                tone: 'muted', text: t('ai.engineSavedRoute', { provider: iso('Anthropic'), model: iso('claude-sonnet-5-5'), effort: iso('low') }),
            });
        });
    }

    it('writes the hint as text, never as markup: a provider label with HTML in it stays text', () => {
        const { AiSettingsPage, dom } = load('en');
        mountForm(dom);
        const hostile = '<img src=x onerror=alert(1)>';
        dom.get('engine-selector')!.value = 'providers';
        AiSettingsPage._routeView = view(
            { saved: null, resolved: { provider: 'anthropic', model: 'm', effort: 'low', source: 'default' } },
            [{ id: 'anthropic', label: hostile }]
        );
        AiSettingsPage.showRouteHint();
        const hint = dom.get('engine-route-hint')!;
        assert.ok(hint.textContent.includes(hostile));
        assert.equal(hint.innerHTML, '', 'innerHTML is never written');
        assert.equal(hint.classes.has('hidden'), false);
        assert.equal(hint.classes.has('text-warning'), true);
    });

    it('asks the layer\'s status only of a platform admin, once per visit, and only when AI providers is picked', async () => {
        const { AiSettingsPage, dom, adminCalls } = load('en', { admin: true, api: { getAdminAi: async () => { adminCalls.push(1); return NO_ROUTE; } } });
        mountForm(dom);
        AiSettingsPage.syncEngine();
        assert.equal(adminCalls.length, 0, 'Gemini needs no route');

        dom.get('engine-selector')!.value = 'providers';
        AiSettingsPage.engineChanged();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(adminCalls.length, 1);
        assert.equal(dom.get('fallback-block')!.classes.has('hidden'), false);
        assert.equal(dom.get('engine-route-hint')!.classes.has('hidden'), false);
        assert.equal(dom.get('engine-route-hint')!.textContent.length > 0, true);

        dom.get('engine-selector')!.value = 'gemini';
        AiSettingsPage.engineChanged();
        dom.get('engine-selector')!.value = 'providers';
        AiSettingsPage.engineChanged();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(adminCalls.length, 1, 'cached for the visit');
    });

    it('is silent for anyone who is not a platform admin, without calling an endpoint that would 404 for them', async () => {
        const { AiSettingsPage, dom, adminCalls } = load('en', { admin: false });
        mountForm(dom);
        dom.get('engine-selector')!.value = 'providers';
        AiSettingsPage.engineChanged();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(adminCalls.length, 0);
        assert.equal(dom.get('engine-route-hint')!.textContent, '');
        assert.equal(dom.get('engine-route-hint')!.classes.has('hidden'), true);
        assert.equal(dom.get('fallback-block')!.classes.has('hidden'), false, 'the switch is still theirs to set');
    });

    it('is silent, not an error, when the status call fails', async () => {
        const { AiSettingsPage, dom, toasts } = load('en', { api: { getAdminAi: async () => { throw new Error('502'); } } });
        mountForm(dom);
        dom.get('engine-selector')!.value = 'providers';
        AiSettingsPage.engineChanged();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(dom.get('engine-route-hint')!.textContent, '');
        assert.equal(toasts.length, 0);
    });

    it('follows the fallback switch: the same missing key reads differently with it on and off', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAdminAi: async () => NO_ROUTE } });
        mountForm(dom);
        dom.get('engine-selector')!.value = 'providers';
        AiSettingsPage.engineChanged();
        await new Promise((resolve) => setImmediate(resolve));
        const on = dom.get('engine-route-hint')!.textContent;
        dom.get('gemini-fallback-toggle')!.checked = false;
        AiSettingsPage.fallbackChanged();
        assert.notEqual(dom.get('engine-route-hint')!.textContent, on);
    });

    it('drops an answer that arrives after the operator left the page', async () => {
        let release: (v: unknown) => void = () => {};
        const { AiSettingsPage, dom } = load('en', { api: { getAdminAi: () => new Promise((resolve) => { release = resolve; }) } });
        mountForm(dom);
        dom.get('engine-selector')!.value = 'providers';
        AiSettingsPage.engineChanged();
        AiSettingsPage.destroy();
        release(NO_ROUTE);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(dom.get('engine-route-hint')!.textContent, '', 'those elements belong to another page now');
    });
});
