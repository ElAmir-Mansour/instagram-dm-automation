/**
 * Anthropic's Messages API, asked for JSON.
 *
 * Shapes verified against platform.claude.com on 2026-10-13 (structured-outputs, effort,
 * refusals-and-fallback, api/errors, api/rate-limits):
 *
 *   - The schema goes in `output_config.format` as `{type: 'json_schema', schema}`. The older
 *     top-level `output_format` is deprecated and needs a beta header; this needs none.
 *   - `output_config.effort` is `low | medium | high | xhigh | max`, GA, no header. Opus 5.5 and
 *     Haiku 5.5 default to medium, everything else to high, so it is always sent explicitly: the
 *     answer should not depend on which model happens to be configured.
 *   - No sampling parameters. The 5.x models ignore or refuse them, and effort is the dial.
 *   - The answer is the `text` blocks of `content`. `thinking` blocks and, after a server-side
 *     fallback, a `fallback` marker sit beside them and are not part of the answer.
 *   - `stop_reason: 'refusal'` is a 200, not an error, with the category in `stop_details`.
 *     `max_tokens` is the cut-off. Thinking counts against `max_tokens`.
 *   - Objects must be closed (`additionalProperties: false`), which `toJsonSchema` already does.
 *     A schema may have at most 24 optional properties and 16 union-typed ones, or it is a 400
 *     that only says it is too complex; `buildAnthropicRequest` counts first.
 *
 * Server-side fallback (`fallbacks: "default"` with `anthropic-beta: server-side-fallback-2026-07-01`)
 * re-runs a request the safety classifier declined on the model Anthropic recommends for that
 * category, inside the same call. It is the one fallback this library allows, because it is
 * Anthropic's, visible, and billed: the response's `model` names who answered, and
 * `usage.iterations` lists every model that ran. Those iterations are what was billed, so they
 * are what `billed` is made of; the top-level `usage` is the last attempt only. It is sent only to
 * the models the docs say have it: Haiku 5.5 has none, and an older model may reject the parameter.
 *
 * The base URL is Anthropic's, always. An operator's URL would be somewhere to send the key.
 */
import { AiError } from '../errors.js';
import { totalUsage } from '../cost.js';
import { jsonSchemaFor, schemaComplexity } from '../schema.js';
import type { Adapter, AdapterArgs, AdapterResult, Billed, Effort, FamilyAdapter, LlmTurn, StopReason } from '../types.js';
import { postJson } from './post.js';

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The documented limits on structured-output schemas (structured-outputs, "Schema complexity limits"). */
export const MAX_OPTIONAL_PROPERTIES = 24;
export const MAX_UNION_PROPERTIES = 16;

/** `claude-opus-5-5` → opus, 5, 5; `claude-sonnet-4-20250514` → sonnet, 4, 0. Names that do not fit are a model this code has not met. */
function generation(model: string): { family: string; major: number; minor: number } | undefined {
    const m = model.toLowerCase().match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/);
    return m ? { family: m[1]!, major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 } : undefined;
}

/**
 * Whether the model takes `output_config.effort`. Opus 4.5+, Sonnet 4.6+ and everything 5.x do;
 * Claude 3, Haiku 4.5, Sonnet 4.5 and the 4.0/4.1 models answer 400. A name this code has not
 * met is assumed current, as a new family will be.
 */
export function supportsEffort(model: string): boolean {
    if (/^claude-(?:instant|\d)/i.test(model)) return false;
    const g = generation(model);
    if (!g) return true;
    if (g.major >= 5) return true;
    if (g.major < 4) return false;
    return (g.family === 'opus' && g.minor >= 5) || (g.family === 'sonnet' && g.minor >= 6);
}

/**
 * What to send for `effort` on this model, or nothing. The effort page's level table is not the
 * same for every model that has effort: `max` is on all of them except Opus 4.5, and `xhigh`
 * only on the 5.x models and Opus 4.7 and 4.8. Where the level asked for does not exist, `high`
 * is what is sent.
 */
export function effortFor(model: string, effort: Effort): Effort | undefined {
    if (!supportsEffort(model)) return undefined;
    const g = generation(model);
    const hasMax = !(g && g.family === 'opus' && g.major === 4 && g.minor === 5);
    const hasXhigh = !g || g.major >= 5 || (g.family === 'opus' && g.minor >= 7);
    if ((effort === 'max' && !hasMax) || (effort === 'xhigh' && !hasXhigh)) return 'high';
    return effort;
}

/**
 * Whether the docs give this model server-side fallback: Opus 5.5 and 5, Sonnet 5.5, Fable 5 and
 * 5.1. Not Haiku 5.5 (its refusals stand), not plain Sonnet 5 (a fallback *target*), not 4.x.
 */
export function supportsServerFallback(model: string): boolean {
    return /^claude-(?:opus-5|sonnet-5-5|fable-5)(?:-|$)/i.test(model);
}

