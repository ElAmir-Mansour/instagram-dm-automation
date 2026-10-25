/**
 * Operations: the "AI providers" card (P20d; dashboard/js/pages/ai_providers.js).
 *
 * Loaded the way operations.test.ts and escaping.test.ts load the dashboard: the REAL shipped files in a `node:vm` context with a
 * fake DOM that keeps the elements the card paints into, so these test what ships. What they pin, that a screenshot cannot:
 *
 *   - **the card reads what the server writes.** Its fixtures are built by the server's own `describeAi` and typed with the server's
 *     `UsageSummary`, so a field renamed on either side fails here rather than blanking a card in production;
 *   - **a key is only ever sent.** No paint carries one, the password field has no value and is emptied after a save (and kept when
 *     the provider refuses it), and a pasted key appears in no region and no toast;
 *   - **nothing from the server is written as markup.** A model name, a tenant's name, a provider's error and a base URL are hostile
 *     strings here, put in every place the card draws one, and none comes out as a live tag or breaks out of an attribute;
 *   - **the old Gemini card still works inside it** (the DM bot's key check, the quota caveat, the two outcomes of Remove);
 *   - **the pure helpers** (money, masking, the route table, the request bodies) and **both languages**.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { describeAi } from '../services/aiProviders/view.js';
import { PROVIDER_KEY_ENV, ProviderKeys, type AiConfig, type KeySource } from '../services/aiProviders/settings.js';
import type { UsageSummary } from '../services/aiProviders/usage.js';
import { PROVIDER_IDS, type ProviderId } from '../services/llm/registry.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ─── The fake DOM ────────────────────────────────────────────────────────────────────────────

class FakeEl {
    innerHTML = '';
    textContent = '';
    name = '';
    value = '';
    checked = false;
    disabled = false;
    hidden = false;
    offsetWidth = 0;
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    attrs: Record<string, string> = {};
    classes = new Set<string>();
    /** What `querySelector(selector)` answers, by the exact selector the card uses. */
    found: Record<string, FakeEl> = {};
    classList = {
        add: (c: string) => { this.classes.add(c); },
        remove: (c: string) => { this.classes.delete(c); },
        contains: (c: string) => this.classes.has(c),
        toggle: (c: string, force?: boolean) => { if (force === undefined ? !this.classes.has(c) : force) this.classes.add(c); else this.classes.delete(c); },
    };
    constructor(public id = '') {}
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return k in this.attrs ? this.attrs[k]! : null; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    querySelector(selector: string) { return this.found[selector] ?? null; }
    querySelectorAll() { return []; }
    addEventListener() {}
    removeEventListener() {}
    appendChild() {}
    focus() {}
    remove() {}
    closest() { return null; }
    contains() { return false; }
}

class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { values?: Record<string, unknown> } | null) {
        this.fields = (form && form.values) || {};
    }
    get(name: string): unknown {
        return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null;
    }
}

