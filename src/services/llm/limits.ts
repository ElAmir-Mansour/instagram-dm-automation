/**
 * How much room a call needs: the smallest `maxTokens` that is worth asking a model for.
 *
 * `maxTokens` caps the whole answer, thinking included (types.ts). A model that thinks spends the
 * limit on its reasoning first, and a limit sized for the visible JSON alone ends as `max_tokens`
 * after the reasoning was billed, with no answer. Nothing here raises a caller's limit: it is
 * their spending cap, and the library never retries, so it cannot try again with more. This says
 * what a sensible limit is, for the router (P20c) to apply when it builds a route and for
 * `callLlm` to warn when a call asks for less.
 *
 *   - OpenAI reasoning models: 25 000. That is the figure from OpenAI's reasoning guide ("reserving
 *     at least 25,000 tokens for reasoning and outputs"), and it is a cap, not a charge. The same
 *     for an `openai/` reasoning model behind OpenRouter, the only OpenRouter models that are sent
 *     a `reasoning` request (adapters/chatCompletions.ts).
 *   - Anthropic models that take `effort`, and Gemini thinking models, think by default and have
 *     no documented minimum. These are heuristics, sized so the thinking the effort asks for and
 *     a JSON answer both fit: Anthropic 4 000 / 8 000 / 16 000 / 24 000 / 32 000 for low to max;
 *     Gemini twice the thinking budget the adapter asks for (a budget is held to half the limit,
 *     adapters/gemini.ts), and at least 4 096.
 *   - Groq: 0, gpt-oss included, although its reasoning is counted in its completion tokens. Groq
 *     counts the `max_tokens` a request asks for against the account's tokens per minute, and on
 *     the free tier that is 8 000 for gpt-oss-120b: a 25 000 floor would make every free-tier
 *     request "too large" (a 413) before it was read. The caller's limit stands.
 *   - Meta (Muse): 4 000, whatever the model and the effort. Muse Spark always reasons and counts it in
 *     `completion_tokens`; measured live on 2026-10-28 to 10-30, a one-word answer spent 180 tokens thinking,
 *     and a limit under about 1 000 to 2 000 came back with no text and `finish_reason: 'length'` after being
 *     billed. The admin's Test button asks for 200, and would otherwise fail every time. A floor, not a charge.
 *   - Baseten (Meta's open Muse Spark): the same 4 000. It always reasons too (Baseten's reasoning page: "Muse Spark Open always reasons"), the reasoning is
 *     counted in `completion_tokens`, and the live reel analysis of 2026-10-29 spent 3 371 output tokens on a 37 s reel.
 *   - Everything else (a model that does not reason, a Custom endpoint, an unknown name): 0, no
 *     minimum, which is the answer for a limit that was sized for the JSON alone.
 */
import { META_MIN_OUTPUT, openRouterReasoning } from './adapters/chatCompletions.js';
import { thinkingConfigFor, THINKING_BUDGETS } from './adapters/gemini.js';
import { supportsEffort } from './adapters/anthropic.js';
import { OPENAI_REASONING_MIN_OUTPUT, supportsReasoning } from './adapters/openai.js';
import type { Effort } from './types.js';

const ANTHROPIC_MIN_OUTPUT: Readonly<Record<Effort, number>> = { low: 4_000, medium: 8_000, high: 16_000, xhigh: 24_000, max: 32_000 };
const GEMINI_FLOOR = 4_096;

/** The smallest `maxTokens` worth asking `model` for at this effort, or 0 if there is no such minimum. */
export function minOutputTokens(provider: string, model: string, effort: Effort): number {
    switch (provider) {
        case 'openai':
            return supportsReasoning(model) ? OPENAI_REASONING_MIN_OUTPUT : 0;
        case 'openrouter':
            return openRouterReasoning(model, effort) ? OPENAI_REASONING_MIN_OUTPUT : 0;
        case 'anthropic':
            return supportsEffort(model) ? ANTHROPIC_MIN_OUTPUT[effort] : 0;
        case 'gemini':
            return thinkingConfigFor(model, effort, Number.MAX_SAFE_INTEGER) ? Math.max(GEMINI_FLOOR, THINKING_BUDGETS[effort] * 2) : 0;
        case 'meta':
        case 'baseten':
            return META_MIN_OUTPUT;
        default:
            return 0;
    }
}
