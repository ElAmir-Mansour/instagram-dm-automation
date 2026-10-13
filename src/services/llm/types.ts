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

/** What a call cost in tokens. Thinking counts as output: every provider bills it at the output rate. */
export type Usage = { input_tokens: number; output_tokens: number };

/** `fetch`, as far as this library needs it: tests hand in a stub, production uses the global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What `generateJson` hands an adapter. */
export interface AdapterArgs {
    /** Which provider, for errors: two providers can share a family (OpenRouter and Custom). */
    provider: ProviderId;
    apiKey: string;
    /** Overrides the registry's base URL (only Custom has none of its own). */
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
 * What an adapter returns. `text`, not parsed JSON: `generateJson` looks at `stopReason` first,
 * because a refusal or a cut-off answer is text that does not parse and the right error is the
 * refusal, not "bad output".
 */
export interface AdapterResult {
    /** The model's answer, as text. Thinking is not in it. */
    text: string;
    usage: Usage;
    /** The model that answered. Anthropic's server-side fallback can make it differ from the one asked for. */
    model: string;
    stopReason: StopReason;
    /** The provider's own reason when there is one worth showing: a refusal's category, Gemini's finishReason. */
    detail?: string;
}

export type Adapter = (args: AdapterArgs) => Promise<AdapterResult>;
