/**
 * Chat Completions, the wire format OpenRouter and every OpenAI-compatible endpoint speak:
 * OpenRouter (fixed address) and Custom (an address the operator typed).
 *
 * Shapes verified against openrouter.ai/docs and developers.openai.com on 2026-10-13
 * (structured-outputs, provider-routing, usage-accounting, reasoning-tokens, errors, limits,
 * the API overview, `GET /api/v1/key`, `GET /api/v1/models` read live) with findings that shape
 * the code:
 *
 *   - `response_format: {type: 'json_schema', json_schema: {name, strict: true, schema}}`, nested
 *     (the Responses API flattens it). The schema is strictified, as for OpenAI, and the family's
 *     `normalize` is `dropNulls`. Some OpenRouter providers treat `strict` as a hint, not a
 *     guarantee, so an answer is not trusted to have the shape: `callLlm` checks that it parses,
 *     is the right kind of top-level value, and has every required top-level key (`bad_output`
 *     otherwise, retryable once). Anything deeper is the validator of whoever asked.
 *   - OpenRouter: `provider: {require_parameters: true}`. Without it a request goes to an endpoint
 *     that does not support `response_format` and the schema is silently ignored; with it a model
 *     without structured output fails to route (a 404 that says so) instead of answering in prose.
 *   - OpenRouter documents `usage: {include: true}` as deprecated with no effect: "full usage
 *     details are now always included". It is not sent. `usage.cost` is the amount charged, in
 *     credits (one dollar each), and becomes `billed[].usd` with `source: 'provider'`, which
 *     `costOf` prefers to its table: OpenRouter's models change prices and `openrouter/auto` has
 *     none. On a BYOK call (`is_byok`) `cost` is only OpenRouter's fee and the provider billed the
 *     rest, which `cost_details.upstream_inference_cost` reports: the two are added, and without
 *     that figure the table's estimate stands.
 *   - `max_tokens`, not `max_completion_tokens`: OpenRouter documents both with the same meaning
 *     (covering reasoning and output together), `max_tokens` is the one every compatible endpoint
 *     reads, and with `require_parameters` the narrower name could fail to route.
 *   - Reasoning: OpenRouter's `reasoning: {effort}` takes our five names, but a request that names
 *     a parameter the model lacks cannot be routed under `require_parameters`, and its list marks
 *     non-reasoning models only by omission. So it is sent only for `openai/` models that take
 *     reasoning (the same rule as the Responses adapter, whose 400s it would otherwise hit). Any
 *     other model reasons as it does by default. Custom gets none: an unknown server may
 *     reject a field it does not know, and the call is never retried.
 *   - `finish_reason` is normalised by OpenRouter to `stop | length | tool_calls | content_filter
 *     | error`: `length` is `max_tokens`, `content_filter` a refusal, `message.refusal` too, and
 *     `error` (or a top-level `error`) is a failure that came back as a 200: "check the response
 *     body for an error on every request". A 403 is read by its body (`classify403`, errors.ts):
 *     a moderation flag or a guardrail is a refusal, a spent key limit is `quota`, the rest `auth`.
 *   - No attribution headers (`HTTP-Referer`, `X-Title`): they are optional, and they would name
 *     this deployment to a third party from a constant, where owner-facing values are settings.
 *
 * Custom's JSON mode (`jsonMode`, the operator's setting): `schema` as above, or `object` for an
 * endpoint that only does JSON mode: `{type: 'json_object'}` plus the schema described in the
 * system prompt (JSON mode errors unless the word "JSON" is in the conversation, and promises
 * valid JSON, not this schema). OpenRouter is always `schema`.
 *
 * The key is `Authorization: Bearer`, in that header and nowhere else (none for a keyless Custom
 * endpoint). OpenRouter's address is fixed; Custom's is checked by `endpointFor` every time.
 */
