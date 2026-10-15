/**
 * The provider registry: which providers exist, what wire format each speaks, and the seeds the
 * settings card starts from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPENROUTER_BASE_URL } from './adapters/chatCompletions.js';
import { ADAPTERS, adapterFor } from './adapters/index.js';
import { OPENAI_BASE_URL } from './adapters/openai.js';
import { isAiError } from './errors.js';
import { checkBaseUrl, isProviderId, PROVIDER_IDS, PROVIDERS, providerById, providerName } from './registry.js';

describe('PROVIDERS', () => {
    it('lists the six providers in the order resolveRoute falls back through them', () => {
        assert.deepEqual(PROVIDERS.map((p) => p.id), ['anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'custom']);
        assert.deepEqual([...PROVIDER_IDS], PROVIDERS.map((p) => p.id));
    });

    it('puts each provider on the wire family the spec names', () => {
        const families = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.family]));
        assert.deepEqual(families, {
            anthropic: 'anthropic',
            openai: 'openai_responses',
            gemini: 'gemini',
            openrouter: 'chat_completions',
            groq: 'chat_completions',
            custom: 'chat_completions',
        });
    });

    it('has Groq at its fixed OpenAI-compatible address, key required, defaulting to a gpt-oss model and suggesting no Llama', () => {
        const groq = providerById('groq')!;
        assert.equal(groq.label, 'Groq');
        assert.equal(groq.baseUrl, 'https://api.groq.com/openai/v1');
        assert.equal(groq.editableBaseUrl, false);
        assert.equal(groq.keyRequired, true);
        assert.equal(groq.defaultModel, 'openai/gpt-oss-120b');
        assert.deepEqual([...groq.suggestedModels], ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
        // Strict `json_schema` is what every call asks for, and among Groq's production models only gpt-oss does it (the registry says why).
        for (const model of groq.suggestedModels) assert.match(model, /^openai\/gpt-oss-/);
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
        assert.equal(providerById('groq')?.family, 'chat_completions');
        assert.equal(providerById('mistral'), undefined);
        assert.equal(providerById(undefined), undefined);
        assert.equal(isProviderId('openrouter'), true);
        assert.equal(isProviderId('groq'), true);
        assert.equal(isProviderId('mistral'), false);
        assert.equal(isProviderId(42), false);
    });

    it('names a provider the way an error message should', () => {
        assert.equal(providerName('anthropic'), 'Anthropic');
        assert.equal(providerName('openai'), 'OpenAI');
        assert.equal(providerName('groq'), 'Groq');
        assert.equal(providerName('custom'), 'The custom endpoint');
        assert.equal(providerName('nope'), 'The provider');
    });
});

describe('adapterFor', () => {
    it('has an adapter for every wire family, shaped {generate, normalize?, listModels?, checkKey?}', () => {
        assert.deepEqual(Object.keys(ADAPTERS).sort(), ['anthropic', 'chat_completions', 'gemini', 'openai_responses']);
        for (const [family, adapter] of Object.entries(ADAPTERS)) {
            assert.equal(typeof adapter.generate, 'function', family);
            assert.equal(typeof adapter.listModels, 'function', family);
            assert.equal(typeof adapter.checkKey, 'function', family);
        }
        // Only the two families that reshape the schema for strict mode have something to undo.
        assert.deepEqual(Object.entries(ADAPTERS).filter(([, a]) => a.normalize).map(([f]) => f).sort(), ['chat_completions', 'openai_responses']);
    });

    it('has an adapter for the family of every provider in the registry: none is left "not available yet"', () => {
        for (const p of PROVIDERS) {
            const adapter = adapterFor(p.family, { provider: p.id, model: 'm' });
            assert.equal(adapter, ADAPTERS[p.family], p.id);
            assert.equal(typeof adapter.generate, 'function', p.id);
        }
    });

    it('answers a family that is missing from the map it was given with a bad_request, not a crash', () => {
        assert.throws(
            () => adapterFor('openai_responses', { provider: 'openai', model: 'some-model' }, { anthropic: ADAPTERS.anthropic! }),
            (err: unknown) => {
                assert.ok(isAiError(err));
                assert.equal(err.kind, 'bad_request');
                assert.equal(err.retryable, false);
                assert.equal(err.provider, 'openai');
                assert.match(err.message, /no adapter for the openai_responses family/);
                return true;
            },
        );
    });

    it('agrees with the registry about where OpenAI and OpenRouter live', () => {
        assert.equal(OPENAI_BASE_URL, providerById('openai')!.baseUrl);
        assert.equal(OPENROUTER_BASE_URL, providerById('openrouter')!.baseUrl);
    });
});

describe('checkBaseUrl', () => {
    it('accepts a public https origin and returns it without a trailing slash', () => {
        assert.deepEqual(checkBaseUrl('https://llm.example.com'), { ok: true, url: 'https://llm.example.com' });
        assert.deepEqual(checkBaseUrl('  https://llm.example.com/v1/  '), { ok: true, url: 'https://llm.example.com/v1' });
        assert.deepEqual(checkBaseUrl('https://gateway.example.co.uk:8443/openai/v1'), { ok: true, url: 'https://gateway.example.co.uk:8443/openai/v1' });
    });

    it('requires https, because the key would cross the network readable over anything else', () => {
        for (const url of ['http://llm.example.com/v1', 'ftp://llm.example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'llm.example.com/v1']) {
            const checked = checkBaseUrl(url);
            assert.equal(checked.ok, false, url);
        }
        assert.match((checkBaseUrl('http://llm.example.com') as { reason: string }).reason, /https/);
    });

    it('refuses addresses that only exist on a private network', () => {
        const refused = [
            'https://127.0.0.1/v1', 'https://10.0.0.5', 'https://192.168.1.1:8080', 'https://169.254.169.254/latest/meta-data',
            'https://[::1]/v1', 'https://[fd00::1]/v1', 'https://localhost/v1', 'https://api.localhost', 'https://printer.local',
            'https://db.internal/v1', 'https://intranet', 'https://LOCALHOST./v1',
            // The URL parser spells these as the dotted address before they are checked.
            'https://2130706433/v1', 'https://0x7f.0.0.1/v1', 'https://0177.0.0.1/v1',
        ];
        for (const url of refused) assert.equal(checkBaseUrl(url).ok, false, url);
    });

    it('refuses credentials, a query and a fragment in the URL', () => {
        for (const url of ['https://user:pass@llm.example.com', 'https://token@llm.example.com', 'https://llm.example.com/v1?key=abc', 'https://llm.example.com/v1#frag']) {
            assert.equal(checkBaseUrl(url).ok, false, url);
        }
    });

    it('says what is wrong, so the settings card can show it', () => {
        assert.deepEqual(checkBaseUrl('not a url'), { ok: false, reason: 'is not a valid URL' });
        assert.match((checkBaseUrl('https://10.0.0.5') as { reason: string }).reason, /public address/);
        assert.match((checkBaseUrl('https://u:p@llm.example.com') as { reason: string }).reason, /username or password/);
    });
});
