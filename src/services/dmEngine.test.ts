/**
 * The DM reply engine (DM plan S3): `generateDmViaLayer`, the dispatch `generateDmReply` and the failure policy.
 *
 * What is pinned, because each is a way a real customer is answered twice, answered in the wrong voice, or not answered and nothing says so:
 *
 *   - **the layer is asked for exactly what Gemini is told**: the same system text (byte for byte), the same history window, the schema
 *     Gemini answers in, purpose `dm`, the system prompt cached, and a Claude-safe conversation (starting with the user);
 *   - **the answer is coerced like Gemini's**: the same `coerceAiResponse` and `enforceMetaConstraints`, and an empty one is a failure;
 *   - **the policy is the owner's**: `gemini` is today's call and its errors still throw; `providers` that fails is answered by Gemini ONCE
 *     when the fallback is on, and otherwise (fallback off, or Gemini failing too) is a handoff stub: nothing sent, `dm.engine_failed`;
 *   - **a refused budget is a failure like any other**, through the real `generate` and the real `ai_usage` bookkeeping.
 *
 * Nothing here reaches a network or a database: `pool.query` answers on the SQL it is handed, `axios.post` is Gemini, `setAiCaller` or
 * `setProviderFetch` is the layer, and any call a test did not arrange throws.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { DEFAULT_MODEL, dmResponseSchema, dmSystemInstruction, generateAiResponse, HISTORY_WINDOW, setGeminiClock, type AiResponse, type DmContext } from './ai.js';
import {
    DM_MAX_TOKENS, DM_TIMEOUT_MS, DmEngineError, dmLlmSchema, dmTurns, failureOf, generateDmReply, generateDmViaLayer, isDmEngine, readDmEngine,
    type DmReply,
} from './dmEngine.js';
import { setAiCaller, setProviderFetch, type AiCaller, type AiGenerateArgs, type AiGenerateResult } from './aiProviders/generate.js';
import { installAiDb, type AiDb } from './aiProviders/testDb.js';
import { FAKE_KEYS } from './aiProviders/testKeys.js';
import { BudgetRefused } from './aiProviders/usage.js';
import { buildAnthropicRequest, MAX_OPTIONAL_PROPERTIES, MAX_UNION_PROPERTIES } from './llm/adapters/anthropic.js';
import { AiError } from './llm/errors.js';
import { jsonSchemaFor, schemaComplexity } from './llm/schema.js';
import { jsonResponse, stubFetch } from './llm/testFetch.js';
import { legacyContext } from './profile/context.js';

const TENANT = '33333333-3333-4333-8333-333333333333';
const OWNER = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';

/** The wording the owner is served (Gulf Arabic, the legacy context): what the live bot passes in. */
const CTX: DmContext = legacyContext('dm');
/** A second wording: an English creator who sells products. */
const CTX_EN: DmContext = {
    language: { code: 'en', register: null, digits: 'latin', dir: 'ltr' },
    who: { kind: null, role: '', niche: '', domain: 'general', offerKind: 'product' },
};

const AGENT = { is_active: true, system_prompt: 'PERSONA-SENTINEL you answer followers.', knowledge_base: 'KB-SENTINEL a price list.', model: DEFAULT_MODEL, temperature: 0.7 };

// ─── The world: SQL, Gemini, the layer, the log ────────────────────────────────────────────────────────────

interface World {
    /** The `ai_agents` row, or null for a tenant with none. `engine` and `gemini_fallback` are read from it by their own query. */
    agent: Record<string, unknown> | null;
    /** The `messages` rows as the history query returns them: newest first. */
    history: { direction: 'inbound' | 'outbound'; text: string }[];
    /** v37 not applied yet: the engine query fails like Postgres does for a missing column. */
    columnsMissing: boolean;
    /** The engine query fails for another reason. */
    engineReadError: Error | null;
}

interface GeminiCall { url: string; payload: any; config: any }

let world: World;
let statements: string[];
let geminiCalls: GeminiCall[];
let layerCalls: AiGenerateArgs[];
let logs: { level: string; event: string; [key: string]: unknown }[];
let gemini: () => Promise<any>;
let layer: (args: AiGenerateArgs) => Promise<AiGenerateResult>;
let restore: (() => void)[];
/** The layer's own `generate`, which `install` swaps for a stand-in; the integration suite puts it back. */
let realCaller: AiCaller;

const geminiSaying = (reply: Record<string, unknown>) => async () => ({
    data: { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] },
});

const layerResult = (json: unknown): AiGenerateResult => ({
    json, usage: { in: 900, out: 60, cacheRead: 800 }, billed: [{ model: 'claude-test', in: 900, out: 60 }], model: 'claude-test', provider: 'anthropic',
    stopReason: 'end_turn', elapsed_ms: 1200, usd: 0.004, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '1',
});
const layerSaying = (json: unknown) => async () => layerResult(json);

const aiError = (kind: AiError['kind'], message = `a ${kind} failure`) => new AiError({ kind, provider: 'anthropic', model: 'claude-test', message });

/** The statements this suite arranges, as `pool.query` answers them; `undefined` means "not mine" (the integration tests pass those on). */
function answer(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number } | undefined {
    const rows = (list: unknown[]) => ({ rows: list, rowCount: list.length });
    if (/^SELECT engine, gemini_fallback FROM ai_agents/.test(sql)) {
        if (world.columnsMissing) throw Object.assign(new Error('column "engine" does not exist'), { code: '42703' });
        if (world.engineReadError) throw world.engineReadError;
        return rows(world.agent ? [{ engine: world.agent.engine, gemini_fallback: world.agent.gemini_fallback }] : []);
    }
    if (/FROM ai_agents WHERE creator_id = \$1/.test(sql)) return rows(world.agent ? [world.agent] : []);
    if (/SELECT direction, text/.test(sql)) {
        assert.equal(params[1], HISTORY_WINDOW, 'the history window is the one Gemini reads');
        // A copy: the callers `.reverse()` what they are handed, and the real driver hands each call its own array.
        return rows([...world.history]);
    }
    return undefined;
}

