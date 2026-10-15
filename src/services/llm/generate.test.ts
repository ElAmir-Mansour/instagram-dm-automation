/**
 * `generateJson` end to end against a stub `fetch`, once per provider: a structured answer, every
 * way a call can fail and the kind it fails as, that nothing is ever retried, and that the API key
 * is in exactly one request header and in no error. No network.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { log, setLogSink } from '../../utils/log.js';
import type { GeminiSchema } from './geminiSchema.js';
import type { FamilyAdapters } from './adapters/index.js';
import { costOf, DEFAULT_PRICES } from './cost.js';
import { aiErrorLogFields, AiError, isAiError, type AiErrorKind } from './errors.js';
import {
    callLlm, generateJson, MAX_TIMEOUT_MS, parseModelJson, setLlmCaller, type GenerateJsonArgs, type GenerateJsonResult,
} from './generate.js';
import type { ProviderId } from './registry.js';
import { hangingFetch, jsonResponse, stubFetch } from './testFetch.js';
import type { AdapterResult, Effort, FamilyAdapter, FetchLike } from './types.js';

// `callLlm` warns about a limit below what a thinking model needs, and most of these calls use a small one
// (the point of them is not the limit). The logging tests below capture their own lines.
setLogSink(() => {});

const SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' }, score: { type: 'INTEGER' } },
    required: ['reply'],
};
const ANSWER = { reply: 'مرحبا', score: 7 };

/** Everything that differs between providers: how each one words an answer and an error. */
interface Fixture {
    provider: ProviderId;
    model: string;
    key: string;
    /** The one header the key may travel in. */
    keyHeader: string;
    /** What that header holds for a key: the key itself, or `Bearer <key>`. */
    keyHeaderValue(key: string): string;
    /** The origin every request must go to, whatever base URL the caller offers (Custom's is the one it was given). */
    origin: string;
    /** Only Custom: the operator's base URL, which the request goes to. Every other provider has its own address. */
    baseUrl?: string;
    /** Whether an answer whose top level is an array is allowed (OpenAI's strict mode needs an object). */
    arrayRoot: boolean;
    /** What a spent balance answers: 429, or OpenRouter's 402. Absent for a provider with no such answer: Groq's 429 is always a rate limit. */
    quotaStatus?: number;
    text(text: string, usage?: { input: number; output: number }): Response;
    refusal(): Response;
    cutOff(): Response;
    error(status: number, message: string): Response;
    /** A 429 for a limit that lifts by itself. `retryAfter` is the header, where the provider has one. */
    rateLimited(retryAfter?: string): Response;
    /** How long a caller is told to wait after `rateLimited()` with the header `retryAfterHeader`, or without one. */
    waitMs: { withHeader: number; withoutHeader: number | undefined };
    /** A 429 for a limit that does not: a daily quota, the monthly spend cap. */
    quotaSpent?(): Response;
}

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
    400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error',
    404: 'not_found_error', 429: 'rate_limit_error', 500: 'api_error', 504: 'timeout_error', 529: 'overloaded_error',
};
const GEMINI_STATUSES: Record<number, string> = {
    400: 'INVALID_ARGUMENT', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE',
};
// The sentence is the same for Google's per-minute limit and its daily one; only `details` differs.
const GEMINI_QUOTA_WORDS = 'You exceeded your current quota, please check your plan and billing details.';
const geminiQuota = (quotaId: string, retryDelay: string) => [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaValue: '20' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
];

const anthropic: Fixture = {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    key: 'sk-ant-api03-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq',
    keyHeader: 'x-api-key',
    keyHeaderValue: (key) => key,
    arrayRoot: true,
    quotaStatus: 429,
    origin: 'https://api.anthropic.com/',
    text: (text, usage = { input: 120, output: 34 }) => jsonResponse(200, {
        id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null,
        content: [{ type: 'text', text }], usage: { input_tokens: usage.input, output_tokens: usage.output },
    }),
    refusal: () => jsonResponse(200, {
        id: 'msg_02', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'refusal',
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'Declined.' }, usage: { input_tokens: 412, output_tokens: 0 },
    }),
    cutOff: () => jsonResponse(200, {
        id: 'msg_03', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'max_tokens', stop_details: null,
        content: [{ type: 'text', text: '{"reply":"cut o' }], usage: { input_tokens: 100, output_tokens: 1000 },
    }),
    error: (status, message) => jsonResponse(status, { type: 'error', error: { type: ANTHROPIC_ERROR_TYPES[status] ?? 'api_error', message }, request_id: 'req_011CSHoEeqs5C35K2UUqR7Fy' }),
    rateLimited: (retryAfter) => jsonResponse(
        429,
        { type: 'error', error: { type: 'rate_limit_error', message: "This request would exceed your organization's rate limit of 30,000 input tokens per minute." } },
        retryAfter ? { 'retry-after': retryAfter } : {},
    ),
    waitMs: { withHeader: 30_000, withoutHeader: undefined },
    quotaSpent: () => jsonResponse(429, {
        type: 'error',
        error: {
            type: 'rate_limit_error',
            message: 'You have reached your API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
            details: { error_code: 'enforced_spend_limit_reached' },
        },
    }),
};

const gemini: Fixture = {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    key: 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
    keyHeader: 'x-goog-api-key',
    keyHeaderValue: (key) => key,
    arrayRoot: true,
    quotaStatus: 429,
    origin: 'https://generativelanguage.googleapis.com/',
    text: (text, usage = { input: 90, output: 20 }) => jsonResponse(200, {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output, thoughtsTokenCount: 0 },
    }),
    refusal: () => jsonResponse(200, { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 412 } }),
    cutOff: () => jsonResponse(200, {
        candidates: [{ content: { parts: [{ text: '{"reply":"cut o' }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 600, thoughtsTokenCount: 400 },
    }),
    error: (status, message) => jsonResponse(status, { error: { code: status, message, status: GEMINI_STATUSES[status] ?? 'UNKNOWN' } }),
    rateLimited: (retryAfter) => jsonResponse(
        429,
        { error: { code: 429, message: GEMINI_QUOTA_WORDS, status: 'RESOURCE_EXHAUSTED', details: geminiQuota('GenerateContentInputTokensPerModelPerMinute-FreeTier', '33s') } },
        retryAfter ? { 'retry-after': retryAfter } : {},
    ),
    // Google sends no header; the wait is in RetryInfo.
    waitMs: { withHeader: 30_000, withoutHeader: 33_000 },
    quotaSpent: () => jsonResponse(429, {
        error: { code: 429, message: GEMINI_QUOTA_WORDS, status: 'RESOURCE_EXHAUSTED', details: geminiQuota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '1s') },
    }),
};

// OpenAI: `{error: {message, type, param, code}}`; a 429's `code` says what kind of limit it is.
const OPENAI_ERROR_TYPES: Record<number, string> = {
    400: 'invalid_request_error', 401: 'invalid_request_error', 403: 'invalid_request_error', 404: 'invalid_request_error',
    429: 'rate_limit_error', 500: 'server_error', 503: 'service_unavailable_error',
};
const openAiError = (status: number, message: string, code: string | null = null) =>
    jsonResponse(status, { error: { message, type: OPENAI_ERROR_TYPES[status] ?? 'api_error', param: null, code } });

/** A Responses API object, as the reference's example has it. */
const responsesBody = (over: Record<string, unknown> = {}) => ({
    id: 'resp_67ccd3a9da748190baa7f1570fe91ac604becb25c45c1d41', object: 'response', status: 'completed', model: 'gpt-6-astra',
    error: null, incomplete_details: null, output: [],
    usage: { input_tokens: 0, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 },
    ...over,
});
const messageItem = (content: unknown[]) => ({ type: 'message', id: 'msg_67ccd3acc8d48190a77525dc6de64b4104becb25c45c1d41', role: 'assistant', status: 'completed', content });

const openai: Fixture = {
    provider: 'openai',
    model: 'gpt-6-astra',
    key: 'sk-proj-Tq8vLm2xWz4RnYb7KdP1aHc6JfSe9UoNgIiXtVrBwEs3',
    keyHeader: 'authorization',
    keyHeaderValue: (key) => `Bearer ${key}`,
    arrayRoot: false,
    quotaStatus: 429,
    origin: 'https://api.openai.com/',
    text: (text, usage = { input: 120, output: 34 }) => jsonResponse(200, responsesBody({
        output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, messageItem([{ type: 'output_text', text, annotations: [] }])],
        usage: { input_tokens: usage.input, output_tokens: usage.output, output_tokens_details: { reasoning_tokens: 12 }, total_tokens: usage.input + usage.output },
    })),
    refusal: () => jsonResponse(200, responsesBody({
        output: [messageItem([{ type: 'refusal', refusal: "I can't help with that." }])],
        usage: { input_tokens: 412, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 412 },
    })),
    cutOff: () => jsonResponse(200, responsesBody({
        status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
        output: [messageItem([{ type: 'output_text', text: '{"reply":"cut o', annotations: [] }])],
        usage: { input_tokens: 100, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 900 }, total_tokens: 1100 },
    })),
    error: (status, message) => openAiError(status, message, status === 401 ? 'invalid_api_key' : null),
    rateLimited: (retryAfter) => {
        const body = { error: { message: 'Rate limit reached for gpt-6-astra on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000.', type: 'tokens', param: null, code: 'rate_limit_exceeded' } };
        return jsonResponse(429, body, retryAfter ? { 'retry-after': retryAfter } : {});
    },
    waitMs: { withHeader: 30_000, withoutHeader: undefined },
    quotaSpent: () => openAiError(429, 'You exceeded your current quota, please check your plan and billing details.', 'insufficient_quota'),
};

/** A Chat Completions answer: one choice, as OpenRouter and the compatible servers send it. */
const chatBody = (model: string, choice: Record<string, unknown>, usage: Record<string, unknown>) => ({
    id: 'gen-1790000000-abc', object: 'chat.completion', created: 1790000000, model, choices: [{ index: 0, ...choice }], usage,
});
const chatText = (model: string) => (text: string, usage = { input: 120, output: 34 }) => jsonResponse(200, chatBody(
    model,
    { message: { role: 'assistant', content: text }, finish_reason: 'stop' },
    { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output },
));
const chatRefusal = (model: string) => () => jsonResponse(200, chatBody(
    model,
    { message: { role: 'assistant', content: null, refusal: "I can't help with that." }, finish_reason: 'stop' },
    { prompt_tokens: 412, completion_tokens: 0, total_tokens: 412 },
));
const chatCutOff = (model: string) => () => jsonResponse(200, chatBody(
    model,
    { message: { role: 'assistant', content: '{"reply":"cut o' }, finish_reason: 'length' },
    { prompt_tokens: 100, completion_tokens: 1000, total_tokens: 1100 },
));

// OpenRouter: `{error: {code, message, metadata?}}`, with the status in `code`.
const openRouterError = (status: number, message: string, metadata?: Record<string, unknown>) =>
    jsonResponse(status, { error: { code: status, message, ...(metadata ? { metadata } : {}) } });

