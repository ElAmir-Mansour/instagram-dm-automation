/**
 * `generateJson`: one structured answer from one provider, or an `AiError` that says why not.
 *
 * What the function promises is as much a list of things it will not do:
 *
 *   - It never retries. A retry belongs to the caller's state machine, which knows the deadline
 *     and the budget; one made in here would bill twice and hide a broken key behind a slow
 *     success. `AiError.retryable` says whether the caller may.
 *   - It never falls back to another provider. The one fallback in the library is Anthropic's own,
 *     server-side, inside a single request (see adapters/anthropic.ts).
 *   - It looks at *why the model stopped* before it looks at what it said. A refusal or an answer
 *     cut off by `maxTokens` is text that does not parse, and "not valid JSON" would be the wrong
 *     thing to tell anyone.
 *   - It sends the platform's key only where the registry says: a base URL is honoured for a
 *     provider whose entry has an editable one (Custom), and then only if it is a public https
 *     address. For every other provider it is ignored (as is `jsonMode`, which only Custom has).
 *   - It leaves nothing of the key behind: not in an error message, not in a thrown object.
 *
 * `callLlm` is the call itself. `generateJson` is what callers use, so that a test (or, in P20c,
 * the router that resolves a purpose to a provider, key and model) can stand in front of it with
 * `setLlmCaller`.
 */
import { log } from '../../utils/log.js';
import { ADAPTERS, adapterFor, type FamilyAdapters } from './adapters/index.js';
import { AiError, isAiError } from './errors.js';
import { minOutputTokens } from './limits.js';
import { checkBaseUrl, providerById, providerName, type ProviderId } from './registry.js';
import { matchesRoot, missingRequired, rootKind, type LlmSchema } from './schema.js';
import {
    DEFAULT_EFFORT, isJsonMode, type AdapterResult, type Billed, type Effort, type FetchLike, type JsonMode, type LlmTurn, type StopReason, type Usage,
} from './types.js';

/** No call may take longer than this, whatever a caller asks for: a serverless function has its own ceiling. */
export const MAX_TIMEOUT_MS = 150_000;

export interface GenerateJsonArgs {
    provider: ProviderId;
    apiKey: string;
    model: string;
    /** Only Custom takes one; for every other provider it is ignored. */
    baseUrl?: string;
    /** Only Custom takes one: how the endpoint is asked for JSON, `schema` unless told `object`. Ignored for every other provider. */
    jsonMode?: JsonMode;
    system: string;
    user: string | LlmTurn[];
    schema: LlmSchema;
    /** Caps the whole answer, thinking included. Size it for the reasoning as well as the JSON. A positive integer. */
    maxTokens: number;
    /** One deadline for the whole call, connection and body. A positive integer of milliseconds, capped at 150 000. */
    timeoutMs: number;
    /** Default medium. */
    effort?: Effort;
    /** For tests. */
    fetchImpl?: FetchLike;
}

export interface GenerateJsonResult {
    json: unknown;
    /** Everything the call was billed for. */
    usage: Usage;
    /** The same per model, for pricing (`costOf`). More than one entry only after a server-side fallback. */
    billed: Billed[];
    /** The model that answered. Anthropic's server-side fallback can make it differ from `args.model`. */
    model: string;
    provider: ProviderId;
    stopReason: StopReason;
    elapsed_ms: number;
}

/**
 * JSON out of a model's text. Structured output makes it plain JSON, but a Custom endpoint that
 * only does JSON mode may wrap it in a code fence or a sentence, so those are tolerated:
 * the text as is, then the fenced block, then whatever sits between the first brace or bracket
 * and the last. `undefined` when none of them parses.
 */
