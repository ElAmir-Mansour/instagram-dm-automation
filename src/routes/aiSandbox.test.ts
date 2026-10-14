/**
 * POST /api/settings/ai/test — the sandbox runs the model and temperature ON SCREEN.
 *
 * Until the form sent them, the sandbox ran the SAVED pair, so a test after changing the
 * picker tested the wrong model. Run through the route's handler with `pool.query` and
 * `axios.post` stubbed, so no request leaves the process; the assertion is on what would
 * have been sent to Gemini.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import axios from 'axios';
import { pool } from '../config/db.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../services/aiProviders/generate.js';
import { AiError } from '../services/llm/errors.js';
import { FITNESS_EN, SHOP_EG } from '../services/profile/fixtures.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import type { CreatorProfile } from '../services/profile/types.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

function handlerFor(method: string, path: string): Handle {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    const handles = layer!.route!.stack.map((l) => l.handle);
    return handles[handles.length - 1]!;
}

const TENANT = '22222222-2222-4222-8222-222222222222';
const SAVED = { is_active: true, system_prompt: 'saved prompt', knowledge_base: 'saved kb', model: 'gemini-2.5-flash', temperature: 0.7 };

let restoreSink: (() => void) | undefined;
let originalQuery: typeof pool.query;
let originalPost: typeof axios.post;
let savedKey: string | undefined;
let sent: Array<{ url: string; body: any }>;

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    originalQuery = pool.query;
    originalPost = axios.post;
    savedKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    sent = [];
    (pool as unknown as { query: unknown }).query = async (sql: string) => {
        if (/FROM ai_agents WHERE creator_id = \$1/.test(sql)) return { rows: [SAVED], rowCount: 1 };
        if (/FROM app_settings WHERE key = \$1/.test(sql)) return { rows: [], rowCount: 0 };
        if (/FROM messages/.test(sql)) return { rows: [], rowCount: 0 };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    (axios as any).post = async (url: string, body: unknown) => {
        sent.push({ url, body });
        return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'أهلاً' }) }] } }] } };
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (axios as any).post = originalPost;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedKey;
    restoreSink?.();
});

async function test(body: Record<string, unknown>) {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
    await handlerFor('post', '/settings/ai/test')(
        { session: { userId: 'u-1', role: 'user', tenantId: TENANT }, body, params: {}, headers: {} }, res, () => {}
    );
    return res;
}

describe('POST /settings/ai/test — model and temperature from the form', () => {
    it('sends the model and temperature on screen, not the saved pair', async () => {
        const res = await test({ user_message: 'كم السعر؟', model: 'gemini-3.8-flash', temperature: 0 });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(sent.length, 1);
        assert.match(sent[0]!.url, /\/models\/gemini-3\.8-flash:generateContent$/);
        // 0 is a real choice (the "stop improvising" setting), not a missing value.
        assert.equal(sent[0]!.body.generationConfig.temperature, 0);
    });

    it('accepts the temperature as the string a form field holds', async () => {
        await test({ user_message: 'x', temperature: '0.3' });
        assert.equal(sent[0]!.body.generationConfig.temperature, 0.3);
    });

    it('falls back to the saved pair when the form sends neither (an older dashboard)', async () => {
        await test({ user_message: 'x' });
        assert.match(sent[0]!.url, /\/models\/gemini-2\.5-flash:generateContent$/);
        assert.equal(sent[0]!.body.generationConfig.temperature, 0.7);
    });

    it('refuses a model the server does not run, and a temperature outside 0–1, before calling Gemini', async () => {
        for (const body of [
            { user_message: 'x', model: 'gpt-4o' },
            { user_message: 'x', temperature: 1.5 },
            { user_message: 'x', temperature: 'hot' },
        ]) {
            const res = await test(body);
            assert.equal(res.statusCode, 400, JSON.stringify(body));
        }
        assert.equal(sent.length, 0);
    });
});

/**
 * P8: the sandbox runs the DM bot as the tenant's real customers would meet it, so its rules, schema and (with no agent saved
 * yet) starter persona are written from the tenant's Creator Profile, like the live path's.
 */