function install(): void {
    world = { agent: { ...AGENT, engine: 'providers', gemini_fallback: true }, history: [], columnsMissing: false, engineReadError: null };
    statements = [];
    geminiCalls = [];
    layerCalls = [];
    logs = [];
    gemini = geminiSaying({ message_type: 'text', text: 'رد جيميني' });
    layer = layerSaying({ message_type: 'text', text: 'رد من المزوّد' });
    restore = [];

    const previousSink = setLogSink((level, line) => { logs.push({ level, ...JSON.parse(line) }); });
    restore.push(() => setLogSink(previousSink));

    const originalQuery = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        const mine = answer(sql, params);
        if (mine) return mine;
        if (/FROM app_settings WHERE key/.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    restore.push(() => { (pool as unknown as { query: unknown }).query = originalQuery; });

    const originalPost = axios.post;
    (axios as any).post = async (url: string, payload: any, config: any) => {
        geminiCalls.push({ url, payload, config });
        return gemini();
    };
    restore.push(() => { (axios as any).post = originalPost; });

    // Gemini's quick retry waits 0.5-1.5 s; a test that makes Gemini fail has no use for the wait.
    const realClock = setGeminiClock({ now: () => Date.now(), sleep: async () => {}, random: () => 0 });
    restore.push(() => { setGeminiClock(realClock); });

    realCaller = setAiCaller(async (args) => {
        layerCalls.push(args);
        return layer(args);
    });
    const original = realCaller;
    restore.push(() => { setAiCaller(original); });

    const key = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    restore.push(() => { if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; });
}

beforeEach(install);
afterEach(() => { for (const undo of restore.reverse()) undo(); });

const ask = (text = 'كم السعر؟', overrides?: Parameters<typeof generateDmReply>[3]): Promise<DmReply> =>
    generateDmReply(CONVERSATION, text, TENANT, overrides, CTX);

const events = (event: string) => logs.filter((l) => l.event === event);

/** The Gemini request a call made, as the one place it is visible: its URL, body, headers and timeout. */
const wire = (call: GeminiCall): string => JSON.stringify([call.url, call.payload, call.config]);

// ─── The schema ─────────────────────────────────────────────────────────────────────────────────────

describe('dmLlmSchema', () => {
    it('is the schema Gemini answers in, byte for byte, in every wording', () => {
        for (const ctx of [CTX, CTX_EN]) assert.equal(JSON.stringify(dmLlmSchema(ctx)), JSON.stringify(dmResponseSchema(ctx)));
    });

    it('is within what Anthropic\'s structured output accepts, with room to spare', () => {
        for (const ctx of [CTX, CTX_EN]) {
            const { optional, unions } = schemaComplexity(jsonSchemaFor(dmLlmSchema(ctx)));
            assert.ok(optional <= MAX_OPTIONAL_PROPERTIES, `${optional} optional properties`);
            assert.ok(unions <= MAX_UNION_PROPERTIES, `${unions} unions`);
            assert.equal(unions, 0, 'every property has one type');
        }
    });

    it('becomes a request the Anthropic adapter builds: every object closed, the reply and its type required, the system block cached', () => {
        const request = buildAnthropicRequest({
            provider: 'anthropic', apiKey: FAKE_KEYS.anthropic, model: 'claude-sonnet-5-5', system: 'SYSTEM', user: [{ role: 'user', text: 'hi' }],
            schema: dmLlmSchema(CTX_EN), maxTokens: DM_MAX_TOKENS, effort: 'low', cacheSystem: true,
        });
        const body = request.body as any;
        const schema = body.output_config.format.schema;
        assert.deepEqual(schema.required, ['message_type', 'text']);
        assert.equal(schema.additionalProperties, false);
        assert.equal(schema.properties.quick_replies.items.additionalProperties, false);
        assert.equal(schema.properties.carousel_elements.items.properties.buttons.items.additionalProperties, false);
        assert.deepEqual(schema.properties.message_type.enum, ['text', 'quick_reply', 'carousel']);
        assert.deepEqual(body.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
        assert.equal(body.messages[0].role, 'user');
    });
});

// ─── The conversation ───────────────────────────────────────────────────────────────────────────────

describe('dmTurns', () => {
    const row = (direction: 'inbound' | 'outbound', text: string) => ({ direction, text });

    it('maps inbound to user and outbound to model, oldest first', () => {
        assert.deepEqual(dmTurns([row('inbound', 'a'), row('outbound', 'b'), row('inbound', 'c')], 'c'), [
            { role: 'user', text: 'a' }, { role: 'model', text: 'b' }, { role: 'user', text: 'c' },
        ]);
    });

    it('does not repeat the message being answered when it is already the last stored row', () => {
        assert.equal(dmTurns([row('inbound', 'hello')], 'hello').length, 1);
    });

    it('appends it when it is not stored yet, or the last row is something else (the sandbox, a retry after a send)', () => {
        assert.deepEqual(dmTurns([], 'hello'), [{ role: 'user', text: 'hello' }]);
        assert.deepEqual(dmTurns([row('inbound', 'x')], 'hello'), [{ role: 'user', text: 'x' }, { role: 'user', text: 'hello' }]);
        assert.deepEqual(dmTurns([row('inbound', 'hello'), row('outbound', 'hi there')], 'hello').map((t) => t.role), ['user', 'model', 'user']);
        // The same text from the other side is not the same message.
        assert.deepEqual(dmTurns([row('outbound', 'hello')], 'hello'), [{ role: 'user', text: 'hello' }]);
    });

    it('starts with the user: Anthropic refuses a conversation that opens with the model, and a window of eight can', () => {
        const turns = dmTurns([row('outbound', 'old reply'), row('outbound', 'older reply'), row('inbound', 'question')], 'question');
        assert.deepEqual(turns, [{ role: 'user', text: 'question' }]);
    });

    it('drops a turn with no text, which Anthropic refuses and Gemini only wastes a part on', () => {
        const turns = dmTurns([row('inbound', 'a'), row('outbound', '  '), row('inbound', '')], 'next');
        assert.deepEqual(turns, [{ role: 'user', text: 'a' }, { role: 'user', text: 'next' }]);
    });
});

// ─── The call the layer gets ────────────────────────────────────────────────────────────────────────

describe('generateDmViaLayer — what the layer is asked', () => {
    it('purpose dm for the tenant, the same system text Gemini is sent, the schema, the cached system block and the DM deadline', async () => {
        // Newest first, as the query returns it.
        world.history = [{ direction: 'inbound', text: 'كم السعر؟' }, { direction: 'outbound', text: 'أهلاً بك' }, { direction: 'inbound', text: 'مرحبا' }];
        const reply = await generateDmViaLayer(CONVERSATION, 'كم السعر؟', TENANT, undefined, CTX);

        assert.equal(layerCalls.length, 1);
        const call = layerCalls[0]!;
        assert.equal(call.purpose, 'dm');
        assert.equal(call.creatorId, TENANT);
        assert.equal(call.usageAs, undefined, 'a real customer is a `dm` row in ai_usage, not an `eval` one');
        assert.equal(call.system, dmSystemInstruction(AGENT.system_prompt, AGENT.knowledge_base, CTX), 'the persona, the knowledge base and the rules, byte for byte');
        assert.equal(JSON.stringify(call.schema), JSON.stringify(dmResponseSchema(CTX)));
        assert.equal(call.cacheSystem, true);
        assert.equal(call.timeoutMs, DM_TIMEOUT_MS);
        assert.equal(call.maxTokens, DM_MAX_TOKENS);
        assert.deepEqual(call.user, [{ role: 'user', text: 'مرحبا' }, { role: 'model', text: 'أهلاً بك' }, { role: 'user', text: 'كم السعر؟' }]);
        assert.deepEqual(reply, { message_type: 'text', text: 'رد من المزوّد' });
    });

    it('reads the same history window as Gemini does, and orders it oldest first', async () => {
        // The query returns newest first (ORDER BY created_at DESC LIMIT 8); the call must hand the layer the conversation in order.
        world.history = [
            { direction: 'inbound', text: 'third' }, { direction: 'outbound', text: 'second' }, { direction: 'inbound', text: 'first' },
        ];
        await generateDmViaLayer(CONVERSATION, 'third', TENANT, undefined, CTX);
        assert.deepEqual(layerCalls[0]!.user, [{ role: 'user', text: 'first' }, { role: 'model', text: 'second' }, { role: 'user', text: 'third' }]);
        assert.ok(statements.some((s) => /ORDER BY created_at DESC LIMIT \$2/.test(s)));
    });

    it('speaks the English wording to an English creator: the rules and the schema follow the context, as on the Gemini path', async () => {
        await generateDmViaLayer(CONVERSATION, 'how much?', TENANT, undefined, CTX_EN);
        const call = layerCalls[0]!;
        assert.equal(call.system, dmSystemInstruction(AGENT.system_prompt, AGENT.knowledge_base, CTX_EN));
        assert.match(JSON.stringify(call.schema), /Must be written in English if appropriate\./);
    });

    it('substitutes the sandbox\'s draft for the saved prompt and knowledge base, and labels the spend `eval`', async () => {
        await generateDmViaLayer(CONVERSATION, 'hi', TENANT, { system_prompt: 'DRAFT-PERSONA', knowledge_base: 'DRAFT-KB' }, CTX);
        const call = layerCalls[0]!;
        assert.equal(call.system, dmSystemInstruction('DRAFT-PERSONA', 'DRAFT-KB', CTX));
        assert.equal(call.usageAs, 'eval');
        assert.equal(call.creatorId, TENANT, 'still the tenant\'s: its budget bounds a test loop');
    });

    it('ignores the Gemini model and temperature: the route decides the provider, model and effort', async () => {
        await generateDmViaLayer(CONVERSATION, 'hi', TENANT, { model: 'gemini-3.8-flash', temperature: 0 }, CTX);
        const call = layerCalls[0]!;
        assert.equal((call as any).model, undefined);
        assert.equal((call as any).temperature, undefined);
        assert.equal(call.effort, undefined, 'the route\'s effort (low for dm)');
    });

    it('never calls Gemini, and never reads the Gemini key', async () => {
        await generateDmViaLayer(CONVERSATION, 'hi', TENANT, undefined, CTX);
        assert.equal(geminiCalls.length, 0);
        assert.ok(!statements.some((s) => /FROM app_settings/.test(s)));
    });
});

describe('generateDmViaLayer — whether to speak at all', () => {
    it('says nothing for a switched-off agent, without asking the layer', async () => {
        world.agent = { ...AGENT, is_active: false, engine: 'providers', gemini_fallback: true };
        assert.equal(await generateDmViaLayer(CONVERSATION, 'hi', TENANT, undefined, CTX), null);
        assert.equal(layerCalls.length, 0);
    });

    it('says nothing for a tenant with no agent row, and warns', async () => {
        world.agent = null;
        assert.equal(await generateDmViaLayer(CONVERSATION, 'hi', TENANT, undefined, CTX), null);
        assert.equal(layerCalls.length, 0);
        assert.equal(events('ai.unconfigured')[0]?.level, 'warn');
    });

    it('still answers the sandbox with no agent saved, or a switched-off one: trying a prompt before switching on is the point', async () => {
        world.agent = null;
        assert.ok(await generateDmViaLayer(CONVERSATION, 'hi', TENANT, {}, CTX));
        world.agent = { ...AGENT, is_active: false };
        assert.ok(await generateDmViaLayer(CONVERSATION, 'hi', TENANT, {}, CTX));
        assert.equal(layerCalls.length, 2);
    });
});

// ─── The answer ─────────────────────────────────────────────────────────────────────────────────────

describe('generateDmViaLayer — what comes back is coerced as Gemini\'s is', () => {
    const through = async (json: unknown): Promise<AiResponse | null> => {
        layer = layerSaying(json);
        return generateDmViaLayer(CONVERSATION, 'hi', TENANT, undefined, CTX);
    };

    it('cuts a reply to Meta\'s limits: 1000 characters of text, 20 of a quick reply title, 13 quick replies', async () => {
        const reply = await through({
            message_type: 'quick_reply', text: 'ا'.repeat(1500),
            quick_replies: Array.from({ length: 15 }, (_, i) => ({ title: `t${i}-`.padEnd(40, 'x'), payload: `P${i}` })),
        });
        assert.equal(reply?.text.length, 1000);
        assert.equal(reply?.quick_replies?.length, 13);
        assert.ok(reply?.quick_replies?.every((qr) => qr.title.length === 20));
    });

    it('cuts a carousel to ten cards, 80-character titles and three buttons a card', async () => {
        const reply = await through({
            message_type: 'carousel', text: 'اختر',
            carousel_elements: Array.from({ length: 12 }, () => ({
                title: 'x'.repeat(120), subtitle: 'y'.repeat(120),
                buttons: Array.from({ length: 5 }, () => ({ type: 'postback', title: 'z'.repeat(40), payload: 'GO' })),
            })),
        });
        assert.equal(reply?.carousel_elements?.length, 10);
        assert.equal(reply?.carousel_elements?.[0]?.title.length, 80);
        assert.equal(reply?.carousel_elements?.[0]?.subtitle?.length, 80);
        assert.equal(reply?.carousel_elements?.[0]?.buttons?.length, 3);
        assert.equal(reply?.carousel_elements?.[0]?.buttons?.[0]?.title.length, 20);
    });

    it('downgrades a carousel with no cards, or a quick reply with no buttons, to the plain text the model wrote', async () => {
        assert.deepEqual(await through({ message_type: 'carousel', text: 'اختر من التالي' }), { message_type: 'text', text: 'اختر من التالي' });
        assert.deepEqual(await through({ message_type: 'quick_reply', text: 'نعم أو لا؟' }), { message_type: 'text', text: 'نعم أو لا؟' });
        assert.deepEqual(await through({ message_type: 'sticker', text: 'أهلا' }), { message_type: 'text', text: 'أهلا' });
    });

    it('coerces a numeric text rather than throwing on it', async () => {
        assert.equal((await through({ message_type: 'text', text: 42 }))?.text, '42');
    });

    it('treats a reply with no usable text as a failure, never as a message to send', async () => {
        for (const json of [{ message_type: 'text', text: '' }, { message_type: 'text', text: '   ' }, { message_type: 'text' }, { message_type: 'text', text: { nested: true } }]) {
            layer = layerSaying(json);
            await assert.rejects(generateDmViaLayer(CONVERSATION, 'hi', TENANT, undefined, CTX), (err: unknown) => err instanceof DmEngineError && err.reason === 'empty_reply', JSON.stringify(json));
        }
    });

    it('lets a carousel with no text through, as Gemini\'s path does: the text is only the disclosure\'s standalone line', async () => {
        const reply = await through({ message_type: 'carousel', text: '', carousel_elements: [{ title: 'a' }] });
        assert.equal(reply?.message_type, 'carousel');
    });
});

// ─── The engine setting ─────────────────────────────────────────────────────────────────────────────

describe('readDmEngine', () => {
    it('reads the engine and the fallback switch of the tenant\'s agent', async () => {
        world.agent = { ...AGENT, engine: 'providers', gemini_fallback: false };
        assert.deepEqual(await readDmEngine(TENANT), { engine: 'providers', geminiFallback: false });
        world.agent = { ...AGENT, engine: 'gemini', gemini_fallback: true };
        assert.deepEqual(await readDmEngine(TENANT), { engine: 'gemini', geminiFallback: true });
    });

    it('is today\'s behaviour for a tenant with no agent, and for a row that says nothing', async () => {
        world.agent = null;
        assert.deepEqual(await readDmEngine(TENANT), { engine: 'gemini', geminiFallback: true });
        world.agent = { ...AGENT };
        assert.deepEqual(await readDmEngine(TENANT), { engine: 'gemini', geminiFallback: true });
    });

    it('is today\'s behaviour for a value it does not know, rather than an engine nobody chose', async () => {
        for (const engine of ['claude', '', null, 7, 'PROVIDERS']) {
            world.agent = { ...AGENT, engine, gemini_fallback: true };
            assert.equal((await readDmEngine(TENANT)).engine, 'gemini', String(engine));
        }
    });

    it('survives a database that has not had v37 applied (the columns are missing): Gemini, today\'s call, and a warning', async () => {
        world.columnsMissing = true;
        assert.deepEqual(await readDmEngine(TENANT), { engine: 'gemini', geminiFallback: true });
        assert.equal(events('dm.engine_read_failed').length, 1);
        assert.equal(events('dm.engine_read_failed')[0]?.level, 'warn');
    });

    it('and a read that fails for any other reason', async () => {
        world.engineReadError = new Error('connection terminated');
        assert.equal((await readDmEngine(TENANT)).engine, 'gemini');
    });

    it('knows its two engines', () => {
        assert.equal(isDmEngine('gemini'), true);
        assert.equal(isDmEngine('providers'), true);
        for (const other of ['claude', '', undefined, null, 1, {}]) assert.equal(isDmEngine(other), false);
    });
});

// ─── The dispatch ───────────────────────────────────────────────────────────────────────────────────

describe('generateDmReply — the gemini engine is today\'s call', () => {
    beforeEach(() => { world.agent = { ...AGENT, engine: 'gemini', gemini_fallback: true }; });

    it('asks Gemini and nothing else: the layer is never called', async () => {
        const reply = await ask();
        assert.deepEqual(reply, { kind: 'reply', response: { message_type: 'text', text: 'رد جيميني' }, engine: 'gemini' });
        assert.equal(geminiCalls.length, 1);
        assert.equal(layerCalls.length, 0);
    });

    it('lets a Gemini failure through as the error it always was, for the pipeline\'s retry rules: no fallback, no stub', async () => {
        gemini = async () => { throw Object.assign(new Error('overloaded'), { response: { status: 503, data: { error: { message: 'model overloaded' } } } }); };
        await assert.rejects(ask(), /Gemini request failed \[HTTP 503\]/);
        // A 503 is Gemini's overload: `generateAiResponse` retries it once, quickly, inside its own 30 s budget (ai.ts, `postToGemini`).
        // Nothing above that call retries it: not the engine, which is the contract this test holds.
        assert.equal(geminiCalls.length, 2, 'retried once inside the Gemini call, and by nothing else');
        assert.equal(layerCalls.length, 0, 'and the other engine is not tried instead');
        assert.equal(events('dm.engine_failed').length, 0);
    });

    it('says nothing for a switched-off agent', async () => {
        world.agent = { ...AGENT, is_active: false, engine: 'gemini', gemini_fallback: true };
        assert.deepEqual(await ask(), { kind: 'off' });
        assert.equal(geminiCalls.length, 0);
    });

    it('sends Gemini the request it sends without this engine in the picture, byte for byte', async () => {
        world.history = [{ direction: 'inbound', text: 'كم السعر؟' }];
        await ask();
        const viaDispatch = geminiCalls[0]!;
        geminiCalls = [];
        await generateAiResponse(CONVERSATION, 'كم السعر؟', TENANT, undefined, CTX);
        assert.equal(wire(viaDispatch), wire(geminiCalls[0]!));
    });
});

describe('generateDmReply — the providers engine', () => {
    it('answers through the layer and never asks Gemini: exactly one reply', async () => {
        const reply = await ask();
        assert.deepEqual(reply, { kind: 'reply', response: { message_type: 'text', text: 'رد من المزوّد' }, engine: 'providers' });
        assert.equal(layerCalls.length, 1);
        assert.equal(geminiCalls.length, 0);
        assert.equal(events('dm.engine_fallback').length + events('dm.engine_failed').length, 0);
    });

    it('says nothing for a switched-off agent, without a fallback to Gemini: off is a decision, not a failure', async () => {
        world.agent = { ...AGENT, is_active: false, engine: 'providers', gemini_fallback: true };
        assert.deepEqual(await ask(), { kind: 'off' });
        assert.equal(layerCalls.length, 0);
        assert.equal(geminiCalls.length, 0);
    });

    it('takes the sandbox\'s on-screen engine over the saved one, and its fallback switch over the saved switch', async () => {
        world.agent = { ...AGENT, engine: 'gemini', gemini_fallback: true };
        const picked = await ask('hi', { engine: 'providers' });
        assert.equal(picked.kind === 'reply' && picked.engine, 'providers');
        assert.equal(geminiCalls.length, 0);

        world.agent = { ...AGENT, engine: 'providers', gemini_fallback: true };
        layer = async () => { throw aiError('server'); };
        const noFallback = await ask('hi', { gemini_fallback: false });
        assert.equal(noFallback.kind, 'handoff', 'the switch on screen is off');
        assert.equal(geminiCalls.length, 0);

        const gemini = await ask('hi', { engine: 'gemini' });
        assert.equal(gemini.kind === 'reply' && gemini.engine, 'gemini');
    });

    it('hands Gemini only the sandbox\'s own fields: the engine\'s are not its to see, and `overrides` still means "the sandbox"', async () => {
        world.agent = { ...AGENT, engine: 'gemini', gemini_fallback: true, is_active: false };
        // A switched-off agent is silent for a customer and answers the sandbox: the only difference is that `overrides` is present.
        assert.deepEqual(await ask('hi'), { kind: 'off' });
        const sandbox = await ask('hi', { engine: 'gemini', gemini_fallback: false, temperature: 0 });
        assert.equal(sandbox.kind, 'reply');
        assert.equal(geminiCalls[0]!.payload.generationConfig.temperature, 0);
    });
});

describe('generateDmReply — a providers failure is answered by Gemini, once, when the fallback is on', () => {
    // Every way the layer can say no: no key, no route, a provider outage, a timeout, a spent budget, and the rest of the taxonomy.
    const KINDS: AiError['kind'][] = ['no_provider', 'budget', 'timeout', 'server', 'rate', 'quota', 'auth', 'bad_request', 'refusal', 'max_tokens', 'bad_output'];

    for (const kind of KINDS) {
        it(`${kind}: Gemini answers, one reply, and the log says why`, async () => {
            layer = async () => { throw aiError(kind); };
            const reply = await ask();

            assert.equal(reply.kind, 'reply');
            assert.equal(reply.kind === 'reply' && reply.engine, 'gemini');
            assert.equal(reply.kind === 'reply' && reply.fellBackFrom?.reason, kind);
            assert.equal(reply.kind === 'reply' && reply.response.text, 'رد جيميني');
            assert.equal(layerCalls.length, 1, 'the layer is tried once');
            assert.equal(geminiCalls.length, 1, 'and Gemini once');
            assert.equal(events('dm.engine_fallback').length, 1);
            assert.equal(events('dm.engine_fallback')[0]?.reason, kind);
            assert.equal(events('dm.engine_failed').length, 0, 'something answered, so nothing failed');
        });
    }

    it('a failure that is not an AiError at all (the settings read, a bug) is a failure too: `unexpected`', async () => {
        layer = async () => { throw new TypeError('x is undefined'); };
        const reply = await ask();
        assert.equal(reply.kind === 'reply' && reply.fellBackFrom?.reason, 'unexpected');
        assert.equal(geminiCalls.length, 1);
    });

    it('an answer with no usable text is a failure of the engine, answered by Gemini', async () => {
        layer = layerSaying({ message_type: 'text', text: '' });
        const reply = await ask();
        assert.equal(reply.kind === 'reply' && reply.fellBackFrom?.reason, 'empty_reply');
        assert.equal(geminiCalls.length, 1);
    });

    it('the Gemini that answers is asked exactly as the Gemini engine asks it', async () => {
        layer = async () => { throw aiError('timeout'); };
        world.history = [{ direction: 'inbound', text: 'كم السعر؟' }];
        await ask('كم السعر؟');
        const viaFallback = geminiCalls[0]!;
        geminiCalls = [];
        await generateAiResponse(CONVERSATION, 'كم السعر؟', TENANT, undefined, CTX);
        assert.equal(wire(viaFallback), wire(geminiCalls[0]!));
    });
});

describe('generateDmReply — otherwise the result is a handoff stub: nothing to send', () => {
    it('with the fallback off, Gemini is never asked: the stub, and `dm.engine_failed` with the reason', async () => {
        world.agent = { ...AGENT, engine: 'providers', gemini_fallback: false };
        layer = async () => { throw aiError('no_provider', 'No AI provider is ready.'); };
        const reply = await ask();

        assert.equal(reply.kind, 'handoff');
        assert.equal(reply.kind === 'handoff' && reply.failure.reason, 'no_provider');
        assert.equal(geminiCalls.length, 0);
        const [failed] = events('dm.engine_failed');
        assert.equal(failed?.level, 'error');
        assert.equal(failed?.reason, 'no_provider');
        assert.equal(failed?.fallback, 'off');
        assert.equal(failed?.creator_id, TENANT);
        assert.equal(events('dm.engine_fallback').length, 0);
    });

    it('with the fallback on and Gemini failing too: the stub, both reasons logged, one try of the layer and no third of Gemini', async () => {
        layer = async () => { throw aiError('server', 'Anthropic is down.'); };
        gemini = async () => { throw Object.assign(new Error('quota'), { response: { status: 429, data: { error: { message: 'quota exceeded' } } } }); };
        const reply = await ask();

        assert.equal(reply.kind, 'handoff');
        assert.equal(reply.kind === 'handoff' && reply.failure.reason, 'server');
        assert.match(reply.kind === 'handoff' ? reply.fallbackFailure?.message ?? '' : '', /Gemini request failed \[HTTP 429\]/);
        assert.equal(layerCalls.length, 1);
        // The 429 is retried once inside the Gemini call (ai.ts, `postToGemini`); the fallback does not ask a third time.
        assert.equal(geminiCalls.length, 2);
        const [failed] = events('dm.engine_failed');
        assert.equal(failed?.reason, 'server');
        assert.equal(failed?.fallback, 'failed');
        assert.match(String(failed?.fallback_message), /HTTP 429/);
    });

    it('with the fallback on and no Gemini key anywhere: the stub, not a crash', async () => {
        delete process.env.GEMINI_API_KEY;
        layer = async () => { throw aiError('auth'); };
        const reply = await ask();
        assert.equal(reply.kind, 'handoff');
        assert.match(String(events('dm.engine_failed')[0]?.fallback_message), /Gemini API key/i);
    });

    it('carries no reply at all, so there is nothing for the pipeline to send', async () => {
        world.agent = { ...AGENT, engine: 'providers', gemini_fallback: false };
        layer = async () => { throw aiError('timeout'); };
        const reply = await ask();
        assert.deepEqual(Object.keys(reply).sort(), ['engine', 'failure', 'kind']);
    });

    it('never writes the key, the prompt or the customer\'s words to the log', async () => {
        world.agent = { ...AGENT, engine: 'providers', gemini_fallback: false };
        layer = async () => { throw new Error(`boom with ${FAKE_KEYS.anthropic} inside`); };
        await ask('PRIVATE-CUSTOMER-WORDS');
        const text = JSON.stringify(logs);
        assert.ok(!text.includes(FAKE_KEYS.anthropic), 'the key');
        assert.ok(!text.includes('PRIVATE-CUSTOMER-WORDS'), 'the customer');
        assert.ok(!text.includes('PERSONA-SENTINEL'), 'the persona');
    });
});

describe('failureOf', () => {
    it('keeps an AiError\'s kind and its already-scrubbed message', () => {
        assert.deepEqual(failureOf(aiError('budget', 'The tenant is over budget.')), { reason: 'budget', message: 'The tenant is over budget.' });
    });

    it('names the engine\'s own empty-reply failure, and scrubs anything else of a key', () => {
        assert.equal(failureOf(new DmEngineError('empty_reply', 'no text')).reason, 'empty_reply');
        const other = failureOf(new Error(`failed with ${FAKE_KEYS.anthropic}`));
        assert.equal(other.reason, 'unexpected');
        assert.ok(!other.message.includes(FAKE_KEYS.anthropic));
        assert.equal(failureOf('a string').reason, 'unexpected');
    });
});

// ─── The real layer: routing, budgets and the request on the wire ──────────────────────────────────────────

describe('through the real layer: route, budget and the request Anthropic gets', () => {
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
        // The outer `install` already ran: put the real `generate` back, and lay the in-memory database for the layer's tables under
        // the agent and history statements. `installAiDb` replaces `pool.query`, so this suite's answers go on top of it.
        setAiCaller(realCaller);
        for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY']) { savedEnv[name] = process.env[name]; delete process.env[name]; }
        const outer = pool.query;
        db = installAiDb({ owner: OWNER });
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        const layerDb = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            const mine = answer(sql, params);
            return mine ?? (layerDb as unknown as (s: string, p?: unknown[]) => Promise<unknown>).call(pool, sql, params);
        };
        restore.push(() => {
            db.restore();
            (pool as unknown as { query: unknown }).query = outer;
            setProviderFetch(undefined);
            for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY']) {
                if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
            }
        });
    });

    const anthropicSaying = (reply: Record<string, unknown>) => jsonResponse(200, {
        id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn', stop_details: null,
        usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 1800, cache_read_input_tokens: 0 },
    });

    it('sends Anthropic the persona as a cached system block, the conversation starting with the user, the schema, effort low; records a `dm` row', async () => {
        const { fetchImpl, calls } = stubFetch(anthropicSaying({ message_type: 'text', text: 'رد كلود' }));
        setProviderFetch(fetchImpl);
        world.history = [{ direction: 'inbound', text: 'كم السعر؟' }, { direction: 'outbound', text: 'أهلاً' }, { direction: 'inbound', text: 'مرحبا' }];

        const reply = await ask('كم السعر؟');

        assert.equal(reply.kind === 'reply' && reply.response.text, 'رد كلود');
        assert.equal(calls.length, 1);
        const body = calls[0]!.body;
        assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages');
        assert.deepEqual(body.system, [{ type: 'text', text: dmSystemInstruction(AGENT.system_prompt, AGENT.knowledge_base, CTX), cache_control: { type: 'ephemeral' } }]);
        assert.deepEqual(body.messages, [
            { role: 'user', content: 'مرحبا' }, { role: 'assistant', content: 'أهلاً' }, { role: 'user', content: 'كم السعر؟' },
        ]);
        assert.equal(body.output_config.effort, 'low');
        assert.deepEqual(body.output_config.format.schema.required, ['message_type', 'text']);
        assert.ok(body.max_tokens >= DM_MAX_TOKENS);
        assert.ok(!calls[0]!.raw.includes(FAKE_KEYS.anthropic));

        assert.equal(db.usage.length, 1);
        const row = db.usage[0]!;
        assert.deepEqual([row.purpose, row.creator_id, row.provider, row.outcome, row.cache_write_tokens], ['dm', TENANT, 'anthropic', 'ok', 1800]);
        assert.equal(geminiCalls.length, 0);
    });

    describe('with the `dm` route saved to Groq', () => {
        const groqSaying = (reply: Record<string, unknown>) => jsonResponse(200, {
            id: 'chatcmpl-1', object: 'chat.completion', model: 'openai/gpt-oss-120b',
            choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }],
            usage: { prompt_tokens: 2100, completion_tokens: 140, total_tokens: 2240 },
        });
        beforeEach(() => {
            db.setSetting('ai.providers.groq.api_key', FAKE_KEYS.groq, true);
            db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low' } }));
        });

        it('sends gpt-oss the persona as the system message and the conversation, the strict schema, effort low and the DM\'s own token limit; records a `dm` row on groq', async () => {
            const { fetchImpl, calls } = stubFetch(groqSaying({ message_type: 'text', text: 'رد من جروك' }));
            setProviderFetch(fetchImpl);
            world.history = [{ direction: 'inbound', text: 'كم السعر؟' }, { direction: 'outbound', text: 'أهلاً' }, { direction: 'inbound', text: 'مرحبا' }];

            const reply = await ask('كم السعر؟');

            assert.equal(reply.kind === 'reply' && reply.engine, 'providers');
            assert.equal(reply.kind === 'reply' && reply.response.text, 'رد من جروك');
            assert.equal(calls.length, 1);
            const body = calls[0]!.body;
            assert.equal(calls[0]!.url, 'https://api.groq.com/openai/v1/chat/completions');
            assert.equal(calls[0]!.headers['authorization'], `Bearer ${FAKE_KEYS.groq}`);
            assert.deepEqual(body.messages, [
                { role: 'system', content: dmSystemInstruction(AGENT.system_prompt, AGENT.knowledge_base, CTX) },
                { role: 'user', content: 'مرحبا' }, { role: 'assistant', content: 'أهلاً' }, { role: 'user', content: 'كم السعر؟' },
            ]);
            assert.equal(body.reasoning_effort, 'low');
            assert.equal(body.include_reasoning, false);
            assert.equal(body.response_format.type, 'json_schema');
            assert.equal(body.response_format.json_schema.strict, true);
            const schema = body.response_format.json_schema.schema;
            assert.equal(schema.additionalProperties, false);
            assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), 'strict mode lists every property as required');
            assert.equal(body.max_tokens, DM_MAX_TOKENS, 'not raised: Groq counts max_tokens against the free tier\'s 8 000 tokens a minute');
            assert.ok(!('reasoning' in body) && !('provider' in body));
            assert.ok(!calls[0]!.raw.includes('cache_control'), 'Anthropic\'s cache marker is not sent to anyone else');
            assert.ok(!calls[0]!.raw.includes(FAKE_KEYS.groq));

            assert.equal(db.usage.length, 1);
            const row = db.usage[0]!;
            assert.deepEqual([row.purpose, row.creator_id, row.provider, row.model, row.outcome, row.priced], ['dm', TENANT, 'groq', 'openai/gpt-oss-120b', 'ok', true]);
            assert.equal(row.usd, (2100 * 0.15 + 140 * 0.6) / 1e6, 'Groq\'s paid rate from the table (a free-tier call costs nothing)');
            assert.equal(geminiCalls.length, 0);
        });

        it('a Groq 498 (the flex tier is out of capacity) is `server`: Gemini answers once, and the call is on the books as a failed one', async () => {
            const { fetchImpl, calls } = stubFetch(jsonResponse(498, { error: { message: 'Flex tier capacity exceeded.', type: 'capacity_exceeded' } }));
            setProviderFetch(fetchImpl);

            const reply = await ask();

            assert.equal(calls.length, 1);
            assert.equal(reply.kind === 'reply' && reply.fellBackFrom?.reason, 'server');
            assert.equal(geminiCalls.length, 1);
            assert.deepEqual(db.usage.map((u) => [u.purpose, u.provider, u.outcome]), [['dm', 'groq', 'server']]);
        });
    });

    it('the sandbox is `eval` in ai_usage, still charged to the tenant', async () => {
        const { fetchImpl } = stubFetch(anthropicSaying({ message_type: 'text', text: 'تجربة' }));
        setProviderFetch(fetchImpl);
        await ask('hi', { system_prompt: 'DRAFT' });
        assert.deepEqual([db.usage[0]!.purpose, db.usage[0]!.creator_id], ['eval', TENANT]);
    });

    it('a refused budget is a failure: the provider is never asked, the refusal is on the books, and Gemini answers once (fallback on)', async () => {
        db.setSetting('ai.budget.tenant_daily_usd', '0');
        const { fetchImpl, calls } = stubFetch();
        setProviderFetch(fetchImpl);

        const reply = await ask();

        assert.equal(calls.length, 0, 'Anthropic was not asked');
        assert.equal(reply.kind === 'reply' && reply.engine, 'gemini');
        assert.equal(reply.kind === 'reply' && reply.fellBackFrom?.reason, 'budget');
        assert.equal(geminiCalls.length, 1);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.outcome, u.usd]), [['dm', 'budget', 0]]);
        assert.equal(events('dm.engine_fallback')[0]?.reason, 'budget');
    });

    it('a refused budget with the fallback off is the stub: nothing sent, nothing spent, `dm.engine_failed` says budget', async () => {
        world.agent = { ...AGENT, engine: 'providers', gemini_fallback: false };
        db.setSetting('ai.budget.daily_usd', '0');
        const { fetchImpl, calls } = stubFetch();
        setProviderFetch(fetchImpl);

        const reply = await ask();

        assert.equal(reply.kind, 'handoff');
        assert.equal(calls.length, 0);
        assert.equal(geminiCalls.length, 0);
        assert.equal(events('dm.engine_failed')[0]?.reason, 'budget');
        assert.ok(db.usage.every((u) => u.usd === 0));
    });

    it('a budget the layer reports as BudgetRefused is the same failure', () => {
        const refused = new BudgetRefused('tenant_day', 2, 2, 'anthropic', 'claude-test');
        assert.equal(failureOf(refused).reason, 'budget');
    });

    it('no key saved for any provider is `no_provider`: the same policy, with the reason in the log', async () => {
        db.settings.delete('ai.providers.anthropic.api_key');
        // The layer would otherwise take the first provider with a key, and Gemini's (the bot's own) is there: switch it off for the layer.
        db.setSetting('ai.providers', JSON.stringify({ gemini: { enabled: false } }));
        const { fetchImpl, calls } = stubFetch();
        setProviderFetch(fetchImpl);

        const reply = await ask();

        assert.equal(calls.length, 0);
        assert.equal(reply.kind === 'reply' && reply.fellBackFrom?.reason, 'no_provider');
        assert.equal(geminiCalls.length, 1, 'the legacy call has its own key');
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.outcome]), [['dm', 'no_provider']]);
    });

    it('with no route saved the first provider that has a key answers: on a deployment with only the bot\'s Gemini key, that is Gemini, through the layer', async () => {
        db.settings.delete('ai.providers.anthropic.api_key');
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, {
            candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'عبر الطبقة' }) }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, totalTokenCount: 520 },
        }));
        setProviderFetch(fetchImpl);

        const reply = await ask();

        assert.equal(reply.kind === 'reply' && reply.engine, 'providers');
        assert.equal(reply.kind === 'reply' && reply.response.text, 'عبر الطبقة');
        assert.match(calls[0]!.url, /generativelanguage\.googleapis\.com/);
        assert.equal(geminiCalls.length, 0, 'not the legacy call');
        assert.equal(db.usage[0]!.purpose, 'dm');
    });

    it('a provider that answers 503 is `server`: Gemini answers, and the call is on the books as a failed one', async () => {
        const { fetchImpl } = stubFetch(jsonResponse(503, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
        setProviderFetch(fetchImpl);

        const reply = await ask();

        assert.equal(reply.kind === 'reply' && reply.fellBackFrom?.reason, 'server');
        assert.equal(geminiCalls.length, 1);
        assert.deepEqual(db.usage.map((u) => [u.purpose, u.outcome]), [['dm', 'server']]);
    });
});

// Keep the timeouts honest: the layer's deadline is shorter than Gemini's, because a DM is answered while the person waits.
describe('the deadline', () => {
    it('is shorter than Gemini\'s 30 s', () => {
        assert.ok(DM_TIMEOUT_MS < 30_000);
    });
});
