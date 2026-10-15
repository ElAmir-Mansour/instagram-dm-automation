/**
 * `generate` (P20c): route, budget, call, settle. The provider is `setLlmCaller`'s stand-in unless a test says otherwise, so the layer
 * under test is the router, the reservation and the row; one test at the end runs the real Anthropic adapter against a stub `fetch`
 * to see the whole path put together. Against the in-memory stand-in for the database (testDb.ts).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { estimateUsd, generate, setAiCaller, setProviderFetch, type AiGenerateArgs } from './generate.js';
import { AiError, isAiError } from '../llm/errors.js';
import type { GeminiSchema } from '../llm/geminiSchema.js';
import { setLlmCaller, type GenerateJsonArgs, type GenerateJsonResult } from '../llm/generate.js';
import { MacBrainTenantRefused } from './route.js';
import { BudgetRefused, monthStart } from './usage.js';
import { installAiDb, type AiDb } from './testDb.js';
import { jsonResponse, stubFetch } from '../llm/testFetch.js';
import { assertNoKey, FAKE_KEYS } from './testKeys.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TENANT = '44444444-4444-4444-8444-444444444444';
const SCHEMA: GeminiSchema = { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] };

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY'] as const;
let db: AiDb;
let savedEnv: Record<string, string | undefined>;
let logs: { level: string; line: string }[];
let restoreSink: (() => void) | undefined;
let restoreCaller: (() => void) | undefined;
let providerCalls: GenerateJsonArgs[];

/** What the stand-in provider answers next; set per test. */
let answer: (args: GenerateJsonArgs) => GenerateJsonResult | Promise<GenerateJsonResult>;

const okAnswer = (over: Partial<GenerateJsonResult> = {}): GenerateJsonResult => ({
    json: { reply: 'OUTPUT-SENTINEL-the-model-said-this' },
    usage: { in: 1000, out: 500 },
    billed: [{ model: 'claude-opus-5-5', in: 1000, out: 500 }],
    model: 'claude-opus-5-5', provider: 'anthropic', stopReason: 'end_turn', elapsed_ms: 1234,
    ...over,
});

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
    db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
    logs = [];
    const previous = setLogSink((level, line) => { logs.push({ level, line }); });
    restoreSink = () => setLogSink(previous);
    providerCalls = [];
    answer = () => okAnswer();
    const previousCaller = setLlmCaller(async (args) => {
        providerCalls.push(args);
        return answer(args);
    });
    restoreCaller = () => setLlmCaller(previousCaller);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
    restoreCaller?.();
    setProviderFetch(undefined);
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
});

const call = (over: Partial<AiGenerateArgs> = {}) => generate({
    purpose: 'onboarding_draft', creatorId: TENANT, system: 'SYSTEM-SENTINEL you write a profile.', user: 'USER-SENTINEL the bio is …',
    schema: SCHEMA, maxTokens: 20_000, timeoutMs: 60_000, ...over,
});

async function failure(promise: Promise<unknown>): Promise<AiError> {
    try {
        await promise;
    } catch (err) {
        assert.ok(isAiError(err), `expected an AiError, got ${String(err)}`);
        return err;
    }
    return assert.fail('expected a rejection');
}

const budgets = (over: Record<string, string>) => { for (const [k, v] of Object.entries(over)) db.setSetting(k, v); };

describe('a call that succeeds', () => {
    it('writes one row: tenant, purpose, provider, model, tokens, dollars, ok, latency, with nothing left reserved', async () => {
        const out = await call();
        assert.equal(db.usage.length, 1);
        const row = db.usage[0]!;
        assert.equal(row.creator_id, TENANT);
        assert.equal(row.purpose, 'onboarding_draft');
        assert.equal(row.provider, 'anthropic');
        assert.equal(row.model, 'claude-opus-5-5');
        assert.equal(row.input_tokens, 1000);
        assert.equal(row.output_tokens, 500);
        assert.equal(row.outcome, 'ok');
        assert.equal(row.priced, true);
        assert.equal(row.usd, 0.014, '1000 in at $4/M plus 500 out at $20/M');
        assert.ok(row.elapsed_ms !== null && row.elapsed_ms >= 0);
        assert.equal(out.usageId, row.id);
        assert.ok(!db.usage.some((u) => u.outcome === 'reserved'));
    });

    it('returns the answer, the cost, where the cost came from and which route answered', async () => {
        const out = await call();
        assert.deepEqual(out.json, { reply: 'OUTPUT-SENTINEL-the-model-said-this' });
        assert.equal(out.usd, 0.014);
        assert.equal(out.priced, true);
        assert.equal(out.costSource, 'table');
        assert.equal(out.route, 'default');
        assert.equal(out.effort, 'high');
        assert.deepEqual(out.usage, { in: 1000, out: 500 });
        assert.equal(out.billed[0]!.usd, 0.014);
    });

    it('takes the provider\'s own figure over the price table when it reported one', async () => {
        db.setSetting('ai.providers.openrouter.api_key', FAKE_KEYS.openrouter, true);
        db.setSetting('ai.routing', JSON.stringify({ tenant_studio: { provider: 'openrouter', model: 'some/model', effort: 'medium' } }));
        answer = () => okAnswer({ model: 'some/model', provider: 'openrouter', billed: [{ model: 'some/model', in: 400, out: 100, usd: 0.0031, source: 'provider' }], usage: { in: 400, out: 100 } });
        const out = await call({ purpose: 'tenant_studio' });
        assert.equal(out.usd, 0.0031);
        assert.equal(out.costSource, 'provider');
        assert.equal(out.priced, true);
        assert.equal(db.usage[0]!.usd, 0.0031);
    });

    it('charges a model with no price at the table\'s ceiling and marks the row unpriced', async () => {
        db.setSetting('ai.routing', JSON.stringify({ onboarding_draft: { provider: 'anthropic', model: 'claude-mystery-9', effort: 'high' } }));
        answer = () => okAnswer({ model: 'claude-mystery-9', billed: [{ model: 'claude-mystery-9', in: 1_000_000, out: 1_000_000 }], usage: { in: 1e6, out: 1e6 } });
        const out = await call();
        assert.equal(out.priced, false);
        assert.equal(db.usage[0]!.priced, false);
        assert.equal(db.usage[0]!.usd, 30, 'the highest rates in the table: $5 in, $25 out');
    });

    it('prices with the operator\'s table laid over the code\'s', async () => {
        db.setSetting('ai.prices', JSON.stringify({ 'claude-opus-5-5': { in: 1, out: 1 } }));
        assert.equal((await call()).usd, 0.0015);
    });

    it('records the model that answered, which a server-side fallback can make differ from the one asked for', async () => {
        answer = () => okAnswer({ model: 'claude-opus-4-8', billed: [{ model: 'claude-opus-5-5', in: 500, out: 0 }, { model: 'claude-opus-4-8', in: 500, out: 500 }] });
        const out = await call();
        assert.equal(db.usage[0]!.model, 'claude-opus-4-8');
        assert.equal(db.usage[0]!.input_tokens, 1000);
        assert.equal(out.usd, 0.017, 'each model at its own price: Opus 5.5 $4/$20 for the declined attempt, Opus 4.8 $5/$25 for the answer');
    });

    it('records a call that belongs to no tenant with a null tenant, and a different `usageAs` as the row\'s purpose', async () => {
        await call({ creatorId: null, usageAs: 'key_test', purpose: 'onboarding_proof' });
        assert.equal(db.usage[0]!.creator_id, null);
        assert.equal(db.usage[0]!.purpose, 'key_test');
    });
});

