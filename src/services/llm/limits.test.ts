/**
 * `minOutputTokens`: the smallest limit worth asking each kind of model for. OpenAI's figure is
 * from its reasoning guide; the Anthropic and Gemini ones are heuristics, so what these tests pin
 * is their shape (none for a model that does not think, never less for more effort), not a claim
 * that the numbers are documented.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPENAI_REASONING_MIN_OUTPUT } from './adapters/openai.js';
import { minOutputTokens } from './limits.js';
import { PROVIDER_IDS } from './registry.js';
import { EFFORTS } from './types.js';

describe('minOutputTokens', () => {
    it('is 25 000 for an OpenAI reasoning model, whatever the effort: the figure in OpenAI\'s reasoning guide', () => {
        assert.equal(OPENAI_REASONING_MIN_OUTPUT, 25_000);
        for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-5-mini', 'o3', 'o4-mini', 'gpt-7-nova']) {
            for (const effort of EFFORTS) assert.equal(minOutputTokens('openai', model, effort), 25_000, `${model} ${effort}`);
        }
    });

    it('is nothing for an OpenAI model that does not reason, or one this code does not know', () => {
        for (const model of ['gpt-4.1', 'gpt-4o', 'gpt-5-chat-latest', 'o1-mini', 'ft:gpt-4.1:acme::x', 'text-embedding-3-large', '']) {
            assert.equal(minOutputTokens('openai', model, 'high'), 0, model);
        }
    });

    it('is 25 000 for an OpenAI reasoning model behind OpenRouter, the only one it sends reasoning to, and nothing for the rest', () => {
        assert.equal(minOutputTokens('openrouter', 'openai/gpt-6.1-sol', 'medium'), 25_000);
        assert.equal(minOutputTokens('openrouter', 'openai/gpt-6.1-sol:batch', 'max'), 25_000);
        for (const model of ['openai/gpt-4o', 'anthropic/claude-opus-5.5', 'google/gemini-3.8-flash', 'openrouter/auto', 'x-ai/grok-4']) {
            assert.equal(minOutputTokens('openrouter', model, 'high'), 0, model);
        }
    });

    it('is nothing on Groq, gpt-oss included: Groq counts max_tokens against the free tier\'s 8 000 tokens a minute, so a floor would make every request too large', () => {
        for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile', 'unknown-model', '']) {
            for (const effort of EFFORTS) assert.equal(minOutputTokens('groq', model, effort), 0, `${model} ${effort}`);
        }
    });

    it('gives a gpt-oss model no floor behind OpenRouter, OpenAI or a Custom endpoint: it is Groq that sends it reasoning', () => {
        for (const provider of ['openrouter', 'custom', 'openai']) assert.equal(minOutputTokens(provider, 'openai/gpt-oss-120b', 'high'), 0, provider);
    });

    it('is a heuristic that grows with effort for a Claude model that takes effort, and nothing for one that does not', () => {
        assert.deepEqual(EFFORTS.map((e) => minOutputTokens('anthropic', 'claude-opus-5-5', e)), [4000, 8000, 16000, 24000, 32000]);
        assert.deepEqual(EFFORTS.map((e) => minOutputTokens('anthropic', 'claude-haiku-5-5', e)), [4000, 8000, 16000, 24000, 32000]);
        for (const model of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-3-5-sonnet-20241022', 'claude-opus-4-1']) {
            assert.equal(minOutputTokens('anthropic', model, 'high'), 0, model);
        }
    });

    it('is twice the thinking budget the adapter asks a Gemini thinking model for, and at least 4 096; nothing for one that does not think', () => {
        for (const model of ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-flash', 'models/gemini-2.5-pro']) {
            assert.deepEqual(EFFORTS.map((e) => minOutputTokens('gemini', model, e)), [4096, 8192, 16384, 32768, 49152], model);
        }
        for (const model of ['gemini-2.0-flash', 'gemini-1.5-pro', 'palm-2', '']) {
            assert.equal(minOutputTokens('gemini', model, 'high'), 0, model);
        }
    });

    it('is nothing for a Custom endpoint, whose models nobody here knows, or for a provider that does not exist', () => {
        for (const effort of EFFORTS) assert.equal(minOutputTokens('custom', 'o3', effort), 0);
        assert.equal(minOutputTokens('mistral', 'openai/gpt-oss-120b', 'high'), 0);
        assert.equal(minOutputTokens('', '', 'high'), 0);
    });

    it('never asks for less when more effort is asked for, for any provider and any model', () => {
        const models = ['gpt-6-astra', 'gpt-4.1', 'o3', 'openai/gpt-6.1-sol', 'claude-opus-5-5', 'claude-haiku-4-5', 'gemini-3.8-flash', 'gemini-2.0-flash', 'llama-4', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
        for (const provider of PROVIDER_IDS) {
            for (const model of models) {
                const values = EFFORTS.map((e) => minOutputTokens(provider, model, e));
                for (let i = 1; i < values.length; i++) assert.ok(values[i]! >= values[i - 1]!, `${provider} ${model}: ${values.join(', ')}`);
            }
        }
    });
});
