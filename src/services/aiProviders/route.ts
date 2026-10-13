/**
 * `resolveRoute(purpose, tenant)`: which provider, model and effort answers a purpose (docs/onboarding/06 §2, "Routing by purpose").
 *
 *   1. A saved route wins. If its provider cannot answer (no key, switched off, no base URL) that is `no_provider`, naming the cause:
 *      never a quiet move to another provider, which would bill someone the operator did not choose and hide a broken key.
 *   2. With none saved, the first provider that can answer, in the registry's order (Anthropic, OpenAI, Gemini, OpenRouter, Custom),
 *      at its default model. Gemini's key is the DM bot's, so on a deployment that has only that one, drafts spend the bot's quota:
 *      the Operations card says so beside any route that lands there.
 *   3. With no provider at all, `no_provider`. That error is final; the wizard falls back to its deterministic prefill.
 *
 * Before any of that, the Mac guard: `tenant_monteur_think` and `tenant_infographic` are refused for a tenant the operator's Mac works for
 * (the owner, and `studio.mac_brain_tenants`). His videos stay on the Mac; his work is never routed through the operator's API key.
 *
 * `resolveRoute` is the whole thing against the database. `pickRoute` is the choice itself, from settings already read, so a screen can
 * show what each purpose would use without making a call, and `generate` reads the settings once for the route, the key and the prices.
 */
import { isMacBrainAllowed } from '../macBrain.js';
import { defaultModelOf, loadAiSettings, providerProblem, type AiConfig, type ProviderKeys } from './settings.js';
import { AiError } from '../llm/errors.js';
import { MAC_BRAIN_PURPOSES, PURPOSE_DEFAULT_EFFORT, type AiPurpose } from './purposes.js';
import { PROVIDER_IDS, providerById, providerName, type ProviderId } from '../llm/registry.js';
import type { Effort, JsonMode } from '../llm/types.js';

export interface ResolvedRoute {
    purpose: AiPurpose;
    provider: ProviderId;
    model: string;
    effort: Effort;
    /** `saved`: the operator's route for this purpose. `default`: the first provider that could answer. */
    source: 'saved' | 'default';
    /** Custom's endpoint and JSON mode; absent for every other provider (the registry decides where a base URL may go). */
    baseUrl?: string;
    jsonMode?: JsonMode;
}

/**
 * A tenant the Mac works for asked for the Mac's work through the API. `bad_request`, so nothing retries it. Not an outage and not a
 * missing key: the caller routed the wrong tenant, and the way to see that in a log is its own class and `reason`.
 */
export class MacBrainTenantRefused extends AiError {
    readonly reason = 'mac_brain_tenant';
    constructor(readonly purpose: AiPurpose, readonly creatorId: string) {
        super({
            kind: 'bad_request', provider: '', model: '',
            message: `This tenant's ${purpose === 'tenant_infographic' ? 'infographic' : 'Monteur'} work runs on the operator's Mac (it is the owner, or on the Mac-brain list), not on the AI providers layer.`,
        });
        this.name = 'MacBrainTenantRefused';
    }
}

const noProvider = (message: string): AiError => new AiError({ kind: 'no_provider', provider: '', model: '', message });

/** The choice, from settings already read. Throws `no_provider` with the reason; never touches the database. */
export function pickRoute(purpose: AiPurpose, config: AiConfig, keys: ProviderKeys): ResolvedRoute {
    const route = (provider: ProviderId, model: string, effort: Effort, source: ResolvedRoute['source']): ResolvedRoute => {
        const custom = providerById(provider)?.editableBaseUrl;
        return {
            purpose, provider, model, effort, source,
            ...(custom ? { baseUrl: config.providers[provider]?.baseUrl, jsonMode: config.providers[provider]?.jsonMode } : {}),
        };
    };

    const saved = config.routing[purpose];
    if (saved) {
        const problem = providerProblem(saved.provider, config, keys);
        if (problem) throw noProvider(`The route for ${purpose} uses ${providerName(saved.provider)}, which ${problem}. Fix the key or choose another provider for this purpose.`);
        const model = saved.model || defaultModelOf(saved.provider, config);
        if (!model) throw noProvider(`The route for ${purpose} uses ${providerName(saved.provider)}, which has no model: name one on the route or set the provider's default model.`);
        return route(saved.provider, model, saved.effort, 'saved');
    }

    for (const id of PROVIDER_IDS) {
        if (providerProblem(id, config, keys)) continue;
        const model = defaultModelOf(id, config);
        if (model) return route(id, model, PURPOSE_DEFAULT_EFFORT[purpose], 'default');
    }
    throw noProvider('No AI provider is ready: save an API key for one in Operations → AI providers.');
}

/**
 * The Mac guard, on its own so that a caller that has read settings already can apply it. Skipped when the spend belongs to no tenant
 * (the operator pressing "Test" on a route), because there is no tenant whose Mac it could be.
 */
export async function assertNotMacBrainWork(purpose: AiPurpose, creatorId: string | null): Promise<void> {
    if (!creatorId || !MAC_BRAIN_PURPOSES.has(purpose)) return;
    if (await isMacBrainAllowed(creatorId)) throw new MacBrainTenantRefused(purpose, creatorId);
}

export async function resolveRoute(purpose: AiPurpose, creatorId: string | null): Promise<ResolvedRoute> {
    await assertNotMacBrainWork(purpose, creatorId);
    const { config, keys } = await loadAiSettings();
    return pickRoute(purpose, config, keys);
}