import { totalUsage } from '../cost.js';
import { AiError, errorFromHttp } from '../errors.js';
import { providerName } from '../registry.js';
import { jsonSchemaFor, rootKind } from '../schema.js';
import type { Adapter, AdapterArgs, AdapterResult, Billed, FamilyAdapter, LlmTurn, ProviderQuery, StopReason } from '../types.js';
import { endpointFor, modelIdsFrom, prepareQuery } from './endpoint.js';
import { reasoningEffortFor } from './openai.js';
import { getJson, postJson } from './post.js';
import { dropStrictNulls, SCHEMA_NAME, strictSchemaFor } from './strict.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** `openai/gpt-6.1-sol:batch` → `gpt-6.1-sol`: the vendor and the routing variant are not part of the model's name. */
const bareName = (model: string): string => model.replace(/^[^/]+\//, '').replace(/:[^:]*$/, '');

/** The reasoning request OpenRouter takes for this model, or none (see the file comment for why it is rare). */
export function openRouterReasoning(model: string, effort: AdapterArgs['effort']): { effort: AdapterArgs['effort'] } | undefined {
    if (!/^openai\//i.test(model)) return undefined;
    const sent = reasoningEffortFor(bareName(model), effort);
    return sent ? { effort: sent } : undefined;
}

/** The schema as a paragraph for the system prompt, for an endpoint that can only be asked for "a JSON object". */
function describedSchema(a: AdapterArgs): string {
    return `Answer with a single JSON object and nothing else, one that matches this JSON Schema:\n${JSON.stringify(jsonSchemaFor(a.schema))}`;
}

function messagesFor(system: string, user: string | LlmTurn[]): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const turns = typeof user === 'string' ? [{ role: 'user' as const, content: user }] : user.map((t) => ({ role: t.role === 'model' ? ('assistant' as const) : ('user' as const), content: t.text }));
    // An empty system prompt is not one; leave it out rather than send it.
    return system.trim() ? [{ role: 'system', content: system }, ...turns] : turns;
}

export function buildChatRequest(a: AdapterArgs): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const base = endpointFor(a);
    const openrouter = a.provider === 'openrouter';
    const objectMode = !openrouter && a.jsonMode === 'object';

    let system = a.system;
    let responseFormat: Record<string, unknown>;
    if (objectMode) {
        if (rootKind(a.schema) !== 'object') {
            throw new AiError({
                kind: 'bad_request', provider: a.provider, model: a.model, key: a.apiKey,
                message: `${providerName(a.provider)}'s JSON-object mode can only answer with an object, not an array or a union. Wrap it, for example {"items": [...]}.`,
            });
        }
        system = `${a.system.trim()}\n\n${describedSchema(a)}`.trim();
        responseFormat = { type: 'json_object' };
    } else {
        responseFormat = { type: 'json_schema', json_schema: { name: SCHEMA_NAME, strict: true, schema: strictSchemaFor(a, { objectRoot: false }) } };
    }

    const reasoning = openrouter ? openRouterReasoning(a.model, a.effort) : undefined;
    return {
        url: `${base}/chat/completions`,
        // The key is here and nowhere else: not in the URL, not in the body. A keyless endpoint sends none.
        headers: a.apiKey ? { authorization: `Bearer ${a.apiKey}` } : {},
        body: {
            model: a.model,
            messages: messagesFor(system, a.user),
            max_tokens: a.maxTokens,
            response_format: responseFormat,
            ...(openrouter ? { provider: { require_parameters: true } } : {}),
            ...(reasoning ? { reasoning } : {}),
        },
    };
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);
const money = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);

/**
 * What OpenRouter says the call cost, as the `usd` and `source` of a `Billed` entry, or nothing.
 * Only OpenRouter's figure is a price: a Custom endpoint's `cost` could mean anything. `cost` is
 * what was charged to the account; on a BYOK call that is OpenRouter's fee alone, and the model's
 * own provider billed `cost_details.upstream_inference_cost` on top, so the call cost both. A BYOK
 * call that reports no upstream figure is left to the price table: the fee alone would be a
 * lie in the budget's favour. Rounded to the billionth, like `costOf`.
 */
function providerCost(provider: string, usage: any): { usd: number; source: 'provider' } | Record<string, never> {
    if (provider !== 'openrouter') return {};
    const charged = money(usage?.cost);
    if (usage?.is_byok === true) {
        const upstream = money(usage?.cost_details?.upstream_inference_cost);
        return upstream !== undefined && upstream > 0 ? { usd: Math.round(((charged ?? 0) + upstream) * 1e9) / 1e9, source: 'provider' } : {};
    }
    return charged !== undefined ? { usd: charged, source: 'provider' } : {};
}

type Call = Pick<AdapterArgs, 'provider' | 'model' | 'apiKey'>;

/**
 * A failure that came back in the body of a 200: `{error: {code, message}}`, where `code` is the
 * HTTP status the provider would have sent. It is read as the HTTP error it stands for, so a 502
 * from a provider behind OpenRouter is `server` and a 402 is `quota`; a body with no usable code
 * is `server`: something failed upstream and nothing says it is the request's fault.
 */
function embeddedError(error: any, a: Call, billed: Billed[]): AiError {
    const code = Number(error?.code);
    if (Number.isInteger(code) && code >= 400 && code < 600) {
        const err = errorFromHttp(a.provider, a.model, code, JSON.stringify({ error }), { key: a.apiKey });
        return billed[0]!.in || billed[0]!.out
            ? new AiError({ kind: err.kind, provider: a.provider, model: a.model, status: code, message: err.message, key: a.apiKey, usage: totalUsage(billed), billed, retryAfterMs: err.retryAfterMs })
            : err;
    }
    const said = typeof error?.message === 'string' ? error.message : '';
    return new AiError({
        kind: 'server', provider: a.provider, model: a.model, key: a.apiKey,
        message: said || `${providerName(a.provider)} reported an error in its answer.`,
        ...(billed[0]!.in || billed[0]!.out ? { usage: totalUsage(billed), billed } : {}),
    });
}

const textOf = (content: unknown): string =>
    typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('')
          : '';

