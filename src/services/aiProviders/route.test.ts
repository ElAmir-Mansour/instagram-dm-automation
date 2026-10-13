/**
 * `resolveRoute` (P20c): a saved route wins, then the first provider with a key, then `no_provider`; never a quiet move to another
 * provider; and the Mac guard, which keeps the owner's Monteur and infographic work off the operator's API key (06 §2).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { loadAiSettings, type AiConfig } from './settings.js';
import { isAiError } from '../llm/errors.js';
import { AI_PURPOSES, MAC_BRAIN_PURPOSES, PURPOSE_DEFAULT_EFFORT } from './purposes.js';
import { PROVIDER_IDS } from '../llm/registry.js';
import { MacBrainTenantRefused, pickRoute, resolveRoute } from './route.js';
import { installAiDb, type AiDb } from './testDb.js';
import { FAKE_KEYS } from './testKeys.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const LISTED = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;
let db: AiDb;
let savedEnv: Record<string, string | undefined>;

before(() => {
    savedEnv = { TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY };
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
});
after(() => {
    if (savedEnv.TOKEN_ENCRYPTION_KEY === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedEnv.TOKEN_ENCRYPTION_KEY;
});
beforeEach(() => {
    for (const name of ENV_NAMES) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
    }
    db = installAiDb({ owner: OWNER });
});
afterEach(() => {
    db.restore();
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
});

const saveKey = (id: keyof typeof FAKE_KEYS) => db.setSetting(id === 'gemini' ? 'gemini.api_key' : `ai.providers.${id}.api_key`, FAKE_KEYS[id], true);
const saveRouting = (routing: object) => db.setSetting('ai.routing', JSON.stringify(routing));
const saveProviders = (providers: object) => db.setSetting('ai.providers', JSON.stringify(providers));

async function pick(purpose: (typeof AI_PURPOSES)[number]) {
    const { config, keys } = await loadAiSettings();
    return pickRoute(purpose, config, keys);
}

async function failure(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (err) {
        assert.ok(isAiError(err), `expected an AiError, got ${String(err)}`);
        return err;
    }
    return assert.fail('expected a rejection');
}

describe('the default pick: the first provider that has a key', () => {
    it('is Anthropic when it has a key, at its default model and the purpose\'s effort', async () => {
        saveKey('anthropic');
        saveKey('openai');
        const route = await pick('onboarding_draft');
        assert.deepEqual(route, { purpose: 'onboarding_draft', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', source: 'default' });
    });

    it('takes the registry\'s order: Anthropic, OpenAI, Gemini, OpenRouter, Custom', async () => {
        const expected: string[] = [];
        for (const id of ['custom', 'openrouter', 'gemini', 'openai', 'anthropic'] as const) {
            if (id === 'custom') {
                saveProviders({ custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model' } });
            } else {
                saveKey(id);
            }
            expected.push(id);
            assert.equal((await pick('tenant_studio')).provider, id, `after adding ${id}`);
        }
        assert.deepEqual(expected, [...PROVIDER_IDS].reverse());
    });

    it('gives each purpose its own default effort', async () => {
        saveKey('anthropic');
        for (const purpose of AI_PURPOSES) assert.equal((await pick(purpose)).effort, PURPOSE_DEFAULT_EFFORT[purpose], purpose);
        assert.deepEqual(Object.values(PURPOSE_DEFAULT_EFFORT), ['high', 'medium', 'medium', 'high', 'high']);
    });

    it('uses the operator\'s default model for a provider over the code\'s', async () => {
        saveKey('anthropic');
        saveProviders({ anthropic: { defaultModel: 'claude-sonnet-5-5' } });
        assert.equal((await pick('onboarding_proof')).model, 'claude-sonnet-5-5');
    });

    it('skips a provider that is switched off, though its key is saved', async () => {
        saveKey('anthropic');
        saveKey('openai');
        saveProviders({ anthropic: { enabled: false } });
        assert.equal((await pick('onboarding_draft')).provider, 'openai');
    });

    it('lands on Gemini when it is the only key, which is the DM bot\'s (the card warns)', async () => {
        saveKey('gemini');
        const route = await pick('onboarding_draft');
        assert.equal(route.provider, 'gemini');
        assert.equal(route.model, 'gemini-3.8-flash');
    });

    it('takes an environment key as a key', async () => {
        process.env.OPENAI_API_KEY = FAKE_KEYS.openai;
        assert.equal((await pick('onboarding_draft')).provider, 'openai');
    });

    it('passes over Custom until it has a base URL and a model, and needs no key', async () => {
        saveProviders({ custom: { baseUrl: 'https://llm.example.com/v1' } });
        const none = await failure(resolveRoute('onboarding_draft', null));
        assert.equal(none.kind, 'no_provider', 'a base URL with no model is not a route');
        saveProviders({ custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model', jsonMode: 'object' } });
        assert.deepEqual(await pick('onboarding_draft'), {
            purpose: 'onboarding_draft', provider: 'custom', model: 'my-model', effort: 'high', source: 'default',
            baseUrl: 'https://llm.example.com/v1', jsonMode: 'object',
        });
    });

    it('is `no_provider`, final, when no provider has a key at all, and says where to add one', async () => {
        const err = await failure(resolveRoute('onboarding_draft', null));
        assert.equal(err.kind, 'no_provider');
        assert.equal(err.retryable, false);
        assert.match(err.message, /Operations → AI providers/);
    });
});

describe('a saved route', () => {
    it('wins over the default pick, with its own effort', async () => {
        saveKey('anthropic');
        saveKey('openai');
        saveRouting({ onboarding_proof: { provider: 'openai', model: 'gpt-6-luna', effort: 'low' } });
        assert.deepEqual(await pick('onboarding_proof'), { purpose: 'onboarding_proof', provider: 'openai', model: 'gpt-6-luna', effort: 'low', source: 'saved' });
        assert.equal((await pick('onboarding_draft')).provider, 'anthropic', 'a purpose with no route still takes the default');
    });

    it('with no model on it uses the provider\'s default model as it is when the call is made', async () => {
        saveKey('openai');
        saveRouting({ tenant_studio: { provider: 'openai', model: '', effort: 'medium' } });
        assert.equal((await pick('tenant_studio')).model, 'gpt-6-astra');
        saveProviders({ openai: { defaultModel: 'gpt-6.1-sol' } });
        assert.equal((await pick('tenant_studio')).model, 'gpt-6.1-sol');
    });

    it('whose provider has no key is `no_provider` naming the provider, never a move to one that has a key', async () => {
        saveKey('anthropic');
        saveRouting({ onboarding_draft: { provider: 'openai', model: 'gpt-6-astra', effort: 'high' } });
        const err = await failure(resolveRoute('onboarding_draft', null));
        assert.equal(err.kind, 'no_provider');
        assert.match(err.message, /onboarding_draft uses OpenAI, which has no API key saved/);
    });

    it('whose provider is switched off, or Custom with no base URL, is refused with that reason', async () => {
        saveKey('anthropic');
        saveProviders({ anthropic: { enabled: false } });
        saveRouting({ onboarding_draft: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' }, onboarding_proof: { provider: 'custom', model: 'm', effort: 'low' } });
        assert.match((await failure(resolveRoute('onboarding_draft', null))).message, /Anthropic, which is switched off/);
        assert.match((await failure(resolveRoute('onboarding_proof', null))).message, /which has no base URL saved/);
    });

    it('with no model anywhere (Custom, no default) is refused, and says how to fix it', async () => {
        saveProviders({ custom: { baseUrl: 'https://llm.example.com/v1' } });
        saveRouting({ onboarding_draft: { provider: 'custom', model: '', effort: 'high' } });
        assert.match((await failure(resolveRoute('onboarding_draft', null))).message, /has no model/);
    });

    it('carries Custom\'s endpoint and JSON mode, and no other provider\'s', async () => {
        saveKey('anthropic');
        saveProviders({ custom: { baseUrl: 'https://llm.example.com/v1', jsonMode: 'object' } });
        saveRouting({ onboarding_draft: { provider: 'custom', model: 'm', effort: 'high' }, onboarding_proof: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' } });
        const custom = await pick('onboarding_draft');
        assert.equal(custom.baseUrl, 'https://llm.example.com/v1');
        assert.equal(custom.jsonMode, 'object');
        const anthropic = await pick('onboarding_proof');
        assert.equal('baseUrl' in anthropic, false);
        assert.equal('jsonMode' in anthropic, false);
    });
});

describe('pickRoute is a pure choice over settings already read', () => {
    it('does not touch the database', async () => {
        saveKey('anthropic');
        const { config, keys } = await loadAiSettings();
        const before = db.statements.length;
        pickRoute('onboarding_draft', config, keys);
        pickRoute('tenant_studio', config, keys);
        assert.equal(db.statements.length, before);
    });

    it('answers from a hand-made config too', async () => {
        saveKey('openai');
        const { keys } = await loadAiSettings();
        const config: AiConfig = {
            providers: {}, routing: { onboarding_draft: { provider: 'openai', model: 'x-model', effort: 'xhigh' } }, prices: {},
            budgets: { dailyUsd: null, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: null },
        };
        assert.deepEqual(pickRoute('onboarding_draft', config, keys), { purpose: 'onboarding_draft', provider: 'openai', model: 'x-model', effort: 'xhigh', source: 'saved' });
    });
});

describe('the Mac guard', () => {
    beforeEach(() => saveKey('anthropic'));

    it('names exactly the Monteur\'s thinking and the infographic writer', () => {
        assert.deepEqual([...MAC_BRAIN_PURPOSES].sort(), ['tenant_infographic', 'tenant_monteur_think']);
    });

    it('refuses both for the owner: his videos stay on the Mac, with nothing routed through the operator\'s key', async () => {
        for (const purpose of ['tenant_monteur_think', 'tenant_infographic'] as const) {
            const err = await failure(resolveRoute(purpose, OWNER));
            assert.ok(err instanceof MacBrainTenantRefused, purpose);
            assert.equal(err.kind, 'bad_request');
            assert.equal(err.retryable, false);
            assert.equal(err.reason, 'mac_brain_tenant');
            assert.equal(err.creatorId, OWNER);
        }
    });

    it('refuses both for a tenant on studio.mac_brain_tenants, and not the next tenant', async () => {
        db.setSetting('studio.mac_brain_tenants', JSON.stringify([LISTED]));
        for (const purpose of ['tenant_monteur_think', 'tenant_infographic'] as const) {
            assert.ok((await failure(resolveRoute(purpose, LISTED))) instanceof MacBrainTenantRefused, purpose);
            assert.equal((await resolveRoute(purpose, OTHER)).provider, 'anthropic', `a tenant the Mac is not for gets the API: ${purpose}`);
        }
    });

    it('does not touch the owner\'s other purposes: his drafts and the Studio may use the API', async () => {
        for (const purpose of ['onboarding_draft', 'onboarding_proof', 'tenant_studio'] as const) {
            assert.equal((await resolveRoute(purpose, OWNER)).provider, 'anthropic', purpose);
        }
    });

    it('does not apply when the spend belongs to no tenant (the operator\'s Test on a route)', async () => {
        assert.equal((await resolveRoute('tenant_monteur_think', null)).provider, 'anthropic');
    });

    it('refuses before the settings are read, so no key is loaded for a call that will not be made', async () => {
        await failure(resolveRoute('tenant_infographic', OWNER));
        assert.equal(db.statements.some((s) => /ai\.providers\.anthropic\.api_key/.test(JSON.stringify(s.params))), false);
    });

    it('is a refusal even when no provider has a key: the Mac guard answers first', async () => {
        db.settings.clear();
        assert.ok((await failure(resolveRoute('tenant_monteur_think', OWNER))) instanceof MacBrainTenantRefused);
    });

    it('with no creators at all nobody is on the Mac, so the guard refuses nobody', async () => {
        db.owner = null;
        assert.equal((await resolveRoute('tenant_monteur_think', OTHER)).provider, 'anthropic');
    });

    it('a failing read of the list is an error, never a yes (the work is refused until the database answers)', async () => {
        db.failOn(/FROM app_settings WHERE key = \$1/, new Error('connection terminated'), 1);
        await assert.rejects(resolveRoute('tenant_infographic', OTHER), /connection terminated/);
    });
});
