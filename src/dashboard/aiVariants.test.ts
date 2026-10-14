/**
 * AI settings: the A/B wording experiment's editor (DM plan S14), under the sales assistant's picker.
 *
 * The REAL `ai_settings.js` in a `node:vm` context, as `aiSales.test.ts` loads it, in both languages. What is pinned: the block is hidden until the
 * screen has read the experiment and the sales assistant is not Off, and a server without it costs nothing; every word the owner typed is text and
 * never markup; a row with nothing typed is not a variant; a saved variant can be retired but not removed (its slot letter must never be given to
 * other wording); what is saved is what is on screen, after the agent's own settings and never half-saved after a typo; and every string exists in
 * both languages.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>;
type Lang = 'ar' | 'en';

interface FakeEl {
    id: string;
    value: string;
    checked: boolean;
    disabled: boolean;
    innerHTML: string;
    textContent: string;
    classes: Set<string>;
    classList: { toggle(name: string, force?: boolean): boolean; add(name: string): void; remove(name: string): void; contains(name: string): boolean };
    focused: number;
    focus(): void;
    querySelector(selector: string): unknown;
    setAttribute(): void;
    getAttribute(): null;
}

function fakeEl(id: string, over: Partial<FakeEl> = {}): FakeEl {
    const classes = new Set<string>();
    const el: FakeEl = {
        id, value: '', checked: false, disabled: false, innerHTML: '', textContent: '', classes, focused: 0,
        classList: {
            toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : force; if (on) classes.add(name); else classes.delete(name); return on; },
            add: (name) => { classes.add(name); }, remove: (name) => { classes.delete(name); }, contains: (name) => classes.has(name),
        },
        focus() { el.focused++; },
        querySelector: () => null, setAttribute: () => {}, getAttribute: () => null,
        ...over,
    };
    return el;
}

function load(lang: Lang, opts: { api?: Json } = {}) {
    const noop = (): void => {};
    const stub = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null, appendChild: noop, setAttribute: noop,
        getAttribute: () => null, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [], innerHTML: '',
    };
    const dom = new Map<string, FakeEl>();
    const api: Json = { token: 'test', getAdminAi: async () => ({ purposes: [], providers: [] }), ...(opts.api ?? {}) };
    const ctx: Json = {
        document: {
            ...stub, createElement: () => ({ ...stub }), body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null, activeElement: null, visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '#/ai_settings' } },
        location: { hash: '#/ai_settings', pathname: '/dashboard', origin: 'https://example.test' },
        Intl, console, clearTimeout, clearInterval, setTimeout, setInterval,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: api,
        App: { currentTheme: () => 'auto', navigate: noop, isAdmin: () => false },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        URLSearchParams,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js',
        'dashboard/js/pages/ai_settings.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const pages = vm.runInContext('({ AiSettingsPage, UI, t })', ctx) as { AiSettingsPage: Json; UI: Json; t: (key: string, params?: Json) => string };
    const toasts: { message: string; type?: string }[] = [];
    pages.UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    return { ...pages, dom, toasts, api };
}

/** The form's elements, as the page finds them by id, with the sales picker on `mode` and the variants block mounted (hidden, as the shell has it). */
function mountForm(dom: Map<string, FakeEl>): void {
    for (const id of [
        'ai-active-toggle', 'system-prompt-text', 'knowledge-base-text', 'model-selector', 'temp-slider', 'temp-value', 'save-settings-btn',
        'ai-settings-error', 'engine-selector', 'gemini-fallback-toggle', 'fallback-block', 'engine-route-hint', 'ai-unsaved-note',
        'sales-mode-selector', 'sales-test-senders', 'sales-senders-block', 'sales-senders-hint',
        'sales-variants-block', 'sales-variants-list', 'sales-variants-enabled', 'sales-variants-hint', 'sales-variant-add',
    ]) dom.set(id, fakeEl(id));
    dom.get('engine-selector')!.value = 'gemini';
    dom.get('gemini-fallback-toggle')!.checked = true;
    dom.get('fallback-block')!.classes.add('hidden');
    dom.get('engine-route-hint')!.classes.add('hidden');
    dom.get('sales-mode-selector')!.value = 'off';
    dom.get('sales-senders-block')!.classes.add('hidden');
    dom.get('sales-senders-hint')!.classes.add('hidden');
    dom.get('sales-variants-block')!.classes.add('hidden');
    dom.get('sales-variants-hint')!.classes.add('hidden');
}

