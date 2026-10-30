/**
 * The AI providers layer's settings (docs/onboarding/06 §2, "Providers and storage"): the operator's keys, which providers are on, which
 * provider and model answers each purpose, what a model costs, and what the platform and each tenant may spend.
 *
 * Everything here is a dashboard setting (`app_settings`, DB first, env as the fallback for keys) because these are the owner's inputs
 * and prices and model names change faster than a deploy. `ai.providers`, `ai.routing` and `ai.prices` are plain JSON; a key is one
 * encrypted row per provider. Gemini has no row of its own: its key is `gemini.api_key`, shared with the DM bot and the Studio, so a route
 * that uses Gemini spends the DM bot's quota (the card says so).
 *
 * Two rules the code below keeps:
 *
 *   - **A key leaves this module only as a `ProviderKeys`, which cannot be printed.** Callers ask it for a key by provider, to put in a
 *     request header; what a screen is told is `KeyStatus`, `{set, source, last4}`.
 *   - **Reading is forgiving, writing is strict.** A saved value that cannot be read (someone edited a row by hand) loses that entry, with
 *     a warning in the log; it never throws into a request. A change made through `planAiPatch` is validated whole before anything is written.
 */
import { inspect } from 'node:util';
import { log } from '../../utils/log.js';
import { APP_SETTING_KEYS, getSettings, last4, setSetting, type AppSettingKey } from '../appSettings.js';
import { type PriceTable } from '../llm/cost.js';
import { AI_PURPOSES, isAiPurpose, isContributorModel, PURPOSE_ALLOWLIST_REASON, PURPOSE_DEFAULT_EFFORT, PURPOSE_PROVIDER_ALLOWLIST, type AiPurpose } from './purposes.js';
import { checkBaseUrl, isProviderId, PROVIDER_IDS, providerById, type ProviderId } from '../llm/registry.js';
import { EFFORTS, isJsonMode, type Effort, type JsonMode } from '../llm/types.js';

// ─── Which rows ──────────────────────────────────────────────────────────────────────────────

/** Where each provider's key is saved. Gemini's is the platform's existing one. */
export const PROVIDER_KEY_SETTING: Readonly<Record<ProviderId, AppSettingKey>> = {
    anthropic: APP_SETTING_KEYS.aiProviderKeyAnthropic,
    openai: APP_SETTING_KEYS.aiProviderKeyOpenai,
    gemini: APP_SETTING_KEYS.geminiApiKey,
    openrouter: APP_SETTING_KEYS.aiProviderKeyOpenrouter,
    groq: APP_SETTING_KEYS.aiProviderKeyGroq,
    meta: APP_SETTING_KEYS.aiProviderKeyMeta,
    custom: APP_SETTING_KEYS.aiProviderKeyCustom,
};

/** The environment fallback for each key, when there is one. Custom has none: an endpoint the operator typed is a setting or nothing. */
export const PROVIDER_KEY_ENV: Readonly<Record<ProviderId, string | null>> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    gemini: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    groq: 'GROQ_API_KEY',
    meta: 'META_MODEL_API_KEY',
    custom: null,
};

export const BUDGET_NAMES = ['dailyUsd', 'monthlyUsd', 'tenantDailyUsd', 'tenantMonthlyUsd'] as const;
export type BudgetName = (typeof BUDGET_NAMES)[number];

export const BUDGET_SETTING: Readonly<Record<BudgetName, AppSettingKey>> = {
    dailyUsd: APP_SETTING_KEYS.aiBudgetDailyUsd,
    monthlyUsd: APP_SETTING_KEYS.aiBudgetMonthlyUsd,
    tenantDailyUsd: APP_SETTING_KEYS.aiBudgetTenantDailyUsd,
    tenantMonthlyUsd: APP_SETTING_KEYS.aiBudgetTenantMonthlyUsd,
};

const READ_KEYS: readonly AppSettingKey[] = [
    ...PROVIDER_IDS.map((id) => PROVIDER_KEY_SETTING[id]),
    APP_SETTING_KEYS.aiProviders,
    APP_SETTING_KEYS.aiRouting,
    APP_SETTING_KEYS.aiPrices,
    ...BUDGET_NAMES.map((name) => BUDGET_SETTING[name]),
];