const openrouter: Fixture = {
    provider: 'openrouter',
    model: 'openrouter/auto',
    key: 'sk-or-v1-' + '3f9a'.repeat(16),
    keyHeader: 'authorization',
    keyHeaderValue: (key) => `Bearer ${key}`,
    arrayRoot: true,
    quotaStatus: 402,
    origin: 'https://openrouter.ai/',
    text: chatText('openrouter/auto'),
    refusal: chatRefusal('openrouter/auto'),
    cutOff: chatCutOff('openrouter/auto'),
    error: (status, message) => openRouterError(status, message),
    rateLimited: (retryAfter) => jsonResponse(
        429,
        { error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } } },
        retryAfter ? { 'retry-after': retryAfter } : {},
    ),
    waitMs: { withHeader: 30_000, withoutHeader: undefined },
    quotaSpent: () => openRouterError(402, 'Insufficient credits. Add more using https://openrouter.ai/settings/credits'),
};

// Groq: `{error: {message, type}}`; a 429 carries `retry-after` in seconds, and 498 is its own status for a flex tier that is out of capacity.
const groqError = (status: number, message: string, type = 'invalid_request_error') => jsonResponse(status, { error: { message, type } });

const groq: Fixture = {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    // Built, not written whole: a `gsk_` and fifty-two characters is what a secret scanner blocks a push for.
    key: 'gsk_' + 'Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq' + 'AbCdEfGh',
    keyHeader: 'authorization',
    keyHeaderValue: (key) => `Bearer ${key}`,
    arrayRoot: true,
    origin: 'https://api.groq.com/',
    text: chatText('openai/gpt-oss-120b'),
    refusal: chatRefusal('openai/gpt-oss-120b'),
    cutOff: chatCutOff('openai/gpt-oss-120b'),
    error: (status, message) => groqError(status, message),
    rateLimited: (retryAfter) => jsonResponse(
        429,
        { error: { message: 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Used 7000, Requested 2000. Please try again in 7.5s.', type: 'tokens' } },
        retryAfter ? { 'retry-after': retryAfter } : {},
    ),
    waitMs: { withHeader: 30_000, withoutHeader: undefined },
};

const custom: Fixture = {
    provider: 'custom',
    model: 'llama-4-maverick',
    key: 'llm-key-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq',
    keyHeader: 'authorization',
    keyHeaderValue: (key) => `Bearer ${key}`,
    arrayRoot: true,
    quotaStatus: 429,
    baseUrl: 'https://llm.example.com/v1',
    origin: 'https://llm.example.com/',
    text: chatText('llama-4-maverick'),
    refusal: chatRefusal('llama-4-maverick'),
    cutOff: chatCutOff('llama-4-maverick'),
    error: (status, message) => jsonResponse(status, { error: { message, type: 'invalid_request_error', code: null } }),
    rateLimited: (retryAfter) => jsonResponse(429, { error: { message: 'Too many requests. Please slow down.', type: 'rate_limit_error', code: null } }, retryAfter ? { 'retry-after': retryAfter } : {}),
    waitMs: { withHeader: 30_000, withoutHeader: undefined },
    quotaSpent: () => jsonResponse(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'billing_error', code: null } }),
};

const call = (fx: Fixture, fetchImpl: FetchLike, over: Partial<GenerateJsonArgs> = {}) =>
    generateJson({
        provider: fx.provider, apiKey: fx.key, model: fx.model, system: 'You answer in JSON.', user: 'Say hello.',
        schema: SCHEMA, maxTokens: 1000, timeoutMs: 5000, fetchImpl, ...(fx.baseUrl ? { baseUrl: fx.baseUrl } : {}), ...over,
    });

async function rejection(promise: Promise<unknown>): Promise<AiError> {
    try {
        await promise;
    } catch (err) {
        assert.ok(isAiError(err), `expected an AiError, got ${String(err)}`);
        return err;
    }
    return assert.fail('expected the call to fail');
}

/** Every way an error object can be turned into text: what a log line, a response or a stack would show. */
const printed = (err: AiError): string =>
    [JSON.stringify(err), String(err), err.message, err.stack ?? '', JSON.stringify(Object.getOwnPropertyNames(err).map((k) => (err as any)[k]))].join('\n');

/** What Node's fetch throws for `redirect: 'error'`. */
const redirectRefusal = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });

for (const fx of [anthropic, openai, gemini, openrouter, groq, custom]) {
    describe(`generateJson (${fx.provider})`, () => {
        describe('a structured answer', () => {
            it('returns the parsed JSON with usage, billing, model, provider, stop reason and timing', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER), { input: 150, output: 40 }));
                const out = await call(fx, fetchImpl);
                assert.deepEqual(out.json, ANSWER);
                assert.deepEqual(out.usage, { in: 150, out: 40 });
                assert.deepEqual(out.billed, [{ model: fx.model, in: 150, out: 40 }]);
                assert.equal(out.model, fx.model);
                assert.equal(out.provider, fx.provider);
                assert.equal(out.stopReason, 'end_turn');
                assert.ok(Number.isFinite(out.elapsed_ms) && out.elapsed_ms >= 0);
                assert.equal(calls.length, 1);
            });

            it('reads JSON the model wrapped in a code fence or a sentence', async () => {
                for (const text of ['```json\n{"reply":"hi"}\n```', '```\n{"reply":"hi"}\n```', 'Here you go: {"reply":"hi"} Hope that helps.']) {
                    const { fetchImpl } = stubFetch(fx.text(text));
                    assert.deepEqual((await call(fx, fetchImpl)).json, { reply: 'hi' }, text);
                }
            });

            it('accepts an array when the schema says the answer is one', { skip: !fx.arrayRoot }, async () => {
                const { fetchImpl } = stubFetch(fx.text('[{"a":1},{"a":2}]'));
                const out = await call(fx, fetchImpl, { schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { a: { type: 'INTEGER' } } } } });
                assert.deepEqual(out.json, [{ a: 1 }, { a: 2 }]);
            });
        });

        describe('the key and where it goes', () => {
            it('travels in exactly one request header, and in no URL or body', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, fetchImpl);
                const request = calls[0]!;
                assert.equal(request.headers[fx.keyHeader], fx.keyHeaderValue(fx.key));
                assert.deepEqual(Object.entries(request.headers).filter(([, v]) => v.includes(fx.key)).map(([k]) => k), [fx.keyHeader]);
                assert.ok(!request.url.includes(fx.key));
                assert.ok(!request.url.includes('key='));
                assert.ok(!request.raw.includes(fx.key));
            });

            it('is trimmed before it is sent, so a pasted newline cannot break a header', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, fetchImpl, { apiKey: `  ${fx.key}\n` });
                assert.equal(calls[0]!.headers[fx.keyHeader], fx.keyHeaderValue(fx.key));
            });

            it('goes to the provider\'s own address, whatever base URL the caller offers', { skip: fx.baseUrl !== undefined }, async () => {
                for (const baseUrl of ['https://evil.example.com', 'https://evil.example.com/v1/', 'http://127.0.0.1:9', 'not a url']) {
                    const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                    await call(fx, fetchImpl, { baseUrl });
                    assert.ok(calls[0]!.url.startsWith(fx.origin), `${baseUrl}: ${calls[0]!.url}`);
                    assert.ok(!calls[0]!.url.includes('evil'), baseUrl);
                }
            });

            it('is sent with a request that refuses redirects, which would carry the header to wherever it pointed', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, fetchImpl);
                assert.equal(calls[0]!.redirect, 'error');
            });

            it('is nowhere in an error, even when the provider echoes it back', async () => {
                for (const status of [400, 401, 403, 404, 429, 500, 503]) {
                    const echo = `Invalid credential ${fx.key} (request to /v1?key=${fx.key} with x-api-key: ${fx.key}; Bearer ${fx.key})`;
                    const { fetchImpl } = stubFetch(fx.error(status, echo));
                    const err = await rejection(call(fx, fetchImpl));
                    assert.ok(!printed(err).includes(fx.key), `${status}: ${printed(err)}`);
                    assert.ok(!printed(err).includes(fx.key.slice(5, 30)), `${status}: a piece of it survived`);
                }
            });

            it('is nowhere in the error for a failed connection, a timeout or a body that is not JSON', async () => {
                const failures: FetchLike[] = [
                    stubFetch(Object.assign(new TypeError(`fetch failed for ${fx.key}`), { cause: { code: 'ECONNRESET' } })).fetchImpl,
                    stubFetch(new Response(`<html>${fx.key}</html>`, { status: 200 })).fetchImpl,
                    stubFetch(new Response(`gateway down ${fx.key}`, { status: 502 })).fetchImpl,
                ];
                for (const fetchImpl of failures) {
                    const err = await rejection(call(fx, fetchImpl));
                    assert.ok(!printed(err).includes(fx.key), printed(err));
                }
            });
        });

        describe('a redirect', () => {
            it('is bad_request, final, and not retried, when fetch refuses to follow it', async () => {
                const { fetchImpl, calls } = stubFetch(redirectRefusal(), fx.text(JSON.stringify(ANSWER)));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'bad_request');
                assert.equal(err.retryable, false);
                assert.match(err.message, /redirect/);
                assert.equal(calls.length, 1);
            });

            it('is bad_request too when a stand-in for fetch hands back a 307', async () => {
                const { fetchImpl, calls } = stubFetch(new Response('', { status: 307, headers: { location: 'https://evil.example.com/' } }), fx.text(JSON.stringify(ANSWER)));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'bad_request');
                assert.equal(err.status, 307);
                assert.equal(calls.length, 1);
            });
        });

        describe('why a call fails', () => {
            // [what the provider sent, what it is]. Each is one request: the library never retries.
            const statuses: Array<[number, string, AiErrorKind]> = [
                [401, 'bad credentials', 'auth'],
                [403, 'permission denied', 'auth'],
                [404, 'model not found', 'bad_request'],
                [500, 'internal error', 'server'],
                [503, 'the model is overloaded', 'server'],
                [529, 'overloaded', 'server'],
            ];
            for (const [status, message, kind] of statuses) {
                it(`${status} "${message.slice(0, 30)}" is ${kind}, from one request`, async () => {
                    const { fetchImpl, calls } = stubFetch(fx.error(status, message), fx.text(JSON.stringify(ANSWER)));
                    const err = await rejection(call(fx, fetchImpl));
                    assert.equal(err.kind, kind);
                    assert.equal(err.status, status);
                    assert.equal(err.provider, fx.provider);
                    assert.equal(err.model, fx.model);
                    assert.equal(err.retryable, kind === 'rate' || kind === 'server');
                    assert.equal(err.message, message);
                    // The second scripted answer is a success. A retry would have reached it.
                    assert.equal(calls.length, 1);
                });
            }

            it('a 429 for a limit that lifts by itself is rate: retryable, and says how long to wait', async () => {
                const { fetchImpl, calls } = stubFetch(fx.rateLimited(), fx.text(JSON.stringify(ANSWER)));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'rate');
                assert.equal(err.status, 429);
                assert.equal(err.retryable, true);
                assert.equal(err.retryAfterMs, fx.waitMs.withoutHeader);
                assert.equal(calls.length, 1);
            });

            it('takes the wait from retry-after when the provider sends one', async () => {
                const { fetchImpl } = stubFetch(fx.rateLimited('30'));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'rate');
                assert.equal(err.retryAfterMs, fx.waitMs.withHeader);
            });

            it('a 429 for a limit that does not lift by itself is quota: final, with no wait', { skip: fx.quotaSpent === undefined }, async () => {
                const { fetchImpl, calls } = stubFetch(fx.quotaSpent!(), fx.text(JSON.stringify(ANSWER)));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'quota');
                assert.equal(err.status, fx.quotaStatus);
                assert.equal(err.retryable, false);
                assert.equal(err.retryAfterMs, undefined);
                assert.equal(calls.length, 1);
            });

            it('a refusal is refusal: final, from a 200, with the tokens it was billed', async () => {
                const { fetchImpl, calls } = stubFetch(fx.refusal());
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'refusal');
                assert.equal(err.retryable, false);
                assert.equal(err.usage?.in, 412);
                assert.deepEqual(err.billed, [{ model: fx.model, in: 412, out: 0 }]);
                assert.match(err.message, /declined/);
                assert.equal(calls.length, 1);
            });

            it('an answer cut off by the token limit is max_tokens, not "bad output", although it does not parse', async () => {
                const { fetchImpl, calls } = stubFetch(fx.cutOff());
                const err = await rejection(call(fx, fetchImpl, { maxTokens: 1000 }));
                assert.equal(err.kind, 'max_tokens');
                assert.equal(err.retryable, false);
                assert.match(err.message, /1000/);
                assert.ok((err.usage?.out ?? 0) >= 600, 'the billed tokens travel with the error');
                assert.equal(err.billed?.length, 1);
                assert.equal(calls.length, 1);
            });

            it('text that is not JSON is bad_output, which is retryable once', async () => {
                for (const text of ['Sure! Here is a greeting.', '{"reply": "unterminated', '']) {
                    const { fetchImpl, calls } = stubFetch(fx.text(text));
                    const err = await rejection(call(fx, fetchImpl));
                    assert.equal(err.kind, 'bad_output', JSON.stringify(text));
                    assert.equal(err.retryable, true);
                    assert.ok(err.usage, 'it was billed');
                    assert.equal(calls.length, 1);
                }
            });

            it('JSON of the wrong shape at the top level is bad_output', async () => {
                for (const text of ['[{"reply":"hi"}]', '"just a string"', '42', 'null']) {
                    const { fetchImpl } = stubFetch(fx.text(text));
                    const err = await rejection(call(fx, fetchImpl));
                    assert.equal(err.kind, 'bad_output', text);
                    assert.match(err.message, /not a JSON object/);
                }
                // OpenAI's strict mode has no array at the top (it has its own test, below).
                if (!fx.arrayRoot) return;
                const { fetchImpl } = stubFetch(fx.text('{"reply":"hi"}'));
                const err = await rejection(call(fx, fetchImpl, { schema: { type: 'ARRAY', items: { type: 'STRING' } } }));
                assert.match(err.message, /not a JSON array/);
            });

            it('a 200 whose body is not JSON at all is bad_output', async () => {
                const { fetchImpl } = stubFetch(new Response('<html>maintenance</html>', { status: 200 }));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'bad_output');
                assert.equal(err.status, 200);
            });

            it('a connection that cannot be made is timeout, retryable, naming the network error and not its text', async () => {
                const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
                const { fetchImpl, calls } = stubFetch(refused, fx.text(JSON.stringify(ANSWER)));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'timeout');
                assert.equal(err.retryable, true);
                assert.equal(err.status, undefined);
                assert.match(err.message, /ENOTFOUND/);
                assert.equal(calls.length, 1);
            });

            it('a server that never answers is timeout once the one deadline passes, and is not retried', async () => {
                const calls: string[] = [];
                const fetchImpl: FetchLike = (url, init) => {
                    calls.push(url);
                    return hangingFetch(url, init);
                };
                const started = Date.now();
                const err = await rejection(call(fx, fetchImpl, { timeoutMs: 30 }));
                assert.equal(err.kind, 'timeout');
                assert.equal(err.retryable, true);
                assert.match(err.message, /in time/);
                assert.ok(Date.now() - started < 2000);
                assert.equal(calls.length, 1);
            });

            it('an answer that stalls halfway through its body is timeout too', async () => {
                // Headers arrive, the body never finishes; the deadline errors the stream, as fetch does.
                const fetchImpl: FetchLike = async (_url, init) => {
                    const stream = new ReadableStream({
                        start(controller) {
                            // The open socket that keeps a real process alive; see hangingFetch.
                            const socket = setInterval(() => {}, 1000);
                            init.signal?.addEventListener('abort', () => {
                                clearInterval(socket);
                                controller.error(init.signal!.reason);
                            }, { once: true });
                        },
                    });
                    return new Response(stream, { status: 200 });
                };
                const err = await rejection(call(fx, fetchImpl, { timeoutMs: 30 }));
                assert.equal(err.kind, 'timeout');
                assert.equal(err.retryable, true);
            });

            it('gives the call one deadline, a fresh signal that has not fired', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, fetchImpl, { timeoutMs: 60_000 });
                assert.ok(calls[0]!.signal instanceof AbortSignal);
                assert.equal(calls[0]!.signal!.aborted, false);
            });
        });

        describe('the request', () => {
            it('is one POST of JSON', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, fetchImpl);
                assert.equal(calls.length, 1);
                assert.equal(calls[0]!.method, 'POST');
                assert.equal(calls[0]!.headers['content-type'], 'application/json');
                assert.ok(calls[0]!.url.startsWith('https://'));
            });

            it('treats cacheSystem as Anthropic\'s alone: every other provider\'s request is the one it would have been, and says nothing of a cache', async () => {
                const plain = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, plain.fetchImpl);
                const asked = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, asked.fetchImpl, { cacheSystem: true });
                if (fx.provider === 'anthropic') {
                    assert.notEqual(asked.calls[0]!.raw, plain.calls[0]!.raw);
                    assert.ok(asked.calls[0]!.raw.includes('cache_control'));
                } else {
                    assert.equal(asked.calls[0]!.raw, plain.calls[0]!.raw);
                    assert.ok(!asked.calls[0]!.raw.includes('cache_control'));
                }
                assert.ok(!plain.calls[0]!.raw.includes('cache_control'), 'and nobody sends one that was not asked for');
            });

            it('passes the system prompt, the user\'s words and the token limit on', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, fetchImpl, { system: 'Be brief.', user: 'Say hello.', maxTokens: 777 });
                const raw = calls[0]!.raw;
                assert.ok(raw.includes('Be brief.'));
                assert.ok(raw.includes('Say hello.'));
                assert.ok(raw.includes('777'));
            });
        });
    });
}

