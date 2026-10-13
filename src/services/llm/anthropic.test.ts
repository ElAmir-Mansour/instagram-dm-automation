/**
 * The Anthropic adapter: the request it builds (against the shapes platform.claude.com documents)
 * and how it reads the answer. Errors, timeouts and the key's whereabouts are in generate.test.ts,
 * where the whole path runs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GeminiSchema } from '../studio/generate.js';
import {
    anthropicAdapter, buildAnthropicRequest, effortFor, FALLBACK_BETA, parseAnthropicResponse, supportsEffort, supportsServerFallback,
} from './adapters/anthropic.js';
import { jsonResponse, stubFetch } from './testFetch.js';
import type { AdapterArgs } from './types.js';

const KEY = 'sk-ant-api03-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq';
const SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' }, tags: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: 3 } },
    required: ['reply'],
};

const args = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'anthropic', apiKey: KEY, model: 'claude-opus-5-5', system: 'You write replies.', user: 'Say hi.',
    schema: SCHEMA, maxTokens: 2000, effort: 'medium', ...over,
});

/** A Messages API answer. */
const message = (over: Record<string, unknown> = {}) => ({
    id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content: [{ type: 'text', text: '{"reply":"hi"}' }],
    stop_reason: 'end_turn', stop_details: null,
    usage: { input_tokens: 120, output_tokens: 34, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ...over,
});

describe('buildAnthropicRequest', () => {
    it('posts to /v1/messages with the key in x-api-key and the pinned API version', () => {
        const r = buildAnthropicRequest(args());
        assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
        assert.equal(r.headers['x-api-key'], KEY);
        assert.equal(r.headers['anthropic-version'], '2023-06-01');
    });

    it('asks for JSON in output_config.format with the schema as JSON Schema, and sets effort explicitly', () => {
        const { body } = buildAnthropicRequest(args({ effort: 'high' }));
        assert.deepEqual(body.output_config, {
            format: {
                type: 'json_schema',
                schema: {
                    type: 'object',
                    properties: { reply: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
                    required: ['reply'],
                    additionalProperties: false,
                },
            },
            effort: 'high',
        });
        assert.equal(body.model, 'claude-opus-5-5');
        assert.equal(body.max_tokens, 2000);
        assert.equal(body.system, 'You write replies.');
        assert.deepEqual(body.messages, [{ role: 'user', content: 'Say hi.' }]);
    });

    it('sends no sampling parameters, no thinking block and no deprecated top-level output_format', () => {
        const { body } = buildAnthropicRequest(args());
        for (const field of ['temperature', 'top_p', 'top_k', 'thinking', 'output_format', 'stream', 'tools', 'tool_choice']) {
            assert.ok(!(field in body), field);
        }
    });

    it('needs no beta header for structured output or effort', () => {
        assert.ok(!('anthropic-beta' in buildAnthropicRequest(args({ model: 'claude-sonnet-4-5' })).headers));
    });

    it('never puts the key in the URL or the body', () => {
        const r = buildAnthropicRequest(args());
        assert.ok(!r.url.includes(KEY));
        assert.ok(!JSON.stringify(r.body).includes(KEY));
        assert.deepEqual(Object.entries(r.headers).filter(([, v]) => v.includes(KEY)).map(([k]) => k), ['x-api-key']);
    });

    it('opts in to Anthropic\'s server-side fallback on the models the docs say have it', () => {
        for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-opus-5-5-20261001']) {
            const r = buildAnthropicRequest(args({ model }));
            assert.equal(r.body.fallbacks, 'default', model);
            assert.equal(r.headers['anthropic-beta'], FALLBACK_BETA, model);
        }
        assert.equal(FALLBACK_BETA, 'server-side-fallback-2026-07-01');
    });

    it('does not send fallbacks to a model without it: Haiku 5.5, plain Sonnet 5, or anything older', () => {
        for (const model of ['claude-haiku-5-5', 'claude-sonnet-5', 'claude-sonnet-4-5', 'claude-opus-4-6', 'claude-haiku-4-5-20251001']) {
            const r = buildAnthropicRequest(args({ model }));
            assert.ok(!('fallbacks' in r.body), model);
            assert.ok(!('anthropic-beta' in r.headers), model);
        }
    });

    it('leaves effort out for models that answer 400 to it, and clamps xhigh where only high exists', () => {
        assert.ok(!('effort' in (buildAnthropicRequest(args({ model: 'claude-haiku-4-5-20251001' })).body.output_config as object)));
        assert.equal((buildAnthropicRequest(args({ model: 'claude-opus-4-6', effort: 'xhigh' })).body.output_config as any).effort, 'high');
        assert.equal((buildAnthropicRequest(args({ model: 'claude-opus-5-5', effort: 'xhigh' })).body.output_config as any).effort, 'xhigh');
        assert.equal((buildAnthropicRequest(args({ model: 'claude-opus-4-6', effort: 'max' })).body.output_config as any).effort, 'max');
    });

    it('maps a conversation onto user and assistant turns, ending on the user\'s', () => {
        const { body } = buildAnthropicRequest(args({
            user: [
                { role: 'user', text: 'first prompt' },
                { role: 'model', text: 'the answer it got' },
                { role: 'user', text: 'what to fix' },
            ],
        }));
        assert.deepEqual(body.messages, [
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'the answer it got' },
            { role: 'user', content: 'what to fix' },
        ]);
    });

    it('leaves out an empty system prompt', () => {
        assert.ok(!('system' in buildAnthropicRequest(args({ system: '  ' })).body));
    });

    it('sends a {json} schema untouched', () => {
        const raw = { type: 'object', properties: { x: { type: ['string', 'null'] } }, required: ['x'], additionalProperties: false };
        assert.deepEqual((buildAnthropicRequest(args({ schema: { json: raw } })).body.output_config as any).format.schema, raw);
    });

    it('takes a base URL override, with or without a trailing slash', () => {
        assert.equal(buildAnthropicRequest(args({ baseUrl: 'https://proxy.example.com/' })).url, 'https://proxy.example.com/v1/messages');
    });
});

