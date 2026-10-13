/**
 * The AI layer's settings (P20c): how a key is read and what it is reduced to, how each `ai.*` row is parsed and what a change to
 * it may be, and that nothing a screen is told contains a key. Against the in-memory stand-in for `app_settings` (testDb.ts).
 *
 * Fake keys are built at run time, never written as literals: a key-shaped string in the repository is what secret scanners block a push for.
 */
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { APP_SETTING_KEYS, getSettings, isSecretSetting, last4 } from '../appSettings.js';
import {
    applyAiPlan, BUDGET_NAMES, defaultModelOf, keyProblem, loadAiSettings, MAX_PRICE_OVERRIDES, parseBudget, parsePrices, parseProviders, parseRouting,
    planAiPatch, PROVIDER_KEY_ENV, PROVIDER_KEY_SETTING, providerProblem, type AiConfig,
} from './settings.js';
import { describeAi } from './view.js';
import { PROVIDER_IDS } from '../llm/registry.js';
import { installAiDb, type AiDb } from './testDb.js';
import { assertNoKey, FAKE_KEYS } from './testKeys.js';

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'] as const;

let db: AiDb;
let savedEnv: Record<string, string | undefined>;
let logs: string[];
let restoreSink: (() => void) | undefined;

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
    db = installAiDb();
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
});

const EMPTY: AiConfig = { providers: {}, routing: {}, prices: {}, budgets: { dailyUsd: null, monthlyUsd: null, tenantDailyUsd: null, tenantMonthlyUsd: null } };

