/**
 * The vocabulary every adapter and `generateJson` share.
 */
import type { ProviderId } from './registry.js';
import type { LlmSchema } from './schema.js';

/**
 * How hard the model should think. The five names are Anthropic's own; each family maps them on
 * to what it has (`reasoning.effort`, a Gemini thinking level or budget). The default is medium,
 * which is also what Opus 5.5 does when `effort` is omitted, so "always explicit" costs nothing.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const DEFAULT_EFFORT: Effort = 'medium';

/** Why the model stopped, in the one vocabulary every family is mapped onto. */
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal';

/** One turn of a conversation. A repair round is the first prompt, the answer it got, and what to fix. */
export type LlmTurn = { role: 'user' | 'model'; text: string };

/**
 * Tokens, as `{in, out}` (the spec's names). Not `input_tokens`/`output_tokens`: the logger
 * (`utils/log.ts`) redacts any field whose name contains "token", so those arrived in every log
 * line as `[redacted]`. Thinking counts as output: every provider bills it at the output rate.
 */
export type Usage = { in: number; out: number };

/**
 * One model's share of what a call was billed. Normally a call has one entry; Anthropic's
 * server-side fallback can have several (the model that declined, then the one that answered),
 * each at its own price. `usd` is filled by whoever knows the prices (`costOf`, cost.ts).
 */
export type Billed = { model: string; in: number; out: number; usd?: number };

/** `fetch`, as far as this library needs it: tests hand in a stub, production uses the global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What `generateJson` hands an adapter. */
export interface AdapterArgs {
    /** Which provider, for errors: two providers can share a family (OpenRouter and Custom). */
    provider: ProviderId;
    apiKey: string;
    /**
     * An operator's base URL. Only a provider whose registry entry has `editableBaseUrl` (Custom)
     * ever has one: `callLlm` withholds it from every other, and the Anthropic and Gemini
     * adapters ignore it regardless. A URL a tenant could point elsewhere would be a way to send
     * the platform's key to a server of their choosing.
     */
    baseUrl?: string;
    model: string;
    system: string;
    user: string | LlmTurn[];
    schema: LlmSchema;
    /**
     * Caps the whole answer, thinking included: Opus 5.5 and every Gemini thinking model spend
     * this on reasoning first, so a limit sized for the visible JSON alone ends in `max_tokens`.
     */
    maxTokens: number;
    effort: Effort;
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
}

/**
 * What an adapter returns. `text`, not parsed JSON: `callLlm` looks at `stopReason` first,
 * because a refusal or a cut-off answer is text that does not parse and the right error is the
 * refusal, not "bad output".
 */
export interface AdapterResult {
    /** The model's answer, as text. Thinking is not in it. */
    text: string;
    /** Everything the call was billed for, summed over `billed`. */
    usage: Usage;
    /** The same, per model, so each can be priced at its own rate. */
    billed: Billed[];
    /** The model that answered. Anthropic's server-side fallback can make it differ from the one asked for. */
    model: string;
    stopReason: StopReason;
    /** The provider's own reason when there is one worth showing: a refusal's category, Gemini's finishReason. */
    detail?: string;
}

export type Adapter = (args: AdapterArgs) => Promise<AdapterResult>;

/** What listing a provider's models and checking its key need (P20b implements both). */
export type ProviderQuery = Pick<AdapterArgs, 'provider' | 'apiKey' | 'baseUrl' | 'signal' | 'fetchImpl'>;
/** A key that passed. One that did not throws an `AiError`; `warning` is for a key that works but should be looked at. */
export type KeyCheck = { ok: true; warning?: string };

/**
 * What a wire family provides. Only `generate` exists in P20a; the rest are the seams P20b fills
 * so that nothing in `callLlm` has to be reordered to make room:
 *
 *   - `normalize` runs on the parsed answer, before its shape is checked: undoing what the
 *     family did to the schema (OpenAI strict mode's `null`s are `dropNulls`'s to remove).
 *   - `listModels` is the provider's model list, for "Load models".
 *   - `checkKey` is the free call a key must pass before it is saved.
 */
export interface FamilyAdapter {
    generate: Adapter;
    normalize?: (json: unknown, schema: LlmSchema) => unknown;
    listModels?: (query: ProviderQuery) => Promise<string[]>;
    checkKey?: (query: ProviderQuery) => Promise<KeyCheck>;
}
