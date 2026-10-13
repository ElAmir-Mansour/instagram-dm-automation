/**
 * The OpenAI Responses adapter: the request it builds (against the shapes developers.openai.com
 * documents), which models get a `reasoning` block and at what level, the strict schema it sends,
 * and how it reads an answer. Errors, timeouts and the key's whereabouts for the whole path are in
 * generate.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildOpenAiRequest, OPENAI_BASE_URL, openaiAdapter, openaiFamily, parseOpenAiResponse, reasoningEffortFor, supportsReasoning,
} from './adapters/openai.js';
import { isAiError } from './errors.js';
import type { GeminiSchema } from './geminiSchema.js';
import { jsonResponse, stubFetch } from './testFetch.js';
import { EFFORTS, type AdapterArgs } from './types.js';

const KEY = 'sk-proj-Tq8vLm2xWz4RnYb7KdP1aHc6JfSe9UoNgIiXtVrBwEs3';
const SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: {
        reply: { type: 'STRING' },
        score: { type: 'INTEGER' },
        tags: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 3 },
        meta: { type: 'OBJECT', properties: { lang: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['lang'] },
    },
    required: ['reply'],
};

const args = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'openai', apiKey: KEY, model: 'gpt-6-astra', system: 'You write replies.', user: 'Say hi.',
    schema: SCHEMA, maxTokens: 4000, effort: 'medium', ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
    id: 'resp_01', object: 'response', status: 'completed', model: 'gpt-6-astra-2026-09-01', error: null, incomplete_details: null,
    output: [
        { type: 'reasoning', id: 'rs_01', summary: [] },
        { type: 'message', id: 'msg_01', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"reply":"hi"}', annotations: [] }] },
    ],
    usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 0 }, output_tokens: 80, output_tokens_details: { reasoning_tokens: 46 }, total_tokens: 200 },
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

describe('buildOpenAiRequest', () => {
    it('posts to /v1/responses with the key in Authorization and nowhere else', () => {
        const r = buildOpenAiRequest(args());
        assert.equal(r.url, 'https://api.openai.com/v1/responses');
        assert.equal(OPENAI_BASE_URL, 'https://api.openai.com/v1');
        assert.deepEqual(r.headers, { authorization: `Bearer ${KEY}` });
        assert.ok(!r.url.includes(KEY));
        assert.ok(!JSON.stringify(r.body).includes(KEY));
    });

    it('is exactly this body: instructions, input, a flattened strict json_schema, store false, max_output_tokens, and reasoning', () => {
        const { body } = buildOpenAiRequest(args({ effort: 'high' }));
        assert.deepEqual(body, {
            model: 'gpt-6-astra',
            instructions: 'You write replies.',
            input: [{ role: 'user', content: 'Say hi.' }],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'answer',
                    strict: true,
                    schema: {
                        type: 'object',
                        properties: {
                            reply: { type: 'string' },
                            score: { type: ['integer', 'null'] },
                            tags: { type: ['array', 'null'], items: { type: 'string' } },
                            meta: {
                                type: ['object', 'null'],
                                properties: { lang: { type: 'string' }, note: { type: ['string', 'null'] } },
                                required: ['lang', 'note'],
                                additionalProperties: false,
                            },
                        },
                        required: ['reply', 'score', 'tags', 'meta'],
                        additionalProperties: false,
                    },
                },
            },
            store: false,
            max_output_tokens: 4000,
            reasoning: { effort: 'high' },
        });
    });

    it('sends no sampling parameters, no Chat Completions fields, no stream, and does not ask for a reasoning summary', () => {
        const { body } = buildOpenAiRequest(args());
        for (const field of ['temperature', 'top_p', 'response_format', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 'tools', 'previous_response_id', 'include']) {
            assert.ok(!(field in body), field);
        }
        assert.deepEqual(body.reasoning, { effort: 'medium' });
    });

    it('does not touch the schema it was given', () => {
        const before = JSON.stringify(SCHEMA);
        buildOpenAiRequest(args());
        assert.equal(JSON.stringify(SCHEMA), before);
    });

    it('strictifies a {json} schema the same way, nested objects, unions and $defs included', () => {
        const raw = {
            type: 'object',
            properties: {
                a: { type: 'string' },
                b: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
                c: { $ref: '#/$defs/item' },
            },
            required: ['a'],
            $defs: { item: { type: 'object', properties: { x: { type: 'number' } } } },
        };
        const schema = (buildOpenAiRequest(args({ schema: { json: raw } })).body.text as any).format.schema;
        assert.deepEqual(schema.required, ['a', 'b', 'c']);
        assert.deepEqual(schema.properties.b, { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] });
        assert.deepEqual(schema.properties.c, { anyOf: [{ $ref: '#/$defs/item' }, { type: 'null' }] });
        // `x` was optional inside the definition, so it is required and nullable there too.
        assert.deepEqual(schema.$defs.item, { type: 'object', properties: { x: { type: ['number', 'null'] } }, required: ['x'], additionalProperties: false });
        assert.equal(schema.additionalProperties, false);
    });

    it('maps a conversation onto input messages, a repair round included, and leaves out an empty system prompt', () => {
        const { body } = buildOpenAiRequest(args({
            system: '  ',
            user: [{ role: 'user', text: 'first prompt' }, { role: 'model', text: 'the answer it got' }, { role: 'user', text: 'what to fix' }],
        }));
        assert.ok(!('instructions' in body));
        assert.deepEqual(body.input, [
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'the answer it got' },
            { role: 'user', content: 'what to fix' },
        ]);
    });

    it('ignores a base URL: the key goes to OpenAI and nowhere else', () => {
        for (const baseUrl of ['https://proxy.example.com/v1', 'http://localhost:9999', '']) {
            assert.equal(buildOpenAiRequest(args({ baseUrl })).url, 'https://api.openai.com/v1/responses', baseUrl);
        }
    });
});

describe('the schemas strict mode cannot take, refused before anything is sent', () => {
    it('an array at the top level: OpenAI wants an object there, and says to wrap it', () => {
        const err = caught(() => buildOpenAiRequest(args({ schema: { type: 'ARRAY', items: { type: 'STRING' } } })));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.retryable, false);
        assert.equal(err.provider, 'openai');
        assert.match(err.message, /JSON object at the top level/);
        assert.match(err.message, /Wrap it/);
    });

    it('a nullable object at the top level: ["object", "null"] is a union, whatever rootKind makes of the null', () => {
        const err = caught(() => buildOpenAiRequest(args({ schema: { json: { type: ['object', 'null'], properties: { a: { type: 'string' } }, required: ['a'] } } })));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /nullable object/);
    });

    it('a union at the top level, which the guide forbids too', () => {
        const err = caught(() => buildOpenAiRequest(args({ schema: { json: { anyOf: [{ type: 'object', properties: {} }, { type: 'null' }] } } })));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /top level/);
    });

    it('an object that is free-form some other way: additionalProperties true, or no properties at all', () => {
        for (const free of [
            { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
            { type: 'object', properties: { blob: { type: 'object' } }, required: ['blob'] },
            { type: 'object' },
        ]) {
            const err = caught(() => buildOpenAiRequest(args({ schema: { json: free } })));
            assert.equal(err.kind, 'bad_request', JSON.stringify(free));
            assert.match(err.message, /free-form keys/);
        }
    });

    it('an object with free-form keys, which strict mode cannot express, naming where', () => {
        const err = caught(() => buildOpenAiRequest(args({ schema: { json: { type: 'object', properties: { by_id: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['by_id'] } } })));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /free-form keys/);
        assert.match(err.message, /by_id/);
    });
});

describe('which models get a reasoning block', () => {
    it('gpt-6* and gpt-5.6* take all five levels as they are: the models pages list low through max', () => {
        for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra-2026-09-01', 'gpt-5.6', 'gpt-5.6-mini', 'gpt-5.6-cyber']) {
            for (const effort of EFFORTS) assert.equal(reasoningEffortFor(model, effort), effort, `${model} ${effort}`);
        }
    });

    it('gpt-5.5* goes up to xhigh: max is sent as xhigh, and nothing below it changes', () => {
        for (const model of ['gpt-5.5', 'gpt-5.5-mini', 'GPT-5.5']) {
            for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) assert.equal(reasoningEffortFor(model, effort), effort, `${model} ${effort}`);
            assert.equal(reasoningEffortFor(model, 'max'), 'xhigh', model);
        }
    });

    it('other gpt-5.x and the o-series go up to high: the one level every reasoning model is known to have', () => {
        for (const model of ['gpt-5', 'gpt-5-mini', 'gpt-5.1', 'gpt-5.4', 'o1', 'o3', 'o3-mini', 'o4-mini', 'O3']) {
            assert.equal(reasoningEffortFor(model, 'low'), 'low', model);
            assert.equal(reasoningEffortFor(model, 'medium'), 'medium', model);
            assert.equal(reasoningEffortFor(model, 'high'), 'high', model);
            assert.equal(reasoningEffortFor(model, 'xhigh'), 'high', model);
            assert.equal(reasoningEffortFor(model, 'max'), 'high', model);
        }
    });

    it('a model this table has not met, a newer major or a variant of one it has, is played safe: up to high', () => {
        // A gpt-6 `-pro` id is not on OpenAI's models page (there, pro is a reasoning mode), gpt-7 does not exist yet,
        // and gpt-5.7 is a minor nobody has checked. A level that does not exist is a 400 and the call is never retried.
        for (const model of ['gpt-7-nova', 'gpt-7', 'gpt-50', 'gpt-6.1-sol-pro', 'gpt-6-astra-pro', 'gpt-5.7', 'gpt-5.60-x']) {
            assert.equal(supportsReasoning(model), true, model);
            assert.equal(reasoningEffortFor(model, 'medium'), 'medium', model);
            assert.equal(reasoningEffortFor(model, 'high'), 'high', model);
            assert.equal(reasoningEffortFor(model, 'xhigh'), 'high', model);
            assert.equal(reasoningEffortFor(model, 'max'), 'high', model);
        }
    });

    it('is in the request as the table says', () => {
        const effortOf = (model: string, effort: AdapterArgs['effort']) => (buildOpenAiRequest(args({ model, effort })).body.reasoning as { effort: string }).effort;
        assert.equal(effortOf('gpt-6-astra', 'max'), 'max');
        assert.equal(effortOf('gpt-5.5', 'max'), 'xhigh');
        assert.equal(effortOf('gpt-5.4', 'xhigh'), 'high');
        assert.equal(effortOf('gpt-7-nova', 'xhigh'), 'high');
    });

    it('a model that does not reason, or is not one of ours to know, gets none: that cannot be a 400', () => {
        const none = [
            'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'chatgpt-4o-latest',
            'gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'o1-mini', 'o1-preview', 'gpt-5-pro', 'gpt-5-pro-2025-10-06',
            'ft:gpt-4.1-2025-04-14:acme::abc123', 'text-embedding-3-large', 'whisper-1', 'omni-moderation-latest', 'my-model', '',
        ];
        for (const model of none) {
            assert.equal(supportsReasoning(model), false, model);
            assert.equal(reasoningEffortFor(model, 'high'), undefined, model);
            assert.ok(!('reasoning' in buildOpenAiRequest(args({ model })).body), model);
        }
    });

    it('does not mistake a longer number or a longer name for a version: gpt-4.15 is not GPT-5 and o3x is not o3', () => {
        assert.equal(supportsReasoning('gpt-4.15'), false);
        assert.equal(supportsReasoning('o3x'), false);
        // `gpt-50` is a major of its own, which the table has not met, not GPT-5.
        assert.equal(reasoningEffortFor('gpt-50', 'max'), 'high');
    });
});

describe('parseOpenAiResponse', () => {
    const call = { provider: 'openai', model: 'gpt-6-astra', apiKey: KEY } as const;

    it('reads the text of the message item, not the reasoning item beside it, and bills the tokens', () => {
        const r = parseOpenAiResponse(answer(), call);
        assert.equal(r.text, '{"reply":"hi"}');
        assert.equal(r.stopReason, 'end_turn');
        assert.deepEqual(r.usage, { in: 120, out: 80 });
        // Billed under the model that was asked for: `model` in the response is a dated snapshot no price table has.
        assert.deepEqual(r.billed, [{ model: 'gpt-6-astra', in: 120, out: 80 }]);
        assert.equal(r.model, 'gpt-6-astra');
        assert.ok(!('detail' in r));
    });

    it('joins several output_text parts and several message items in order', () => {
        const r = parseOpenAiResponse(answer({
            output: [
                { type: 'message', content: [{ type: 'output_text', text: '{"reply":' }, { type: 'output_text', text: '"hi' }] },
                { type: 'function_call', name: 'x', arguments: '{}' },
                { type: 'message', content: [{ type: 'output_text', text: '"}' }] },
            ],
        }), call);
        assert.equal(r.text, '{"reply":"hi"}');
    });

    it('is a refusal when a message holds a refusal part, with its words as the detail, even though status says completed', () => {
        const r = parseOpenAiResponse(answer({
            output: [{ type: 'message', content: [{ type: 'refusal', refusal: "I'm sorry, I can't help with that." }] }],
            usage: { input_tokens: 412, output_tokens: 9 },
        }), call);
        assert.equal(r.stopReason, 'refusal');
        assert.equal(r.detail, "I'm sorry, I can't help with that.");
        assert.equal(r.text, '');
        assert.deepEqual(r.usage, { in: 412, out: 9 });
    });

    it('is max_tokens when incomplete for max_output_tokens, with whatever text there was', () => {
        const r = parseOpenAiResponse(answer({
            status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{"reply":"cu' }] }],
            usage: { input_tokens: 100, output_tokens: 4000 },
        }), call);
        assert.equal(r.stopReason, 'max_tokens');
        assert.equal(r.text, '{"reply":"cu');
        assert.equal(r.usage.out, 4000);
    });

    it('is max_tokens when the reasoning alone used the whole limit, so there is no message item at all', () => {
        const r = parseOpenAiResponse(answer({
            status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
            output: [{ type: 'reasoning', id: 'rs_01', summary: [] }], usage: { input_tokens: 100, output_tokens: 4000 },
        }), call);
        assert.equal(r.stopReason, 'max_tokens');
        assert.equal(r.text, '');
    });

    it('is a refusal when incomplete for content_filter', () => {
        const r = parseOpenAiResponse(answer({ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }), call);
        assert.equal(r.stopReason, 'refusal');
        assert.equal(r.detail, 'content_filter');
    });

    it('leaves a reason this library\'s requests cannot cause as an ordinary stop, saying which, so a parseable answer still counts', () => {
        for (const reason of ['max_messages', 'steered', 'something_new']) {
            const r = parseOpenAiResponse(answer({ status: 'incomplete', incomplete_details: { reason } }), call);
            assert.equal(r.stopReason, 'end_turn', reason);
            assert.equal(r.detail, `incomplete: ${reason}`);
        }
    });

    it('is an error for a response that failed, was cancelled or never finished, billed for what it used', () => {
        for (const [status, kind] of [['failed', 'server'], ['cancelled', 'server'], ['queued', 'server'], ['in_progress', 'server']] as const) {
            const err = caught(() => parseOpenAiResponse(answer({ status, error: status === 'failed' ? { code: 'server_error', message: 'The model crashed.' } : null, usage: { input_tokens: 7, output_tokens: 1 } }), call));
            assert.equal(err.kind, kind, status);
            assert.deepEqual(err.usage, { in: 7, out: 1 });
            assert.equal(err.retryable, true);
        }
        const failed = caught(() => parseOpenAiResponse(answer({ status: 'failed', error: { code: 'invalid_prompt', message: 'Your prompt was flagged.' } }), call));
        assert.equal(failed.kind, 'bad_request');
        assert.equal(failed.message, 'Your prompt was flagged.');
    });

    it('scrubs the key from a failure\'s message, as every error is', () => {
        const err = caught(() => parseOpenAiResponse(answer({ status: 'failed', error: { code: 'server_error', message: `Bad credential ${KEY}` } }), call));
        assert.ok(!err.message.includes(KEY));
        assert.ok(!JSON.stringify(err).includes(KEY));
    });

    it('is empty and ordinary for an answer with nothing in it, and zero for tokens that are missing or nonsense', () => {
        const r = parseOpenAiResponse({ status: 'completed', output: [], usage: { input_tokens: -5, output_tokens: 'many' } }, call);
        assert.equal(r.text, '');
        assert.equal(r.stopReason, 'end_turn');
        assert.deepEqual(r.usage, { in: 0, out: 0 });
        assert.deepEqual(parseOpenAiResponse({}, call).usage, { in: 0, out: 0 });
        assert.equal(parseOpenAiResponse(null, call).text, '');
    });
});

describe('the family\'s normalize', () => {
    it('takes out the nulls strict mode asked the model to write for optional fields, at every depth, and keeps the required ones', () => {
        const normalize = openaiFamily.normalize!;
        const raw = { reply: 'hi', score: null, tags: null, meta: { lang: 'ar', note: null } };
        assert.deepEqual(normalize(raw, SCHEMA), { reply: 'hi', meta: { lang: 'ar' } });
        // Values that are there stay.
        assert.deepEqual(normalize({ reply: 'hi', score: 0, tags: ['a'], meta: { lang: 'ar', note: 'x' } }, SCHEMA), { reply: 'hi', score: 0, tags: ['a'], meta: { lang: 'ar', note: 'x' } });
    });

    it('works from a {json} schema too', () => {
        const schema = { json: { type: 'object', properties: { a: { type: 'string' }, b: { type: ['string', 'null'] }, c: { type: ['string', 'null'] } }, required: ['a', 'c'] } };
        assert.deepEqual(openaiFamily.normalize!({ a: 'x', b: null, c: null }, schema), { a: 'x', c: null });
    });
});

describe('openaiAdapter', () => {
    it('makes one POST and returns the parsed answer', async () => {
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, answer()));
        const r = await openaiAdapter({ ...args(), fetchImpl });
        assert.equal(r.text, '{"reply":"hi"}');
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'POST');
        assert.equal(calls[0]!.headers['authorization'], `Bearer ${KEY}`);
        assert.equal(calls[0]!.redirect, 'error');
    });
});