describe('POST /settings/ai/test — the wording is the tenant\'s profile\'s (P8)', () => {
    /** Answers the profile read with `profile` (as the database hands a JSONB column back) and the agent read with `agent`; anything else as the stub above does. */
    function arrange(profile: CreatorProfile, agent: typeof SAVED | null): void {
        const rest = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
            if (/FROM ai_agents WHERE creator_id = \$1/.test(sql)) return { rows: agent ? [agent] : [], rowCount: agent ? 1 : 0 };
            if (/FROM creator_profiles/.test(sql)) return { rows: [{ profile: throughJsonb(profile), version: 1, activated_at: null }], rowCount: 1 };
            return (rest as unknown as (s: string, p?: unknown[]) => Promise<unknown>).call(pool, sql, params);
        };
    }

    it('an English tenant with no agent saved yet is tested with the English starter persona, English rules and an English schema', async () => {
        arrange(FITNESS_EN, null);
        const res = await test({ user_message: 'How much is it?' });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));

        const instruction: string = sent[0]!.body.systemInstruction.parts[0].text;
        assert.match(instruction, /^You are a smart assistant who answers followers' questions in English\.\n\n=== Knowledge base available to you ===\n\n\n=== Additional important instructions ===\n1\. /);
        assert.match(instruction, /2\. If the user asks for offers or contact details/);
        assert.doesNotMatch(JSON.stringify([sent[0]!.body.systemInstruction, sent[0]!.body.generationConfig.responseSchema]), /[؀-ۿ]/);
        assert.match(sent[0]!.body.generationConfig.responseSchema.properties.text.description, /Must be written in English if appropriate\./);
    });

    it('an Egyptian shop with an agent saved is tested with Egyptian rule 1, the «منتجات» noun and an OFFER button id', async () => {
        arrange(SHOP_EG, SAVED);
        const res = await test({ user_message: 'بكام؟' });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));

        const instruction: string = sent[0]!.body.systemInstruction.parts[0].text;
        assert.match(instruction, /^saved prompt\n\n=== قاعدة المعرفة المتاحة لديك \(Knowledge Base\) ===\nsaved kb\n\n/);
        assert.match(instruction, /1\. يجب أن تكون إجاباتك ودية وتفاعلية ومكتوبة باللهجة المصرية البسيطة\./);
        assert.match(instruction, /2\. إذا طلب المستخدم منتجات أو معلومات تواصل/);
        assert.match(JSON.stringify(sent[0]!.body.generationConfig.responseSchema), /GO_TO_OFFER_1/);
    });

    /** Says who the platform owner is to the stub in beforeEach, which has no answer for the profile read (so it throws). */
    function ownerIs(owner: string): void {
        const rest = pool.query;
        invalidateTenantCache();
        (pool as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
            if (/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/.test(sql)) return { rows: [{ id: owner }], rowCount: 1 };
            return (rest as unknown as (s: string, p?: unknown[]) => Promise<unknown>).call(pool, sql, params);
        };
    }
    afterEach(() => invalidateTenantCache());

    const inTheOwnersWording = async (): Promise<void> => {
        const res = await test({ user_message: 'x' });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        const instruction: string = sent[0]!.body.systemInstruction.parts[0].text;
        assert.match(instruction, /2\. إذا طلب المستخدم كورسات أو معلومات تواصل/);
        assert.match(JSON.stringify(sent[0]!.body.generationConfig.responseSchema), /GO_TO_COURSE_1/);
    };

    it('a profile that cannot be read is tested in the owner\'s wording when the tenant IS the owner: Arabic, Gulf, courses', async () => {
        ownerIs(TENANT);
        await inTheOwnersWording();
    });

    it('and when the owner cannot be found (the lookup itself fails: the stub has no answer for it)', async () => {
        await inTheOwnersWording();
    });

    it('for a tenant that is not the owner an unreadable profile is an error: the model is never asked, in the owner\'s wording or any other', async () => {
        ownerIs('someone-else');
        const res = await test({ user_message: 'x' });
        assert.equal(res.statusCode, 500);
        assert.equal(sent.length, 0);
    });
});

/**
 * DM plan S3: the sandbox runs the engine on screen. A test of the AI providers engine goes through the layer (`dm`, labelled `eval`),
 * says which engine answered, and says why when nothing did. Gemini stays `axios.post`, as above; the layer is `setAiCaller`'s stand-in.
 */
