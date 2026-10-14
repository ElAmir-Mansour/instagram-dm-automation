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
 *
 * `in` is the input billed at the full rate. Anthropic's prompt cache splits the prompt in three
 * (usage.input_tokens is the uncached remainder only, so total input is the three added up), and
 * the cached two are kept apart because they are priced apart (`cost.ts`):
 *   - `cacheRead`:  `cache_read_input_tokens`, served from the cache (a fraction of the input price);
 *   - `cacheWrite`: `cache_creation_input_tokens`, written to the cache (1.25x the input price).
 * Both are absent, not zero, when there were none, so a provider with no cache looks as it always did.
 */
export type Usage = { in: number; out: number; cacheRead?: number; cacheWrite?: number };

/**
 * Where a `usd` came from. `provider`: the provider said what it charged (OpenRouter's
 * `usage.cost`), an adapter set it, and `costOf` keeps it. `table`: `costOf` worked it out from
 * the price table (a guess, at the ceiling for a model with no price). Only `provider` is trusted
 * on the way in: a `usd` without it is recomputed, so pricing a result a second time cannot turn
 * a ceiling estimate into a figure that looks like an invoice.
 */
export type CostSource = 'provider' | 'table';

/**
 * One model's share of what a call was billed. Normally a call has one entry; Anthropic's
 * server-side fallback can have several (the model that declined, then the one that answered),
 * each at its own price. An adapter sets `usd` (with `source: 'provider'`) only when the provider
 * reports a charge; otherwise `costOf` (cost.ts) fills in `usd` from the price table and marks it
 * `source: 'table'`.
 */
export type Billed = { model: string; in: number; out: number; cacheRead?: number; cacheWrite?: number; usd?: number; source?: CostSource };

/**
 * How a Custom (OpenAI-compatible) endpoint is asked for JSON. `schema` sends the schema as a
 * strict `json_schema` response format, which is what OpenAI and OpenRouter speak. `object` is
 * for endpoints that only do JSON mode: it sends `{type: 'json_object'}` and describes the schema
 * in the system prompt instead. The operator's setting (`ai.providers.custom.jsonMode`, P20c).
 */
export const JSON_MODES = ['schema', 'object'] as const;
export type JsonMode = (typeof JSON_MODES)[number];
export const isJsonMode = (value: unknown): value is JsonMode => typeof value === 'string' && (JSON_MODES as readonly string[]).includes(value);

/** `fetch`, as far as this library needs it: tests hand in a stub, production uses the global. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What `generateJson` hands an adapter. */
export interface AdapterArgs {
    /** Which provider, for errors: two providers can share a family (OpenRouter and Custom). */
    provider: ProviderId;
    apiKey: string;
    /**
     * An operator's base URL. Only a provider whose registry entry has `editableBaseUrl` (Custom)
     * ever has one: `callLlm` withholds it from every other, and every adapter but Custom's
     * ignores it regardless. A URL a tenant could point elsewhere would be a way to send the
     * platform's key to a server of their choosing.
     */
    baseUrl?: string;
    /**
     * Only Custom reads it: how the endpoint is asked for JSON (default `schema`). `callLlm`
     * withholds it from every other provider, as it does `baseUrl`; OpenRouter is always `schema`.
     */
    jsonMode?: JsonMode;
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
    /**
     * Ask Anthropic to cache the system prompt (`cache_control` on the system block, 5-minute
     * lifetime). Only the Anthropic adapter reads it; every other family ignores it. Absent unless
     * a caller asked: a cache write costs 1.25x the input price, so it is for a prompt that is sent
     * again within minutes, not a default.
     */
    cacheSystem?: boolean;
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

/** What listing a provider's models and checking its key need. */
export type ProviderQuery = Pick<AdapterArgs, 'provider' | 'apiKey' | 'baseUrl' | 'signal' | 'fetchImpl'>;
/** A key that passed. One that did not throws an `AiError`; `warning` is for a key that works but should be looked at. */
export type KeyCheck = { ok: true; warning?: string };

/**
 * What a wire family provides. Every family has `generate`; the rest are optional so that a test
 * (or a family added later) can stand in with only what it needs:
 *
 *   - `normalize` runs on the parsed answer, before its shape is checked: undoing what the
 *     family did to the schema (OpenAI strict mode's `null`s are `dropNulls`'s to remove).
 *   - `listModels` is the provider's model list, for "Load models".
 *   - `checkKey` is the free call a key must pass before it is saved. It throws the `AiError`
 *     of whatever went wrong; what it returns is a pass, possibly with a `warning`.
 *
 * `listModels` and `checkKey` are the family's own: a `ProviderQuery` carries the provider
 * because two providers can share a family (OpenRouter and Custom), and they differ here.
 * `listProviderModels` and `checkProviderKey` (providerQuery.ts) are what callers use.
 */
export interface FamilyAdapter {
    generate: Adapter;
    normalize?: (json: unknown, schema: LlmSchema) => unknown;
    listModels?: (query: ProviderQuery) => Promise<string[]>;
    checkKey?: (query: ProviderQuery) => Promise<KeyCheck>;
}
