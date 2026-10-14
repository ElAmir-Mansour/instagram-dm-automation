/**
 * AI settings: the sales assistant's picker and its test senders (DM plan S6).
 *
 * The REAL `ai_settings.js` in a `node:vm` context, as `aiEngine.test.ts` loads it, in both languages: a template that throws blanks the
 * whole screen, and a string that exists in one language renders English inside the Arabic page.
 *
 * What is pinned: the picker offers exactly the modes the server runs, Off first (today's replies, and the default); the test-sender box
 * is there only for Test; what is saved is what is on screen, cleaned the way the server cleans it; a bad ID is stopped before the
 * request with the ID shown as text; the help says that Test answers ONLY those senders; and a screen without the controls (an older
 * form) reads and saves as it always did.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { SALES_MODES } from '../services/dmSales/mode.js';

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

/** The elements the form holds, as `loadSettings` and `saveSettings` find them by id; `sales: false` is a screen from before the picker. */
function mountForm(dom: Map<string, FakeEl>, { sales = true }: { sales?: boolean } = {}): void {
    for (const id of [
        'ai-active-toggle', 'system-prompt-text', 'knowledge-base-text', 'model-selector', 'temp-slider', 'temp-value', 'save-settings-btn',
        'ai-settings-error', 'engine-selector', 'gemini-fallback-toggle', 'fallback-block', 'engine-route-hint', 'ai-unsaved-note',
        ...(sales ? ['sales-mode-selector', 'sales-test-senders', 'sales-senders-block', 'sales-senders-hint'] : []),
    ]) dom.set(id, fakeEl(id));
    dom.get('engine-selector')!.value = 'gemini';
    dom.get('gemini-fallback-toggle')!.checked = true;
    dom.get('fallback-block')!.classes.add('hidden');
    dom.get('engine-route-hint')!.classes.add('hidden');
    if (sales) {
        dom.get('sales-mode-selector')!.value = 'off';
        dom.get('sales-senders-block')!.classes.add('hidden');
        dom.get('sales-senders-hint')!.classes.add('hidden');
    }
}

const LANGS = ['ar', 'en'] as const;
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const text = (markup: unknown) => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const iso = (value: string): string => `⁨${value}⁩`;

const SETTINGS = { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7 };
const ID_A = '17841400000000001';
const ID_B = '17841400000000002';

