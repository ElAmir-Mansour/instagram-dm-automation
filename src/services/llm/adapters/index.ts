/**
 * Which adapter speaks which wire family.
 *
 * Each family is `{generate, normalize?, listModels?, checkKey?}` (see `FamilyAdapter`). All four
 * families have an adapter, so every provider in the registry can be called; `adapterFor` still
 * answers a family that is missing from a map it was given (a test's, or one built piecemeal)
 * with a `bad_request` rather than a crash.
 */
import { AiError } from '../errors.js';
import { providerName, type ProviderFamily } from '../registry.js';
import type { AdapterArgs, FamilyAdapter } from '../types.js';
import { anthropicFamily } from './anthropic.js';
import { chatCompletionsFamily } from './chatCompletions.js';
import { geminiFamily } from './gemini.js';
import { openaiFamily } from './openai.js';

export type FamilyAdapters = Partial<Record<ProviderFamily, FamilyAdapter>>;

export const ADAPTERS: FamilyAdapters = {
    anthropic: anthropicFamily,
    openai_responses: openaiFamily,
    gemini: geminiFamily,
    chat_completions: chatCompletionsFamily,
};

export function adapterFor(family: ProviderFamily, call: Pick<AdapterArgs, 'provider' | 'model'>, adapters: FamilyAdapters = ADAPTERS): FamilyAdapter {
    const adapter = adapters[family];
    if (adapter) return adapter;
    throw new AiError({
        kind: 'bad_request',
        provider: call.provider,
        model: call.model,
        message: `${providerName(call.provider)} cannot be called: there is no adapter for the ${family} family.`,
    });
}
