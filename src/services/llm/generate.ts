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
 *   - It leaves nothing of the key behind: not in an error message, not in a thrown object.
 */
import { adapterFor } from './adapters/index.js';
import { AiError, isAiError } from './errors.js';
import { providerById, providerName, type ProviderId } from './registry.js';
import { matchesRoot, rootKind, type LlmSchema } from './schema.js';
import { DEFAULT_EFFORT, type Effort, type FetchLike, type LlmTurn, type StopReason, type Usage } from './types.js';

export interface GenerateJsonArgs {
    provider: ProviderId;
    apiKey: string;
    model: string;
    /** Only Custom needs one; the others have a base URL in the registry. */
    baseUrl?: string;
    system: string;
    user: string | LlmTurn[];
    schema: LlmSchema;
    /** Caps the whole answer, thinking included. Size it for the reasoning as well as the JSON. */
    maxTokens: number;
    /** One deadline for the whole call, connection and body. */
    timeoutMs: number;
    /** Default medium. */
    effort?: Effort;
    /** For tests. */
    fetchImpl?: FetchLike;
}

export interface GenerateJsonResult {
    json: unknown;
    usage: Usage;
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

/** Whatever an adapter threw, as an `AiError`: its own, or a deadline, or something unforeseen. */
function asAiError(err: unknown, args: GenerateJsonArgs, key: string): AiError {
    if (isAiError(err)) return err;
    const name = (err as { name?: string } | null)?.name;
    const aborted = name === 'AbortError' || name === 'TimeoutError';
    return new AiError({
        kind: aborted ? 'timeout' : 'server',
        provider: args.provider,
        model: args.model,
        message: aborted ? `${providerName(args.provider)} did not answer in time.` : `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`,
        key,
    });
}

/** The real call: the provider named in `args`. */
export async function callProvider(args: GenerateJsonArgs): Promise<GenerateJsonResult> {
    const key = (args.apiKey ?? '').trim();
    const name = providerName(args.provider);
    const fail = (kind: AiError['kind'], message: string, usage?: Usage) =>
        new AiError({ kind, provider: args.provider, model: args.model, message, key, usage });

    const def = providerById(args.provider);
    if (!def) throw fail('bad_request', `Unknown AI provider "${String(args.provider).slice(0, 40)}".`);
    if (def.keyRequired && !key) throw fail('no_provider', `No API key is saved for ${name}.`);
    const baseUrl = args.baseUrl?.trim() || undefined;
    if (!baseUrl && !def.baseUrl) throw fail('bad_request', `${name} has no base URL.`);
    const adapter = adapterFor(def.family, args);

    const started = Date.now();
    let answer;
    try {
        answer = await adapter({
            provider: args.provider, apiKey: key, baseUrl, model: args.model, system: args.system, user: args.user,
            schema: args.schema, maxTokens: args.maxTokens, effort: args.effort ?? DEFAULT_EFFORT,
            // One deadline for the call, however many awaits the adapter makes.
            signal: AbortSignal.timeout(args.timeoutMs), fetchImpl: args.fetchImpl,
        });
    } catch (err) {
        throw asAiError(err, args, key);
    }

    // Why it stopped, before what it said. Both cases were billed, so the tokens go with the error.
    const detail = answer.detail ? ` (${answer.detail})` : '';
    if (answer.stopReason === 'refusal') throw fail('refusal', `${name} declined to answer${detail}.`, answer.usage);
    if (answer.stopReason === 'max_tokens') {
        throw fail('max_tokens', `The answer was cut off at the ${args.maxTokens}-token limit, which covers the model's thinking too.`, answer.usage);
    }

    if (!answer.text.trim()) throw fail('bad_output', `${name} answered with no text${detail}.`, answer.usage);
    const parsed = parseModelJson(answer.text);
    if (!parsed) throw fail('bad_output', `${name}'s answer is not valid JSON.`, answer.usage);
    const kind = rootKind(args.schema);
    if (!matchesRoot(parsed.value, kind)) throw fail('bad_output', `${name}'s answer is not a JSON ${kind}.`, answer.usage);

    return {
        json: parsed.value,
        usage: answer.usage,
        model: answer.model,
        provider: args.provider,
        stopReason: answer.stopReason,
        elapsed_ms: Date.now() - started,
    };
}

export type LlmCaller = (args: GenerateJsonArgs) => Promise<GenerateJsonResult>;

let llmCaller: LlmCaller = callProvider;

/**
 * Swaps the module's model call (tests, and the later PRs that route through here). Returns the
 * previous one, like `setModelCaller` in studio/generate.ts, so a test can put it back.
 */
export function setLlmCaller(next: LlmCaller): LlmCaller {
    const previous = llmCaller;
    llmCaller = next;
    return previous;
}

/** One structured answer, from `callProvider` or whatever `setLlmCaller` put in its place. */
export function generateJson(args: GenerateJsonArgs): Promise<GenerateJsonResult> {
    return llmCaller(args);
}