describe('model capability checks', () => {
    it('knows which Claude models take effort', () => {
        const table: Record<string, boolean> = {
            'claude-opus-5-5': true, 'claude-sonnet-5-5': true, 'claude-haiku-5-5': true, 'claude-fable-5-1': true, 'claude-sonnet-5': true,
            'claude-opus-4-8': true, 'claude-opus-4-5-20251101': true, 'claude-sonnet-4-6': true,
            'claude-sonnet-4-5': false, 'claude-haiku-4-5-20251001': false, 'claude-opus-4-1-20250805': false, 'claude-sonnet-4-20250514': false,
            'claude-3-5-sonnet-20241022': false, 'claude-3-opus-20240229': false,
            // A family this code has not met is assumed current.
            'claude-nova-6': true,
        };
        for (const [model, expected] of Object.entries(table)) assert.equal(supportsEffort(model), expected, model);
    });

    it('keeps xhigh only where it exists', () => {
        assert.equal(effortFor('claude-opus-5-5', 'xhigh'), 'xhigh');
        assert.equal(effortFor('claude-opus-4-7', 'xhigh'), 'xhigh');
        assert.equal(effortFor('claude-sonnet-4-6', 'xhigh'), 'high');
        assert.equal(effortFor('claude-opus-4-5-20251101', 'xhigh'), 'high');
        assert.equal(effortFor('claude-haiku-4-5', 'xhigh'), undefined);
    });

    it('knows which Claude models have server-side fallback', () => {
        const table: Record<string, boolean> = {
            'claude-opus-5-5': true, 'claude-opus-5': true, 'claude-sonnet-5-5': true, 'claude-fable-5': true, 'claude-fable-5-1': true,
            'claude-haiku-5-5': false, 'claude-sonnet-5': false, 'claude-opus-4-8': false, 'claude-opus-55': false,
        };
        for (const [model, expected] of Object.entries(table)) assert.equal(supportsServerFallback(model), expected, model);
    });
});