describe('generateJson (anthropic specifics)', () => {
    it('asks for medium effort when the caller does not say, and for what it does say otherwise', async () => {
        const first = stubFetch(anthropic.text(JSON.stringify(ANSWER)));
        await call(anthropic, first.fetchImpl);
        assert.equal(first.calls[0]!.body.output_config.effort, 'medium');

        const second = stubFetch(anthropic.text(JSON.stringify(ANSWER)));
        await call(anthropic, second.fetchImpl, { effort: 'low' });
        assert.equal(second.calls[0]!.body.output_config.effort, 'low');
    });

    it('caches the system prompt when told to, and bills what the answer says it wrote and read, apart from the uncached input', async () => {
        const answer = (usage: Record<string, number>) => jsonResponse(200, {
            id: 'msg_05', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null,
            content: [{ type: 'text', text: JSON.stringify(ANSWER) }],
            usage: { input_tokens: 150, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
        });
        const { fetchImpl, calls } = stubFetch(answer({ cache_creation_input_tokens: 2000 }), answer({ cache_read_input_tokens: 2000 }), answer({}));
        const first = await call(anthropic, fetchImpl, { cacheSystem: true });
        const second = await call(anthropic, fetchImpl, { cacheSystem: true });
        const third = await call(anthropic, fetchImpl);

        assert.deepEqual(calls[0]!.body.system, [{ type: 'text', text: 'You answer in JSON.', cache_control: { type: 'ephemeral' } }]);
        assert.deepEqual(calls[1]!.body.system, calls[0]!.body.system, 'the same bytes, so the second request can read the first\'s entry');
        assert.equal(calls[2]!.body.system, 'You answer in JSON.');
        assert.deepEqual(first.usage, { in: 150, out: 40, cacheWrite: 2000 });
        assert.deepEqual(second.usage, { in: 150, out: 40, cacheRead: 2000 });
        assert.deepEqual(third.usage, { in: 150, out: 40 });
        assert.deepEqual(second.billed, [{ model: 'claude-opus-5-5', in: 150, out: 40, cacheRead: 2000 }]);
        // $4 in, $20 out, a write at $5 and a read at $0.20 a million.
        assert.equal(costOf(first.billed, DEFAULT_PRICES).usd, (150 * 4 + 2000 * 5 + 40 * 20) / 1e6);
        assert.equal(costOf(second.billed, DEFAULT_PRICES).usd, (150 * 4 + 2000 * 0.2 + 40 * 20) / 1e6);
    });

    it('bills the cache tokens of an answer that then fails: a refusal or a cut-off carries them on the error', async () => {
        const { fetchImpl } = stubFetch(jsonResponse(200, {
            id: 'msg_06', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'max_tokens', stop_details: null,
            content: [{ type: 'text', text: '{"reply":' }],
            usage: { input_tokens: 100, output_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 1800 },
        }));
        const err = await rejection(call(anthropic, fetchImpl, { cacheSystem: true }));
        assert.equal(err.kind, 'max_tokens');
        assert.deepEqual(err.usage, { in: 100, out: 1000, cacheRead: 1800 });
        assert.deepEqual(err.billed, [{ model: 'claude-opus-5-5', in: 100, out: 1000, cacheRead: 1800 }]);
    });

    // Opus 5.5 declined and Opus 4.8 answered. The top-level usage is the last attempt only.
    const fellBack = (over: Record<string, unknown> = {}) => jsonResponse(200, {
        id: 'msg_04', type: 'message', role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', stop_details: null,
        content: [
            { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
            { type: 'text', text: JSON.stringify(ANSWER) },
        ],
        usage: {
            input_tokens: 412, output_tokens: 264,
            iterations: [
                { type: 'message', model: 'claude-opus-5-5', input_tokens: 535, output_tokens: 0 },
                { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 412, output_tokens: 264 },
            ],
        },
        ...over,
    });

    it('reports the model that answered when the server-side fallback moved the request', async () => {
        const { fetchImpl } = stubFetch(fellBack());
        const out = await call(anthropic, fetchImpl);
        assert.equal(out.model, 'claude-opus-4-8');
        assert.deepEqual(out.json, ANSWER);
    });

    it('bills a fallen-back call for every model that ran, so the declined attempt is not free', async () => {
        const { fetchImpl } = stubFetch(fellBack());
        const out = await call(anthropic, fetchImpl);
        assert.deepEqual(out.billed, [
            { model: 'claude-opus-5-5', in: 535, out: 0 },
            { model: 'claude-opus-4-8', in: 412, out: 264 },
        ]);
        assert.deepEqual(out.usage, { in: 947, out: 264 });
        const cost = costOf(out.billed, DEFAULT_PRICES);
        assert.equal(cost.usd, 0.0108);
        assert.equal(cost.priced, true);
    });

    it('bills a fallen-back call that then fails too: the error carries every entry', async () => {
        const { fetchImpl } = stubFetch(fellBack({
            content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'bio', explanation: null },
        }));
        const err = await rejection(call(anthropic, fetchImpl));
        assert.equal(err.kind, 'refusal');
        assert.equal(err.billed?.length, 2);
        assert.deepEqual(err.usage, { in: 947, out: 264 });
    });

    it('maps the errors only Anthropic sends: 402 billing, a 400 for an empty balance, and an overload', async () => {
        const cases: Array<[number, string, AiErrorKind]> = [
            [402, 'There is an issue with your billing.', 'quota'],
            [400, 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.', 'quota'],
            [400, 'output_config.format: schema is not supported', 'bad_request'],
            [413, 'Request exceeds the maximum allowed number of bytes.', 'bad_request'],
        ];
        for (const [status, message, kind] of cases) {
            const { fetchImpl } = stubFetch(anthropic.error(status, message));
            assert.equal((await rejection(call(anthropic, fetchImpl))).kind, kind, `${status} ${message}`);
        }
    });

    it('refuses a schema Anthropic would call too complex, before any request', async () => {
        const tooMany: GeminiSchema = {
            type: 'OBJECT',
            properties: Object.fromEntries([...Array(30).keys()].map((i) => [`f${i}`, { type: 'STRING' as const }])),
        };
        const { fetchImpl, calls } = stubFetch(anthropic.text(JSON.stringify(ANSWER)));
        const err = await rejection(call(anthropic, fetchImpl, { schema: tooMany }));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /30 optional properties/);
        assert.equal(calls.length, 0);
    });
});

describe('generateJson (gemini specifics)', () => {
    it('maps Gemini\'s 400 "API key not valid" to auth, as it answers a bad key with 400, not 401', async () => {
        const { fetchImpl } = stubFetch(gemini.error(400, 'API key not valid. Please pass a valid API key.'));
        const err = await rejection(call(gemini, fetchImpl));
        assert.equal(err.kind, 'auth');
        assert.equal(err.status, 400);
        assert.equal(err.retryable, false);
    });

    it('maps any other 400 to bad_request', async () => {
        const { fetchImpl } = stubFetch(gemini.error(400, 'Request contains an invalid argument.'));
        assert.equal((await rejection(call(gemini, fetchImpl))).kind, 'bad_request');
    });

    it('tells a per-minute 429 from a per-day one although both say "You exceeded your current quota"', async () => {
        const perMinute = await rejection(call(gemini, stubFetch(gemini.rateLimited()).fetchImpl));
        const perDay = await rejection(call(gemini, stubFetch(gemini.quotaSpent!()).fetchImpl));
        assert.equal(perMinute.message, perDay.message);
        assert.equal(perMinute.kind, 'rate');
        assert.equal(perMinute.retryable, true);
        assert.equal(perDay.kind, 'quota');
        assert.equal(perDay.retryable, false);
    });

    it('reads a blocked prompt as a refusal', async () => {
        const { fetchImpl } = stubFetch(jsonResponse(200, { promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 30 } }));
        const err = await rejection(call(gemini, fetchImpl));
        assert.equal(err.kind, 'refusal');
        assert.match(err.message, /blocked: SAFETY/);
    });

    it('counts the model\'s thinking as output tokens', async () => {
        const { fetchImpl } = stubFetch(jsonResponse(200, {
            candidates: [{ content: { parts: [{ text: JSON.stringify(ANSWER) }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20, thoughtsTokenCount: 300 },
        }));
        const out = await call(gemini, fetchImpl);
        assert.deepEqual(out.usage, { in: 90, out: 320 });
        assert.deepEqual(out.billed, [{ model: 'gemini-3.8-flash', in: 90, out: 320 }]);
    });
});

describe('generateJson (openai specifics)', () => {
    const effortSent = async (model: string, effort?: Effort) => {
        const { fetchImpl, calls } = stubFetch(openai.text(JSON.stringify(ANSWER)));
        await call(openai, fetchImpl, { model, ...(effort ? { effort } : {}) });
        return calls[0]!.body.reasoning?.effort;
    };

    it('asks for medium effort when the caller does not say, and passes every level through to the GPT-6 models', async () => {
        assert.equal(await effortSent('gpt-6-astra'), 'medium');
        for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
            assert.equal(await effortSent('gpt-6-astra', effort), effort);
            assert.equal(await effortSent('gpt-6.1-sol', effort), effort);
            assert.equal(await effortSent('gpt-5.6', effort), effort);
        }
    });

    it('sends max as xhigh to gpt-5.5, and xhigh and max as high to a model only known to have three levels, and no effort to one that does not reason', async () => {
        assert.equal(await effortSent('gpt-5.5', 'xhigh'), 'xhigh');
        assert.equal(await effortSent('gpt-5.5', 'max'), 'xhigh');
        assert.equal(await effortSent('gpt-5.4', 'xhigh'), 'high');
        assert.equal(await effortSent('gpt-7-nova', 'max'), 'high');
        assert.equal(await effortSent('o3', 'max'), 'high');
        assert.equal(await effortSent('o4-mini', 'low'), 'low');
        assert.equal(await effortSent('gpt-4.1', 'high'), undefined);
        assert.equal(await effortSent('gpt-5-chat-latest', 'high'), undefined);
    });

    it('keeps the prompt out of the account, flattens the schema into text.format with strict on, and sends no sampling parameters', async () => {
        const { fetchImpl, calls } = stubFetch(openai.text(JSON.stringify(ANSWER)));
        await call(openai, fetchImpl, { system: 'Be brief.', maxTokens: 777 });
        const body = calls[0]!.body;
        assert.equal(calls[0]!.url, 'https://api.openai.com/v1/responses');
        assert.equal(body.store, false);
        assert.equal(body.max_output_tokens, 777);
        assert.equal(body.instructions, 'Be brief.');
        assert.equal(body.text.format.type, 'json_schema');
        assert.equal(body.text.format.strict, true);
        assert.equal(body.text.format.name, 'answer');
        for (const field of ['temperature', 'top_p', 'response_format', 'messages', 'max_tokens', 'stream', 'tools']) assert.ok(!(field in body), field);
    });

    it('reads an optional field back out of strict mode: required and nullable on the way out, the null dropped on the way back', async () => {
        const { fetchImpl, calls } = stubFetch(openai.text('{"reply":"hi","score":null}'));
        const out = await call(openai, fetchImpl);
        const sent = calls[0]!.body.text.format.schema;
        assert.deepEqual(sent.required, ['reply', 'score']);
        assert.deepEqual(sent.properties.score.type, ['integer', 'null']);
        assert.equal(sent.additionalProperties, false);
        assert.deepEqual(out.json, { reply: 'hi' });
    });

    it('keeps a real value of an optional field', async () => {
        const { fetchImpl } = stubFetch(openai.text('{"reply":"hi","score":7}'));
        assert.deepEqual((await call(openai, fetchImpl)).json, { reply: 'hi', score: 7 });
    });

    it('refuses an array at the top level before any request, because strict mode needs an object there', async () => {
        const { fetchImpl, calls } = stubFetch(openai.text('[]'));
        const err = await rejection(call(openai, fetchImpl, { schema: { type: 'ARRAY', items: { type: 'STRING' } } }));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.retryable, false);
        assert.match(err.message, /JSON object at the top level/);
        assert.equal(calls.length, 0);
    });

    it('reads a content-filter stop as a refusal, and an answer with no text as bad_output', async () => {
        const filtered = jsonResponse(200, responsesBody({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, usage: { input_tokens: 50, output_tokens: 3 } }));
        const refused = await rejection(call(openai, stubFetch(filtered).fetchImpl));
        assert.equal(refused.kind, 'refusal');
        assert.match(refused.message, /content_filter/);
        assert.deepEqual(refused.usage, { in: 50, out: 3 });

        const onlyThinking = jsonResponse(200, responsesBody({ output: [{ type: 'reasoning', id: 'rs_1', summary: [] }], usage: { input_tokens: 50, output_tokens: 800 } }));
        const empty = await rejection(call(openai, stubFetch(onlyThinking).fetchImpl));
        assert.equal(empty.kind, 'bad_output');
        assert.match(empty.message, /no text/);
    });

    it('reads a response whose status is failed as the error its code names, with the tokens it was billed', async () => {
        const cases: Array<[string, AiErrorKind]> = [['server_error', 'server'], ['rate_limit_exceeded', 'rate'], ['invalid_prompt', 'bad_request']];
        for (const [code, kind] of cases) {
            const failed = jsonResponse(200, responsesBody({ status: 'failed', error: { code, message: `It failed: ${code}.` }, usage: { input_tokens: 60, output_tokens: 0 } }));
            const err = await rejection(call(openai, stubFetch(failed).fetchImpl));
            assert.equal(err.kind, kind, code);
            assert.equal(err.message, `It failed: ${code}.`);
            assert.deepEqual(err.usage, { in: 60, out: 0 });
        }
    });

    it('reads the 429 codes OpenAI uses for an empty balance or a spend cap as quota, and a rate limit as rate', async () => {
        for (const code of ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']) {
            const err = await rejection(call(openai, stubFetch(openAiError(429, 'Your request could not be completed.', code)).fetchImpl));
            assert.equal(err.kind, 'quota', code);
            assert.equal(err.retryable, false);
        }
        const slow = await rejection(call(openai, stubFetch(openAiError(429, 'You are sending requests too quickly.', 'slow_down')).fetchImpl));
        assert.equal(slow.kind, 'rate');
    });
});

describe('generateJson (openrouter specifics)', () => {
    it('asks for strict structured output nested in response_format, and only from endpoints that support it', async () => {
        const { fetchImpl, calls } = stubFetch(openrouter.text(JSON.stringify(ANSWER)));
        await call(openrouter, fetchImpl, { system: 'Be brief.', maxTokens: 777 });
        const { body, headers, url } = calls[0]!;
        assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(body.response_format.json_schema.strict, true);
        assert.equal(body.response_format.json_schema.name, 'answer');
        assert.deepEqual(body.provider, { require_parameters: true });
        assert.equal(body.max_tokens, 777);
        assert.deepEqual(body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello.' }]);
        // `usage: {include: true}` is documented as deprecated and without effect, so it is not sent.
        for (const field of ['usage', 'max_completion_tokens', 'temperature', 'stream', 'reasoning']) assert.ok(!(field in body), field);
        assert.deepEqual(Object.keys(headers).sort(), ['authorization', 'content-type']);
    });

    it('bills what OpenRouter says it charged, which beats the price table, even for a model the table has never heard of', async () => {
        const charged = jsonResponse(200, chatBody(
            'anthropic/claude-opus-5.5',
            { message: { role: 'assistant', content: JSON.stringify(ANSWER) }, finish_reason: 'stop' },
            { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190, cost: 0.00123, is_byok: false, cost_details: { upstream_inference_cost: null } },
        ));
        const out = await call(openrouter, stubFetch(charged).fetchImpl);
        assert.deepEqual(out.billed, [{ model: 'openrouter/auto', in: 150, out: 40, usd: 0.00123, source: 'provider' }]);
        assert.deepEqual(out.usage, { in: 150, out: 40 });
        const cost = costOf(out.billed, DEFAULT_PRICES);
        assert.equal(cost.usd, 0.00123);
        assert.equal(cost.priced, true);

        // Without it, the same unknown model is charged at the table's ceiling and flagged.
        const unpriced = await call(openrouter, stubFetch(openrouter.text(JSON.stringify(ANSWER), { input: 150, output: 40 })).fetchImpl);
        assert.equal(costOf(unpriced.billed, DEFAULT_PRICES).priced, false);
    });

    it('does not take the cost of a call that was billed to the caller\'s own provider key as the call\'s cost', async () => {
        const byok = jsonResponse(200, chatBody(
            'openai/gpt-6-astra',
            { message: { role: 'assistant', content: JSON.stringify(ANSWER) }, finish_reason: 'stop' },
            { prompt_tokens: 150, completion_tokens: 40, cost: 0.00001, is_byok: true },
        ));
        const out = await call(openrouter, stubFetch(byok).fetchImpl);
        assert.ok(!('usd' in out.billed[0]!));
    });

    it('reports the model the router picked, and keeps billing under the id that was asked for', async () => {
        const routed = jsonResponse(200, chatBody(
            'anthropic/claude-sonnet-5.5',
            { message: { role: 'assistant', content: JSON.stringify(ANSWER) }, finish_reason: 'stop' },
            { prompt_tokens: 10, completion_tokens: 5 },
        ));
        const out = await call(openrouter, stubFetch(routed).fetchImpl);
        assert.equal(out.model, 'anthropic/claude-sonnet-5.5');
        assert.equal(out.billed[0]!.model, 'openrouter/auto');
    });

    it('sends reasoning to an OpenAI model that has it, as OpenAI would take it, and to no other model', async () => {
        const reasoningFor = async (model: string, effort: Effort) => {
            const { fetchImpl, calls } = stubFetch(openrouter.text(JSON.stringify(ANSWER)));
            await call(openrouter, fetchImpl, { model, effort });
            return calls[0]!.body.reasoning;
        };
        assert.deepEqual(await reasoningFor('openai/gpt-6.1-sol', 'xhigh'), { effort: 'xhigh' });
        assert.deepEqual(await reasoningFor('openai/gpt-6.1-sol:batch', 'max'), { effort: 'max' });
        assert.deepEqual(await reasoningFor('openai/gpt-5.5', 'max'), { effort: 'xhigh' });
        assert.deepEqual(await reasoningFor('openai/gpt-5.4', 'xhigh'), { effort: 'high' });
        for (const model of ['openai/gpt-4o', 'openai/gpt-5-chat', 'anthropic/claude-opus-5.5', 'google/gemini-3.8-flash', 'openrouter/auto', 'x-ai/grok-4']) {
            assert.equal(await reasoningFor(model, 'high'), undefined, model);
        }
    });

    it('reads an optional field back out of strict mode, as OpenAI\'s does', async () => {
        const { fetchImpl, calls } = stubFetch(openrouter.text('{"reply":"hi","score":null}'));
        const out = await call(openrouter, fetchImpl);
        assert.deepEqual(calls[0]!.body.response_format.json_schema.schema.required, ['reply', 'score']);
        assert.deepEqual(out.json, { reply: 'hi' });
    });

    it('reads a failure that came back inside a 200 as the HTTP error its code stands for', async () => {
        const cases: Array<[Record<string, unknown>, AiErrorKind, boolean]> = [
            [{ code: 502, message: 'Provider returned error' }, 'server', true],
            [{ code: 402, message: 'Insufficient credits.' }, 'quota', false],
            [{ code: 401, message: 'No auth credentials found' }, 'auth', false],
            [{ code: 429, message: 'Rate limit exceeded' }, 'rate', true],
            [{ message: 'The upstream provider fell over.' }, 'server', true],
        ];
        for (const [error, kind, retryable] of cases) {
            const { fetchImpl, calls } = stubFetch(jsonResponse(200, { error }), openrouter.text(JSON.stringify(ANSWER)));
            const err = await rejection(call(openrouter, fetchImpl));
            assert.equal(err.kind, kind, JSON.stringify(error));
            assert.equal(err.retryable, retryable);
            assert.equal(calls.length, 1);
        }
    });

    it('reads a choice that ended in error, with the tokens it was billed, as a server failure', async () => {
        const failed = jsonResponse(200, chatBody(
            'openrouter/auto',
            { message: { role: 'assistant', content: '' }, finish_reason: 'error', error: { code: 502, message: 'Upstream closed the stream.' } },
            { prompt_tokens: 80, completion_tokens: 0 },
        ));
        const err = await rejection(call(openrouter, stubFetch(failed).fetchImpl));
        assert.equal(err.kind, 'server');
        assert.deepEqual(err.usage, { in: 80, out: 0 });
        const bare = jsonResponse(200, chatBody('openrouter/auto', { message: { role: 'assistant', content: null }, finish_reason: 'error' }, { prompt_tokens: 1, completion_tokens: 0 }));
        assert.equal((await rejection(call(openrouter, stubFetch(bare).fetchImpl))).kind, 'server');
    });

    it('reads a content-filter stop as a refusal', async () => {
        const filtered = jsonResponse(200, chatBody('openrouter/auto', { message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }, { prompt_tokens: 40, completion_tokens: 0 }));
        const err = await rejection(call(openrouter, stubFetch(filtered).fetchImpl));
        assert.equal(err.kind, 'refusal');
        assert.match(err.message, /content_filter/);
    });

    it('reads a 403 by its body: a moderation flag or a guardrail is a refusal, a spent limit is quota, a key that may not is auth', async () => {
        const cases: Array<[string, Record<string, unknown> | undefined, string]> = [
            ['Your input was flagged by moderation', { reasons: ['harassment'], flagged_input: 'a flagged sentence', provider_name: 'OpenAI', model_slug: 'openai/gpt-6-astra' }, 'refusal'],
            ['Blocked by a guardrail', { guardrail_id: 'gr_1' }, 'refusal'],
            ['Key limit exceeded', { limit_source: 'openrouter_key_limit' }, 'quota'],
            ['Your daily budget is spent', { limit_source: 'openrouter_in_flight_budget' }, 'quota'],
            ['Insufficient permissions', undefined, 'auth'],
        ];
        for (const [message, metadata, kind] of cases) {
            const { fetchImpl, calls } = stubFetch(openRouterError(403, message, metadata), openrouter.text(JSON.stringify(ANSWER)));
            const err = await rejection(call(openrouter, fetchImpl));
            assert.equal(err.kind, kind, message);
            assert.equal(err.status, 403);
            assert.equal(err.retryable, false);
            assert.equal(err.message, message);
            assert.equal(calls.length, 1);
        }
        // The same words from a Custom endpoint are just a key that may not.
        const custom403 = await rejection(call(custom, stubFetch(jsonResponse(403, { error: { message: 'Blocked by a guardrail', metadata: { limit_source: 'x', reasons: ['x'] } } })).fetchImpl));
        assert.equal(custom403.kind, 'auth');
    });

    it('reads a model that routed nowhere (OpenRouter\'s 404) as bad_request, with its own explanation', async () => {
        const message = 'No endpoints found that can handle the requested parameters.';
        const err = await rejection(call(openrouter, stubFetch(openRouterError(404, message)).fetchImpl, { model: 'some/model-without-schemas' }));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.message, message);
    });
});

describe('generateJson (groq specifics)', () => {
    it('asks for strict structured output nested in response_format, with reasoning_effort and include_reasoning, and nothing that is OpenRouter\'s', async () => {
        const { fetchImpl, calls } = stubFetch(groq.text(JSON.stringify(ANSWER)));
        await call(groq, fetchImpl, { system: 'Be brief.', maxTokens: 777, effort: 'low' });
        const { body, headers, url } = calls[0]!;
        assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
        assert.equal(body.model, 'openai/gpt-oss-120b');
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(body.response_format.json_schema.strict, true);
        assert.equal(body.response_format.json_schema.name, 'answer');
        assert.deepEqual(body.response_format.json_schema.schema.required, ['reply', 'score']);
        assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
        assert.equal(body.reasoning_effort, 'low');
        assert.equal(body.include_reasoning, false);
        assert.equal(body.max_tokens, 777);
        assert.deepEqual(body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello.' }]);
        for (const field of ['provider', 'reasoning', 'usage', 'max_completion_tokens', 'temperature', 'stream']) assert.ok(!(field in body), field);
        assert.deepEqual(Object.keys(headers).sort(), ['authorization', 'content-type']);
    });

    it('sends reasoning_effort for gpt-oss only, as low, medium or high, with xhigh and max sent as high', async () => {
        const sent = async (model: string, effort: Effort) => {
            const { fetchImpl, calls } = stubFetch(groq.text(JSON.stringify(ANSWER)));
            await call(groq, fetchImpl, { model, effort });
            return [calls[0]!.body.reasoning_effort, calls[0]!.body.include_reasoning];
        };
        assert.deepEqual(await sent('openai/gpt-oss-20b', 'low'), ['low', false]);
        assert.deepEqual(await sent('openai/gpt-oss-120b', 'medium'), ['medium', false]);
        assert.deepEqual(await sent('openai/gpt-oss-120b', 'high'), ['high', false]);
        assert.deepEqual(await sent('openai/gpt-oss-120b', 'xhigh'), ['high', false]);
        assert.deepEqual(await sent('openai/gpt-oss-120b', 'max'), ['high', false]);
        for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
            assert.deepEqual(await sent(model, 'high'), [undefined, undefined], model);
        }
    });

    it('bills the tokens Groq reports under the model it was asked for, and prices them from the table: no cost is taken from the answer', async () => {
        const withCost = jsonResponse(200, chatBody(
            'openai/gpt-oss-120b',
            { message: { role: 'assistant', content: JSON.stringify(ANSWER), reasoning: 'thinking it over' }, finish_reason: 'stop' },
            { prompt_tokens: 150, completion_tokens: 40, total_tokens: 190, completion_tokens_details: { reasoning_tokens: 22 }, cost: 99 },
        ));
        const out = await call(groq, stubFetch(withCost).fetchImpl);
        assert.deepEqual(out.billed, [{ model: 'openai/gpt-oss-120b', in: 150, out: 40 }]);
        assert.deepEqual(out.json, ANSWER);
        assert.ok(!JSON.stringify(out).includes('thinking it over'), 'the reasoning text is never part of the answer');
        // Groq's own rate from the table ($0.15 / $0.60 a million), not the `cost: 99` in the body.
        assert.deepEqual(costOf(out.billed, DEFAULT_PRICES).usd, (150 * 0.15 + 40 * 0.6) / 1e6);
    });

    it('reads an optional field back out of strict mode, as OpenAI\'s does', async () => {
        const { fetchImpl } = stubFetch(groq.text('{"reply":"hi","score":null}'));
        assert.deepEqual((await call(groq, fetchImpl)).json, { reply: 'hi' });
    });

    it('reads status 498, the flex tier out of capacity, as a server error to try again from one request, with the wait it asks for', async () => {
        const { fetchImpl, calls } = stubFetch(groqError(498, 'Flex tier capacity exceeded. Please retry later.', 'capacity_exceeded'), groq.text(JSON.stringify(ANSWER)));
        const err = await rejection(call(groq, fetchImpl));
        assert.equal(err.kind, 'server');
        assert.equal(err.status, 498);
        assert.equal(err.retryable, true);
        assert.equal(err.provider, 'groq');
        assert.equal(calls.length, 1);
        const waiting = await rejection(call(groq, stubFetch(jsonResponse(498, { error: { message: 'Retry later.', type: 'capacity_exceeded' } }, { 'retry-after': '12' })).fetchImpl));
        assert.equal(waiting.retryAfterMs, 12_000);
    });

    it('is the only provider for which 498 is a server error', async () => {
        for (const fx of [anthropic, openai, gemini, openrouter, custom]) {
            const err = await rejection(call(fx, stubFetch(fx.error(498, 'odd')).fetchImpl));
            assert.equal(err.kind, 'bad_request', fx.provider);
            assert.equal(err.retryable, false, fx.provider);
        }
    });

    it('reads every 429 as a rate limit, whatever its words say: Groq\'s limits are lifted by waiting, and its messages point at where to upgrade', async () => {
        const message = 'Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD). Need more tokens? Upgrade at https://console.groq.com/settings/billing';
        const { fetchImpl, calls } = stubFetch(groqError(429, message, 'tokens'), groq.text(JSON.stringify(ANSWER)));
        const err = await rejection(call(groq, fetchImpl));
        assert.equal(err.kind, 'rate');
        assert.equal(err.retryable, true);
        assert.equal(calls.length, 1);
    });
});

describe('generateJson (custom specifics)', () => {
    it('posts to the operator\'s base URL, tidied, and to nothing else', async () => {
        const { fetchImpl, calls } = stubFetch(custom.text(JSON.stringify(ANSWER)));
        await call(custom, fetchImpl, { baseUrl: '  https://llm.example.com/openai/v1/  ' });
        assert.equal(calls[0]!.url, 'https://llm.example.com/openai/v1/chat/completions');
    });

    it('sends no authorization header at all to an endpoint that needs no key', async () => {
        const { fetchImpl, calls } = stubFetch(custom.text(JSON.stringify(ANSWER)));
        const out = await call(custom, fetchImpl, { apiKey: '' });
        assert.deepEqual(out.json, ANSWER);
        assert.ok(!('authorization' in calls[0]!.headers));
    });

    it('asks for a strict json_schema by default, and sends no routing object, no reasoning and no OpenRouter fields', async () => {
        const { fetchImpl, calls } = stubFetch(custom.text(JSON.stringify(ANSWER)));
        await call(custom, fetchImpl, { effort: 'max' });
        const body = calls[0]!.body;
        assert.equal(body.response_format.type, 'json_schema');
        assert.equal(body.response_format.json_schema.strict, true);
        for (const field of ['provider', 'reasoning', 'usage', 'max_completion_tokens']) assert.ok(!(field in body), field);
        assert.equal(body.max_tokens, 1000);
    });

    it('in JSON-object mode asks for json_object, describes the schema in the system prompt, and reads an answer in a code fence', async () => {
        const { fetchImpl, calls } = stubFetch(custom.text('```json\n{"reply":"hi","score":null}\n```'));
        const out = await call(custom, fetchImpl, { jsonMode: 'object', system: 'You answer in Arabic.' });
        const body = calls[0]!.body;
        assert.deepEqual(body.response_format, { type: 'json_object' });
        const system: string = body.messages[0].content;
        assert.ok(system.startsWith('You answer in Arabic.'));
        assert.match(system, /JSON/);
        // The schema as the caller wrote it, not the strict one: `score` is optional, not nullable.
        assert.ok(system.includes('"required":["reply"]'));
        assert.ok(!system.includes('"null"'));
        // The model's own null for an optional field goes the way strict mode's does.
        assert.deepEqual(out.json, { reply: 'hi' });
    });

    it('in JSON-object mode works with no system prompt at all, putting the schema first', async () => {
        const { fetchImpl, calls } = stubFetch(custom.text(JSON.stringify(ANSWER)));
        await call(custom, fetchImpl, { jsonMode: 'object', system: '' });
        assert.match(calls[0]!.body.messages[0].content, /^Answer with a single JSON object/);
    });

    it('in JSON-object mode refuses an array at the top level, which JSON mode cannot give', async () => {
        const { fetchImpl, calls } = stubFetch(custom.text('[]'));
        const err = await rejection(call(custom, fetchImpl, { jsonMode: 'object', schema: { type: 'ARRAY', items: { type: 'STRING' } } }));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /JSON-object mode/);
        assert.equal(calls.length, 0);
    });

    it('refuses a JSON mode that is neither schema nor object, before any request', async () => {
        const { fetchImpl, calls } = stubFetch(custom.text(JSON.stringify(ANSWER)));
        const err = await rejection(call(custom, fetchImpl, { jsonMode: 'grammar' as never }));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /JSON mode must be "schema" or "object"/);
        assert.equal(calls.length, 0);
    });

    it('does not offer JSON-object mode to a provider that is not Custom: OpenRouter, Groq and OpenAI stay on strict schemas', async () => {
        const router = stubFetch(openrouter.text(JSON.stringify(ANSWER)));
        await call(openrouter, router.fetchImpl, { jsonMode: 'object' });
        assert.equal(router.calls[0]!.body.response_format.type, 'json_schema');
        const fast = stubFetch(groq.text(JSON.stringify(ANSWER)));
        await call(groq, fast.fetchImpl, { jsonMode: 'object' });
        assert.equal(fast.calls[0]!.body.response_format.type, 'json_schema');
        const direct = stubFetch(openai.text(JSON.stringify(ANSWER)));
        await call(openai, direct.fetchImpl, { jsonMode: 'object' });
        assert.equal(direct.calls[0]!.body.text.format.type, 'json_schema');
        // Not even an invalid value is looked at for a provider that has no use for it.
        await call(openrouter, stubFetch(openrouter.text(JSON.stringify(ANSWER))).fetchImpl, { jsonMode: 'grammar' as never });
    });

    it('reads an array of content parts as text, which some compatible servers send', async () => {
        const parts = jsonResponse(200, chatBody('llama-4-maverick', { message: { role: 'assistant', content: [{ type: 'text', text: '{"reply":' }, { type: 'text', text: '"hi"}' }] }, finish_reason: 'stop' }, { prompt_tokens: 5, completion_tokens: 4 }));
        assert.deepEqual((await call(custom, stubFetch(parts).fetchImpl)).json, { reply: 'hi' });
    });

    it('is told "no text" when the server sends no choices at all', async () => {
        const err = await rejection(call(custom, stubFetch(jsonResponse(200, { id: 'x', choices: [], usage: { prompt_tokens: 9, completion_tokens: 0 } })).fetchImpl));
        assert.equal(err.kind, 'bad_output');
        assert.match(err.message, /no text/);
        assert.deepEqual(err.usage, { in: 9, out: 0 });
    });

    it('never takes a cost from the endpoint: only OpenRouter\'s figure is a price', async () => {
        const withCost = jsonResponse(200, chatBody('llama-4-maverick', { message: { role: 'assistant', content: JSON.stringify(ANSWER) }, finish_reason: 'stop' }, { prompt_tokens: 5, completion_tokens: 4, cost: 99 }));
        assert.deepEqual((await call(custom, stubFetch(withCost).fetchImpl)).billed, [{ model: 'llama-4-maverick', in: 5, out: 4 }]);
    });
});

