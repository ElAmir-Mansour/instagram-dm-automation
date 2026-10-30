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
import { assertProviderMayAnswer, MacBrainTenantRefused, pickRoute, resolveRoute } from './route.js';
import { installAiDb, type AiDb } from './testDb.js';
import { FAKE_KEYS } from './testKeys.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const LISTED = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'META_MODEL_API_KEY', 'BASETEN_API_KEY', 'GEMINI_API_KEY'] as const;
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

    it('takes the registry\'s order: Anthropic, OpenAI, Gemini, OpenRouter, Groq, Meta, Custom (Baseten is in it, and answers the reel indexer alone: see below)', async () => {
        const expected: string[] = [];
        for (const id of ['custom', 'meta', 'groq', 'openrouter', 'gemini', 'openai', 'anthropic'] as const) {
            if (id === 'custom') {
                saveProviders({ custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model' } });
            } else {
                saveKey(id);
            }
            expected.push(id);
            assert.equal((await pick('tenant_studio')).provider, id, `after adding ${id}`);
        }
        assert.deepEqual(expected, [...PROVIDER_IDS].filter((id) => id !== 'baseten').reverse());
    });

    it('gives each purpose its own default effort', async () => {
        saveKey('anthropic');
        // The Muse purposes answer from Meta alone, so a key for it is what lets them pick at all.
        saveKey('meta');
        for (const purpose of AI_PURPOSES) assert.equal((await pick(purpose)).effort, PURPOSE_DEFAULT_EFFORT[purpose], purpose);
        assert.deepEqual(Object.values(PURPOSE_DEFAULT_EFFORT), ['high', 'medium', 'medium', 'high', 'high', 'low', 'low', 'medium', 'medium', 'low', 'low', 'low', 'low']);
    });

    it('answers the `dm` purpose at low effort on the default model, until a route is saved for it', async () => {
        saveKey('anthropic');
        assert.deepEqual(await pick('dm'), { purpose: 'dm', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', source: 'default' });
        saveProviders({ anthropic: { defaultModel: 'claude-sonnet-5-5' } });
        assert.deepEqual(await pick('dm'), { purpose: 'dm', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', source: 'default' });
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

    it('lands on Groq, at its default gpt-oss model, only when it is the first provider with a key; any earlier one keeps the default pick', async () => {
        saveKey('groq');
        assert.deepEqual(await pick('onboarding_draft'), { purpose: 'onboarding_draft', provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'high', source: 'default' });
        assert.deepEqual(await pick('dm'), { purpose: 'dm', provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low', source: 'default' });
        saveKey('openrouter');
        assert.equal((await pick('dm')).provider, 'openrouter', 'OpenRouter is ahead of Groq in the registry\'s order');
    });

    it('takes GROQ_API_KEY as Groq\'s key', async () => {
        process.env.GROQ_API_KEY = FAKE_KEYS.groq;
        assert.equal((await pick('onboarding_draft')).provider, 'groq');
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

    it('for `dm` wins over the default, with its own model and effort, and leaves every other purpose on the default', async () => {
        saveKey('anthropic');
        saveKey('openai');
        saveRouting({ dm: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } });
        assert.deepEqual(await pick('dm'), { purpose: 'dm', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', source: 'saved' });
        assert.equal((await pick('tenant_studio')).source, 'default');
        saveRouting({ dm: { provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium' } });
        assert.deepEqual(await pick('dm'), { purpose: 'dm', provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium', source: 'saved' });
    });

    it('for `dm` can be Groq, with its own model and effort, while every other purpose stays on the default and no engine or route is changed', async () => {
        saveKey('anthropic');
        saveKey('groq');
        saveRouting({ dm: { provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'medium' } });
        assert.deepEqual(await pick('dm'), { purpose: 'dm', provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'medium', source: 'saved' });
        assert.deepEqual(await pick('tenant_studio'), { purpose: 'tenant_studio', provider: 'anthropic', model: 'claude-opus-5-5', effort: 'medium', source: 'default' });
        // Groq has no base URL or JSON mode to carry: only Custom does.
        assert.ok(!('baseUrl' in (await pick('dm'))) && !('jsonMode' in (await pick('dm'))));
    });

    it('for `dm` on Groq with no key (or switched off) is `no_provider` naming Groq, never a move to the provider that has one', async () => {
        saveKey('anthropic');
        saveRouting({ dm: { provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low' } });
        assert.match((await failure(resolveRoute('dm', null))).message, /dm uses Groq, which has no API key saved/);
        saveKey('groq');
        saveProviders({ groq: { enabled: false } });
        assert.match((await failure(resolveRoute('dm', null))).message, /dm uses Groq, which is switched off/);
    });

    it('for `dm` whose provider has no key is `no_provider` naming dm and the provider, never a move to the provider that has one', async () => {
        saveKey('anthropic');
        saveRouting({ dm: { provider: 'openai', model: 'gpt-6-astra', effort: 'low' } });
        const err = await failure(resolveRoute('dm', null));
        assert.equal(err.kind, 'no_provider');
        assert.match(err.message, /dm uses OpenAI, which has no API key saved/);
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
        assert.equal(MAC_BRAIN_PURPOSES.has('dm'), false, 'a DM reply is never the Mac\'s: it is a job queue and cannot answer in seconds');
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
        for (const purpose of ['onboarding_draft', 'onboarding_proof', 'tenant_studio', 'dm'] as const) {
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

describe('the `dm_whatsapp` purpose: WhatsApp replies answer only from providers that do not train on what they are sent', () => {
    it('with no route saved for it, takes the saved `dm` route, as a saved route, at that route\'s own model and effort', async () => {
        saveKey('groq');
        saveRouting({ dm: { provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'low' } });
        assert.deepEqual(await pick('dm_whatsapp'), { purpose: 'dm_whatsapp', provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'low', source: 'saved' });
        assert.deepEqual(await pick('dm'), { purpose: 'dm', provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'low', source: 'saved' }, 'and `dm` itself is as it was');
    });

    it('prefers a route saved for itself over the `dm` route', async () => {
        saveKey('groq');
        saveKey('anthropic');
        saveRouting({ dm: { provider: 'groq', model: 'openai/gpt-oss-20b', effort: 'low' }, dm_whatsapp: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' } });
        assert.deepEqual(await pick('dm_whatsapp'), { purpose: 'dm_whatsapp', provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium', source: 'saved' });
        assert.equal((await pick('dm')).provider, 'groq', 'the Instagram route does not follow it');
    });

    it('never borrows the route of a purpose that is not its fallback: a saved `tenant_studio` route is no WhatsApp route', async () => {
        saveKey('anthropic');
        saveRouting({ tenant_studio: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } });
        assert.equal((await pick('dm_whatsapp')).source, 'default');
    });

    it('refuses a `dm` route on Gemini, OpenRouter or Custom (taken as its own), naming where the route came from, and never moves to another provider', async () => {
        saveKey('groq');
        for (const provider of ['gemini', 'openrouter'] as const) {
            saveKey(provider);
            saveRouting({ dm: { provider, model: 'some-model', effort: 'low' } });
            const err = await failure(resolveRoute('dm_whatsapp', null));
            assert.equal(err.kind, 'no_provider', provider);
            assert.match(err.message, /dm_whatsapp \(taken from the dm route\) uses/, provider);
            assert.match(err.message, /not on the list of providers that may answer this purpose \(Groq, Anthropic, OpenAI\)/, provider);
            assert.equal((await pick('dm')).provider, provider, `Instagram's \`dm\` keeps ${provider}`);
        }
        saveProviders({ custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model' } });
        saveRouting({ dm_whatsapp: { provider: 'custom', model: 'my-model', effort: 'low' } });
        assert.equal((await failure(resolveRoute('dm_whatsapp', null))).kind, 'no_provider');
    });

    it('refuses a route of its own on a provider that is not allowed, even when that provider has a key', async () => {
        saveKey('gemini');
        saveKey('groq');
        saveRouting({ dm_whatsapp: { provider: 'gemini', model: 'gemini-3.8-flash', effort: 'low' } });
        const err = await failure(resolveRoute('dm_whatsapp', null));
        assert.match(err.message, /The route for dm_whatsapp uses Google Gemini, which is not on the list/);
    });

    it('with nothing saved, defaults to the first ALLOWED provider with a key: Gemini and OpenRouter are passed over, so the default is never one of them', async () => {
        saveKey('gemini');
        saveKey('openrouter');
        const none = await failure(resolveRoute('dm_whatsapp', null));
        assert.equal(none.kind, 'no_provider', 'only providers that train: nothing to answer with');
        saveKey('groq');
        assert.deepEqual(await pick('dm_whatsapp'), { purpose: 'dm_whatsapp', provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low', source: 'default' });
        saveKey('openai');
        assert.equal((await pick('dm_whatsapp')).provider, 'openai', 'the registry\'s order, among the allowed');
        assert.equal((await pick('dm')).provider, 'openai', 'for `dm` the first with a key is, as always, ahead of Gemini');
    });

    it('does not change how any other purpose picks: Gemini is still a default for them', async () => {
        saveKey('gemini');
        assert.equal((await pick('dm')).provider, 'gemini');
        assert.equal((await pick('tenant_studio')).provider, 'gemini');
    });
});

describe('Meta (Muse): the provider and the four purposes only it answers', () => {
    const MUSE = ['perception_dm', 'recall', 'reel_index', 'comment_intent'] as const;

    it('lands on Meta, at Muse Spark 1.3 and effort low, only when it is the first provider with a key; any earlier one keeps the default pick', async () => {
        saveKey('meta');
        assert.deepEqual(await pick('onboarding_draft'), { purpose: 'onboarding_draft', provider: 'meta', model: 'muse-spark-1.3', effort: 'high', source: 'default' });
        saveKey('groq');
        assert.equal((await pick('onboarding_draft')).provider, 'groq', 'Groq is ahead of Meta in the registry\'s order');
        saveKey('anthropic');
        assert.equal((await pick('dm')).provider, 'anthropic');
    });

    it('is never what a purpose with no route is moved to while the owner\'s existing providers can answer: Gemini (the DM agent\'s key) is ahead of it', async () => {
        saveKey('gemini');
        saveKey('meta');
        for (const purpose of ['dm', 'tenant_studio', 'onboarding_draft', 'ads_draft'] as const) assert.equal((await pick(purpose)).provider, 'gemini', purpose);
    });

    it('answers a Muse purpose with Meta and nobody else, whatever other keys there are, and says so when there is no key for it', async () => {
        saveKey('anthropic');
        saveKey('gemini');
        saveKey('groq');
        for (const purpose of MUSE) {
            const err = await failure(resolveRoute(purpose, null));
            assert.equal(err.kind, 'no_provider', purpose);
            assert.equal(err.retryable, false);
            assert.match(err.message, /No AI provider is ready/, purpose);
        }
        saveKey('meta');
        for (const purpose of MUSE) {
            assert.deepEqual(await pick(purpose), { purpose, provider: 'meta', model: 'muse-spark-1.3', effort: 'low', source: 'default' }, purpose);
        }
    });

    it('takes a saved route to Meta for a Muse purpose, at that route\'s own model and effort', async () => {
        saveKey('meta');
        saveRouting({ perception_dm: { provider: 'meta', model: 'muse-spark-1.2', effort: 'medium' } });
        assert.deepEqual(await pick('perception_dm'), { purpose: 'perception_dm', provider: 'meta', model: 'muse-spark-1.2', effort: 'medium', source: 'saved' });
        assert.equal((await pick('recall')).source, 'default', 'a route for one Muse purpose is no route for another');
    });

    it('with no model on it uses Meta\'s default model as it is when the call is made, so the operator moving it moves every such route', async () => {
        saveKey('meta');
        saveRouting({ reel_index: { provider: 'meta', model: '', effort: 'low' } });
        assert.equal((await pick('reel_index')).model, 'muse-spark-1.3');
        saveProviders({ meta: { defaultModel: 'muse-spark-1.2' } });
        assert.equal((await pick('reel_index')).model, 'muse-spark-1.2');
    });

    it('refuses a Muse route that names another provider, naming the list (Meta) and where it came from, and never moves to Meta or to the provider that has a key', async () => {
        saveKey('meta');
        saveKey('anthropic');
        for (const purpose of MUSE) {
            saveRouting({ [purpose]: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' } });
            const err = await failure(resolveRoute(purpose, null));
            assert.equal(err.kind, 'no_provider', purpose);
            const list = purpose === 'reel_index' ? 'Meta, Baseten' : 'Meta';
            assert.match(err.message, new RegExp(`The route for ${purpose} uses Anthropic, which is not on the list of providers that may answer this purpose \\(${list}\\)`), purpose);
        }
    });

    it('is no_provider naming Meta, never a move to the provider that has a key, when a Muse route\'s key is missing or the provider is switched off', async () => {
        saveKey('anthropic');
        saveRouting({ perception_dm: { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' } });
        assert.match((await failure(resolveRoute('perception_dm', null))).message, /perception_dm uses Meta, which has no API key saved/);
        saveKey('meta');
        saveProviders({ meta: { enabled: false } });
        assert.match((await failure(resolveRoute('perception_dm', null))).message, /perception_dm uses Meta, which is switched off/);
    });

    it('takes META_MODEL_API_KEY as Meta\'s key', async () => {
        process.env.META_MODEL_API_KEY = FAKE_KEYS.meta;
        assert.equal((await pick('perception_dm')).provider, 'meta');
    });

    it('does not open WhatsApp to Meta: it is not one of the providers that forbid training, so a WhatsApp route on it is refused', async () => {
        saveKey('meta');
        saveKey('groq');
        saveRouting({ dm_whatsapp: { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' } });
        const err = await failure(resolveRoute('dm_whatsapp', null));
        assert.match(err.message, /The route for dm_whatsapp uses Meta, which is not on the list of providers that may answer this purpose \(Groq, Anthropic, OpenAI\)/);
        // With nothing saved the default skips Meta too.
        saveRouting({});
        assert.equal((await pick('dm_whatsapp')).provider, 'groq');
    });
});

describe('Baseten (Meta\'s open model): answers the reel indexer and no other purpose, however it is chosen', () => {
    const OTHERS = AI_PURPOSES.filter((purpose) => purpose !== 'reel_index');
    const MODEL = 'meta-models/muse-spark-open-1026';
    const refusal = (purpose: string, via = purpose) => new RegExp(`The route for ${via.replace(/[()]/g, '\\$&')} uses Baseten\\. Baseten may answer only reel_index: it watches the owner's own published reels, and no message, comment or follower data goes to it\\. Choose another provider\\.`);

    it('is what the reel indexer lands on when it is the only provider with a key, at its model and effort low; and nothing else lands on it, whatever the purpose', async () => {
        saveKey('baseten');
        assert.deepEqual(await pick('reel_index'), { purpose: 'reel_index', provider: 'baseten', model: MODEL, effort: 'low', source: 'default' });
        assert.equal(OTHERS.length, 12);
        for (const purpose of OTHERS) {
            const err = await failure(resolveRoute(purpose, null));
            assert.equal(err.kind, 'no_provider', purpose);
            assert.equal(err.retryable, false, purpose);
            assert.match(err.message, /No AI provider is ready/, `${purpose}: the default order never reaches Baseten, so there is no provider at all`);
        }
    });

    it('is never what a purpose with no route is moved to, even with a key, while another provider can answer: Anthropic or Groq or Gemini keeps `dm` and every default pick', async () => {
        saveKey('baseten');
        saveKey('groq');
        for (const purpose of ['dm', 'dm_whatsapp', 'tenant_studio', 'onboarding_draft', 'ads_draft'] as const) assert.equal((await pick(purpose)).provider, 'groq', purpose);
        // And a Muse purpose that only Meta answers still needs Meta: Baseten does not stand in for it (it is on reel_index's list alone).
        for (const purpose of ['perception_dm', 'recall', 'comment_intent'] as const) assert.equal((await failure(resolveRoute(purpose, null))).kind, 'no_provider', purpose);
    });

    it('comes after Meta in the default order for the reel indexer: with both keys and no route, Meta\'s hosted model answers, and the open model only when the operator routes it', async () => {
        saveKey('baseten');
        saveKey('meta');
        assert.deepEqual(await pick('reel_index'), { purpose: 'reel_index', provider: 'meta', model: 'muse-spark-1.3', effort: 'low', source: 'default' });
        saveRouting({ reel_index: { provider: 'baseten', model: '', effort: 'low' } });
        assert.deepEqual(await pick('reel_index'), { purpose: 'reel_index', provider: 'baseten', model: MODEL, effort: 'low', source: 'saved' });
        saveRouting({ reel_index: { provider: 'baseten', model: 'meta-models/muse-spark-open', effort: 'medium' } });
        assert.deepEqual(await pick('reel_index'), { purpose: 'reel_index', provider: 'baseten', model: 'meta-models/muse-spark-open', effort: 'medium', source: 'saved' });
    });

    it('refuses a saved route to Baseten for every other purpose, by name and before its key is looked at, whether or not the key is there, and never moves to another provider', async () => {
        saveKey('anthropic');
        saveKey('meta');
        for (const withKey of [false, true]) {
            if (withKey) saveKey('baseten');
            for (const purpose of OTHERS) {
                saveRouting({ [purpose]: { provider: 'baseten', model: MODEL, effort: 'low' } });
                const err = await failure(resolveRoute(purpose, null));
                assert.equal(err.kind, 'no_provider', `${purpose} key=${withKey}`);
                assert.match(err.message, refusal(purpose), `${purpose} key=${withKey}`);
            }
        }
    });

    it('refuses WhatsApp\'s borrowed route the same way and names where it came from: dm_whatsapp takes the dm route, and a dm route on Baseten is refused for both', async () => {
        saveKey('baseten');
        saveKey('groq');
        saveRouting({ dm: { provider: 'baseten', model: MODEL, effort: 'low' } });
        assert.match((await failure(resolveRoute('dm', null))).message, refusal('dm'));
        assert.match((await failure(resolveRoute('dm_whatsapp', null))).message, refusal('dm_whatsapp', 'dm_whatsapp (taken from the dm route)'));
    });

    it('refuses a Muse purpose routed to Baseten with the privacy reason and not a list of providers: the rule on the provider comes first', async () => {
        saveKey('baseten');
        for (const purpose of ['perception_dm', 'recall', 'comment_intent'] as const) {
            saveRouting({ [purpose]: { provider: 'baseten', model: MODEL, effort: 'low' } });
            assert.match((await failure(resolveRoute(purpose, null))).message, refusal(purpose), purpose);
        }
    });

    it('is no_provider naming Baseten, never a move to another provider, when the reel indexer\'s route has no key or the provider is switched off', async () => {
        saveKey('meta');
        saveRouting({ reel_index: { provider: 'baseten', model: '', effort: 'low' } });
        assert.match((await failure(resolveRoute('reel_index', null))).message, /reel_index uses Baseten, which has no API key saved/);
        saveKey('baseten');
        saveProviders({ baseten: { enabled: false } });
        assert.match((await failure(resolveRoute('reel_index', null))).message, /reel_index uses Baseten, which is switched off/);
    });

    it('takes BASETEN_API_KEY as Baseten\'s key', async () => {
        process.env.BASETEN_API_KEY = FAKE_KEYS.baseten;
        assert.equal((await pick('reel_index')).provider, 'baseten');
    });

    it('is what `skip` passes over: the indexer\'s second try on Meta\'s hosted model after Baseten failed, and only a narrowing, never a way to name a provider', async () => {
        saveKey('baseten');
        saveKey('meta');
        saveRouting({ reel_index: { provider: 'baseten', model: '', effort: 'low' } });
        const { config, keys } = await loadAiSettings();
        // Skipping the saved route's provider falls to the default order: the first allowed provider with a key, at its default model.
        assert.deepEqual(pickRoute('reel_index', config, keys, { skip: ['baseten'] }), { purpose: 'reel_index', provider: 'meta', model: 'muse-spark-1.3', effort: 'low', source: 'default' });
        // Skipping a provider the route does not name changes nothing.
        assert.equal(pickRoute('reel_index', config, keys, { skip: ['meta'] }).provider, 'baseten');
        assert.equal(pickRoute('reel_index', config, keys, { skip: [] }).provider, 'baseten');
        // With nobody left to answer, it is no_provider, not a return to the provider that was skipped.
        assert.throws(() => pickRoute('reel_index', config, keys, { skip: ['baseten', 'meta'] }), (err: unknown) => isAiError(err) && err.kind === 'no_provider');
        // Skipping can never reach Baseten for another purpose: the deny holds for the default order.
        for (const purpose of OTHERS) {
            assert.throws(() => pickRoute(purpose, { ...config, routing: {} }, keys, { skip: ['meta', 'anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'custom'] }), (err: unknown) => isAiError(err) && err.kind === 'no_provider', purpose);
        }
    });

    it('is asserted on its own too, for a caller that has a route in hand: Baseten for reel_index passes, and for any other purpose is a final no_provider', () => {
        assert.doesNotThrow(() => assertProviderMayAnswer('baseten', 'reel_index'));
        for (const provider of PROVIDER_IDS.filter((id) => id !== 'baseten')) for (const purpose of AI_PURPOSES) assert.doesNotThrow(() => assertProviderMayAnswer(provider, purpose), `${provider} ${purpose}`);
        for (const purpose of OTHERS) {
            assert.throws(() => assertProviderMayAnswer('baseten', purpose), (err: unknown) => isAiError(err) && err.kind === 'no_provider' && !err.retryable && err.message.startsWith('Baseten may answer only reel_index') && err.message.endsWith(`It cannot be used for ${purpose}.`), purpose);
        }
    });
});

describe('a Contributor-mode model is never what a purpose answers with: Meta may train on what it is sent', () => {
    const CONTRIBUTOR = 'muse-spark-1.3-contributor';

    it('refuses a saved route that names one, by name, for any purpose, whichever provider the route is on', async () => {
        saveKey('meta');
        saveKey('anthropic');
        for (const [purpose, provider] of [['dm', 'meta'], ['perception_dm', 'meta'], ['tenant_studio', 'anthropic']] as const) {
            saveRouting({ [purpose]: { provider, model: CONTRIBUTOR, effort: 'low' } });
            const err = await failure(resolveRoute(purpose, null));
            assert.equal(err.kind, 'no_provider', purpose);
            assert.equal(err.retryable, false);
            assert.match(err.message, new RegExp(`The route for ${purpose} uses ${CONTRIBUTOR}, a Contributor-mode model: ${provider === 'meta' ? 'Meta' : 'Anthropic'} may train on what it is sent, so no purpose may use it\\. Choose the Standard model instead\\.`), purpose);
        }
    });

    it('refuses one that arrives as the provider\'s default model, though the route names none, and the Standard model is fine', async () => {
        saveKey('meta');
        saveRouting({ perception_dm: { provider: 'meta', model: '', effort: 'low' } });
        saveProviders({ meta: { defaultModel: CONTRIBUTOR } });
        assert.match((await failure(resolveRoute('perception_dm', null))).message, /uses muse-spark-1\.3-contributor, a Contributor-mode model/);
        saveProviders({ meta: { defaultModel: 'muse-spark-1.3' } });
        assert.equal((await pick('perception_dm')).model, 'muse-spark-1.3');
    });

    it('passes over a provider whose default model is one when no route is saved, as it does a provider with no key, and falls to the next that can answer', async () => {
        saveKey('groq');
        saveKey('meta');
        saveProviders({ groq: { defaultModel: 'some-model-contributor' } });
        assert.equal((await pick('onboarding_draft')).provider, 'meta');
        saveKey('anthropic');
        assert.equal((await pick('onboarding_draft')).provider, 'anthropic');
    });

    it('is allowed only when the caller says it is an evaluation of made-up cases (`allowContributor`), and only then', async () => {
        saveKey('meta');
        saveRouting({ dm: { provider: 'meta', model: CONTRIBUTOR, effort: 'low' } });
        const { config, keys } = await loadAiSettings();
        assert.throws(() => pickRoute('dm', config, keys), /a Contributor-mode model/);
        assert.throws(() => pickRoute('dm', config, keys, {}), /a Contributor-mode model/);
        assert.throws(() => pickRoute('dm', config, keys, { allowContributor: false }), /a Contributor-mode model/);
        assert.deepEqual(pickRoute('dm', config, keys, { allowContributor: true }), { purpose: 'dm', provider: 'meta', model: CONTRIBUTOR, effort: 'low', source: 'saved' });
    });

    it('is shown to the card the way it is for any route that cannot answer: as an error naming the model, not as a route in use', async () => {
        saveKey('meta');
        saveRouting({ dm: { provider: 'meta', model: CONTRIBUTOR, effort: 'low' } });
        const err = await failure(resolveRoute('dm', null));
        assert.match(err.message, /^The route for dm uses muse-spark-1\.3-contributor/);
    });
});
