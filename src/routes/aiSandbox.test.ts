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