/** What typing into a variant's boxes does: the elements `paintVariants` would have drawn, holding what was typed. */
function type(dom: Map<string, FakeEl>, slot: string, fields: Partial<Record<'label' | 'weight' | 'opening' | 'cta', string>>): void {
    for (const [name, value] of Object.entries(fields)) {
        const id = `sales-variant-${slot}-${name}`;
        const el = dom.get(id) ?? fakeEl(id);
        el.value = value!;
        dom.set(id, el);
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const plain = (value: unknown): any => JSON.parse(JSON.stringify(value));
const text = (markup: unknown) => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const LANGS = ['ar', 'en'] as const;

const SETTINGS = { is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7 };
const LIMITS = { min: 2, max: 3, label: 40, text: 300, weight: 100, minSample: 30 };
const WARM = { id: 'A', label: 'Warm', weight: 50, opening: 'Open with one short question.', cta: '' };
const DIRECT = { id: 'B', label: 'Direct', weight: 50, opening: '', cta: 'Offer the link in one plain sentence.' };
const payloadOf = (enabled: boolean, variants: Json[]) => ({ config: { enabled, variants }, saved: true, running: enabled, slots: ['A', 'B', 'C'], limits: LIMITS });

/** A page on the sales assistant `mode`, loaded against a server that holds `stored`. */
async function opened(stored: Json | Error | null, over: { lang?: Lang; mode?: 'off' | 'test' | 'on'; api?: Json } = {}) {
    const calls: string[] = [];
    const saves: Json[] = [];
    const { AiSettingsPage, dom, toasts, t, UI } = load(over.lang ?? 'en', {
        api: {
            getAiSettings: async () => ({ ...SETTINGS, sales_mode: over.mode ?? 'on', sales_test_senders: over.mode === 'test' ? ['17841400000000001'] : [] }),
            getSalesVariants: async () => { calls.push('read'); if (stored instanceof Error) throw stored; return stored ?? payloadOf(false, []); },
            saveAiSettings: async () => { calls.push('agent'); return {}; },
            saveSalesVariants: async (body: Json) => {
                calls.push('variants'); saves.push(body);
                return payloadOf(body.enabled, body.variants);
            },
            ...(over.api ?? {}),
        },
    });
    mountForm(dom);
    await AiSettingsPage.loadSettings();
    await settle();
    return { AiSettingsPage, dom, toasts, t, UI, calls, saves };
}

const submit = (page: Json) => page.saveSettings({ querySelector: () => null }, { preventDefault() {} });

// ─── The form ────────────────────────────────────────────────────────────────────────────────

describe('AI settings: the wording experiment, in the form', () => {
    for (const lang of LANGS) {
        it(`has a block that starts hidden, with a switch named by its own label, the list, the add button and a polite status region (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const shell = String(AiSettingsPage.shell());
            assert.match(shell, /<div class="form-group hidden" id="sales-variants-block">/);
            assert.match(shell, /<input type="checkbox" id="sales-variants-enabled" data-change="ai:variantsChanged" aria-describedby="sales-variants-desc sales-variants-hint">/);
            assert.match(shell, /<label class="switch" for="sales-variants-enabled">\s*<span class="sr-only">/);
            assert.match(shell, /<div class="variant-list" id="sales-variants-list"><\/div>/);
            assert.match(shell, /<button[^>]*id="sales-variant-add"[^>]*data-action="ai:addVariant"|<button[^>]*data-action="ai:addVariant"[^>]*id="sales-variant-add"/);
            assert.match(shell, /<p class="form-hint hidden" id="sales-variants-hint" role="status" aria-live="polite"><\/p>/);
            for (const key of ['ai.variants', 'ai.variantsDesc', 'ai.variantsRun', 'ai.variantAdd', 'ai.variantsRetire']) assert.ok(shell.includes(t(key)), key);
            assert.equal(/ai\.variant/.test(text(shell)), false, 'no raw key reaches the screen');
            assert.ok(shell.indexOf('id="sales-followup-block"') < shell.indexOf('id="sales-variants-block"'), 'under the sales settings, after the follow-up');
            assert.ok(shell.indexOf('id="sales-variants-block"') < shell.indexOf('id="model-selector"'), 'and before the model');
        });

        it(`has every string in both languages, with no placeholder left unfilled and Latin digits only (${lang})`, () => {
            const { t } = load(lang);
            const keys = [
                'ai.variants', 'ai.variantsDesc', 'ai.variantsRun', 'ai.variantSlot', 'ai.variantName', 'ai.variantNamePlaceholder', 'ai.variantShare',
                'ai.variantOpening', 'ai.variantOpeningPlaceholder', 'ai.variantCta', 'ai.variantCtaPlaceholder', 'ai.variantAdd', 'ai.variantRemove',
                'ai.variantsSplit', 'ai.variantsRetire',
                ...['too_few', 'weights_one_arm', 'label_missing', 'label_long', 'label_duplicate', 'weight_invalid', 'text_long', 'text_link', 'text_number', 'other'].map((c) => `ai.variantsProblem.${c}`),
            ];
            for (const key of keys) {
                const value = t(key, { slot: 'A', split: 'A 50%', max: 40 });
                assert.notEqual(value, key, `${key} is translated`);
                assert.equal(/\{\w+\}/.test(value), false, `${key} has no unfilled placeholder`);
                if (lang === 'ar') assert.equal(/[٠-٩۰-۹]/.test(value), false, `${key}: Latin digits`);
            }
        });
    }

    it('says that it is wording only, that each new conversation keeps its variant, and that nothing claims a winner', () => {
        const en = load('en').t;
        assert.match(en('ai.variantsDesc'), /Each NEW conversation gets one of them for good/);
        assert.match(en('ai.variantsDesc'), /no links and no numbers/);
        assert.match(en('ai.variantsRetire'), /set its share to 0/);
        const ar = load('ar').t;
        assert.match(ar('ai.variantsDesc'), /بشكل دائم/);
        assert.match(ar('ai.variantsDesc'), /بلا روابط ولا أرقام/);
    });
});

// ─── The pure parts ──────────────────────────────────────────────────────────────────────────

describe('AI settings: the wording experiment, as data', () => {
    it('pads what the server holds to the two rows a comparison needs, in slot order, and drops a slot that is not ours', () => {
        const { AiSettingsPage: p } = load('en');
        assert.deepEqual(plain(p.variantRowsFrom({ enabled: false, variants: [] })).map((r: Json) => [r.id, r.saved]), [['A', false], ['B', false]]);
        assert.deepEqual(plain(p.variantRowsFrom({ variants: [DIRECT] })).map((r: Json) => [r.id, r.saved]), [['A', false], ['B', true]], 'the saved one keeps its slot; the blank one takes the first free');
        assert.deepEqual(plain(p.variantRowsFrom({ variants: [{ ...DIRECT, id: 'C' }, WARM] })).map((r: Json) => r.id), ['A', 'C']);
        assert.deepEqual(plain(p.variantRowsFrom({ variants: [{ ...WARM, id: 'D' }, { ...WARM, id: '__proto__' }] })).map((r: Json) => r.id), ['A', 'B'], 'only A, B and C');
        assert.equal(p.variantRowsFrom(null).length, 2);
    });

    it('sends only rows with something typed, squashed, with a share kept as typed when it is not a number', () => {
        const { AiSettingsPage: p } = load('en');
        const rows = [
            { id: 'A', label: '  Warm   one ', weight: '50', opening: 'Open\n with  a question.', cta: '', saved: false },
            { id: 'B', label: '', weight: '70', opening: '', cta: '  ', saved: false },
            { id: 'C', label: 'Odd', weight: 'lots', opening: '', cta: 'x', saved: false },
        ];
        assert.deepEqual(plain(p.variantsPayloadOf(true, rows)), {
            enabled: true,
            variants: [
                { id: 'A', label: 'Warm one', weight: 50, opening: 'Open with a question.', cta: '' },
                { id: 'C', label: 'Odd', weight: 'lots', opening: '', cta: 'x' },
            ],
        });
        assert.deepEqual(plain(p.variantsPayloadOf(false, [])), { enabled: false, variants: [] });
    });

    it('names what is wrong without the server: a name, a share, a length, and, only while it runs, two variants with a share', () => {
        const { AiSettingsPage: p } = load('en');
        const v = (over: Json = {}) => ({ id: 'A', label: 'Warm', weight: 50, opening: '', cta: '', ...over });
        const problem = (enabled: boolean, variants: Json[]) => p.variantsProblem({ enabled, variants });
        assert.equal(problem(true, [v(), v({ id: 'B', label: 'Direct' })]), null);
        assert.equal(problem(false, []), null, 'a draft may be empty');
        assert.equal(problem(false, [v()]), null, 'and half written');
        assert.equal(problem(true, []), 'too_few');
        assert.equal(problem(true, [v()]), 'too_few');
        assert.equal(problem(true, [v(), v({ id: 'B', label: 'Direct', weight: 0 })]), 'weights_one_arm');
        assert.equal(problem(false, [v({ label: '' })]), 'label_missing');
        assert.equal(problem(false, [v({ label: 'x'.repeat(41) })]), 'label_long');
        assert.equal(problem(false, [v(), v({ id: 'B', label: ' warm' })].map((x) => ({ ...x, label: x.label.trim() }))), 'label_duplicate');
        for (const weight of [101, -1, 'lots', 2.5]) assert.equal(problem(false, [v({ weight })]), 'weight_invalid', String(weight));
        assert.equal(problem(false, [v({ opening: 'x'.repeat(301) })]), 'text_long');
        assert.equal(problem(false, [v({ cta: 'x'.repeat(301) })]), 'text_long');
    });

    it('words a problem code in the page\'s language, with the limit, and a code it does not know as the generic line', () => {
        for (const lang of LANGS) {
            const { AiSettingsPage: p, t } = load(lang);
            assert.equal(p.variantsProblemText('too_few'), t('ai.variantsProblem.too_few'));
            assert.equal(p.variantsProblemText('label_long'), t('ai.variantsProblem.label_long', { max: 40 }));
            assert.equal(p.variantsProblemText('text_long'), t('ai.variantsProblem.text_long', { max: 300 }));
            assert.equal(p.variantsProblemText('weight_invalid'), t('ai.variantsProblem.weight_invalid', { max: 100 }));
            assert.equal(p.variantsProblemText('text_link'), t('ai.variantsProblem.text_link'));
            assert.equal(p.variantsProblemText('something_new'), t('ai.variantsProblem.other'));
            assert.equal(p.variantsProblemText('__proto__'), t('ai.variantsProblem.other'));
        }
    });

    it('reads the server\'s refusal as words, and nothing else as one', () => {
        const { AiSettingsPage: p, t } = load('en');
        assert.equal(p.variantsErrorText({ body: { code: 'VARIANTS_INVALID', problems: [{ code: 'text_number', field: 'variants[0].cta' }] } }), t('ai.variantsProblem.text_number'));
        assert.equal(p.variantsErrorText({ body: { code: 'OTHER', problems: [{ code: 'text_number' }] } }), '');
        assert.equal(p.variantsErrorText({ body: { code: 'VARIANTS_INVALID', problems: [] } }), '');
        assert.equal(p.variantsErrorText(new Error('x')), '');
        assert.equal(p.variantsErrorText(null), '');
    });

    it('shows how new conversations will be split, from the shares as typed: each arm\'s part of the whole, retired arms left out', () => {
        const { AiSettingsPage: p } = load('en');
        const split = (...weights: Array<number | string>) => p.variantsSplit({ variants: weights.map((weight, i) => ({ id: 'ABC'[i], weight })) });
        assert.equal(split(50, 30, 20), 'A 50% · B 30% · C 20%');
        assert.equal(split(1, 3), 'A 25% · B 75%');
        assert.equal(split(10, 0), 'A 100%');
        assert.equal(split(0, 0), '');
        assert.equal(split('lots', 5), 'B 100%', 'a share that is not a number is not a share');
    });
});

// ─── Loading ─────────────────────────────────────────────────────────────────────────────────

describe('AI settings: the wording experiment, loading', () => {
    it('shows the saved variants and the switch once the sales assistant is on, reading the server once per visit', async () => {
        const { AiSettingsPage, dom, calls } = await opened(payloadOf(true, [WARM, DIRECT]));
        assert.equal(dom.get('sales-variants-block')!.classes.has('hidden'), false);
        assert.equal(dom.get('sales-variants-enabled')!.checked, true);
        const list = dom.get('sales-variants-list')!.innerHTML;
        assert.match(list, /<fieldset class="variant-card" data-slot="A">/);
        assert.match(list, /<fieldset class="variant-card" data-slot="B">/);
        assert.match(list, /id="sales-variant-A-label"[^>]*value="Warm"/);
        assert.match(list, /id="sales-variant-A-weight"[^>]*value="50"/);
        assert.ok(list.includes('Offer the link in one plain sentence.'));
        AiSettingsPage.salesChanged();
        AiSettingsPage.salesChanged();
        await settle();
        assert.deepEqual(calls.filter((c) => c === 'read'), ['read'], 'once');
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false, 'a screen nobody touched has nothing unsaved');
    });

    it('is open in Test as well, and says how conversations are split while it runs', async () => {
        const { dom } = await opened(payloadOf(true, [WARM, { ...DIRECT, weight: 150 - 100 }]), { mode: 'test' });
        assert.equal(dom.get('sales-variants-block')!.classes.has('hidden'), false);
        assert.match(dom.get('sales-variants-hint')!.textContent, /A 50% · B 50%/);
        assert.equal(dom.get('sales-variants-hint')!.classes.has('hidden'), false);
    });

    it('is out of the way while the sales assistant is Off, and does not ask the server', async () => {
        const { dom, calls, AiSettingsPage } = await opened(payloadOf(true, [WARM, DIRECT]), { mode: 'off' });
        assert.deepEqual(calls, []);
        assert.equal(dom.get('sales-variants-block')!.classes.has('hidden'), true);
        assert.equal(AiSettingsPage.variantsDirty(), false);
    });

    it('starts an account with no experiment as two empty variants with the switch off: nothing is unsaved, and the hint is quiet', async () => {
        const { AiSettingsPage, dom } = await opened(payloadOf(false, []));
        assert.equal(dom.get('sales-variants-enabled')!.checked, false);
        assert.match(dom.get('sales-variants-list')!.innerHTML, /data-slot="A"[\s\S]*data-slot="B"/);
        assert.ok(!/data-slot="C"/.test(dom.get('sales-variants-list')!.innerHTML));
        assert.equal(AiSettingsPage.variantsDirty(), false, 'the blank rows are not a variant');
        assert.equal(dom.get('sales-variants-hint')!.classes.has('hidden'), true);
    });

    it('stays hidden and says nothing when the server has no such route: the rest of the screen works as before', async () => {
        const { dom, toasts, AiSettingsPage } = await opened(new Error('Not found.'));
        assert.equal(dom.get('sales-variants-block')!.classes.has('hidden'), true);
        assert.equal(toasts.length, 0);
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        assert.equal(AiSettingsPage.variantsDraft(), null);
    });

    it('does not accept an answer that is not an experiment: the block stays hidden', async () => {
        const { dom } = await opened({ nothing: true });
        assert.equal(dom.get('sales-variants-block')!.classes.has('hidden'), true);
    });

    it('is forgotten with the tenant: another account does not meet this one\'s wording', async () => {
        const { AiSettingsPage } = await opened(payloadOf(true, [WARM, DIRECT]));
        assert.ok(AiSettingsPage._variants);
        AiSettingsPage.resetTenantState();
        assert.equal(AiSettingsPage._variants, undefined);
    });
});

// ─── Everything the owner typed is text ──────────────────────────────────────────────────────

describe('AI settings: the wording experiment, escaping', () => {
    const HOSTILE = '<img src=x onerror=alert(1)>"\'`</textarea><script>alert(2)</script>';

    for (const lang of LANGS) {
        it(`draws a name and both wordings as text and never as markup, in an attribute and in a textarea alike (${lang})`, async () => {
            const { dom } = await opened(payloadOf(true, [{ ...WARM, label: HOSTILE, opening: HOSTILE, cta: HOSTILE }, DIRECT]), { lang });
            const list = dom.get('sales-variants-list')!.innerHTML;
            assert.equal(/<img|<script|<\/textarea><script/i.test(list), false, 'no tag of the owner\'s survives');
            assert.ok(list.includes('&lt;img src=x onerror=alert(1)&gt;'), 'escaped, so it reads as the words typed');
            assert.ok(list.includes('&quot;&#39;&#96;&lt;/textarea&gt;&lt;script&gt;'), 'the quote characters and the closing tag too');
            assert.equal((list.match(/<textarea/g) ?? []).length, 4, 'two per variant, and the hostile one did not close one early');
        });
    }

    it('writes the hint as text: a split or a problem is never parsed', async () => {
        const { AiSettingsPage, dom } = await opened(payloadOf(true, [WARM, DIRECT]));
        type(dom, 'A', { label: '<b>x</b>', weight: '50', opening: '', cta: '' });
        AiSettingsPage.variantsChanged();
        assert.equal(dom.get('sales-variants-hint')!.innerHTML, '', 'only textContent is ever written');
    });

    it('takes a slot letter from a fixed table: a row the server sent with another slot is not drawn', async () => {
        const { dom } = await opened(payloadOf(true, [WARM, DIRECT, { ...WARM, id: '"><script>x</script>', label: 'Evil' }]));
        assert.equal(/Evil|<script/.test(dom.get('sales-variants-list')!.innerHTML), false);
    });
});

// ─── Adding, removing, retiring ──────────────────────────────────────────────────────────────

describe('AI settings: the wording experiment, adding and removing', () => {
    it('offers no Remove for a saved variant (it may hold conversations, and its letter must never be given to other wording), only to retire it with a share of 0', async () => {
        const { dom } = await opened(payloadOf(true, [WARM, DIRECT]));
        assert.equal(/data-action="ai:removeVariant"/.test(dom.get('sales-variants-list')!.innerHTML), false);
    });

    it('adds a variant in the first free slot, with its name focused, and takes the typed text of the others with it', async () => {
        const { AiSettingsPage, dom } = await opened(payloadOf(true, [WARM, DIRECT]));
        type(dom, 'A', { label: 'Warm typed', weight: '40', opening: 'typed', cta: '' });
        AiSettingsPage.addVariant();
        assert.deepEqual(AiSettingsPage._variants.rows.map((r: Json) => [r.id, r.saved]), [['A', true], ['B', true], ['C', false]]);
        assert.equal(AiSettingsPage._variants.rows[0].label, 'Warm typed', 'what was typed was kept before the list was drawn again');
        assert.match(dom.get('sales-variants-list')!.innerHTML, /data-slot="C"/);
        assert.match(dom.get('sales-variants-list')!.innerHTML, /id="sales-variant-A-label"[^>]*value="Warm typed"/);
    });

    it('stops at three: the add button goes off, and a fourth is never made', async () => {
        const { AiSettingsPage, dom } = await opened(payloadOf(true, [WARM, DIRECT]));
        AiSettingsPage.addVariant();
        assert.equal(dom.get('sales-variant-add')!.disabled, true);
        AiSettingsPage.addVariant();
        assert.equal(AiSettingsPage._variants.rows.length, 3);
    });

    it('removes a variant nobody has saved, offers that only while more than two are shown, and never removes a saved one', async () => {
        const { AiSettingsPage, dom } = await opened(payloadOf(true, [WARM, DIRECT]));
        AiSettingsPage.addVariant();
        const list = () => dom.get('sales-variants-list')!.innerHTML;
        assert.match(list(), /data-action="ai:removeVariant"[^>]*data-slot="C"/);
        assert.equal((list().match(/data-action="ai:removeVariant"/g) ?? []).length, 1, 'only the new one');
        AiSettingsPage.removeVariant('A');
        assert.equal(AiSettingsPage._variants.rows.length, 3, 'a saved variant stays');
        AiSettingsPage.removeVariant('C');
        assert.deepEqual(AiSettingsPage._variants.rows.map((r: Json) => r.id), ['A', 'B']);
        assert.equal(dom.get('sales-variant-add')!.disabled, false);
        AiSettingsPage.removeVariant('B');
        assert.equal(AiSettingsPage._variants.rows.length, 2);
        AiSettingsPage.removeVariant('Z');
        assert.equal(AiSettingsPage._variants.rows.length, 2);
    });

    it('an empty account\'s two blank rows can be removed only down to two', async () => {
        const { AiSettingsPage } = await opened(payloadOf(false, []));
        AiSettingsPage.removeVariant('B');
        assert.equal(AiSettingsPage._variants.rows.length, 2);
    });
});

// ─── What is unsaved, and saving ─────────────────────────────────────────────────────────────

describe('AI settings: the wording experiment, saving', () => {
    it('counts a typed name, a changed share, a wording and the switch as unsaved, and not a blank row', async () => {
        const { AiSettingsPage, dom } = await opened(payloadOf(false, [WARM, DIRECT]));
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        type(dom, 'A', { weight: '60' });
        assert.equal(AiSettingsPage.variantsDirty(), true);
        type(dom, 'A', { weight: '50' });
        assert.equal(AiSettingsPage.variantsDirty(), false, 'put back, nothing changed');
        type(dom, 'B', { cta: 'Offer the link in one plain sentence.  ' });
        assert.equal(AiSettingsPage.variantsDirty(), false, 'trailing spaces are not a change: the server would squash them');
        dom.get('sales-variants-enabled')!.checked = true;
        assert.equal(AiSettingsPage.variantsDirty(), true);
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
    });

    it('saves what is on screen through its own route, right after the agent\'s settings, and is then not unsaved', async () => {
        const { AiSettingsPage, dom, calls, saves, toasts } = await opened(payloadOf(false, [WARM, DIRECT]));
        dom.get('sales-variants-enabled')!.checked = true;
        type(dom, 'A', { weight: '30' });
        type(dom, 'B', { weight: '70' });
        await submit(AiSettingsPage);
        assert.deepEqual(calls.slice(1), ['agent', 'variants'], 'the agent first');
        assert.deepEqual(plain(saves), [{ enabled: true, variants: [
            { id: 'A', label: 'Warm', weight: 30, opening: 'Open with one short question.', cta: '' },
            { id: 'B', label: 'Direct', weight: 70, opening: '', cta: 'Offer the link in one plain sentence.' },
        ] }]);
        assert.equal(toasts.at(-1)!.type, 'success');
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        assert.equal(dom.get('sales-variants-enabled')!.checked, true);
    });

    it('saves a variant added on screen as saved, which can then only be retired', async () => {
        const { AiSettingsPage, dom, saves } = await opened(payloadOf(false, [WARM, DIRECT]));
        AiSettingsPage.addVariant();
        type(dom, 'C', { label: 'Third', weight: '10', opening: 'Start warmly.', cta: '' });
        await submit(AiSettingsPage);
        assert.equal(saves[0]!.variants.length, 3);
        assert.deepEqual(AiSettingsPage._variants.rows.map((r: Json) => [r.id, r.saved]), [['A', true], ['B', true], ['C', true]]);
        assert.equal(/data-action="ai:removeVariant"/.test(dom.get('sales-variants-list')!.innerHTML), false);
    });

    it('does not send an experiment nobody changed: only the agent is saved', async () => {
        const { AiSettingsPage, calls } = await opened(payloadOf(true, [WARM, DIRECT]));
        await submit(AiSettingsPage);
        assert.deepEqual(calls.slice(1), ['agent']);
    });

    it('stops a typo before ANY request, says which in the page\'s language, and keeps what was typed', async () => {
        for (const lang of LANGS) {
            const { AiSettingsPage, dom, calls, toasts, t } = await opened(payloadOf(false, [WARM, DIRECT]), { lang });
            dom.get('sales-variants-enabled')!.checked = true;
            type(dom, 'B', { weight: '0' });
            await submit(AiSettingsPage);
            assert.deepEqual(calls, ['read'], `${lang}: nothing half-saved`);
            assert.equal(toasts.length, 1);
            assert.equal(toasts[0]!.type, 'error');
            assert.equal(toasts[0]!.message, t('ai.variantsProblem.weights_one_arm'));
            assert.equal(dom.get('sales-variant-B-weight')!.value, '0', 'what was typed is still there');
            assert.equal(dom.get('sales-variants-hint')!.textContent, t('ai.variantsProblem.weights_one_arm'));
            assert.equal(dom.get('sales-variants-hint')!.classes.has('text-warning'), true);
        }
    });

    it('refuses to run an experiment with one variant, and lets a draft with one be saved while it is off', async () => {
        const { AiSettingsPage, dom, calls, saves } = await opened(payloadOf(false, []));
        type(dom, 'A', { label: 'Only', weight: '50' });
        await submit(AiSettingsPage);
        assert.deepEqual(calls.slice(1), ['agent', 'variants'], 'off: a draft');
        assert.equal(saves[0]!.variants.length, 1);
        dom.get('sales-variants-enabled')!.checked = true;
        calls.length = 0;
        await submit(AiSettingsPage);
        assert.deepEqual(calls, [], 'on: not with one');
    });

    it('says what the server refused, in words, when it refuses something the page could not check (a link or a number in the wording)', async () => {
        for (const lang of LANGS) {
            const refusal = Object.assign(new Error('Write the wording, not a link.'), { status: 400, body: { code: 'VARIANTS_INVALID', problems: [{ field: 'variants[0].cta', code: 'text_link', message: 'x' }] } });
            const { AiSettingsPage, dom, toasts, t, calls } = await opened(payloadOf(false, [WARM, DIRECT]), {
                lang, api: { saveSalesVariants: async () => { throw refusal; } },
            });
            type(dom, 'A', { cta: 'Send https://x.test' });
            await submit(AiSettingsPage);
            assert.deepEqual(calls.slice(1), ['agent'], `${lang}: the agent was saved, the experiment was refused`);
            assert.equal(toasts.at(-1)!.type, 'error');
            assert.equal(toasts.at(-1)!.message, t('ai.variantsProblem.text_link'));
            assert.equal(AiSettingsPage.variantsDirty(), true, 'still unsaved, so the note beside Save says so');
        }
    });

    it('never sends the experiment of an account that did not load it (the sales assistant Off, or a server without it)', async () => {
        const off = await opened(payloadOf(true, [WARM, DIRECT]), { mode: 'off' });
        await submit(off.AiSettingsPage);
        assert.deepEqual(off.calls, ['agent']);
        const old = await opened(new Error('Not found.'));
        await submit(old.AiSettingsPage);
        assert.deepEqual(old.calls.filter((c) => c === 'variants'), []);
    });
});

// ─── The files ───────────────────────────────────────────────────────────────────────────────

describe('AI settings: the wording experiment, wiring', () => {
    it('has the three actions registered, an API client for the route, and a stylesheet for the cards that holds at a phone\'s width', () => {
        const page = readFileSync('dashboard/js/pages/ai_settings.js', 'utf8');
        for (const action of ['variantsChanged', 'addVariant', 'removeVariant']) assert.match(page, new RegExp(`${action}: `));
        const api = readFileSync('dashboard/js/api.js', 'utf8');
        assert.match(api, /getSalesVariants: \(\) => API\.request\('\/settings\/sales-variants'\)/);
        assert.match(api, /saveSalesVariants: \(data\) => API\.request\('\/settings\/sales-variants', \{ method: 'POST', body: JSON\.stringify\(data\) \}\)/);
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /\.variant-card \{[^}]*min-inline-size: 0/, 'a fieldset shrinks, or it stretches the page at 375px');
        assert.match(css, /\.variant-card \{[^}]*border: 1px solid var\(--border-subtle\)/);
        assert.doesNotMatch(css, /\.variant-card \{[^}]*(width|inline-size): \d+px/, 'no fixed width');
    });
});
