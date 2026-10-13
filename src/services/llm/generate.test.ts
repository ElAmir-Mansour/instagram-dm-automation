/**
 * `generateJson` end to end against a stub `fetch`, once per provider with an adapter: a
 * structured answer, every way a call can fail and the kind it fails as, that nothing is ever
 * retried, and that the API key is in exactly one request header and in no error. No network.
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
import type { AdapterResult, FamilyAdapter, FetchLike } from './types.js';

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
    /** The origin every request must go to, whatever base URL the caller offers. */
    origin: string;
    text(text: string, usage?: { input: number; output: number }): Response;
    refusal(): Response;
    cutOff(): Response;
    error(status: number, message: string): Response;
    /** A 429 for a limit that lifts by itself. `retryAfter` is the header, where the provider has one. */
    rateLimited(retryAfter?: string): Response;
    /** How long a caller is told to wait after `rateLimited()` with the header `retryAfterHeader`, or without one. */
    waitMs: { withHeader: number; withoutHeader: number | undefined };
    /** A 429 for a limit that does not: a daily quota, the monthly spend cap. */
    quotaSpent(): Response;
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

const call = (fx: Fixture, fetchImpl: FetchLike, over: Partial<GenerateJsonArgs> = {}) =>
    generateJson({
        provider: fx.provider, apiKey: fx.key, model: fx.model, system: 'You answer in JSON.', user: 'Say hello.',
        schema: SCHEMA, maxTokens: 1000, timeoutMs: 5000, fetchImpl, ...over,
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

for (const fx of [anthropic, gemini]) {
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

            it('accepts an array when the schema says the answer is one', async () => {
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
                assert.equal(request.headers[fx.keyHeader], fx.key);
                assert.deepEqual(Object.entries(request.headers).filter(([, v]) => v.includes(fx.key)).map(([k]) => k), [fx.keyHeader]);
                assert.ok(!request.url.includes(fx.key));
                assert.ok(!request.url.includes('key='));
                assert.ok(!request.raw.includes(fx.key));
            });

            it('is trimmed before it is sent, so a pasted newline cannot break a header', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER)));
                await call(fx, fetchImpl, { apiKey: `  ${fx.key}\n` });
                assert.equal(calls[0]!.headers[fx.keyHeader], fx.key);
            });

            it('goes to the provider\'s own address, whatever base URL the caller offers', async () => {
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

            it('a 429 for a limit that does not lift by itself is quota: final, with no wait', async () => {
                const { fetchImpl, calls } = stubFetch(fx.quotaSpent(), fx.text(JSON.stringify(ANSWER)));
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'quota');
                assert.equal(err.status, 429);
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
        const perDay = await rejection(call(gemini, stubFetch(gemini.quotaSpent()).fetchImpl));
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
        const err = await rejection(call(anthropic, fetchImpl, { provider: 'groq' as ProviderId }));
        assert.equal(err.kind, 'bad_request');
        assert.equal(calls.length, 0);
    });

    it('says clearly that OpenAI, OpenRouter and Custom are not implemented yet, as bad_request, until P20b', async () => {
        for (const provider of ['openai', 'openrouter', 'custom'] as const) {
            const { fetchImpl, calls } = stubFetch();
            const err = await rejection(call(anthropic, fetchImpl, { provider, apiKey: 'sk-test-0123456789', model: 'some-model', baseUrl: 'https://llm.example.com/v1' }));
            assert.equal(err.kind, 'bad_request', provider);
            assert.equal(err.retryable, false);
            assert.equal(err.provider, provider);
            assert.match(err.message, /not implemented/);
            assert.equal(calls.length, 0);
        }
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
            for (const fx of [anthropic, gemini]) {
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
            assert.match((await rejection(call(anthropic, fetchImpl, { provider: 'groq' as ProviderId, maxTokens: 0 }))).message, /maxTokens/);
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
        const err = await rejection(call(anthropic, fetchImpl));
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
        const err = await rejection(call(gemini, stubFetch(gemini.rateLimited()).fetchImpl));
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
        const out = await call(anthropic, stubFetch(anthropic.text(JSON.stringify(ANSWER), { input: 150, output: 40 })).fetchImpl);
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