describe('AI settings — the sales assistant\'s picker', () => {
    for (const lang of LANGS) {
        it(`offers exactly the modes the server runs, Off first, with a label and a description that says what Test answers (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const shell = String(AiSettingsPage.shell());
            const select = shell.match(/<select[^>]*\bid="sales-mode-selector"[^>]*>([\s\S]*?)<\/select>/);
            assert.ok(select, 'the form has a sales picker');
            assert.deepEqual([...select![1]!.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map((m) => m[1]), [...SALES_MODES], 'in the server\'s own list and order');
            assert.ok(/<label[^>]*for="sales-mode-selector"[^>]*>\s*([^<]*)/.test(shell) && shell.includes(t('ai.sales')), 'a label for it');
            for (const key of ['ai.salesOff', 'ai.salesTest', 'ai.salesOn']) assert.ok(shell.includes(t(key)), key);
            assert.ok(/id="sales-desc"/.test(shell) && shell.includes(t('ai.salesDesc')));
            assert.match(shell, /<select[^>]*\bid="sales-mode-selector"[^>]*\baria-describedby="sales-desc"/);
            assert.match(shell, /<select[^>]*\bid="sales-mode-selector"[^>]*\bdata-change="ai:salesChanged"/, 'a change reaches the page');
            assert.equal(/ai\.sales/.test(text(shell)), false, 'no raw key reaches the screen');
        });

        it(`explains in words that Test answers ONLY the listed senders and Off changes nothing (${lang})`, () => {
            const { t } = load(lang);
            const help = t('ai.salesDesc');
            if (lang === 'en') {
                assert.match(help, /Off keeps every reply exactly as it is today/);
                assert.match(help, /Test answers ONLY the test senders listed below/);
                assert.match(help, /everyone else still gets the usual replies/);
                assert.match(t('ai.salesSendersDesc'), /only these senders get sales replies/);
            } else {
                assert.match(help, /عند الإيقاف تبقى كل الردود كما هي اليوم/);
                assert.match(help, /المدرجين أدناه فقط/);
                assert.match(t('ai.salesSendersDesc'), /إلا إلى هؤلاء/);
            }
        });

        it(`has the test-sender box, hidden until Test is picked, left to right (the IDs are numbers), with its help and a polite status region (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const shell = String(AiSettingsPage.shell());
            assert.match(shell, /<div class="form-group hidden" id="sales-senders-block">/);
            assert.match(shell, /<textarea id="sales-test-senders"[^>]*\bdir="ltr"[^>]*\binputmode="numeric"/);
            assert.match(shell, /<textarea id="sales-test-senders"[^>]*\baria-describedby="sales-senders-desc sales-senders-hint"/);
            assert.match(shell, /<textarea id="sales-test-senders"[^>]*\bdata-input="ai:salesChanged"/);
            assert.match(shell, /<p class="form-hint hidden" id="sales-senders-hint" role="status" aria-live="polite"><\/p>/);
            assert.ok(shell.includes(t('ai.salesSenders')) && shell.includes(t('ai.salesSendersDesc')));
            assert.match(shell, /<label[^>]*for="sales-test-senders"/);
        });

        it(`has every string in both languages, with no placeholder left unfilled (${lang})`, () => {
            const { t } = load(lang);
            for (const key of [
                'ai.sales', 'ai.salesOff', 'ai.salesTest', 'ai.salesOn', 'ai.salesDesc', 'ai.salesSenders', 'ai.salesSendersDesc', 'ai.salesSendersPlaceholder',
                'ai.salesSendersEmpty', 'ai.salesSendersInvalid', 'ai.salesSendersMany',
            ]) {
                const value = t(key, { value: 'V', max: 20 });
                assert.notEqual(value, key, `${key} is translated`);
                assert.equal(/\{\w+\}/.test(value), false, `${key} has no unfilled placeholder`);
            }
        });
    }

    it('shows no digit of the Arabic-Indic script anywhere in the Arabic strings (the dashboard pins Latin digits)', () => {
        const { t } = load('ar');
        for (const key of ['ai.salesDesc', 'ai.salesSendersDesc', 'ai.salesSendersEmpty', 'ai.salesSendersInvalid', 'ai.salesSendersMany']) {
            assert.equal(/[٠-٩۰-۹]/.test(t(key, { value: 'V', max: 20 })), false, key);
        }
    });
});