describe('an answer that leaves out a required field', () => {
    for (const fx of [anthropic, openai, gemini, openrouter, groq, custom]) {
        describe(fx.provider, () => {
            it('is bad_output, retryable once, naming the field and billed, because some endpoints take strict for a hint', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text('{"score":3}', { input: 77, output: 9 }));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'bad_output');
                assert.equal(err.retryable, true);
                assert.match(err.message, /missing a required field: reply/);
                assert.deepEqual(err.usage, { in: 77, out: 9 });
                assert.equal(calls.length, 1);
            });

            it('lists every one that is missing, and a key that is there as null counts as there', async () => {
                const schema: GeminiSchema = { type: 'OBJECT', properties: { a: { type: 'STRING' }, b: { type: 'STRING' }, c: { type: 'STRING' } }, required: ['a', 'b', 'c'] };
                const both = await rejection(call(fx, stubFetch(fx.text('{"b":"x"}')).fetchImpl, { schema }));
                assert.match(both.message, /missing required fields: a, c/);
                const nulls = await call(fx, stubFetch(fx.text('{"a":null,"b":"x","c":null}')).fetchImpl, { schema });
                assert.deepEqual(nulls.json, { a: null, b: 'x', c: null });
            });
        });
    }

    it('checks a {json} schema\'s required keys at the top level only, and a schema that requires nothing needs nothing', async () => {
        const json = { type: 'object', properties: { a: { type: 'string' }, inner: { type: 'object', properties: { deep: { type: 'string' } }, required: ['deep'] } }, required: ['a'] };
        const deep = await call(anthropic, stubFetch(anthropic.text('{"a":"x","inner":{}}')).fetchImpl, { schema: { json } });
        assert.deepEqual(deep.json, { a: 'x', inner: {} });
        const err = await rejection(call(anthropic, stubFetch(anthropic.text('{"inner":{"deep":"y"}}')).fetchImpl, { schema: { json } }));
        assert.match(err.message, /missing a required field: a/);
        const none = await call(anthropic, stubFetch(anthropic.text('{}')).fetchImpl, { schema: { type: 'OBJECT', properties: { a: { type: 'STRING' } } } });
        assert.deepEqual(none.json, {});
    });

    it('does not mistake a null for a missing field: strict mode\'s nulls for optional fields are dropped, a required field\'s own is kept', async () => {
        const out = await call(openai, stubFetch(openai.text('{"reply":"hi","score":null}')).fetchImpl);
        assert.deepEqual(out.json, { reply: 'hi' });
        const err = await rejection(call(openai, stubFetch(openai.text('{"score":null}')).fetchImpl));
        assert.equal(err.kind, 'bad_output');
    });

    it('is not asked of an array, which has no keys', async () => {
        const out = await call(anthropic, stubFetch(anthropic.text('[{"a":1}]')).fetchImpl, { schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { a: { type: 'INTEGER' } }, required: ['a'] } } });
        assert.deepEqual(out.json, [{ a: 1 }]);
    });
});

