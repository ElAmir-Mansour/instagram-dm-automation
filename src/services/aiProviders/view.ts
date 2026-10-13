/**
 * What `GET /api/admin/ai` tells the Operations card: the settings as the operator would read them, with every key reduced to
 * `{set, source, last4}`. Pure: it takes settings already read, so a test can hand it a key and look for that key in what comes back.
 *
 * Nothing in the view is a secret, and nothing is built from `ProviderKeys.get`. `describeAi` takes the keys object only for `status()`.
 */
import { DEFAULT_PRICES, priceFor } from '../llm/cost.js';
import { BUDGET_NAMES, defaultModelOf, providerProblem, type AiConfig, type Budgets, type KeyStatus, type ProviderKeys } from './settings.js';
import { AI_PURPOSES, MAC_BRAIN_PURPOSES, PURPOSE_DEFAULT_EFFORT, type AiPurpose } from './purposes.js';
import { PROVIDERS, type ProviderId } from '../llm/registry.js';
import { pickRoute } from './route.js';
import type { Effort, JsonMode } from '../llm/types.js';
import { isAiError } from '../llm/errors.js';

export interface ProviderView {
    id: ProviderId;
    label: string;
    family: string;
    keyRequired: boolean;
    key: KeyStatus;
    enabled: boolean;
    defaultModel: string;
    /** `setting`: the operator's. `code`: the registry's seed. */
    defaultModelSource: 'setting' | 'code';
    suggestedModels: readonly string[];
    /** Custom only; null for the rest. */
    baseUrl: string | null;
    jsonMode: JsonMode | null;
    /** Whether it could answer a call right now, and if not, why. */
    usable: boolean;
    problem: string | null;
    /** Gemini's key is the DM bot's: a route that lands here spends its quota. */
    sharesDmQuota: boolean;
}

export interface PurposeView {
    purpose: AiPurpose;
    defaultEffort: Effort;
    /** Refused for a tenant the Mac works for. */
    macBrainGuarded: boolean;
    saved: { provider: ProviderId; model: string; effort: Effort } | null;
    /** What a call for this purpose would use now, or why it would fail. */
    resolved:
        | { provider: ProviderId; model: string; effort: Effort; source: 'saved' | 'default' }
        | { error: { kind: string; message: string } };
}

export interface Warning {
    code: 'no_budget' | 'gemini_dm_quota' | 'unpriced_model';
    detail?: string[];
}

export interface AiView {
    providers: ProviderView[];
    purposes: PurposeView[];
    prices: { model: string; in: number; out: number; source: 'default' | 'custom' }[];
    budgets: Budgets & { unlimited: boolean };
    warnings: Warning[];
}

export function describeAi(config: AiConfig, keys: ProviderKeys): AiView {
    const providers: ProviderView[] = PROVIDERS.map((def) => {
        const saved = config.providers[def.id];
        const problem = providerProblem(def.id, config, keys);
        return {
            id: def.id,
            label: def.label,
            family: def.family,
            keyRequired: def.keyRequired,
            key: keys.status(def.id),
            enabled: saved?.enabled !== false,
            defaultModel: defaultModelOf(def.id, config),
            defaultModelSource: saved?.defaultModel ? 'setting' : 'code',
            suggestedModels: def.suggestedModels,
            baseUrl: def.editableBaseUrl ? saved?.baseUrl ?? null : null,
            jsonMode: def.editableBaseUrl ? saved?.jsonMode ?? 'schema' : null,
            usable: problem === null,
            problem,
            sharesDmQuota: def.id === 'gemini',
        };
    });

    const purposes: PurposeView[] = AI_PURPOSES.map((purpose) => {
        const saved = config.routing[purpose];
        let resolved: PurposeView['resolved'];
        try {
            const r = pickRoute(purpose, config, keys);
            resolved = { provider: r.provider, model: r.model, effort: r.effort, source: r.source };
        } catch (err) {
            resolved = { error: isAiError(err) ? { kind: err.kind, message: err.message } : { kind: 'bad_request', message: 'The route could not be resolved.' } };
        }
        return {
            purpose,
            defaultEffort: PURPOSE_DEFAULT_EFFORT[purpose],
            macBrainGuarded: MAC_BRAIN_PURPOSES.has(purpose),
            saved: saved ? { provider: saved.provider, model: saved.model, effort: saved.effort } : null,
            resolved,
        };
    });

    const priceModels = new Set([...Object.keys(DEFAULT_PRICES), ...Object.keys(config.prices)]);
    const prices = [...priceModels].sort().map((model) => {
        const custom = config.prices[model];
        const p = custom ?? DEFAULT_PRICES[model]!;
        return { model, in: p.in, out: p.out, source: custom ? ('custom' as const) : ('default' as const) };
    });

    const warnings: Warning[] = [];
    const unlimited = BUDGET_NAMES.every((name) => config.budgets[name] === null);
    if (unlimited) warnings.push({ code: 'no_budget' });
    const resolvedRoutes = purposes.flatMap((p) => ('error' in p.resolved ? [] : [p.resolved]));
    if (resolvedRoutes.some((r) => r.provider === 'gemini')) warnings.push({ code: 'gemini_dm_quota' });
    const unpriced = [...new Set(resolvedRoutes.map((r) => r.model).filter((model) => !priceFor(model, config.prices).priced))];
    if (unpriced.length) warnings.push({ code: 'unpriced_model', detail: unpriced });

    return { providers, purposes, prices, budgets: { ...config.budgets, unlimited }, warnings };
}
