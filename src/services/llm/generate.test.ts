/**
 * `generateJson` end to end against a stub `fetch`, once per provider with an adapter: a
 * structured answer, every way a call can fail and the kind it fails as, that nothing is ever
 * retried, and that the API key is in exactly one request header and in no error. No network.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { GeminiSchema } from '../studio/generate.js';
import { AiError, isAiError, type AiErrorKind } from './errors.js';
import { callProvider, generateJson, parseModelJson, setLlmCaller, type GenerateJsonArgs, type GenerateJsonResult } from './generate.js';
import type { ProviderId } from './registry.js';
import { hangingFetch, jsonResponse, stubFetch } from './testFetch.js';
import type { FetchLike } from './types.js';

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
    text(text: string, usage?: { input: number; output: number }): Response;
    refusal(): Response;
    cutOff(): Response;
    error(status: number, message: string): Response;
}

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
    400: 'invalid_request_error', 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error',
    404: 'not_found_error', 429: 'rate_limit_error', 500: 'api_error', 504: 'timeout_error', 529: 'overloaded_error',
};
const GEMINI_STATUSES: Record<number, string> = {
    400: 'INVALID_ARGUMENT', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE',
};

const anthropic: Fixture = {
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    key: 'sk-ant-api03-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq',
    keyHeader: 'x-api-key',
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
};

const gemini: Fixture = {
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    key: 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
    keyHeader: 'x-goog-api-key',
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

for (const fx of [anthropic, gemini]) {
    describe(`generateJson (${fx.provider})`, () => {
        describe('a structured answer', () => {
            it('returns the parsed JSON with usage, model, provider, stop reason and timing', async () => {
                const { fetchImpl, calls } = stubFetch(fx.text(JSON.stringify(ANSWER), { input: 150, output: 40 }));
                const out = await call(fx, fetchImpl);
                assert.deepEqual(out.json, ANSWER);
                assert.deepEqual(out.usage, { input_tokens: 150, output_tokens: 40 });
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

        describe('the key', () => {
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

        describe('why a call fails', () => {
            // [what the provider sent, what it is]. Each is one request: the library never retries.
            const statuses: Array<[number, string, AiErrorKind]> = [
                [401, 'bad credentials', 'auth'],
                [403, 'permission denied', 'auth'],
                [404, 'model not found', 'bad_request'],
                [429, 'Too many requests, slow down. Rate limit reached.', 'rate'],
                [429, 'You exceeded your current quota, please check your plan and billing details.', 'quota'],
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

            it('a refusal is refusal: final, from a 200, with the tokens it was billed', async () => {
                const { fetchImpl, calls } = stubFetch(fx.refusal());
                const err = await rejection(call(fx, fetchImpl));
                assert.equal(err.kind, 'refusal');
                assert.equal(err.retryable, false);
                assert.equal(err.usage?.input_tokens, 412);
                assert.match(err.message, /declined/);
                assert.equal(calls.length, 1);
            });

            it('an answer cut off by the token limit is max_tokens, not "bad output", although it does not parse', async () => {
                const { fetchImpl, calls } = stubFetch(fx.cutOff());
                const err = await rejection(call(fx, fetchImpl, { maxTokens: 1000 }));
                assert.equal(err.kind, 'max_tokens');
                assert.equal(err.retryable, false);
                assert.match(err.message, /1000/);
                assert.ok((err.usage?.output_tokens ?? 0) >= 600, 'the billed tokens travel with the error');
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

    it('reports the model that answered when the server-side fallback moved the request', async () => {
        const { fetchImpl } = stubFetch(jsonResponse(200, {
            id: 'msg_04', type: 'message', role: 'assistant', model: 'claude-opus-4-8', stop_reason: 'end_turn', stop_details: null,
            content: [
                { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
                { type: 'text', text: JSON.stringify(ANSWER) },
            ],
            usage: { input_tokens: 412, output_tokens: 264 },
        }));
        const out = await call(anthropic, fetchImpl);
        assert.equal(out.model, 'claude-opus-4-8');
        assert.deepEqual(out.json, ANSWER);
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
        assert.deepEqual((await call(gemini, fetchImpl)).usage, { input_tokens: 90, output_tokens: 320 });
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

    it('is bad_request for Custom without a base URL, which has none of its own', async () => {
        const { fetchImpl } = stubFetch();
        const err = await rejection(call(anthropic, fetchImpl, { provider: 'custom', apiKey: '', model: 'm' }));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /no base URL/);
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
            return { json: { reply: 'stubbed' }, usage: { input_tokens: 1, output_tokens: 2 }, model: a.model, provider: a.provider, stopReason: 'end_turn', elapsed_ms: 0 };
        };
        const previous = setLlmCaller(fake);
        restore = () => void setLlmCaller(previous);
        assert.equal(previous, callProvider);

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
