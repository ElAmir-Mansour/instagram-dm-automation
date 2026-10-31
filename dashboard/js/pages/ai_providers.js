/**
 * AI providers — the card on Operations (P20d; docs/onboarding/06-ai-providers.md §2, "The 'AI providers' card").
 *
 * Platform admin only, because the screen that hosts it is. It is the one place the operator's AI keys, routes, prices and budgets
 * are edited, and it absorbs the Gemini key card that used to sit on its own under the tenant cards: Gemini is one provider row
 * here, and its key still goes to the old route (`PUT /api/admin/gemini-key`), which checks it against the DM bot's models before
 * saving. The other four providers save through `PUT /api/admin/ai/keys/:provider`, which checks the key with the provider.
 *
 *   providers   status (saved ••••1234 / the server's / none), paste a key, Check, Load models, Remove, the on/off switch,
 *               the default model, and for Custom the base URL and JSON mode
 *   routing     one row per purpose: provider, model (free text, with the provider's model list as suggestions), effort,
 *               Save, and Test, which sends one tiny structured call down the SAVED route
 *   prices      per-model overrides (US dollars per million tokens), optional
 *   budgets     platform and per-tenant, per day and per month; empty is no limit
 *   spend       today and this month, by purpose and by tenant
 *
 * ─── Three rules this file keeps ───────────────────────────────────────────
 *   - **A key is only ever sent.** No response carries one, so there is nothing to prefill: the status says which key answers and,
 *     for a saved one, its last four characters. The password field is empty on every paint and is emptied again after a save.
 *   - **Nothing from the server is written as markup.** Every value (a model name from a provider's list, a tenant's name, an
 *     error message a provider wrote) goes through the `html` tag, which escapes it. `html.raw` appears only on literals written
 *     here. src/dashboard/ai-providers.test.ts renders hostile strings through every region and looks for a live tag.
 *   - **The Gemini key outlives the rest of the card.** `GET /api/admin/ai` needs migration v34 and a working database; the DM
 *     bot's key must not depend on either. So Gemini's status comes from `GET /api/admin/gemini-key`, as it always did, and when
 *     the AI settings fail to load the card says so and still shows the Gemini key form.
 *
 * ─── Painting ──────────────────────────────────────────────────────────────
 * The page paints the card once, as a set of regions with stable ids. An action repaints only the regions it changed, so a key
 * half-pasted into one provider's field survives saving another's. Focus survives a repaint the way the rest of the dashboard's
 * does (UI.captureFocus / UI.restoreFocus).
 *
 * `AiProvidersView` holds everything the card decides and that needs no DOM (formatting, the masking line, the route table, the
 * request bodies), so a test can ask it directly. `AiProviders` is the rest.
 */

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Pure: no DOM, no network, no `t()`.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const AiProvidersView = {
    EFFORTS: ['low', 'medium', 'high', 'xhigh', 'max'],
    BUDGETS: ['dailyUsd', 'monthlyUsd', 'tenantDailyUsd', 'tenantMonthlyUsd'],
    /** What `ai_usage.purpose` can say that is not a purpose: the operator pressing Check or Test. */
    KEY_TEST: 'key_test',
    /** The same bound the server enforces (src/services/aiProviders/settings.ts MAX_BUDGET_USD / MAX_PRICE_PER_MTOK). */
    MAX_BUDGET_USD: 1000000,
    MAX_PRICE_PER_MTOK: 10000,
    /** The server's model-id rule (settings.ts MODEL_ID): the card refuses what the server would, before the round trip. */
    MODEL_ID: /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/,
    /** How many of a provider's models are put in the suggestion list: a datalist of thousands is a slow page, not a help. */
    MODELS_SHOWN: 500,

    /** The environment variable each provider's key falls back to (settings.ts PROVIDER_KEY_ENV). */
    KEY_ENV: Object.assign(Object.create(null), {
        anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY',
        meta: 'META_MODEL_API_KEY', baseten: 'BASETEN_API_KEY',
    }),

    /**
     * The purposes the interface has words for; any other (a newer server's) is shown as its own name. The last three are not routes:
     * `key_test` (Check and Test), `eval` (a run of the DM evaluation harness) and `perception_voice` (a voice note heard by Meta's speech model)
     * only label spend, so they have a name and no hint.
     */
    KNOWN_PURPOSES: ['onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm', 'dm_whatsapp', 'ads_draft', 'ads_review',
        'perception_dm', 'recall', 'reel_index', 'comment_intent', 'key_test', 'eval', 'perception_voice'],

    // ─── Numbers ──────────────────────────────────────────────────────────────────────────

    /** A number in the interface's locale, with a fixed range of fraction digits. */
    number(n, min, max, locale) {
        try {
            return n.toLocaleString(locale || I18N.locale(), { minimumFractionDigits: min, maximumFractionDigits: max });
        } catch {
            return n.toFixed(max);
        }
    },

    /**
     * Money as a spend figure: "$0", "<$0.0001", "$0.0004", "$0.50", "$1,234.57". Calls cost fractions of a cent, so a figure under
     * a dollar keeps four digits; a larger one keeps cents. Not a number (a missing field) is a dash, never "$NaN".
     */
    usd(value, locale) {
        const n = Number(value);
        if (value === null || value === undefined || !Number.isFinite(n)) return '—';
        if (n === 0) return '$0';
        const abs = Math.abs(n);
        if (abs < 0.0001) return n > 0 ? '<$0.0001' : '>-$0.0001';
        const text = AiProvidersView.number(abs, 2, abs < 1 ? 4 : 2, locale);
        return `${n < 0 ? '-' : ''}$${text}`;
    },

    /** A price per million tokens: "$4", "$0.10", "$1.5" is shown "$1.50". Whole dollars carry no decimals. */
    rate(value, locale) {
        const n = Number(value);
        if (value === null || value === undefined || !Number.isFinite(n)) return '—';
        return `$${Number.isInteger(n) ? AiProvidersView.number(n, 0, 0, locale) : AiProvidersView.number(n, 2, 4, locale)}`;
    },

    /** How long a call took: "340 ms", "1.4 s". */
    duration(ms, locale) {
        const n = Number(ms);
        if (ms === null || ms === undefined || !Number.isFinite(n) || n < 0) return '—';
        return n < 1000 ? `${AiProvidersView.number(Math.round(n), 0, 0, locale)} ms` : `${AiProvidersView.number(n / 1000, 1, 1, locale)} s`;
    },

    /**
     * What a money box holds, as typed: "" is no limit (null), "12", "12.5" and the Arabic spellings "١٢٫٥" and "12,5" are numbers.
     * `{ok: false}` for anything else, and for a negative or absurd figure the server would refuse.
     */
    parseMoney(text, max) {
        const ceiling = max === undefined ? AiProvidersView.MAX_BUDGET_USD : max;
        const raw = String(text === null || text === undefined ? '' : text).trim();
        if (raw === '') return { ok: true, value: null };
        const latin = raw
            .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
            .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
            .replace(/[٫٬,،]/g, '.')
            .replace(/\s+/g, '');
        if (!/^\d+(?:\.\d+)?$/.test(latin)) return { ok: false, reason: 'format' };
        const value = Number(latin);
        if (!Number.isFinite(value) || value > ceiling) return { ok: false, reason: 'range' };
        return { ok: true, value };
    },

    /** A saved limit as the box shows it: empty for none, otherwise the plain number (no grouping, so it can be edited). */
    moneyInput(value) {
        return value === null || value === undefined || !Number.isFinite(Number(value)) ? '' : String(Number(value));
    },

    // ─── Providers ────────────────────────────────────────────────────────────────────────

    /**
     * What the status chip says about a key: `saved` (with its last four characters, which are all the server ever sends), `env` (the
     * deployment's variable answers), `none` (a provider that needs one has none) or `optional` (Custom may run without).
     */
    keyBadge(provider) {
        const key = (provider && provider.key) || {};
        if (key.set && key.source === 'database') return { kind: 'saved', tone: 'success', last4: key.last4 ? String(key.last4) : null };
        if (key.set) return { kind: 'env', tone: 'info', last4: null };
        return provider && provider.keyRequired === false
            ? { kind: 'optional', tone: 'neutral', last4: null }
            : { kind: 'none', tone: 'warning', last4: null };
    },

    /**
     * The key as the card draws it: bullets and the last four. Never longer than that, and never anything but what the server sent.
     * `null` for a key with nothing to show (the environment's, or none).
     */
    maskedKey(last4) {
        const tail = String(last4 === null || last4 === undefined ? '' : last4).replace(/[^\x20-\x7e]/g, '').slice(-4);
        return tail ? `••••${tail}` : null;
    },

    /**
     * Whether a provider could answer a call right now, and if not the first reason, in the server's own order (switched off, no key,
     * no base URL). Worked out here from the fields rather than read from the server's English `problem` text.
     */
    providerState(provider) {
        if (!provider) return 'off';
        if (provider.enabled === false) return 'off';
        if (provider.keyRequired !== false && !(provider.key && provider.key.set)) return 'nokey';
        if (provider.id === 'custom' && !provider.baseUrl) return 'nourl';
        return 'ready';
    },

    /** The environment variable a provider's key falls back to, or null. A name the table does not own is never answered. */
    keyEnv(id) {
        return AiProvidersView.KEY_ENV[String(id)] || null;
    },

    /**
     * The model suggestions for one provider's input: its default first, then the registry's suggestions, then whatever "Load models"
     * returned. Distinct, in that order, and bounded.
     */
    modelOptions(provider, loaded) {
        const seen = new Set();
        const out = [];
        const add = (m) => {
            const id = typeof m === 'string' ? m.trim() : '';
            if (!id || seen.has(id) || out.length >= AiProvidersView.MODELS_SHOWN) return;
            seen.add(id);
            out.push(id);
        };
        if (provider) {
            add(provider.defaultModel);
            (Array.isArray(provider.suggestedModels) ? provider.suggestedModels : []).forEach(add);
        }
        (Array.isArray(loaded) ? loaded : []).forEach(add);
        return out;
    },

    /** The warning a key check came back with (`no_credit`, `no_model_list`), as an i18n key, or null for one the card has no words for. */
    warningKey(code) {
        return code === 'no_credit' || code === 'no_model_list' ? `ops.ai.warning.${code}` : null;
    },

    /** The body of `PUT /api/admin/ai` for a provider's switch. */
    enablePatch(id, enabled) {
        return { providers: { [id]: { enabled: !!enabled } } };
    },

    /**
     * The body for saving a provider's defaults, from what the form holds. An empty model clears the default (the registry's answers
     * again); only Custom has a base URL and a JSON mode, so no other provider's body carries them.
     */
    defaultsPatch(provider, values) {
        const model = String((values && values.defaultModel) || '').trim();
        if (model && !AiProvidersView.MODEL_ID.test(model)) return { ok: false, field: 'defaultModel' };
        const entry = { defaultModel: model || null };
        if (provider && provider.id === 'custom') {
            const url = String((values && values.baseUrl) || '').trim();
            entry.baseUrl = url || null;
            entry.jsonMode = values && values.jsonMode === 'object' ? 'object' : 'schema';
        }
        return { ok: true, patch: { providers: { [provider.id]: entry } } };
    },

    // ─── Routing ──────────────────────────────────────────────────────────────────────────

    /**
     * The routing table: one row per purpose, in the server's order, with what the form starts at. A purpose with no saved route
     * starts on "Automatic" (the first provider with a key answers) and the purpose's own effort.
     */
    routeRows(ai) {
        const purposes = ai && Array.isArray(ai.purposes) ? ai.purposes : [];
        return purposes.map((p) => ({
            purpose: p.purpose,
            defaultEffort: p.defaultEffort,
            macBrainGuarded: !!p.macBrainGuarded,
            saved: p.saved || null,
            resolved: p.resolved || null,
            selected: p.saved
                ? { provider: p.saved.provider, model: p.saved.model || '', effort: p.saved.effort }
                : { provider: '', model: '', effort: p.defaultEffort },
        }));
    },

    /** Whether the form differs from what is saved. Automatic is the saved state of a purpose with no route. */
    routeDirty(saved, values) {
        const provider = String((values && values.provider) || '');
        if (!saved) return provider !== '';
        return provider !== saved.provider
            || String((values && values.model) || '').trim() !== String(saved.model || '')
            || String((values && values.effort) || '') !== saved.effort;
    },

    /**
     * The body that saves a route. "Automatic" removes the saved route (`null`), which is how a purpose goes back to "the first
     * provider with a key"; otherwise the server gets the provider, the model (empty is the provider's own default) and the effort.
     */
    routePatch(purpose, values) {
        const provider = String((values && values.provider) || '');
        if (!provider) return { ok: true, patch: { routing: { [purpose]: null } } };
        const model = String((values && values.model) || '').trim();
        if (model && !AiProvidersView.MODEL_ID.test(model)) return { ok: false, field: 'model' };
        const effort = AiProvidersView.EFFORTS.includes(values && values.effort) ? values.effort : null;
        if (!effort) return { ok: false, field: 'effort' };
        return { ok: true, patch: { routing: { [purpose]: { provider, model, effort } } } };
    },

    /** A Test or Check answer as the card says it: green or red, with the error's code and the provider's own words. */
    verdict(result) {
        const r = result || {};
        if (r.ok === true) {
            return { ok: true, code: null, message: null, provider: r.provider || null, model: r.model || null,
                elapsedMs: r.elapsedMs === undefined ? null : r.elapsedMs, usd: typeof r.usd === 'number' ? r.usd : null, warning: r.warning || null };
        }
        const error = r.error || {};
        return { ok: false, code: error.kind ? String(error.kind) : 'unknown', message: error.message ? String(error.message) : null,
            provider: r.provider || null, model: r.model || null, elapsedMs: r.elapsedMs === undefined ? null : r.elapsedMs, usd: null, warning: null };
    },

    // ─── Prices ───────────────────────────────────────────────────────────────────────────

    /** The body that saves one price, or the field that is wrong. The model is lower-cased: the server keys prices that way. */
    pricePatch(model, inText, outText) {
        const id = String(model || '').trim().toLowerCase();
        if (!AiProvidersView.MODEL_ID.test(id)) return { ok: false, field: 'model' };
        const input = AiProvidersView.parseMoney(inText, AiProvidersView.MAX_PRICE_PER_MTOK);
        if (!input.ok || input.value === null) return { ok: false, field: 'in' };
        const output = AiProvidersView.parseMoney(outText, AiProvidersView.MAX_PRICE_PER_MTOK);
        if (!output.ok || output.value === null) return { ok: false, field: 'out' };
        return { ok: true, patch: { prices: { [id]: { in: input.value, out: output.value } } } };
    },

    pricesRemovePatch(model) {
        return { prices: { [String(model || '').trim().toLowerCase()]: null } };
    },

    // ─── Budgets ──────────────────────────────────────────────────────────────────────────

    /**
     * The body that saves the budgets: only the boxes that changed, since each one is an audit entry. `{ok: true, patch: null}` when
     * nothing did. A box the server would refuse names itself in `field`.
     */
    budgetsPatch(current, texts) {
        const budgets = {};
        for (const name of AiProvidersView.BUDGETS) {
            const parsed = AiProvidersView.parseMoney(texts && texts[name]);
            if (!parsed.ok) return { ok: false, field: name, reason: parsed.reason };
            const before = current && current[name] !== undefined ? current[name] : null;
            if (parsed.value !== before) budgets[name] = parsed.value;
        }
        return { ok: true, patch: Object.keys(budgets).length ? { budgets } : null };
    },

    // ─── Spend ────────────────────────────────────────────────────────────────────────────

    /** Whether a purpose is one the interface has a name for. */
    knownPurpose(purpose) {
        return AiProvidersView.KNOWN_PURPOSES.includes(String(purpose));
    },

    /**
     * The spend breakdown for one period, biggest first, with the share of the total each row is. Rows with no spend are kept: a
     * purpose that only failed still belongs on the list.
     */
    spendRows(usage) {
        const byPurpose = usage && Array.isArray(usage.byPurpose) ? usage.byPurpose : [];
        const byTenant = usage && Array.isArray(usage.byTenant) ? usage.byTenant : [];
        const total = byPurpose.reduce((sum, r) => sum + (Number(r.usd) || 0), 0);
        const share = (usd) => (total > 0 ? Math.round(((Number(usd) || 0) / total) * 100) : 0);
        const byUsd = (a, b) => (Number(b.usd) || 0) - (Number(a.usd) || 0);
        return {
            total,
            purposes: byPurpose.slice().sort(byUsd).map((r) => ({
                purpose: r.purpose, provider: r.provider, calls: Number(r.calls) || 0, failed: Number(r.failed) || 0,
                usd: Number(r.usd) || 0, share: share(r.usd),
            })),
            tenants: byTenant.slice().sort(byUsd).map((r) => ({
                creatorId: r.creatorId === undefined ? null : r.creatorId, name: r.name === undefined ? null : r.name,
                calls: Number(r.calls) || 0, usd: Number(r.usd) || 0,
            })),
        };
    },
};

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The card.
// ═══════════════════════════════════════════════════════════════════════════════════════════