describe('a limit below what the model needs to think', () => {
    const lines: Array<Record<string, any>> = [];
    let restore: (() => void) | undefined;
    afterEach(() => restore?.());
    const capture = () => {
        lines.length = 0;
        const previous = setLogSink((_level, line) => void lines.push(JSON.parse(line)));
        restore = () => void setLogSink(previous);
    };
    const warnings = () => lines.filter((l) => l['event'] === 'llm.max_tokens_low');

    it('is logged as a warning with the provider, model, effort, the limit asked for and the one recommended, and the call goes ahead', async () => {
        capture();
        const out = await call(openai, stubFetch(openai.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 2000, effort: 'high' });
        assert.deepEqual(out.json, ANSWER);
        assert.equal(warnings().length, 1);
        const w = warnings()[0]!;
        assert.equal(w['level'], 'warn');
        assert.equal(w['provider'], 'openai');
        assert.equal(w['model'], 'gpt-6-astra');
        assert.equal(w['effort'], 'high');
        assert.equal(w['limit'], 2000);
        assert.equal(w['recommended'], 25_000);
        // No field of it was redacted by name, and the key is not in it.
        assert.ok(!JSON.stringify(w).includes('redacted'));
        assert.ok(!JSON.stringify(w).includes(openai.key));
    });

    it('is logged for every provider that thinks, at that provider\'s own figure', async () => {
        capture();
        await call(anthropic, stubFetch(anthropic.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 1000, effort: 'low' });
        await call(gemini, stubFetch(gemini.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 1000, effort: 'medium' });
        await call(openrouter, stubFetch(openrouter.text(JSON.stringify(ANSWER))).fetchImpl, { model: 'openai/gpt-6.1-sol', maxTokens: 1000 });
        assert.deepEqual(warnings().map((w) => [w['provider'], w['recommended']]), [['anthropic', 4000], ['gemini', 8192], ['openrouter', 25_000]]);
    });

    it('is the default effort that is looked at when the caller names none', async () => {
        capture();
        await call(anthropic, stubFetch(anthropic.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 5000 });
        assert.equal(warnings()[0]!['effort'], 'medium');
        assert.equal(warnings()[0]!['recommended'], 8000);
    });

    it('is not logged at the recommended limit or above it, nor for a model or provider with no minimum', async () => {
        capture();
        await call(openai, stubFetch(openai.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 25_000 });
        await call(anthropic, stubFetch(anthropic.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 8000 });
        await call(openai, stubFetch(openai.text(JSON.stringify(ANSWER))).fetchImpl, { model: 'gpt-4.1', maxTokens: 100 });
        await call(custom, stubFetch(custom.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 100 });
        await call(openrouter, stubFetch(openrouter.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 100 });
        // Groq has no minimum, gpt-oss included: it counts max_tokens against the free tier's 8 000 tokens a minute (limits.ts).
        await call(groq, stubFetch(groq.text(JSON.stringify(ANSWER))).fetchImpl, { maxTokens: 1000 });
        await call(groq, stubFetch(groq.text(JSON.stringify(ANSWER))).fetchImpl, { model: 'llama-3.3-70b-versatile', maxTokens: 100 });
        assert.equal(warnings().length, 0);
    });

    it('is not logged for a call that was refused before it began, such as one with no key', async () => {
        capture();
        await rejection(call(openai, stubFetch().fetchImpl, { apiKey: '', maxTokens: 10 }));
        assert.equal(warnings().length, 0);
    });
});

