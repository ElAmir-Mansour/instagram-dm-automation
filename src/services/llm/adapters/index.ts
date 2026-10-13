/**
 * Which adapter speaks which wire family.
 *
 * OpenAI Responses and Chat Completions (OpenRouter, Custom) arrive in P20b. Until then asking
 * for them is a `bad_request` that says so, rather than a crash or a silent wrong answer: the
 * registry already lists those providers, and a route can already name one.
 */
import { AiError } from '../errors.js';
import { providerName, type ProviderFamily } from '../registry.js';
import type { Adapter, AdapterArgs } from '../types.js';
import { anthropicAdapter } from './anthropic.js';
import { geminiAdapter } from './gemini.js';

const ADAPTERS: Partial<Record<ProviderFamily, Adapter>> = {
    anthropic: anthropicAdapter,
    gemini: geminiAdapter,
};

export function adapterFor(family: ProviderFamily, call: Pick<AdapterArgs, 'provider' | 'model'>): Adapter {
    const adapter = ADAPTERS[family];
    if (adapter) return adapter;
    throw new AiError({
        kind: 'bad_request',
        provider: call.provider,
        model: call.model,
        message: `${providerName(call.provider)} is not available yet: the ${family} adapter is not implemented.`,
    });
}