// ─── The shapes ──────────────────────────────────────────────────────────────────────────────

/** What the operator changed about a provider. `enabled` is stored only when it is `false`: a provider is on unless it was switched off. */
export interface ProviderConfig {
    enabled?: false;
    defaultModel?: string;
    /** Custom only. */
    baseUrl?: string;
    /** Custom only. */
    jsonMode?: JsonMode;
}
export type ProvidersConfig = Partial<Record<ProviderId, ProviderConfig>>;

/** `model` is `''` for "the provider's own default model, whatever it is when the call is made". */
export interface RouteConfig {
    provider: ProviderId;
    model: string;
    effort: Effort;
}
export type RoutingConfig = Partial<Record<AiPurpose, RouteConfig>>;

/** US dollars; `null` is no limit, `0` refuses everything. */
export type Budgets = Record<BudgetName, number | null>;

export interface AiConfig {
    providers: ProvidersConfig;
    routing: RoutingConfig;
    /** The operator's overrides only; `cost.ts` lays them over `DEFAULT_PRICES`. */
    prices: PriceTable;
    budgets: Budgets;
}

export type KeySource = 'database' | 'env';

/** All a screen is told of a key. */
export interface KeyStatus {
    set: boolean;
    source: KeySource | null;
    /** Only of a key saved here; an environment key is reported present and never previewed. */
    last4: string | null;
    /** Whether removing the saved key would fall back to the environment. */
    envFallback: boolean;
}

/**
 * The keys in force, held where they cannot be printed: `JSON.stringify`, `console.log` and `util.inspect` all show a placeholder, and
 * the values are in a private field. `get` is for the one place a key is wanted (a request header); `secrets` is for the check that a
 * response does not contain one.
 */
export class ProviderKeys {
    readonly #keys: ReadonlyMap<ProviderId, { key: string; source: KeySource }>;
    readonly #envFallback: ReadonlySet<ProviderId>;

    constructor(keys: ReadonlyMap<ProviderId, { key: string; source: KeySource }>, envFallback: ReadonlySet<ProviderId>) {
        this.#keys = keys;
        this.#envFallback = envFallback;
    }

    get(provider: ProviderId): string | null {
        return this.#keys.get(provider)?.key ?? null;
    }

    has(provider: ProviderId): boolean {
        return this.#keys.has(provider);
    }

    status(provider: ProviderId): KeyStatus {
        const found = this.#keys.get(provider);
        return {
            set: !!found,
            source: found?.source ?? null,
            last4: found?.source === 'database' ? last4(found.key) : null,
            envFallback: this.#envFallback.has(provider),
        };
    }