describe('generateJson before any request is made', () => {
    it('is no_provider when a provider that needs a key has none, without calling anyone', async () => {
        for (const apiKey of ['', '   ']) {
            const { fetchImpl, calls } = stubFetch();
            const err = await rejection(call(anthropic, fetchImpl, { apiKey }));
            assert.equal(err.kind, 'no_provider');
            assert.equal(err.retryable, false);
            assert.match(err.message, /No API key is saved for Anthropic/);
            assert.equal(calls.length, 0);
        }
    });

    it('is bad_request for a provider that does not exist', async () => {
        const { fetchImpl, calls } = stubFetch();
        const err = await rejection(call(anthropic, fetchImpl, { provider: 'mistral' as ProviderId }));
        assert.equal(err.kind, 'bad_request');
        assert.equal(calls.length, 0);
    });

    describe('Custom\'s base URL, the one address someone types', () => {
        const custom = (baseUrl: string | undefined) => {
            const { fetchImpl, calls } = stubFetch();
            return { calls, result: rejection(call(anthropic, fetchImpl, { provider: 'custom', apiKey: '', model: 'm', baseUrl })) };
        };

        it('is required: Custom has none of its own', async () => {
            for (const baseUrl of [undefined, '', '   ']) {
                const { calls, result } = custom(baseUrl);
                const err = await result;
                assert.equal(err.kind, 'bad_request');
                assert.match(err.message, /no base URL/);
                assert.equal(calls.length, 0);
            }
        });

        it('must be https', async () => {
            const { calls, result } = custom('http://llm.example.com/v1');
            const err = await result;
            assert.equal(err.kind, 'bad_request');
            assert.equal(err.retryable, false);
            assert.match(err.message, /base URL must start with https/);
            assert.equal(calls.length, 0);
        });

        it('must be a public address: no IP literal, localhost, .local or .internal, however spelled', async () => {
            for (const url of ['https://127.0.0.1/v1', 'https://169.254.169.254/', 'https://[::1]/v1', 'https://localhost:8080', 'https://box.local', 'https://db.internal', 'https://2130706433/']) {
                const { calls, result } = custom(url);
                const err = await result;
                assert.equal(err.kind, 'bad_request', url);
                assert.match(err.message, /public address/, url);
                assert.equal(calls.length, 0);
            }
        });

        it('may not carry credentials or a query', async () => {
            for (const url of ['https://user:secret@llm.example.com', 'https://llm.example.com/v1?key=abc']) {
                const err = await custom(url).result;
                assert.equal(err.kind, 'bad_request', url);
                assert.ok(!printed(err).includes('secret'), url);
            }
        });

        it('is ignored, however bad, for a provider that has its own address', async () => {
            for (const fx of [anthropic, openai, gemini, openrouter, groq]) {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                const out = await call(fx, fetchImpl, { baseUrl: 'http://10.0.0.5/not-a-url-we-would-allow' });
                assert.deepEqual(out.json, ANSWER);
                assert.ok(calls[0]!.url.startsWith(fx.origin));
            }
        });
    });

    describe('the limits it is given', () => {
        const rejects = async (over: Partial<GenerateJsonArgs>, pattern: RegExp) => {
            const { fetchImpl, calls } = stubFetch(anthropic.text(JSON.stringify(ANSWER)));
            const err = await rejection(call(anthropic, fetchImpl, over));
            assert.equal(err.kind, 'bad_request', JSON.stringify(over));
            assert.equal(err.retryable, false);
            assert.match(err.message, pattern);
            assert.equal(calls.length, 0, 'nothing is sent for a limit that means nothing');
        };

        it('needs timeoutMs to be a positive whole number', async () => {
            for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5000', null, undefined]) {
                await rejects({ timeoutMs: timeoutMs as number }, /timeoutMs must be a positive whole number/);
            }
        });

        it('needs maxTokens to be a positive whole number', async () => {
            for (const maxTokens of [0, -5, 100.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', null, undefined]) {
                await rejects({ maxTokens: maxTokens as number }, /maxTokens must be a positive whole number/);
            }
        });

        it('checks them before it looks for a key or a provider', async () => {
            const { fetchImpl } = stubFetch();
            assert.match((await rejection(call(anthropic, fetchImpl, { apiKey: '', timeoutMs: 0 }))).message, /timeoutMs/);
            assert.match((await rejection(call(anthropic, fetchImpl, { provider: 'mistral' as ProviderId, maxTokens: 0 }))).message, /maxTokens/);
        });

        describe('and caps the deadline', () => {
            const originalTimeout = AbortSignal.timeout;
            afterEach(() => {
                AbortSignal.timeout = originalTimeout;
            });
            const deadlineFor = async (timeoutMs: number) => {
                const seen: number[] = [];
                AbortSignal.timeout = (ms: number) => {
                    seen.push(ms);
                    return originalTimeout.call(AbortSignal, ms);
                };
                await call(anthropic, stubFetch(anthropic.text(JSON.stringify(ANSWER))).fetchImpl, { timeoutMs });
                return seen;
            };

            it('at 150 seconds, however long a caller asks for', async () => {
                assert.equal(MAX_TIMEOUT_MS, 150_000);
                assert.deepEqual(await deadlineFor(10_000_000), [150_000]);
                assert.deepEqual(await deadlineFor(150_001), [150_000]);
            });

            it('and leaves a shorter one alone', async () => {
                assert.deepEqual(await deadlineFor(150_000), [150_000]);
                assert.deepEqual(await deadlineFor(8000), [8000]);
                assert.deepEqual(await deadlineFor(1), [1]);
            });
        });
    });
});