describe('AI settings — loading the sales controls and what counts as unsaved', () => {
    it('fills the picker and the senders from the server, and shows the senders box only in Test', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'test', sales_test_senders: [ID_A, ID_B] }) } });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        assert.equal(dom.get('sales-mode-selector')!.value, 'test');
        assert.equal(dom.get('sales-test-senders')!.value, `${ID_A}\n${ID_B}`);
        assert.equal(dom.get('sales-senders-block')!.classes.has('hidden'), false);
    });

    it('On keeps the senders box out of the way, and the list as saved', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'on', sales_test_senders: [ID_A] }) } });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        assert.equal(dom.get('sales-mode-selector')!.value, 'on');
        assert.equal(dom.get('sales-senders-block')!.classes.has('hidden'), true);
        assert.equal(dom.get('sales-test-senders')!.value, ID_A);
    });

    it('reads a server that sends neither (an old one, a row from before v39) as Off with no senders', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...SETTINGS }) } });
        mountForm(dom);
        dom.get('sales-mode-selector')!.value = 'on';
        dom.get('sales-test-senders')!.value = ID_A;
        await AiSettingsPage.loadSettings();
        assert.equal(dom.get('sales-mode-selector')!.value, 'off');
        assert.equal(dom.get('sales-test-senders')!.value, '');
        assert.equal(dom.get('sales-senders-block')!.classes.has('hidden'), true);
    });

    it('does not trust a mode it does not know: the picker shows Off, which is what would run', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'sales' }) } });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        assert.equal(dom.get('sales-mode-selector')!.value, 'off');
    });

    it('counts a changed mode or list as unsaved, and the same list typed with other separators or spaces as the same', async () => {
        const { AiSettingsPage, dom } = load('en', { api: { getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'test', sales_test_senders: [ID_A, ID_B] }) } });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        dom.get('sales-mode-selector')!.value = 'on';
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
        dom.get('sales-mode-selector')!.value = 'test';
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        dom.get('sales-test-senders')!.value = `  ${ID_A},  ${ID_B}  \n`;
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false, 'spaces and commas are not a change');
        dom.get('sales-test-senders')!.value = ID_A;
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
        assert.equal(AiSettingsPage.isDirty(), false, 'the reload guard still only protects the two texts');
    });

    it('a screen without the controls (an older form) reads as it always did: no sales key in what it saves', () => {
        const { AiSettingsPage, dom } = load('en');
        mountForm(dom, { sales: false });
        dom.get('model-selector')!.value = 'gemini-2.5-flash';
        dom.get('temp-slider')!.value = '0.7';
        dom.get('ai-active-toggle')!.checked = true;
        const settings = plain(AiSettingsPage.currentSettings()) as Json;
        assert.equal('sales_mode' in settings, false);
        assert.equal('sales_test_senders' in settings, false);
        assert.equal(AiSettingsPage.salesMode(), 'off');
        assert.deepEqual(plain(AiSettingsPage.testSenders()), []);
    });
});

