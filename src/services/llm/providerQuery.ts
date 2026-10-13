/**
 * "Load models" and "check this key": what the settings card asks of a provider, as two functions
 * that either answer or throw an `AiError`, the way `callLlm` does for a generate call.
 *
 * Each provider's list and check live in its family's adapter (`FamilyAdapter.listModels` and
 * `checkKey`), because what is free, what is public and what proves a key differs: OpenRouter's
 * `/models` is public, so its key is checked against `/key`; a Custom endpoint may have no list
 * at all. This is the front door, so that a caller picks a provider and nothing else:
 *
 *   - an unknown provider, or a family without that capability, is a `bad_request`;
 *   - a missing key for a provider that needs one is `no_provider`, before any request;
 *   - Custom's base URL is checked inside the adapter (`endpointFor`), as it is for a call;
 *   - an `AiError` from the adapter passes through, and anything else becomes one: the deadline
 *     is `timeout`, a bug is `bad_request`, both scrubbed of the key like every error here.
 *
 * Nothing is retried, and nothing here saves a key or a model: a key that fails is simply not
 * saved by the caller (P20c).
 */
import { ADAPTERS, adapterFor, type FamilyAdapters } from './adapters/index.js';
import { AiError, isAiError } from './errors.js';
import { providerById, providerName } from './registry.js';
import type { KeyCheck, ProviderQuery } from './types.js';

/** The key as it was sent (trimmed, as every adapter does), so scrubbing finds it in what a provider echoes back. */
const keyOf = (q: ProviderQuery): string => (q.apiKey ?? '').trim();

function asAiError(err: unknown, q: ProviderQuery): AiError {
    if (isAiError(err)) return err;
    const name = (err as { name?: string } | null)?.name;
    const aborted = name === 'AbortError' || name === 'TimeoutError';
    return new AiError({
        kind: aborted ? 'timeout' : 'bad_request',
        provider: q.provider,
        model: '',
        message: aborted ? `${providerName(q.provider)} did not answer in time.` : `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
        key: keyOf(q),
    });
}

async function ask<T>(q: ProviderQuery, adapters: FamilyAdapters, what: 'listModels' | 'checkKey'): Promise<T> {
    const def = providerById(q.provider);
    if (!def) {
        throw new AiError({ kind: 'bad_request', provider: String(q.provider), model: '', message: `Unknown AI provider "${String(q.provider).slice(0, 40)}".`, key: keyOf(q) });
    }
    try {
        const family = adapterFor(def.family, { provider: q.provider, model: '' }, adapters);
        const run = family[what];
        if (!run) {
            throw new AiError({
                kind: 'bad_request', provider: q.provider, model: '', key: keyOf(q),
                message: `${providerName(q.provider)} has no ${what === 'listModels' ? 'model list' : 'key check'}.`,
            });
        }
        return (await run(q)) as T;
    } catch (err) {
        throw asAiError(err, q);
    }
}

/** The model ids a provider offers, for a picker; any other id can still be typed in. */
export function listProviderModels(q: ProviderQuery, adapters: FamilyAdapters = ADAPTERS): Promise<string[]> {
    return ask<string[]>(q, adapters, 'listModels');
}

/**
 * Whether a key works, by a call that is free and answers about the key itself. Passes with
 * `{ok: true}`, or with a `warning` for a key that cannot be proven (a Custom endpoint with no
 * model list: `no_model_list`); a key that fails throws.
 */
export function checkProviderKey(q: ProviderQuery, adapters: FamilyAdapters = ADAPTERS): Promise<KeyCheck> {
    return ask<KeyCheck>(q, adapters, 'checkKey');
}