describe('the route a call takes', () => {
    it('sends the provider the route\'s model, the right key, the route\'s effort and the caller\'s prompts', async () => {
        await call();
        assert.equal(providerCalls.length, 1);
        const sent = providerCalls[0]!;
        assert.equal(sent.provider, 'anthropic');
        assert.equal(sent.model, 'claude-opus-5-5');
        assert.equal(sent.apiKey, FAKE_KEYS.anthropic);
        assert.equal(sent.effort, 'high');
        assert.equal(sent.system, 'SYSTEM-SENTINEL you write a profile.');
        assert.equal(sent.user, 'USER-SENTINEL the bio is …');
        assert.equal(sent.timeoutMs, 60_000);
        assert.equal(sent.baseUrl, undefined);
    });

    it('follows a saved route to another provider, with that provider\'s key, and Custom\'s endpoint and JSON mode', async () => {
        db.setSetting('ai.providers.custom.api_key', FAKE_KEYS.custom, true);
        db.setSetting('ai.providers', JSON.stringify({ custom: { baseUrl: 'https://llm.example.com/v1', jsonMode: 'object' } }));
        db.setSetting('ai.routing', JSON.stringify({ onboarding_proof: { provider: 'custom', model: 'my-model', effort: 'low' } }));
        answer = () => okAnswer({ model: 'my-model', provider: 'custom', billed: [{ model: 'my-model', in: 10, out: 10 }], usage: { in: 10, out: 10 } });
        const out = await call({ purpose: 'onboarding_proof' });
        const sent = providerCalls[0]!;
        assert.deepEqual([sent.provider, sent.model, sent.apiKey, sent.baseUrl, sent.jsonMode, sent.effort], ['custom', 'my-model', FAKE_KEYS.custom, 'https://llm.example.com/v1', 'object', 'low']);
        assert.equal(out.route, 'saved');
        assert.equal(db.usage[0]!.provider, 'custom');
    });

    it('lets the caller override the route\'s effort for one call', async () => {
        await call({ effort: 'low' });
        assert.equal(providerCalls[0]!.effort, 'low');
        assert.equal((await call({ effort: 'max' })).effort, 'max');
    });

    it('raises a `maxTokens` that is too small for the route\'s model to think and answer, and never lowers one', async () => {
        await call({ maxTokens: 1000 });
        assert.equal(providerCalls[0]!.maxTokens, 16_000, 'Opus 5.5 at high effort needs room to think');
        await call({ maxTokens: 50_000 });
        assert.equal(providerCalls[1]!.maxTokens, 50_000);
    });

    it('does not retry, and does not try another provider, when the one it chose fails', async () => {
        db.setSetting('ai.providers.openai.api_key', FAKE_KEYS.openai, true);
        answer = () => { throw new AiError({ kind: 'server', provider: 'anthropic', model: 'claude-opus-5-5', message: 'overloaded', status: 529 }); };
        const err = await failure(call());
        assert.equal(err.kind, 'server');
        assert.equal(providerCalls.length, 1);
        assert.equal(providerCalls[0]!.provider, 'anthropic');
    });
});