function load(opts: { withCard?: boolean; lang?: 'ar' | 'en' } = {}) {
    const withCard = opts.withCard !== false;
    const elements = new Map<string, FakeEl>();
    const el = (id: string): FakeEl => {
        let found = elements.get(id);
        if (!found) { found = new FakeEl(id); elements.set(id, found); }
        return found;
    };
    const container = el('page-container');
    const api: Record<string, (...args: unknown[]) => unknown> = {};
    const calls: Array<{ name: string; args: unknown[] }> = [];
    const toasts: Array<{ message: string; type?: string }> = [];
    const confirms: Array<Record<string, unknown>> = [];
    const appended: Array<Record<string, unknown>> = [];

    const ctx: Record<string, unknown> = {
        document: Object.assign(new FakeEl(), {
            createElement: () => Object.assign(new FakeEl(), { onload: null as null | (() => void), onerror: null as null | (() => void), src: '' }),
            body: new FakeEl(),
            head: { appendChild: (node: Record<string, unknown>) => { appended.push(node); } },
            documentElement: Object.assign(new FakeEl(), { lang: 'ar', dir: 'rtl' }),
            getElementById: (id: string) => (id === 'page-container' ? container : elements.get(id) ?? null),
            activeElement: null,
            visibilityState: 'visible',
        }),
        window: {
            addEventListener() {}, removeEventListener() {},
            matchMedia: () => ({ matches: false, addEventListener() {} }),
            location: { hash: '' },
        },
        Intl, console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: 'ar' },
        CSS: { escape: (v: string) => String(v) },
        API: new Proxy(api, {
            get: (target, prop: string) => (prop in target
                ? (...args: unknown[]) => { calls.push({ name: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        location: { hash: '', pathname: '/dashboard', search: '' },
        history: { replaceState() {} },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        URL, URLSearchParams,
        crypto: { getRandomValues: (a: Uint8Array) => a },
        FormData: FakeFormData,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    const files = [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js',
        'dashboard/js/motion.js',
        'dashboard/js/pages/admin_common.js',
        ...(withCard ? ['dashboard/js/pages/ai_providers.js'] : []),
        'dashboard/js/pages/operations.js',
        'dashboard/js/app.js',
    ];
    for (const f of files) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    const names = `OperationsPage, App, UI, Admin, t, I18N, html, esc${withCard ? ', AiProviders, AiProvidersView' : ''}`;
    const s = vm.runInContext(`({ ${names} })`, ctx) as Json;
    s.UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    s.Admin.confirm = (o: Record<string, unknown>) => { confirms.push(o); };
    if (opts.lang === 'en') s.I18N.lang = 'en';
    const run = <T = unknown>(code: string): T => vm.runInContext(code, ctx) as T;
    const loaded: Loaded = {
        ...s, Ops: s.OperationsPage, Card: s.AiProviders as Json, View: s.AiProvidersView as Json,
        api, calls, toasts, confirms, appended, container, el, elements, ctx: ctx as Json, run,
        /** Every region the card has painted, as one string. */
        painted: () => [...elements.values()].map((e) => e.innerHTML).join('\n'),
        t: s.t as Loaded['t'],
    };
    return loaded;
}

/** What `load()` hands a test: the shipped globals (`Card`, `View`, `App`, `UI`, `html`, `esc`, ...) and the fake page they run on. */
interface Loaded extends Json {
    Ops: Json;
    Card: Json;
    View: Json;
    api: Record<string, (...args: unknown[]) => unknown>;
    calls: Array<{ name: string; args: unknown[] }>;
    toasts: Array<{ message: string; type?: string }>;
    confirms: Array<Record<string, unknown>>;
    appended: Array<Record<string, unknown>>;
    container: FakeEl;
    el: (id: string) => FakeEl;
    elements: Map<string, FakeEl>;
    ctx: Json;
    run: <T = unknown>(code: string) => T;
    painted: () => string;
    t: (key: string, params?: Record<string, unknown>) => string;
}

/** A form as the card's handlers see it: its dataset, what FormData holds, and the controls they look up by selector. */
function fakeForm(opts: { dataset?: Record<string, string>; values?: Record<string, unknown>; controls?: Record<string, FakeEl>; busyLabel?: string }) {
    const submit = new FakeEl();
    submit.innerHTML = opts.busyLabel ?? 'Check and save';
    const form = new FakeEl();
    form.dataset = opts.dataset ?? {};
    (form as unknown as { values: Record<string, unknown> }).values = opts.values ?? {};
    form.found = { 'button[type="submit"]': submit, ...(opts.controls ?? {}) };
    return Object.assign(form, { submit });
}

const event = { preventDefault: () => {} };
/** A value out of the vm context as a plain object of this realm, so `deepStrictEqual` compares what it says rather than whose prototype it has. */
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// ─── Fixtures: what the server writes ────────────────────────────────────────────────────────

/** Run-time key-shaped strings, never literals (a key-shaped literal is what secret scanners block a push for). */
const KEY = (marker: string): string => `sk-test-${'q'.repeat(30)}${marker}`;

const BUDGETS = { dailyUsd: null, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: null };

function aiView(over: { keys?: Partial<Record<ProviderId, { source: KeySource; key: string }>>; env?: ProviderId[]; config?: Partial<AiConfig> } = {}): Json {
    const config: AiConfig = { providers: {}, routing: {}, prices: {}, budgets: { ...BUDGETS }, ...(over.config ?? {}) };
    const keys = new ProviderKeys(
        new Map(Object.entries(over.keys ?? { anthropic: { source: 'database' as KeySource, key: KEY('ant1') } }) as [ProviderId, { source: KeySource; key: string }][]),
        new Set(over.env ?? [])
    );
    const spend = usageView().today;
    return JSON.parse(JSON.stringify({ ...describeAi(config, keys), spend: { today: spend, month: usageView().month, dayStart: '2026-10-14T00:00:00.000Z' } }));
}

function usageView(over: Partial<UsageSummary> = {}): UsageSummary {
    return {
        asOf: '2026-10-14T09:00:00.000Z', dayStart: '2026-10-14T00:00:00.000Z', monthStart: '2026-10-01T00:00:00.000Z',
        today: { calls: 12, failed: 1, unpriced: 0, usd: 0.0432 },
        month: { calls: 340, failed: 9, unpriced: 3, usd: 18.5 },
        period: 'day',
        byPurpose: [
            { purpose: 'onboarding_draft', provider: 'anthropic', calls: 8, failed: 0, usd: 0.04, tokensIn: 10_000, tokensOut: 3000 },
            { purpose: 'key_test', provider: 'anthropic', calls: 4, failed: 1, usd: 0.0032, tokensIn: 200, tokensOut: 40 },
        ],
        byTenant: [
            { creatorId: null, name: null, calls: 4, usd: 0.0032 },
            { creatorId: 'c-1', name: 'سالم للتصميم', calls: 8, usd: 0.04 },
        ],
        byOutcome: [{ outcome: 'ok', calls: 11 }, { outcome: 'auth', calls: 1 }],
        ...over,
    };
}

const GEMINI_SAVED = { source: 'database', preview: 'AIz•••••••••••••89', envFallback: true };

/** A loaded card: the AI settings, the Gemini status and the spend, as `load()` would leave them. */
function loaded(over: Parameters<typeof aiView>[0] = {}, extra: { gemini?: Json | null; usage?: UsageSummary | null } = {}) {
    const s = load();
    s.Card.ai = aiView(over);
    s.Card.gemini = extra.gemini === undefined ? GEMINI_SAVED : extra.gemini;
    s.Card.usage = extra.usage === undefined ? usageView() : extra.usage;
    return s;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The pure half
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('AI providers card — the pure helpers', () => {
    const { View } = load();

    it('writes money as a spend figure: fractions of a cent kept, cents above a dollar, a dash for nothing', () => {
        assert.equal(View.usd(0, 'en'), '$0');
        assert.equal(View.usd(0.0004, 'en'), '$0.0004');
        assert.equal(View.usd(0.5, 'en'), '$0.50');
        assert.equal(View.usd(12.5, 'en'), '$12.50');
        assert.equal(View.usd(1234.567, 'en'), '$1,234.57');
        assert.equal(View.usd(0.00004, 'en'), '<$0.0001');
        assert.equal(View.usd(null), '—');
        assert.equal(View.usd(undefined), '—');
        assert.equal(View.usd(Number.NaN), '—');
    });

    it('writes a price per million tokens: whole dollars bare, the rest to the cent or finer', () => {
        assert.equal(View.rate(4, 'en'), '$4');
        assert.equal(View.rate(0.1, 'en'), '$0.10');
        assert.equal(View.rate(1.5, 'en'), '$1.50');
        assert.equal(View.rate(0.0625, 'en'), '$0.0625');
        assert.equal(View.rate(null), '—');
    });

    it('writes how long a call took', () => {
        assert.equal(View.duration(340, 'en'), '340 ms');
        assert.equal(View.duration(1400, 'en'), '1.4 s');
        assert.equal(View.duration(null), '—');
        assert.equal(View.duration(-5), '—');
    });

    it('reads a money box: empty is no limit, Arabic digits and separators are numbers, nonsense and the absurd are refused', () => {
        assert.deepEqual({ ...View.parseMoney('') }, { ok: true, value: null });
        assert.deepEqual({ ...View.parseMoney('   ') }, { ok: true, value: null });
        assert.deepEqual({ ...View.parseMoney('0') }, { ok: true, value: 0 });
        assert.deepEqual({ ...View.parseMoney('12.5') }, { ok: true, value: 12.5 });
        assert.deepEqual({ ...View.parseMoney('12,5') }, { ok: true, value: 12.5 });
        assert.deepEqual({ ...View.parseMoney('١٢٫٥') }, { ok: true, value: 12.5 });
        assert.deepEqual({ ...View.parseMoney('۴') }, { ok: true, value: 4 });
        for (const bad of ['abc', '-1', '1e3', '1.2.3', '$5', '5 dollars']) assert.equal(View.parseMoney(bad).ok, false, bad);
        assert.deepEqual({ ...View.parseMoney('1000001') }, { ok: false, reason: 'range' });
        assert.equal(View.parseMoney('10001', 10_000).ok, false, 'a price is bounded tighter than a budget');
    });

    it('shows a saved limit as a plain number the box can be edited from, and nothing for no limit', () => {
        assert.equal(View.moneyInput(null), '');
        assert.equal(View.moneyInput(undefined), '');
        assert.equal(View.moneyInput(5), '5');
        assert.equal(View.moneyInput(0), '0');
        assert.equal(View.moneyInput(2.5), '2.5');
    });

    it('describes a key by its status and masks it to the last four characters, never more', () => {
        const saved = View.keyBadge({ keyRequired: true, key: { set: true, source: 'database', last4: 'ant1', envFallback: false } });
        assert.deepEqual({ ...saved }, { kind: 'saved', tone: 'success', last4: 'ant1' });
        assert.equal(View.keyBadge({ keyRequired: true, key: { set: true, source: 'env', last4: null, envFallback: true } }).kind, 'env');
        assert.equal(View.keyBadge({ keyRequired: true, key: { set: false, source: null, last4: null, envFallback: false } }).kind, 'none');
        assert.equal(View.keyBadge({ keyRequired: false, key: { set: false, source: null, last4: null, envFallback: false } }).kind, 'optional');
        assert.equal(View.maskedKey('ant1'), '••••ant1');
        assert.equal(View.maskedKey('abcdefgh'), '••••efgh', 'only the last four, whatever it was given');
        assert.equal(View.maskedKey(null), null);
        assert.equal(View.maskedKey(''), null);
        assert.equal(View.maskedKey('\u0000\u0001'), null, 'control characters are not shown');
    });

    it('works out whether a provider can answer, in the server\'s order of reasons', () => {
        const base = { id: 'anthropic', enabled: true, keyRequired: true, key: { set: true } };
        assert.equal(View.providerState(base), 'ready');
        assert.equal(View.providerState({ ...base, enabled: false }), 'off');
        assert.equal(View.providerState({ ...base, key: { set: false } }), 'nokey');
        assert.equal(View.providerState({ ...base, enabled: false, key: { set: false } }), 'off', 'switched off is named before a missing key');
        assert.equal(View.providerState({ id: 'custom', enabled: true, keyRequired: false, key: { set: false }, baseUrl: null }), 'nourl');
        assert.equal(View.providerState({ id: 'custom', enabled: true, keyRequired: false, key: { set: false }, baseUrl: 'https://x.example.com' }), 'ready');
    });

    it('names the environment variable a key falls back to, and answers nothing for a name it does not own', () => {
        assert.equal(View.keyEnv('anthropic'), 'ANTHROPIC_API_KEY');
        assert.equal(View.keyEnv('gemini'), 'GEMINI_API_KEY');
        assert.equal(View.keyEnv('openrouter'), 'OPENROUTER_API_KEY');
        assert.equal(View.keyEnv('groq'), 'GROQ_API_KEY');
        assert.equal(View.keyEnv('custom'), null);
        // The card keeps its own copy of the server's table (it cannot import it), so a provider added there and not here would say "the server's key" with no name.
        for (const id of PROVIDER_IDS) assert.equal(View.keyEnv(id), PROVIDER_KEY_ENV[id], id);
        assert.equal(View.keyEnv('constructor'), null, 'a table lookup, not an object property chain');
        assert.equal(View.keyEnv('__proto__'), null);
    });

    it('lists a provider\'s model suggestions: default first, then the registry\'s, then what was loaded, distinct and bounded', () => {
        const provider = { defaultModel: 'm-default', suggestedModels: ['m-a', 'm-default', 'm-b'] };
        assert.deepEqual([...View.modelOptions(provider, ['m-b', 'm-c', 'm-a', '', 7])], ['m-default', 'm-a', 'm-b', 'm-c']);
        assert.deepEqual([...View.modelOptions(null, undefined)], []);
        const many = Array.from({ length: 900 }, (_, i) => `model-${i}`);
        assert.equal(View.modelOptions(provider, many).length, 500);
    });

    it('builds the routing table from the server\'s purposes, starting an unrouted purpose on Automatic at its own effort', () => {
        const ai = aiView({ config: { routing: { onboarding_proof: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } } } });
        const rows = View.routeRows(ai) as Json[];
        assert.deepEqual(rows.map((r) => r.purpose), ['onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm', 'dm_whatsapp', 'ads_draft', 'ads_review']);
        const draft = rows[0]!;
        assert.deepEqual({ ...draft.selected }, { provider: '', model: '', effort: 'high' });
        assert.equal(draft.saved, null);
        const proof = rows[1]!;
        assert.deepEqual({ ...proof.selected }, { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' });
        assert.deepEqual(rows.filter((r) => r.macBrainGuarded).map((r) => r.purpose), ['tenant_monteur_think', 'tenant_infographic']);
        // The DM purpose is a row like the others: unrouted it starts on Automatic at the effort the server gives it (low), and the Mac does not do it.
        const dm = rows.find((r) => r.purpose === 'dm')!;
        assert.deepEqual({ ...dm.selected }, { provider: '', model: '', effort: 'low' });
        assert.equal(dm.saved, null);
        assert.equal(dm.macBrainGuarded, false);
        assert.deepEqual([...View.routeRows(null)], []);
    });

    it('saves and clears a route for the DM purpose like any other, under its own key', () => {
        assert.deepEqual(plain(View.routePatch('dm', { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' })),
            { ok: true, patch: { routing: { dm: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } } } });
        assert.deepEqual(plain(View.routePatch('dm', { provider: '', model: '', effort: 'low' })), { ok: true, patch: { routing: { dm: null } } });
    });

    it('knows when a route row differs from what is saved', () => {
        assert.equal(View.routeDirty(null, { provider: '', model: '', effort: 'high' }), false, 'Automatic is the saved state of an unrouted purpose');
        assert.equal(View.routeDirty(null, { provider: 'openai', model: '', effort: 'high' }), true);
        const saved = { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' };
        assert.equal(View.routeDirty(saved, { ...saved }), false);
        assert.equal(View.routeDirty(saved, { ...saved, model: ' claude-opus-5-5 ' }), false, 'spaces are not a change');
        assert.equal(View.routeDirty(saved, { ...saved, model: 'x' }), true);
        assert.equal(View.routeDirty(saved, { ...saved, effort: 'low' }), true);
        assert.equal(View.routeDirty(saved, { provider: '', model: '', effort: 'high' }), true, 'going back to Automatic is a change');
    });

    it('builds the route body: Automatic removes the route, a route carries provider, model and effort, and a bad model is refused here', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(View.routePatch('onboarding_draft', { provider: '', model: 'ignored', effort: 'low' }))), { ok: true, patch: { routing: { onboarding_draft: null } } });
        assert.deepEqual(JSON.parse(JSON.stringify(View.routePatch('tenant_studio', { provider: 'gemini', model: '  gemini-3.8-flash ', effort: 'medium' }))),
            { ok: true, patch: { routing: { tenant_studio: { provider: 'gemini', model: 'gemini-3.8-flash', effort: 'medium' } } } });
        assert.deepEqual(JSON.parse(JSON.stringify(View.routePatch('tenant_studio', { provider: 'openai', model: '', effort: 'high' }))),
            { ok: true, patch: { routing: { tenant_studio: { provider: 'openai', model: '', effort: 'high' } } } }, 'an empty model is the provider\'s default');
        assert.equal(View.routePatch('tenant_studio', { provider: 'openai', model: 'a b', effort: 'high' }).field, 'model');
        assert.equal(View.routePatch('tenant_studio', { provider: 'openai', model: '"><img>', effort: 'high' }).ok, false);
        assert.equal(View.routePatch('tenant_studio', { provider: 'openai', model: '', effort: 'extreme' }).field, 'effort');
    });

    it('builds the defaults body: only Custom carries a base URL and a JSON mode, and an empty model clears the default', () => {
        const custom = { id: 'custom' };
        assert.deepEqual(JSON.parse(JSON.stringify(View.defaultsPatch(custom, { defaultModel: ' m ', baseUrl: ' https://x.example.com/v1 ', jsonMode: 'object' }))),
            { ok: true, patch: { providers: { custom: { defaultModel: 'm', baseUrl: 'https://x.example.com/v1', jsonMode: 'object' } } } });
        assert.deepEqual(JSON.parse(JSON.stringify(View.defaultsPatch({ id: 'anthropic' }, { defaultModel: '', baseUrl: 'https://evil.example.com', jsonMode: 'object' }))),
            { ok: true, patch: { providers: { anthropic: { defaultModel: null } } } });
        assert.equal(View.defaultsPatch(custom, { defaultModel: 'a b' }).ok, false);
        assert.deepEqual(JSON.parse(JSON.stringify(View.enablePatch('openai', false))), { providers: { openai: { enabled: false } } });
    });

    it('builds a price body: lower-case model, both prices required, bounded', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(View.pricePatch(' GPT-6-Astra ', '2.5', '١٠'))), { ok: true, patch: { prices: { 'gpt-6-astra': { in: 2.5, out: 10 } } } });
        assert.equal(View.pricePatch('', '1', '2').field, 'model');
        assert.equal(View.pricePatch('m', '', '2').field, 'in');
        assert.equal(View.pricePatch('m', '1', 'x').field, 'out');
        assert.equal(View.pricePatch('m', '1', '10001').field, 'out');
        assert.deepEqual(JSON.parse(JSON.stringify(View.pricesRemovePatch(' Claude-Opus-5-5 '))), { prices: { 'claude-opus-5-5': null } });
    });

    it('builds a budgets body from the boxes that changed only, and names a box the server would refuse', () => {
        const current = { dailyUsd: 5, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: 20 };
        assert.deepEqual(JSON.parse(JSON.stringify(View.budgetsPatch(current, { dailyUsd: '5', monthlyUsd: '', tenantDailyUsd: '', tenantMonthlyUsd: '20' }))), { ok: true, patch: null });
        assert.deepEqual(JSON.parse(JSON.stringify(View.budgetsPatch(current, { dailyUsd: '', monthlyUsd: '100', tenantDailyUsd: '0', tenantMonthlyUsd: '20' }))),
            { ok: true, patch: { budgets: { dailyUsd: null, monthlyUsd: 100, tenantDailyUsd: 0 } } });
        assert.deepEqual(JSON.parse(JSON.stringify(View.budgetsPatch(current, { dailyUsd: 'lots', monthlyUsd: '', tenantDailyUsd: '', tenantMonthlyUsd: '20' }))), { ok: false, field: 'dailyUsd', reason: 'format' });
    });

    it('sorts the spend breakdown biggest first with each row\'s share, and keeps a purpose that only failed', () => {
        const rows = View.spendRows(usageView({
            byPurpose: [
                { purpose: 'a', provider: 'x', calls: 1, failed: 1, usd: 0, tokensIn: 0, tokensOut: 0 },
                { purpose: 'b', provider: 'x', calls: 3, failed: 0, usd: 3, tokensIn: 0, tokensOut: 0 },
                { purpose: 'c', provider: 'y', calls: 1, failed: 0, usd: 1, tokensIn: 0, tokensOut: 0 },
            ],
        }));
        assert.deepEqual((rows.purposes as Json[]).map((r) => [r.purpose, r.share]), [['b', 75], ['c', 25], ['a', 0]]);
        assert.equal(rows.total, 4);
        assert.equal((rows.tenants as Json[])[0]!.name, 'سالم للتصميم', 'biggest tenant first');
        assert.deepEqual([...View.spendRows(null).purposes], []);
    });

    it('turns a Test or Check answer into a verdict with the error\'s code and the provider\'s own words', () => {
        const ok = View.verdict({ ok: true, purpose: 'tenant_studio', provider: 'anthropic', model: 'claude-opus-5-5', usd: 0.0004, elapsedMs: 1200 });
        assert.equal(ok.ok, true);
        assert.equal(ok.model, 'claude-opus-5-5');
        assert.equal(ok.usd, 0.0004);
        const failed = View.verdict({ ok: false, provider: 'openai', error: { kind: 'auth', message: 'Incorrect API key' } });
        assert.deepEqual({ ok: failed.ok, code: failed.code, message: failed.message }, { ok: false, code: 'auth', message: 'Incorrect API key' });
        assert.equal(View.verdict({ ok: false }).code, 'unknown');
        assert.equal(View.verdict(null).ok, false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// What it draws
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('AI providers card — what it draws', () => {
    it('is one section on the page the admin opens, under the tenant cards, replacing the Gemini card', async () => {
        const { Ops, api, container, t } = load();
        api.getAdminOps = () => Promise.resolve({ tenants: [] });
        api.getAdminAi = () => Promise.resolve(aiView());
        api.getGeminiKey = () => Promise.resolve(GEMINI_SAVED);
        api.getAiUsage = () => Promise.resolve(usageView());

        await Ops.render();
        const page = String(container.innerHTML);
        assert.ok(page.includes(t('ops.ai.title')));
        assert.ok(page.indexOf(t('ops.tenantsTitle')) < page.indexOf(t('ops.ai.title')));
        assert.ok(page.indexOf(t('ops.ai.title')) < page.indexOf(t('ops.queueTitle')) || !page.includes(t('ops.queueTitle')));
        assert.equal(page.includes(`<h2 class="section-title">${t('ops.gemini.title')}</h2>`), false, 'no separate Gemini section: it is a provider row now');
        assert.ok(page.includes('id="aip-p-gemini"'));
    });

    it('shows every provider with its key status and the last four characters, and never a key', () => {
        const { Card, t } = loaded({
            keys: { anthropic: { source: 'database', key: KEY('ant1') }, openai: { source: 'env', key: KEY('oai2') } },
            env: ['openai'],
        });
        const markup = String(Card.renderLoaded());
        for (const label of ['Anthropic (Claude)', 'OpenAI', 'Google Gemini', 'OpenRouter', 'Groq', 'Custom (OpenAI-compatible)']) assert.ok(markup.includes(label), label);
        assert.ok(markup.includes(`${t('ops.ai.badge.saved')} <bdi class="ltr-text" dir="ltr">••••ant1</bdi>`), 'the saved key: status and its last four, isolated');
        assert.ok(markup.includes(t('ops.ai.badge.env')));
        assert.ok(!markup.includes('oai2'), 'an environment key is reported present and never previewed');
        assert.ok(!markup.includes(KEY('ant1')) && !markup.includes('q'.repeat(30)), 'no key, whole or in part');
        assert.ok(markup.includes(t('ops.ai.key.fromEnv', { env: 'OPENAI_API_KEY' })));
    });

    it('gives every provider a paste field that is masked, never prefilled and never autofilled', () => {
        const { Card } = loaded();
        const markup = String(Card.renderLoaded());
        const inputs = [...markup.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((m) => m[0]);
        assert.equal(inputs.length, 6, 'one per provider');
        for (const input of inputs) {
            assert.match(input, /autocomplete="new-password"/);
            assert.match(input, /name="apiKey"/);
            assert.doesNotMatch(input, /\svalue=/);
        }
    });

    it('reads as an outage when a provider that needs a key has none, and is quiet for Custom, which may run without', () => {
        const { Card, t } = loaded({ keys: {} });
        const markup = String(Card.renderLoaded());
        assert.ok(markup.includes('role="alert"'));
        assert.ok(markup.includes(t('ops.ai.key.none', { name: 'Anthropic (Claude)' })));
        assert.ok(markup.includes(t('ops.ai.key.noneOptional')));
        assert.equal(markup.includes(t('ops.ai.key.none', { name: 'Custom (OpenAI-compatible)' })), false);
    });

    it('offers Remove only for a key saved here, Check and Load models only for a provider that can answer', () => {
        const { Card } = loaded({ keys: { anthropic: { source: 'database', key: KEY('ant1') } } });
        const anthropic = String(Card.providerInner(Card.provider('anthropic')));
        const openai = String(Card.providerInner(Card.provider('openai')));
        assert.ok(anthropic.includes('data-action="aip:removeKey"'));
        assert.ok(!openai.includes('data-action="aip:removeKey"'));
        const check = (markup: string) => markup.match(/<button[^>]*data-action="aip:check"[^>]*>/)?.[0] ?? '';
        assert.doesNotMatch(check(anthropic), /disabled/);
        assert.match(check(openai), /disabled/, 'nothing to check without a key');
        assert.match(String(Card.providerInner(Card.provider('custom'))).match(/<button[^>]*data-action="aip:loadModels"[^>]*>/)![0], /disabled/, 'Custom needs its base URL first');
    });

    it('puts the switch, the base URL and the JSON mode where they belong: the switch on all six, the endpoint on Custom only', () => {
        const { Card } = loaded();
        const markup = String(Card.renderLoaded());
        assert.equal([...markup.matchAll(/data-change="aip:toggleEnabled"/g)].length, 6);
        assert.equal([...markup.matchAll(/name="baseUrl"/g)].length, 1);
        assert.equal([...markup.matchAll(/name="jsonMode"/g)].length, 1);
        const custom = String(Card.providerInner(Card.provider('custom')));
        assert.match(custom, /name="baseUrl" type="url" dir="ltr"/);
        assert.ok(!String(Card.providerInner(Card.provider('openai'))).includes('name="baseUrl"'));
        // A provider switched off is unchecked.
        const off = loaded({ config: { providers: { openai: { enabled: false } } } });
        assert.doesNotMatch(String(off.Card.enableSwitch(off.Card.provider('openai'))), /checked/);
        assert.match(String(off.Card.enableSwitch(off.Card.provider('anthropic'))), /checked/);
    });

    it('draws the routing table: a row per purpose, Automatic for an unrouted one with its model and effort off', () => {
        const { Card, View, t } = loaded({ config: { routing: { tenant_studio: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } } } });
        const markup = String(Card.renderLoaded());
        for (const purpose of ['onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm', 'dm_whatsapp', 'ads_draft', 'ads_review']) {
            assert.ok(markup.includes(`id="aip-r-${purpose}"`), purpose);
            assert.ok(markup.includes(t(`ops.ai.purpose.${purpose}`)), purpose);
            assert.ok(markup.includes(t(`ops.ai.purpose.${purpose}.hint`)), `${purpose}: its hint`);
        }
        const rows = View.routeRows(Card.ai) as Json[];
        const draft = String(Card.routeInner(rows.find((r) => r.purpose === 'onboarding_draft')));
        assert.match(draft, /<option value="" selected>/, 'Automatic is selected');
        assert.match(draft.match(/<input[^>]*name="model"[^>]*>/)![0], /disabled/);
        assert.match(draft.match(/<select[^>]*name="effort"[^>]*>/)![0], /disabled/);
        const studio = String(Card.routeInner(rows.find((r) => r.purpose === 'tenant_studio')));
        assert.match(studio, /<option value="anthropic" selected>/);
        assert.match(studio, /<option value="low" selected>/);
        assert.match(studio.match(/<input[^>]*name="model"[^>]*>/)![0], /value="claude-sonnet-5-5"/);
        assert.doesNotMatch(studio.match(/<input[^>]*name="model"[^>]*>/)![0], /disabled/);
        assert.match(studio.match(/<input[^>]*name="model"[^>]*>/)![0], /list="aip-models-anthropic"/, 'free text, with the provider\'s list as suggestions');
    });

    it('marks the two purposes the Mac already does, and says what each route would use now', () => {
        const { Card, View, t } = loaded();
        const rows = View.routeRows(Card.ai) as Json[];
        const monteur = String(Card.routeInner(rows.find((r) => r.purpose === 'tenant_monteur_think')));
        const draft = String(Card.routeInner(rows.find((r) => r.purpose === 'onboarding_draft')));
        assert.ok(monteur.includes(t('ops.ai.macGuard')));
        assert.ok(!draft.includes(t('ops.ai.macGuard')));
        // With only Anthropic keyed, Automatic resolves to it at its default model.
        assert.match(draft, /id="aip-now-onboarding_draft"[^>]*>[\s\S]*Anthropic \(Claude\)[\s\S]*claude-opus-5-5/);
        // With nothing keyed it says why nothing can answer.
        const none = loaded({ keys: {} });
        const row = (none.View.routeRows(none.Card.ai) as Json[])[0];
        assert.ok(String(none.Card.nowLine(row)).includes('no_provider'));
    });

    it('offers Test on a route that matches what is saved and not on one with unsaved changes', () => {
        const { Card, View } = loaded();
        const row = (View.routeRows(Card.ai) as Json[])[0];
        const test = String(Card.routeInner(row)).match(/<button[^>]*data-action="aip:testRoute"[^>]*>/)![0];
        assert.doesNotMatch(test, /disabled/);
        assert.match(test, /data-purpose="onboarding_draft"/);
        const dirty = String(Card.routeInner({ ...row, selected: { ...row!.selected, provider: 'openai' } })).match(/<button[^>]*data-action="aip:testRoute"[^>]*>/)![0];
        assert.match(dirty, /disabled/);
    });

    it('draws the prices with their source, an Edit on every row and a Remove on the operator\'s own', () => {
        const { Card, t } = loaded({ config: { prices: { 'gpt-6-astra': { in: 2.5, out: 10 } } } });
        const markup = String(Card.pricesInner());
        assert.ok(markup.includes('claude-opus-5-5') && markup.includes('gpt-6-astra'));
        assert.ok(markup.includes(t('ops.ai.priceCustom')) && markup.includes(t('ops.ai.priceDefault')));
        assert.equal([...markup.matchAll(/data-action="aip:editPrice"/g)].length, 11, 'ten built in and one of the operator\'s');
        assert.equal([...markup.matchAll(/data-action="aip:removePrice"/g)].length, 1, 'only an override can be removed');
        assert.match(markup, /data-model="gpt-6-astra"[^>]*data-in="2.5"[^>]*data-out="10"/);
    });

    it('draws the four budgets with what is saved, empty for no limit, and what has been spent against the platform ones', () => {
        const { Card, t } = loaded({ config: { budgets: { dailyUsd: 5, monthlyUsd: null, tenantDailyUsd: 0.5, tenantMonthlyUsd: null } } });
        const markup = String(Card.budgetsInner());
        const input = (name: string) => markup.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))![0];
        assert.match(input('dailyUsd'), /value="5"/);
        assert.match(input('monthlyUsd'), /value=""/);
        assert.match(input('tenantDailyUsd'), /value="0.5"/);
        for (const name of ['dailyUsd', 'monthlyUsd', 'tenantDailyUsd', 'tenantMonthlyUsd']) assert.match(input(name), /inputmode="decimal"[^>]*dir="ltr"|dir="ltr"[^>]*inputmode="decimal"/, name);
        assert.ok(markup.includes(t('ops.ai.budget.none')), 'the placeholder says no limit');
        assert.ok(markup.includes('<bdi class="ltr-text" dir="ltr">$0.0432</bdi>'), 'today\'s spend beside the platform daily budget');
    });

    it('names the DM purpose and the evaluation label in the spend, in words and not as raw ids, and counts both in the total', () => {
        const usage = usageView({
            byPurpose: [
                { purpose: 'dm', provider: 'anthropic', calls: 3, failed: 0, usd: 0.06, tokensIn: 15_000, tokensOut: 900 },
                { purpose: 'eval', provider: 'anthropic', calls: 30, failed: 1, usd: 0.5, tokensIn: 150_000, tokensOut: 9000 },
            ],
        });
        const { Card, View, t } = loaded({}, { usage });
        const markup = String(Card.spendInner());
        assert.ok(markup.includes(t('ops.ai.purpose.dm')) && markup.includes(t('ops.ai.purpose.eval')));
        assert.doesNotMatch(markup, />(dm|eval)</, 'a purpose the card has words for is never shown as its id');
        const rows = View.spendRows(usage) as Json;
        assert.ok(Math.abs(rows.total - 0.56) < 1e-9, 'the total is the sum of every row, evaluation runs included');
        assert.deepEqual((rows.purposes as Json[]).map((r) => [r.purpose, r.share]), [['eval', 89], ['dm', 11]]);
    });

    it('draws the spend: today and this month, by purpose (named) and by tenant (the platform when there is none)', () => {
        const { Card, t } = loaded();
        const markup = String(Card.spendInner());
        assert.ok(markup.includes('$0.0432') && markup.includes('$18.50'));
        assert.ok(markup.includes(t('ops.ai.purpose.onboarding_draft')));
        assert.ok(markup.includes(t('ops.ai.purpose.key_test')));
        assert.ok(markup.includes(t('ops.ai.spend.platform')));
        assert.ok(markup.includes('سالم للتصميم'));
        assert.match(markup, /data-period="day"[^>]*aria-pressed="true"/);
        assert.match(markup, /data-period="month"[^>]*aria-pressed="false"/);
        // An empty period says so.
        const empty = loaded({}, { usage: usageView({ byPurpose: [], byTenant: [] }) });
        assert.ok(String(empty.Card.spendInner()).includes(t('ops.ai.spend.none')));
    });

    it('says each warning once: no budget, a route on Gemini, and the models with no price', () => {
        const { Card, t } = loaded({ keys: { gemini: { source: 'env', key: KEY('gem3') }, openai: { source: 'database', key: KEY('oai2') } } });
        const markup = String(Card.warnings());
        assert.ok(markup.includes(t('ops.ai.warn.noBudget')));
        // OpenAI answers first, and its default model has no price in the table.
        assert.ok(markup.includes(t('ops.ai.warn.unpriced')) && markup.includes('gpt-6-astra'));
        const gemini = loaded({ keys: { gemini: { source: 'env', key: KEY('gem3') } }, config: { budgets: { ...BUDGETS, dailyUsd: 5 } } });
        const geminiMarkup = String(gemini.Card.warnings());
        assert.ok(geminiMarkup.includes(t('ops.ai.warn.geminiQuota')));
        assert.ok(!geminiMarkup.includes(t('ops.ai.warn.noBudget')));
    });

    it('gives every control the shared classes that carry the 44px target, and isolates every figure for right-to-left', () => {
        const { Card } = loaded();
        const markup = String(Card.renderLoaded()) + String(Card.spendInner());
        for (const [tag] of markup.matchAll(/<button\b[^>]*>/g)) assert.match(tag, /class="btn\b/, tag);
        for (const [tag] of markup.matchAll(/<input\b[^>]*type="(?:text|password|url)"[^>]*>/g)) assert.match(tag, /class="field\b/, tag);
        for (const [tag] of markup.matchAll(/<select\b[^>]*>/g)) assert.match(tag, /class="select"/, tag);
        for (const [tag] of markup.matchAll(/<input\b[^>]*type="checkbox"[^>]*>/g)) assert.match(markup.slice(markup.lastIndexOf('<label', markup.indexOf(tag)), markup.indexOf(tag)), /class="switch"/);
        // A Latin value (a model id, a figure, a key mask) in a right-to-left page is isolated, or it is typed in the wrong order.
        for (const [tag] of markup.matchAll(/<(?:input|code)\b[^>]*class="[^"]*(?:field-mono|aip-model)[^"]*"[^>]*>/g)) assert.match(tag, /dir="ltr"/, tag);
        assert.ok(/<bdi class="ltr-text" dir="ltr">\$/.test(markup), 'money is isolated');
    });
});

describe('AI providers card — the CSS keeps the 375px, right-to-left and token rules', () => {
    const css = readFileSync('dashboard/css/styles.css', 'utf8');
    const start = css.indexOf('/* ─── Pattern: AI providers card');
    const block = css.slice(start, css.indexOf('/* ─── Tenant detail', start));

    it('has its block, and it ends where the next section begins', () => {
        assert.ok(start > 0 && block.length > 500 && block.includes('.aip-period'));
    });

    it('uses logical properties only (the page is right-to-left first)', () => {
        const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
        assert.doesNotMatch(withoutComments, /\b(?:margin|padding|border)-(?:left|right)\b|\b(?:left|right|float|text-align:\s*(?:left|right))\b/);
    });

    it('writes no colour literal and no fixed width wider than a phone: grids are auto-fit with a min(100%, …) minimum', () => {
        const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
        assert.doesNotMatch(withoutComments, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
        assert.doesNotMatch(withoutComments, /(?:^|[;{\s])(?:width|min-width|inline-size|min-inline-size):\s*\d+(?:px|rem)/m);
        for (const [, columns] of withoutComments.matchAll(/grid-template-columns:\s*([^;]+);/g)) assert.match(columns!, /min\(100%,/, columns);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// What it does: keys
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('AI providers card — keys', () => {
    /** A paste form for one provider, with the password field the card looks up to empty. */
    const keyForm = (provider: string, pasted: string) => {
        const field = new FakeEl();
        field.value = pasted;
        const form = fakeForm({ dataset: { provider }, values: { apiKey: pasted }, controls: { 'input[name="apiKey"]': field } });
        return Object.assign(form, { field });
    };
    const keyedStatus = (last4: string) => ({ set: true, source: 'database', last4, envFallback: false });

    it('sends the pasted key once, trimmed, to the provider\'s own route, then empties the field and repaints that provider', async () => {
        const s = loaded();
        const key = KEY('new9');
        const sent: unknown[] = [];
        s.api.saveAiKey = (id, k) => { sent.push([id, k]); return Promise.resolve({ provider: id, key: keyedStatus('new9') }); };
        s.api.getAdminAi = () => Promise.resolve(aiView({ keys: { anthropic: { source: 'database', key: KEY('ant1') }, openai: { source: 'database', key } } }));
        const form = keyForm('openai', `  ${key}\n`);
        const region = s.el('aip-p-openai');
        const warnings = s.el('aip-warnings');

        await s.Card.saveKey(form, event);

        assert.deepEqual(sent, [['openai', key]]);
        assert.equal(form.field.value, '', 'the pasted key is gone from the field');
        assert.ok(region.innerHTML.includes('••••new9'), 'the provider repainted with its new status');
        assert.ok(warnings.innerHTML.includes(s.t('ops.ai.warn.noBudget')), 'and the warnings');
        assert.deepEqual(s.toasts, [{ message: s.t('ops.ai.key.savedToast'), type: 'success' }]);
        assert.ok(!s.painted().includes(key) && !JSON.stringify(s.toasts).includes(key), 'the key is in no region and no toast');
    });

    it('shows the provider\'s refusal and keeps the paste, so a typo can be fixed; nothing is repainted', async () => {
        const s = loaded();
        const key = KEY('typo');
        s.api.saveAiKey = () => Promise.reject(new Error('OpenAI refused this key: Incorrect API key provided.'));
        const form = keyForm('openai', key);
        const region = s.el('aip-p-openai');

        await s.Card.saveKey(form, event);

        assert.equal(form.field.value, key, 'kept');
        assert.equal(form.submit.disabled, false, 'and the button works again');
        assert.equal(region.innerHTML, '', 'no repaint, which would drop the paste');
        assert.deepEqual(s.toasts, [{ message: 'OpenAI refused this key: Incorrect API key provided.', type: 'error' }]);
    });

    it('says a key saved with a warning (a custom endpoint with no model list) in the same toast', async () => {
        const s = loaded();
        s.api.saveAiKey = () => Promise.resolve({ provider: 'custom', key: keyedStatus('cus5'), warning: 'no_model_list' });
        s.api.getAdminAi = () => Promise.resolve(aiView());
        await s.Card.saveKey(keyForm('custom', KEY('cus5')), event);
        assert.equal(s.toasts[0]!.message, `${s.t('ops.ai.key.savedToast')} ${s.t('ops.ai.warning.no_model_list')}`);
    });

    it('does not send a blank paste, a second one while the first is in flight, a provider that is not listed, or Gemini\'s key down this route', async () => {
        const s = loaded();
        let calls = 0;
        s.api.saveAiKey = () => { calls += 1; return new Promise(() => {}); };

        await s.Card.saveKey(keyForm('openai', '   '), event);
        const form = keyForm('openai', KEY('abc1'));
        void s.Card.saveKey(form, event);
        await s.Card.saveKey(form, event);
        await s.Card.saveKey(keyForm('nope', KEY('abc1')), event);
        await s.Card.saveKey(keyForm('__proto__', KEY('abc1')), event);
        await s.Card.saveKey(keyForm('gemini', KEY('abc1')), event);

        assert.equal(calls, 1);
    });

    it('asks before removing, and says whether the server\'s variable takes over or nothing is left', async () => {
        const s = loaded({ keys: { anthropic: { source: 'database', key: KEY('ant1') }, openai: { source: 'database', key: KEY('oai2') } }, env: ['openai'] });
        const button = (provider: string) => Object.assign(new FakeEl(), { dataset: { provider } });

        s.Card.removeKey(button('openai'));
        s.Card.removeKey(button('anthropic'));
        s.Card.removeKey(button('gemini'));
        s.Card.removeKey(button('nope'));

        assert.equal(s.confirms.length, 2, 'Gemini has its own route, and an unknown provider is ignored');
        assert.equal(s.confirms[0]!.body, s.t('ops.ai.key.removeBodyEnv', { env: 'OPENAI_API_KEY' }));
        assert.equal(s.confirms[1]!.body, s.t('ops.ai.key.removeBodyNone', { name: 'Anthropic (Claude)' }));

        const removed: unknown[] = [];
        s.api.removeAiKey = (id) => { removed.push(id); return Promise.resolve({ provider: id }); };
        s.api.getAdminAi = () => Promise.resolve(aiView({ keys: { anthropic: { source: 'database', key: KEY('ant1') } } }));
        await (s.confirms[0]!.onConfirm as () => Promise<void>)();
        assert.deepEqual(removed, ['openai']);
        assert.deepEqual(s.toasts, [{ message: s.t('ops.ai.key.removed'), type: 'success' }]);
    });

    it('switches a provider on or off with the one field that changes, and puts the switch back when the save fails', async () => {
        const s = loaded();
        const bodies: unknown[] = [];
        s.api.saveAdminAi = (body) => { bodies.push(body); return Promise.resolve(aiView({ config: { providers: { openai: { enabled: false } } } })); };
        const input = Object.assign(new FakeEl(), { dataset: { provider: 'openai' }, checked: false });
        const region = s.el('aip-p-openai');

        await s.Card.toggleEnabled(input);
        assert.deepEqual(plain(bodies), [{ providers: { openai: { enabled: false } } }]);
        assert.ok(region.innerHTML.includes(s.t('ops.ai.state.off')));
        assert.deepEqual(s.toasts.at(-1), { message: s.t('ops.ai.enabledOff', { name: 'OpenAI' }), type: 'success' });

        s.api.saveAdminAi = () => Promise.reject(new Error('Nothing to change.'));
        const failing = Object.assign(new FakeEl(), { dataset: { provider: 'openai' }, checked: true });
        await s.Card.toggleEnabled(failing);
        assert.equal(failing.checked, false, 'back to what is saved');
        assert.equal(failing.disabled, false);
        assert.deepEqual(s.toasts.at(-1), { message: 'Nothing to change.', type: 'error' });
    });

    it('saves a provider\'s default model, and Custom\'s endpoint with it; a model the server would refuse is not sent', async () => {
        const s = loaded();
        const bodies: unknown[] = [];
        s.api.saveAdminAi = (body) => { bodies.push(body); return Promise.resolve(aiView({ config: { providers: { custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model' } } } })); };
        const field = (value: string) => Object.assign(new FakeEl(), { value });
        s.el('aip-p-custom');
        const form = fakeForm({
            dataset: { provider: 'custom' },
            controls: { '[name="defaultModel"]': field('my-model'), '[name="baseUrl"]': field('https://llm.example.com/v1'), '[name="jsonMode"]': field('object') },
        });
        await s.Card.saveDefaults(form, event);
        assert.deepEqual(plain(bodies), [{ providers: { custom: { defaultModel: 'my-model', baseUrl: 'https://llm.example.com/v1', jsonMode: 'object' } } }]);
        assert.ok(s.el('aip-p-custom').innerHTML.includes('https://llm.example.com/v1'));

        const bad = fakeForm({ dataset: { provider: 'openai' }, controls: { '[name="defaultModel"]': field('has space'), '[name="baseUrl"]': field(''), '[name="jsonMode"]': field('') } });
        await s.Card.saveDefaults(bad, event);
        assert.equal(bodies.length, 1, 'refused before the round trip');
        assert.equal(s.toasts.at(-1)!.message, s.t('ops.ai.modelInvalid'));
    });

    it('checks a key now and says so in green, or in red with the error code and the provider\'s own words', async () => {
        const s = loaded();
        const asked: unknown[] = [];
        s.api.testAi = (body) => { asked.push(body); return Promise.resolve({ ok: true, provider: 'anthropic', elapsedMs: 340 }); };
        s.api.getAiUsage = () => Promise.resolve(usageView());
        const button = Object.assign(new FakeEl(), { dataset: { provider: 'anthropic' } });
        const region = s.el('aip-check-anthropic');

        await s.Card.check(button);
        assert.deepEqual(plain(asked), [{ provider: 'anthropic' }]);
        assert.ok(region.innerHTML.includes('badge-success') && region.innerHTML.includes(s.t('ops.ai.checkOk')));
        assert.ok(region.innerHTML.includes('340 ms'));

        s.api.testAi = () => Promise.resolve({ ok: false, provider: 'anthropic', elapsedMs: 80, error: { kind: 'auth', message: 'invalid x-api-key' } });
        await s.Card.check(button);
        assert.ok(region.innerHTML.includes('badge-danger') && region.innerHTML.includes('<code>auth</code>') && region.innerHTML.includes('invalid x-api-key'));

        s.api.testAi = () => Promise.reject(new Error('Could not reach the server.'));
        await s.Card.check(button);
        assert.ok(region.innerHTML.includes('<code>request</code>') && region.innerHTML.includes('Could not reach the server.'));
        assert.equal(button.disabled, false, 'the button is back after every answer');
    });

    it('loads a provider\'s models into its suggestion list, and says why when it cannot', async () => {
        const s = loaded();
        s.api.getAiModels = (id) => Promise.resolve({ provider: id, models: ['claude-opus-5-5', 'claude-future-9'], truncated: false });
        const button = Object.assign(new FakeEl(), { dataset: { provider: 'anthropic' } });
        for (const id of ['aip-datalists', 'aip-models-note-anthropic', 'aip-models-note-openai']) s.el(id);

        await s.Card.loadModels(button);
        assert.ok(s.el('aip-datalists').innerHTML.includes('<option value="claude-future-9">'));
        assert.ok(s.el('aip-models-note-anthropic').innerHTML.includes(s.t('ops.ai.modelsLoaded', { count: '2' })));

        s.api.getAiModels = () => Promise.reject(new Error('OpenAI: Incorrect API key'));
        await s.Card.loadModels(Object.assign(new FakeEl(), { dataset: { provider: 'openai' } }));
        assert.ok(s.el('aip-models-note-openai').innerHTML.includes('OpenAI: Incorrect API key'));
        assert.ok(s.el('aip-datalists').innerHTML.includes('<option value="claude-future-9">'), 'the other provider\'s list is untouched');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// What it does: routing, prices, budgets, spend
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('AI providers card — routing', () => {
    const field = (name: string, value: string) => Object.assign(new FakeEl(), { name, value });
    /** A route form for one purpose, as the browser would hold it. */
    const routeForm = (purpose: string, v: { provider: string; model: string; effort: string }) => {
        const provider = field('provider', v.provider);
        const model = field('model', v.model);
        const effort = field('effort', v.effort);
        const test = new FakeEl();
        const form = fakeForm({
            dataset: { purpose },
            values: v,
            controls: { '[name="provider"]': provider, '[name="model"]': model, '[name="effort"]': effort, '[data-action="aip:testRoute"]': test },
        });
        return Object.assign(form, { provider, model, effort, test });
    };

    it('turns model and effort off for Automatic, starts a new provider on its own default model, and offers Test only for what is saved', async () => {
        const s = loaded({ keys: { anthropic: { source: 'database', key: KEY('ant1') } } });
        const asked: unknown[] = [];
        s.api.getAiModels = (id) => { asked.push(id); return Promise.resolve({ provider: id, models: ['m-1'], truncated: false }); };
        const form = routeForm('onboarding_draft', { provider: '', model: '', effort: 'high' });
        const note = s.el('aip-dirty-onboarding_draft');
        note.classes.add('hidden');

        // Pick a provider: the model (meaningless to another provider) is cleared, its list is wired and warmed once, the row is unsaved.
        form.provider.value = 'anthropic';
        form.model.value = 'a-model-of-another-provider';
        s.Card.routeChanged(form, { target: form.provider });
        s.Card.routeChanged(form, { target: form.provider });
        assert.equal(form.model.value, '');
        assert.equal(form.model.getAttribute('list'), 'aip-models-anthropic');
        assert.equal(form.model.disabled, false);
        assert.equal(form.effort.disabled, false);
        assert.equal(note.classes.has('hidden'), false, '"Unsaved" shows');
        assert.equal(form.test.disabled, true, 'Test waits for Save');
        assert.deepEqual(plain(asked), ['anthropic'], 'the list is fetched once');

        // Back to Automatic: clean again, and the model and effort go off.
        form.provider.value = '';
        s.Card.routeChanged(form, { target: form.provider });
        assert.equal(form.model.disabled, true);
        assert.equal(form.effort.disabled, true);
        assert.equal(note.classes.has('hidden'), true);
        assert.equal(form.test.disabled, false);
        await settle();
    });

    it('does not fetch a model list for a provider that cannot answer (no key): the suggestions stay what the registry has', () => {
        const s = loaded({ keys: {} });
        let asked = 0;
        s.api.getAiModels = () => { asked += 1; return Promise.resolve({ models: [] }); };
        const form = routeForm('tenant_studio', { provider: 'openai', model: '', effort: 'medium' });
        s.Card.routeChanged(form, { target: form.provider });
        assert.equal(asked, 0);
    });

    it('saves a route as provider, model and effort, and Automatic as no route; the saved route is what Test then uses', async () => {
        const s = loaded();
        const bodies: unknown[] = [];
        s.api.saveAdminAi = (body) => {
            bodies.push(body);
            return Promise.resolve(aiView({ config: { routing: { tenant_studio: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } } } }));
        };
        const form = routeForm('tenant_studio', { provider: 'anthropic', model: ' claude-sonnet-5-5 ', effort: 'low' });
        const note = s.el('aip-dirty-tenant_studio');
        s.Card.tests.tenant_studio = { ok: true, provider: 'anthropic', model: 'old' };

        await s.Card.saveRoute(form, event);

        assert.deepEqual(plain(bodies), [{ routing: { tenant_studio: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } } }]);
        assert.deepEqual(s.toasts, [{ message: s.t('ops.ai.route.saved'), type: 'success' }]);
        assert.equal(s.Card.tests.tenant_studio, undefined, 'the old verdict was about the old route');
        assert.equal(form.submit.disabled, false);
        assert.equal(note.classes.has('hidden'), true, 'saved, so not unsaved');
        assert.equal(form.test.disabled, false);

        await s.Card.saveRoute(routeForm('tenant_studio', { provider: '', model: '', effort: 'medium' }), event);
        assert.deepEqual(plain(bodies[1]), { routing: { tenant_studio: null } });
    });

    it('does not send a route the server would refuse, and ignores a purpose it does not list', async () => {
        const s = loaded();
        let calls = 0;
        s.api.saveAdminAi = () => { calls += 1; return Promise.resolve(aiView()); };
        await s.Card.saveRoute(routeForm('tenant_studio', { provider: 'openai', model: 'two words', effort: 'low' }), event);
        await s.Card.saveRoute(routeForm('tenant_studio', { provider: 'openai', model: '', effort: 'extreme' }), event);
        await s.Card.saveRoute(routeForm('not_a_purpose', { provider: 'openai', model: '', effort: 'low' }), event);
        assert.equal(calls, 0);
        assert.deepEqual(s.toasts.map((x) => x.message), [s.t('ops.ai.modelInvalid'), s.t('ops.ai.effortInvalid')]);
    });

    it('shows the failure of a save and keeps the row as it was typed', async () => {
        const s = loaded();
        s.api.saveAdminAi = () => Promise.reject(new Error('routing.tenant_studio.model is not a model id.'));
        const form = routeForm('tenant_studio', { provider: 'openai', model: 'ok-model', effort: 'low' });
        await s.Card.saveRoute(form, event);
        assert.deepEqual(s.toasts, [{ message: 'routing.tenant_studio.model is not a model id.', type: 'error' }]);
        assert.equal(form.model.value, 'ok-model');
        assert.equal(form.submit.disabled, false);
    });

    it('tests the saved route: green with the model, time and cost; red with the code and the provider\'s words; red again if the request itself fails', async () => {
        const s = loaded();
        const asked: unknown[] = [];
        s.api.testAi = (body) => { asked.push(body); return Promise.resolve({ ok: true, purpose: 'onboarding_draft', provider: 'anthropic', model: 'claude-opus-5-5', usd: 0.0004, elapsedMs: 1400 }); };
        s.api.getAiUsage = () => Promise.resolve(usageView());
        const button = Object.assign(new FakeEl(), { dataset: { purpose: 'onboarding_draft' } });
        const region = s.el('aip-t-onboarding_draft');

        await s.Card.testRoute(button);
        assert.deepEqual(plain(asked), [{ purpose: 'onboarding_draft' }]);
        assert.ok(region.innerHTML.includes('badge-success') && region.innerHTML.includes(s.t('ops.ai.test.ok')));
        assert.ok(region.innerHTML.includes('claude-opus-5-5') && region.innerHTML.includes('1.4 s') && region.innerHTML.includes('$0.0004'));

        s.api.testAi = () => Promise.resolve({ ok: false, purpose: 'onboarding_draft', provider: 'anthropic', model: 'claude-opus-5-5', error: { kind: 'quota', message: 'Your credit balance is too low.' } });
        await s.Card.testRoute(button);
        assert.ok(region.innerHTML.includes('badge-danger') && region.innerHTML.includes('<code>quota</code>') && region.innerHTML.includes('Your credit balance is too low.'));
        assert.ok(!region.innerHTML.includes('badge-success'), 'the green one is gone');

        s.api.testAi = () => Promise.reject(new Error('Could not reach the server.'));
        await s.Card.testRoute(button);
        assert.ok(region.innerHTML.includes('<code>request</code>'));
        assert.equal(button.disabled, false);

        await s.Card.testRoute(Object.assign(new FakeEl(), { dataset: { purpose: 'nope' } }));
        assert.equal(asked.length, 1, 'a purpose the server did not list is not tested');
    });
});

describe('AI providers card — prices, budgets and spend', () => {
    const field = (name: string, value: string) => Object.assign(new FakeEl(), { name, value });

    it('saves a price from the form, and refuses what is not a price before the round trip', async () => {
        const s = loaded();
        const bodies: unknown[] = [];
        s.api.saveAdminAi = (body) => { bodies.push(body); return Promise.resolve(aiView({ config: { prices: { 'gpt-6-astra': { in: 2.5, out: 10 } } } })); };
        const form = fakeForm({ controls: { '[name="model"]': field('model', 'GPT-6-Astra'), '[name="in"]': field('in', '2.5'), '[name="out"]': field('out', '10') } });
        const region = s.el('aip-prices');

        await s.Card.savePrice(form, event);
        assert.deepEqual(plain(bodies), [{ prices: { 'gpt-6-astra': { in: 2.5, out: 10 } } }]);
        assert.ok(region.innerHTML.includes(s.t('ops.ai.priceCustom')));

        const bad = fakeForm({ controls: { '[name="model"]': field('model', 'gpt'), '[name="in"]': field('in', 'free'), '[name="out"]': field('out', '10') } });
        await s.Card.savePrice(bad, event);
        assert.equal(bodies.length, 1);
        assert.equal(s.toasts.at(-1)!.message, s.t('ops.ai.priceInvalid'));
    });

    it('puts a row\'s figures in the form as values, and removes an override only for a model the table lists', async () => {
        const s = loaded({ config: { prices: { 'gpt-6-astra': { in: 2.5, out: 10 } } } });
        s.el('aip-price-model');
        s.el('aip-price-in');
        s.el('aip-price-out');
        s.Card.editPrice(Object.assign(new FakeEl(), { dataset: { model: 'gpt-6-astra', in: '2.5', out: '10' } }));
        assert.deepEqual([s.el('aip-price-model').value, s.el('aip-price-in').value, s.el('aip-price-out').value], ['gpt-6-astra', '2.5', '10']);

        const bodies: unknown[] = [];
        s.api.saveAdminAi = (body) => { bodies.push(body); return Promise.resolve(aiView()); };
        await s.Card.removePrice(Object.assign(new FakeEl(), { dataset: { model: 'gpt-6-astra' } }));
        await s.Card.removePrice(Object.assign(new FakeEl(), { dataset: { model: 'something-else' } }));
        assert.deepEqual(plain(bodies), [{ prices: { 'gpt-6-astra': null } }]);
    });

    it('saves only the budgets that changed; empty is no limit, and it says so when nothing changed', async () => {
        const s = loaded({ config: { budgets: { ...BUDGETS, dailyUsd: 5 } } });
        const bodies: unknown[] = [];
        s.api.saveAdminAi = (body) => { bodies.push(body); return Promise.resolve(aiView({ config: { budgets: { ...BUDGETS, monthlyUsd: 100 } } })); };
        const budgetForm = (v: Record<string, string>) => fakeForm({ controls: Object.fromEntries(Object.entries(v).map(([k, val]) => [`[name="${k}"]`, field(k, val)])) });
        s.el('aip-budgets');

        await s.Card.saveBudgets(budgetForm({ dailyUsd: '', monthlyUsd: '100', tenantDailyUsd: '', tenantMonthlyUsd: '' }), event);
        assert.deepEqual(plain(bodies), [{ budgets: { dailyUsd: null, monthlyUsd: 100 } }]);
        assert.ok(s.el('aip-budgets').innerHTML.includes('value="100"'));

        s.Card.ai = aiView({ config: { budgets: { ...BUDGETS, dailyUsd: 5 } } });
        await s.Card.saveBudgets(budgetForm({ dailyUsd: '5', monthlyUsd: '', tenantDailyUsd: '', tenantMonthlyUsd: '' }), event);
        assert.equal(bodies.length, 1);
        assert.equal(s.toasts.at(-1)!.message, s.t('ops.ai.budget.nothing'));

        await s.Card.saveBudgets(budgetForm({ dailyUsd: 'lots', monthlyUsd: '', tenantDailyUsd: '', tenantMonthlyUsd: '' }), event);
        assert.equal(bodies.length, 1);
        assert.equal(s.toasts.at(-1)!.message, s.t('ops.ai.budget.invalid'));
    });

    it('switches the spend breakdown between today and this month with one request, and says when the spend cannot be read', async () => {
        const s = loaded();
        const asked: unknown[] = [];
        s.api.getAiUsage = (period) => { asked.push(period); return Promise.resolve(usageView({ period: 'month', byPurpose: [], byTenant: [] })); };
        const region = s.el('aip-spend');

        await s.Card.setPeriod(Object.assign(new FakeEl(), { dataset: { period: 'month' } }));
        assert.deepEqual(plain(asked), ['month']);
        assert.match(region.innerHTML, /data-period="month"[^>]*aria-pressed="true"/);
        await s.Card.setPeriod(Object.assign(new FakeEl(), { dataset: { period: 'month' } }));
        assert.equal(asked.length, 1, 'already showing it');

        s.api.getAiUsage = () => Promise.reject(new Error('HTTP 500'));
        await s.Card.setPeriod(Object.assign(new FakeEl(), { dataset: { period: 'day' } }));
        assert.ok(region.innerHTML.includes(s.t('ops.ai.spend.failed', { message: 'HTTP 500' })), 'the totals from the settings stay, the breakdown says why it is gone');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Loading, and the old Gemini card inside it
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('AI providers card — loading', () => {
    it('reads the settings, the Gemini status and the spend side by side, each keeping its own failure', async () => {
        const s = load();
        s.api.getAdminAi = () => Promise.reject(new Error('The database is missing migration v34.'));
        s.api.getGeminiKey = () => Promise.resolve(GEMINI_SAVED);
        s.api.getAiUsage = () => Promise.reject(new Error('HTTP 500'));
        await s.Card.load();
        assert.equal(s.Card.ai, null);
        assert.equal(s.Card.aiError.message, 'The database is missing migration v34.');
        assert.deepEqual({ ...s.Card.gemini }, GEMINI_SAVED);
        assert.equal(s.Card.usageError.message, 'HTTP 500');
    });

    it('still offers the Gemini key when the AI settings cannot be read, with the reason and a Retry', async () => {
        const s = load();
        s.api.getAdminAi = () => Promise.reject(new Error('The database is missing migration v34.'));
        s.api.getGeminiKey = () => Promise.resolve(GEMINI_SAVED);
        s.api.getAiUsage = () => Promise.reject(new Error('HTTP 500'));
        await s.Card.load();
        const markup = String(s.Card.renderSection());
        assert.ok(markup.includes(s.t('ops.ai.loadFailed', { message: 'The database is missing migration v34.' })));
        assert.ok(markup.includes('data-action="aip:reload"'));
        assert.ok(markup.includes('id="gemini-key-form"') && markup.includes('data-action="aip:removeGeminiKey"'), 'the DM bot\'s key is still there to change');
        assert.equal(markup.includes('id="aip-routing"'), false, 'and nothing that needs the settings is drawn');
    });

    it('grows from the Gemini row to the whole card when a key save finds the settings readable again', async () => {
        const s = load();
        s.Card.ai = null;
        s.Card.gemini = GEMINI_SAVED;
        s.Card.aiError = new Error('down');
        s.api.saveGeminiKey = () => Promise.resolve({ ...GEMINI_SAVED, quotaSpent: [] });
        s.api.getGeminiKey = () => Promise.resolve(GEMINI_SAVED);
        s.api.getAdminAi = () => Promise.resolve(aiView());
        const body = s.el('aip-body');
        await s.Card.saveGeminiKey(fakeForm({ values: { apiKey: 'AIzaSyD-pasted-0123456789' } }), event);
        assert.ok(body.innerHTML.includes('id="aip-routing"'));
    });

    it('still draws the rest of Operations when only the AI settings fail', async () => {
        const s = load();
        s.api.getAdminOps = () => Promise.resolve({ tenants: [] });
        s.api.getAdminAi = () => Promise.reject(new Error('HTTP 500'));
        s.api.getGeminiKey = () => Promise.resolve({ source: 'env', preview: null, envFallback: true });
        s.api.getAiUsage = () => Promise.reject(new Error('HTTP 500'));
        await s.Ops.render();
        const page = String(s.container.innerHTML);
        assert.ok(page.includes(s.t('ops.tenantsTitle')));
        assert.ok(page.includes(s.t('ops.ai.loadFailed', { message: 'HTTP 500' })));
        assert.ok(page.includes('id="gemini-key-form"'));
    });

    it('still draws the rest of Operations, and the rest of the card, when only the Gemini key status fails', async () => {
        const s = load();
        s.api.getAdminOps = () => Promise.resolve({ tenants: [] });
        s.api.getAdminAi = () => Promise.resolve(aiView());
        s.api.getGeminiKey = () => Promise.reject(new Error('HTTP 500'));
        s.api.getAiUsage = () => Promise.resolve(usageView());
        await s.Ops.render();
        const page = String(s.container.innerHTML);
        assert.ok(page.includes(s.t('ops.tenantsTitle')));
        assert.ok(page.includes(s.t('ops.gemini.loadFailed', { message: 'HTTP 500' })), 'the Gemini row says why it has no form');
        assert.ok(!page.includes('id="gemini-key-form"'));
        assert.ok(page.includes('id="aip-routing"') && page.includes('id="aip-p-anthropic"'), 'and the other providers are all there');
    });

    it('fetches its module on first use, at the dashboard\'s asset version, and says so when it cannot be fetched', async () => {
        const s = load({ withCard: false });
        s.api.getAdminOps = () => Promise.resolve({ tenants: [] });
        const render = s.Ops.render();
        await settle();
        const script = s.appended.find((n) => String(n.src).includes('ai_providers.js'))!;
        assert.equal(script.src, `/dashboard/js/pages/ai_providers.js?v=${s.App.ASSET_VERSION}`, 'the same ?v= as every other asset, so one bump busts them all');
        (script.onerror as () => void)();
        await render;
        const page = String(s.container.innerHTML);
        assert.ok(page.includes(s.t('ops.ai.moduleFailed')), 'the section says why it is empty');
        assert.ok(page.includes(s.t('ops.tenantsTitle')), 'and the rest of the page is there');
        assert.ok(page.includes('data-action="ops:render"'), 'with a Retry that fetches again');

        // A failed fetch is not remembered: the retry asks again, and this time it arrives.
        s.api.getAdminAi = () => Promise.resolve(aiView());
        s.api.getGeminiKey = () => Promise.resolve(GEMINI_SAVED);
        s.api.getAiUsage = () => Promise.resolve(usageView());
        const again = s.Ops.render();
        await settle();
        const second = s.appended.filter((n) => String(n.src).includes('ai_providers.js'));
        assert.equal(second.length, 2);
        vm.runInContext(readFileSync('dashboard/js/pages/ai_providers.js', 'utf8'), s.ctx, { filename: 'dashboard/js/pages/ai_providers.js' });
        (second[1]!.onload as () => void)();
        await again;
        assert.ok(String(s.container.innerHTML).includes('id="aip-routing"'));
    });

    it('is not in the shell: index.html preloads it for Operations only, and loads no page module as a script', () => {
        const index = readFileSync('dashboard/index.html', 'utf8');
        assert.equal(/<script[^>]*src="[^"]*ai_providers\.js/.test(index), false);
        assert.ok(/page === 'operations'\) preload\('\/dashboard\/js\/pages\/ai_providers\.js\?v=/.test(index));
    });

    it('is a registered module that is not a route, for admins only, and forgets everything when the tenant changes', async () => {
        const s = loaded();
        const entry = s.App.pages.ai_providers;
        assert.deepEqual({ src: entry.src, routable: entry.routable, adminOnly: entry.adminOnly }, { src: 'ai_providers', routable: false, adminOnly: true });
        s.ctx.location.hash = '#/ai_providers';
        assert.equal(s.App.pageFromHash(), 'overview', 'an address cannot open it as a page');
        s.Card.geminiNotice = ['gemini-2.5-flash'];
        s.Card.tests.tenant_studio = { ok: true };
        s.App.resetTenantState();
        assert.equal(s.Card.ai, null);
        assert.equal(s.Card.gemini, null);
        assert.equal(s.Card.geminiNotice, null);
        assert.deepEqual(Object.keys(s.Card.tests), []);
    });
});

describe('AI providers card — the Gemini key, as the old card had it', () => {
    const geminiStatus = (over: Json = {}) => ({ source: 'database', preview: 'AIz•••••••••••••89', envFallback: true, ...over });

    it('names the saved key by its masked hint, and offers to remove it', () => {
        const { Card, t } = loaded();
        const markup = String(Card.renderGeminiKey());
        assert.ok(markup.includes(t('ops.gemini.fromDatabase')));
        // Isolated: a Latin hint inside Arabic copy reorders around its bullets otherwise.
        assert.ok(markup.includes(`<bdi class="ltr-text" dir="ltr">${GEMINI_SAVED.preview}</bdi>`));
        assert.ok(markup.includes('data-action="aip:removeGeminiKey"'));
        // The field only ever takes a new key: never prefilled, and masked while typed.
        const input = markup.match(/<input[^>]*id="gemini-key-input"[^>]*>/)?.[0] ?? '';
        assert.match(input, /type="password"/);
        assert.match(input, /autocomplete="new-password"/);
        assert.doesNotMatch(input, /\svalue=/);
    });

    it('sits in the Gemini provider row, with the note that its key is the DM bot\'s and the Studio\'s', () => {
        const { Card, t } = loaded();
        const row = String(Card.providerInner(Card.provider('gemini')));
        assert.ok(row.includes('id="gemini-key-form"') && row.includes(t('ops.ai.geminiShared')));
        assert.ok(row.includes('data-submit="aip:saveGeminiKey"'), 'saved through the route that checks the DM bot\'s models');
        assert.ok(!String(Card.providerInner(Card.provider('openai'))).includes('gemini-key-form'));
    });

    it('says the server\'s key is answering, with nothing saved to remove', () => {
        const { Card, t } = loaded({}, { gemini: geminiStatus({ source: 'env', preview: null }) });
        const markup = String(Card.renderGeminiKey());
        assert.ok(markup.includes(t('ops.gemini.fromEnv')));
        assert.ok(!markup.includes('aip:removeGeminiKey'));
    });

    it('reads as an outage when there is no key at all', () => {
        const { Card, t } = loaded({}, { gemini: geminiStatus({ source: null, preview: null, envFallback: false }) });
        const markup = String(Card.renderGeminiKey());
        assert.ok(markup.includes('role="alert"'));
        assert.ok(markup.includes(t('ops.gemini.none')));
    });

    it('says the status could not be read, rather than drawing an empty form', () => {
        const { Card, t } = loaded({}, { gemini: null });
        Card.geminiError = new Error('HTTP 500');
        const markup = String(Card.renderGeminiKey());
        assert.ok(markup.includes(t('ops.gemini.loadFailed', { message: 'HTTP 500' })));
        assert.ok(!markup.includes('gemini-key-form'));
    });

    it('sends the pasted key once, trimmed, and re-reads, so the field is empty again', async () => {
        const s = loaded();
        const sent: unknown[] = [];
        let reads = 0;
        s.api.saveGeminiKey = (key) => { sent.push(key); return Promise.resolve({ ...GEMINI_SAVED, quotaSpent: [] }); };
        s.api.getGeminiKey = () => { reads += 1; return Promise.resolve(GEMINI_SAVED); };
        s.api.getAdminAi = () => Promise.resolve(aiView());
        const field = new FakeEl();
        field.value = 'AIzaSyD-pasted-0123456789';
        const form = fakeForm({ values: { apiKey: '  AIzaSyD-pasted-0123456789\n' }, controls: { 'input[name="apiKey"]': field } });
        s.el('aip-p-gemini');

        await s.Card.saveGeminiKey(form, event);

        assert.deepEqual(sent, ['AIzaSyD-pasted-0123456789']);
        assert.equal(reads, 1, 'the status is read again from its own route');
        assert.equal(field.value, '');
        assert.deepEqual(s.toasts, [{ message: s.t('ops.gemini.saved'), type: 'success' }]);
        assert.equal(s.Card.geminiNotice, null, 'nothing to warn about');
        assert.ok(!s.painted().includes('AIzaSyD-pasted'), 'the key is in no region');
    });

    it('does not send a blank paste, or a second one while the first is in flight', async () => {
        const { Card, api } = loaded();
        let calls = 0;
        api.saveGeminiKey = () => { calls += 1; return new Promise(() => {}); };

        await Card.saveGeminiKey(fakeForm({ values: { apiKey: '   ' } }), event);
        const form = fakeForm({ values: { apiKey: 'AIzaSyD-pasted-0123456789' } });
        void Card.saveGeminiKey(form, event);
        await Card.saveGeminiKey(form, event);

        assert.equal(calls, 1);
    });

    it('keeps a spent-quota caveat in the card, with the models isolated', async () => {
        const s = loaded();
        s.api.saveGeminiKey = () => Promise.resolve({ ...GEMINI_SAVED, quotaSpent: ['gemini-2.5-flash'] });
        s.api.getGeminiKey = () => Promise.resolve(GEMINI_SAVED);
        s.api.getAdminAi = () => Promise.resolve(aiView());
        const region = s.el('aip-p-gemini');

        await s.Card.saveGeminiKey(fakeForm({ values: { apiKey: 'AIzaSyD-pasted-0123456789' } }), event);
        assert.deepEqual([...s.Card.geminiNotice], ['gemini-2.5-flash']);
        assert.ok(region.innerHTML.includes(s.t('ops.gemini.quotaSpent')), 'in the repainted row, not only in a toast');
        assert.match(region.innerHTML, /<bdi[^>]*dir="ltr"[^>]*>gemini-2\.5-flash<\/bdi>/);

        const markup = String(s.Card.renderGeminiKey(['x-model']));
        assert.match(markup, /<bdi[^>]*dir="ltr"[^>]*>x-model<\/bdi>/, 'an explicit notice wins');
    });

    it('shows Google\'s refusal and keeps the paste, so a typo can be fixed', async () => {
        const s = loaded();
        s.api.saveGeminiKey = () => Promise.reject(new Error('Google refused this key: API key not valid.'));
        const field = new FakeEl();
        field.value = 'AIzaSyD-typo-0123456789';
        const form = fakeForm({ values: { apiKey: 'AIzaSyD-typo-0123456789' }, controls: { 'input[name="apiKey"]': field } });
        const region = s.el('aip-p-gemini');

        await s.Card.saveGeminiKey(form, event);

        assert.equal(region.innerHTML, '', 'no repaint, which would drop the paste');
        assert.equal(field.value, 'AIzaSyD-typo-0123456789');
        assert.equal(form.submit.disabled, false, 'and the button works again');
        assert.deepEqual(s.toasts, [{ message: 'Google refused this key: API key not valid.', type: 'error' }]);
    });

    it('asks before removing, and says the server\'s key takes over', () => {
        const { Card, confirms, t } = loaded();
        Card.removeGeminiKey();
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.body, t('ops.gemini.removeBodyEnv'));
    });

    it('warns that removing leaves no key at all when the server has none, and removes through the old route', async () => {
        const s = loaded({}, { gemini: geminiStatus({ envFallback: false }) });
        s.Card.removeGeminiKey();
        assert.equal(s.confirms[0]!.body, s.t('ops.gemini.removeBodyNone'));

        s.el('aip-p-gemini');
        let removed = 0;
        s.api.removeGeminiKey = () => { removed += 1; return Promise.resolve({ source: null, preview: null, envFallback: false }); };
        s.api.getGeminiKey = () => Promise.resolve({ source: null, preview: null, envFallback: false });
        s.api.getAdminAi = () => Promise.resolve(aiView());
        await (s.confirms[0]!.onConfirm as () => Promise<void>)();
        assert.equal(removed, 1);
        assert.deepEqual(s.toasts, [{ message: s.t('ops.gemini.removed'), type: 'success' }]);
        assert.ok(s.el('aip-p-gemini').innerHTML.includes(s.t('ops.gemini.none')), 'the row now reads as the outage it is');
    });

    it('reads in English too', () => {
        const s = loaded();
        s.I18N.lang = 'en';
        s.Card.gemini = geminiStatus({ source: 'env', preview: null });
        const markup = String(s.Card.renderGeminiKey());
        assert.ok(markup.includes('In use: the server’s key, GEMINI_API_KEY.'));
        assert.equal(s.t('ops.gemini.save'), 'Check and save');
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Nothing from the server is written as markup
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The markup with every quoted attribute value emptied: what is left shows only the tags and the attribute NAMES a browser would act on. */
const withoutValues = (markup: string): string => markup.replace(/="[^"]*"/g, '=""');

describe('AI providers card — escaping (nothing from the server is written as markup)', () => {
    /**
     * A distinct hostile value for each place the card draws something it was told. Half break out of an element, half out of a quoted
     * attribute; each names its place, so a failure says which one escaped.
     */
    const element = (place: string) => `<img src=x onerror=alert('${place}')>`;
    const attribute = (place: string) => `"><svg onload=alert('${place}')>`;
    const PLACES = {
        providerLabel: element('providerLabel'),
        defaultModel: attribute('defaultModel'),
        suggestedModel: element('suggestedModel'),
        baseUrl: attribute('baseUrl'),
        savedModel: attribute('savedModel'),
        resolvedModel: element('resolvedModel'),
        resolvedKind: element('resolvedKind'),
        resolvedMessage: element('resolvedMessage'),
        priceModel: attribute('priceModel'),
        unpricedModel: element('unpricedModel'),
        spendPurpose: element('spendPurpose'),
        spendProvider: element('spendProvider'),
        tenantName: element('tenantName'),
        geminiPreview: element('geminiPreview'),
        geminiNotice: element('geminiNotice'),
        listedModel: attribute('listedModel'),
        modelsError: element('modelsError'),
        checkKind: element('checkKind'),
        checkMessage: element('checkMessage'),
        checkWarning: element('checkWarning'),
        testKind: element('testKind'),
        testMessage: element('testMessage'),
        testProvider: element('testProvider'),
        testModel: element('testModel'),
    };

    /** A card with a hostile string in every place the server (or a provider, or a tenant) can put one. */
    function hostileCard() {
        const s = loaded({ keys: { anthropic: { source: 'database', key: KEY('ant1') } } });
        const ai = s.Card.ai as Json;
        ai.providers[0].label = PLACES.providerLabel;
        ai.providers[0].defaultModel = PLACES.defaultModel;
        ai.providers[0].defaultModelSource = 'setting';
        ai.providers[0].suggestedModels = [PLACES.suggestedModel];
        ai.providers.find((p: Json) => p.id === 'custom').baseUrl = PLACES.baseUrl;
        ai.purposes[0].saved = { provider: 'anthropic', model: PLACES.savedModel, effort: 'high' };
        ai.purposes[1].resolved = { provider: 'anthropic', model: PLACES.resolvedModel, effort: 'high', source: 'saved' };
        ai.purposes[2].resolved = { error: { kind: PLACES.resolvedKind, message: PLACES.resolvedMessage } };
        ai.prices = [{ model: PLACES.priceModel, in: 1, out: 2, source: 'custom' }];
        ai.warnings = [{ code: 'unpriced_model', detail: [PLACES.unpricedModel] }];
        s.Card.usage = usageView({
            byPurpose: [{ purpose: PLACES.spendPurpose, provider: PLACES.spendProvider, calls: 1, failed: 0, usd: 1, tokensIn: 1, tokensOut: 1 }],
            byTenant: [{ creatorId: 'c-9', name: PLACES.tenantName, calls: 1, usd: 1 }],
        });
        s.Card.gemini = { source: 'database', preview: PLACES.geminiPreview, envFallback: true };
        s.Card.geminiNotice = [PLACES.geminiNotice];
        s.Card.models.anthropic = { status: 'ready', list: [PLACES.listedModel], truncated: false, message: '' };
        s.Card.models.openai = { status: 'error', list: [], truncated: false, message: PLACES.modelsError };
        s.Card.checks.anthropic = { ok: false, error: { kind: PLACES.checkKind, message: PLACES.checkMessage } };
        s.Card.checks.openai = { ok: true, elapsedMs: 5, warning: PLACES.checkWarning };
        s.Card.tests.onboarding_draft = { ok: false, error: { kind: PLACES.testKind, message: PLACES.testMessage } };
        s.Card.tests.onboarding_proof = { ok: true, provider: PLACES.testProvider, model: PLACES.testModel, usd: 1, elapsedMs: 5 };
        return s;
    }

    it('escapes a hostile string in every place the card draws one: none is a live tag, and each is there, as text', () => {
        const s = hostileCard();
        const markup = String(s.Card.renderSection()) + String(s.Card.datalists());
        assert.doesNotMatch(markup, /<img\b|<svg\b|<script\b/i, 'no tag came out of a value');
        assert.doesNotMatch(withoutValues(markup), /<[a-z][^>]*\son(?:error|load)\s*=/i, 'no value became an event handler');
        for (const [place, payload] of Object.entries(PLACES)) {
            assert.ok(markup.includes(s.esc(payload)), `${place}: drawn, as escaped text`);
            assert.equal(markup.includes(payload), false, `${place}: never drawn raw`);
        }
    });

    it('escapes the same strings when a region is repainted rather than rendered with the page', () => {
        const s = hostileCard();
        const regions = ['aip-warnings', 'aip-p-anthropic', 'aip-p-openai', 'aip-p-gemini', 'aip-p-custom', 'aip-prices', 'aip-budgets', 'aip-spend', 'aip-datalists'];
        for (const id of regions) s.el(id);
        for (const purpose of ['onboarding_draft', 'onboarding_proof', 'tenant_studio']) { s.el(`aip-r-${purpose}`); s.el(`aip-now-${purpose}`); s.el(`aip-t-${purpose}`); }
        s.Card.paintWarnings();
        for (const id of ['anthropic', 'openai', 'gemini', 'custom']) s.Card.paintProvider(id);
        for (const purpose of ['onboarding_draft', 'onboarding_proof', 'tenant_studio']) { s.Card.paintRoute(purpose); s.Card.paintNow(); }
        s.Card.paintPrices();
        s.Card.paintBudgets();
        s.Card.paintSpend();
        s.Card.paintDatalists();
        const painted = s.painted();
        assert.doesNotMatch(painted, /<img\b|<svg\b|<script\b/i);
        assert.doesNotMatch(withoutValues(painted), /<[a-z][^>]*\son(?:error|load)\s*=/i);
        assert.ok(painted.includes(s.esc(PLACES.savedModel)) && painted.includes(s.esc(PLACES.listedModel)) && painted.includes(s.esc(PLACES.tenantName)) && painted.includes(s.esc(PLACES.priceModel)));
    });

    it('escapes what the unloaded card says: a database error, and the Gemini status error', () => {
        const s = load();
        s.Card.aiError = new Error(element('aiError'));
        s.Card.geminiError = new Error(attribute('geminiError'));
        s.Card.gemini = null;
        const markup = String(s.Card.renderSection());
        assert.doesNotMatch(markup, /<img\b|<svg\b/i);
        assert.ok(markup.includes(s.esc(element('aiError'))) && markup.includes(s.esc(attribute('geminiError'))));
    });

    it('writes the values it puts in a form field or a data attribute as attribute text, which cannot close the attribute', () => {
        const s = hostileCard();
        const markup = String(s.Card.renderSection());
        // The saved model, the default model and the base URL are `value=`; a price row's model is `data-model=`.
        for (const payload of [PLACES.savedModel, PLACES.defaultModel, PLACES.baseUrl]) assert.ok(markup.includes(`value="${s.esc(payload)}"`), payload);
        assert.ok(markup.includes(`data-model="${s.esc(PLACES.priceModel)}"`));
        assert.doesNotMatch(markup, /value="[^"]*"><svg/);
    });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Both languages
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('AI providers card — interface copy in Arabic and English', () => {
    const s = load();
    const strings = s.I18N.strings as Record<'ar' | 'en', Record<string, string>>;
    const source = ['dashboard/js/pages/ai_providers.js', 'dashboard/js/pages/operations.js'].map((f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).join('\n');

    /** Every key the card can ask for: the ones written out, and the families it builds from a closed list. */
    const used = (): Set<string> => {
        const keys = new Set<string>([...source.matchAll(/'(ops\.ai\.[A-Za-z0-9_.]+)'/g)].map((m) => m[1]!));
        for (const kind of ['saved', 'env', 'none', 'optional']) keys.add(`ops.ai.badge.${kind}`);
        for (const state of ['ready', 'off', 'nokey', 'nourl']) keys.add(`ops.ai.state.${state}`);
        for (const effort of s.View.EFFORTS as string[]) keys.add(`ops.ai.effort.${effort}`);
        for (const purpose of s.View.KNOWN_PURPOSES as string[]) {
            keys.add(`ops.ai.purpose.${purpose}`);
            // `key_test` and `eval` only label spend: they are not routes, so they have a name and no hint.
            if (purpose !== 'key_test' && purpose !== 'eval') keys.add(`ops.ai.purpose.${purpose}.hint`);
        }
        for (const name of s.View.BUDGETS as string[]) keys.add(`ops.ai.budget.${name}`);
        for (const code of ['no_credit', 'no_model_list']) keys.add(`ops.ai.warning.${code}`);
        return keys;
    };

    it('has every string the card asks for, in both languages', () => {
        const missing: string[] = [];
        for (const key of used()) for (const lang of ['ar', 'en'] as const) if (strings[lang][key] === undefined) missing.push(`${lang}: ${key}`);
        assert.deepEqual(missing, []);
        assert.ok(used().size > 120, `${used().size} keys found`);
    });

    it('has no string the card never asks for (a dead string is copy nobody reads and somebody translates)', () => {
        const wanted = used();
        const extra = Object.keys(strings.en).filter((k) => k.startsWith('ops.ai.') && !wanted.has(k));
        assert.deepEqual(extra, []);
        assert.deepEqual(Object.keys(strings.ar).filter((k) => k.startsWith('ops.ai.')).sort(), Object.keys(strings.en).filter((k) => k.startsWith('ops.ai.')).sort(), 'the two languages hold the same keys');
    });

    it('translates rather than copies: the Arabic is Arabic, apart from the strings that are only names', () => {
        const untranslated = Object.keys(strings.en)
            .filter((k) => k.startsWith('ops.ai.'))
            .filter((k) => !/[؀-ۿ]/.test(strings.ar[k] ?? ''));
        assert.deepEqual(untranslated, []);
    });

    it('promises no fallback between providers, in either language: a route whose provider fails, fails', () => {
        assert.match(strings.en['ops.ai.routingHint']!, /no fallback between providers/i);
        assert.match(strings.ar['ops.ai.routingHint']!, /لا بديل بين المزوّدين/);
    });
});