export function parseModelJson(text: string): { value: unknown } | undefined {
    const attempts: string[] = [text.trim()];
    const fenced = attempts[0]!.match(/^```[a-z]*\s*\n?([\s\S]*?)\n?```$/i);
    if (fenced) attempts.push(fenced[1]!.trim());
    const open = attempts[0]!.search(/[{[]/);
    const close = Math.max(attempts[0]!.lastIndexOf('}'), attempts[0]!.lastIndexOf(']'));
    if (open >= 0 && close > open) attempts.push(attempts[0]!.slice(open, close + 1));
    for (const attempt of attempts) {
        if (!attempt) continue;
        try {
            return { value: JSON.parse(attempt) };
        } catch {
            // Try the next reading.
        }
    }
    return undefined;
}

/**
 * Whatever an adapter threw, as an `AiError`: its own, or a deadline, or something unforeseen.
 * Something unforeseen is a bug in what was asked or in this code, and asking again will not fix
 * it, so it is `bad_request` (final), not `server`: a retry loop would run it to its limit.
 */
function asAiError(err: unknown, args: GenerateJsonArgs, key: string): AiError {
    if (isAiError(err)) return err;
    const name = (err as { name?: string } | null)?.name;
    const aborted = name === 'AbortError' || name === 'TimeoutError';
    return new AiError({
        kind: aborted ? 'timeout' : 'bad_request',
        provider: args.provider,
        model: args.model,
        message: aborted ? `${providerName(args.provider)} did not answer in time.` : `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
        key,
    });
}

const isPositiveInteger = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** The real call: the provider named in `args`. `adapters` is for tests; production uses the registry's. */
export async function callLlm(args: GenerateJsonArgs, adapters: FamilyAdapters = ADAPTERS): Promise<GenerateJsonResult> {
    const key = (args.apiKey ?? '').trim();
    const name = providerName(args.provider);
    const fail = (kind: AiError['kind'], message: string, answer?: AdapterResult) =>
        new AiError({ kind, provider: args.provider, model: args.model, message, key, usage: answer?.usage, billed: answer?.billed });

    // Before anything else, and before a request exists: a limit of 0, NaN or "5000" would otherwise
    // reach a provider (or `AbortSignal.timeout`) as something it does not mean.
    if (!isPositiveInteger(args.timeoutMs)) throw fail('bad_request', `timeoutMs must be a positive whole number of milliseconds, not ${String(args.timeoutMs).slice(0, 20)}.`);
    if (!isPositiveInteger(args.maxTokens)) throw fail('bad_request', `maxTokens must be a positive whole number, not ${String(args.maxTokens).slice(0, 20)}.`);
    const timeoutMs = Math.min(args.timeoutMs, MAX_TIMEOUT_MS);

    const def = providerById(args.provider);
    if (!def) throw fail('bad_request', `Unknown AI provider "${String(args.provider).slice(0, 40)}".`);
    if (def.keyRequired && !key) throw fail('no_provider', `No API key is saved for ${name}.`);

    // The one place an address typed by someone reaches a request, so the one place it is checked.
    let baseUrl: string | undefined;
    if (def.editableBaseUrl) {
        const raw = args.baseUrl?.trim();
        if (!raw) throw fail('bad_request', `${name} has no base URL.`);
        const checked = checkBaseUrl(raw);
        if (!checked.ok) throw fail('bad_request', `${name}'s base URL ${checked.reason}.`);
        baseUrl = checked.url;
    }
    // The same: only Custom has the choice, and a value that is not one of the two is a settings bug.
    let jsonMode: JsonMode | undefined;
    if (def.editableBaseUrl && args.jsonMode !== undefined) {
        if (!isJsonMode(args.jsonMode)) throw fail('bad_request', `${name}'s JSON mode must be "schema" or "object", not "${String(args.jsonMode).slice(0, 20)}".`);
        jsonMode = args.jsonMode;
    }
    const family = adapterFor(def.family, args, adapters);

    // A limit below what a model of this kind needs to think and answer is the caller's to decide,
    // but not to be surprised by: such a call is likely to end as `max_tokens` after being billed.
    const effort = args.effort ?? DEFAULT_EFFORT;
    const recommended = minOutputTokens(args.provider, args.model, effort);
    if (args.maxTokens < recommended) {
        log('warn', 'llm.max_tokens_low', { provider: args.provider, model: args.model, effort, limit: args.maxTokens, recommended });
    }

    const started = Date.now();
    let answer: AdapterResult;
    try {
        answer = await family.generate({
            provider: args.provider, apiKey: key, baseUrl, jsonMode, model: args.model, system: args.system, user: args.user,
            schema: args.schema, maxTokens: args.maxTokens, effort,
            // One deadline for the call, however many awaits the adapter makes.
            signal: AbortSignal.timeout(timeoutMs), fetchImpl: args.fetchImpl,
        });
    } catch (err) {
        throw asAiError(err, args, key);
    }

    // Why it stopped, before what it said. Both cases were billed, so the tokens go with the error.
    const detail = answer.detail ? ` (${answer.detail})` : '';
    if (answer.stopReason === 'refusal') throw fail('refusal', `${name} declined to answer${detail}.`, answer);
    if (answer.stopReason === 'max_tokens') {
        throw fail('max_tokens', `The answer was cut off at the ${args.maxTokens}-token limit, which covers the model's thinking too.`, answer);
    }

    if (!answer.text.trim()) throw fail('bad_output', `${name} answered with no text${detail}.`, answer);
    const parsed = parseModelJson(answer.text);
    if (!parsed) throw fail('bad_output', `${name}'s answer is not valid JSON.`, answer);

    // The family's own undoing of what it did to the schema, before the shape is judged.
    let json = parsed.value;
    if (family.normalize) {
        try {
            json = family.normalize(json, args.schema);
        } catch (err) {
            throw fail('bad_output', `${name}'s answer could not be read back into the schema: ${err instanceof Error ? err.message : String(err)}`, answer);
        }
    }
    const kind = rootKind(args.schema);
    if (!matchesRoot(json, kind)) throw fail('bad_output', `${name}'s answer is not a JSON ${kind}.`, answer);
    // Structured output is a request, not a guarantee: some endpoints behind OpenRouter treat
    // `strict` as a hint. The top-level keys the schema requires are cheap to check here, so a
    // missing one is bad_output (retryable once) instead of a surprise in the caller's code.
    const missing = missingRequired(json, args.schema);
    if (missing.length) {
        throw fail('bad_output', `${name}'s answer is missing ${missing.length === 1 ? 'a required field' : 'required fields'}: ${missing.slice(0, 6).join(', ')}.`, answer);
    }

    return {
        json,
        usage: answer.usage,
        billed: answer.billed,
        model: answer.model,
        provider: args.provider,
        stopReason: answer.stopReason,
        elapsed_ms: Date.now() - started,
    };
}

export type LlmCaller = (args: GenerateJsonArgs) => Promise<GenerateJsonResult>;

let llmCaller: LlmCaller = callLlm;

/**
 * Swaps the module's model call (tests, and the later PRs that route through here). Returns the
 * previous one, like `setModelCaller` in studio/generate.ts, so a test can put it back.
 */
export function setLlmCaller(next: LlmCaller): LlmCaller {
    const previous = llmCaller;
    llmCaller = next;
    return previous;
}

/** One structured answer, from `callLlm` or whatever `setLlmCaller` put in its place. */
export function generateJson(args: GenerateJsonArgs): Promise<GenerateJsonResult> {
    return llmCaller(args);
}