export function parseChatResponse(data: any, a: Call): AdapterResult {
    const usage = data?.usage;
    // Keyed by the model that was asked for: that is what an operator's price table is written in.
    const billed: Billed[] = [{ model: a.model, in: count(usage?.prompt_tokens), out: count(usage?.completion_tokens), ...providerCost(a.provider, usage) }];

    if (data?.error) throw embeddedError(data.error, a, billed);
    const choice = data?.choices?.[0];
    if (choice?.error) throw embeddedError(choice.error, a, billed);

    const finish: unknown = choice?.finish_reason;
    if (finish === 'error') throw embeddedError(undefined, a, billed);

    const message = choice?.message;
    const refusal = typeof message?.refusal === 'string' ? message.refusal.trim() : '';
    let stopReason: StopReason = 'end_turn';
    let detail: string | undefined;
    if (refusal) {
        stopReason = 'refusal';
        detail = refusal;
    } else if (finish === 'content_filter') {
        stopReason = 'refusal';
        detail = 'content_filter';
    } else if (finish === 'length') {
        stopReason = 'max_tokens';
    }
    // Who answered: a router's pick (`openrouter/auto`) is worth showing; `billed` keeps the id that was asked for.
    const answered = a.provider === 'openrouter' && typeof data?.model === 'string' && data.model ? data.model : a.model;
    return { text: textOf(message?.content), usage: totalUsage(billed), billed, model: answered, stopReason, ...(detail ? { detail } : {}) };
}

export const chatCompletionsAdapter: Adapter = async (a) => {
    const request = buildChatRequest(a);
    const data = await postJson({
        provider: a.provider, model: a.model, key: a.apiKey, signal: a.signal, fetchImpl: a.fetchImpl, ...request,
    });
    return parseChatResponse(data, a);
};

// ─── Model lists and key checks ──────────────────────────────────────────────────────────────

/**
 * OpenRouter's list is large (hundreds) and not all of it can do this library's job: a model whose
 * `supported_parameters` lacks `structured_outputs` would fail to route under `require_parameters`,
 * and one that does not output text is no use here. An entry without either field is kept: the
 * list's shape is OpenRouter's to change, and a model left out can still be typed in.
 */
function openRouterModels(body: unknown): string[] {
    const list: any[] = Array.isArray((body as any)?.data) ? (body as any).data : [];
    const usable = list.filter((m) => {
        const params: unknown = m?.supported_parameters;
        const outputs: unknown = m?.architecture?.output_modalities;
        return (!Array.isArray(params) || params.includes('structured_outputs')) && (!Array.isArray(outputs) || outputs.includes('text'));
    });
    return modelIdsFrom({ data: usable });
}

/** A list, or a check, of an OpenAI-compatible endpoint's models; `404` is "this server has no list", for the caller to read. */
async function getModels(q: ProviderQuery) {
    // OpenRouter's list is public, and a Custom endpoint may need no key: neither is required here.
    const { def, key, signal } = prepareQuery(q, { needsKey: false });
    const openrouter = def.id === 'openrouter';
    const base = endpointFor({ provider: q.provider, model: '', apiKey: key, baseUrl: q.baseUrl });
    return getJson({
        provider: q.provider, model: '', url: `${base}/models`,
        // A public list is not sent the key at all.
        headers: key && !openrouter ? { authorization: `Bearer ${key}` } : {},
        key, signal, fetchImpl: q.fetchImpl,
    });
}

const isNoList = (err: unknown): boolean => err instanceof AiError && err.status === 404;

export const chatCompletionsFamily: FamilyAdapter = {
    generate: chatCompletionsAdapter,
    normalize: dropStrictNulls,
    listModels: async (q) => {
        try {
            const body = await getModels(q);
            return q.provider === 'openrouter' ? openRouterModels(body) : modelIdsFrom(body);
        } catch (err) {
            if (q.provider === 'custom' && isNoList(err)) {
                throw prepareQuery(q, { needsKey: false }).fail('bad_request', `${providerName(q.provider)} has no model list: GET /models answered 404. Type the model id instead.`, 404);
            }
            throw err;
        }
    },
    checkKey: async (q) => {
        if (q.provider === 'openrouter') {
            // Its `/models` is public and proves nothing about a key. `/key` answers 401 to one that is not.
            const { key, signal } = prepareQuery(q);
            const body: any = await getJson({ provider: q.provider, model: '', url: `${OPENROUTER_BASE_URL}/key`, headers: { authorization: `Bearer ${key}` }, key, signal, fetchImpl: q.fetchImpl });
            // A key that works but is out of credit (`limit_remaining` is `null` when it has no limit): every call would be a 402.
            const remaining: unknown = body?.data?.limit_remaining;
            return typeof remaining === 'number' && remaining <= 0 ? { ok: true, warning: 'no_credit' } : { ok: true };
        }
        try {
            await getModels(q);
            return { ok: true };
        } catch (err) {
            // A server with no `/models` cannot say whether the key is good; saving it is the operator's call.
            if (isNoList(err)) return { ok: true, warning: 'no_model_list' };
            throw err;
        }
    },
};