describe('a call that fails', () => {
    it('writes one row with the error kind, no tokens and no cost when the provider never answered', async () => {
        answer = () => { throw new AiError({ kind: 'auth', provider: 'anthropic', model: 'claude-opus-5-5', message: 'invalid x-api-key', status: 401 }); };
        const err = await failure(call());
        assert.equal(err.kind, 'auth');
        assert.equal(db.usage.length, 1);
        assert.deepEqual(
            [db.usage[0]!.outcome, db.usage[0]!.input_tokens, db.usage[0]!.output_tokens, db.usage[0]!.usd, db.usage[0]!.priced],
            ['auth', 0, 0, 0, true]
        );
    });

    it('charges what an answer that was refused, cut off or malformed was billed for', async () => {
        for (const [kind, expectedUsd] of [['refusal', 0.0035], ['max_tokens', 0.0035], ['bad_output', 0.0035]] as const) {
            db.usage.length = 0;
            answer = () => { throw new AiError({ kind, provider: 'anthropic', model: 'claude-opus-5-5', message: 'x', usage: { in: 500, out: 75 }, billed: [{ model: 'claude-opus-5-5', in: 500, out: 75 }] }); };
            await failure(call());
            const row = db.usage[0]!;
            assert.equal(row.outcome, kind);
            assert.equal(row.input_tokens, 500);
            assert.equal(row.output_tokens, 75);
            assert.equal(row.usd, expectedUsd, kind);
        }
    });

    it('rethrows the very error the provider layer threw, for the caller\'s state machine to read `kind` and `retryable`', async () => {
        const original = new AiError({ kind: 'rate', provider: 'anthropic', model: 'claude-opus-5-5', message: 'slow down', status: 429, retryAfterMs: 30_000 });
        answer = () => { throw original; };
        const err = await failure(call());
        assert.equal(err, original);
        assert.equal(err.retryable, true);
        assert.equal(db.usage[0]!.outcome, 'rate');
    });

    it('records an error that is not an AiError as `bad_request` and rethrows it', async () => {
        answer = () => { throw new TypeError('boom'); };
        await assert.rejects(call(), TypeError);
        assert.equal(db.usage[0]!.outcome, 'bad_request');
        assert.equal(db.usage.filter((u) => u.outcome === 'reserved').length, 0);
    });

    it('a timeout is recorded as one', async () => {
        answer = () => { throw new AiError({ kind: 'timeout', provider: 'anthropic', model: 'claude-opus-5-5', message: 'no answer' }); };
        await failure(call());
        assert.equal(db.usage[0]!.outcome, 'timeout');
    });

    it('still returns the answer when the row cannot be settled: a call that was paid for is not thrown away over bookkeeping', async () => {
        db.failOn(/^UPDATE ai_usage/, new Error('connection terminated'));
        const out = await call();
        assert.deepEqual(out.json, { reply: 'OUTPUT-SENTINEL-the-model-said-this' });
        assert.equal(db.usage[0]!.outcome, 'reserved', 'the reservation stays, at its ceiling');
        assert.ok(logs.some((l) => l.line.includes('ai.usage_settle_failed')));
    });

    it('does not ask the provider when the reservation cannot be made: a call that cannot be recorded cannot be limited', async () => {
        db.failOn(/^INSERT INTO ai_usage/, new Error('connection terminated'));
        await assert.rejects(call(), /connection terminated/);
        assert.equal(providerCalls.length, 0);
        assert.equal(db.openClients(), 0);
    });

    it('does not ask the provider when the settings cannot be read', async () => {
        db.failOn(/FROM app_settings WHERE key = ANY/, new Error('connection terminated'));
        await assert.rejects(call(), /connection terminated/);
        assert.equal(providerCalls.length, 0);
        assert.equal(db.usage.length, 0);
    });
});