describe('AI settings — the senders on screen', () => {
    it('are one ID per entry, trimmed, each once, in the order typed, whatever separates them', () => {
        const { AiSettingsPage, dom } = load('en');
        mountForm(dom);
        dom.get('sales-test-senders')!.value = ` ${ID_A}\n${ID_B},${ID_A};  12345 ، 67890 `;
        assert.deepEqual(plain(AiSettingsPage.testSenders()), [ID_A, ID_B, '12345', '67890']);
    });

    it('say what is wrong with them, in the page\'s language: an entry that is not an ID, too many, none while Test is picked', () => {
        for (const lang of LANGS) {
            const { AiSettingsPage, t } = load(lang);
            assert.deepEqual(plain(AiSettingsPage.sendersHint('test', ['12345', 'abc'])), { tone: 'warning', text: t('ai.salesSendersInvalid', { value: iso('abc') }) });
            assert.deepEqual(plain(AiSettingsPage.sendersHint('on', ['123'])), { tone: 'warning', text: t('ai.salesSendersInvalid', { value: iso('123') }) }, 'too short to be one');
            assert.deepEqual(plain(AiSettingsPage.sendersHint('test', Array.from({ length: 21 }, (_, i) => String(10000 + i)))), { tone: 'warning', text: t('ai.salesSendersMany', { max: 20 }) });
            assert.deepEqual(plain(AiSettingsPage.sendersHint('test', [])), { tone: 'warning', text: t('ai.salesSendersEmpty') });
            assert.equal(AiSettingsPage.sendersHint('on', []), null, 'Off and On need none');
            assert.equal(AiSettingsPage.sendersHint('test', [ID_A]), null);
        }
    });

    it('write that hint as text, never markup: an ID typed as HTML is shown, not run', () => {
        const { AiSettingsPage, dom } = load('en');
        mountForm(dom);
        const hostile = '<img src=x onerror=alert(1)>';
        dom.get('sales-mode-selector')!.value = 'test';
        dom.get('sales-test-senders')!.value = hostile;
        AiSettingsPage.syncSales();
        const hint = dom.get('sales-senders-hint')!;
        // Spaces separate IDs, so the first bad entry is `<img`: that is what is shown, as the characters it is.
        assert.ok(hint.textContent.includes('<img'), 'shown, as text');
        assert.equal(hint.innerHTML, '', 'and never assigned as markup');
        assert.equal(hint.classes.has('hidden'), false);
        assert.equal(dom.get('sales-senders-block')!.classes.has('hidden'), false);
    });

    it('show the box and the empty-list warning in Test, and neither once the mode is changed back', () => {
        const { AiSettingsPage, dom, t } = load('en');
        mountForm(dom);
        dom.get('sales-mode-selector')!.value = 'test';
        AiSettingsPage.salesChanged();
        assert.equal(dom.get('sales-senders-block')!.classes.has('hidden'), false);
        assert.equal(dom.get('sales-senders-hint')!.textContent, t('ai.salesSendersEmpty'));
        dom.get('sales-mode-selector')!.value = 'off';
        AiSettingsPage.salesChanged();
        assert.equal(dom.get('sales-senders-block')!.classes.has('hidden'), true);
        assert.equal(dom.get('sales-senders-hint')!.textContent, '');
        assert.equal(dom.get('sales-senders-hint')!.classes.has('hidden'), true);
    });

    it('make the Gemini fallback switch matter whenever the layer writes replies: AI providers, or Test or On', () => {
        const { AiSettingsPage, dom } = load('en');
        mountForm(dom);
        assert.equal(AiSettingsPage.usesProviders(), false);
        dom.get('sales-mode-selector')!.value = 'test';
        assert.equal(AiSettingsPage.usesProviders(), true);
        dom.get('sales-mode-selector')!.value = 'off';
        dom.get('engine-selector')!.value = 'providers';
        assert.equal(AiSettingsPage.usesProviders(), true);
        dom.get('engine-selector')!.value = 'gemini';
        dom.get('sales-mode-selector')!.value = 'on';
        AiSettingsPage.salesChanged();
        assert.equal(dom.get('fallback-block')!.classes.has('hidden'), false, 'the switch is shown for the sales assistant too');
    });
});