describe('the setting keys', () => {
    it('are the ones 06 names, one secret row per provider, and Gemini keeps the existing one', () => {
        assert.deepEqual(Object.values(PROVIDER_KEY_SETTING).sort(), [
            'ai.providers.anthropic.api_key', 'ai.providers.custom.api_key', 'ai.providers.openai.api_key', 'ai.providers.openrouter.api_key', 'gemini.api_key',
        ]);
        assert.equal(PROVIDER_KEY_SETTING.gemini, APP_SETTING_KEYS.geminiApiKey);
        assert.equal(APP_SETTING_KEYS.aiProviders, 'ai.providers');
        assert.equal(APP_SETTING_KEYS.aiRouting, 'ai.routing');
        assert.equal(APP_SETTING_KEYS.aiPrices, 'ai.prices');
        assert.equal(APP_SETTING_KEYS.aiBudgetDailyUsd, 'ai.budget.daily_usd');
        assert.equal(APP_SETTING_KEYS.aiBudgetTenantDailyUsd, 'ai.budget.tenant_daily_usd');
    });

    it('make every key a secret (encrypted at rest) and nothing else one', () => {
        for (const id of PROVIDER_IDS) assert.equal(isSecretSetting(PROVIDER_KEY_SETTING[id]), true, id);
        for (const key of [APP_SETTING_KEYS.aiProviders, APP_SETTING_KEYS.aiRouting, APP_SETTING_KEYS.aiPrices, APP_SETTING_KEYS.aiBudgetDailyUsd, APP_SETTING_KEYS.aiBudgetMonthlyUsd]) {
            assert.equal(isSecretSetting(key), false, key);
        }
    });

    it('have environment fallbacks for three providers and Gemini, none for Custom', () => {
        assert.deepEqual(PROVIDER_KEY_ENV, { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', custom: null });
    });
});

describe('getSettings and last4', () => {
    it('reads several rows in one statement, decrypting the secrets, with null for what is not saved', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        db.setSetting('ai.budget.daily_usd', '5');
        const got = await getSettings([APP_SETTING_KEYS.aiProviderKeyAnthropic, APP_SETTING_KEYS.aiBudgetDailyUsd, APP_SETTING_KEYS.aiRouting]);
        assert.equal(got.get(APP_SETTING_KEYS.aiProviderKeyAnthropic), FAKE_KEYS.anthropic);
        assert.equal(got.get(APP_SETTING_KEYS.aiBudgetDailyUsd), '5');
        assert.equal(got.get(APP_SETTING_KEYS.aiRouting), null);
        assert.equal(db.statements.filter((s) => /FROM app_settings/.test(s.sql)).length, 1);
    });

    it('shows the last four characters of a key, and nothing of one too short to spare them', () => {
        assert.equal(last4(FAKE_KEYS.anthropic), 'ant1');
        assert.equal(last4('abcdefghijk'), null, '11 characters');
        assert.equal(last4('abcdefghijkl'), 'ijkl');
    });
});

describe('loadAiSettings: the keys', () => {
    it('a saved key wins over the environment, and says so', async () => {
        process.env.ANTHROPIC_API_KEY = FAKE_KEYS.openai;
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        const { keys } = await loadAiSettings();
        assert.equal(keys.get('anthropic'), FAKE_KEYS.anthropic);
        assert.deepEqual(keys.status('anthropic'), { set: true, source: 'database', last4: 'ant1', envFallback: true });
    });

    it('falls back to the environment, trimmed, and never previews it', async () => {
        process.env.OPENAI_API_KEY = `  ${FAKE_KEYS.openai}\n`;
        const { keys } = await loadAiSettings();
        assert.equal(keys.get('openai'), FAKE_KEYS.openai);
        assert.deepEqual(keys.status('openai'), { set: true, source: 'env', last4: null, envFallback: true });
    });

    it('is not set when there is no key anywhere; a blank env var is not a key', async () => {
        process.env.OPENROUTER_API_KEY = '   ';
        const { keys } = await loadAiSettings();
        assert.equal(keys.has('openrouter'), false);
        assert.equal(keys.get('openrouter'), null);
        assert.deepEqual(keys.status('openrouter'), { set: false, source: null, last4: null, envFallback: false });
    });

    it("reads Gemini's key from the platform's existing setting, saved first, then GEMINI_API_KEY", async () => {
        process.env.GEMINI_API_KEY = FAKE_KEYS.openai;
        assert.equal((await loadAiSettings()).keys.get('gemini'), FAKE_KEYS.openai);
        db.setSetting('gemini.api_key', FAKE_KEYS.gemini, true);
        const { keys } = await loadAiSettings();
        assert.equal(keys.get('gemini'), FAKE_KEYS.gemini);
        assert.equal(keys.status('gemini').source, 'database');
    });

    it('Custom has no environment fallback', async () => {
        process.env.CUSTOM_API_KEY = FAKE_KEYS.custom;
        try {
            assert.equal((await loadAiSettings()).keys.has('custom'), false);
        } finally {
            delete process.env.CUSTOM_API_KEY;
        }
    });

    it('cannot be printed: JSON, inspect and string interpolation show a placeholder, never a key', async () => {
        for (const id of PROVIDER_IDS) db.setSetting(PROVIDER_KEY_SETTING[id], FAKE_KEYS[id], true);
        const { keys, config } = await loadAiSettings();
        for (const [label, text] of Object.entries({
            json: JSON.stringify(keys), inspect: inspect(keys, { depth: 5, showHidden: true }), template: `${keys}`,
            both: JSON.stringify({ keys, config }), logged: inspect({ keys }, { depth: 5 }),
        })) assertNoKey(text, label);
        assert.equal(JSON.stringify(keys), '"[ProviderKeys]"');
    });

    it('stores a saved key encrypted, never as the pasted text', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        const stored = db.settings.get('ai.providers.anthropic.api_key')!;
        assert.equal(stored.is_secret, true);
        assert.match(stored.value, /^enc:v1:/);
        assertNoKey(stored.value, 'stored value');
    });
});

