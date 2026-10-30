/**
 * OpenAI's Responses API, asked for JSON.
 *
 * Shapes verified against developers.openai.com on 2026-10-13 (the Responses reference, the
 * structured-outputs, reasoning and migrate-to-responses guides, the models pages, the models
 * list reference and the error-codes guide):
 *
 *   - The schema goes in `text.format` as `{type: 'json_schema', name, schema, strict: true}`,
 *     flattened, not nested under `json_schema` as Chat Completions has it. `name` is `a-zA-Z0-9_-`.
 *   - Strict mode wants every property required, optional ones nullable, every object closed, and
 *     an object at the root (never `anyOf`): `strictify` makes the first three, the fourth is a
 *     `bad_request` before anything is sent. `dropNulls` (the family's `normalize`) undoes it.
 *   - `store: false`: nothing of a tenant's prompt is kept in the account (the API default is
 *     true). There is no multi-turn state to keep: a repair round resends its turns.
 *   - The system prompt is `instructions`; the turns are `input` messages with string content.
 *   - `reasoning.effort` takes `none | minimal | low | medium | high | xhigh | max`, but which
 *     of them a model takes varies and an unsupported one is a 400, so the top level sent is a
 *     small table by model name, and a level above it is sent as the top one:
 *       gpt-6* and gpt-5.6*  all five of ours (the models page lists low through max for Astra, Sol
 *                            and Luna; 5.6 is listed as an effort-taking model)
 *       gpt-5.5*             up to `xhigh`: `max` is sent as `xhigh`
 *       other gpt-5.x, o-series, and anything this table has not met (gpt-7 and later, a gpt-6
 *       `-pro` id, which OpenAI's page describes as a reasoning mode rather than a model):
 *                            up to `high`, the one level every reasoning model is known to have.
 *                            A call is never retried, so a 400 for a level that was guessed is
 *                            worse than a little less effort.
 *     A model that does not reason (GPT-4.x, GPT-4o, `*-chat-*`) gets no `reasoning` at all, which
 *     is always safe.
 *   - `max_output_tokens` covers visible output and reasoning together. OpenAI recommends
 *     reserving at least 25 000 for both on its reasoning models, and `maxTokens` is not raised
 *     here: it is the caller's spending cap, so a route that uses OpenAI has to size it for the
 *     thinking (a limit that is too small ends as `max_tokens`, billed for the reasoning).
 *   - The answer is `output[]`: a `message` item whose `content` has `output_text` parts and, if
 *     the model declined, a `refusal` part (checked before the text is parsed). `reasoning` items
 *     sit beside it and are not the answer. A response that stopped short has `status:
 *     'incomplete'` with `incomplete_details.reason`: `max_output_tokens`, `content_filter`,
 *     and two (`max_messages`, `steered`) this library's requests cannot cause. `status:
 *     'failed'` is a 200 whose `error` says what happened.
 *   - Usage is `input_tokens` and `output_tokens`, the latter including reasoning
 *     (`output_tokens_details.reasoning_tokens` is a part of it, not an addition).
 *
 * The key is `Authorization: Bearer`, in that header and nowhere else. The base URL is OpenAI's,
 * always: an operator's URL would be somewhere to send the key.
 */
import { totalUsage } from '../cost.js';
import { AiError, type AiErrorKind } from '../errors.js';
import { providerName } from '../registry.js';
import { EFFORTS, type Adapter, type AdapterArgs, type AdapterResult, type Billed, type Effort, type FamilyAdapter, type LlmTurn, type ProviderQuery, type StopReason } from '../types.js';
import { prepareQuery } from './endpoint.js';
import { refuseMedia } from './media.js';
import { getJson, postJson } from './post.js';
import { dropStrictNulls, SCHEMA_NAME, strictSchemaFor } from './strict.js';

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** `gpt-6.1-sol` → 6.1, `gpt-5-mini` → 5.0, `o3` → o-series. Anything else is a model this code has not met. */
function generation(model: string): { kind: 'gpt'; major: number; minor: number } | { kind: 'o' } | undefined {
    const gpt = model.toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?(?![\d.])/);
    if (gpt) return { kind: 'gpt', major: Number(gpt[1]), minor: gpt[2] ? Number(gpt[2]) : 0 };
    return /^o\d+(?:-|$)/i.test(model) ? { kind: 'o' } : undefined;
}

