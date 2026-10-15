/**
 * The Chat Completions adapter (OpenRouter, Groq and Custom): the request it builds, what OpenRouter
 * and Groq get that Custom does not (and what each is never sent of the other's), JSON-object mode,
 * and how it reads an answer, an error that came back in a 200, and OpenRouter's own cost. The whole
 * path (every status, timeouts, the key's whereabouts) is in generate.test.ts; model lists and key
 * checks are in providerQuery.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildChatRequest, chatCompletionsAdapter, chatCompletionsFamily, groqReasoningEffort, OPENROUTER_BASE_URL, openRouterReasoning, parseChatResponse,
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

// Built, not written whole: a `gsk_` and fifty-two characters is what a secret scanner blocks a push for.
const GROQ_KEY = 'gsk_' + 'Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq' + 'AbCdEfGh';
const groq = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'groq', apiKey: GROQ_KEY, model: 'openai/gpt-oss-120b', system: 'You write replies.', user: 'Say hi.',
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

describe('groqReasoningEffort', () => {
    it('is sent for gpt-oss, in the three levels Groq has: low, medium and high, with xhigh and max sent as high', () => {
        for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'OpenAI/GPT-OSS-120B']) {
            assert.deepEqual(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => groqReasoningEffort(model, e as AdapterArgs['effort'])), ['low', 'medium', 'high', 'high', 'high'], model);
        }
    });

    it('is sent for no other model: not Llama, not the gpt-oss classifier, not another provider\'s reasoning model, not a name that only looks like gpt-oss', () => {
        for (const model of [
            'llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-safeguard-20b', 'meta-llama/llama-prompt-guard-2-22m', 'whisper-large-v3',
            'gpt-oss-120b', 'openai/gpt-oss-120b-extra', 'openai/gpt-oss-1200b', 'openai/gpt-6.1-sol', 'openai/o3', 'qwen/qwen3-32b', 'openrouter/auto', '',
        ]) {
            assert.equal(groqReasoningEffort(model, 'high'), undefined, model);
        }
    });
});

describe('buildChatRequest for Groq', () => {
    it('is exactly this: its own /chat/completions, a nested strict json_schema, max_tokens, reasoning_effort and include_reasoning false', () => {
        const r = buildChatRequest(groq());
        assert.equal(r.url, 'https://api.groq.com/openai/v1/chat/completions');
        assert.deepEqual(r.headers, { authorization: `Bearer ${GROQ_KEY}` });
        assert.deepEqual(r.body, {
            model: 'openai/gpt-oss-120b',
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
            reasoning_effort: 'medium',
            include_reasoning: false,
        });
    });

    it('closes every object and requires every property, at any depth, which is what Groq\'s strict mode wants', () => {
        const r = buildChatRequest(groq({
            schema: { json: { type: 'object', properties: { a: { type: 'string' }, inner: { type: 'object', properties: { b: { type: 'integer' }, c: { type: 'string' } }, required: ['b'] }, list: { type: 'array', items: { type: 'object', properties: { d: { type: 'string' } } } } }, required: ['a'] } },
        }));
        const schema = (r.body.response_format as any).json_schema.schema;
        assert.equal((r.body.response_format as any).json_schema.strict, true);
        const nodes = [schema, schema.properties.inner, schema.properties.list.items];
        assert.deepEqual(schema.properties.list.type, ['array', 'null']);
        for (const node of nodes) {
            assert.equal(node.additionalProperties, false);
            assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
        }
        // An optional property is still there to be written, and may be null: that is how strict mode says "optional".
        assert.deepEqual(schema.properties.inner.properties.c.type, ['string', 'null']);
    });

    it('maps the effort for gpt-oss: low, medium and high as they are, xhigh and max as high', () => {
        const sent = (model: string, effort: AdapterArgs['effort']) => buildChatRequest(groq({ model, effort })).body.reasoning_effort;
        for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
            assert.deepEqual((['low', 'medium', 'high', 'xhigh', 'max'] as const).map((e) => sent(model, e)), ['low', 'medium', 'high', 'high', 'high'], model);
        }
    });

    it('leaves the reasoning text out of the response whenever it asks for reasoning, and only then', () => {
        for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
            const body = buildChatRequest(groq({ effort })).body;
            assert.equal(body.include_reasoning, false, effort);
            assert.ok(!('reasoning_format' in body), effort);
        }
    });

    it('sends a Llama model none of it: no reasoning_effort, no include_reasoning, and still a strict json_schema', () => {
        for (const model of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
            for (const effort of ['low', 'max'] as const) {
                const r = buildChatRequest(groq({ model, effort }));
                assert.deepEqual(Object.keys(r.body), ['model', 'messages', 'max_tokens', 'response_format'], `${model} ${effort}`);
                assert.equal((r.body.response_format as any).type, 'json_schema');
                assert.equal((r.body.response_format as any).json_schema.strict, true);
            }
        }
    });

    it('never sends OpenRouter\'s reasoning object or provider field, not even for a model whose name OpenRouter would send them for', () => {
        for (const model of ['openai/gpt-oss-120b', 'openai/gpt-6.1-sol', 'llama-3.3-70b-versatile']) {
            const body = buildChatRequest(groq({ model, effort: 'high' })).body;
            assert.ok(!('reasoning' in body), model);
            assert.ok(!('provider' in body), model);
        }
    });

    it('puts the key in the header and nowhere else, and sends no attribution headers', () => {
        const r = buildChatRequest(groq());
        assert.ok(!r.url.includes(GROQ_KEY));
        assert.ok(!JSON.stringify(r.body).includes(GROQ_KEY));
        assert.deepEqual(Object.keys(r.headers), ['authorization']);
    });

    it('is always a strict schema and always at its own address: JSON-object mode and a base URL are not offered', () => {
        const r = buildChatRequest(groq({ jsonMode: 'object', baseUrl: 'https://evil.example.com/v1' }));
        assert.equal((r.body.response_format as any).type, 'json_schema');
        assert.equal(r.url, 'https://api.groq.com/openai/v1/chat/completions');
    });

    it('refuses a schema strict mode cannot express, before any request', () => {
        const err = caught(() => buildChatRequest(groq({ schema: { json: { type: 'object', properties: { m: { type: 'object', additionalProperties: { type: 'string' } } } } } })));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.provider, 'groq');
        assert.match(err.message, /free-form keys/);
    });

    it('is what changes for Groq alone: OpenRouter and Custom are sent no reasoning_effort or include_reasoning, whatever the model is called', () => {
        for (const args of [router({ model: 'openai/gpt-oss-120b', effort: 'high' }), custom({ model: 'openai/gpt-oss-120b', effort: 'high' })]) {
            const body = buildChatRequest(args).body;
            assert.ok(!('reasoning_effort' in body), args.provider);
            assert.ok(!('include_reasoning' in body), args.provider);
        }
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

describe('parseChatResponse for Groq', () => {
    const groqCall = { provider: 'groq', model: 'openai/gpt-oss-120b', apiKey: GROQ_KEY } as const;
    // What Groq sends for a gpt-oss call: the reasoning rides along in `message.reasoning` unless `include_reasoning` is false, and there is no cost.
    const groqCompletion = (over: Record<string, unknown> = {}) => ({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1790000000, model: 'openai/gpt-oss-120b',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"hi"}', reasoning: 'The user wants a greeting, so say hi.' } }],
        usage: { queue_time: 0.01, prompt_tokens: 120, prompt_time: 0.002, completion_tokens: 80, completion_time: 0.1, total_tokens: 200, completion_tokens_details: { reasoning_tokens: 46 } },
        ...over,
    });

    it('reads the content and the tokens (reasoning is inside completion_tokens), never the reasoning text, and bills under the model it asked for', () => {
        const r = parseChatResponse(groqCompletion(), groqCall);
        assert.equal(r.text, '{"reply":"hi"}');
        assert.equal(r.stopReason, 'end_turn');
        assert.deepEqual(r.usage, { in: 120, out: 80 });
        assert.deepEqual(r.billed, [{ model: 'openai/gpt-oss-120b', in: 120, out: 80 }]);
        assert.equal(r.model, 'openai/gpt-oss-120b');
        assert.ok(!JSON.stringify(r).includes('greeting'));
    });

    it('has no price of its own: the figure is left to the table, and a cost that appears anyway is not taken for one', () => {
        assert.ok(!('usd' in parseChatResponse(groqCompletion(), groqCall).billed[0]!));
        const odd = parseChatResponse(groqCompletion({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: 5, is_byok: true, cost_details: { upstream_inference_cost: 9 } } }), groqCall);
        assert.ok(!('usd' in odd.billed[0]!) && !('source' in odd.billed[0]!));
    });

    it('is max_tokens, with the tokens it was billed, when the reasoning used the limit up and nothing was written', () => {
        const r = parseChatResponse(groqCompletion({ choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: '', reasoning: 'Let me think about' } }] }), groqCall);
        assert.equal(r.stopReason, 'max_tokens');
        assert.equal(r.text, '');
        assert.deepEqual(r.usage, { in: 120, out: 80 });
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

describe('chatCompletionsAdapter for Groq', () => {
    it('makes one POST to Groq with the bearer key and the request body, and returns the answer', async () => {
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, completion({ model: 'openai/gpt-oss-120b', usage: { prompt_tokens: 12, completion_tokens: 8 } })));
        const r = await chatCompletionsAdapter({ ...groq({ effort: 'max' }), fetchImpl });
        assert.equal(r.text, '{"reply":"hi"}');
        assert.deepEqual(r.billed, [{ model: 'openai/gpt-oss-120b', in: 12, out: 8 }]);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
        assert.equal(calls[0]!.method, 'POST');
        assert.equal(calls[0]!.redirect, 'error');
        assert.equal(calls[0]!.headers['authorization'], `Bearer ${GROQ_KEY}`);
        assert.equal(calls[0]!.body.reasoning_effort, 'high');
        assert.equal(calls[0]!.body.include_reasoning, false);
        assert.ok(!calls[0]!.raw.includes(GROQ_KEY));
    });

    it('reads Groq\'s 498 (flex tier out of capacity) as a server error to try again, keeping the wait it asks for, and a 429 as a rate limit', async () => {
        const overloaded = jsonResponse(498, { error: { message: 'Flex tier capacity exceeded. Please retry later.', type: 'capacity_exceeded' } }, { 'retry-after': '3' });
        const err = await chatCompletionsAdapter({ ...groq(), fetchImpl: stubFetch(overloaded).fetchImpl }).then(() => assert.fail('expected a failure'), (e) => e);
        assert.ok(isAiError(err));
        assert.equal(err.kind, 'server');
        assert.equal(err.status, 498);
        assert.equal(err.retryable, true);
        assert.equal(err.retryAfterMs, 3000);
        assert.equal(err.provider, 'groq');
        const limited = jsonResponse(429, { error: { message: 'Rate limit reached for model `openai/gpt-oss-120b`. Please try again in 7s.', type: 'tokens' } }, { 'retry-after': '7' });
        const rate = await chatCompletionsAdapter({ ...groq(), fetchImpl: stubFetch(limited).fetchImpl }).then(() => assert.fail('expected a failure'), (e) => e);
        assert.ok(isAiError(rate));
        assert.equal(rate.kind, 'rate');
        assert.equal(rate.retryAfterMs, 7000);
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