describe('AI settings — saving the sales controls', () => {
    async function saved(over: (dom: Map<string, FakeEl>) => void, settings: Json = {}) {
        const payloads: Json[] = [];
        const { AiSettingsPage, dom, toasts } = load('en', {
            api: {
                getAiSettings: async () => ({ ...SETTINGS, ...settings }),
                saveAiSettings: async (payload: Json) => { payloads.push(payload); return {}; },
            },
        });
        mountForm(dom);
        await AiSettingsPage.loadSettings();
        over(dom);
        await AiSettingsPage.saveSettings({ querySelector: () => null }, { preventDefault() {} });
        return { payload: payloads[0], payloads, AiSettingsPage, toasts, dom };
    }

    it('sends the mode and the senders with every save, as they are on screen, cleaned the way the server cleans them', async () => {
        const { payload } = await saved((dom) => {
            dom.get('sales-mode-selector')!.value = 'test';
            dom.get('sales-test-senders')!.value = ` ${ID_A}\n${ID_B}, ${ID_A}`;
        });
        assert.equal(payload!.sales_mode, 'test');
        assert.deepEqual(plain(payload!.sales_test_senders), [ID_A, ID_B]);
        assert.equal(payload!.engine, 'gemini', 'the rest of the form goes as it did');
    });

    it('sends Off and no senders for a form left alone: what is saved is never a default nobody saw', async () => {
        const { payload } = await saved(() => {});
        assert.equal(payload!.sales_mode, 'off');
        assert.deepEqual(plain(payload!.sales_test_senders), []);
    });

    it('stops a bad ID before the request, says which, and leaves the form as it was, ready to try again', async () => {
        const { payloads, toasts, dom } = await saved((d) => {
            d.get('sales-mode-selector')!.value = 'test';
            d.get('sales-test-senders')!.value = `${ID_A}\nsomeone`;
        });
        assert.equal(payloads.length, 0, 'nothing was sent');
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0]!.type, 'error');
        assert.ok(toasts[0]!.message.includes(iso('someone')), toasts[0]!.message);
        assert.equal(dom.get('sales-test-senders')!.value, `${ID_A}\nsomeone`, 'what was typed is still there');
        assert.equal(dom.get('sales-senders-hint')!.classes.has('hidden'), false, 'and the hint says it too');
    });

    it('stops a bad ID even when the mode is not Test: the server would refuse the list whatever the mode', async () => {
        const { payloads } = await saved((d) => { d.get('sales-test-senders')!.value = '12'; });
        assert.equal(payloads.length, 0);
    });

    it('lets Test with an empty list be saved (nobody is then answered, which the hint says), and clears a list that was there', async () => {
        const { payload } = await saved((d) => {
            d.get('sales-mode-selector')!.value = 'test';
            d.get('sales-test-senders')!.value = '';
        }, { sales_mode: 'test', sales_test_senders: [ID_A] });
        assert.equal(payload!.sales_mode, 'test');
        assert.deepEqual(plain(payload!.sales_test_senders), []);
    });

    it('treats the form as saved afterwards: nothing is unsaved until the next change', async () => {
        const { AiSettingsPage, dom } = await saved((d) => {
            d.get('sales-mode-selector')!.value = 'on';
            d.get('sales-test-senders')!.value = ID_A;
        });
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        dom.get('sales-mode-selector')!.value = 'off';
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
    });
});

// ─── The follow-up delay (S9) ───────────────────────────────────────────────────────────────

/** The follow-up field's elements, as the shell renders them: the block hidden until the screen has the value. */
function mountFollowup(dom: Map<string, FakeEl>): void {
    for (const id of ['sales-followup-block', 'sales-followup-minutes', 'sales-followup-hint']) dom.set(id, fakeEl(id));
    dom.get('sales-followup-block')!.classes.add('hidden');
    dom.get('sales-followup-hint')!.classes.add('hidden');
}