describe('what a screen is told (describeAi)', () => {
    it('is {set, source, last4} for a key and contains no key, whole or in part, for every provider at once', async () => {
        for (const id of PROVIDER_IDS) db.setSetting(PROVIDER_KEY_SETTING[id], FAKE_KEYS[id], true);
        db.setSetting('ai.providers', JSON.stringify({ custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model' } }));
        const { config, keys } = await loadAiSettings();
        const view = describeAi(config, keys);
        assertNoKey(JSON.stringify(view), 'the view');
        const anthropic = view.providers.find((p) => p.id === 'anthropic')!;
        assert.deepEqual(anthropic.key, { set: true, source: 'database', last4: 'ant1', envFallback: false });
        assert.deepEqual(Object.keys(anthropic.key).sort(), ['envFallback', 'last4', 'set', 'source']);
    });

    it('lists every provider with its usable state and the reason when it is not usable', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        db.setSetting('ai.providers', JSON.stringify({ openai: { enabled: false } }));
        const { config, keys } = await loadAiSettings();
        const byId = Object.fromEntries(describeAi(config, keys).providers.map((p) => [p.id, p]));
        assert.equal(byId.anthropic!.usable, true);
        assert.equal(byId.openai!.problem, 'is switched off');
        assert.equal(byId.openai!.enabled, false);
        assert.equal(byId.openrouter!.problem, 'has no API key saved');
        assert.equal(byId.custom!.problem, 'has no base URL saved');
        assert.equal(byId.gemini!.sharesDmQuota, true);
        assert.equal(byId.anthropic!.sharesDmQuota, false);
        assert.equal(byId.anthropic!.defaultModel, 'claude-opus-5-5');
        assert.equal(byId.anthropic!.defaultModelSource, 'code');
        assert.equal(byId.custom!.baseUrl, null);
        assert.equal(byId.anthropic!.baseUrl, null, 'only Custom has one');
    });

    it('warns when no budget is set, when a route lands on Gemini (the DM bot\'s quota), and for a model with no price', async () => {
        db.setSetting('gemini.api_key', FAKE_KEYS.gemini, true);
        let { config, keys } = await loadAiSettings();
        let codes = describeAi(config, keys).warnings.map((w) => w.code);
        assert.deepEqual(codes.sort(), ['gemini_dm_quota', 'no_budget']);

        db.setSetting('ai.budget.daily_usd', '5');
        db.setSetting('ai.providers.openai.api_key', FAKE_KEYS.openai, true);
        ({ config, keys } = await loadAiSettings());
        const view = describeAi(config, keys);
        codes = view.warnings.map((w) => w.code);
        assert.deepEqual(codes, ['unpriced_model'], 'openai answers first; its default model has no price in the table');
        assert.deepEqual(view.warnings[0]!.detail, ['gpt-6-astra']);
    });

    it('shows each purpose with what it would use now: the saved route, or the reason it would fail', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        db.setSetting('ai.routing', JSON.stringify({ onboarding_proof: { provider: 'openai', model: 'gpt-6-luna', effort: 'low' } }));
        const { config, keys } = await loadAiSettings();
        const purposes = Object.fromEntries(describeAi(config, keys).purposes.map((p) => [p.purpose, p]));
        assert.deepEqual(purposes.onboarding_draft!.resolved, { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high', source: 'default' });
        const proof = purposes.onboarding_proof!.resolved;
        assert.ok('error' in proof);
        assert.equal(proof.error.kind, 'no_provider');
        assert.match(proof.error.message, /OpenAI, which has no API key saved/);
        assert.equal(purposes.tenant_monteur_think!.macBrainGuarded, true);
        assert.equal(purposes.onboarding_draft!.macBrainGuarded, false);
    });

    it('seeds the price table from code and marks the operator\'s own', async () => {
        db.setSetting('ai.prices', JSON.stringify({ 'gpt-6-astra': { in: 2.5, out: 10 }, 'claude-opus-5-5': { in: 3, out: 15 } }));
        const { config, keys } = await loadAiSettings();
        const prices = Object.fromEntries(describeAi(config, keys).prices.map((p) => [p.model, p]));
        assert.deepEqual(prices['claude-sonnet-5-5'], { model: 'claude-sonnet-5-5', in: 2, out: 10, source: 'default' });
        assert.deepEqual(prices['gpt-6-astra'], { model: 'gpt-6-astra', in: 2.5, out: 10, source: 'custom' });
        assert.equal(prices['claude-opus-5-5']!.in, 3);
    });
});

describe('reading the JSON settings is forgiving', () => {
    it('drops an entry it cannot read and keeps the rest, with a warning that names the entry, never its value', () => {
        const providers = parseProviders(JSON.stringify({
            anthropic: { defaultModel: 'claude-sonnet-5-5' }, openai: 'oops', nope: {}, custom: { baseUrl: 'http://insecure.example.com', defaultModel: 'x' },
        }));
        assert.deepEqual(providers, { anthropic: { defaultModel: 'claude-sonnet-5-5' } });
        assert.ok(logs.some((l) => l.includes('"entry":"openai"')));
        assert.ok(logs.some((l) => l.includes('"entry":"custom"')));
        assert.ok(!logs.some((l) => l.includes('insecure')), 'the value is not logged');
    });

    it('reads a route with its effort, and gives an entry with no effort its purpose\'s default', () => {
        const routing = parseRouting(JSON.stringify({
            onboarding_draft: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'max' },
            onboarding_proof: { provider: 'openai' },
            not_a_purpose: { provider: 'openai' }, tenant_studio: { provider: 'mistral' },
        }));
        assert.deepEqual(routing, {
            onboarding_draft: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'max' },
            onboarding_proof: { provider: 'openai', model: '', effort: 'medium' },
        });
    });

    it('lower-cases price keys and skips a price that is not two good numbers', () => {
        const prices = parsePrices(JSON.stringify({ 'GPT-6-Astra': { in: 1, out: 2 }, bad: { in: -1, out: 2 }, worse: { in: 'x', out: 1 } }));
        assert.deepEqual(prices, { 'gpt-6-astra': { in: 1, out: 2 } });
    });

    it('a malformed row is the same as no row: not an error', () => {
        for (const raw of ['not json', '[]', '"x"', 'null']) {
            assert.deepEqual(parseProviders(raw), {});
            assert.deepEqual(parseRouting(raw), {});
            assert.deepEqual(parsePrices(raw), {});
        }
        assert.deepEqual(parseProviders(null), {});
    });

    it('reads a budget as a number of dollars, unset as no limit, and a bad one as no limit with a warning', () => {
        assert.equal(parseBudget(null, 'ai.budget.daily_usd'), null);
        assert.equal(parseBudget('0', 'ai.budget.daily_usd'), 0, 'zero is a limit: it refuses everything');
        assert.equal(parseBudget('12.5', 'ai.budget.daily_usd'), 12.5);
        assert.equal(parseBudget('lots', 'ai.budget.daily_usd'), null);
        assert.equal(parseBudget('-3', 'ai.budget.daily_usd'), null);
        assert.ok(logs.some((l) => l.includes('ai.setting_unreadable')));
    });
});

describe('planAiPatch: what a change may be', () => {
    const plan = (body: unknown, current: AiConfig = EMPTY) => planAiPatch(body, current);
    const problems = (body: unknown, current?: AiConfig): string[] => {
        const r = plan(body, current);
        assert.equal(r.ok, false, JSON.stringify(body));
        return r.ok ? [] : r.problems;
    };

    it('accepts a provider\'s default model and Custom\'s endpoint, normalising the URL', () => {
        const r = plan({ providers: { anthropic: { defaultModel: ' claude-sonnet-5-5 ' }, custom: { baseUrl: 'https://LLM.example.com/v1/', jsonMode: 'object', defaultModel: 'my-model' } } });
        assert.ok(r.ok);
        assert.deepEqual(r.plan.providers, {
            anthropic: { defaultModel: 'claude-sonnet-5-5' },
            custom: { baseUrl: 'https://llm.example.com/v1', jsonMode: 'object', defaultModel: 'my-model' },
        });
        assert.deepEqual(r.plan.changes.providers, ['anthropic', 'custom']);
    });

    it('merges a provider\'s fields into what is saved, so saving a model does not forget the base URL; null clears one field', () => {
        const current: AiConfig = { ...EMPTY, providers: { custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'old' } } };
        let r = plan({ providers: { custom: { defaultModel: 'new' } } }, current);
        assert.ok(r.ok);
        assert.deepEqual(r.plan.providers!.custom, { baseUrl: 'https://llm.example.com/v1', defaultModel: 'new' });
        r = plan({ providers: { custom: { defaultModel: null } } }, current);
        assert.ok(r.ok);
        assert.deepEqual(r.plan.providers!.custom, { baseUrl: 'https://llm.example.com/v1' });
        r = plan({ providers: { custom: null } }, current);
        assert.ok(r.ok);
        assert.deepEqual(r.plan.providers, {}, 'null resets the provider to its defaults');
    });

    it('stores `enabled` only when it is false, so switching a provider back on leaves nothing behind', () => {
        const current: AiConfig = { ...EMPTY, providers: { openai: { enabled: false, defaultModel: 'gpt-6-luna' } } };
        const r = plan({ providers: { openai: { enabled: true } } }, current);
        assert.ok(r.ok);
        assert.deepEqual(r.plan.providers!.openai, { defaultModel: 'gpt-6-luna' });
    });

    it('refuses a base URL anywhere but Custom, and one that is not a public https address', () => {
        assert.match(problems({ providers: { openai: { baseUrl: 'https://llm.example.com/v1' } } })[0]!, /only Custom has a base URL/);
        for (const url of ['http://llm.example.com/v1', 'https://localhost/v1', 'https://10.0.0.5/v1', 'https://intranet/v1', 'https://user:pw@llm.example.com/v1', 'ftp://x.example.com', 'not a url']) {
            assert.match(problems({ providers: { custom: { baseUrl: url } } })[0]!, /providers\.custom\.baseUrl/, url);
        }
        assert.match(problems({ providers: { anthropic: { jsonMode: 'object' } } })[0]!, /only Custom has a JSON mode/);
        assert.match(problems({ providers: { custom: { jsonMode: 'both' } } })[0]!, /"schema" or "object"/);
    });

    it('refuses an unknown provider, an unknown field, a bad model id and a non-boolean enabled', () => {
        assert.match(problems({ providers: { mistral: {} } })[0]!, /is not a provider/);
        assert.match(problems({ providers: { anthropic: { apiKey: 'x' } } })[0]!, /is not a setting/);
        assert.match(problems({ providers: { anthropic: { defaultModel: 'has spaces' } } })[0]!, /not a model id/);
        assert.match(problems({ providers: { anthropic: { enabled: 'yes' } } })[0]!, /true or false/);
        assert.match(problems({ providers: { anthropic: 'x' } })[0]!, /must be an object/);
    });

    it('saves a route as {provider, model, effort}, giving a missing effort its purpose\'s default, and null removes it', () => {
        let r = plan({ routing: { onboarding_draft: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'xhigh' }, tenant_studio: { provider: 'openai' } } });
        assert.ok(r.ok);
        assert.deepEqual(r.plan.routing, {
            onboarding_draft: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'xhigh' },
            tenant_studio: { provider: 'openai', model: '', effort: 'medium' },
        });
        assert.deepEqual(r.plan.changes.routes, { onboarding_draft: 'anthropic/claude-opus-5-5/xhigh', tenant_studio: 'openai/default/medium' });
        r = plan({ routing: { onboarding_draft: null } }, { ...EMPTY, routing: r.plan.routing! });
        assert.ok(r.ok);
        assert.deepEqual(Object.keys(r.plan.routing!), ['tenant_studio']);
        assert.deepEqual(r.plan.changes.routes, { onboarding_draft: 'removed' });
    });

    it('refuses a route for an unknown purpose or provider, a bad effort, a bad model, or a stray field', () => {
        assert.match(problems({ routing: { key_test: { provider: 'openai' } } })[0]!, /is not a purpose/);
        assert.match(problems({ routing: { onboarding_draft: { provider: 'mistral' } } })[0]!, /provider must be one of/);
        assert.match(problems({ routing: { onboarding_draft: {} } })[0]!, /provider must be one of/);
        assert.match(problems({ routing: { onboarding_draft: { provider: 'openai', effort: 'turbo' } } })[0]!, /effort must be one of/);
        assert.match(problems({ routing: { onboarding_draft: { provider: 'openai', model: 'a b' } } })[0]!, /not a model id/);
        assert.match(problems({ routing: { onboarding_draft: { provider: 'openai', fallback: 'x' } } })[0]!, /is not a setting/);
    });

    it('saves prices per model, lower-cased, and refuses a figure that is not dollars per million tokens', () => {
        const r = plan({ prices: { 'GPT-6-Astra': { in: 2.5, out: 10 }, 'old-model': null } }, { ...EMPTY, prices: { 'old-model': { in: 1, out: 1 } } });
        assert.ok(r.ok);
        assert.deepEqual(r.plan.prices, { 'gpt-6-astra': { in: 2.5, out: 10 } });
        assert.deepEqual(r.plan.changes.prices, ['gpt-6-astra', 'old-model']);
        for (const bad of [{ in: -1, out: 1 }, { in: 1 }, { in: '1', out: 1 }, { in: 1, out: 20_000 }, { in: 1, out: 1, cached: 0.5 }, 5]) {
            assert.ok(problems({ prices: { 'gpt-6-astra': bad } })[0]!.startsWith('prices.gpt-6-astra'), JSON.stringify(bad));
        }
        assert.match(problems({ prices: { 'not a model': { in: 1, out: 1 } } })[0]!, /not a model id/);
    });

    it('caps how many prices can be saved', () => {
        const many = Object.fromEntries(Array.from({ length: MAX_PRICE_OVERRIDES + 1 }, (_, i) => [`model-${i}`, { in: 1, out: 1 }]));
        assert.match(problems({ prices: many })[0]!, /At most 200 prices/);
    });

    it('takes a budget as a number or numeric text, null as no limit, and refuses a negative or non-numeric one', () => {
        const r = plan({ budgets: { dailyUsd: '7.5', monthlyUsd: 100, tenantDailyUsd: null, tenantMonthlyUsd: 0 } });
        assert.ok(r.ok);
        assert.deepEqual(r.plan.budgets, { dailyUsd: 7.5, monthlyUsd: 100, tenantDailyUsd: null, tenantMonthlyUsd: 0 });
        assert.deepEqual(r.plan.changes.budgets, [...BUDGET_NAMES]);
        for (const bad of [-1, 'lots', NaN, Infinity, 2_000_000, {}, true]) {
            assert.match(problems({ budgets: { dailyUsd: bad } })[0]!, /budgets\.dailyUsd must be a number/, String(bad));
        }
        assert.match(problems({ budgets: { weeklyUsd: 1 } })[0]!, /is not a budget/);
    });

    it('is all or nothing: one bad entry among good ones is a list of problems and no plan', () => {
        const r = plan({ budgets: { dailyUsd: 5 }, routing: { onboarding_draft: { provider: 'mistral' } }, prices: { x: { in: 1 } } });
        assert.equal(r.ok, false);
        assert.equal(r.ok ? 0 : r.problems.length, 2);
    });

    it('refuses a body that is not an object, an unknown section, an empty change and a section that is not an object', () => {
        assert.match(problems('x')[0]!, /Send an object/);
        assert.match(problems(null)[0]!, /Send an object/);
        assert.match(problems({ keys: {} })[0]!, /is not a section/);
        assert.match(problems({ routing: [] })[0]!, /routing must be an object/);
        assert.deepEqual(problems({}), ['Nothing to change.']);
        assert.deepEqual(problems({ routing: {} }), ['Nothing to change.']);
    });

    it('a request cannot smuggle a key in: `keys` and `apiKey` are not settings of this body', () => {
        assert.match(problems({ keys: { anthropic: FAKE_KEYS.anthropic } })[0]!, /is not a section/);
        const r = problems({ providers: { anthropic: { apiKey: FAKE_KEYS.anthropic } } });
        assert.match(r[0]!, /is not a setting/);
        assertNoKey(r.join(' '), 'the problems');
    });
});