    /** Every key in force, saved or from the environment. */
    secrets(): string[] {
        return [...this.#keys.values()].map((k) => k.key);
    }

    toJSON(): string {
        return '[ProviderKeys]';
    }

    [inspect.custom](): string {
        return '[ProviderKeys]';
    }
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────

/** A model id as every provider here writes one: `claude-opus-5-5`, `anthropic/claude-opus-5.5`, `openrouter/auto`, `openai/gpt-oss-120b`, `llama3:8b`. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(raw: string | null, setting: string): Record<string, unknown> | null {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (isPlainObject(parsed)) return parsed;
    } catch {
        // Falls through to the warning.
    }
    log('warn', 'ai.setting_unreadable', { setting });
    return null;
}

/** One provider's saved entry, or a reason it is not one. The same rules read and write. */
function providerEntry(id: ProviderId, value: unknown): { ok: true; entry: ProviderConfig } | { ok: false; problem: string } {
    if (!isPlainObject(value)) return { ok: false, problem: `providers.${id} must be an object.` };
    const def = providerById(id)!;
    const entry: ProviderConfig = {};
    for (const [field, v] of Object.entries(value)) {
        switch (field) {
            case 'enabled':
                if (typeof v !== 'boolean') return { ok: false, problem: `providers.${id}.enabled must be true or false.` };
                if (!v) entry.enabled = false;
                break;
            case 'defaultModel': {
                if (v === null || v === '') break;
                if (typeof v !== 'string' || !MODEL_ID.test(v.trim())) return { ok: false, problem: `providers.${id}.defaultModel is not a model id.` };
                entry.defaultModel = v.trim();
                break;
            }
            case 'baseUrl': {
                if (v === null || v === '') break;
                if (!def.editableBaseUrl) return { ok: false, problem: `providers.${id}.baseUrl: only Custom has a base URL.` };
                const checked = typeof v === 'string' ? checkBaseUrl(v) : ({ ok: false, reason: 'is not a URL' } as const);
                if (!checked.ok) return { ok: false, problem: `providers.${id}.baseUrl ${checked.reason}.` };
                entry.baseUrl = checked.url;
                break;
            }
            case 'jsonMode':
                if (v === null || v === '') break;
                if (!def.editableBaseUrl) return { ok: false, problem: `providers.${id}.jsonMode: only Custom has a JSON mode.` };
                if (!isJsonMode(v)) return { ok: false, problem: `providers.${id}.jsonMode must be "schema" or "object".` };
                entry.jsonMode = v;
                break;
            default:
                return { ok: false, problem: `providers.${id}.${field.slice(0, 40)} is not a setting.` };
        }
    }
    return { ok: true, entry };
}

function routeEntry(purpose: AiPurpose, value: unknown): { ok: true; route: RouteConfig } | { ok: false; problem: string } {
    if (!isPlainObject(value)) return { ok: false, problem: `routing.${purpose} must be an object.` };
    for (const field of Object.keys(value)) {
        if (field !== 'provider' && field !== 'model' && field !== 'effort') return { ok: false, problem: `routing.${purpose}.${field.slice(0, 40)} is not a setting.` };
    }
    if (!isProviderId(value.provider)) return { ok: false, problem: `routing.${purpose}.provider must be one of ${PROVIDER_IDS.join(', ')}.` };
    const rawModel = value.model;
    let model = '';
    if (rawModel !== undefined && rawModel !== null && rawModel !== '') {
        if (typeof rawModel !== 'string' || !MODEL_ID.test(rawModel.trim())) return { ok: false, problem: `routing.${purpose}.model is not a model id.` };
        model = rawModel.trim();
    }
    let effort: Effort = PURPOSE_DEFAULT_EFFORT[purpose];
    if (value.effort !== undefined && value.effort !== null) {
        if (!(EFFORTS as readonly unknown[]).includes(value.effort)) return { ok: false, problem: `routing.${purpose}.effort must be one of ${EFFORTS.join(', ')}.` };
        effort = value.effort as Effort;
    }
    return { ok: true, route: { provider: value.provider, model, effort } };
}

/** A price in dollars per million tokens: a ceiling so a pasted per-token figure (0.000004) or a typo (4000000) is caught, not saved. */
const MAX_PRICE_PER_MTOK = 10_000;
/** More than this is a paste gone wrong: the operator prices the handful of models routes use. */
export const MAX_PRICE_OVERRIDES = 200;

function priceEntry(model: string, value: unknown): { ok: true; price: { in: number; out: number } } | { ok: false; problem: string } {
    if (!isPlainObject(value)) return { ok: false, problem: `prices.${model} must be { "in": …, "out": … } in US dollars per million tokens.` };
    for (const field of Object.keys(value)) if (field !== 'in' && field !== 'out') return { ok: false, problem: `prices.${model}.${field.slice(0, 40)} is not a price.` };
    const [input, output] = [value.in, value.out];
    for (const [name, n] of [['in', input], ['out', output]] as const) {
        if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > MAX_PRICE_PER_MTOK) {
            return { ok: false, problem: `prices.${model}.${name} must be a number from 0 to ${MAX_PRICE_PER_MTOK} (US dollars per million tokens).` };
        }
    }
    return { ok: true, price: { in: input as number, out: output as number } };
}

export const MAX_BUDGET_USD = 1_000_000;

/** A budget as typed: a number, or text that is one. */
function budgetValue(v: unknown): number | null | undefined {
    if (v === null || v === '') return null;
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_BUDGET_USD ? n : undefined;
}

export function parseProviders(raw: string | null): ProvidersConfig {
    const parsed = readJson(raw, APP_SETTING_KEYS.aiProviders);
    const out: ProvidersConfig = {};
    for (const [id, value] of Object.entries(parsed ?? {})) {
        if (!isProviderId(id)) continue;
        const entry = providerEntry(id, value);
        if (entry.ok) out[id] = entry.entry;
        else log('warn', 'ai.setting_entry_unreadable', { setting: APP_SETTING_KEYS.aiProviders, entry: id });
    }
    return out;
}

export function parseRouting(raw: string | null): RoutingConfig {
    const parsed = readJson(raw, APP_SETTING_KEYS.aiRouting);
    const out: RoutingConfig = {};
    for (const [purpose, value] of Object.entries(parsed ?? {})) {
        if (!isAiPurpose(purpose)) continue;
        const route = routeEntry(purpose, value);
        if (route.ok) out[purpose] = route.route;
        else log('warn', 'ai.setting_entry_unreadable', { setting: APP_SETTING_KEYS.aiRouting, entry: purpose });
    }
    return out;
}

export function parsePrices(raw: string | null): PriceTable {
    const parsed = readJson(raw, APP_SETTING_KEYS.aiPrices);
    const out: Record<string, { in: number; out: number }> = {};
    for (const [model, value] of Object.entries(parsed ?? {})) {
        const price = priceEntry(model, value);
        if (price.ok) out[model.toLowerCase()] = price.price;
        else log('warn', 'ai.setting_entry_unreadable', { setting: APP_SETTING_KEYS.aiPrices, entry: model.slice(0, 40) });
    }
    return out;
}

export function parseBudget(raw: string | null, setting: string): number | null {
    if (raw === null) return null;
    const n = budgetValue(raw);
    if (n === undefined) {
        log('warn', 'ai.setting_unreadable', { setting });
        return null;
    }
    return n;
}

const envKey = (provider: ProviderId): string | null => {
    const name = PROVIDER_KEY_ENV[provider];
    return name ? process.env[name]?.trim() || null : null;
};

/**
 * Everything the AI layer reads, in one round trip: the keys (saved first, then the environment), the three JSON settings and the four
 * budgets. Read on every call and never cached: a key or a route saved from the dashboard has to reach every warm serverless instance,
 * and `ANY` over an indexed column is one cheap read next to a model call.
 */
export async function loadAiSettings(): Promise<{ config: AiConfig; keys: ProviderKeys }> {
    const rows = await getSettings(READ_KEYS);
    const found = new Map<ProviderId, { key: string; source: KeySource }>();
    const envFallback = new Set<ProviderId>();
    for (const id of PROVIDER_IDS) {
        const saved = rows.get(PROVIDER_KEY_SETTING[id]) ?? null;
        const env = envKey(id);
        if (env) envFallback.add(id);
        if (saved) found.set(id, { key: saved, source: 'database' });
        else if (env) found.set(id, { key: env, source: 'env' });
    }
    const budgets = Object.fromEntries(
        BUDGET_NAMES.map((name) => [name, parseBudget(rows.get(BUDGET_SETTING[name]) ?? null, BUDGET_SETTING[name])])
    ) as Budgets;
    return {
        config: {
            providers: parseProviders(rows.get(APP_SETTING_KEYS.aiProviders) ?? null),
            routing: parseRouting(rows.get(APP_SETTING_KEYS.aiRouting) ?? null),
            prices: parsePrices(rows.get(APP_SETTING_KEYS.aiPrices) ?? null),
            budgets,
        },
        keys: new ProviderKeys(found, envFallback),
    };
}

// ─── What a provider is, with the operator's changes ─────────────────────────────────────────

/** The model a provider answers with when a route names none: the operator's, else the registry's. `''` for Custom until one is set. */
export function defaultModelOf(id: ProviderId, config: AiConfig): string {
    return config.providers[id]?.defaultModel || providerById(id)?.defaultModel || '';
}

/** Why a provider cannot answer right now, or null when it can. Saying why is the point: "no_provider" alone sends the operator looking. */
export function providerProblem(id: ProviderId, config: AiConfig, keys: ProviderKeys): string | null {
    const def = providerById(id);
    if (!def) return 'is not a known provider';
    if (config.providers[id]?.enabled === false) return 'is switched off';
    if (def.keyRequired && !keys.has(id)) return 'has no API key saved';
    if (def.editableBaseUrl && !config.providers[id]?.baseUrl) return 'has no base URL saved';
    return null;
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────

/** What a change will leave in force, and what it touched: names and non-secret facts only, which is what the audit row says. */
export interface AiPlan {
    providers?: ProvidersConfig;
    routing?: RoutingConfig;
    prices?: PriceTable;
    budgets?: Partial<Budgets>;
    changes: { providers: string[]; routes: Record<string, string>; prices: string[]; budgets: string[] };
}

export type PlanResult = { ok: true; plan: AiPlan } | { ok: false; problems: string[] };

const SECTIONS = ['providers', 'routing', 'prices', 'budgets'] as const;

/** Said to a purpose with an allow-list that has no reason of its own (`PURPOSE_ALLOWLIST_REASON`): WhatsApp's. */
const DEFAULT_ALLOWLIST_REASON = 'only providers whose terms forbid training on what they are sent may answer this purpose.';

/** Why a Contributor-mode model id (`isContributorModel`) is refused when it is saved, for a route's model and for a provider's default. */
const CONTRIBUTOR_REFUSAL = 'is a Contributor-mode model: its provider may train on what it is sent, so no purpose may use one. Use the Standard model.';

/**
 * `PUT /api/admin/ai`'s body, validated whole against what is saved. Each section merges entry by entry: `null` removes an entry, an
 * object replaces it (a provider's fields merge into what is saved; a route and a price replace). Nothing is written here, so a body with
 * one bad entry changes nothing.
 */
export function planAiPatch(body: unknown, current: AiConfig): PlanResult {
    if (!isPlainObject(body)) return { ok: false, problems: ['Send an object: { providers?, routing?, prices?, budgets? }.'] };
    const problems: string[] = [];
    for (const name of Object.keys(body)) if (!(SECTIONS as readonly string[]).includes(name)) problems.push(`${name.slice(0, 40)} is not a section: use providers, routing, prices or budgets.`);
    for (const name of SECTIONS) if (body[name] !== undefined && !isPlainObject(body[name])) problems.push(`${name} must be an object.`);
    if (problems.length) return { ok: false, problems };

    const plan: AiPlan = { changes: { providers: [], routes: {}, prices: [], budgets: [] } };

    if (isPlainObject(body.providers)) {
        const next: ProvidersConfig = { ...current.providers };
        for (const [id, value] of Object.entries(body.providers)) {
            if (!isProviderId(id)) { problems.push(`providers.${id.slice(0, 40)} is not a provider.`); continue; }
            if (value === null) {
                delete next[id];
                plan.changes.providers.push(id);
                continue;
            }
            if (!isPlainObject(value)) { problems.push(`providers.${id} must be an object, or null to reset it.`); continue; }
            // A provider's fields merge into what is saved: a card saving the default model must not forget the base URL. `null` clears one.
            const merged = providerEntry(id, { ...current.providers[id], ...value });
            if (!merged.ok) { problems.push(merged.problem); continue; }
            // Only what is being saved: a patch that touches something else must not be held up by a model that was already there.
            if (typeof value.defaultModel === 'string' && isContributorModel(value.defaultModel)) { problems.push(`providers.${id}.defaultModel ${CONTRIBUTOR_REFUSAL}`); continue; }
            if (Object.keys(merged.entry).length) next[id] = merged.entry;
            else delete next[id];
            plan.changes.providers.push(id);
        }
        plan.providers = next;
    }

    if (isPlainObject(body.routing)) {
        const next: RoutingConfig = { ...current.routing };
        for (const [purpose, value] of Object.entries(body.routing)) {
            if (!isAiPurpose(purpose)) { problems.push(`routing.${purpose.slice(0, 40)} is not a purpose: use ${AI_PURPOSES.join(', ')}.`); continue; }
            if (value === null) {
                delete next[purpose];
                plan.changes.routes[purpose] = 'removed';
                continue;
            }
            const route = routeEntry(purpose, value);
            if (!route.ok) { problems.push(route.problem); continue; }
            // Refused when SAVED, not when read: a stored route on a provider that may not answer this purpose is still loaded, so `pickRoute` can name it
            // in the refusal and the card can show it, instead of the route vanishing and another provider answering without anyone having chosen it.
            const allowed = PURPOSE_PROVIDER_ALLOWLIST[purpose];
            if (allowed && !allowed.includes(route.route.provider)) {
                problems.push(`routing.${purpose}.provider must be one of ${allowed.join(', ')}: ${PURPOSE_ALLOWLIST_REASON[purpose] ?? DEFAULT_ALLOWLIST_REASON}`);
                continue;
            }
            // Refused when SAVED, like the allow-list; `pickRoute` refuses one that got in some other way, and names it.
            if (isContributorModel(route.route.model)) { problems.push(`routing.${purpose}.model ${CONTRIBUTOR_REFUSAL}`); continue; }
            next[purpose] = route.route;
            plan.changes.routes[purpose] = `${route.route.provider}/${route.route.model || 'default'}/${route.route.effort}`;
        }
        plan.routing = next;
    }

    if (isPlainObject(body.prices)) {
        const next: Record<string, { in: number; out: number }> = { ...current.prices };
        for (const [raw, value] of Object.entries(body.prices)) {
            const model = raw.trim().toLowerCase();
            if (!MODEL_ID.test(model)) { problems.push(`prices.${raw.slice(0, 40)} is not a model id.`); continue; }
            if (value === null) {
                delete next[model];
                plan.changes.prices.push(model);
                continue;
            }
            const price = priceEntry(model, value);
            if (!price.ok) { problems.push(price.problem); continue; }
            next[model] = price.price;
            plan.changes.prices.push(model);
        }
        if (Object.keys(next).length > MAX_PRICE_OVERRIDES) problems.push(`At most ${MAX_PRICE_OVERRIDES} prices can be saved.`);
        plan.prices = next;
    }

    if (isPlainObject(body.budgets)) {
        const next: Partial<Budgets> = {};
        for (const [name, value] of Object.entries(body.budgets)) {
            if (!(BUDGET_NAMES as readonly string[]).includes(name)) { problems.push(`budgets.${name.slice(0, 40)} is not a budget: use ${BUDGET_NAMES.join(', ')}.`); continue; }
            const usd = budgetValue(value);
            if (usd === undefined) { problems.push(`budgets.${name} must be a number of US dollars from 0 to ${MAX_BUDGET_USD}, or null for no limit.`); continue; }
            next[name as BudgetName] = usd;
            plan.changes.budgets.push(name);
        }
        plan.budgets = next;
    }

    if (problems.length) return { ok: false, problems };
    if (!plan.changes.providers.length && !Object.keys(plan.changes.routes).length && !plan.changes.prices.length && !plan.changes.budgets.length) {
        return { ok: false, problems: ['Nothing to change.'] };
    }
    return { ok: true, plan };
}

const json = (value: object): string | null => (Object.keys(value).length ? JSON.stringify(value) : null);

/** Writes a plan. One row per section, so a failure part-way leaves the earlier sections saved: each is complete on its own. */
export async function applyAiPlan(plan: AiPlan, updatedBy: string | null): Promise<void> {
    if (plan.providers) await setSetting(APP_SETTING_KEYS.aiProviders, json(plan.providers), updatedBy);
    if (plan.routing) await setSetting(APP_SETTING_KEYS.aiRouting, json(plan.routing), updatedBy);
    if (plan.prices) await setSetting(APP_SETTING_KEYS.aiPrices, json(plan.prices), updatedBy);
    for (const [name, usd] of Object.entries(plan.budgets ?? {}) as [BudgetName, number | null][]) {
        await setSetting(BUDGET_SETTING[name], usd === null ? null : String(usd), updatedBy);
    }
}

/** A key as pasted: one run of printable ASCII, not whitespace, not absurdly long. Google's, Anthropic's and OpenAI's are 39 to ~200. */
export function keyProblem(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return 'Paste the key to save. To go back to the environment, remove the saved key instead.';
    const key = raw.trim();
    if (key.length < 8 || key.length > 600 || /[^\x21-\x7e]/.test(key)) return 'That does not look like an API key.';
    return null;
}
