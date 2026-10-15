/**
 * The three tenant purposes through the REAL layer (P32): `tenant_monteur_think` (the `monteur.brain: 'api'` branch of `ask()`),
 * `tenant_infographic` (the infographic written on the server) and `tenant_studio` (`GenOptions.callModel`, plan D13).
 *
 * The router's own rules are pinned in route.test.ts and the budget's in usage.test.ts. What is pinned here is what each call site does
 * with them, end to end against the in-memory stand-in for the database (testDb.ts) and a stand-in for the provider:
 *
 *   - a tenant's call is made for that tenant, with that purpose, and leaves ONE `ai_usage` row that says so;
 *   - the prompts and the schema the layer is given are the ones the Mac would be given for the same request;
 *   - no key is a clear error, recorded, and the Mac is never asked in its place;
 *   - a spent budget refuses before the provider is asked, and only for the tenant that spent it;
 *   - the owner's Mac purposes are refused by the layer itself, so his work cannot reach it even by mistake;
 *   - the owner's Studio writer is not handed the layer.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { AiError, isAiError } from '../llm/errors.js';
import { setLlmCaller, type GenerateJsonArgs, type GenerateJsonResult } from '../llm/generate.js';
import { effectiveBrain } from '../monteur/brain.js';
import { ask, emptyCost, MonteurModelError } from '../monteur/model.js';
import { PICK_SCHEMA } from '../monteur/pick.js';
import { flattenTurns, toJsonSchema } from '../monteur/think.js';
import { contextFor } from '../profile/context.js';
import { legacyBase } from '../profile/legacy.js';
import type { GeminiSchema } from '../llm/geminiSchema.js';
import { StudioError } from '../studio/common.js';
import { writeInfographicOnServer } from '../studio/infographicWriter.js';
import { layerCallModel, NEEDS_AI_PROVIDER_MESSAGE, studioErrorFromAi, writerOptionsFor } from '../studio/tenantAi.js';
import { generate } from './generate.js';
import { MAC_BRAIN_PURPOSES, PURPOSE_DEFAULT_EFFORT, type AiPurpose } from './purposes.js';
import { MacBrainTenantRefused } from './route.js';
import { installAiDb, type AiDb } from './testDb.js';
import { assertNoKey, FAKE_KEYS } from './testKeys.js';
import { BudgetRefused } from './usage.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TENANT = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY'] as const;
const SCHEMA: GeminiSchema = { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] };

let db: AiDb;
let savedEnv: Record<string, string | undefined>;
let providerCalls: GenerateJsonArgs[];
let restoreCaller: (() => void) | undefined;
let restoreSink: (() => void) | undefined;
let logs: string[];
let answer: (args: GenerateJsonArgs) => GenerateJsonResult | Promise<GenerateJsonResult>;

const okAnswer = (json: unknown = { reply: 'ok' }, over: Partial<GenerateJsonResult> = {}): GenerateJsonResult => ({
    json, usage: { in: 1000, out: 500 }, billed: [{ model: 'claude-opus-5-5', in: 1000, out: 500 }],
    model: 'claude-opus-5-5', provider: 'anthropic', stopReason: 'end_turn', elapsed_ms: 900, ...over,
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
    const previousSink = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previousSink);
    providerCalls = [];
    answer = () => okAnswer();
    const previous = setLlmCaller(async (args) => {
        providerCalls.push(args);
        return answer(args);
    });
    restoreCaller = () => setLlmCaller(previous);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
    restoreCaller?.();
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
});

const rejection = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    return assert.fail('expected a rejection');
};

const askArgs = (creatorId: string) => ({
    purpose: 'monteur.pick', system: 'SYSTEM-SENTINEL pick the best moments', schema: PICK_SCHEMA, temperature: 0.4, thinkingBudget: 2048,
    maxOutputTokens: 8192, capMs: 120_000, turns: [{ role: 'user' as const, text: 'L1 [00:00.0] USER-SENTINEL' }, { role: 'model' as const, text: '{"clips":[]}' }, { role: 'user' as const, text: 'fix clip 2' }],
    api: { creatorId },
});
const deadline = () => Date.now() + 250_000;
const mac = () => db.statements.filter((s) => /monteur_think|INSERT INTO studio_jobs/.test(s.sql));

describe('the three purposes: what the layer does for each of them', () => {
    const efforts: Record<string, string> = { tenant_monteur_think: 'high', tenant_infographic: 'high', tenant_studio: 'medium' };

    it('names their default efforts as 06 does: the Monteur and the infographic think hard, the Studio writer at medium', () => {
        for (const [purpose, effort] of Object.entries(efforts)) assert.equal(PURPOSE_DEFAULT_EFFORT[purpose as AiPurpose], effort, purpose);
    });

    it('routes each to the first provider with a key, at that effort, and records one row for the tenant, with nothing left reserved', async () => {
        for (const purpose of ['tenant_monteur_think', 'tenant_infographic', 'tenant_studio'] as const) {
            const out = await generate({ purpose, creatorId: TENANT, system: 's', user: 'u', schema: SCHEMA, maxTokens: 20_000, timeoutMs: 60_000 });
            assert.equal(out.effort, efforts[purpose], purpose);
            assert.equal(out.route, 'default');
        }
        assert.deepEqual(providerCalls.map((c) => [c.provider, c.model, c.effort]), [
            ['anthropic', 'claude-opus-5-5', 'high'], ['anthropic', 'claude-opus-5-5', 'high'], ['anthropic', 'claude-opus-5-5', 'medium'],
        ]);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.creator_id, u.outcome]), [
            ['tenant_monteur_think', TENANT, 'ok'], ['tenant_infographic', TENANT, 'ok'], ['tenant_studio', TENANT, 'ok'],
        ]);
        assert.ok(db.usage.every((u) => u.usd === 0.014 && u.priced), 'priced from the table: 1000 in at $4/M and 500 out at $20/M');
        assert.ok(!db.usage.some((u) => u.outcome === 'reserved'));
    });

    it('a saved route for a purpose wins over the default, for that purpose alone', async () => {
        db.setSetting('ai.providers.openai.api_key', FAKE_KEYS.openai, true);
        db.setSetting('ai.routing', JSON.stringify({ tenant_studio: { provider: 'openai', model: 'gpt-x', effort: 'low' } }));
        answer = (a) => okAnswer({ reply: 'ok' }, { provider: a.provider, model: a.model, billed: [{ model: a.model, in: 10, out: 10 }], usage: { in: 10, out: 10 } });
        await generate({ purpose: 'tenant_studio', creatorId: TENANT, system: 's', user: 'u', schema: SCHEMA, maxTokens: 20_000, timeoutMs: 60_000 });
        await generate({ purpose: 'tenant_monteur_think', creatorId: TENANT, system: 's', user: 'u', schema: SCHEMA, maxTokens: 20_000, timeoutMs: 60_000 });
        assert.deepEqual(providerCalls.map((c) => [c.provider, c.model, c.effort]), [['openai', 'gpt-x', 'low'], ['anthropic', 'claude-opus-5-5', 'high']]);
    });
});

describe('ask() on the layer: tenant_monteur_think (monteur.brain = api)', () => {
    it('is made for the tenant, with the purpose, and leaves one ai_usage row that says so', async () => {
        const cost = emptyCost();
        const json = await ask(askArgs(TENANT), deadline(), cost);
        assert.deepEqual(json, { reply: 'ok' });
        assert.equal(db.usage.length, 1);
        const row = db.usage[0]!;
        assert.deepEqual([row.purpose, row.creator_id, row.provider, row.model, row.outcome, row.input_tokens, row.output_tokens], ['tenant_monteur_think', TENANT, 'anthropic', 'claude-opus-5-5', 'ok', 1000, 500]);
        assert.equal(row.usd, 0.014);
        assert.deepEqual(cost, { model: 'claude-opus-5-5', tokens_in: 1000, tokens_out: 500, thinking: 0, calls: 1 });
        assert.equal(mac().length, 0, 'nothing asked of the Mac');
    });

    it('gives the layer the same system prompt, turns and schema the Mac is queued for the same request, and the same cap', async () => {
        const req = askArgs(TENANT);
        await ask(req, deadline(), emptyCost());
        const [sent] = providerCalls;
        assert.equal(sent!.system, req.system);
        assert.deepEqual(sent!.user, req.turns, 'the turns as the step built them, the repair round included');
        assert.deepEqual(sent!.schema, PICK_SCHEMA);
        assert.ok(sent!.maxTokens >= req.maxOutputTokens);
        // What the Mac gets for it: `think()` flattens the turns and sends the schema as JSON Schema. The layer does that for a provider that needs it.
        assert.match(flattenTurns(req.turns), /USER-SENTINEL[\s\S]*Your previous answer:\n\{"clips":\[\]\}[\s\S]*fix clip 2/);
        assert.ok(toJsonSchema(PICK_SCHEMA).type === 'object');
        assert.ok(sent!.timeoutMs <= 120_000, 'the call’s own cap');
    });

    it('with no provider key is a clear no_provider error, recorded, and the Mac is not asked in its place', async () => {
        db.settings.clear();
        const err = await rejection(ask(askArgs(TENANT), deadline(), emptyCost()));
        assert.ok(isAiError(err));
        assert.equal(err.kind, 'no_provider');
        assert.match(err.message, /No AI provider is ready: save an API key for one in Operations → AI providers/);
        assert.equal(providerCalls.length, 0, 'no provider was asked');
        assert.equal(mac().length, 0, 'no Mac think was looked up or queued: there is no fallback to the owner’s Mac');
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.creator_id, u.outcome]), [['tenant_monteur_think', TENANT, 'no_provider']], 'the refusal is on the books');
    });

    it('with a saved route whose provider has no key is the same error, naming the route, never another provider', async () => {
        db.setSetting('ai.routing', JSON.stringify({ tenant_monteur_think: { provider: 'openai', model: 'gpt-x', effort: 'high' } }));
        const err = await rejection(ask(askArgs(TENANT), deadline(), emptyCost()));
        assert.ok(isAiError(err) && err.kind === 'no_provider');
        assert.match(err.message, /The route for tenant_monteur_think uses OpenAI/);
        assert.equal(providerCalls.length, 0, 'Anthropic has a key and is NOT used instead');
    });

    it('a spent tenant budget refuses before the provider is asked, for that tenant only', async () => {
        db.setSetting('ai.budget.tenant_daily_usd', '0.5');
        db.seedUsage({ usd: 0.5, at: db.now, creator_id: TENANT, purpose: 'tenant_studio' });
        const err = await rejection(ask(askArgs(TENANT), deadline(), emptyCost()));
        assert.ok(err instanceof BudgetRefused);
        assert.equal(err.kind, 'budget');
        assert.equal(err.scope, 'tenant_day');
        assert.match(err.message, /This tenant's daily AI budget is spent/);
        assert.equal(providerCalls.length, 0);
        assert.equal(mac().length, 0);

        await ask(askArgs(OTHER), deadline(), emptyCost());
        assert.equal(providerCalls.length, 1, 'another tenant’s budget is its own');
        assert.deepEqual(db.usage.at(-1) && [db.usage.at(-1)!.creator_id, db.usage.at(-1)!.outcome], [OTHER, 'ok']);
    });

    it('a failed call is charged to the tenant what it used, and the error goes up as the layer made it (retryable says whether it may pass)', async () => {
        answer = () => { throw new AiError({ kind: 'rate', provider: 'anthropic', model: 'claude-opus-5-5', status: 429, message: 'slow down' }); };
        const err = await rejection(ask(askArgs(TENANT), deadline(), emptyCost()));
        assert.ok(isAiError(err) && err.kind === 'rate' && err.retryable === true);
        assert.deepEqual(db.usage.map((u) => [u.creator_id, u.outcome]), [[TENANT, 'rate']]);
    });

    it('is refused by the layer for the owner: his Monteur work cannot reach the operator’s key, whoever routes it here', async () => {
        const err = await rejection(ask(askArgs(OWNER), deadline(), emptyCost()));
        assert.ok(err instanceof MacBrainTenantRefused);
        assert.equal(err.kind, 'bad_request');
        assert.equal(providerCalls.length, 0);
        assert.equal(db.usage.length, 0);
        assert.ok(MAC_BRAIN_PURPOSES.has('tenant_monteur_think'));
    });

    it('is refused for a tenant on studio.mac_brain_tenants too, and the same tenant is served the moment it is taken off', async () => {
        db.setSetting('studio.mac_brain_tenants', JSON.stringify([TENANT]));
        assert.ok((await rejection(ask(askArgs(TENANT), deadline(), emptyCost()))) instanceof MacBrainTenantRefused);
        db.setSetting('studio.mac_brain_tenants', '[]');
        await ask(askArgs(TENANT), deadline(), emptyCost());
        assert.equal(providerCalls.length, 1);
    });

    it('a request that names the Mac and the layer is a bug in its step: neither is asked', async () => {
        const err = await rejection(ask({ ...askArgs(TENANT), think: { creatorId: TENANT, request: 'x', step: 'pick' } }, deadline(), emptyCost()));
        assert.ok(err instanceof MonteurModelError);
        assert.match((err as Error).message, /names both the Mac and the AI providers layer/);
        assert.equal(providerCalls.length, 0);
        assert.equal(mac().length, 0);
    });

    it('does not start a call with less than the minimum time left', async () => {
        const err = await rejection(ask(askArgs(TENANT), Date.now() + 5_000, emptyCost()));
        assert.ok(err instanceof MonteurModelError);
        assert.match((err as Error).message, /Out of time before the monteur\.pick call/);
        assert.equal(providerCalls.length, 0);
    });

    it('never puts a key in a log line', async () => {
        await ask(askArgs(TENANT), deadline(), emptyCost());
        assertNoKey(logs.join('\n'), 'the logs');
    });
});

describe('which brain a stored monteur.brain really is (effectiveBrain)', () => {
    it('keeps gemini and claude_mac as they are, without reading the database', async () => {
        const before = db.statements.length;
        assert.equal(await effectiveBrain(OWNER, 'claude_mac'), 'claude_mac');
        assert.equal(await effectiveBrain(TENANT, 'gemini'), 'gemini');
        assert.equal(await effectiveBrain(OWNER, 'gemini'), 'gemini');
        assert.equal(db.statements.length, before, 'the owner’s path asks the database exactly what it always did');
    });

    it('api is the layer for a tenant the Mac is not for, and the Mac for the owner and for a tenant on the list', async () => {
        assert.equal(await effectiveBrain(TENANT, 'api'), 'api');
        assert.equal(await effectiveBrain(OWNER, 'api'), 'claude_mac');
        db.setSetting('studio.mac_brain_tenants', JSON.stringify([TENANT]));
        assert.equal(await effectiveBrain(TENANT, 'api'), 'claude_mac');
        assert.equal(await effectiveBrain(OTHER, 'api'), 'api');
    });

    it('a read that fails is an error, never a guess about which side of the rule the tenant is on', async () => {
        db.failOn(/FROM app_settings WHERE key = \$1/, new Error('connection terminated'), 1);
        await assert.rejects(effectiveBrain(TENANT, 'api'), /connection terminated/);
    });
});

describe('the Studio writer on the layer: tenant_studio, per call (D13)', () => {
    const modelRequest = (over: Record<string, unknown> = {}) => ({
        purpose: 'draft', system: 'SYSTEM-SENTINEL', turns: [{ role: 'user' as const, text: 'USER-SENTINEL' }], schema: SCHEMA, temperature: 0.7, thinkingBudget: 2048,
        timeoutMs: 120_000, maxOutputTokens: 24_576, ...over,
    });

    it('answers as callGemini does (the parsed JSON), for the tenant, as tenant_studio, and tells onUsage what it cost', async () => {
        const seen: unknown[] = [];
        const json = await layerCallModel(TENANT)(modelRequest({ onUsage: (u: unknown) => seen.push(u) }));
        assert.deepEqual(json, { reply: 'ok' });
        assert.deepEqual(seen, [{ model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 500, thinking: 0 }]);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.creator_id, u.outcome]), [['tenant_studio', TENANT, 'ok']]);
        assert.equal(providerCalls[0]!.effort, 'medium');
        assert.equal(providerCalls[0]!.system, 'SYSTEM-SENTINEL');
        assert.deepEqual(providerCalls[0]!.user, [{ role: 'user', text: 'USER-SENTINEL' }]);
    });

    it('is held to the writer’s deadline, and an error carries `retryable`, which the writer’s retry reads', async () => {
        await layerCallModel(TENANT)(modelRequest({ deadline: Date.now() + 30_000 }));
        assert.ok(providerCalls[0]!.timeoutMs <= 30_000);
        answer = () => { throw new AiError({ kind: 'server', provider: 'anthropic', model: 'm', status: 529, message: 'overloaded' }); };
        const err = await rejection(layerCallModel(TENANT)(modelRequest()));
        assert.equal((err as { retryable?: boolean }).retryable, true);
    });

    it('with no provider key is no_provider, and the Studio does not quietly go back to Gemini', async () => {
        db.settings.clear();
        const err = await rejection(layerCallModel(TENANT)(modelRequest()));
        assert.ok(isAiError(err) && err.kind === 'no_provider');
        assert.equal(providerCalls.length, 0);
    });

    it('is handed to a tenant and never to the owner: his writer is Gemini, unchanged', async () => {
        assert.deepEqual(await writerOptionsFor(OWNER), {}, 'generateDraft(input, sources, ctx, {}): the call as it was');
        const options = await writerOptionsFor(TENANT);
        assert.equal(typeof options.callModel, 'function');
        assert.deepEqual(Object.keys(options), ['callModel']);
        assert.deepEqual(await writerOptionsFor(OWNER.toUpperCase()), {}, 'whatever the case of the id');
    });

    it('with no creators at all, or an owner lookup that fails, is the call as it was: a failed read never moves the owner’s Studio', async () => {
        db.owner = null;
        assert.deepEqual(await writerOptionsFor(TENANT), {});
        db.owner = OWNER;
        db.failOn(/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/, new Error('connection terminated'), 1);
        // The owner lookup is cached for 30 s once read, so ask a fresh one.
        const { invalidateTenantCache } = await import('../tenant.js');
        invalidateTenantCache();
        assert.deepEqual(await writerOptionsFor(TENANT), {});
        assert.ok(logs.some((l) => /studio\.writer_owner_unreadable/.test(l)));
    });
});

describe('the infographic written on the server: tenant_infographic', () => {
    const ctx = contextFor(legacyBase('ar'), 'infographic', null);
    const step = (n: number) => ({ title: `خطوة ${n}`, desc: 'وصف قصير', diagram: { kind: 'chat' } });
    const column = (name: string) => ({ name, kind: 'نوع', note: 'ملاحظة', hero: { kind: 'docs', label: '10K+' }, steps: [step(1), step(2), step(3)], examples: [] });
    const ANSWER = { subtitle: 'فرق', accent: 'فرق', columns: [column('AAA'), column('BBB')], caption: 'AAA و BBB: مقارنة', review: { objections: [{ comment: 'c', reply: 'r' }, { comment: 'd', reply: 's' }] } };
    const write = (creatorId: string) => writeInfographicOnServer({ creatorId, topic: 'AAA vs BBB', notes: null, language: 'ar', avoid: [], ctx });

    it('is made for the tenant as tenant_infographic, charged to them, and gives back the spec, caption and review', async () => {
        answer = () => okAnswer(ANSWER);
        const out = await write(TENANT);
        assert.equal(out.spec.columns.length, 2);
        assert.equal(out.caption, 'AAA و BBB: مقارنة');
        assert.equal(out.review?.objections.length, 2);
        assert.deepEqual([out.provider, out.model], ['anthropic', 'claude-opus-5-5']);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.creator_id, u.outcome]), [['tenant_infographic', TENANT, 'ok']]);
        assert.equal(providerCalls[0]!.effort, 'high');
        assert.ok('json' in providerCalls[0]!.schema);
        assert.equal(mac().length, 0);
    });

    it('with no provider key is a 409 NEEDS_AI_PROVIDER that says where to fix it and that the Mac was not tried', async () => {
        db.settings.clear();
        const err = await rejection(write(TENANT));
        assert.ok(err instanceof StudioError);
        assert.deepEqual([err.status, err.code, err.message], [409, 'NEEDS_AI_PROVIDER', NEEDS_AI_PROVIDER_MESSAGE]);
        assert.equal(providerCalls.length, 0);
        assert.equal(mac().length, 0);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.outcome]), [['tenant_infographic', 'no_provider']]);
    });

    it('a spent budget is a 429 AI_BUDGET_SPENT, before the provider is asked', async () => {
        db.setSetting('ai.budget.tenant_daily_usd', '0.01');
        db.seedUsage({ usd: 0.01, at: db.now, creator_id: TENANT, purpose: 'tenant_studio' });
        const err = await rejection(write(TENANT));
        assert.ok(err instanceof StudioError);
        assert.deepEqual([err.status, err.code], [429, 'AI_BUDGET_SPENT']);
        assert.equal(providerCalls.length, 0);
    });

    it('is refused by the layer for the owner (409 MAC_BRAIN_TENANT), whoever routes it here: his infographics are written on his Mac', async () => {
        const err = await rejection(write(OWNER));
        assert.ok(err instanceof StudioError);
        assert.deepEqual([err.status, err.code], [409, 'MAC_BRAIN_TENANT']);
        assert.equal(providerCalls.length, 0);
        assert.equal(db.usage.length, 0);
    });

    it('an answer cut off, refused or malformed is a 502 the tenant can retry, and what the layer billed stays on the books', async () => {
        answer = () => { throw new AiError({ kind: 'max_tokens', provider: 'anthropic', model: 'claude-opus-5-5', message: 'cut off', usage: { in: 800, out: 16_000 }, billed: [{ model: 'claude-opus-5-5', in: 800, out: 16_000 }] }); };
        const err = await rejection(write(TENANT));
        assert.ok(err instanceof StudioError);
        assert.deepEqual([err.status, err.code], [502, 'AI_ANSWER_UNUSABLE']);
        assert.deepEqual(db.usage.map((u) => [u.creator_id, u.outcome, u.output_tokens]), [[TENANT, 'max_tokens', 16_000]]);
    });
});

describe('studioErrorFromAi: what a route says about each kind of failure', () => {
    const e = (kind: AiError['kind'], message = 'm') => new AiError({ kind, provider: 'anthropic', model: 'm', message });
    const say = (err: unknown) => { const s = studioErrorFromAi(err, 'this infographic') as StudioError; return [s.status, s.code]; };

    it('maps every kind to a status and a code a person can act on', () => {
        assert.deepEqual(say(e('no_provider')), [409, 'NEEDS_AI_PROVIDER']);
        assert.deepEqual(say(new BudgetRefused('global_day', 5, 5, '', '')), [429, 'AI_BUDGET_SPENT']);
        for (const kind of ['auth', 'quota'] as const) assert.deepEqual(say(e(kind)), [503, 'AI_PROVIDER_REJECTED'], kind);
        for (const kind of ['rate', 'server', 'timeout'] as const) assert.deepEqual(say(e(kind)), [503, 'AI_UNAVAILABLE'], kind);
        for (const kind of ['refusal', 'max_tokens', 'bad_output', 'bad_request'] as const) assert.deepEqual(say(e(kind)), [502, 'AI_ANSWER_UNUSABLE'], kind);
        assert.deepEqual(say(new MacBrainTenantRefused('tenant_infographic', OWNER)), [409, 'MAC_BRAIN_TENANT']);
    });

    it('leaves anything that is not the layer’s own error as it was: a database failure is the route’s 500, not an AI problem', () => {
        const dbError = new Error('connection terminated');
        assert.equal(studioErrorFromAi(dbError, 'x'), dbError);
        const already = new StudioError(404, 'No such infographic.');
        assert.equal(studioErrorFromAi(already, 'x'), already);
    });

    it('never carries a key: the provider’s own words are scrubbed before an AiError exists', () => {
        const err = new AiError({ kind: 'auth', provider: 'anthropic', model: 'm', message: `bad key ${FAKE_KEYS.anthropic}`, key: FAKE_KEYS.anthropic });
        assertNoKey((studioErrorFromAi(err, 'x') as StudioError).message, 'the message');
    });
});
