/**
 * The Gemini adapter: the request it builds, the effort-to-thinking mapping, and how it reads the
 * answer. Errors, timeouts and the key's whereabouts are in generate.test.ts, where the whole
 * path runs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GeminiSchema } from '../studio/generate.js';
import {
    buildGeminiRequest, geminiAdapter, parseGeminiResponse, thinkingConfigFor, THINKING_BUDGETS, THINKING_LEVELS,
} from './adapters/gemini.js';
import { EFFORTS, type AdapterArgs } from './types.js';
import { jsonResponse, stubFetch } from './testFetch.js';

const KEY = 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY';
const SCHEMA: GeminiSchema = {
    type: 'OBJECT',
    properties: { reply: { type: 'STRING' }, tags: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1, maxItems: 3 } },
    required: ['reply'],
};

const args = (over: Partial<AdapterArgs> = {}): AdapterArgs => ({
    provider: 'gemini', apiKey: KEY, model: 'gemini-3.8-flash', system: 'You write replies.', user: 'Say hi.',
    schema: SCHEMA, maxTokens: 4000, effort: 'medium', ...over,
});

/** A generateContent answer. */
const answer = (over: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: 'model', parts: [{ text: '{"reply":"hi"}' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20, thoughtsTokenCount: 55, totalTokenCount: 165 },
    modelVersion: 'gemini-3.8-flash',
    ...over,
});

describe('buildGeminiRequest', () => {
    it('posts to the model\'s generateContent with the key in x-goog-api-key', () => {
        const r = buildGeminiRequest(args());
        assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
        assert.equal(r.headers['x-goog-api-key'], KEY);
    });

    it('never puts the key in the URL or the body', () => {
        const r = buildGeminiRequest(args());
        assert.ok(!r.url.includes(KEY));
        assert.ok(!r.url.includes('?'));
        assert.ok(!JSON.stringify(r.body).includes(KEY));
        assert.deepEqual(Object.entries(r.headers).filter(([, v]) => v.includes(KEY)).map(([k]) => k), ['x-goog-api-key']);
    });

    it('mirrors callGemini: systemInstruction, contents, JSON mime type and responseSchema without the array bounds', () => {
        const { body } = buildGeminiRequest(args({ model: 'gemini-2.0-flash' }));
        assert.deepEqual(body, {
            systemInstruction: { parts: [{ text: 'You write replies.' }] },
            contents: [{ role: 'user', parts: [{ text: 'Say hi.' }] }],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: 'OBJECT',
                    properties: { reply: { type: 'STRING' }, tags: { type: 'ARRAY', items: { type: 'STRING' } } },
                    required: ['reply'],
                },
                maxOutputTokens: 4000,
            },
        });
    });

    it('sends a {json} schema as responseJsonSchema and never both fields', () => {
        const raw = { type: 'object', properties: { x: { type: ['string', 'null'] } }, additionalProperties: false };
        const config = buildGeminiRequest(args({ schema: { json: raw } })).body.generationConfig as Record<string, unknown>;
        assert.deepEqual(config.responseJsonSchema, raw);
        assert.equal(config.responseMimeType, 'application/json');
        assert.ok(!('responseSchema' in config));
        assert.ok(!('responseJsonSchema' in (buildGeminiRequest(args()).body.generationConfig as object)));
    });

    it('sends no sampling parameters: Google recommends the default temperature for Gemini 3', () => {
        const config = buildGeminiRequest(args()).body.generationConfig as Record<string, unknown>;
        for (const field of ['temperature', 'topP', 'topK']) assert.ok(!(field in config), field);
    });

    it('maps a conversation onto user and model turns', () => {
        const { body } = buildGeminiRequest(args({
            user: [{ role: 'user', text: 'prompt' }, { role: 'model', text: 'answer' }, { role: 'user', text: 'fix it' }],
        }));
        assert.deepEqual(body.contents, [
            { role: 'user', parts: [{ text: 'prompt' }] },
            { role: 'model', parts: [{ text: 'answer' }] },
            { role: 'user', parts: [{ text: 'fix it' }] },
        ]);
    });

    it('leaves out an empty system prompt, and accepts a model named with its models/ prefix', () => {
        assert.ok(!('systemInstruction' in buildGeminiRequest(args({ system: '' })).body));
        assert.equal(
            buildGeminiRequest(args({ model: 'models/gemini-3.8-flash' })).url,
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        );
    });

    it('takes a base URL override', () => {
        assert.equal(buildGeminiRequest(args({ baseUrl: 'https://proxy.example.com/v1beta/' })).url, 'https://proxy.example.com/v1beta/models/gemini-3.8-flash:generateContent');
    });
});