const AiProviders = {
    /** GET /admin/ai: providers, routes, prices, budgets, warnings, spend. Never a key. */
    ai: null,
    aiError: null,
    /** GET /admin/gemini-key: `{source, preview, envFallback}`. Gemini's status comes from here, so it survives `ai` failing. */
    gemini: null,
    geminiError: null,
    /** Models whose quota the last Gemini save found spent: shown in the card rather than in a toast that is gone in 4.5s. */
    geminiNotice: null,
    /** GET /admin/ai/usage for `usagePeriod`: the totals and the by-purpose / by-tenant breakdown. */
    usage: null,
    usageError: null,
    usagePeriod: 'day',
    /** provider -> { status: 'loading' | 'ready' | 'error', list, truncated, message }: what "Load models" last said. */
    models: Object.create(null),
    /** provider -> the last Check answer; purpose -> the last Test answer. Cleared when what they tested changes. */
    checks: Object.create(null),
    tests: Object.create(null),

    resetTenantState() {
        this.ai = null;
        this.aiError = null;
        this.gemini = null;
        this.geminiError = null;
        this.geminiNotice = null;
        this.usage = null;
        this.usageError = null;
        this.usagePeriod = 'day';
        this.models = Object.create(null);
        this.checks = Object.create(null);
        this.tests = Object.create(null);
    },

    // ─── Loading ──────────────────────────────────────────────────────────────────────────

    /**
     * Fetch everything the card shows. Never rejects: each part keeps its own error, because the Gemini key must stay usable when the
     * AI settings cannot be read (the database behind them may be a migration behind), and the rest of Operations must paint either way.
     */
    async load() {
        this.models = Object.create(null);
        this.checks = Object.create(null);
        this.tests = Object.create(null);
        // Shown once, right after the save that found it; a fresh read of the screen is not that save.
        this.geminiNotice = null;
        const [ai, gemini, usage] = await Promise.allSettled([
            API.getAdminAi(),
            API.getGeminiKey(),
            API.getAiUsage(this.usagePeriod),
        ]);
        this.ai = ai.status === 'fulfilled' ? ai.value : null;
        this.aiError = ai.status === 'rejected' ? ai.reason : null;
        this.gemini = gemini.status === 'fulfilled' ? gemini.value : null;
        this.geminiError = gemini.status === 'rejected' ? gemini.reason : null;
        this.usage = usage.status === 'fulfilled' ? usage.value : null;
        this.usageError = usage.status === 'rejected' ? usage.reason : null;
    },

    /** Fetch the AI settings again after a change, keeping the spend the PUT responses do not carry. */
    async refetchAi() {
        const fresh = await API.getAdminAi();
        this.ai = fresh;
        this.aiError = null;
        return fresh;
    },

    /** A `PUT /admin/ai` answers with the settings but not the spend: lay it over what is held. */
    adopt(view) {
        if (view && typeof view === 'object' && Array.isArray(view.providers)) {
            this.ai = Object.assign({}, this.ai || {}, view);
            this.aiError = null;
        }
    },

    /** A provider id the server listed (or Gemini, whose row exists without the list). Anything else is not acted on. */
    knownProvider(raw) {
        const id = String(raw || '');
        if (id === 'gemini') return id;
        return this.ai && this.ai.providers.some((p) => p.id === id) ? id : null;
    },

    provider(id) {
        if (this.ai) {
            const found = this.ai.providers.find((p) => p.id === id);
            if (found) return found;
        }
        return id === 'gemini' ? this.geminiStub() : null;
    },

    /** Gemini's row when the AI settings did not load: only the key, which is all the old card ever had. */
    geminiStub() {
        const status = this.gemini || {};
        return {
            id: 'gemini', label: 'Google Gemini', family: 'gemini', keyRequired: true,
            key: { set: status.source === 'database' || status.source === 'env', source: status.source || null, last4: null, envFallback: !!status.envFallback },
            enabled: true, defaultModel: '', defaultModelSource: 'code', suggestedModels: [], baseUrl: null, jsonMode: null,
            usable: false, problem: null, sharesDmQuota: true,
        };
    },

    // ─── The section ──────────────────────────────────────────────────────────────────────

    /** The whole card, for the Operations page to place where the Gemini card used to be. */
    renderSection() {
        return html`
            <section class="section" id="aip-section">
                <h2 class="section-title">${t('ops.ai.title')}</h2>
                <div class="surface pad-5 stack gap-5">
                    <p class="form-hint aip-lede">${t('ops.ai.intro')} ${UI.helpLink('ai-usage', t('help.link.aiUsage'))}</p>
                    <div id="aip-body" class="stack gap-5">${this.body()}</div>
                </div>
            </section>
        `;
    },

    /** The card's contents: everything when the AI settings loaded, and otherwise the error and the Gemini row. */
    body() {
        return this.ai ? this.renderLoaded() : this.renderUnloaded();
    },

    /** The AI settings could not be read: say so with a retry, and keep the Gemini key where it was. */
    renderUnloaded() {
        const message = this.aiError ? this.aiError.message : '';
        return html`
            <div class="inline-error aip-load-error" role="alert">
                <i data-lucide="alert-circle" aria-hidden="true"></i>
                <div>
                    <strong dir="auto">${t('ops.ai.loadFailed', { message })}</strong>
                    <span class="inline-error-hint">${t('ops.ai.loadFailedHint')}</span>
                </div>
            </div>
            <div class="form-actions aip-actions-flush">
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'rotate-cw', label: t('common.retry'), action: 'aip:reload' })}
            </div>
            <div id="aip-providers" class="aip-providers">
                <article class="aip-provider" id="aip-p-gemini" data-provider="gemini">${this.providerInner(this.geminiStub())}</article>
            </div>
        `;
    },

    renderLoaded() {
        return html`
            <div id="aip-warnings">${this.warnings()}</div>

            <div class="aip-block">
                <h3 class="aip-subtitle">${t('ops.ai.providers')}</h3>
                <p class="form-hint mbe-4">${t('ops.ai.providersHint')}</p>
                <div id="aip-providers" class="aip-providers">
                    ${this.ai.providers.map((p) => html`<article class="aip-provider" id="aip-p-${p.id}" data-provider="${p.id}">${this.providerInner(p)}</article>`)}
                </div>
            </div>

            <div class="aip-block">
                <h3 class="aip-subtitle">${t('ops.ai.routing')}</h3>
                <p class="form-hint mbe-4">${t('ops.ai.routingHint')}</p>
                <div id="aip-routing" class="aip-routes">
                    ${AiProvidersView.routeRows(this.ai).map((row) => html`<div class="aip-route" id="aip-r-${row.purpose}">${this.routeInner(row)}</div>`)}
                </div>
            </div>

            <div class="aip-block" id="aip-prices">${this.pricesInner()}</div>
            <div class="aip-block" id="aip-budgets">${this.budgetsInner()}</div>
            <div class="aip-block" id="aip-spend">${this.spendInner()}</div>

            <div id="aip-datalists" hidden>${this.datalists()}</div>
        `;
    },

    // ─── Painting ─────────────────────────────────────────────────────────────────────────

    /** Replace one region's contents, keeping focus where it was. Returns whether the region is on the page. */
    paint(id, markup) {
        const el = document.getElementById(id);
        if (!el) return false;
        const focus = UI.captureFocus(el);
        el.innerHTML = esc(markup);
        UI.icons(el);
        UI.restoreFocus(focus);
        return true;
    },

    paintWarnings() { this.paint('aip-warnings', this.warnings()); },
    paintProvider(id) { const p = this.provider(id); if (p) this.paint(`aip-p-${id}`, this.providerInner(p)); },
    paintRoute(purpose) {
        const row = AiProvidersView.routeRows(this.ai).find((r) => r.purpose === purpose);
        if (row) this.paint(`aip-r-${purpose}`, this.routeInner(row));
    },
    paintNow() { AiProvidersView.routeRows(this.ai).forEach((row) => this.paint(`aip-now-${row.purpose}`, this.nowLine(row))); },
    paintPrices() { this.paint('aip-prices', this.pricesInner()); },
    paintBudgets() { this.paint('aip-budgets', this.budgetsInner()); },
    paintSpend() { this.paint('aip-spend', this.spendInner()); },
    paintDatalists() { this.paint('aip-datalists', this.datalists()); },

    // ─── Warnings ─────────────────────────────────────────────────────────────────────────

    warnings() {
        const list = this.ai && Array.isArray(this.ai.warnings) ? this.ai.warnings : [];
        const one = (icon, body) => html`
            <div class="warning-card aip-warning">
                <div class="row row--start gap-4">
                    <span class="stat-icon warning shrink-0"><i data-lucide="${icon}" aria-hidden="true"></i></span>
                    <p dir="auto">${body}</p>
                </div>
            </div>
        `;
        return list.map((w) => {
            if (w.code === 'no_budget') return one('shield-alert', t('ops.ai.warn.noBudget'));
            if (w.code === 'gemini_dm_quota') return one('alert-triangle', t('ops.ai.warn.geminiQuota'));
            if (w.code === 'unpriced_model') {
                const models = Array.isArray(w.detail) ? w.detail : [];
                return one('alert-triangle', html`${t('ops.ai.warn.unpriced')} ${models.map((m, i) => html`${i ? ', ' : ''}${UI.ltr(m)}`)}`);
            }
            return '';
        });
    },

    // ─── Providers ────────────────────────────────────────────────────────────────────────

    providerInner(p) {
        const loaded = !!this.ai;
        const state = AiProvidersView.providerState(p);
        const badge = AiProvidersView.keyBadge(p);
        const mask = AiProvidersView.maskedKey(badge.last4);
        const badgeText = t(`ops.ai.badge.${badge.kind}`);
        return html`
            <header class="aip-provider-head">
                <h4 class="aip-provider-name" dir="auto">${p.label}</h4>
                ${loaded ? this.enableSwitch(p) : ''}
            </header>
            <div class="aip-badges">
                <span class="badge badge-${html.raw(badge.tone)}">${badgeText}${mask ? html` <bdi class="ltr-text" dir="ltr">${mask}</bdi>` : ''}</span>
                ${loaded ? html`<span class="badge ${state === 'ready' ? html.raw('badge-success') : html.raw('badge-neutral')}">${t(`ops.ai.state.${state}`)}</span>` : ''}
            </div>
            ${p.id === 'gemini' && loaded ? html`<p class="form-hint">${t('ops.ai.geminiShared')}</p>` : ''}
            ${this.keyBlock(p)}
            ${loaded ? this.providerControls(p) : ''}
        `;
    },

    enableSwitch(p) {
        const on = p.enabled !== false;
        return html`
            <div class="switch-row aip-switch">
                <span class="switch-label" id="aip-enabled-label-${p.id}">${t('ops.ai.enabled')}</span>
                <label class="switch" for="aip-enabled-${p.id}">
                    <span class="sr-only">${t('ops.ai.enabledFor', { name: p.label })}</span>
                    <input type="checkbox" id="aip-enabled-${p.id}" data-change="aip:toggleEnabled" data-provider="${p.id}"
                           aria-labelledby="aip-enabled-label-${p.id}" ${on ? html.raw('checked') : ''}>
                    <span class="switch-track"></span>
                </label>
            </div>
        `;
    },

    /**
     * What the key block of a provider says and where its buttons point. Gemini keeps the old card's words, ids and routes exactly:
     * its form is the one that checks the key against the DM bot's models.
     */
    keyView(p) {
        if (p.id === 'gemini') {
            const status = this.gemini || {};
            return {
                gemini: true,
                source: status.source === 'database' || status.source === 'env' ? status.source : null,
                mask: status.preview || null,
                envFallback: !!status.envFallback,
                formId: 'gemini-key-form', inputId: 'gemini-key-input', hintId: 'gemini-key-hint', submitId: 'gemini-key-submit',
                submit: 'aip:saveGeminiKey', remove: 'aip:removeGeminiKey', provider: 'gemini',
                outageWhenNone: true,
                text: {
                    fromDatabase: t('ops.gemini.fromDatabase'), fromEnv: t('ops.gemini.fromEnv'), none: t('ops.gemini.none'),
                    body: t('ops.gemini.body'), label: t('ops.gemini.label'), hint: t('ops.gemini.hint'),
                    save: t('ops.gemini.save'), remove: t('ops.gemini.remove'),
                },
            };
        }
        const env = AiProvidersView.keyEnv(p.id);
        const source = p.key && p.key.set ? p.key.source : null;
        return {
            gemini: false,
            source,
            // The badge in the header carries the last four characters; the sentence does not say them again.
            mask: null,
            envFallback: !!(p.key && p.key.envFallback),
            formId: `aip-key-form-${p.id}`, inputId: `aip-key-${p.id}`, hintId: `aip-key-hint-${p.id}`, submitId: `aip-key-submit-${p.id}`,
            submit: 'aip:saveKey', remove: 'aip:removeKey', provider: p.id,
            outageWhenNone: p.keyRequired !== false,
            text: {
                fromDatabase: t('ops.ai.key.fromDatabase', { name: p.label }),
                fromEnv: env ? t('ops.ai.key.fromEnv', { env }) : t('ops.ai.key.fromEnvPlain'),
                none: p.keyRequired === false ? t('ops.ai.key.noneOptional') : t('ops.ai.key.none', { name: p.label }),
                body: '',
                label: t('ops.ai.key.label'),
                hint: p.keyRequired === false ? t('ops.ai.key.hintOptional') : t('ops.ai.key.hint', { name: p.label }),
                save: t('ops.ai.key.save'), remove: t('ops.ai.key.remove'),
            },
        };
    },

    /**
     * The status line, the paste form and (for a saved key) the Remove button. The server never sends a key back, so the field has no
     * value to show: the status says which key answers, and the field only ever takes a new one.
     */
    keyBlock(p, notice) {
        if (p.id === 'gemini' && this.geminiError) {
            return html`<p class="form-hint text-warning" dir="auto">${t('ops.gemini.loadFailed', { message: this.geminiError.message })}</p>`;
        }
        if (p.id === 'gemini' && !this.gemini) return html``;
        const v = this.keyView(p);
        // The masked hint stays out of the sentence: Latin inside Arabic copy needs its own <bdi>, or the parentheses and bullets around it reorder.
        const inUse = (text, mask) => html`
            <p class="token-info">
                <i data-lucide="check-circle" class="icon-success" aria-hidden="true"></i>
                <span dir="auto">${text}</span>
                ${mask ? html`<code>${UI.ltr(mask)}</code>` : ''}
            </p>
        `;
        const statusLine = v.source === 'database'
            ? inUse(v.text.fromDatabase, v.mask)
            : v.source === 'env'
                ? inUse(v.text.fromEnv)
                : v.outageWhenNone
                    ? html`
                        <div class="warning-card aip-none" role="alert">
                            <div class="row row--start gap-4">
                                <span class="stat-icon warning shrink-0"><i data-lucide="key-round" aria-hidden="true"></i></span>
                                <p>${v.text.none}</p>
                            </div>
                        </div>
                    `
                    : html`<p class="token-info"><span dir="auto">${v.text.none}</span></p>`;
        const spent = v.gemini ? (notice === undefined ? this.geminiNotice : notice) : null;

        return html`
            <div class="aip-key stack gap-4">
                ${statusLine}
                ${spent && spent.length ? html`<p class="form-hint text-warning">${t('ops.gemini.quotaSpent')} ${UI.ltr(spent.join(', '))}</p>` : ''}
                ${v.text.body ? html`<p class="form-hint">${v.text.body}</p>` : ''}
                <form id="${v.formId}" data-submit="${v.submit}" data-provider="${v.provider}"${v.gemini ? html` aria-label="${t('ops.gemini.title')}"` : ''}>
                    <div class="form-group">
                        <label class="form-label" for="${v.inputId}">${v.text.label}</label>
                        <input class="field field-mono" id="${v.inputId}" name="apiKey" type="password" dir="ltr"
                               autocomplete="new-password" spellcheck="false" autocapitalize="off" required
                               aria-describedby="${v.hintId}">
                        <p class="form-hint" id="${v.hintId}">${v.text.hint}</p>
                    </div>
                    <div class="form-actions">
                        ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'shield-check', label: v.text.save, id: v.submitId })}
                        ${v.source === 'database' ? UI.button({
                            variant: 'secondary', size: 'sm', icon: 'trash-2', label: v.text.remove, action: v.remove, data: { provider: v.provider },
                        }) : ''}
                    </div>
                </form>
            </div>
        `;
    },

    /**
     * The Gemini key block as the standalone card drew it before this card absorbed it: the same status lines, copy, ids and routes.
     * `notice` is the models a save found spent; it defaults to the one kept from the last save.
     */
    renderGeminiKey(notice) {
        return this.keyBlock(this.provider('gemini'), notice);
    },

    /** Check, Load models, the default model (and Custom's endpoint). Only when the AI settings are loaded. */
    providerControls(p) {
        const needsKey = p.keyRequired !== false && !(p.key && p.key.set);
        const needsUrl = p.id === 'custom' && !p.baseUrl;
        const cannot = needsKey || needsUrl;
        return html`
            <div class="form-actions aip-actions">
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'plug-zap', label: t('ops.ai.check'), action: 'aip:check', data: { provider: p.id }, disabled: cannot })}
                ${UI.button({ variant: 'secondary', size: 'sm', icon: 'download', label: t('ops.ai.loadModels'), action: 'aip:loadModels', data: { provider: p.id }, disabled: cannot })}
            </div>
            <p class="aip-result" id="aip-check-${p.id}" role="status" aria-live="polite">${this.checkResult(p.id)}</p>
            <form class="aip-defaults" id="aip-defaults-${p.id}" data-submit="aip:saveDefaults" data-provider="${p.id}">
                ${p.id === 'custom' ? html`
                    <div class="form-group">
                        <label class="form-label" for="aip-url-${p.id}">${t('ops.ai.baseUrl')}</label>
                        <input class="field field-mono" id="aip-url-${p.id}" name="baseUrl" type="url" dir="ltr" autocomplete="off"
                               spellcheck="false" autocapitalize="off" placeholder="https://" value="${p.baseUrl || ''}"
                               aria-describedby="aip-url-hint-${p.id}">
                        <p class="form-hint" id="aip-url-hint-${p.id}">${t('ops.ai.baseUrlHint')}</p>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="aip-json-${p.id}">${t('ops.ai.jsonMode')}</label>
                        <select class="select" id="aip-json-${p.id}" name="jsonMode" aria-describedby="aip-json-hint-${p.id}">
                            <option value="schema" ${p.jsonMode !== 'object' ? html.raw('selected') : ''}>${t('ops.ai.jsonMode.schema')}</option>
                            <option value="object" ${p.jsonMode === 'object' ? html.raw('selected') : ''}>${t('ops.ai.jsonMode.object')}</option>
                        </select>
                        <p class="form-hint" id="aip-json-hint-${p.id}">${t('ops.ai.jsonModeHint')}</p>
                    </div>
                ` : ''}
                <div class="form-group">
                    <label class="form-label" for="aip-model-${p.id}">${t('ops.ai.defaultModel')}</label>
                    <div class="field-row">
                        <input class="field field-mono" id="aip-model-${p.id}" name="defaultModel" type="text" dir="ltr" autocomplete="off"
                               spellcheck="false" autocapitalize="off" list="aip-models-${p.id}"
                               placeholder="${p.id === 'custom' ? '' : p.defaultModel}" value="${p.defaultModelSource === 'setting' ? p.defaultModel : ''}"
                               aria-describedby="aip-models-note-${p.id}">
                        ${p.id === 'custom' ? '' : UI.button({ variant: 'secondary', size: 'sm', type: 'submit', icon: 'save', ariaLabel: t('ops.ai.saveDefault'), title: t('ops.ai.saveDefault') })}
                    </div>
                    <p class="form-hint" id="aip-models-note-${p.id}" aria-live="polite">${this.modelsNote(p.id)}</p>
                </div>
                ${p.id === 'custom' ? html`
                    <div class="form-actions">
                        ${UI.button({ variant: 'secondary', size: 'sm', type: 'submit', icon: 'save', label: t('ops.ai.saveEndpoint') })}
                    </div>
                ` : ''}
            </form>
        `;
    },

    /** The last Check answer for a provider, as a green or red line. */
    checkResult(id) {
        const result = this.checks[id];
        if (!result) return '';
        const v = AiProvidersView.verdict(result);
        if (v.ok) {
            const warning = v.warning ? (AiProvidersView.warningKey(v.warning) ? t(AiProvidersView.warningKey(v.warning)) : v.warning) : '';
            return html`
                <span class="badge badge-success"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('ops.ai.checkOk')}</span>
                <span class="aip-meta">${UI.ltr(AiProvidersView.duration(v.elapsedMs))}</span>
                ${warning ? html`<span class="form-hint text-warning" dir="auto">${warning}</span>` : ''}
            `;
        }
        return html`
            <span class="badge badge-danger"><i data-lucide="alert-circle" aria-hidden="true"></i> ${t('ops.ai.checkFailed')} <code>${v.code}</code></span>
            ${v.message ? html`<span class="aip-error" dir="auto">${v.message}</span>` : ''}
        `;
    },

    /** "N models loaded", the error "Load models" hit, or nothing. */
    modelsNote(id) {
        const m = this.models[id];
        if (!m) return t('ops.ai.defaultModelHint');
        if (m.status === 'loading') return t('ops.ai.modelsLoading');
        if (m.status === 'error') return html`<span class="text-warning" dir="auto">${t('ops.ai.modelsFailed', { message: m.message || '' })}</span>`;
        return t(m.truncated ? 'ops.ai.modelsLoadedMore' : 'ops.ai.modelsLoaded', { count: UI.formatNumber(m.list.length) });
    },

    /** One datalist per provider: the default, the suggestions, and what "Load models" returned. */
    datalists() {
        const providers = this.ai ? this.ai.providers : [];
        return providers.map((p) => html`
            <datalist id="aip-models-${p.id}">${AiProvidersView.modelOptions(p, this.models[p.id] && this.models[p.id].list).map((m) => html`<option value="${m}"></option>`)}</datalist>
        `);
    },

    // ─── Routing ──────────────────────────────────────────────────────────────────────────

    purposeLabel(purpose) {
        return AiProvidersView.knownPurpose(purpose) ? t(`ops.ai.purpose.${purpose}`) : String(purpose);
    },

    routeInner(row) {
        const providers = this.ai.providers;
        const auto = row.selected.provider === '';
        const dirty = AiProvidersView.routeDirty(row.saved, row.selected);
        const optionText = (p) => {
            const state = AiProvidersView.providerState(p);
            return state === 'ready' ? p.label : `${p.label} — ${t(`ops.ai.state.${state}`)}`;
        };
        const selectedProvider = providers.find((p) => p.id === row.selected.provider) || null;
        const listId = selectedProvider ? `aip-models-${selectedProvider.id}` : '';
        return html`
            <form data-submit="aip:saveRoute" data-change="aip:routeChanged" data-input="aip:routeChanged" data-purpose="${row.purpose}">
                <div class="aip-route-head">
                    <h4 class="aip-route-name" dir="auto">${this.purposeLabel(row.purpose)}</h4>
                    <p class="form-hint">${t(`ops.ai.purpose.${row.purpose}.hint`)}</p>
                    ${row.macBrainGuarded ? html`<p class="form-hint">${t('ops.ai.macGuard')}</p>` : ''}
                </div>
                <div class="aip-route-fields">
                    <div class="form-group">
                        <label class="form-label" for="aip-rp-${row.purpose}">${t('ops.ai.route.provider')}</label>
                        <select class="select" id="aip-rp-${row.purpose}" name="provider">
                            <option value="" ${auto ? html.raw('selected') : ''}>${t('ops.ai.route.auto')}</option>
                            ${providers.map((p) => html`<option value="${p.id}" ${p.id === row.selected.provider ? html.raw('selected') : ''}>${optionText(p)}</option>`)}
                        </select>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="aip-rm-${row.purpose}">${t('ops.ai.route.model')}</label>
                        <input class="field field-mono" id="aip-rm-${row.purpose}" name="model" type="text" dir="ltr" autocomplete="off"
                               spellcheck="false" autocapitalize="off" list="${listId}" placeholder="${t('ops.ai.route.modelDefault')}"
                               value="${row.selected.model}" ${auto ? html.raw('disabled') : ''}>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="aip-re-${row.purpose}">${t('ops.ai.route.effort')}</label>
                        <select class="select" id="aip-re-${row.purpose}" name="effort" ${auto ? html.raw('disabled') : ''}>
                            ${AiProvidersView.EFFORTS.map((e) => html`<option value="${e}" ${e === row.selected.effort ? html.raw('selected') : ''}>${t(`ops.ai.effort.${e}`)}</option>`)}
                        </select>
                    </div>
                </div>
                <p class="aip-now form-hint" id="aip-now-${row.purpose}" aria-live="polite">${this.nowLine(row)}</p>
                <div class="form-actions">
                    ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('ops.ai.route.save') })}
                    ${UI.button({
                        variant: 'secondary', size: 'sm', icon: 'play', label: t('ops.ai.route.test'), action: 'aip:testRoute',
                        data: { purpose: row.purpose }, disabled: dirty,
                    })}
                    <span class="form-hint text-warning aip-unsaved ${dirty ? '' : html.raw('hidden')}" id="aip-dirty-${row.purpose}">${t('ops.ai.route.unsaved')}</span>
                </div>
                <p class="aip-result" id="aip-t-${row.purpose}" role="status" aria-live="polite">${this.testResult(row.purpose)}</p>
            </form>
        `;
    },

    /** What a call for this purpose would use now, or why it would fail. */
    nowLine(row) {
        // The live rows may have moved on since the table was built: read the purpose from the settings held now.
        const live = this.ai && this.ai.purposes.find((p) => p.purpose === row.purpose);
        const resolved = live ? live.resolved : row.resolved;
        if (!resolved) return '';
        if (resolved.error) {
            return html`<span class="text-warning" dir="auto">${t('ops.ai.now.error', { code: resolved.error.kind })} ${resolved.error.message || ''}</span>`;
        }
        const provider = this.ai && this.ai.providers.find((p) => p.id === resolved.provider);
        return html`${t('ops.ai.now.uses')} <strong dir="auto">${provider ? provider.label : resolved.provider}</strong> ${UI.ltr(resolved.model)}
            · ${t(`ops.ai.effort.${resolved.effort}`)} · ${t(resolved.source === 'saved' ? 'ops.ai.now.saved' : 'ops.ai.now.default')}`;
    },

    /** The last Test answer for a purpose: green with the model, time and cost, or red with the error's code and the provider's words. */
    testResult(purpose) {
        const result = this.tests[purpose];
        if (!result) return '';
        const v = AiProvidersView.verdict(result);
        if (v.ok) {
            const provider = this.ai && this.ai.providers.find((p) => p.id === v.provider);
            return html`
                <span class="badge badge-success"><i data-lucide="check-circle" aria-hidden="true"></i> ${t('ops.ai.test.ok')}</span>
                <span class="aip-meta">${provider ? provider.label : v.provider} ${v.model ? UI.ltr(v.model) : ''}
                    · ${UI.ltr(AiProvidersView.duration(v.elapsedMs))} · ${UI.ltr(AiProvidersView.usd(v.usd))}</span>
            `;
        }
        return html`
            <span class="badge badge-danger"><i data-lucide="alert-circle" aria-hidden="true"></i> ${t('ops.ai.test.failed')} <code>${v.code}</code></span>
            ${v.message ? html`<span class="aip-error" dir="auto">${v.message}</span>` : ''}
        `;
    },

    // ─── Prices ───────────────────────────────────────────────────────────────────────────

    pricesInner() {
        const prices = this.ai && Array.isArray(this.ai.prices) ? this.ai.prices : [];
        return html`
            <h3 class="aip-subtitle">${t('ops.ai.prices')}</h3>
            <p class="form-hint mbe-4">${t('ops.ai.pricesHint')}</p>
            <ul class="aip-rows">
                ${prices.map((p) => html`
                    <li class="aip-row">
                        <div class="aip-row-main">
                            <code class="aip-model" dir="ltr">${p.model}</code>
                            <span class="badge ${p.source === 'custom' ? html.raw('badge-info') : html.raw('badge-neutral')}">${t(p.source === 'custom' ? 'ops.ai.priceCustom' : 'ops.ai.priceDefault')}</span>
                        </div>
                        <div class="aip-row-figures">
                            <span>${t('ops.ai.priceIn')} ${UI.ltr(AiProvidersView.rate(p.in))}</span>
                            <span>${t('ops.ai.priceOut')} ${UI.ltr(AiProvidersView.rate(p.out))}</span>
                        </div>
                        <div class="aip-row-actions">
                            ${UI.button({
                                variant: 'ghost', size: 'sm', icon: 'pencil', label: t('ops.ai.priceEdit'), action: 'aip:editPrice',
                                data: { model: p.model, in: p.in, out: p.out }, ariaLabel: t('ops.ai.priceEditFor', { model: p.model }),
                            })}
                            ${p.source === 'custom' ? UI.button({
                                variant: 'ghost', size: 'sm', icon: 'rotate-ccw', label: t('ops.ai.priceRemove'), action: 'aip:removePrice',
                                data: { model: p.model }, ariaLabel: t('ops.ai.priceRemoveFor', { model: p.model }),
                            }) : ''}
                        </div>
                    </li>
                `)}
            </ul>
            <form class="aip-price-form" id="aip-price-form" data-submit="aip:savePrice">
                <div class="aip-price-fields">
                    <div class="form-group">
                        <label class="form-label" for="aip-price-model">${t('ops.ai.price.model')}</label>
                        <input class="field field-mono" id="aip-price-model" name="model" type="text" dir="ltr" autocomplete="off"
                               spellcheck="false" autocapitalize="off" required list="aip-price-models">
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="aip-price-in">${t('ops.ai.price.in')}</label>
                        <input class="field field-mono" id="aip-price-in" name="in" type="text" inputmode="decimal" dir="ltr" autocomplete="off" required>
                    </div>
                    <div class="form-group">
                        <label class="form-label" for="aip-price-out">${t('ops.ai.price.out')}</label>
                        <input class="field field-mono" id="aip-price-out" name="out" type="text" inputmode="decimal" dir="ltr" autocomplete="off" required>
                    </div>
                </div>
                <div class="form-actions">
                    ${UI.button({ variant: 'secondary', size: 'sm', type: 'submit', icon: 'save', label: t('ops.ai.price.save') })}
                </div>
                <datalist id="aip-price-models">${this.priceModelOptions().map((m) => html`<option value="${m}"></option>`)}</datalist>
            </form>
        `;
    },

    /** Models a price could be for: the ones already in the table, and every provider's default and suggestions. */
    priceModelOptions() {
        const seen = new Set();
        (this.ai && this.ai.prices ? this.ai.prices : []).forEach((p) => seen.add(p.model));
        (this.ai ? this.ai.providers : []).forEach((p) => AiProvidersView.modelOptions(p, this.models[p.id] && this.models[p.id].list).forEach((m) => seen.add(m)));
        return [...seen].slice(0, AiProvidersView.MODELS_SHOWN);
    },

    // ─── Budgets ──────────────────────────────────────────────────────────────────────────

    budgetsInner() {
        const budgets = (this.ai && this.ai.budgets) || {};
        const spend = this.usage || (this.ai && this.ai.spend) || null;
        const spent = (name) => {
            if (!spend) return '';
            const daily = name === 'dailyUsd' ? spend.today : name === 'monthlyUsd' ? spend.month : null;
            return daily ? html`<span class="aip-meta">${t('ops.ai.budget.spent')} ${UI.ltr(AiProvidersView.usd(daily.usd))}</span>` : '';
        };
        return html`
            <h3 class="aip-subtitle">${t('ops.ai.budgets')}</h3>
            <p class="form-hint mbe-4">${t('ops.ai.budgetsHint')}</p>
            <form id="aip-budget-form" data-submit="aip:saveBudgets">
                <div class="aip-budget-fields">
                    ${AiProvidersView.BUDGETS.map((name) => html`
                        <div class="form-group">
                            <label class="form-label" for="aip-b-${name}">${t(`ops.ai.budget.${name}`)}</label>
                            <input class="field field-mono" id="aip-b-${name}" name="${name}" type="text" inputmode="decimal" dir="ltr"
                                   autocomplete="off" placeholder="${t('ops.ai.budget.none')}" value="${AiProvidersView.moneyInput(budgets[name])}">
                            ${spent(name)}
                        </div>
                    `)}
                </div>
                <div class="form-actions">
                    ${UI.button({ variant: 'primary', size: 'sm', type: 'submit', icon: 'save', label: t('ops.ai.budget.save') })}
                </div>
            </form>
        `;
    },

    // ─── Spend ────────────────────────────────────────────────────────────────────────────

    spendInner() {
        const totals = this.usage || (this.ai && this.ai.spend) || null;
        const header = html`<h3 class="aip-subtitle">${t('ops.ai.spend')}</h3>`;
        if (this.usageError && !totals) {
            return html`${header}<p class="form-hint text-warning" dir="auto">${t('ops.ai.spend.failed', { message: this.usageError.message })}</p>`;
        }
        if (!totals) return html`${header}`;

        const tile = (label, block) => Admin.statTile({
            label, value: UI.ltr(AiProvidersView.usd(block && block.usd)), icon: 'bar-chart-3', tone: 'accent',
            sub: t('ops.ai.spend.calls', { calls: UI.formatNumber((block && block.calls) || 0), failed: UI.formatNumber((block && block.failed) || 0) })
                + (block && block.unpriced ? ` ${t('ops.ai.spend.unpriced', { count: UI.formatNumber(block.unpriced) })}` : ''),
        });
        const rows = AiProvidersView.spendRows(this.usage);
        const periodButton = (period, label) => html`
            <button type="button" class="btn btn-ghost btn-sm" data-action="aip:setPeriod" data-period="${period}"
                    aria-pressed="${this.usagePeriod === period ? 'true' : 'false'}">${label}</button>
        `;

        return html`
            ${header}
            <div class="stats-grid mbe-4">
                ${tile(t('ops.ai.spend.today'), totals.today)}
                ${tile(t('ops.ai.spend.month'), totals.month)}
            </div>
            <div class="segmented aip-period" role="group" aria-label="${t('ops.ai.spend.period')}">
                ${periodButton('day', t('ops.ai.spend.today'))}
                ${periodButton('month', t('ops.ai.spend.month'))}
            </div>
            ${this.usage ? html`
                <h4 class="aip-minor">${t('ops.ai.spend.byPurpose')}</h4>
                ${rows.purposes.length === 0
                    ? html`<p class="form-hint">${t('ops.ai.spend.none')}</p>`
                    : html`<ul class="aip-rows">${rows.purposes.map((r) => html`
                        <li class="aip-row">
                            <div class="aip-row-main">
                                <span class="aip-row-name" dir="auto">${this.purposeLabel(r.purpose)}</span>
                                <span class="badge badge-neutral" dir="auto">${r.provider}</span>
                            </div>
                            <div class="aip-row-figures">
                                <span>${t('ops.ai.spend.callsShort', { calls: UI.formatNumber(r.calls) })}</span>
                                ${r.failed ? html`<span class="count-bad">${t('ops.ai.spend.failedShort', { failed: UI.formatNumber(r.failed) })}</span>` : ''}
                                <strong>${UI.ltr(AiProvidersView.usd(r.usd))}</strong>
                            </div>
                        </li>`)}</ul>`}
                <h4 class="aip-minor">${t('ops.ai.spend.byTenant')}</h4>
                ${rows.tenants.length === 0
                    ? html`<p class="form-hint">${t('ops.ai.spend.none')}</p>`
                    : html`<ul class="aip-rows">${rows.tenants.map((r) => html`
                        <li class="aip-row">
                            <div class="aip-row-main">
                                <span class="aip-row-name" dir="auto">${r.creatorId === null ? t('ops.ai.spend.platform') : (r.name || t('tenants.untitled'))}</span>
                            </div>
                            <div class="aip-row-figures">
                                <span>${t('ops.ai.spend.callsShort', { calls: UI.formatNumber(r.calls) })}</span>
                                <strong>${UI.ltr(AiProvidersView.usd(r.usd))}</strong>
                            </div>
                        </li>`)}</ul>`}
            ` : html`<p class="form-hint text-warning" dir="auto">${t('ops.ai.spend.failed', { message: this.usageError ? this.usageError.message : '' })}</p>`}
        `;
    },

    // ─── Actions: keys ────────────────────────────────────────────────────────────────────

    /** The pasted key, trimmed; the field is cleared the moment it has been sent and accepted, and kept when the provider refuses it. */
    pastedKey(form) {
        return String((new FormData(form).get('apiKey') || '')).trim();
    },

    clearKeyField(form) {
        const input = form && typeof form.querySelector === 'function' ? form.querySelector('input[name="apiKey"]') : null;
        if (input) input.value = '';
    },

    async saveKey(form, event) {
        event.preventDefault();
        const id = this.knownProvider(form.dataset && form.dataset.provider);
        if (!id || id === 'gemini') return;
        const apiKey = this.pastedKey(form);
        if (!apiKey) return;

        const restore = UI.formBusy(form, t('ops.ai.key.checking'));
        if (!restore) return; // already in flight
        try {
            const result = await API.saveAiKey(id, apiKey);
            this.clearKeyField(form);
            const warning = result && result.warning ? result.warning : '';
            const warningKey = AiProvidersView.warningKey(warning);
            UI.toast(warning ? `${t('ops.ai.key.savedToast')} ${warningKey ? t(warningKey) : warning}` : t('ops.ai.key.savedToast'), 'success');
            await this.afterKeyChange(id);
        } catch (err) {
            // Kept in the field, so a typo can be fixed rather than pasted again.
            restore();
            UI.toast((err && err.message) || t('ops.ai.key.saveFailed'), 'error');
        }
    },

    /** Gemini's key goes to the DM bot's own route, which asks Google to run the bot's models with it before saving. */
    async saveGeminiKey(form, event) {
        event.preventDefault();
        const apiKey = this.pastedKey(form);
        if (!apiKey) return;

        const restore = UI.formBusy(form, t('ops.gemini.checking'));
        if (!restore) return; // already in flight
        try {
            const result = await API.saveGeminiKey(apiKey);
            const spent = result && Array.isArray(result.quotaSpent) ? result.quotaSpent : [];
            if (spent.length) this.geminiNotice = spent;
            this.clearKeyField(form);
            UI.toast(t('ops.gemini.saved'), 'success');
            await this.afterKeyChange('gemini');
        } catch (err) {
            // Kept in the field, so a typo can be fixed rather than pasted again.
            restore();
            UI.toast((err && err.message) || t('ops.gemini.saveFailed'), 'error');
        }
    },

    removeKey(el) {
        const id = this.knownProvider(el.dataset && el.dataset.provider);
        if (!id || id === 'gemini') return;
        const p = this.provider(id);
        const env = AiProvidersView.keyEnv(id);
        const fallback = !!(p && p.key && p.key.envFallback);
        Admin.confirm({
            title: t('ops.ai.key.removeTitle', { name: p.label }),
            body: fallback && env ? t('ops.ai.key.removeBodyEnv', { env }) : t('ops.ai.key.removeBodyNone', { name: p.label }),
            confirmLabel: t('ops.ai.key.remove'),
            confirmIcon: 'trash-2',
            onConfirm: () => AiProviders.removeKeyConfirmed(id),
        });
    },

    /** A rejection is shown inside the confirm dialog, which stays open (Admin.runConfirm). */
    async removeKeyConfirmed(id) {
        await API.removeAiKey(id);
        UI.toast(t('ops.ai.key.removed'), 'success');
        await this.afterKeyChange(id);
    },

    removeGeminiKey() {
        const fallback = !!(this.gemini && this.gemini.envFallback);
        Admin.confirm({
            title: t('ops.gemini.removeTitle'),
            body: fallback ? t('ops.gemini.removeBodyEnv') : t('ops.gemini.removeBodyNone'),
            confirmLabel: t('ops.gemini.remove'),
            confirmIcon: 'trash-2',
            onConfirm: () => AiProviders.removeGeminiKeyConfirmed(),
        });
    },

    /** A rejection is shown inside the confirm dialog, which stays open (Admin.runConfirm). */
    async removeGeminiKeyConfirmed() {
        await API.removeGeminiKey();
        this.geminiNotice = null;
        UI.toast(t('ops.gemini.removed'), 'success');
        await this.afterKeyChange('gemini');
    },

    /**
     * A key was saved or removed: re-read what depends on it (the provider's status, which routes can answer, the warnings) and repaint
     * those regions. Gemini's own status is read from its own route.
     */
    async afterKeyChange(id) {
        if (id === 'gemini') {
            try { this.gemini = await API.getGeminiKey(); this.geminiError = null; } catch (err) { this.geminiError = err; }
        }
        // A key change invalidates what was checked with the old one.
        delete this.checks[id];
        delete this.models[id];
        const wasLoaded = !!this.ai;
        try { await this.refetchAi(); } catch (err) { this.aiError = err; }
        if (!wasLoaded && this.ai) {
            // The settings that could not be read now can: the card grows from the Gemini row to the whole thing.
            this.repaintAll();
            return;
        }
        this.paintProvider(id);
        if (this.ai) {
            this.paintWarnings();
            this.paintNow();
            this.paintDatalists();
        }
    },

    async check(el) {
        const id = this.knownProvider(el.dataset && el.dataset.provider);
        if (!id) return;
        const restore = UI.actionBusy(el);
        if (restore === null) return;
        try {
            this.checks[id] = await API.testAi({ provider: id });
        } catch (err) {
            this.checks[id] = { ok: false, error: { kind: 'request', message: (err && err.message) || t('common.error') } };
        } finally {
            restore();
        }
        this.paint(`aip-check-${id}`, this.checkResult(id));
        this.refreshSpendQuietly();
    },

    async loadModels(el) {
        const id = this.knownProvider(el.dataset && el.dataset.provider);
        if (!id) return;
        const restore = UI.actionBusy(el);
        if (restore === null) return;
        try {
            await this.fetchModels(id);
        } finally {
            restore();
        }
    },

    /** Ask the provider for its model list once; the datalists and the note under the default-model field follow. */
    async fetchModels(id) {
        this.models[id] = { status: 'loading', list: [], truncated: false, message: '' };
        this.paint(`aip-models-note-${id}`, this.modelsNote(id));
        try {
            const result = await API.getAiModels(id);
            const list = result && Array.isArray(result.models) ? result.models.filter((m) => typeof m === 'string') : [];
            this.models[id] = { status: 'ready', list, truncated: !!(result && result.truncated), message: '' };
        } catch (err) {
            this.models[id] = { status: 'error', list: [], truncated: false, message: (err && err.message) || t('common.error') };
        }
        this.paint(`aip-models-note-${id}`, this.modelsNote(id));
        this.paintDatalists();
        this.paint('aip-price-models', this.priceModelOptions().map((m) => html`<option value="${m}"></option>`));
    },

    async toggleEnabled(input) {
        const id = this.knownProvider(input.dataset && input.dataset.provider);
        if (!id || !this.ai) return;
        const want = !!input.checked;
        input.disabled = true;
        try {
            this.adopt(await API.saveAdminAi(AiProvidersView.enablePatch(id, want)));
            UI.toast(t(want ? 'ops.ai.enabledOn' : 'ops.ai.enabledOff', { name: this.provider(id).label }), 'success');
            this.paintProvider(id);
            this.paintWarnings();
            this.paintNow();
        } catch (err) {
            input.checked = !want;
            input.disabled = false;
            UI.toast((err && err.message) || t('ops.ai.saveFailed'), 'error');
        }
    },

    /** The default model, and Custom's base URL and JSON mode. */
    async saveDefaults(form, event) {
        event.preventDefault();
        const id = this.knownProvider(form.dataset && form.dataset.provider);
        const p = id && this.provider(id);
        if (!p || !this.ai) return;
        const value = (name) => {
            const field = form.querySelector(`[name="${name}"]`);
            return field ? field.value : '';
        };
        const built = AiProvidersView.defaultsPatch(p, { defaultModel: value('defaultModel'), baseUrl: value('baseUrl'), jsonMode: value('jsonMode') });
        if (!built.ok) {
            UI.toast(t('ops.ai.modelInvalid'), 'error');
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            this.adopt(await API.saveAdminAi(built.patch));
            UI.toast(t('ops.ai.defaultsSaved'), 'success');
            delete this.models[id];
            this.paintProvider(id);
            this.paintWarnings();
            this.paintNow();
            this.paintDatalists();
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('ops.ai.saveFailed'), 'error');
        }
    },

    // ─── Actions: routing ─────────────────────────────────────────────────────────────────

    routeFields(form) {
        const pick = (name) => (form && typeof form.querySelector === 'function' ? form.querySelector(`[name="${name}"]`) : null);
        return { provider: pick('provider'), model: pick('model'), effort: pick('effort') };
    },

    routeValues(form) {
        const f = this.routeFields(form);
        return {
            provider: f.provider ? String(f.provider.value || '') : '',
            model: f.model ? String(f.model.value || '') : '',
            effort: f.effort ? String(f.effort.value || '') : '',
        };
    },

    savedRoute(purpose) {
        const row = AiProvidersView.routeRows(this.ai).find((r) => r.purpose === purpose);
        return row ? row.saved : null;
    },

    /**
     * A control in a route row changed: "Automatic" has no model or effort to set, a new provider starts with its own default model
     * (a model id means nothing to another provider) and its model list, and Test is only offered for what is saved.
     */
    routeChanged(form, event) {
        const purpose = form.dataset && form.dataset.purpose;
        if (!purpose || !this.ai) return;
        const f = this.routeFields(form);
        const target = event && event.target;
        if (f.provider && target && target.name === 'provider') {
            const auto = f.provider.value === '';
            if (f.model) {
                f.model.value = '';
                f.model.setAttribute('list', auto ? '' : `aip-models-${f.provider.value}`);
            }
            if (!auto) this.warmModels(f.provider.value);
        }
        const auto = !f.provider || f.provider.value === '';
        if (f.model) f.model.disabled = auto;
        if (f.effort) f.effort.disabled = auto;
        this.syncRouteDirty(form, purpose);
    },

    /** Show or hide "Unsaved" and enable Test only while the row matches what is saved. */
    syncRouteDirty(form, purpose) {
        const dirty = AiProvidersView.routeDirty(this.savedRoute(purpose), this.routeValues(form));
        const note = document.getElementById(`aip-dirty-${purpose}`);
        if (note && note.classList) note.classList.toggle('hidden', !dirty);
        const test = form.querySelector('[data-action="aip:testRoute"]');
        if (test) test.disabled = dirty;
        return dirty;
    },

    /** Fetch a provider's model list the first time a route points at it, if it can answer; a failure is silent here (Load models says why). */
    warmModels(id) {
        const p = this.provider(id);
        if (!p || this.models[id] || AiProvidersView.providerState(p) !== 'ready') return;
        void this.fetchModels(id);
    },

    async saveRoute(form, event) {
        event.preventDefault();
        const purpose = form.dataset && form.dataset.purpose;
        if (!purpose || !this.ai || !this.ai.purposes.some((p) => p.purpose === purpose)) return;
        const built = AiProvidersView.routePatch(purpose, this.routeValues(form));
        if (!built.ok) {
            UI.toast(t(built.field === 'effort' ? 'ops.ai.effortInvalid' : 'ops.ai.modelInvalid'), 'error');
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            this.adopt(await API.saveAdminAi(built.patch));
            delete this.tests[purpose];
            UI.toast(t('ops.ai.route.saved'), 'success');
            restore();
            this.paint(`aip-t-${purpose}`, this.testResult(purpose));
            this.paintNow();
            this.paintWarnings();
            this.syncRouteDirty(form, purpose);
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('ops.ai.saveFailed'), 'error');
        }
    },

    /** Send one tiny structured call down the saved route and show the verdict beside it. */
    async testRoute(el) {
        const purpose = el.dataset && el.dataset.purpose;
        if (!purpose || !this.ai || !this.ai.purposes.some((p) => p.purpose === purpose)) return;
        const restore = UI.actionBusy(el, t('ops.ai.route.testing'));
        if (restore === null) return;
        try {
            this.tests[purpose] = await API.testAi({ purpose });
        } catch (err) {
            this.tests[purpose] = { ok: false, error: { kind: 'request', message: (err && err.message) || t('common.error') } };
        } finally {
            restore();
        }
        this.paint(`aip-t-${purpose}`, this.testResult(purpose));
        this.refreshSpendQuietly();
    },

    // ─── Actions: prices, budgets, spend ──────────────────────────────────────────────────

    async savePrice(form, event) {
        event.preventDefault();
        const value = (name) => {
            const field = form.querySelector(`[name="${name}"]`);
            return field ? field.value : '';
        };
        const built = AiProvidersView.pricePatch(value('model'), value('in'), value('out'));
        if (!built.ok) {
            UI.toast(t(built.field === 'model' ? 'ops.ai.modelInvalid' : 'ops.ai.priceInvalid'), 'error');
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            this.adopt(await API.saveAdminAi(built.patch));
            UI.toast(t('ops.ai.price.saved'), 'success');
            this.paintPrices();
            this.paintWarnings();
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('ops.ai.saveFailed'), 'error');
        }
    },

    /** Put a row's figures in the form, to change them. The values are written as properties, never as markup. */
    editPrice(el) {
        const set = (id, value) => {
            const field = document.getElementById(id);
            if (field) field.value = value;
        };
        set('aip-price-model', el.dataset.model || '');
        set('aip-price-in', el.dataset.in || '');
        set('aip-price-out', el.dataset.out || '');
        const field = document.getElementById('aip-price-in');
        if (field && typeof field.focus === 'function') field.focus();
    },

    async removePrice(el) {
        const model = el.dataset && el.dataset.model;
        if (!model || !this.ai || !this.ai.prices.some((p) => p.model === model)) return;
        const restore = UI.actionBusy(el);
        if (restore === null) return;
        try {
            this.adopt(await API.saveAdminAi(AiProvidersView.pricesRemovePatch(model)));
            UI.toast(t('ops.ai.price.removed'), 'success');
            this.paintPrices();
            this.paintWarnings();
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('ops.ai.saveFailed'), 'error');
        }
    },

    async saveBudgets(form, event) {
        event.preventDefault();
        const texts = {};
        for (const name of AiProvidersView.BUDGETS) {
            const field = form.querySelector(`[name="${name}"]`);
            texts[name] = field ? field.value : '';
        }
        const built = AiProvidersView.budgetsPatch(this.ai && this.ai.budgets, texts);
        if (!built.ok) {
            UI.toast(t('ops.ai.budget.invalid'), 'error');
            return;
        }
        if (!built.patch) {
            UI.toast(t('ops.ai.budget.nothing'));
            return;
        }
        const restore = UI.formBusy(form, t('common.saving'));
        if (!restore) return;
        try {
            this.adopt(await API.saveAdminAi(built.patch));
            UI.toast(t('ops.ai.budget.saved'), 'success');
            this.paintBudgets();
            this.paintWarnings();
        } catch (err) {
            restore();
            UI.toast((err && err.message) || t('ops.ai.saveFailed'), 'error');
        }
    },

    async setPeriod(el) {
        const period = el.dataset && el.dataset.period === 'month' ? 'month' : 'day';
        if (period === this.usagePeriod && this.usage) return;
        this.usagePeriod = period;
        await this.refreshSpend();
    },

    async refreshSpend() {
        try {
            this.usage = await API.getAiUsage(this.usagePeriod);
            this.usageError = null;
        } catch (err) {
            // The totals from the settings stay; a breakdown for the OTHER period would sit under the wrong toggle.
            this.usage = null;
            this.usageError = err;
        }
        this.paintSpend();
        this.paintBudgets();
    },

    /** A Check or Test adds a `key_test` row: bring the spend up to date without making the operator ask. Never throws. */
    refreshSpendQuietly() {
        void this.refreshSpend().catch(() => {});
    },

    /** The Retry on a card that could not load its settings. */
    async reload() {
        await this.load();
        this.repaintAll();
    },

    /** Repaint the card's contents in place (after a reload, or when the settings load for the first time). */
    repaintAll() {
        this.paint('aip-body', this.body());
    },
};

