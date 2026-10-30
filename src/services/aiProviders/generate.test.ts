/**
 * `generate` (P20c): route, budget, call, settle. The provider is `setLlmCaller`'s stand-in unless a test says otherwise, so the layer
 * under test is the router, the reservation and the row; one test at the end runs the real Anthropic adapter against a stub `fetch`
 * to see the whole path put together. Against the in-memory stand-in for the database (testDb.ts).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { estimateUsd, generate, IMAGE_TOKENS, setAiCaller, setProviderFetch, VIDEO_TOKENS_PER_SECOND, VIDEO_TOKENS_UNKNOWN_LENGTH, type AiGenerateArgs } from './generate.js';
import { AiError, isAiError } from '../llm/errors.js';
import type { GeminiSchema } from '../llm/geminiSchema.js';
import { setLlmCaller, type GenerateJsonArgs, type GenerateJsonResult } from '../llm/generate.js';
import { AI_PURPOSES } from './purposes.js';
import { MacBrainTenantRefused } from './route.js';
import { BudgetRefused, monthStart } from './usage.js';
import { installAiDb, type AiDb } from './testDb.js';
import { jsonResponse, stubFetch } from '../llm/testFetch.js';
import { assertNoKey, FAKE_KEYS } from './testKeys.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TENANT = '44444444-4444-4444-8444-444444444444';
const SCHEMA: GeminiSchema = { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] };

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'META_MODEL_API_KEY', 'BASETEN_API_KEY', 'GEMINI_API_KEY'] as const;
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

describe('estimateUsd with pictures and video', () => {
    const base = { system: 'x'.repeat(1000), schema: SCHEMA };
    const text = 'y'.repeat(400);
    const words = estimateUsd({ ...base, user: [{ role: 'user', text }] }, 4000, 'muse-spark-1.3', {});
    const withMedia = (media: Array<{ kind: 'image' | 'video'; seconds?: number }>) => estimateUsd(
        { ...base, user: [{ role: 'user', text, media: media.map((m) => ({ ...m, mime: m.kind === 'image' ? 'image/jpeg' : 'video/mp4', base64: 'QUJD'.repeat(50_000) })) }] }, 4000, 'muse-spark-1.3', {},
    );
    /** The extra input, in tokens, an estimate carries over the same call with words alone, at Muse Spark's $1.25 a million. */
    const extraTokens = (usd: number) => Math.round(((usd - words.usd) * 1e6) / 1.25);

    it('counts a picture as about 800 tokens of input and a video as about 280 a second, and a video of unknown length as 12 000', () => {
        assert.equal(IMAGE_TOKENS, 800);
        assert.equal(VIDEO_TOKENS_PER_SECOND, 280);
        assert.equal(VIDEO_TOKENS_UNKNOWN_LENGTH, 12_000);
        assert.equal(extraTokens(withMedia([{ kind: 'image' }]).usd), 800);
        assert.equal(extraTokens(withMedia([{ kind: 'image' }, { kind: 'image' }]).usd), 1600);
        assert.equal(extraTokens(withMedia([{ kind: 'video', seconds: 37 }]).usd), 10_360);
        assert.equal(extraTokens(withMedia([{ kind: 'video' }]).usd), 12_000);
        assert.equal(extraTokens(withMedia([{ kind: 'image' }, { kind: 'video', seconds: 10 }]).usd), 800 + 2800);
    });

    it('takes a length that is not a positive number as no length: the unknown-video figure, never a free video', () => {
        for (const seconds of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
            assert.equal(extraTokens(withMedia([{ kind: 'video', seconds }]).usd), 12_000, String(seconds));
        }
    });

    it('counts tokens and not the base64: a 750 kB picture does not cost what its characters would', () => {
        const huge = withMedia([{ kind: 'image' }]);
        assert.ok(huge.usd < words.usd + 0.01, 'about 800 tokens, not 375 000');
    });

    it('is exactly the old estimate when there is no media, an empty list, or a plain string', () => {
        const plain = estimateUsd({ ...base, user: 'y'.repeat(400) }, 4000, 'muse-spark-1.3', {});
        assert.equal(plain.usd, words.usd);
        assert.equal(estimateUsd({ ...base, user: [{ role: 'user', text, media: [] }] }, 4000, 'muse-spark-1.3', {}).usd, words.usd);
        // And the figure itself: half a token a character on the system prompt, the words and the schema, plus the output cap, at Muse Spark's rates.
        const input = Math.ceil((1000 + 400 + JSON.stringify(SCHEMA).length) / 2);
        assert.equal(words.usd, (input * 1.25 + 4000 * 4.25) / 1e6);
        assert.equal(words.priced, true);
    });

    it('adds the media to the input of a call that caches its system prompt too', () => {
        const cachedWords = estimateUsd({ ...base, user: [{ role: 'user', text }], cacheSystem: true }, 4000, 'claude-opus-5-5', {});
        const cachedMedia = estimateUsd({ ...base, user: [{ role: 'user', text, media: [{ kind: 'image', mime: 'image/jpeg', base64: 'QUJD' }] }], cacheSystem: true }, 4000, 'claude-opus-5-5', {});
        assert.equal(Math.round(((cachedMedia.usd - cachedWords.usd) * 1e6) / 4), 800, 'at Opus 5.5\'s $4 a million input');
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

describe('the whole path, through the real Meta adapter', () => {
    const IMAGE = { kind: 'image' as const, mime: 'image/jpeg', base64: 'SU1BR0VCWVRFUw==' };
    const metaAnswer = (usage: Record<string, unknown> = { prompt_tokens: 15, completion_tokens: 190, total_tokens: 205, completion_tokens_details: { reasoning_tokens: 180 }, prompt_tokens_details: { cached_tokens: 0 } }) => jsonResponse(200, {
        id: 'chatcmpl-1', object: 'chat.completion', model: 'muse-spark-1.3',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"a price screenshot"}' } }],
        usage,
    });
    const viaMeta = (fetchImpl: ReturnType<typeof stubFetch>['fetchImpl'], routing: Record<string, unknown> = { perception_dm: { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' } }) => {
        restoreCaller?.();
        restoreCaller = undefined;
        db.setSetting('ai.providers.meta.api_key', FAKE_KEYS.meta, true);
        db.setSetting('ai.routing', JSON.stringify(routing));
        setProviderFetch(fetchImpl);
    };

    it('sends the request Meta takes, raises a small limit to the 4 000 floor, sends reasoning_effort, and puts the key only in the header', async () => {
        const { fetchImpl, calls } = stubFetch(metaAnswer());
        viaMeta(fetchImpl);
        const out = await call({ purpose: 'perception_dm', maxTokens: 200 });
        assert.deepEqual(out.json, { reply: 'a price screenshot' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://api.meta.ai/v1/chat/completions');
        assert.equal(calls[0]!.headers['authorization'], `Bearer ${FAKE_KEYS.meta}`);
        assert.ok(!calls[0]!.url.includes(FAKE_KEYS.meta) && !calls[0]!.raw.includes(FAKE_KEYS.meta), 'never in the URL or the body');
        assert.equal(calls[0]!.body.model, 'muse-spark-1.3');
        assert.equal(calls[0]!.body.max_tokens, 4000, 'a Test asks for 200 and Muse Spark reasons before it answers');
        assert.equal(calls[0]!.body.reasoning_effort, 'low');
        assert.equal(calls[0]!.body.response_format.json_schema.strict, true);
        assertNoKey(JSON.stringify(db.usage) + logs.map((l) => l.line).join('\n'), 'the rows and the log');
    });

    it('keeps a limit above the floor as it was given, and does not raise it twice', async () => {
        const { fetchImpl, calls } = stubFetch(metaAnswer());
        viaMeta(fetchImpl);
        await call({ purpose: 'perception_dm', maxTokens: 8000 });
        assert.equal(calls[0]!.body.max_tokens, 8000);
    });

    it('records a priced row: provider meta, the model, the tokens as returned (thinking inside the output), and dollars from the table', async () => {
        const { fetchImpl } = stubFetch(metaAnswer());
        viaMeta(fetchImpl);
        const out = await call({ purpose: 'perception_dm', maxTokens: 4000 });
        assert.deepEqual([out.priced, out.costSource, out.usd], [true, 'table', 0.00082625]);
        const row = db.usage[0]!;
        assert.deepEqual(
            [row.purpose, row.provider, row.model, row.outcome, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.priced, row.usd, row.creator_id],
            ['perception_dm', 'meta', 'muse-spark-1.3', 'ok', 15, 190, 0, true, 0.00082625, TENANT],
        );
    });

    it('records the cached part of the prompt apart from the rest, and prices it at $0.15 a million', async () => {
        const { fetchImpl } = stubFetch(metaAnswer({ prompt_tokens: 10_000, completion_tokens: 600, total_tokens: 10_600, prompt_tokens_details: { cached_tokens: 8000 } }));
        viaMeta(fetchImpl);
        const out = await call({ purpose: 'perception_dm', maxTokens: 4000 });
        assert.deepEqual(out.usage, { in: 2000, out: 600, cacheRead: 8000 });
        assert.equal(out.usd, 0.00625);
        const row = db.usage[0]!;
        assert.deepEqual([row.input_tokens, row.output_tokens, row.cache_read_tokens, row.usd], [2000, 600, 8000, 0.00625]);
        const line = JSON.parse(logs.filter((l) => l.line.includes('"event":"ai.call"'))[0]!.line);
        assert.equal(line.usage_cache_read, 8000);
    });

    it('carries a picture to Meta as a base64 data URL and charges the reservation for it, then settles at what the call cost', async () => {
        const { fetchImpl, calls } = stubFetch(metaAnswer({ prompt_tokens: 1075, completion_tokens: 564 }));
        viaMeta(fetchImpl);
        let reserved: number | undefined;
        const realFetch = fetchImpl;
        setProviderFetch(async (url, init) => { reserved = db.usage.find((u) => u.outcome === 'reserved')?.usd; return realFetch(url, init); });
        const user = [{ role: 'user' as const, text: 'The customer shared the attached image and wrote nothing with it.', media: [IMAGE] }];
        const out = await call({ purpose: 'perception_dm', maxTokens: 3000, user });
        assert.deepEqual(out.json, { reply: 'a price screenshot' });
        const content = calls[0]!.body.messages[1].content;
        assert.deepEqual(content.map((p: { type: string }) => p.type), ['text', 'image_url']);
        assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,SU1BR0VCWVRFUw==');
        assert.equal(reserved, estimateUsd({ system: 'SYSTEM-SENTINEL you write a profile.', user, schema: SCHEMA }, 4000, 'muse-spark-1.3', {}).usd, 'the reservation counted the picture, at the raised limit');
        assert.deepEqual([db.usage[0]!.outcome, db.usage[0]!.input_tokens, db.usage[0]!.output_tokens], ['ok', 1075, 564]);
        // The file is nowhere in a row or a log line.
        assert.ok(!(JSON.stringify(db.usage) + logs.map((l) => l.line).join('\n')).includes(IMAGE.base64));
    });

    it('refuses a picture for a provider that is not sent them: nothing is called, the row says bad_request, and the file is in no error', async () => {
        // `dm` takes any provider (here Anthropic, the only key), so it is the adapter that refuses: before a request exists.
        const { fetchImpl, calls } = stubFetch(metaAnswer());
        restoreCaller?.();
        restoreCaller = undefined;
        setProviderFetch(fetchImpl);
        const err = await failure(call({ purpose: 'dm', user: [{ role: 'user', text: 'see this', media: [IMAGE] }] }));
        assert.equal(err.kind, 'bad_request');
        assert.equal(calls.length, 0);
        assert.match(err.message, /Anthropic is not sent pictures or video/);
        assert.equal(db.usage[0]!.outcome, 'bad_request');
        assert.ok(!(JSON.stringify(err) + JSON.stringify(db.usage) + logs.map((l) => l.line).join('\n')).includes(IMAGE.base64));
    });

    it('answers a Muse purpose with Meta alone: with only Anthropic\'s key it is `no_provider`, a refusal row, and no call', async () => {
        const err = await failure(call({ purpose: 'perception_dm' }));
        assert.equal(err.kind, 'no_provider');
        assert.equal(providerCalls.length, 0);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.provider, u.outcome]), [['perception_dm', 'none', 'no_provider']]);
    });

    it('runs with the default pick as well, once Meta has a key and no route is saved: Meta, Muse Spark 1.3, effort low', async () => {
        db.setSetting('ai.providers.meta.api_key', FAKE_KEYS.meta, true);
        const out = await call({ purpose: 'recall' });
        const sent = providerCalls[0]!;
        assert.deepEqual([sent.provider, sent.model, sent.effort, sent.apiKey], ['meta', 'muse-spark-1.3', 'low', FAKE_KEYS.meta]);
        assert.equal(sent.maxTokens, 20_000, 'a caller\'s limit above the floor is its own');
        assert.deepEqual([out.route, out.effort], ['default', 'low']);
    });
});

describe('Baseten (Meta\'s open model), through generate: the reel indexer only', () => {
    const MODEL = 'meta-models/muse-spark-open-1026';
    const VIDEO = { kind: 'video' as const, mime: 'video/mp4', base64: 'VklERU9CWVRFUw==' };
    const OTHERS = AI_PURPOSES.filter((purpose) => purpose !== 'reel_index');
    const answerOf = (model: string, usage: Record<string, unknown> = { prompt_tokens: 5863, completion_tokens: 3371 }) => jsonResponse(200, {
        id: 'chatcmpl-1', object: 'chat.completion', model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"a reel about APIs"}', reasoning_content: 'thinking' } }],
        usage,
    });
    /** Provider calls go to the real adapters through a stub `fetch`: what is sent to Baseten is what the wire shows. */
    const viaWire = (...script: Parameters<typeof stubFetch>) => {
        restoreCaller?.();
        restoreCaller = undefined;
        const stub = stubFetch(...script);
        setProviderFetch(stub.fetchImpl);
        return stub;
    };
    const route = (routing: Record<string, unknown>) => db.setSetting('ai.routing', JSON.stringify(routing));
    beforeEach(() => db.setSetting('ai.providers.baseten.api_key', FAKE_KEYS.baseten, true));

    it('answers the reel indexer on a saved route: one POST to inference.baseten.co, the Bearer key in the header only, the video as a data URL, effort low, and a priced row of its own', async () => {
        route({ reel_index: { provider: 'baseten', model: MODEL, effort: 'low' } });
        const { calls } = viaWire(answerOf(MODEL));
        const out = await call({ purpose: 'reel_index', maxTokens: 8000, user: [{ role: 'user', text: 'Watch the whole reel.', media: [VIDEO] }] });
        assert.deepEqual(out.json, { reply: 'a reel about APIs' });
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.url, 'https://inference.baseten.co/v1/chat/completions');
        assert.equal(calls[0]!.headers['authorization'], `Bearer ${FAKE_KEYS.baseten}`);
        assert.ok(!calls[0]!.url.includes(FAKE_KEYS.baseten) && !calls[0]!.raw.includes(FAKE_KEYS.baseten), 'never in the URL or the body');
        assert.equal(calls[0]!.body.model, MODEL);
        assert.equal(calls[0]!.body.reasoning_effort, 'low');
        assert.equal(calls[0]!.body.max_tokens, 8000);
        assert.deepEqual(calls[0]!.body.messages[1].content.map((p: { type: string }) => p.type), ['text', 'video_url']);
        const row = db.usage[0]!;
        assert.deepEqual(
            [row.purpose, row.provider, row.model, row.outcome, row.input_tokens, row.output_tokens, row.priced, row.usd, row.creator_id],
            ['reel_index', 'baseten', MODEL, 'ok', 5863, 3371, true, 0.0216555, TENANT],
        );
        assert.deepEqual([out.priced, out.costSource, out.route], [true, 'table', 'saved']);
        assertNoKey(JSON.stringify(db.usage) + logs.map((l) => l.line).join('\n'), 'the rows and the log');
        assert.ok(!(JSON.stringify(db.usage) + logs.map((l) => l.line).join('\n')).includes(VIDEO.base64), 'the reel is in no row and no log line');
    });

    it('raises a small limit to the 4 000 floor, as it does for Meta: the model always reasons', async () => {
        route({ reel_index: { provider: 'baseten', model: MODEL, effort: 'low' } });
        const { calls } = viaWire(answerOf(MODEL));
        await call({ purpose: 'reel_index', maxTokens: 200 });
        assert.equal(calls[0]!.body.max_tokens, 4000);
    });

    it('is refused for EVERY other purpose on a saved route, however the call is made: `no_provider`, a refusal row, no request, and the customer\'s words are never sent', async () => {
        assert.equal(OTHERS.length, 12);
        for (const purpose of OTHERS) {
            route({ [purpose]: { provider: 'baseten', model: MODEL, effort: 'low' } });
            const { calls } = viaWire(answerOf(MODEL));
            db.usage.length = 0;
            const err = await failure(call({ purpose, creatorId: TENANT, user: 'CUSTOMER-WORDS-SENTINEL do you have a course on APIs?', system: 'SYSTEM-SENTINEL you answer customers.' }));
            assert.equal(err.kind, 'no_provider', purpose);
            assert.equal(err.retryable, false, purpose);
            assert.match(err.message, /Baseten may answer only reel_index/, purpose);
            assert.equal(calls.length, 0, `${purpose}: nothing went out`);
            assert.deepEqual(db.usage.map((u) => [u.purpose, u.provider, u.outcome, u.usd]), [[purpose, 'none', 'no_provider', 0]], purpose);
        }
        assert.ok(logs.some((l) => l.line.includes('"event":"ai.call_refused"')), 'a refusal is logged');
    });

    it('is refused when it is the only provider with a key and no route is saved: the default order never reaches it for another purpose, so there is no provider at all', async () => {
        db.settings.delete('ai.providers.anthropic.api_key');
        for (const purpose of OTHERS) {
            const { calls } = viaWire(answerOf(MODEL));
            const err = await failure(call({ purpose, creatorId: TENANT, user: 'CUSTOMER-WORDS-SENTINEL' }));
            assert.equal(err.kind, 'no_provider', purpose);
            assert.match(err.message, /No AI provider is ready/, purpose);
            assert.equal(calls.length, 0, purpose);
        }
        // And the one purpose it answers is answered by default, at its model and effort.
        const { calls } = viaWire(answerOf(MODEL));
        const out = await call({ purpose: 'reel_index' });
        assert.deepEqual([calls[0]!.url, calls[0]!.body.model, calls[0]!.body.reasoning_effort, out.route], ['https://inference.baseten.co/v1/chat/completions', MODEL, 'low', 'default']);
    });

    it('is refused for a named route too (a call that belongs to no tenant: the benchmark, the admin\'s Test): reel_index may name Baseten, every other purpose may not', async () => {
        const { calls } = viaWire(answerOf(MODEL));
        for (const purpose of OTHERS) {
            const err = await failure(call({ purpose, creatorId: null, usageAs: 'eval', route: { provider: 'baseten', model: MODEL } }));
            assert.equal(err.kind, 'no_provider', purpose);
            assert.match(err.message, /Baseten may answer only reel_index/, purpose);
        }
        assert.equal(calls.length, 0);
        const out = await call({ purpose: 'reel_index', creatorId: null, usageAs: 'eval', route: { provider: 'baseten', model: MODEL } });
        assert.equal(out.provider, 'baseten');
        assert.equal(calls.length, 1);
        assert.equal(db.usage.at(-1)!.purpose, 'eval');
    });

    it('is refused for the operator\'s Test of a route (`key_test`) for any purpose but reel_index, like any other call', async () => {
        route({ dm: { provider: 'baseten', model: MODEL, effort: 'low' } });
        const { calls } = viaWire(answerOf(MODEL));
        const err = await failure(call({ purpose: 'dm', creatorId: null, usageAs: 'key_test' }));
        assert.equal(err.kind, 'no_provider');
        assert.equal(calls.length, 0);
    });

    it('lets a tenant\'s call say who must NOT answer (`avoid`), and then Meta\'s hosted model answers the reel indexer: the move after a Baseten failure, with both calls on the books', async () => {
        db.setSetting('ai.providers.meta.api_key', FAKE_KEYS.meta, true);
        route({ reel_index: { provider: 'baseten', model: MODEL, effort: 'low' } });
        const { calls } = viaWire(
            jsonResponse(503, { error: { message: 'overloaded' } }),
            answerOf('muse-spark-1.3', { prompt_tokens: 10_475, completion_tokens: 2000 }),
        );
        const first = await failure(call({ purpose: 'reel_index', maxTokens: 8000 }));
        assert.deepEqual([first.kind, first.provider], ['server', 'baseten']);
        const second = await call({ purpose: 'reel_index', maxTokens: 8000, avoid: ['baseten'] });
        assert.deepEqual([calls[0]!.url, calls[1]!.url], ['https://inference.baseten.co/v1/chat/completions', 'https://api.meta.ai/v1/chat/completions']);
        assert.equal(calls[1]!.headers['authorization'], `Bearer ${FAKE_KEYS.meta}`);
        assert.deepEqual([second.provider, second.model, second.route], ['meta', 'muse-spark-1.3', 'default']);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.provider, u.model, u.outcome]), [
            ['reel_index', 'baseten', MODEL, 'server'],
            ['reel_index', 'meta', 'muse-spark-1.3', 'ok'],
        ]);
    });

    it('does not let `avoid` name a provider or reach Baseten: with Baseten the only key left, avoiding Meta still gives nothing for another purpose', async () => {
        const { calls } = viaWire(answerOf(MODEL));
        const err = await failure(call({ purpose: 'dm', creatorId: TENANT, avoid: ['meta', 'anthropic'] }));
        assert.equal(err.kind, 'no_provider');
        assert.equal(calls.length, 0);
    });

    it('still refuses a named route for a call that belongs to a tenant: `avoid` is the only thing a tenant\'s call may say', async () => {
        const err = await failure(call({ purpose: 'reel_index', creatorId: TENANT, route: { provider: 'baseten', model: MODEL } }));
        assert.equal(err.kind, 'bad_request');
        assert.match(err.message, /A route can be named only for a call that belongs to no tenant/);
    });
});