describe('thinkingConfigFor', () => {
    it('gives Gemini 3 a thinkingLevel and never a thinkingBudget, which is a 400 beside it', () => {
        for (const model of ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'models/gemini-3.5-flash']) {
            for (const effort of EFFORTS) {
                const config = thinkingConfigFor(model, effort, 4000)!;
                assert.deepEqual(Object.keys(config), ['thinkingLevel'], `${model} ${effort}`);
            }
        }
    });

    it('maps effort onto the levels every Gemini 3 model has: never minimal, nothing above high', () => {
        assert.deepEqual(THINKING_LEVELS, { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' });
        assert.deepEqual(thinkingConfigFor('gemini-3.8-flash', 'low', 4000), { thinkingLevel: 'low' });
        assert.deepEqual(thinkingConfigFor('gemini-3.8-flash', 'max', 4000), { thinkingLevel: 'high' });
    });

    it('gives Gemini 2.5 a thinkingBudget from the table, and never a level, which it rejects', () => {
        assert.deepEqual(THINKING_BUDGETS, { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 });
        for (const model of ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite']) {
            assert.deepEqual(thinkingConfigFor(model, 'high', 100_000), { thinkingBudget: 8192 }, model);
        }
    });

    it('keeps a 2.5 budget to half the answer\'s token limit, and above the 512 Flash-Lite needs', () => {
        assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'max', 6000), { thinkingBudget: 3000 });
        assert.deepEqual(thinkingConfigFor('gemini-2.5-flash', 'low', 600), { thinkingBudget: 512 });
        // Every budget the table can produce is inside every 2.5 model's range.
        for (const effort of EFFORTS) {
            const budget = (thinkingConfigFor('gemini-2.5-pro', effort, 1_000_000) as { thinkingBudget: number }).thinkingBudget;
            assert.ok(budget >= 512 && budget <= 24576, `${effort}: ${budget}`);
        }
    });

    it('sends nothing for models that do not think, or that this code cannot place', () => {
        for (const model of ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-flash-latest', 'gemma-3-27b', 'something-else']) {
            assert.equal(thinkingConfigFor(model, 'high', 4000), undefined, model);
        }
    });

    it('lands in the request\'s generationConfig', () => {
        assert.deepEqual((buildGeminiRequest(args()).body.generationConfig as any).thinkingConfig, { thinkingLevel: 'medium' });
        assert.deepEqual((buildGeminiRequest(args({ model: 'gemini-2.5-flash', effort: 'low' })).body.generationConfig as any).thinkingConfig, { thinkingBudget: 1024 });
        assert.ok(!('thinkingConfig' in (buildGeminiRequest(args({ model: 'gemini-2.0-flash' })).body.generationConfig as object)));
    });
});

describe('parseGeminiResponse', () => {
    it('returns the text, counts thinking as output, and ends normally', () => {
        assert.deepEqual(parseGeminiResponse(answer(), 'gemini-3.8-flash'), {
            text: '{"reply":"hi"}',
            usage: { input_tokens: 90, output_tokens: 75 },
            model: 'gemini-3.8-flash',
            stopReason: 'end_turn',
        });
    });

    it('skips thought parts and joins the rest', () => {
        const parsed = parseGeminiResponse(answer({
            candidates: [{ content: { parts: [{ text: 'musing...', thought: true }, { text: '{"reply":' }, { text: '"hi"}' }] }, finishReason: 'STOP' }],
        }), 'm');
        assert.equal(parsed.text, '{"reply":"hi"}');
    });

    it('reports the model asked for, not a modelVersion with a build suffix', () => {
        assert.equal(parseGeminiResponse(answer({ modelVersion: 'gemini-3.8-flash-001' }), 'gemini-3.8-flash').model, 'gemini-3.8-flash');
    });

    it('reads a blocked prompt as a refusal: no candidates, a blockReason', () => {
        const parsed = parseGeminiResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 30 } }, 'm');
        assert.equal(parsed.stopReason, 'refusal');
        assert.equal(parsed.detail, 'blocked: PROHIBITED_CONTENT');
        assert.equal(parsed.text, '');
        assert.deepEqual(parsed.usage, { input_tokens: 30, output_tokens: 0 });
    });

    it('does not take an unspecified blockReason for a block', () => {
        assert.equal(parseGeminiResponse(answer({ promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' } }), 'm').stopReason, 'end_turn');
    });

    it('reads a stopped answer as a refusal: SAFETY and its kin', () => {
        for (const finishReason of ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'LANGUAGE', 'IMAGE_SAFETY']) {
            const parsed = parseGeminiResponse(answer({ candidates: [{ finishReason }] }), 'm');
            assert.equal(parsed.stopReason, 'refusal', finishReason);
            assert.equal(parsed.detail, `finishReason: ${finishReason}`);
        }
    });

    it('reads MAX_TOKENS as a cut-off answer', () => {
        const parsed = parseGeminiResponse(answer({ candidates: [{ content: { parts: [{ text: '{"reply":"h' }] }, finishReason: 'MAX_TOKENS' }] }), 'm');
        assert.equal(parsed.stopReason, 'max_tokens');
        assert.equal(parsed.detail, 'finishReason: MAX_TOKENS');
    });

    it('keeps an odd finishReason as detail without calling it a refusal', () => {
        const parsed = parseGeminiResponse(answer({ candidates: [{ finishReason: 'MALFORMED_RESPONSE' }] }), 'm');
        assert.equal(parsed.stopReason, 'end_turn');
        assert.equal(parsed.detail, 'finishReason: MALFORMED_RESPONSE');
        assert.equal(parsed.text, '');
    });

    it('copes with a body that is missing pieces', () => {
        assert.deepEqual(parseGeminiResponse({}, 'm'), { text: '', usage: { input_tokens: 0, output_tokens: 0 }, model: 'm', stopReason: 'end_turn' });
        assert.equal(parseGeminiResponse(null, 'm').text, '');
    });
});

describe('geminiAdapter', () => {
    it('makes one POST and returns what the answer says', async () => {
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, answer()));
        const out = await geminiAdapter(args({ fetchImpl }));
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'POST');
        assert.equal(out.text, '{"reply":"hi"}');
        assert.deepEqual(out.usage, { input_tokens: 90, output_tokens: 75 });
    });
});