/**
 * Whether the model takes `reasoning.effort`: the o-series (but not o1-mini or o1-preview, which
 * reason without a dial) and GPT-5 and later (but not the `-chat-` models, which do not reason,
 * nor GPT-5's `-pro` models, which each take one level of their own). A name this code does not
 * recognise gets none: unlike a new Claude, a new OpenAI name is as likely to be an embedding
 * model or a fine-tune as a successor, and no `reasoning` is the one choice that cannot 400.
 */
export function supportsReasoning(model: string): boolean {
    const g = generation(model);
    if (!g) return false;
    if (g.kind === 'o') return !/^o1-(?:mini|preview)/i.test(model);
    if (/-chat(?:-|$)/i.test(model)) return false;
    if (g.major < 5) return false;
    return !(g.major === 5 && /-pro(?:-|$)/i.test(model));
}

/** The highest `reasoning.effort` this model is known to take (see the file comment for the table). */
function topEffort(model: string): Effort {
    const g = generation(model);
    if (!g || g.kind === 'o') return 'high';
    if (g.major === 6 && !/-pro(?:-|$)/i.test(model)) return 'max';
    if (g.major === 5 && g.minor === 6) return 'max';
    if (g.major === 5 && g.minor === 5) return 'xhigh';
    return 'high';
}

/** What to send for `effort` on this model, or nothing: the level asked for, or the top one the model takes if that is lower. */
export function reasoningEffortFor(model: string, effort: Effort): Effort | undefined {
    if (!supportsReasoning(model)) return undefined;
    const top = topEffort(model);
    return EFFORTS.indexOf(effort) > EFFORTS.indexOf(top) ? top : effort;
}

/**
 * The smallest `maxTokens` worth asking an OpenAI reasoning model for. `max_output_tokens` covers
 * the reasoning as well as the answer, and OpenAI's reasoning guide recommends "reserving at least
 * 25,000 tokens for reasoning and outputs" (it is a cap, not a charge). A smaller limit can end as
 * `max_tokens` after being billed for the thinking, with no visible output. The adapter does not
 * raise a caller's limit (it is their spending cap); `minOutputTokens` (limits.ts) is what tells
 * them, and `callLlm` logs a warning when a call is below it.
 */
export const OPENAI_REASONING_MIN_OUTPUT = 25_000;

/** The turns as Responses `input` messages. */
function inputFor(user: string | LlmTurn[]): Array<{ role: 'user' | 'assistant'; content: string }> {
    if (typeof user === 'string') return [{ role: 'user', content: user }];
    return user.map((t) => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.text }));
}

export function buildOpenAiRequest(a: AdapterArgs): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    // Only Meta is sent pictures and video here: a turn that carries any is refused before a request exists.
    refuseMedia(a);
    // A schema OpenAI would refuse is refused here, saying what to change and before a billed call.
    const schema = strictSchemaFor(a, { objectRoot: true });
    const effort = reasoningEffortFor(a.model, a.effort);
    return {
        url: `${OPENAI_BASE_URL}/responses`,
        // The key is here and nowhere else: not in the URL, not in the body.
        headers: { authorization: `Bearer ${a.apiKey}` },
        body: {
            model: a.model,
            // An empty `instructions` is not a system prompt; leave it out rather than send one.
            ...(a.system.trim() ? { instructions: a.system } : {}),
            input: inputFor(a.user),
            text: { format: { type: 'json_schema', name: SCHEMA_NAME, schema, strict: true } },
            store: false,
            max_output_tokens: a.maxTokens,
            ...(effort ? { reasoning: { effort } } : {}),
        },
    };
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

type Call = Pick<AdapterArgs, 'provider' | 'model' | 'apiKey'>;

/** A `failed` response's own error code, in the library's kinds: only a limit that lifts and a fault of OpenAI's are worth asking again for. */
function failureKind(code: unknown): AiErrorKind {
    if (code === 'rate_limit_exceeded') return 'rate';
    return code === 'server_error' || code === 'vector_store_timeout' ? 'server' : 'bad_request';
}