describe('applyAiPlan', () => {
    it('writes each section as one row, an empty one deletes it, and a budget of null deletes its row', async () => {
        db.setSetting('ai.budget.daily_usd', '5');
        db.setSetting('ai.routing', JSON.stringify({ onboarding_draft: { provider: 'openai', model: '', effort: 'high' } }));
        const planned = planAiPatch({
            providers: { custom: { baseUrl: 'https://llm.example.com/v1' } },
            routing: { onboarding_draft: null },
            prices: { 'gpt-6-astra': { in: 2, out: 8 } },
            budgets: { dailyUsd: null, tenantDailyUsd: 1.5 },
        }, EMPTY);
        assert.ok(planned.ok);
        await applyAiPlan(planned.plan, 'user-1');
        assert.deepEqual(JSON.parse(db.settings.get('ai.providers')!.value), { custom: { baseUrl: 'https://llm.example.com/v1' } });
        assert.equal(db.settings.has('ai.routing'), false);
        assert.deepEqual(JSON.parse(db.settings.get('ai.prices')!.value), { 'gpt-6-astra': { in: 2, out: 8 } });
        assert.equal(db.settings.has('ai.budget.daily_usd'), false);
        assert.equal(db.settings.get('ai.budget.tenant_daily_usd')!.value, '1.5');
        const { config } = await loadAiSettings();
        assert.equal(config.budgets.tenantDailyUsd, 1.5);
        assert.equal(config.budgets.dailyUsd, null);
    });
});