UI.registerActions('aip', {
    reload: () => Admin.report(AiProviders.reload()),
    saveKey: (el, e) => Admin.report(AiProviders.saveKey(el, e)),
    removeKey: (el) => AiProviders.removeKey(el),
    saveGeminiKey: (el, e) => Admin.report(AiProviders.saveGeminiKey(el, e)),
    removeGeminiKey: () => AiProviders.removeGeminiKey(),
    check: (el) => Admin.report(AiProviders.check(el)),
    loadModels: (el) => Admin.report(AiProviders.loadModels(el)),
    toggleEnabled: (el) => Admin.report(AiProviders.toggleEnabled(el)),
    saveDefaults: (el, e) => Admin.report(AiProviders.saveDefaults(el, e)),
    routeChanged: (el, e) => AiProviders.routeChanged(el, e),
    saveRoute: (el, e) => Admin.report(AiProviders.saveRoute(el, e)),
    testRoute: (el) => Admin.report(AiProviders.testRoute(el)),
    savePrice: (el, e) => Admin.report(AiProviders.savePrice(el, e)),
    editPrice: (el) => AiProviders.editPrice(el),
    removePrice: (el) => Admin.report(AiProviders.removePrice(el)),
    saveBudgets: (el, e) => Admin.report(AiProviders.saveBudgets(el, e)),
    setPeriod: (el) => Admin.report(AiProviders.setPeriod(el)),
});