export function parseOpenAiResponse(data: any, a: Call): AdapterResult {
    const name = providerName(a.provider);
    const usage = data?.usage;
    // The model asked for: `data.model` is a dated snapshot (`gpt-6-astra-2026-09-01`) that no price table has.
    const billed: Billed[] = [{ model: a.model, in: count(usage?.input_tokens), out: count(usage?.output_tokens) }];
    const status: unknown = data?.status;

    // A 200 that says the response failed or was cancelled: billed, so the tokens go with the error.
    if (status === 'failed' || status === 'cancelled' || status === 'in_progress' || status === 'queued') {
        const said = typeof data?.error?.message === 'string' ? data.error.message : '';
        throw new AiError({
            kind: status === 'failed' ? failureKind(data?.error?.code) : 'server',
            provider: a.provider, model: a.model, key: a.apiKey,
            message: said || `${name} did not complete the response (${status}).`,
            ...(billed[0]!.in || billed[0]!.out ? { usage: totalUsage(billed), billed } : {}),
        });
    }

    const items: unknown[] = Array.isArray(data?.output) ? data.output : [];
    const text: string[] = [];
    const refusals: string[] = [];
    for (const item of items) {
        if ((item as any)?.type !== 'message' || !Array.isArray((item as any).content)) continue;
        for (const part of (item as any).content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') text.push(part.text);
            else if (part?.type === 'refusal' && typeof part.refusal === 'string') refusals.push(part.refusal);
        }
    }

    const reason: unknown = data?.incomplete_details?.reason;
    let stopReason: StopReason = 'end_turn';
    let detail: string | undefined;
    if (refusals.length) {
        stopReason = 'refusal';
        detail = refusals.join(' ').trim() || undefined;
    } else if (status === 'incomplete' && reason === 'content_filter') {
        stopReason = 'refusal';
        detail = 'content_filter';
    } else if (status === 'incomplete' && reason === 'max_output_tokens') {
        stopReason = 'max_tokens';
    } else if (status === 'incomplete' && typeof reason === 'string') {
        detail = `incomplete: ${reason}`;
    }
    return { text: text.join(''), usage: totalUsage(billed), billed, model: a.model, stopReason, ...(detail ? { detail } : {}) };
}

export const openaiAdapter: Adapter = async (a) => {
    const request = buildOpenAiRequest(a);
    const data = await postJson({
        provider: a.provider, model: a.model, key: a.apiKey, signal: a.signal, fetchImpl: a.fetchImpl, ...request,
    });
    return parseOpenAiResponse(data, a);
};

/**
 * Ids that are not for writing text: embeddings, speech and transcription, images and video,
 * realtime and audio, moderation, the legacy completion models, and the ones that are not
 * Responses chat models either (deep-research, which needs tools, and the `-instruct` models).
 * "Load models" feeds a picker for a model that answers in JSON; any other id can still be typed in.
 */
const NOT_FOR_TEXT = /embedding|whisper|tts|transcribe|dall-e|gpt-image|image-|sora|moderation|realtime|audio|-live|davinci|babbage|computer-use|deep-research|-instruct(?:-|$)/i;

/** Newest first, which is what a picker wants and what `GET /models` does not give: it has `created`, not an order. */
function textModels(body: unknown): string[] {
    const list: any[] = Array.isArray((body as any)?.data) ? (body as any).data : [];
    const sorted = list
        .filter((m) => typeof m?.id === 'string' && !NOT_FOR_TEXT.test(m.id))
        .map((m, i) => ({ id: m.id as string, created: typeof m.created === 'number' ? m.created : 0, i }))
        .sort((x, y) => y.created - x.created || x.i - y.i);
    return [...new Set(sorted.map((m) => m.id))];
}

/** `GET /models`, with the key in `Authorization` and nowhere else. */
function getModels(q: ProviderQuery): Promise<unknown> {
    const { key, signal } = prepareQuery(q);
    return getJson({ provider: q.provider, model: '', url: `${OPENAI_BASE_URL}/models`, headers: { authorization: `Bearer ${key}` }, key, signal, fetchImpl: q.fetchImpl });
}

export const openaiFamily: FamilyAdapter = {
    generate: openaiAdapter,
    normalize: dropStrictNulls,
    listModels: async (q) => textModels(await getModels(q)),
    // `GET /models` takes no input and bills nothing; a bad key is a 401, and that is all it can say.
    checkKey: async (q) => {
        await getModels(q);
        return { ok: true };
    },
};