describe('a Contributor-mode model, through generate: Meta may train on what it is sent', () => {
    const CONTRIBUTOR = 'muse-spark-1.3-contributor';
    beforeEach(() => db.setSetting('ai.providers.meta.api_key', FAKE_KEYS.meta, true));

    it('is refused for a tenant\'s call on a saved route: `no_provider`, a refusal row, and the provider is never asked', async () => {
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'meta', model: CONTRIBUTOR, effort: 'low' } }));
        const err = await failure(call({ purpose: 'dm', creatorId: TENANT }));
        assert.equal(err.kind, 'no_provider');
        assert.match(err.message, /uses muse-spark-1\.3-contributor, a Contributor-mode model/);
        assert.equal(providerCalls.length, 0);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.provider, u.outcome, u.usd]), [['dm', 'none', 'no_provider', 0]]);
    });

    it('is refused when a call names it, whatever the label, unless the label is `eval` and the call belongs to no tenant', async () => {
        for (const over of [
            { purpose: 'dm' as const, creatorId: null, route: { provider: 'meta' as const, model: CONTRIBUTOR } },
            { purpose: 'dm' as const, creatorId: null, usageAs: 'key_test' as const, route: { provider: 'meta' as const, model: CONTRIBUTOR } },
        ]) {
            const err = await failure(call(over));
            assert.equal(err.kind, 'no_provider', JSON.stringify(over));
            assert.match(err.message, /a Contributor-mode model/);
        }
        assert.equal(providerCalls.length, 0);
    });

    it('is allowed for an evaluation of made-up cases: label `eval`, no tenant, a named route; it is recorded as `eval`, and its price is the ceiling, flagged', async () => {
        answer = (a) => okAnswer({ model: a.model, provider: 'meta', billed: [{ model: a.model, in: 1000, out: 500 }] });
        const out = await call({ purpose: 'dm', creatorId: null, usageAs: 'eval', route: { provider: 'meta', model: CONTRIBUTOR } });
        assert.equal(providerCalls[0]!.model, CONTRIBUTOR);
        assert.equal(out.priced, false, 'nobody seeded a price for a model nothing may route to');
        const row = db.usage.at(-1)!;
        assert.deepEqual([row.purpose, row.creator_id, row.model, row.outcome, row.priced], ['eval', null, CONTRIBUTOR, 'ok', false]);
    });

    it('is still refused for the Agent sandbox, which is recorded as `eval` but belongs to a tenant: a saved route cannot name one for it either', async () => {
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'meta', model: CONTRIBUTOR, effort: 'low' } }));
        const err = await failure(call({ purpose: 'dm', creatorId: TENANT, usageAs: 'eval' }));
        assert.equal(err.kind, 'no_provider');
        assert.match(err.message, /a Contributor-mode model/);
        assert.equal(providerCalls.length, 0);
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