describe('budgets, through generate', () => {
    it('refuses a call once the day\'s spend has reached the budget, with `budget`, and the provider is never asked', async () => {
        budgets({ 'ai.budget.daily_usd': '1' });
        db.seedUsage({ usd: 1, at: db.now });
        const err = await failure(call());
        assert.ok(err instanceof BudgetRefused);
        assert.equal(err.kind, 'budget');
        assert.equal(err.scope, 'global_day');
        assert.equal(providerCalls.length, 0);
        const row = db.usage.find((u) => u.outcome === 'budget')!;
        assert.equal(row.usd, 0);
        assert.equal(row.creator_id, TENANT);
        assert.equal(row.purpose, 'onboarding_draft');
    });

    it('lets a call through under the budget, and a tenant over its own is refused while another tenant is not', async () => {
        budgets({ 'ai.budget.tenant_daily_usd': '0.5' });
        db.seedUsage({ usd: 0.49, at: db.now, creator_id: TENANT });
        await call({ maxTokens: 20_000, creatorId: TENANT });
        const err = await failure(call());
        assert.equal((err as BudgetRefused).scope, 'tenant_day', 'the first call settled at $0.014, taking the tenant past 0.5');
        await call({ creatorId: OWNER });
        assert.equal(providerCalls.length, 2);
    });

    it('refuses on the month\'s budget when the day\'s is fine', async () => {
        budgets({ 'ai.budget.daily_usd': '100', 'ai.budget.monthly_usd': '10' });
        db.seedUsage({ usd: 10, at: monthStart(new Date()) });
        assert.equal(((await failure(call())) as BudgetRefused).scope, 'global_month');
    });

    it('a budget of 0 pauses everything', async () => {
        budgets({ 'ai.budget.daily_usd': '0' });
        await failure(call());
        assert.equal(providerCalls.length, 0);
    });

    it('two calls racing past the budget: the second is refused and only one reaches the provider', async () => {
        // Each call reserves its ceiling: its 20 000-token limit at $20/M plus the input, about $0.40. A budget of $0.30 leaves room for one.
        budgets({ 'ai.budget.daily_usd': '0.3' });
        const results = await Promise.allSettled([call(), call()]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        assert.ok(refused.reason instanceof BudgetRefused);
        assert.equal(providerCalls.length, 1);
    });

    it('counts the call itself at what it cost once it has finished, not at its ceiling', async () => {
        budgets({ 'ai.budget.daily_usd': '0.1' });
        await call();
        await call();
        assert.equal(providerCalls.length, 2, 'two calls at $0.014 fit in $0.10 even though each reserved about $0.40 while it ran');
        assert.equal(db.usage.reduce((n, u) => n + u.usd, 0), 0.028);
    });
});

describe('no provider, and the Mac guard', () => {
    it('with no key anywhere is `no_provider`, recorded as a refusal, and the provider is never asked', async () => {
        db.settings.clear();
        const err = await failure(call());
        assert.equal(err.kind, 'no_provider');
        assert.equal(providerCalls.length, 0);
        assert.deepEqual([db.usage[0]!.outcome, db.usage[0]!.provider, db.usage[0]!.usd, db.usage[0]!.creator_id], ['no_provider', 'none', 0, TENANT]);
    });

    it('refuses the owner\'s Monteur and infographic work: no call, no row, the Mac\'s work stays on the Mac', async () => {
        for (const purpose of ['tenant_monteur_think', 'tenant_infographic'] as const) {
            const err = await failure(call({ purpose, creatorId: OWNER }));
            assert.ok(err instanceof MacBrainTenantRefused, purpose);
        }
        assert.equal(providerCalls.length, 0);
        assert.equal(db.usage.length, 0);
        assert.equal(db.statements.some((s) => /INSERT INTO ai_usage/.test(s.sql)), false);
        assert.equal(db.statements.some((s) => /ANY\(\$1::text\[\]\)/.test(s.sql)), false, 'no key was loaded for a call that will not be made');
    });

    it('lets the owner use the layer for what is not the Mac\'s work', async () => {
        await call({ purpose: 'tenant_studio', creatorId: OWNER });
        assert.equal(providerCalls.length, 1);
    });

    it('lets another tenant have the Monteur\'s thinking through the API', async () => {
        await call({ purpose: 'tenant_monteur_think', creatorId: TENANT });
        assert.equal(providerCalls.length, 1);
        assert.equal(db.usage[0]!.purpose, 'tenant_monteur_think');
    });
});

describe('what the caller got wrong is refused before anything is read or written', () => {
    it('a purpose, a tenant id, a token limit or a deadline that is not valid is `bad_request`, with no row and no provider call', async () => {
        const bad: Partial<AiGenerateArgs>[] = [
            { purpose: 'key_test' as never }, { purpose: 'nope' as never }, { creatorId: 'not-a-uuid' }, { creatorId: '' },
            { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: '5000' as never }, { maxTokens: NaN },
            { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: '60000' as never },
        ];
        for (const over of bad) {
            const err = await failure(call(over));
            assert.equal(err.kind, 'bad_request', JSON.stringify(over));
        }
        assert.equal(providerCalls.length, 0);
        assert.equal(db.usage.length, 0);
        assert.equal(db.statements.length, 0, 'not even a settings read');
    });
});

describe('estimateUsd', () => {
    const args = { system: 'x'.repeat(1000), user: 'y'.repeat(3000), schema: SCHEMA };

    it('is the whole token limit at the output price plus a half-token-a-character input estimate', () => {
        const { usd, priced } = estimateUsd(args, 10_000, 'claude-opus-5-5', {});
        const input = Math.ceil((4000 + JSON.stringify(SCHEMA).length) / 2);
        assert.equal(priced, true);
        assert.equal(usd, (input * 4 + 10_000 * 20) / 1e6);
    });

    it('counts every turn of a conversation, and prices an unknown model at the table\'s ceiling', () => {
        const turns = estimateUsd({ system: '', user: [{ role: 'user', text: 'a'.repeat(100) }, { role: 'model', text: 'b'.repeat(100) }], schema: SCHEMA }, 1000, 'mystery-model', {});
        assert.equal(turns.priced, false);
        assert.ok(turns.usd >= (1000 * 25) / 1e6);
    });
});

describe('what is logged', () => {
    it('is the purpose, provider, model, outcome, tokens, dollars and latency, and never a key, a prompt or an answer', async () => {
        await call();
        answer = () => { throw new AiError({ kind: 'bad_output', provider: 'anthropic', model: 'claude-opus-5-5', message: 'not json', usage: { in: 10, out: 10 } }); };
        await failure(call());
        db.settings.clear();
        await failure(call());
        const text = logs.map((l) => l.line).join('\n');
        assert.ok(logs.some((l) => l.line.includes('"event":"ai.call"')));
        assert.ok(logs.some((l) => l.line.includes('"event":"ai.call_failed"')));
        assert.ok(logs.some((l) => l.line.includes('"event":"ai.call_refused"')));
        assertNoKey(text, 'the log');
        for (const secret of ['SYSTEM-SENTINEL', 'USER-SENTINEL', 'OUTPUT-SENTINEL']) assert.ok(!text.includes(secret), `the log contains ${secret}`);
        const line = JSON.parse(logs.find((l) => l.line.includes('"event":"ai.call"'))!.line);
        assert.equal(line.purpose, 'onboarding_draft');
        assert.equal(line.usage_in, 1000, 'token counts are logged under names the redactor leaves alone');
        assert.equal(line.usage_out, 500);
        assert.equal(line.usd, 0.014);
        assert.equal(line.provider, 'anthropic');
        assert.equal(line.outcome, 'ok');
    });

    it('is the same in the rows: no key, prompt or answer in anything written to ai_usage or the audit ledger', async () => {
        await call();
        answer = () => { throw new AiError({ kind: 'auth', provider: 'anthropic', model: 'claude-opus-5-5', message: `invalid x-api-key ${FAKE_KEYS.anthropic}`, status: 401 }); };
        const err = await failure(call());
        assert.ok(!err.message.includes(FAKE_KEYS.anthropic), 'the error is scrubbed of the key');
        const stored = JSON.stringify(db.usage) + JSON.stringify(db.audits);
        assertNoKey(stored, 'the rows');
        for (const secret of ['SYSTEM-SENTINEL', 'USER-SENTINEL', 'OUTPUT-SENTINEL']) assert.ok(!stored.includes(secret), `the rows contain ${secret}`);
    });
});

describe('setAiCaller and setProviderFetch', () => {
    it('swaps `generate` whole for a test of a caller, with no settings read and no row, and puts back what it replaced', async () => {
        const canned = { json: { ok: true }, usd: 0 } as never;
        const seen: AiGenerateArgs[] = [];
        const previous = setAiCaller(async (args) => { seen.push(args); return canned; });
        try {
            assert.equal(await call(), canned);
            assert.equal(seen[0]!.purpose, 'onboarding_draft');
            assert.equal(db.statements.length, 0);
            assert.equal(providerCalls.length, 0);
        } finally {
            assert.notEqual(setAiCaller(previous), previous);
        }
        const out = await call();
        assert.equal(out.usd, 0.014, 'the real one is back');
    });

    it('hands every call the fetch it was given, so a test can run the real adapters', async () => {
        const fetchImpl = (async () => new Response('{}')) as never;
        setProviderFetch(fetchImpl);
        await call();
        assert.equal(providerCalls[0]!.fetchImpl, fetchImpl);
        await call({ fetchImpl: undefined });
        const own = (async () => new Response('{}')) as never;
        await call({ fetchImpl: own });
        assert.equal(providerCalls[2]!.fetchImpl, own, 'a call\'s own fetch wins');
    });
});

describe('the whole path, through the real Anthropic adapter', () => {
    it('reads the answer, prices the tokens the provider reported, writes the row, and puts the key only in the header', async () => {
        restoreCaller?.();
        restoreCaller = undefined;
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, {
            id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
            content: [{ type: 'text', text: '{"reply":"hello from the model"}' }],
            stop_reason: 'end_turn', stop_details: null,
            usage: { input_tokens: 120, output_tokens: 34, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }));
        setProviderFetch(fetchImpl);

        const out = await call();
        assert.deepEqual(out.json, { reply: 'hello from the model' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
        assert.equal(calls[0]!.headers['x-api-key'], FAKE_KEYS.anthropic);
        assert.ok(!calls[0]!.url.includes(FAKE_KEYS.anthropic) && !calls[0]!.raw.includes(FAKE_KEYS.anthropic), 'never in the URL or the body');
        assert.equal(calls[0]!.body.model, 'claude-opus-5-5');
        assert.equal(calls[0]!.body.output_config.effort, 'high');

        const row = db.usage[0]!;
        assert.deepEqual([row.outcome, row.input_tokens, row.output_tokens, row.usd], ['ok', 120, 34, (120 * 4 + 34 * 20) / 1e6]);
    });

    it('turns a 401 into an `auth` row and an error that does not contain the key, even when the provider echoes it', async () => {
        restoreCaller?.();
        restoreCaller = undefined;
        const { fetchImpl } = stubFetch(jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${FAKE_KEYS.anthropic}` } }));
        setProviderFetch(fetchImpl);
        const err = await failure(call());
        assert.equal(err.kind, 'auth');
        assertNoKey(JSON.stringify(err) + err.message + (err.stack ?? ''), 'the error');
        assert.equal(db.usage[0]!.outcome, 'auth');
        assertNoKey(JSON.stringify(db.usage) + logs.map((l) => l.line).join('\n'), 'the rows and the log');
    });
});

describe('the whole path, through the real Groq adapter', () => {
    const groqAnswer = (usage: Record<string, unknown> = { prompt_tokens: 120, completion_tokens: 34, total_tokens: 154 }) => jsonResponse(200, {
        id: 'chatcmpl-1', object: 'chat.completion', model: 'openai/gpt-oss-120b',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"hello from groq"}' } }],
        usage,
    });
    const viaGroq = (fetchImpl: ReturnType<typeof stubFetch>['fetchImpl'], effort = 'high') => {
        restoreCaller?.();
        restoreCaller = undefined;
        db.setSetting('ai.providers.groq.api_key', FAKE_KEYS.groq, true);
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'groq', model: 'openai/gpt-oss-120b', effort } }));
        setProviderFetch(fetchImpl);
    };

    it('sends the request Groq takes, keeps the caller\'s maxTokens (Groq counts it against tokens a minute), and puts the key only in the header', async () => {
        const { fetchImpl, calls } = stubFetch(groqAnswer());
        viaGroq(fetchImpl, 'xhigh');
        const out = await call({ purpose: 'dm', maxTokens: 2000 });
        assert.deepEqual(out.json, { reply: 'hello from groq' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
        assert.equal(calls[0]!.headers['authorization'], `Bearer ${FAKE_KEYS.groq}`);
        assert.ok(!calls[0]!.url.includes(FAKE_KEYS.groq) && !calls[0]!.raw.includes(FAKE_KEYS.groq), 'never in the URL or the body');
        assert.equal(calls[0]!.body.model, 'openai/gpt-oss-120b');
        assert.equal(calls[0]!.body.max_tokens, 2000, 'no floor is added: on the free tier 25 000 alone is over the 8 000 tokens a minute');
        assert.equal(calls[0]!.body.reasoning_effort, 'high', 'xhigh is sent as high');
        assert.equal(calls[0]!.body.include_reasoning, false);
        assert.ok(!('reasoning' in calls[0]!.body) && !('provider' in calls[0]!.body));
        assert.equal(calls[0]!.body.response_format.json_schema.strict, true);
        assert.deepEqual(calls[0]!.body.response_format.json_schema.schema.required, ['reply']);
    });

    it('prices a call from Groq\'s own rates in the table, because Groq reports no cost; an operator\'s price overrides them', async () => {
        const { fetchImpl } = stubFetch(groqAnswer(), groqAnswer());
        viaGroq(fetchImpl);
        const out = await call({ purpose: 'dm', maxTokens: 30_000 });
        assert.deepEqual([out.priced, out.costSource, out.usd], [true, 'table', (120 * 0.15 + 34 * 0.6) / 1e6]);
        const row = db.usage[0]!;
        assert.deepEqual([row.provider, row.model, row.outcome, row.input_tokens, row.output_tokens, row.priced, row.usd], ['groq', 'openai/gpt-oss-120b', 'ok', 120, 34, true, (120 * 0.15 + 34 * 0.6) / 1e6]);
        // A figure for the test, not Groq's.
        db.setSetting('ai.prices', JSON.stringify({ 'openai/gpt-oss-120b': { in: 1, out: 2 } }));
        const priced = await call({ purpose: 'dm', maxTokens: 30_000 });
        assert.deepEqual([priced.priced, priced.usd], [true, (120 * 1 + 34 * 2) / 1e6]);
        assert.equal(db.usage[1]!.priced, true);
    });

    it('counts a gpt-oss call against a budget at Groq\'s rate, not the table\'s ceiling, so a DM-sized call fits a small daily cap', async () => {
        const { fetchImpl, calls } = stubFetch(groqAnswer(), groqAnswer());
        viaGroq(fetchImpl);
        budgets({ 'ai.budget.daily_usd': '0.01' });
        await call({ purpose: 'dm', maxTokens: 4000 });
        await call({ purpose: 'dm', maxTokens: 4000 });
        assert.equal(calls.length, 2, 'at the ceiling ($25 a million out) 4 000 tokens would reserve $0.10, ten times this cap');
        assert.deepEqual(db.usage.map((r) => r.usd), [0.0000384, 0.0000384]);
    });

    it('turns a 498 into a retryable `server` row, and a 401 into an `auth` row with no key in the error, even when Groq echoes it', async () => {
        const { fetchImpl } = stubFetch(
            jsonResponse(498, { error: { message: 'Flex tier capacity exceeded. Retry later.', type: 'capacity_exceeded' } }, { 'retry-after': '5' }),
            jsonResponse(401, { error: { message: `Invalid API Key: ${FAKE_KEYS.groq}`, type: 'invalid_request_error', code: 'invalid_api_key' } }),
        );
        viaGroq(fetchImpl);
        const overloaded = await failure(call({ purpose: 'dm' }));
        assert.deepEqual([overloaded.kind, overloaded.retryable, overloaded.status, overloaded.retryAfterMs, overloaded.provider], ['server', true, 498, 5000, 'groq']);
        assert.equal(db.usage[0]!.outcome, 'server');
        const refused = await failure(call({ purpose: 'dm' }));
        assert.equal(refused.kind, 'auth');
        assertNoKey(JSON.stringify(refused) + refused.message + (refused.stack ?? ''), 'the error');
        assertNoKey(JSON.stringify(db.usage) + logs.map((l) => l.line).join('\n'), 'the rows and the log');
    });
});

// ─── Prompt caching (S2 of the DM plan) ───────────────────────────────────────────────────────

describe('asking for the system prompt to be cached', () => {
    it('is passed to the provider layer only when the caller asked: a call that did not ask sends exactly the arguments it always did', async () => {
        await call();
        await call({ cacheSystem: false });
        await call({ cacheSystem: true });
        assert.equal('cacheSystem' in providerCalls[0]!, false);
        assert.equal('cacheSystem' in providerCalls[1]!, false);
        assert.equal(providerCalls[2]!.cacheSystem, true);
    });

    it('records what the call read from and wrote to the cache beside its tokens, and prices them: Opus 5.5 reads at 0.05x', async () => {
        answer = () => okAnswer({ usage: { in: 200, out: 100, cacheRead: 4000 }, billed: [{ model: 'claude-opus-5-5', in: 200, out: 100, cacheRead: 4000 }] });
        const out = await call({ cacheSystem: true });
        const row = db.usage[0]!;
        assert.deepEqual(
            [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens, row.outcome],
            [200, 100, 4000, 0, 'ok']
        );
        assert.equal(row.usd, 0.0036, '200 in at $4/M, 4,000 read at $0.20/M, 100 out at $20/M');
        assert.equal(out.usd, 0.0036);
        assert.deepEqual(out.usage, { in: 200, out: 100, cacheRead: 4000 });
        assert.equal(out.billed[0]!.cacheRead, 4000);
    });

    it('prices a write at 1.25x the input price', async () => {
        answer = () => okAnswer({ usage: { in: 200, out: 100, cacheWrite: 4000 }, billed: [{ model: 'claude-opus-5-5', in: 200, out: 100, cacheWrite: 4000 }] });
        await call({ cacheSystem: true });
        const row = db.usage[0]!;
        assert.deepEqual([row.cache_read_tokens, row.cache_write_tokens], [0, 4000]);
        assert.equal(row.usd, 0.0228, '200 in at $4/M, 4,000 written at $5/M, 100 out at $20/M');
    });

    it('writes zero cache tokens for a call that cached nothing, and the UPDATE carries both columns last', async () => {
        await call();
        const row = db.usage[0]!;
        assert.deepEqual([row.cache_read_tokens, row.cache_write_tokens], [0, 0]);
        const update = db.statements.find((s) => /^UPDATE ai_usage/.test(s.sql))!;
        assert.match(update.sql, /cache_read_tokens = \$10, cache_write_tokens = \$11 WHERE id = \$1$/);
        assert.deepEqual(update.params.slice(-2), [0, 0]);
    });

    it('reads the cache counts from `usage` when a stand-in gave no per-model entries', async () => {
        answer = () => okAnswer({ billed: [], usage: { in: 10, out: 5, cacheRead: 100, cacheWrite: 50 } });
        await call();
        const row = db.usage[0]!;
        assert.deepEqual([row.input_tokens, row.cache_read_tokens, row.cache_write_tokens], [10, 100, 50]);
    });

    it('charges and records the cache tokens of an answer that was refused or cut off, as it does the others', async () => {
        answer = () => { throw new AiError({ kind: 'max_tokens', provider: 'anthropic', model: 'claude-opus-5-5', message: 'x', usage: { in: 100, out: 0, cacheRead: 2000 }, billed: [{ model: 'claude-opus-5-5', in: 100, out: 0, cacheRead: 2000 }] }); };
        await failure(call({ cacheSystem: true }));
        const row = db.usage[0]!;
        assert.deepEqual([row.outcome, row.input_tokens, row.cache_read_tokens, row.usd], ['max_tokens', 100, 2000, 0.0008]);
        // An error that carries only `usage`, with no per-model entries, loses nothing either.
        db.usage.length = 0;
        answer = () => { throw new AiError({ kind: 'refusal', provider: 'anthropic', model: 'claude-opus-5-5', message: 'x', usage: { in: 100, out: 0, cacheWrite: 1000 } }); };
        await failure(call({ cacheSystem: true }));
        assert.deepEqual([db.usage[0]!.cache_write_tokens, db.usage[0]!.usd], [1000, 0.0054]);
    });

    it('logs the cache counts under names the redactor leaves alone, and only when there were some', async () => {
        await call();
        answer = () => okAnswer({ usage: { in: 200, out: 100, cacheRead: 4000, cacheWrite: 300 }, billed: [{ model: 'claude-opus-5-5', in: 200, out: 100, cacheRead: 4000, cacheWrite: 300 }] });
        await call({ cacheSystem: true });
        const lines = logs.filter((l) => l.line.includes('"event":"ai.call"')).map((l) => JSON.parse(l.line));
        assert.ok(!('usage_cache_read' in lines[0]) && !('usage_cache_write' in lines[0]));
        assert.equal(lines[1].usage_cache_read, 4000);
        assert.equal(lines[1].usage_cache_write, 300);
    });

    it('reserves the budget for the worst case: a call that caches its system prompt is estimated as if it wrote all of it', () => {
        const args = { system: 'x'.repeat(4000), user: 'y'.repeat(1000), schema: SCHEMA };
        const plain = estimateUsd(args, 4000, 'claude-opus-5-5', {});
        const cached = estimateUsd({ ...args, cacheSystem: true }, 4000, 'claude-opus-5-5', {});
        const rest = Math.ceil((1000 + JSON.stringify(SCHEMA).length) / 2);
        assert.equal(cached.usd, Math.round(((rest * 4 + 2000 * 4 * 1.25 + 4000 * 20) / 1e6) * 1e9) / 1e9, 'the system prompt at 1.25x, the rest at the input price');
        assert.ok(cached.usd > plain.usd, 'a write costs more than sending the same tokens');
        assert.equal(estimateUsd({ ...args, cacheSystem: false }, 4000, 'claude-opus-5-5', {}).usd, plain.usd, 'asking for no cache is no different from not asking');
        assert.equal(cached.priced, true);
    });

    it('reserves that estimate before the provider is asked', async () => {
        let reserved: number | undefined;
        answer = () => { reserved = db.usage.find((u) => u.outcome === 'reserved')?.usd; return okAnswer(); };
        const args = { system: 'S'.repeat(6000), user: 'u', schema: SCHEMA };
        await call({ ...args, cacheSystem: true });
        assert.equal(reserved, estimateUsd({ ...args, cacheSystem: true }, 20_000, 'claude-opus-5-5', {}).usd);
        assert.ok(db.usage.every((u) => u.outcome === 'ok'), 'and the reservation was settled');
    });
});

describe('the `dm` purpose and the `eval` label, through generate', () => {
    it('routes `dm` at low effort when nothing is saved, and records an evaluation run as `eval` with no tenant', async () => {
        const out = await call({ purpose: 'dm', creatorId: null, usageAs: 'eval' });
        assert.equal(providerCalls[0]!.effort, 'low');
        assert.equal(out.effort, 'low');
        assert.equal(out.route, 'default');
        const row = db.usage[0]!;
        assert.deepEqual([row.purpose, row.creator_id, row.outcome], ['eval', null, 'ok']);
        assert.equal(db.usage.filter((u) => u.purpose === 'dm').length, 0, 'the run is not counted as a real DM');
    });

    it('records a real DM as `dm` for its tenant, and the owner is not refused it: it is not the Mac\'s work', async () => {
        await call({ purpose: 'dm', creatorId: OWNER });
        const row = db.usage[0]!;
        assert.deepEqual([row.purpose, row.creator_id, row.outcome], ['dm', OWNER, 'ok']);
    });

    it('uses the route saved for `dm`: its model, its effort and its price', async () => {
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } }));
        answer = (a) => okAnswer({ model: a.model, billed: [{ model: a.model, in: 1000, out: 500 }] });
        const out = await call({ purpose: 'dm', creatorId: OWNER });
        assert.equal(providerCalls[0]!.model, 'claude-sonnet-5-5');
        assert.equal(out.route, 'saved');
        assert.equal(db.usage[0]!.usd, 0.007, '1000 in at $2/M plus 500 out at $10/M');
    });

    it('prices a cached DM turn on Sonnet 5.5 at the model\'s own read rate: 0.05x of $2, so $0.10 a million', async () => {
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } }));
        answer = () => okAnswer({ model: 'claude-sonnet-5-5', usage: { in: 300, out: 200, cacheRead: 5000 }, billed: [{ model: 'claude-sonnet-5-5', in: 300, out: 200, cacheRead: 5000 }] });
        await call({ purpose: 'dm', creatorId: OWNER, cacheSystem: true });
        assert.equal(db.usage[0]!.usd, 0.0031, '300 in at $2/M, 5,000 read at $0.10/M, 200 out at $10/M');
    });

    it('is held by the budgets like any purpose: a tenant at its limit is refused a DM, and an evaluation run at the platform\'s', async () => {
        budgets({ 'ai.budget.tenant_daily_usd': '0' });
        const refused = await failure(call({ purpose: 'dm', creatorId: TENANT }));
        assert.equal(refused.kind, 'budget');
        assert.equal(providerCalls.length, 0);
        budgets({ 'ai.budget.daily_usd': '0' });
        const evalRefused = await failure(call({ purpose: 'dm', creatorId: null, usageAs: 'eval' }));
        assert.equal(evalRefused.kind, 'budget');
        assert.equal(providerCalls.length, 0);
        assert.ok(db.usage.some((u) => u.purpose === 'eval' && u.outcome === 'budget'));
    });
});

describe('naming the route for one call (the evaluation harness compares models before one is saved)', () => {
    it('answers with the named provider and model, whatever route is saved, and records the row under the label and no tenant', async () => {
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'high' } }));
        answer = (a) => okAnswer({ model: a.model, billed: [{ model: a.model, in: 1000, out: 500 }] });
        const out = await call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
        const sent = providerCalls[0]!;
        assert.deepEqual([sent.provider, sent.model, sent.apiKey, sent.effort], ['anthropic', 'claude-haiku-5-5', FAKE_KEYS.anthropic, 'low'], 'the purpose\'s default effort, not the saved route\'s');
        assert.equal(out.route, 'saved');
        const row = db.usage[0]!;
        assert.deepEqual([row.purpose, row.creator_id, row.model, row.outcome], ['eval', null, 'claude-haiku-5-5', 'ok']);
        assert.equal(row.usd, 0.00035, '1000 in at $0.10/M plus 500 out at $0.50/M: the named model\'s price');
    });

    it('takes the route\'s effort, and the call\'s own effort over it', async () => {
        await call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' } });
        assert.equal(providerCalls[0]!.effort, 'medium');
        await call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' }, effort: 'high' });
        assert.equal(providerCalls[1]!.effort, 'high');
    });

    it('does not use a provider that has no key or is switched off: no_provider, a refusal row, and no call', async () => {
        const noKey = await failure(call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: { provider: 'openai', model: 'gpt-x' } }));
        assert.equal(noKey.kind, 'no_provider');
        assert.match(noKey.message, /no API key/);
        db.setSetting('ai.providers', JSON.stringify({ anthropic: { enabled: false } }));
        const off = await failure(call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: { provider: 'anthropic', model: 'claude-haiku-5-5' } }));
        assert.equal(off.kind, 'no_provider');
        assert.equal(providerCalls.length, 0);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.outcome]), [['eval', 'no_provider'], ['eval', 'no_provider']]);
    });

    it('refuses a provider or a model that is not one, before anything is read or written', async () => {
        for (const route of [{ provider: 'nope', model: 'm' }, { provider: 'anthropic', model: '' }, { provider: 'anthropic', model: '../../x' }, { provider: 'anthropic', model: 'a b' }]) {
            const err = await failure(call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: route as never }));
            assert.equal(err.kind, 'bad_request', JSON.stringify(route));
        }
        assert.equal(providerCalls.length, 0);
        assert.equal(db.usage.length, 0);
        assert.equal(db.statements.length, 0);
    });

    it('is for a call that belongs to no tenant: a tenant\'s calls follow the operator\'s routing, and a route named for one is refused unread', async () => {
        const err = await failure(call({ purpose: 'dm', creatorId: TENANT, route: { provider: 'anthropic', model: 'claude-haiku-5-5' } }));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /belongs to no tenant/);
        assert.equal(providerCalls.length, 0);
        assert.equal(db.usage.length, 0);
        assert.equal(db.statements.length, 0);
    });

    it('is still held by the budgets', async () => {
        budgets({ 'ai.budget.daily_usd': '0' });
        const refused = await failure(call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: { provider: 'anthropic', model: 'claude-haiku-5-5' } }));
        assert.equal(refused.kind, 'budget');
        assert.equal(providerCalls.length, 0);
    });
});

describe('the whole path with the cache, through the real Anthropic adapter', () => {
    const reply = (usage: Record<string, number>) => jsonResponse(200, {
        id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: '{"reply":"hello"}' }], stop_reason: 'end_turn', stop_details: null,
        usage: { input_tokens: 120, output_tokens: 34, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
    });

    it('two evaluation runs a minute apart: the first writes the cache, the second reads it, and both are on the books', async () => {
        restoreCaller?.();
        restoreCaller = undefined;
        const { fetchImpl, calls } = stubFetch(reply({ cache_creation_input_tokens: 1800 }), reply({ cache_read_input_tokens: 1800 }));
        setProviderFetch(fetchImpl);
        const ask = () => call({ purpose: 'dm', creatorId: null, usageAs: 'eval', cacheSystem: true, system: 'SYSTEM-SENTINEL a long, stable persona. '.repeat(100) });

        await ask();
        await ask();

        for (const c of calls) {
            assert.equal(c.body.system[0].cache_control.type, 'ephemeral');
            assert.equal(c.body.output_config.effort, 'low', 'the dm route\'s effort');
            assert.equal(c.headers['x-api-key'], FAKE_KEYS.anthropic);
            assert.ok(!c.raw.includes(FAKE_KEYS.anthropic));
        }
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.cache_write_tokens, u.cache_read_tokens, u.input_tokens]), [['eval', 1800, 0, 120], ['eval', 0, 1800, 120]]);
        assert.deepEqual(db.usage.map((u) => u.usd), [0.01016, 0.00152], 'a write is $5/M and a read is $0.20/M on Opus 5.5');
        assert.ok(db.usage[1]!.usd < db.usage[0]!.usd);
    });

    it('sends no cache_control for a call that did not ask, and records zero cache tokens', async () => {
        restoreCaller?.();
        restoreCaller = undefined;
        const { fetchImpl, calls } = stubFetch(reply({}));
        setProviderFetch(fetchImpl);
        await call({ purpose: 'dm', creatorId: null, usageAs: 'eval' });
        assert.equal(typeof calls[0]!.body.system, 'string');
        assert.ok(!calls[0]!.raw.includes('cache_control'));
        assert.deepEqual([db.usage[0]!.cache_read_tokens, db.usage[0]!.cache_write_tokens], [0, 0]);
    });
});