/** Lets the follow-up request the page fires (and does not await) land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const FOLLOWUP = { minutes: 240, defaultMinutes: 240, min: 0, max: 1320 };

describe('AI settings — the follow-up delay (S9)', () => {
    for (const lang of LANGS) {
        it(`has the field, hidden until the screen has read it, a number box left to right in 0..1320, with its help and a polite status region (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const shell = String(AiSettingsPage.shell());
            assert.match(shell, /<div class="form-group hidden" id="sales-followup-block">/);
            const input = shell.match(/<input[^>]*\bid="sales-followup-minutes"[^>]*>/)?.[0] ?? '';
            assert.ok(input, 'the form has the field');
            for (const attr of [/\btype="number"/, /\bdir="ltr"/, /\binputmode="numeric"/, /\bmin="0"/, /\bmax="1320"/, /\bstep="1"/, /\bdata-input="ai:salesChanged"/, /\baria-describedby="sales-followup-desc sales-followup-hint"/]) {
                assert.match(input, attr);
            }
            assert.match(shell, /<label[^>]*for="sales-followup-minutes"/);
            assert.match(shell, /<p class="form-hint hidden" id="sales-followup-hint" role="status" aria-live="polite"><\/p>/);
            assert.ok(shell.includes(t('ai.salesFollowup')) && shell.includes(t('ai.salesFollowupDesc')));
        });

        it(`has every follow-up string in both languages, filled, and says what the nudge waits for (${lang})`, () => {
            const { t } = load(lang);
            for (const key of ['ai.salesFollowup', 'ai.salesFollowupDesc', 'ai.salesFollowupInvalid', 'ai.salesFollowupOff']) {
                const value = t(key, { max: 1320 });
                assert.notEqual(value, key, `${key} is translated`);
                assert.equal(/\{\w+\}/.test(value), false, `${key} has no unfilled placeholder`);
                if (lang === 'ar') assert.equal(/[٠-٩۰-۹]/.test(value), false, `${key}: Latin digits`);
            }
            const help = t('ai.salesFollowupDesc');
            if (lang === 'en') {
                assert.match(help, /has not replied, has not opened the link, has not asked to stop/);
                assert.match(help, /24-hour window/);
                assert.match(help, /0 turns follow-ups off/);
                assert.match(help, /every account on this deployment/);
            } else {
                assert.match(help, /ألّا يكون الشخص قد ردّ أو فتح الرابط أو طلب التوقف/);
                assert.match(help, /24 ساعة/);
                assert.match(help, /والقيمة 0 توقف المتابعة/);
            }
        });
    }

    it('a platform admin with the sales assistant on sees the saved delay, read once', async () => {
        const calls: number[] = [];
        const { AiSettingsPage, dom } = load('en', {
            api: {
                getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'on' }),
                getSalesFollowup: async () => { calls.push(1); return { ...FOLLOWUP, minutes: 10 }; },
            },
        });
        mountForm(dom);
        mountFollowup(dom);
        await AiSettingsPage.loadSettings();
        await settle();
        assert.equal(dom.get('sales-followup-minutes')!.value, '10');
        assert.equal(dom.get('sales-followup-block')!.classes.has('hidden'), false);
        assert.equal(dom.get('sales-followup-hint')!.classes.has('hidden'), true, 'a good value needs no hint');
        AiSettingsPage.salesChanged();
        AiSettingsPage.salesChanged();
        await settle();
        assert.equal(calls.length, 1, 'once per visit');
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
    });

    it('stays out of the way while the sales assistant is Off, and does not ask the server', async () => {
        const calls: number[] = [];
        const { AiSettingsPage, dom } = load('en', {
            api: {
                getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'off' }),
                getSalesFollowup: async () => { calls.push(1); return FOLLOWUP; },
            },
        });
        mountForm(dom);
        mountFollowup(dom);
        await AiSettingsPage.loadSettings();
        await settle();
        assert.equal(calls.length, 0);
        assert.equal(dom.get('sales-followup-block')!.classes.has('hidden'), true);
    });

    it('is never shown to anyone but a platform admin, and never asked for: the setting is the whole deployment\'s', async () => {
        const calls: number[] = [];
        const { AiSettingsPage, dom } = load('en', {
            admin: false,
            api: {
                getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'on' }),
                getSalesFollowup: async () => { calls.push(1); return FOLLOWUP; },
            },
        });
        mountForm(dom);
        mountFollowup(dom);
        await AiSettingsPage.loadSettings();
        await settle();
        assert.equal(calls.length, 0);
        assert.equal(dom.get('sales-followup-block')!.classes.has('hidden'), true);
        assert.equal(AiSettingsPage.followupDirty(), false);
    });

    it('a read that fails leaves the field hidden and says nothing: the rest of the screen works as before', async () => {
        const { AiSettingsPage, dom, toasts } = load('en', {
            api: {
                getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'test', sales_test_senders: [ID_A] }),
                getSalesFollowup: async () => { throw new Error('Not found.'); },
            },
        });
        mountForm(dom);
        mountFollowup(dom);
        await AiSettingsPage.loadSettings();
        await settle();
        assert.equal(dom.get('sales-followup-block')!.classes.has('hidden'), true);
        assert.equal(toasts.length, 0);
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
    });

    it('says what is wrong with a value, and that 0 means off, as text', () => {
        for (const lang of LANGS) {
            const { AiSettingsPage, t } = load(lang);
            assert.deepEqual(plain(AiSettingsPage.followupHint(null)), { tone: 'warning', text: t('ai.salesFollowupInvalid', { max: 1320 }) });
            assert.deepEqual(plain(AiSettingsPage.followupHint(0)), { tone: 'muted', text: t('ai.salesFollowupOff') });
            assert.equal(AiSettingsPage.followupHint(240), null);
        }
    });

    it('reads only a whole number of minutes in range from the box', () => {
        const { AiSettingsPage, dom } = load('en');
        mountForm(dom);
        mountFollowup(dom);
        const read = (value: string) => { dom.get('sales-followup-minutes')!.value = value; return AiSettingsPage.followupMinutes(); };
        assert.equal(read('240'), 240);
        assert.equal(read(' 10 '), 10);
        assert.equal(read('0'), 0);
        assert.equal(read('1320'), 1320);
        for (const bad of ['', '1321', '-5', '4.5', 'abc', '1e3']) assert.equal(read(bad), null, bad);
    });

    describe('saving it', () => {
        async function savedFollowup(value: string, over: Json = {}) {
            const order: string[] = [];
            const followups: Json[] = [];
            const { AiSettingsPage, dom, toasts } = load('en', {
                api: {
                    getAiSettings: async () => ({ ...SETTINGS, sales_mode: 'on' }),
                    getSalesFollowup: async () => FOLLOWUP,
                    saveAiSettings: async () => { order.push('agent'); return {}; },
                    saveSalesFollowup: async (body: Json) => { order.push('followup'); followups.push(body); return { ...FOLLOWUP, minutes: body.minutes }; },
                    ...over,
                },
            });
            mountForm(dom);
            mountFollowup(dom);
            await AiSettingsPage.loadSettings();
            await settle();
            dom.get('sales-followup-minutes')!.value = value;
            AiSettingsPage.salesChanged();
            await AiSettingsPage.saveSettings({ querySelector: () => null }, { preventDefault() {} });
            return { AiSettingsPage, dom, toasts, order, followups };
        }

        it('a changed delay is saved through its own route, right after the agent\'s settings, and is then not unsaved', async () => {
            const { AiSettingsPage, order, followups, toasts } = await savedFollowup('10');
            assert.deepEqual(order, ['agent', 'followup']);
            assert.deepEqual(plain(followups), [{ minutes: 10 }]);
            assert.equal(toasts.at(-1)!.type, 'success');
            assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        });

        it('0 is saved as 0: follow-ups off, and the hint says so', async () => {
            const { followups, dom } = await savedFollowup('0');
            assert.deepEqual(plain(followups), [{ minutes: 0 }]);
            assert.equal(dom.get('sales-followup-hint')!.classes.has('hidden'), false);
        });

        it('an unchanged delay is not sent: only the agent is saved', async () => {
            const { order } = await savedFollowup('240');
            assert.deepEqual(order, ['agent']);
        });

        it('a value the server would refuse stops the save before ANY request, with the reason, and keeps what was typed', async () => {
            const { order, toasts, dom } = await savedFollowup('1500');
            assert.deepEqual(order, [], 'nothing half-saved');
            assert.equal(toasts.length, 1);
            assert.equal(toasts[0]!.type, 'error');
            assert.match(toasts[0]!.message, /0 to 1320/);
            assert.equal(dom.get('sales-followup-minutes')!.value, '1500');
            assert.equal(dom.get('sales-followup-hint')!.classes.has('hidden'), false);
        });

        it('a failed delay save says so and leaves the delay unsaved (the agent\'s settings did save)', async () => {
            const { AiSettingsPage, order, toasts } = await savedFollowup('10', { saveSalesFollowup: async () => { throw new Error('Failed to save the follow-up delay.'); } });
            assert.deepEqual(order, ['agent']);
            assert.equal(toasts.at(-1)!.type, 'error');
            assert.match(toasts.at(-1)!.message, /follow-up delay/);
            assert.equal(AiSettingsPage.followupDirty(), true);
        });
    });
});