describe('providerProblem and defaultModelOf', () => {
    it('names why a provider cannot answer, and only then', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        db.setSetting('ai.providers', JSON.stringify({ anthropic: { enabled: false }, custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'm' } }));
        const { config, keys } = await loadAiSettings();
        assert.equal(providerProblem('anthropic', config, keys), 'is switched off');
        assert.equal(providerProblem('openai', config, keys), 'has no API key saved');
        assert.equal(providerProblem('custom', config, keys), null, 'Custom needs a base URL, not a key');
        assert.equal(defaultModelOf('custom', config), 'm');
        assert.equal(defaultModelOf('gemini', config), 'gemini-3.8-flash');
        assert.equal(defaultModelOf('custom', EMPTY), '');
    });
});

describe('keyProblem', () => {
    it('accepts one run of printable characters of a plausible length and refuses everything else', () => {
        for (const key of Object.values(FAKE_KEYS)) assert.equal(keyProblem(key), null);
        for (const bad of [undefined, null, '', '   ', 42, 'short', 'has a space inside the key', 'tab\tinside-the-key-12345', 'x'.repeat(601), 'nöt-ascii-key-123456']) {
            assert.ok(keyProblem(bad), JSON.stringify(bad));
        }
    });

    it('never repeats the key it refused', () => {
        const bad = FAKE_KEYS.anthropic + ' extra words';
        assertNoKey(keyProblem(bad) ?? '', 'the problem', [FAKE_KEYS.anthropic]);
    });
});
