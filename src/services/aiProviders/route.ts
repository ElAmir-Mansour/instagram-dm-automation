/**
 * `resolveRoute(purpose, tenant)`: which provider, model and effort answers a purpose (docs/onboarding/06 §2, "Routing by purpose").
 *
 *   1. A saved route wins. If its provider cannot answer (no key, switched off, no base URL) that is `no_provider`, naming the cause:
 *      never a quiet move to another provider, which would bill someone the operator did not choose and hide a broken key.
 *   2. With none saved, the first provider that can answer, in the registry's order (Anthropic, OpenAI, Gemini, OpenRouter, Groq, Meta, Custom),
 *      at its default model. Gemini's key is the DM bot's, so on a deployment that has only that one, drafts spend the bot's quota:
 *      the Operations card says so beside any route that lands there.
 *   3. With no provider at all, `no_provider`. That error is final; the wizard falls back to its deterministic prefill.
 *
 * A provider that may answer only some purposes (Baseten: the reel indexer alone, `PROVIDER_PURPOSE_ALLOWLIST`) is passed over in step 2 for every other
 * purpose, and a saved route that names it for one is refused in step 1, whatever its key says.
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
import {
    isContributorModel, MAC_BRAIN_PURPOSES, providerMayAnswer, providerPurposeReason, PURPOSE_DEFAULT_EFFORT, PURPOSE_PROVIDER_ALLOWLIST, PURPOSE_ROUTE_FALLBACK, type AiPurpose,
} from './purposes.js';
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

export interface PickOptions {
    /**
     * Let a Contributor-mode model (`-contributor`: Meta may train on what it is sent) answer. Only for an evaluation of made-up cases, which belongs to
     * no tenant and is recorded as `eval` (`generate` decides that): everywhere else such a model is refused, saved or not (purposes.ts).
     */
    allowContributor?: boolean;
    /**
     * Providers to pass over: the caller already tried them and wants the next one. A saved route that names one is skipped, not refused, and the first provider
     * that is allowed for the purpose and has a key answers at its default model. It only NARROWS: a caller can never name the provider that answers, so a tenant's
     * call still follows the operator's routing. The reel indexer's one retry after Baseten fails moves to Meta's hosted model this way.
     */
    skip?: readonly ProviderId[];
}

/**
 * `no_provider`, final, when a provider that may answer only some purposes (`PROVIDER_PURPOSE_ALLOWLIST`) is asked for another. Nothing is sent: this is said before a key
 * is read. `pickRoute` applies it to a saved route and `generate` once more to the route it is about to call, so the deny holds even if one of the two changes.
 */
export function assertProviderMayAnswer(provider: ProviderId, purpose: AiPurpose): void {
    if (!providerMayAnswer(provider, purpose)) throw noProvider(`${providerPurposeReason(providerName(provider), provider)} It cannot be used for ${purpose}.`);
}

/** The choice, from settings already read. Throws `no_provider` with the reason; never touches the database. */
export function pickRoute(purpose: AiPurpose, config: AiConfig, keys: ProviderKeys, opts: PickOptions = {}): ResolvedRoute {
    const route = (provider: ProviderId, model: string, effort: Effort, source: ResolvedRoute['source']): ResolvedRoute => {
        const custom = providerById(provider)?.editableBaseUrl;
        return {
            purpose, provider, model, effort, source,
            ...(custom ? { baseUrl: config.providers[provider]?.baseUrl, jsonMode: config.providers[provider]?.jsonMode } : {}),
        };
    };

    // A purpose with an allow-list (WhatsApp replies: only providers that do not train on what they are sent) answers only from it, and a purpose with
    // no route of its own may borrow another's SAVED route. Both are checked before the provider's key: a route that may not be used is refused
    // whatever its key says, and never quietly replaced by a provider the operator did not choose.
    const allowed = PURPOSE_PROVIDER_ALLOWLIST[purpose];
    const fallback = PURPOSE_ROUTE_FALLBACK[purpose];
    const own = config.routing[purpose];
    const skipped = (id: ProviderId): boolean => opts.skip?.includes(id) === true;
    const saved = own ?? (fallback ? config.routing[fallback] : undefined);
    if (saved && !skipped(saved.provider)) {
        const named = own ? purpose : `${purpose} (taken from the ${fallback} route)`;
        // Before the provider's key is looked at, like the allow-list below: a route that may not be used is refused whatever its key says.
        if (!providerMayAnswer(saved.provider, purpose)) {
            throw noProvider(`The route for ${named} uses ${providerName(saved.provider)}. ${providerPurposeReason(providerName(saved.provider), saved.provider)} Choose another provider.`);
        }
        if (allowed && !allowed.includes(saved.provider)) {
            throw noProvider(`The route for ${named} uses ${providerName(saved.provider)}, which is not on the list of providers that may answer this purpose (${allowed.map(providerName).join(', ')}). Choose one of them.`);
        }
        const problem = providerProblem(saved.provider, config, keys);
        if (problem) throw noProvider(`The route for ${named} uses ${providerName(saved.provider)}, which ${problem}. Fix the key or choose another provider for this purpose.`);
        const model = saved.model || defaultModelOf(saved.provider, config);
        if (!model) throw noProvider(`The route for ${named} uses ${providerName(saved.provider)}, which has no model: name one on the route or set the provider's default model.`);
        // Said by name, like a provider that may not answer, and for a model that came from the provider's default as well as one the route names.
        if (!opts.allowContributor && isContributorModel(model)) {
            throw noProvider(`The route for ${named} uses ${model}, a Contributor-mode model: ${providerName(saved.provider)} may train on what it is sent, so no purpose may use it. Choose the Standard model instead.`);
        }
        return route(saved.provider, model, saved.effort, 'saved');
    }

    for (const id of PROVIDER_IDS) {
        if (skipped(id)) continue;
        if (allowed && !allowed.includes(id)) continue;
        // The default order never reaches a provider that may not answer this purpose, even when it is the only one with a key: it would be chosen by nobody.
        if (!providerMayAnswer(id, purpose)) continue;
        if (providerProblem(id, config, keys)) continue;
        const model = defaultModelOf(id, config);
        // A provider whose default model trains on what it is sent cannot answer on its own say-so, the same as one with no key.
        if (!opts.allowContributor && isContributorModel(model)) continue;
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
