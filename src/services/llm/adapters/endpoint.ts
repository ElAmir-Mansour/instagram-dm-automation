/**
 * What every model list and key check starts from: which provider, whether its key is there, and
 * where the request goes.
 *
 * `callLlm` does these checks before a generate call reaches an adapter. A list or a check has no
 * `callLlm` in front of it (P20c's routes call the adapter directly), so the adapters call this
 * themselves, and it is the only thing that stands between a base URL someone typed for Custom and
 * a request carrying a key. It is the same rule `callLlm` applies, from the same `checkBaseUrl`.
 */
import { AiError, type AiErrorKind } from '../errors.js';
import { checkBaseUrl, providerById, providerName, type ProviderDef } from '../registry.js';
import type { ProviderQuery } from '../types.js';

/** A list or a check that has no deadline of its own gets this one; a caller's signal replaces it. */
export const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

export interface PreparedQuery {
    def: ProviderDef;
    /** Trimmed. Empty only for a provider that needs none. */
    key: string;
    signal: AbortSignal;
    /** `AiError` for this provider; a list or a check has no model, so it names none. */
    fail: (kind: AiErrorKind, message: string, status?: number) => AiError;
}

/**
 * The provider, its trimmed key and a deadline, or the error that says what is missing. `needsKey`
 * is true unless the call is one that works without one (OpenRouter's model list is public) or
 * the provider needs none (Custom).
 */
export function prepareQuery(q: ProviderQuery, opts: { needsKey?: boolean } = {}): PreparedQuery {
    const key = (q.apiKey ?? '').trim();
    const def = providerById(q.provider);
    const fail = (kind: AiErrorKind, message: string, status?: number) => new AiError({ kind, provider: q.provider, model: '', status, message, key });
    if (!def) throw fail('bad_request', `Unknown AI provider "${String(q.provider).slice(0, 40)}".`);
    if (def.keyRequired && opts.needsKey !== false && !key) throw fail('no_provider', `No API key is saved for ${providerName(def.id)}.`);
    return { def, key, signal: q.signal ?? AbortSignal.timeout(DEFAULT_QUERY_TIMEOUT_MS), fail };
}

/**
 * Where a Chat Completions request goes: OpenRouter's own address, always, or Custom's, which must
 * be a public https origin (`checkBaseUrl`) and is returned tidied, without a trailing slash.
 */
export function endpointFor(a: { provider: string; model: string; apiKey: string; baseUrl?: string }): string {
    const def = providerById(a.provider);
    const refuse = (message: string) => new AiError({ kind: 'bad_request', provider: a.provider, model: a.model, message, key: a.apiKey });
    if (!def) throw refuse(`Unknown AI provider "${String(a.provider).slice(0, 40)}".`);
    if (!def.editableBaseUrl) return def.baseUrl;
    const raw = a.baseUrl?.trim();
    if (!raw) throw refuse(`${providerName(def.id)} has no base URL.`);
    const checked = checkBaseUrl(raw);
    if (!checked.ok) throw refuse(`${providerName(def.id)}'s base URL ${checked.reason}.`);
    return checked.url;
}

/**
 * Ids out of an OpenAI-style list (`{data: [{id}]}`), which Anthropic's list shares, or the
 * `models` / bare-array variants some compatible servers send; each once, in the order given.
 */
export function modelIdsFrom(body: unknown): string[] {
    const list: unknown = Array.isArray(body) ? body : (body as any)?.data ?? (body as any)?.models;
    const ids = (Array.isArray(list) ? list : [])
        .map((m) => (typeof m === 'string' ? m : (m?.id ?? m?.name)))
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)];
}
