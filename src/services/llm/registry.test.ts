/**
 * The provider registry: which providers exist, what wire format each speaks, and the seeds the
 * settings card starts from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { adapterFor } from './adapters/index.js';
import { isAiError } from './errors.js';
import { isProviderId, PROVIDER_IDS, PROVIDERS, providerById, providerName } from './registry.js';

describe('PROVIDERS', () => {
    it('lists the five launch providers in the order resolveRoute falls back through them', () => {
        assert.deepEqual(PROVIDERS.map((p) => p.id), ['anthropic', 'openai', 'gemini', 'openrouter', 'custom']);
        assert.deepEqual([...PROVIDER_IDS], PROVIDERS.map((p) => p.id));
    });

    it('puts each provider on the wire family the spec names', () => {
        const families = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.family]));
        assert.deepEqual(families, {
            anthropic: 'anthropic',
            openai: 'openai_responses',
            gemini: 'gemini',
            openrouter: 'chat_completions',
            custom: 'chat_completions',
        });
    });

    it('defaults Anthropic to Opus 5.5 and offers Sonnet and Haiku 5.5 beside it', () => {
        const anthropic = providerById('anthropic')!;
        assert.equal(anthropic.defaultModel, 'claude-opus-5-5');
        assert.deepEqual([...anthropic.suggestedModels], ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    });

    it('seeds every provider that has models with a default that is also one of its suggestions', () => {
        for (const p of PROVIDERS.filter((p) => p.suggestedModels.length)) {
            assert.ok(p.suggestedModels.includes(p.defaultModel), `${p.id}: ${p.defaultModel}`);
        }
    });

    it('has a public https base URL for every provider but Custom, whose URL is the operator\'s', () => {
        for (const p of PROVIDERS.filter((p) => p.id !== 'custom')) {
            assert.match(p.baseUrl, /^https:\/\/[^/]+/, p.id);
            assert.ok(!p.baseUrl.endsWith('/'), `${p.id} base URL has a trailing slash`);
            assert.equal(p.editableBaseUrl, false, p.id);
        }
        const custom = providerById('custom')!;
        assert.equal(custom.baseUrl, '');
        assert.equal(custom.editableBaseUrl, true);
        assert.equal(custom.defaultModel, '');
    });

    it('requires a key from every provider except Custom', () => {
        assert.deepEqual(PROVIDERS.filter((p) => !p.keyRequired).map((p) => p.id), ['custom']);
    });

    it('has no duplicate ids and every entry labelled', () => {
        assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
        for (const p of PROVIDERS) assert.ok(p.label.length > 0, p.id);
    });
});

describe('providerById, isProviderId and providerName', () => {
    it('finds a provider by id and says no to one that does not exist', () => {
        assert.equal(providerById('gemini')?.family, 'gemini');
        assert.equal(providerById('groq'), undefined);
        assert.equal(providerById(undefined), undefined);
        assert.equal(isProviderId('openrouter'), true);
        assert.equal(isProviderId('groq'), false);
        assert.equal(isProviderId(42), false);
    });

    it('names a provider the way an error message should', () => {
        assert.equal(providerName('anthropic'), 'Anthropic');
        assert.equal(providerName('openai'), 'OpenAI');
        assert.equal(providerName('custom'), 'The custom endpoint');
        assert.equal(providerName('nope'), 'The provider');
    });
});

describe('adapterFor', () => {
    it('has adapters for the Anthropic and Gemini families', () => {
        assert.equal(typeof adapterFor('anthropic', { provider: 'anthropic', model: 'm' }), 'function');
        assert.equal(typeof adapterFor('gemini', { provider: 'gemini', model: 'm' }), 'function');
    });

    it('says a family\'s adapter is not implemented yet, as a bad_request, until P20b brings it', () => {
        for (const [family, provider] of [['openai_responses', 'openai'], ['chat_completions', 'openrouter'], ['chat_completions', 'custom']] as const) {
            assert.throws(
                () => adapterFor(family, { provider, model: 'some-model' }),
                (err: unknown) => {
                    assert.ok(isAiError(err));
                    assert.equal(err.kind, 'bad_request');
                    assert.equal(err.retryable, false);
                    assert.equal(err.provider, provider);
                    assert.match(err.message, /not implemented/);
                    return true;
                },
            );
        }
    });
});