describe('parseAnthropicResponse', () => {
    it('returns the text of the answer, its usage, the model and a normal stop', () => {
        assert.deepEqual(parseAnthropicResponse(message(), 'claude-opus-5-5'), {
            text: '{"reply":"hi"}',
            usage: { input_tokens: 120, output_tokens: 34 },
            model: 'claude-opus-5-5',
            stopReason: 'end_turn',
        });
    });

    it('joins the text blocks and ignores thinking and fallback blocks', () => {
        const parsed = parseAnthropicResponse(message({
            content: [
                { type: 'thinking', thinking: 'let me think', signature: 'sig' },
                { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
                { type: 'text', text: '{"reply":' },
                { type: 'text', text: '"hi"}' },
            ],
        }), 'claude-opus-5-5');
        assert.equal(parsed.text, '{"reply":"hi"}');
    });

    it('reports the model that answered, which after a server-side fallback is not the one asked for', () => {
        const parsed = parseAnthropicResponse(message({ model: 'claude-opus-4-8' }), 'claude-opus-5-5');
        assert.equal(parsed.model, 'claude-opus-4-8');
    });

    it('falls back to the model asked for when the answer does not name one', () => {
        assert.equal(parseAnthropicResponse(message({ model: undefined }), 'claude-opus-5-5').model, 'claude-opus-5-5');
    });

    it('reads a refusal, with its category and the tokens it was billed for', () => {
        const parsed = parseAnthropicResponse(message({
            content: [], stop_reason: 'refusal',
            stop_details: { type: 'refusal', category: 'cyber', explanation: 'This request was declined because it could enable cyber harm.' },
            usage: { input_tokens: 412, output_tokens: 0 },
        }), 'claude-opus-5-5');
        assert.equal(parsed.stopReason, 'refusal');
        assert.equal(parsed.text, '');
        assert.equal(parsed.detail, 'cyber: This request was declined because it could enable cyber harm.');
        assert.deepEqual(parsed.usage, { input_tokens: 412, output_tokens: 0 });
    });

    it('reads a refusal with no category as a refusal all the same', () => {
        const parsed = parseAnthropicResponse(message({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }), 'm');
        assert.equal(parsed.stopReason, 'refusal');
        assert.equal(parsed.detail, undefined);
    });

    it('reads a cut-off answer as max_tokens, and a full context window the same way', () => {
        assert.equal(parseAnthropicResponse(message({ stop_reason: 'max_tokens' }), 'm').stopReason, 'max_tokens');
        assert.equal(parseAnthropicResponse(message({ stop_reason: 'model_context_window_exceeded' }), 'm').stopReason, 'max_tokens');
    });

    it('treats every other stop reason as the end of the answer', () => {
        for (const reason of ['end_turn', 'stop_sequence', undefined]) {
            assert.equal(parseAnthropicResponse(message({ stop_reason: reason }), 'm').stopReason, 'end_turn');
        }
    });

    it('copes with a body that is missing pieces', () => {
        assert.deepEqual(parseAnthropicResponse({}, 'm'), { text: '', usage: { input_tokens: 0, output_tokens: 0 }, model: 'm', stopReason: 'end_turn' });
        assert.deepEqual(parseAnthropicResponse(null, 'm').usage, { input_tokens: 0, output_tokens: 0 });
        assert.deepEqual(parseAnthropicResponse(message({ usage: { input_tokens: 'many', output_tokens: -3 } }), 'm').usage, { input_tokens: 0, output_tokens: 0 });
    });
});

describe('anthropicAdapter', () => {
    it('makes one POST and returns what the answer says', async () => {
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, message()));
        const out = await anthropicAdapter(args({ fetchImpl }));
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'POST');
        assert.equal(calls[0]!.headers['content-type'], 'application/json');
        assert.equal(out.text, '{"reply":"hi"}');
        assert.deepEqual(out.usage, { input_tokens: 120, output_tokens: 34 });
    });
});