describe('POST /settings/ai/test — the engine on screen (S3)', () => {
    let layerCalls: AiGenerateArgs[];
    let layer: (args: AiGenerateArgs) => Promise<AiGenerateResult>;
    let savedEngine: { engine?: string; gemini_fallback?: boolean };
    let undo: (() => void)[];

    const layerSaying = (reply: Record<string, unknown>) => async (): Promise<AiGenerateResult> => ({
        json: reply, usage: { in: 900, out: 60 }, billed: [], model: 'claude-test', provider: 'anthropic', stopReason: 'end_turn',
        elapsed_ms: 800, usd: 0.003, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '1',
    });
    const layerFailing = (kind: AiError['kind'], message = `a ${kind} failure`) => async (): Promise<AiGenerateResult> => {
        throw new AiError({ kind, provider: 'anthropic', model: 'claude-test', message });
    };

    beforeEach(() => {
        layerCalls = [];
        layer = layerSaying({ message_type: 'text', text: 'رد من المزوّد' });
        savedEngine = {};
        const base = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
            if (/^SELECT engine, gemini_fallback FROM ai_agents/.test(sql)) return { rows: [savedEngine], rowCount: 1 };
            return (base as unknown as (s: string, p?: unknown[]) => Promise<unknown>).call(pool, sql, params);
        };
        const caller = setAiCaller((args) => { layerCalls.push(args); return layer(args); });
        undo = [() => { (pool as unknown as { query: unknown }).query = base; }, () => { setAiCaller(caller); }];
    });
    afterEach(() => { for (const f of undo) f(); });

    it('runs Gemini when nothing says otherwise, and says so', async () => {
        const res = await test({ user_message: 'كم السعر؟' });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.engine, 'gemini');
        assert.equal(res.body.text, 'أهلاً');
        assert.equal(layerCalls.length, 0);
        assert.equal(sent.length, 1);
    });

    it('runs the AI providers engine when the form says so: purpose dm, labelled eval, charged to the tenant, no Gemini request', async () => {
        const res = await test({ user_message: 'كم السعر؟', engine: 'providers' });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.engine, 'providers');
        assert.equal(res.body.text, 'رد من المزوّد');
        assert.equal(res.body.fell_back, undefined);
        assert.equal(layerCalls.length, 1);
        assert.deepEqual([layerCalls[0]!.purpose, layerCalls[0]!.usageAs, layerCalls[0]!.creatorId, layerCalls[0]!.cacheSystem], ['dm', 'eval', TENANT, true]);
        assert.equal(sent.length, 0);
    });

    it('tests the draft prompt on the AI providers engine, as on Gemini: the saved agent is not written to', async () => {
        const statements: string[] = [];
        const wrapped = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => { statements.push(sql); return (wrapped as any).call(pool, sql, params); };
        await test({ user_message: 'x', engine: 'providers', system_prompt: 'DRAFT PROMPT', knowledge_base: 'DRAFT KB' });
        (pool as unknown as { query: unknown }).query = wrapped;
        assert.match(layerCalls[0]!.system, /^DRAFT PROMPT\n\n/);
        assert.match(layerCalls[0]!.system, /\nDRAFT KB\n/);
        assert.ok(!statements.some((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s)), 'a test writes nothing');
    });

    it('runs the saved engine when the form sends none (an older dashboard)', async () => {
        savedEngine = { engine: 'providers', gemini_fallback: true };
        const res = await test({ user_message: 'x' });
        assert.equal(res.body.engine, 'providers');
        assert.equal(sent.length, 0);
    });

    it('the engine on screen wins over the saved one, both ways', async () => {
        savedEngine = { engine: 'providers', gemini_fallback: true };
        const res = await test({ user_message: 'x', engine: 'gemini' });
        assert.equal(res.body.engine, 'gemini');
        assert.equal(layerCalls.length, 0);
    });

    it('answers with Gemini and says the AI providers engine failed, when the fallback is on', async () => {
        layer = layerFailing('budget');
        const res = await test({ user_message: 'x', engine: 'providers', gemini_fallback: true });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.engine, 'gemini');
        assert.equal(res.body.fell_back, true);
        assert.equal(res.body.fallback_reason, 'budget');
        assert.equal(sent.length, 1);
    });

    it('is a 502 that says why when the AI providers engine fails and the fallback on screen is off: what a customer would be sent is nothing', async () => {
        layer = layerFailing('no_provider', 'No AI provider is ready.');
        savedEngine = { engine: 'providers', gemini_fallback: true };
        const res = await test({ user_message: 'x', gemini_fallback: false });
        assert.equal(res.statusCode, 502, 'never 401 or 403: the dashboard reads those as signed out');
        assert.match(res.body.error, /AI providers engine failed \(no_provider\): No AI provider is ready\./);
        assert.equal(sent.length, 0);
    });

    it('is a 502 naming both when Gemini fails too', async () => {
        layer = layerFailing('server', 'Anthropic is down.');
        (axios as any).post = async () => { throw new Error('socket hang up'); };
        const res = await test({ user_message: 'x', engine: 'providers' });
        assert.equal(res.statusCode, 502);
        assert.match(res.body.error, /\(server\): Anthropic is down\./);
        assert.match(res.body.error, /Gemini failed too: Gemini request failed: socket hang up/);
    });

    it('answers a switched-off agent on the AI providers engine, as on Gemini: trying a prompt before switching the agent on is the point', async () => {
        const base = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
            if (/FROM ai_agents WHERE creator_id = \$1/.test(sql) && !/^SELECT engine/.test(sql)) return { rows: [{ ...SAVED, is_active: false }], rowCount: 1 };
            return (base as unknown as (s: string, p?: unknown[]) => Promise<unknown>).call(pool, sql, params);
        };
        const res = await test({ user_message: 'x', engine: 'providers' });
        (pool as unknown as { query: unknown }).query = base;
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.engine, 'providers');
        assert.equal(layerCalls.length, 1);
    });

    it('refuses an engine the server does not run, and a fallback that is not a boolean, before asking anyone', async () => {
        for (const body of [{ engine: 'claude' }, { engine: 3 }, { gemini_fallback: 'false' }, { gemini_fallback: 1 }]) {
            const res = await test({ user_message: 'x', ...body });
            assert.equal(res.statusCode, 400, JSON.stringify(body));
        }
        assert.equal(sent.length, 0);
        assert.equal(layerCalls.length, 0);
    });
});