/** The turns as Anthropic's `messages`. Claude 4.6 and later refuse a prefilled last assistant turn, so a conversation must end on the user's. */
function messagesFor(user: string | LlmTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
    if (typeof user === 'string') return [{ role: 'user', content: user }];
    return user.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text }));
}

export function buildAnthropicRequest(a: AdapterArgs): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const fallback = supportsServerFallback(a.model);
    const effort = effortFor(a.model, a.effort);

    // A schema Anthropic would refuse is refused here, saying which limit and by how much.
    const schema = jsonSchemaFor(a.schema);
    const { optional, unions } = schemaComplexity(schema);
    const tooComplex = (message: string) => new AiError({ kind: 'bad_request', provider: a.provider, model: a.model, message, key: a.apiKey });
    if (optional > MAX_OPTIONAL_PROPERTIES) {
        throw tooComplex(
            `The answer schema has ${optional} optional properties (not listed in "required") and Anthropic accepts at most ${MAX_OPTIONAL_PROPERTIES}. ` +
                'Make some of them required, or split the request.',
        );
    }
    if (unions > MAX_UNION_PROPERTIES) {
        throw tooComplex(
            `The answer schema has ${unions} union-typed properties (anyOf or type arrays) and Anthropic accepts at most ${MAX_UNION_PROPERTIES}. ` +
                'Give some of them a single type, or split the request.',
        );
    }

    return {
        url: `${ANTHROPIC_BASE_URL}/v1/messages`,
        // The key is here and nowhere else: not in the URL, not in the body.
        headers: {
            'x-api-key': a.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            ...(fallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
        },
        body: {
            model: a.model,
            max_tokens: a.maxTokens,
            // An empty `system` is not a system prompt; leave it out rather than send one.
            ...(a.system.trim() ? { system: a.system } : {}),
            messages: messagesFor(a.user),
            output_config: {
                format: { type: 'json_schema', schema },
                ...(effort ? { effort } : {}),
            },
            ...(fallback ? { fallbacks: 'default' } : {}),
        },
    };
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

function stopReasonOf(reason: unknown): StopReason {
    if (reason === 'refusal') return 'refusal';
    // `model_context_window_exceeded` is a truncation too: the answer stopped short of its end.
    if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'max_tokens';
    return 'end_turn';
}

/**
 * What the call was billed for, per model. `usage.iterations` has one entry per model that ran: a
 * model that declined appears as a `message` entry, the one that answered as `fallback_message`.
 * Without a fallback there is one entry, or none, and the top-level `usage` is the whole bill. We
 * send no `cache_control`, so cache tokens are zero and `input_tokens` is all of the input.
 *
 * This is a ceiling, not an invoice: a refusal that arrives before any output is billed only in
 * three categories (bio, frontier_llm, reasoning_extraction), and its entry is counted here
 * whatever the category. A budget that over-counts a few input tokens is the safe side.
 */
function billedOf(data: any, served: string): Billed[] {
    const iterations: unknown[] = Array.isArray(data?.usage?.iterations) ? data.usage.iterations : [];
    const entries = iterations
        .filter((it: any) => it && typeof it === 'object' && (Number.isFinite(it.input_tokens) || Number.isFinite(it.output_tokens)))
        .map((it: any) => ({
            model: typeof it.model === 'string' && it.model ? it.model : served,
            in: count(it.input_tokens),
            out: count(it.output_tokens),
        }));
    return entries.length ? entries : [{ model: served, in: count(data?.usage?.input_tokens), out: count(data?.usage?.output_tokens) }];
}

export function parseAnthropicResponse(data: any, asked: string): AdapterResult {
    const blocks: unknown[] = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
        .filter((b): b is { type: 'text'; text: string } => (b as any)?.type === 'text' && typeof (b as any).text === 'string')
        .map((b) => b.text)
        .join('');
    const stopReason = stopReasonOf(data?.stop_reason);
    const refusal = data?.stop_details;
    const detail =
        stopReason === 'refusal'
            ? [refusal?.category, refusal?.explanation].filter((v) => typeof v === 'string' && v).join(': ') || undefined
            : undefined;
    // After a server-side fallback this is the model that answered.
    const model = typeof data?.model === 'string' && data.model ? data.model : asked;
    const billed = billedOf(data, model);
    return { text, usage: totalUsage(billed), billed, model, stopReason, ...(detail ? { detail } : {}) };
}

export const anthropicAdapter: Adapter = async (a) => {
    const request = buildAnthropicRequest(a);
    const data = await postJson({
        provider: a.provider, model: a.model, key: a.apiKey, signal: a.signal, fetchImpl: a.fetchImpl, ...request,
    });
    return parseAnthropicResponse(data, a.model);
};

export const anthropicFamily: FamilyAdapter = { generate: anthropicAdapter };
