/**
 * The Chat Completions adapter (OpenRouter and Custom): the request it builds, what OpenRouter
 * gets that Custom does not, JSON-object mode, and how it reads an answer, an error that came
 * back in a 200, and OpenRouter's own cost. The whole path (every status, timeouts, the key's
 * whereabouts) is in generate.test.ts; model lists and key checks are in providerQuery.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildChatRequest, chatCompletionsAdapter, chatCompletionsFamily, OPENROUTER_BASE_URL, openRouterReasoning, parseChatResponse,
} from './adapters/chatCompletions.js';
import { costOf, DEFAULT_PRICES } from './cost.js';
import { isAiError } from './errors.js';
import type { GeminiSchema } from './geminiSchema.js';
import { jsonResponse, stubFetch } from './testFetch.js';
import type { AdapterArgs } from './types.js';

const KEY = 'sk-or-v1-' + '3f9a'.repeat(16);
const SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' }, score: { type: 'INTEGER' } },
    required: ['reply'],
};

const router = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'openrouter', apiKey: KEY, model: 'openrouter/auto', system: 'You write replies.', user: 'Say hi.',
    schema: SCHEMA, maxTokens: 4000, effort: 'medium', ...over,
});
const custom = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'custom', apiKey: 'llm-key-123456', baseUrl: 'https://llm.example.com/v1', model: 'llama-4-maverick', system: 'You write replies.', user: 'Say hi.',
    schema: SCHEMA, maxTokens: 4000, effort: 'medium', ...over,
});

const completion = (over: Record<string, unknown> = {}) => ({
    id: 'gen-1', object: 'chat.completion', created: 1790000000, model: 'anthropic/claude-sonnet-5.5',
    choices: [{ index: 0, finish_reason: 'stop', native_finish_reason: 'end_turn', message: { role: 'assistant', content: '{"reply":"hi"}' } }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200, completion_tokens_details: { reasoning_tokens: 46 }, cost: 0.00123 },
    ...over,
});

const caught = (fn: () => unknown) => {
    try {
        fn();
    } catch (err) {
        assert.ok(isAiError(err), String(err));
        return err;
    }
    return assert.fail('expected a throw');
};

describe('buildChatRequest for OpenRouter', () => {
    it('is exactly this: its own /chat/completions, a nested strict json_schema, require_parameters, max_tokens', () => {
        const r = buildChatRequest(router());
        assert.equal(r.url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1');
        assert.deepEqual(r.headers, { authorization: `Bearer ${KEY}` });
        assert.deepEqual(r.body, {
            model: 'openrouter/auto',
            messages: [{ role: 'system', content: 'You write replies.' }, { role: 'user', content: 'Say hi.' }],
            max_tokens: 4000,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'answer',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: { reply: { type: 'string' }, score: { type: ['integer', 'null'] } },
                        required: ['reply', 'score'],
                        additionalProperties: false,
                    },
                },
            },
            provider: { require_parameters: true },
        });
    });

    it('never puts the key in the URL or the body, and sends no attribution headers', () => {
        const r = buildChatRequest(router());
        assert.ok(!r.url.includes(KEY));
        assert.ok(!JSON.stringify(r.body).includes(KEY));
        assert.deepEqual(Object.keys(r.headers), ['authorization']);
    });

    it('does not offer OpenRouter JSON-object mode, whatever it is told, and ignores a base URL', () => {
        const r = buildChatRequest(router({ jsonMode: 'object', baseUrl: 'https://evil.example.com/v1' }));
        assert.equal((r.body.response_format as any).type, 'json_schema');
        assert.equal(r.url, 'https://openrouter.ai/api/v1/chat/completions');
    });

    it('accepts an array at the top level: the endpoint behind it may not be OpenAI, so it answers for itself', () => {
        const r = buildChatRequest(router({ schema: { type: 'ARRAY', items: { type: 'OBJECT', properties: { a: { type: 'INTEGER' } }, required: ['a'] } } }));
        assert.equal((r.body.response_format as any).json_schema.schema.type, 'array');
    });

    it('refuses a schema strict mode cannot express, before any request', () => {
        const err = caught(() => buildChatRequest(router({ schema: { json: { type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } } } } })));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /free-form keys/);
    });

    it('maps a conversation, leaving out an empty system prompt', () => {
        const r = buildChatRequest(router({ system: '', user: [{ role: 'user', text: 'one' }, { role: 'model', text: 'two' }, { role: 'user', text: 'three' }] }));
        assert.deepEqual(r.body.messages, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }]);
    });
});

describe('openRouterReasoning', () => {
    it('is sent for an OpenAI reasoning model, as OpenAI takes it, and for no model whose parameters we cannot know', () => {
        assert.deepEqual(openRouterReasoning('openai/gpt-6.1-sol', 'max'), { effort: 'max' });
        assert.deepEqual(openRouterReasoning('openai/gpt-6-astra:batch', 'xhigh'), { effort: 'xhigh' });
        assert.deepEqual(openRouterReasoning('openai/gpt-5.5', 'max'), { effort: 'xhigh' });
        assert.deepEqual(openRouterReasoning('openai/gpt-5.4', 'max'), { effort: 'high' });
        assert.deepEqual(openRouterReasoning('openai/gpt-6.1-sol-pro', 'max'), { effort: 'high' });
        assert.deepEqual(openRouterReasoning('openai/o3', 'low'), { effort: 'low' });
        for (const model of ['openai/gpt-4.1', 'openai/gpt-5-chat', 'openai/o1-mini', 'anthropic/claude-opus-5.5', 'google/gemini-3.8-flash', 'x-ai/grok-4', 'openrouter/auto', 'gpt-6-astra', '']) {
            assert.equal(openRouterReasoning(model, 'high'), undefined, model);
        }
    });

    it('is in the request only for OpenRouter, never for Custom, even for a model with an OpenAI name', () => {
        assert.deepEqual(buildChatRequest(router({ model: 'openai/gpt-6.1-sol', effort: 'high' })).body.reasoning, { effort: 'high' });
        assert.ok(!('reasoning' in buildChatRequest(custom({ model: 'openai/gpt-6.1-sol', effort: 'high' })).body));
    });
});

describe('buildChatRequest for Custom', () => {
    it('posts to the operator\'s base URL, with a bearer key, and sends nothing that is OpenRouter\'s', () => {
        const r = buildChatRequest(custom());
        assert.equal(r.url, 'https://llm.example.com/v1/chat/completions');
        assert.deepEqual(r.headers, { authorization: 'Bearer llm-key-123456' });
        assert.equal((r.body.response_format as any).type, 'json_schema');
        assert.equal((r.body.response_format as any).json_schema.strict, true);
        for (const field of ['provider', 'reasoning', 'usage', 'max_completion_tokens', 'temperature', 'stream']) assert.ok(!(field in r.body), field);
        assert.equal(r.body.max_tokens, 4000);
    });

    it('sends no header at all for an endpoint that has no key', () => {
        assert.deepEqual(buildChatRequest(custom({ apiKey: '' })).headers, {});
    });

    it('checks the base URL itself, whoever called it: https, public, no credentials, and one at all', () => {
        for (const baseUrl of [undefined, '', 'http://llm.example.com/v1', 'https://10.0.0.5/v1', 'https://localhost:8080', 'https://user:pass@llm.example.com', 'https://llm.example.com/v1?key=x']) {
            const err = caught(() => buildChatRequest(custom({ baseUrl })));
            assert.equal(err.kind, 'bad_request', String(baseUrl));
            assert.ok(!JSON.stringify(err).includes('pass@'), String(baseUrl));
        }
        // And tidies one that is fine.
        assert.equal(buildChatRequest(custom({ baseUrl: '  https://llm.example.com/v1/  ' })).url, 'https://llm.example.com/v1/chat/completions');
    });

    describe('in JSON-object mode', () => {
        const object = (over: Partial<AdapterArgs> = {}) => buildChatRequest(custom({ jsonMode: 'object', ...over }));

        it('asks for json_object, and the schema as the caller wrote it goes in the system prompt after the caller\'s own', () => {
            const r = object();
            assert.deepEqual(r.body.response_format, { type: 'json_object' });
            const system = (r.body.messages as any[])[0].content as string;
            assert.ok(system.startsWith('You write replies.\n\nAnswer with a single JSON object and nothing else'));
            assert.ok(system.endsWith(JSON.stringify({ type: 'object', properties: { reply: { type: 'string' }, score: { type: 'integer' } }, required: ['reply'], additionalProperties: false })));
        });

        it('says JSON in the conversation even with no system prompt of its own, which JSON mode demands', () => {
            const system = (object({ system: '' }).body.messages as any[])[0];
            assert.equal(system.role, 'system');
            assert.match(system.content, /^Answer with a single JSON object/);
        });

        it('refuses an array at the top level, which JSON mode cannot produce', () => {
            const err = caught(() => object({ schema: { type: 'ARRAY', items: { type: 'STRING' } } }));
            assert.equal(err.kind, 'bad_request');
            assert.match(err.message, /JSON-object mode/);
        });

        it('does not insist on a schema strict mode can express: it never goes through strictify', () => {
            const r = object({ schema: { json: { type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } } } } });
            assert.deepEqual(r.body.response_format, { type: 'json_object' });
        });

        it('is the default only when asked for: "schema" and no setting both send a json_schema', () => {
            assert.equal((buildChatRequest(custom({ jsonMode: 'schema' })).body.response_format as any).type, 'json_schema');
            assert.equal((buildChatRequest(custom()).body.response_format as any).type, 'json_schema');
        });
    });
});

describe('parseChatResponse', () => {
    const open = { provider: 'openrouter', model: 'openrouter/auto', apiKey: KEY } as const;
    const own = { provider: 'custom', model: 'llama-4-maverick', apiKey: 'llm-key-123456' } as const;

    it('reads the message content, the tokens, and OpenRouter\'s charge as usd', () => {
        const r = parseChatResponse(completion(), open);
        assert.equal(r.text, '{"reply":"hi"}');
        assert.equal(r.stopReason, 'end_turn');
        assert.deepEqual(r.usage, { in: 120, out: 80 });
        assert.deepEqual(r.billed, [{ model: 'openrouter/auto', in: 120, out: 80, usd: 0.00123, source: 'provider' }]);
        // The router's pick is what answered; the bill stays under the id that was asked for.
        assert.equal(r.model, 'anthropic/claude-sonnet-5.5');
        assert.equal(costOf(r.billed, DEFAULT_PRICES).usd, 0.00123);
    });

    it('takes a charge of zero (a free model), and ignores one that is not a number or is negative', () => {
        assert.deepEqual(parseChatResponse(completion({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }), open).billed[0], { model: 'openrouter/auto', in: 1, out: 1, usd: 0, source: 'provider' });
        for (const usage of [
            { prompt_tokens: 1, completion_tokens: 1, cost: '0.5' },
            { prompt_tokens: 1, completion_tokens: 1, cost: -2 },
            { prompt_tokens: 1, completion_tokens: 1, cost: null },
            { prompt_tokens: 1, completion_tokens: 1 },
        ]) {
            const billed = parseChatResponse(completion({ usage }), open).billed[0]!;
            assert.ok(!('usd' in billed) && !('source' in billed), JSON.stringify(usage));
        }
    });

    describe('a call billed to the caller\'s own provider key (BYOK)', () => {
        const byok = (usage: Record<string, unknown>) => parseChatResponse(completion({ usage: { prompt_tokens: 100, completion_tokens: 50, is_byok: true, ...usage } }), open).billed[0]!;

        it('cost is OpenRouter\'s fee alone: the upstream cost is added to it', () => {
            assert.deepEqual(byok({ cost: 0.0001, cost_details: { upstream_inference_cost: 0.0042 } }), { model: 'openrouter/auto', in: 100, out: 50, usd: 0.0043, source: 'provider' });
        });

        it('is the upstream cost alone when there is no fee', () => {
            assert.equal(byok({ cost: 0, cost_details: { upstream_inference_cost: 0.002 } }).usd, 0.002);
            assert.equal(byok({ cost_details: { upstream_inference_cost: 0.002 } }).usd, 0.002);
        });

        it('is left to the price table when the upstream cost is missing, zero or not a number: the fee alone would under-count', () => {
            for (const usage of [{ cost: 0.0001 }, { cost: 0.0001, cost_details: {} }, { cost: 0.0001, cost_details: { upstream_inference_cost: 0 } }, { cost: 0.0001, cost_details: { upstream_inference_cost: null } }, { cost: 0.0001, cost_details: { upstream_inference_cost: '0.1' } }, { cost: 0.0001, cost_details: { upstream_inference_cost: -1 } }]) {
                const billed = byok(usage);
                assert.ok(!('usd' in billed) && !('source' in billed), JSON.stringify(usage));
            }
        });

        it('is added up without floating-point noise', () => {
            assert.equal(byok({ cost: 0.1, cost_details: { upstream_inference_cost: 0.2 } }).usd, 0.3);
        });

        it('only counts for OpenRouter: a Custom endpoint\'s upstream figure is not a price', () => {
            const r = parseChatResponse(completion({ usage: { prompt_tokens: 1, completion_tokens: 1, is_byok: true, cost: 1, cost_details: { upstream_inference_cost: 2 } } }), own);
            assert.ok(!('usd' in r.billed[0]!));
        });
    });

    it('never takes a cost from a Custom endpoint, and reports the model that was asked for', () => {
        const r = parseChatResponse(completion({ model: 'something-else' }), own);
        assert.ok(!('usd' in r.billed[0]!));
        assert.equal(r.model, 'llama-4-maverick');
    });

    it('is max_tokens at finish_reason length, content_filter a refusal, and message.refusal a refusal with its words', () => {
        const stop = (finish: string, message: Record<string, unknown> = { content: '' }) => parseChatResponse(completion({ choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }] }), open);
        assert.equal(stop('length', { content: '{"reply":"cu' }).stopReason, 'max_tokens');
        assert.equal(stop('length', { content: '{"reply":"cu' }).text, '{"reply":"cu');
        const filtered = stop('content_filter');
        assert.equal(filtered.stopReason, 'refusal');
        assert.equal(filtered.detail, 'content_filter');
        const refused = stop('stop', { content: null, refusal: " I can't help with that. " });
        assert.equal(refused.stopReason, 'refusal');
        assert.equal(refused.detail, "I can't help with that.");
        assert.equal(refused.text, '');
        // Anything else, a tool call included, is an ordinary stop.
        for (const finish of ['stop', 'tool_calls', 'function_call', undefined as unknown as string]) assert.equal(stop(finish, { content: 'x' }).stopReason, 'end_turn');
    });

    it('reads content that is an array of text parts, and nothing from other kinds of part', () => {
        const r = parseChatResponse(completion({ choices: [{ finish_reason: 'stop', message: { content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: 'x' }, { type: 'text', text: 'b' }] } }] }), own);
        assert.equal(r.text, 'ab');
    });

    it('is empty for no choices, null content or no body at all, with zero tokens where none are given', () => {
        assert.equal(parseChatResponse(completion({ choices: [] }), open).text, '');
        assert.equal(parseChatResponse(completion({ choices: [{ finish_reason: 'stop', message: { content: null } }] }), open).text, '');
        assert.deepEqual(parseChatResponse({}, open).usage, { in: 0, out: 0 });
        assert.equal(parseChatResponse(null, open).text, '');
    });

    describe('a failure inside a 200', () => {
        it('reads a top-level error by the HTTP status its code names, retryable or not, with the tokens it was billed', () => {
            const rows: Array<[unknown, string, boolean]> = [
                [{ code: 502, message: 'Provider returned error' }, 'server', true],
                [{ code: 503, message: 'No available model provider meets your routing requirements' }, 'server', true],
                [{ code: 402, message: 'Insufficient credits' }, 'quota', false],
                [{ code: 401, message: 'Invalid credentials' }, 'auth', false],
                [{ code: 403, message: 'Insufficient permissions for this key' }, 'auth', false],
                [{ code: 403, message: 'Your input was flagged', metadata: { reasons: ['harassment'], flagged_input: 'a flagged sentence', provider_name: 'OpenAI', model_slug: 'openai/gpt-6-astra' } }, 'refusal', false],
                [{ code: 403, message: 'Blocked by a guardrail', metadata: {} }, 'refusal', false],
                [{ code: 403, message: 'Request blocked', metadata: { guardrail_id: 'gr_1' } }, 'refusal', false],
                [{ code: 403, message: 'Key limit exceeded', metadata: { limit_source: 'openrouter_key_limit' } }, 'quota', false],
                [{ code: 403, message: 'Daily budget reached', metadata: { limit_source: 'openrouter_in_flight_budget', reasons: ['x'] } }, 'quota', false],
                [{ code: 400, message: 'Invalid parameters' }, 'bad_request', false],
                [{ code: 408, message: 'The request timed out' }, 'timeout', true],
                [{ code: 429, message: 'Rate limit exceeded' }, 'rate', true],
                [{ code: '502', message: 'The code is a string' }, 'server', true],
                [{ message: 'No code at all' }, 'server', true],
                [{}, 'server', true],
            ];
            for (const [error, kind, retryable] of rows) {
                const err = caught(() => parseChatResponse({ error, usage: { prompt_tokens: 30, completion_tokens: 0 } }, open));
                assert.equal(err.kind, kind, JSON.stringify(error));
                assert.equal(err.retryable, retryable);
                assert.deepEqual(err.usage, { in: 30, out: 0 });
            }
        });

        it('has no usage on the error when nothing was billed, and carries the status when there is one', () => {
            const err = caught(() => parseChatResponse({ error: { code: 502, message: 'Provider returned error' } }, open));
            assert.equal(err.usage, undefined);
            assert.equal(err.status, 502);
        });

        it('reads an error in a choice, or finish_reason error, as a failure and not as an empty answer', () => {
            const inChoice = caught(() => parseChatResponse(completion({ choices: [{ finish_reason: 'error', error: { code: 502, message: 'Upstream closed the stream.' }, message: { content: '' } }] }), open));
            assert.equal(inChoice.kind, 'server');
            assert.equal(inChoice.message, 'Upstream closed the stream.');
            const bare = caught(() => parseChatResponse(completion({ choices: [{ finish_reason: 'error', message: { content: '' } }] }), open));
            assert.equal(bare.kind, 'server');
            assert.match(bare.message, /error in its answer/);
        });

        it('scrubs the key from what the provider says', () => {
            const err = caught(() => parseChatResponse({ error: { code: 401, message: `No auth for ${KEY}` } }, open));
            assert.ok(!JSON.stringify(err).includes(KEY));
        });
    });
});

describe('the family\'s normalize', () => {
    it('drops the nulls strict mode wrote for optional fields, and keeps a required one', () => {
        const normalize = chatCompletionsFamily.normalize!;
        assert.deepEqual(normalize({ reply: 'hi', score: null }, SCHEMA), { reply: 'hi' });
        assert.deepEqual(normalize({ reply: 'hi', score: 3 }, SCHEMA), { reply: 'hi', score: 3 });
        assert.deepEqual(normalize({ json: 1 }, { json: { type: 'object', properties: { json: { type: ['integer', 'null'] } }, required: ['json'] } }), { json: 1 });
    });
});

describe('chatCompletionsAdapter', () => {
    it('makes one POST to the right address and returns the parsed answer', async () => {
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, completion()));
        const r = await chatCompletionsAdapter({ ...router(), fetchImpl });
        assert.equal(r.text, '{"reply":"hi"}');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(calls[0]!.redirect, 'error');
        assert.equal(calls[0]!.headers['authorization'], `Bearer ${KEY}`);
    });
});