describe('callLlm with an adapter of its own', () => {
    const args: GenerateJsonArgs = {
        provider: 'anthropic', apiKey: 'sk-ant-test-0123456789abcdef', model: 'claude-opus-5-5', system: 's', user: 'u',
        schema: SCHEMA, maxTokens: 100, timeoutMs: 1000,
    };
    const answering = (text: string): AdapterResult => ({
        text, usage: { in: 1, out: 1 }, billed: [{ model: 'claude-opus-5-5', in: 1, out: 1 }], model: 'claude-opus-5-5', stopReason: 'end_turn',
    });
    const family = (generate: FamilyAdapter['generate'], normalize?: FamilyAdapter['normalize']): FamilyAdapters => ({ anthropic: { generate, ...(normalize ? { normalize } : {}) } });

    describe('the base URL it hands the adapter', () => {
        /** An adapter that records what it was given. */
        const recording = () => {
            const seen: Array<string | undefined> = [];
            const generate: FamilyAdapter['generate'] = async (a) => {
                seen.push(a.baseUrl);
                return answering('{"reply":"hi"}');
            };
            return { seen, generate };
        };

        it('is none, for a provider whose registry entry has an address of its own', async () => {
            const { seen, generate } = recording();
            await callLlm({ ...args, baseUrl: 'https://evil.example.com/v1' }, { anthropic: { generate } });
            await callLlm({ ...args, provider: 'gemini', model: 'gemini-3.8-flash', baseUrl: 'https://evil.example.com/v1' }, { gemini: { generate } });
            assert.deepEqual(seen, [undefined, undefined]);
        });

        it('is Custom\'s own, checked and tidied: https, public, without the trailing slash', async () => {
            const { seen, generate } = recording();
            const custom = { ...args, provider: 'custom' as const, apiKey: '', model: 'llama-4' };
            await callLlm({ ...custom, baseUrl: '  https://llm.example.com/v1/  ' }, { chat_completions: { generate } });
            assert.deepEqual(seen, ['https://llm.example.com/v1']);
            // And an address that fails the check never reaches the adapter.
            await rejection(callLlm({ ...custom, baseUrl: 'http://llm.example.com/v1' }, { chat_completions: { generate } }));
            await rejection(callLlm({ ...custom, baseUrl: 'https://10.0.0.5/v1' }, { chat_completions: { generate } }));
            assert.equal(seen.length, 1);
        });
    });

    describe('cacheSystem, the flag the adapter is handed', () => {
        const seenArgs = () => {
            const seen: Array<Record<string, unknown>> = [];
            const generate: FamilyAdapter['generate'] = async (a) => {
                seen.push({ ...a });
                return answering('{"reply":"hi"}');
            };
            return { seen, generate };
        };

        it('is passed on as true when the caller asked, and is not a key of the adapter\'s arguments when it did not', async () => {
            const { seen, generate } = seenArgs();
            await callLlm({ ...args }, { anthropic: { generate } });
            await callLlm({ ...args, cacheSystem: false }, { anthropic: { generate } });
            await callLlm({ ...args, cacheSystem: undefined }, { anthropic: { generate } });
            await callLlm({ ...args, cacheSystem: true }, { anthropic: { generate } });
            assert.deepEqual(seen.map((a) => 'cacheSystem' in a), [false, false, false, true]);
            assert.equal(seen[3]!.cacheSystem, true);
        });

        it('only a boolean true counts: a truthy string or a number does not ask for a cache', async () => {
            const { seen, generate } = seenArgs();
            for (const cacheSystem of ['true', 1, {}]) await callLlm({ ...args, cacheSystem: cacheSystem as unknown as boolean }, { anthropic: { generate } });
            assert.deepEqual(seen.map((a) => 'cacheSystem' in a), [false, false, false]);
        });
    });

    describe('an unforeseen failure', () => {
        it('is bad_request, not retryable: asking again would hit the same bug', async () => {
            const err = await rejection(callLlm(args, family(async () => { throw new TypeError('x.map is not a function'); })));
            assert.equal(err.kind, 'bad_request');
            assert.equal(err.retryable, false);
            assert.match(err.message, /Unexpected failure: x\.map is not a function/);
        });

        it('is scrubbed of the key like every other message', async () => {
            const err = await rejection(callLlm(args, family(async () => { throw new Error(`boom with ${args.apiKey} inside`); })));
            assert.ok(!printed(err).includes(args.apiKey));
        });

        it('is still timeout when it is a deadline', async () => {
            const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
            const err = await rejection(callLlm(args, family(async () => { throw aborted; })));
            assert.equal(err.kind, 'timeout');
            assert.equal(err.retryable, true);
        });

        it('leaves an AiError the adapter threw exactly as it was', async () => {
            const own = new AiError({ kind: 'quota', provider: 'anthropic', model: 'm', status: 429, message: 'spent' });
            assert.equal(await rejection(callLlm(args, family(async () => { throw own; }))), own);
        });
    });

    describe('normalize, the family\'s hook after the answer is parsed', () => {
        it('is applied to the parsed answer, and its result is what is returned', async () => {
            const seen: unknown[] = [];
            const out = await callLlm(args, family(
                async () => answering('{"reply":"hi","score":null}'),
                (json, schema) => {
                    seen.push(schema);
                    const { score, ...rest } = json as Record<string, unknown>;
                    return score === null ? rest : json;
                },
            ));
            assert.deepEqual(out.json, { reply: 'hi' });
            assert.deepEqual(seen, [SCHEMA]);
        });

        it('runs before the shape is judged, so it can repair the top level', async () => {
            // The family hands back a bare list; its hook wraps it the way the schema asks.
            const out = await callLlm(args, family(async () => answering('[{"reply":"hi"}]'), (json) => ({ reply: (json as Array<{ reply: string }>)[0]!.reply })));
            assert.deepEqual(out.json, { reply: 'hi' });
            // Without the hook, the same answer is the wrong shape.
            const err = await rejection(callLlm(args, family(async () => answering('[{"reply":"hi"}]'))));
            assert.equal(err.kind, 'bad_output');
        });

        it('is not run on a refusal or a cut-off answer, which have nothing to normalise', async () => {
            let ran = 0;
            const normalize = (json: unknown) => { ran += 1; return json; };
            await rejection(callLlm(args, family(async () => ({ ...answering(''), stopReason: 'refusal' as const }), normalize)));
            await rejection(callLlm(args, family(async () => ({ ...answering('{"reply":"cu'), stopReason: 'max_tokens' as const }), normalize)));
            await rejection(callLlm(args, family(async () => answering('not json'), normalize)));
            assert.equal(ran, 0);
        });

        it('failing is bad_output, retryable once, with the tokens that were billed', async () => {
            const err = await rejection(callLlm(args, family(async () => answering('{"reply":"hi"}'), () => { throw new Error('a null in a required place'); })));
            assert.equal(err.kind, 'bad_output');
            assert.equal(err.retryable, true);
            assert.match(err.message, /a null in a required place/);
            assert.deepEqual(err.usage, { in: 1, out: 1 });
        });

        it('is optional: the Anthropic and Gemini families have none and the answer is returned as parsed', async () => {
            const out = await callLlm(args, family(async () => answering('{"reply":"hi","score":null}')));
            assert.deepEqual(out.json, { reply: 'hi', score: null });
        });
    });
});

