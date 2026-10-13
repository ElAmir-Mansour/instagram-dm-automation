/**
 * Which adapter speaks which wire family.
 *
 * Each family is `{generate, normalize?, listModels?, checkKey?}` (see `FamilyAdapter`): P20b adds
 * the families that are missing and fills in the optional parts without touching `callLlm`.
 * OpenAI Responses and Chat Completions (OpenRouter, Custom) arrive in P20b. Until then asking
 * for them is a `bad_request` that says so, rather than a crash or a silent wrong answer: the
 * registry already lists those providers, and a route can already name one.
 */
import { AiError } from '../errors.js';
import { providerName, type ProviderFamily } from '../registry.js';
import type { AdapterArgs, FamilyAdapter } from '../types.js';
import { anthropicFamily } from './anthropic.js';
import { geminiFamily } from './gemini.js';

export type FamilyAdapters = Partial<Record<ProviderFamily, FamilyAdapter>>;

export const ADAPTERS: FamilyAdapters = {
    anthropic: anthropicFamily,
    gemini: geminiFamily,
};

export function adapterFor(family: ProviderFamily, call: Pick<AdapterArgs, 'provider' | 'model'>, adapters: FamilyAdapters = ADAPTERS): FamilyAdapter {
    const adapter = adapters[family];
    if (adapter) return adapter;
    throw new AiError({
        kind: 'bad_request',
        provider: call.provider,
        model: call.model,
        message: `${providerName(call.provider)} is not available yet: the ${family} adapter is not implemented.`,
    });
}