describe('logging a failed call', () => {
    // The logger redacts a field by the words in its *name*. The first version of this library
    // named its token counts `input_tokens` and `output_tokens`, and every log line carried
    // "[redacted]" where the counts should have been; and an Error's own fields are dropped by
    // `describeError` except `code`.
    const lines: Array<Record<string, any>> = [];
    let restore: (() => void) | undefined;
    afterEach(() => restore?.());
    const capture = () => {
        lines.length = 0;
        const previous = setLogSink((_level, line) => void lines.push(JSON.parse(line)));
        restore = () => void setLogSink(previous);
    };

    it('keeps kind, status, retryable, model and the tokens that were billed, and not the key', async () => {
        capture();
        // A refusal that echoes the key in its explanation, after a call that was billed.
        const { fetchImpl } = stubFetch(jsonResponse(200, {
            id: 'msg_05', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: `Declined for ${anthropic.key}.` },
            usage: { input_tokens: 412, output_tokens: 7 },
        }));
        const err = await rejection(call(anthropic, fetchImpl, { maxTokens: 20_000 }));
        log('warn', 'llm.call_failed', aiErrorLogFields(err));

        assert.equal(lines.length, 1);
        const line = lines[0]!;
        assert.equal(line['event'], 'llm.call_failed');
        assert.equal(line['kind'], 'refusal');
        assert.equal(line['provider'], 'anthropic');
        assert.equal(line['model'], 'claude-opus-5-5');
        assert.equal(line['retryable'], false);
        assert.equal(line['in'], 412);
        assert.equal(line['out'], 7);
        // The error itself, through `describeError`: its code is its kind.
        assert.equal(line['err'].code, 'refusal');
        assert.match(line['err'].message, /declined/);
        assert.ok(!JSON.stringify(line).includes(anthropic.key), JSON.stringify(line));
        assert.ok(!JSON.stringify(line).includes(anthropic.key.slice(5, 30)));
        assert.ok(!JSON.stringify(line).includes('redacted'), 'no field was redacted by name');
    });

    it('keeps the status and the wait of an HTTP failure', async () => {
        capture();
        const err = await rejection(call(gemini, stubFetch(gemini.rateLimited()).fetchImpl, { maxTokens: 20_000 }));
        log('warn', 'llm.call_failed', aiErrorLogFields(err));
        const line = lines[0]!;
        assert.equal(line['kind'], 'rate');
        assert.equal(line['status'], 429);
        assert.equal(line['retryable'], true);
        assert.equal(line['retry_after_ms'], 33_000);
        assert.equal(line['err'].code, 'rate');
    });

    it('keeps the tokens of a call that succeeded, as {in, out}, where input_tokens would have been redacted', async () => {
        capture();
        const out = await call(anthropic, stubFetch(anthropic.text(JSON.stringify(ANSWER), { input: 150, output: 40 })).fetchImpl, { maxTokens: 20_000 });
        log('info', 'llm.call_ok', { usage: out.usage, billed: out.billed, model: out.model });
        assert.deepEqual(lines[0]!['usage'], { in: 150, out: 40 });
        assert.deepEqual(lines[0]!['billed'], [{ model: 'claude-opus-5-5', in: 150, out: 40 }]);
        // The reason for the rename, as the logger behaves today.
        log('info', 'llm.old_names', { usage: { input_tokens: 150, output_tokens: 40 } });
        assert.deepEqual(lines[1]!['usage'], { input_tokens: '[redacted]', output_tokens: '[redacted]' });
    });

    it('keeps the code of an error logged as a plain error field, with no helper', () => {
        capture();
        log('error', 'llm.call_failed', { err: new AiError({ kind: 'quota', provider: 'gemini', model: 'm', status: 429, message: 'spent' }) });
        assert.equal(lines[0]!['err'].code, 'quota');
    });
});

describe('parseModelJson', () => {
    it('reads plain JSON, fenced JSON and JSON inside prose', () => {
        assert.deepEqual(parseModelJson('{"a":1}'), { value: { a: 1 } });
        assert.deepEqual(parseModelJson('  \n{"a":1}\n '), { value: { a: 1 } });
        assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { value: { a: 1 } });
        assert.deepEqual(parseModelJson('Result:\n```\n[1,2]\n```'), { value: [1, 2] });
        assert.deepEqual(parseModelJson('Here: {"a":{"b":[1]}} done'), { value: { a: { b: [1] } } });
        assert.deepEqual(parseModelJson('"text"'), { value: 'text' });
        assert.deepEqual(parseModelJson('null'), { value: null });
    });

    it('gives up on text that holds no JSON', () => {
        for (const text of ['', '   ', 'no json here', '{"a": 1', '{a: 1}', 'one } two { three']) {
            assert.equal(parseModelJson(text), undefined, text);
        }
    });
});

describe('setLlmCaller', () => {
    let restore: (() => void) | undefined;
    afterEach(() => restore?.());

    const args: GenerateJsonArgs = {
        provider: 'anthropic', apiKey: 'sk-ant-test-0123456789', model: 'claude-opus-5-5', system: 's', user: 'u',
        schema: SCHEMA, maxTokens: 100, timeoutMs: 1000,
    };

    it('swaps what generateJson calls, hands back the previous caller, and can put it back', async () => {
        const seen: GenerateJsonArgs[] = [];
        const fake = async (a: GenerateJsonArgs): Promise<GenerateJsonResult> => {
            seen.push(a);
            return { json: { reply: 'stubbed' }, usage: { in: 1, out: 2 }, billed: [{ model: a.model, in: 1, out: 2 }], model: a.model, provider: a.provider, stopReason: 'end_turn', elapsed_ms: 0 };
        };
        const previous = setLlmCaller(fake);
        restore = () => void setLlmCaller(previous);
        assert.equal(previous, callLlm);

        assert.deepEqual((await generateJson(args)).json, { reply: 'stubbed' });
        assert.deepEqual(seen, [args]);

        assert.equal(setLlmCaller(previous), fake);
        // Back to the real call, which with no key refuses before anything is sent.
        await assert.rejects(generateJson({ ...args, apiKey: '' }), (err: unknown) => isAiError(err) && err.kind === 'no_provider');
    });

    it('lets a stub fail with an AiError the way the real call does', async () => {
        const previous = setLlmCaller(async (a) => {
            throw new AiError({ kind: 'budget', provider: a.provider, model: a.model, message: 'The daily budget is spent.' });
        });
        restore = () => void setLlmCaller(previous);
        await assert.rejects(generateJson(args), (err: unknown) => isAiError(err) && err.kind === 'budget' && !err.retryable);
    });
});
