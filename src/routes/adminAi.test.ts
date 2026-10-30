/**
 * `/api/admin/ai/*` (P20c): the platform-admin gate, the masking of every key, the check-before-save flow against a fake provider, the
 * settings changes and their audit rows, the route test, the model list and the usage summary.
 *
 * Driven through `admin.ts`'s router (so the mount is covered too) with a plain request object, against the in-memory stand-in for
 * `app_settings`, `ai_usage` and `audit_log` (services/aiProviders/testDb.ts). The provider is a function that answers by URL, and it is
 * the only thing that ever sees a key: nothing here reaches the network.
 *
 * Every fake key is built at run time (testKeys.ts). The tests that matter most are the ones that look for one: in a response, in the
 * log, in an audit row, in a usage row, in a stored setting, in what the provider's own error echoed back.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { setProviderFetch } from '../services/aiProviders/generate.js';
import { AiError } from '../services/llm/errors.js';
import { setLlmCaller, type GenerateJsonArgs, type GenerateJsonResult } from '../services/llm/generate.js';
import { installAiDb, type AiDb } from '../services/aiProviders/testDb.js';
import { jsonResponse } from '../services/llm/testFetch.js';
import { assertNoKey, FAKE_KEYS } from '../services/aiProviders/testKeys.js';
import type { FetchLike } from '../services/llm/types.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';
import aiRouter from './adminAi.js';

type Session = { userId: string | null; role: string; tenantId: string | null; tokenVersion: number };
interface Reply { status: number; body: any; fellThrough?: boolean }

const OWNER = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ADMIN: Session = { userId: USER, role: 'platform_admin', tenantId: OWNER, tokenVersion: 0 };
const NOT_ADMIN: Session = { userId: 'u-1', role: 'user', tenantId: OWNER, tokenVersion: 1 };

function call(method: string, url: string, opts: { session?: Session; body?: unknown; query?: Record<string, unknown>; router?: typeof adminRouter } = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const req = {
            method: method.toUpperCase(), url, originalUrl: url, body: opts.body ?? {}, query: opts.query ?? {}, params: {}, headers: {},
            session: 'session' in opts ? opts.session : ADMIN,
        } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(body: unknown) { resolve({ status: (this as any).statusCode, body }); return this; },
            setHeader() { return this; },
        } as unknown as ExpressResponse;
        (opts.router ?? adminRouter)(req, res, () => resolve({ status: 0, body: null, fellThrough: true }));
    });
}

const AI_ROUTES: [string, string][] = [
    ['GET', '/ai'], ['PUT', '/ai'], ['PUT', '/ai/keys/anthropic'], ['DELETE', '/ai/keys/anthropic'], ['POST', '/ai/test'],
    ['GET', '/ai/models/anthropic'], ['GET', '/ai/usage'],
];

// ─── The fake provider ───────────────────────────────────────────────────────────────────────

interface Hit { url: string; method: string | undefined; headers: Record<string, string>; raw: string }
let hits: Hit[];
/** Answers by URL. The default accepts exactly the fake keys and answers anything else as the provider would: with the key it was sent, in its message. */
let providerAnswer: (hit: Hit) => Response | Promise<Response>;

const echoes401 = (hit: Hit) => jsonResponse(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${hit.headers['x-api-key'] ?? hit.headers.authorization ?? ''}` } });

const goodProvider = (hit: Hit): Response => {
    const u = new URL(hit.url);
    if (u.host === 'api.anthropic.com' && u.pathname === '/v1/models') {
        if (hit.headers['x-api-key'] !== FAKE_KEYS.anthropic) return echoes401(hit);
        return jsonResponse(200, { data: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }], has_more: false });
    }
    if (u.host === 'openrouter.ai' && u.pathname === '/api/v1/key') {
        if (hit.headers.authorization !== `Bearer ${FAKE_KEYS.openrouter}`) return echoes401(hit);
        return jsonResponse(200, { data: { limit_remaining: null } });
    }
    if (u.host === 'api.groq.com' && u.pathname === '/openai/v1/models') {
        if (hit.headers.authorization !== `Bearer ${FAKE_KEYS.groq}`) return echoes401(hit);
        return jsonResponse(200, {
            object: 'list',
            data: [{ id: 'openai/gpt-oss-120b' }, { id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }, { id: 'canopylabs/orpheus-v1-english' }, { id: 'llama-3.3-70b-versatile' }],
        });
    }
    if (u.host === 'api.meta.ai' && u.pathname === '/v1/models') {
        if (hit.headers.authorization !== `Bearer ${FAKE_KEYS.meta}`) return echoes401(hit);
        // As GET /v1/models answered on 2026-10-28: every chat model's Contributor twin, and the models of other endpoints, are in it.
        return jsonResponse(200, {
            object: 'list',
            data: ['muse-wonder-1.0', 'sam-3.1', 'muse-spark-1.3-contributor', 'muse-voice-transcribe-1.0', 'muse-spark-1.3', 'muse-image-1.0', 'muse-spark-1.2-contributor', 'muse-spark-1.2', 'muse-spark-1.1']
                .map((id) => ({ id, object: 'model', created: 0, owned_by: 'meta' })),
        });
    }
    if (u.host === 'inference.baseten.co' && u.pathname === '/v1/models') {
        if (hit.headers.authorization !== `Bearer ${FAKE_KEYS.baseten}`) return echoes401(hit);
        // Baseten lists every open model its Model APIs serve (documented 2026-10-30); only Meta's are offered.
        return jsonResponse(200, { object: 'list', data: ['zai-org/GLM-5.3', 'meta-models/muse-spark-open-1026', 'moonshotai/Kimi-K3'].map((id) => ({ id, object: 'model' })) });
    }
    if (u.host === 'llm.example.com' && u.pathname === '/v1/models') {
        return jsonResponse(200, { data: [{ id: 'my-model' }, { id: 'other-model' }] });
    }
    return jsonResponse(404, { error: 'nothing here' });
};

const fakeFetch: FetchLike = async (url, init) => {
    const hit: Hit = {
        url, method: init.method, raw: String(init.body ?? ''),
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
    };
    hits.push(hit);
    return providerAnswer(hit);
};

// ─── The stand-in for the rest ───────────────────────────────────────────────────────────────

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'META_MODEL_API_KEY', 'BASETEN_API_KEY', 'GEMINI_API_KEY'] as const;
let db: AiDb;
let savedEnv: Record<string, string | undefined>;
let logs: string[];
let restoreSink: (() => void) | undefined;
let restoreCaller: (() => void) | undefined;
let generated: GenerateJsonArgs[];
let generateAnswer: (args: GenerateJsonArgs) => GenerateJsonResult | Promise<GenerateJsonResult>;

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
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
    hits = [];
    providerAnswer = goodProvider;
    setProviderFetch(fakeFetch);
    generated = [];
    generateAnswer = () => ({
        json: { ok: true }, usage: { in: 40, out: 6 }, billed: [{ model: 'claude-opus-5-5', in: 40, out: 6 }],
        model: 'claude-opus-5-5', provider: 'anthropic', stopReason: 'end_turn', elapsed_ms: 800,
    });
    const previousCaller = setLlmCaller(async (args) => { generated.push(args); return generateAnswer(args); });
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

const saveKey = (id: keyof typeof FAKE_KEYS) => db.setSetting(id === 'gemini' ? 'gemini.api_key' : `ai.providers.${id}.api_key`, FAKE_KEYS[id], true);
const usageOf = (purpose: string) => db.usage.filter((u) => u.purpose === purpose);

// ─── The gate ────────────────────────────────────────────────────────────────────────────────

describe('the platform_admin gate', () => {
    it('404s every AI route for a non-admin, with the same body as a route that does not exist', async () => {
        const invented = await call('GET', '/there-is-no-such-endpoint', { session: NOT_ADMIN });
        for (const [method, url] of AI_ROUTES) {
            const reply = await call(method, url, { session: NOT_ADMIN });
            assert.equal(reply.status, 404, `${method} ${url}`);
            assert.deepEqual(reply.body, invented.body, `${method} ${url}`);
        }
    });

    it('404s every AI route when there is no session at all', async () => {
        for (const [method, url] of AI_ROUTES) assert.equal((await call(method, url, { session: undefined })).status, 404, `${method} ${url}`);
    });

    it('is checked by the AI router itself, so mounting it somewhere else cannot open it', async () => {
        for (const [method, url] of AI_ROUTES) {
            const reply = await call(method, url.replace(/^\/ai/, '') || '/', { session: NOT_ADMIN, router: aiRouter as unknown as typeof adminRouter });
            assert.equal(reply.status, 404, `${method} ${url}`);
        }
    });

    it('does not touch the database, the provider or the settings for a non-admin', async () => {
        for (const [method, url] of AI_ROUTES) await call(method, url, { session: NOT_ADMIN, body: { apiKey: FAKE_KEYS.anthropic } });
        assert.equal(db.statements.length, 0);
        assert.equal(hits.length, 0);
    });

    it('does not 404 an admin', async () => {
        assert.equal((await call('GET', '/ai')).status, 200);
    });
});

// ─── GET /ai ─────────────────────────────────────────────────────────────────────────────────

describe('GET /ai', () => {
    it('answers with providers, purposes, prices, budgets, warnings and today\'s spend, and nothing is saved yet', async () => {
        const { status, body } = await call('GET', '/ai');
        assert.equal(status, 200);
        assert.deepEqual(body.providers.map((p: any) => p.id), ['anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'meta', 'baseten', 'custom']);
        assert.deepEqual(body.purposes.map((p: any) => p.purpose), [
            'onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm', 'dm_whatsapp', 'ads_draft', 'ads_review',
            'perception_dm', 'recall', 'reel_index', 'comment_intent',
        ]);
        assert.ok(body.prices.some((p: any) => p.model === 'claude-opus-5-5' && p.source === 'default'));
        assert.equal(body.budgets.unlimited, true);
        assert.deepEqual(body.warnings.map((w: any) => w.code), ['no_budget']);
        assert.equal(body.purposes[0].resolved.error.kind, 'no_provider');
        assert.deepEqual(body.spend.today, { calls: 0, failed: 0, unpriced: 0, usd: 0 });
        assert.equal(hits.length, 0, 'reading the settings asks no provider anything');
    });

    it('reports each key as {set, source, last4} and never more, for every provider, whichever way it was set', async () => {
        saveKey('anthropic');
        saveKey('gemini');
        process.env.OPENAI_API_KEY = FAKE_KEYS.openai;
        db.setSetting('ai.providers.custom.api_key', FAKE_KEYS.custom, true);
        db.setSetting('ai.providers.groq.api_key', FAKE_KEYS.groq, true);
        db.setSetting('ai.providers.meta.api_key', FAKE_KEYS.meta, true);
        db.setSetting('ai.providers.baseten.api_key', FAKE_KEYS.baseten, true);
        const { body } = await call('GET', '/ai');
        const keys = Object.fromEntries(body.providers.map((p: any) => [p.id, p.key]));
        assert.deepEqual(keys.anthropic, { set: true, source: 'database', last4: 'ant1', envFallback: false });
        assert.deepEqual(keys.gemini, { set: true, source: 'database', last4: 'gem3', envFallback: false });
        assert.deepEqual(keys.openai, { set: true, source: 'env', last4: null, envFallback: true });
        assert.deepEqual(keys.openrouter, { set: false, source: null, last4: null, envFallback: false });
        assert.deepEqual(keys.custom, { set: true, source: 'database', last4: 'cus5', envFallback: false });
        assert.deepEqual(keys.groq, { set: true, source: 'database', last4: 'grq6', envFallback: false });
        assert.deepEqual(keys.meta, { set: true, source: 'database', last4: 'met7', envFallback: false });
        assert.deepEqual(keys.baseten, { set: true, source: 'database', last4: 'bas9', envFallback: false });
        assertNoKey(JSON.stringify(body), 'GET /ai');
    });

    it('shows what each purpose would use, with the route that is saved beside it', async () => {
        saveKey('anthropic');
        db.setSetting('ai.routing', JSON.stringify({ tenant_studio: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } }));
        const { body } = await call('GET', '/ai');
        const byPurpose = Object.fromEntries(body.purposes.map((p: any) => [p.purpose, p]));
        assert.deepEqual(byPurpose.tenant_studio.saved, { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' });
        assert.equal(byPurpose.tenant_studio.resolved.source, 'saved');
        assert.equal(byPurpose.onboarding_draft.resolved.source, 'default');
        assert.equal(byPurpose.onboarding_draft.saved, null);
    });

    it('lists the DM purpose, then WhatsApp\'s: low effort by default, not the Mac\'s, and resolved to the first provider with a key', async () => {
        saveKey('anthropic');
        const { body } = await call('GET', '/ai');
        const [dm, whatsapp] = ['dm', 'dm_whatsapp'].map((purpose) => body.purposes.find((p: any) => p.purpose === purpose));
        assert.deepEqual(dm, {
            purpose: 'dm', defaultEffort: 'low', macBrainGuarded: false, saved: null,
            resolved: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', source: 'default' },
        });
        assert.deepEqual(whatsapp, {
            purpose: 'dm_whatsapp', defaultEffort: 'low', macBrainGuarded: false, saved: null,
            resolved: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low', source: 'default' },
        });
    });

    it('shows WhatsApp\'s purpose resolved to an error, not to Gemini, when Gemini is the only key', async () => {
        db.setSetting('gemini.api_key', FAKE_KEYS.gemini, true);
        const { body } = await call('GET', '/ai');
        const [dm, whatsapp] = ['dm', 'dm_whatsapp'].map((purpose) => body.purposes.find((p: any) => p.purpose === purpose));
        assert.equal(dm.resolved.provider, 'gemini', 'Instagram\'s DM route may use it');
        assert.equal(whatsapp.resolved.error.kind, 'no_provider', 'WhatsApp\'s may not');
    });

    it('lists the four Muse purposes last, low effort, not the Mac\'s, and resolved to an error until Meta has a key, then to Meta whatever other keys there are', async () => {
        saveKey('anthropic');
        saveKey('gemini');
        const before = await call('GET', '/ai');
        const muse = ['perception_dm', 'recall', 'reel_index', 'comment_intent'];
        assert.deepEqual(before.body.purposes.slice(-4).map((p: any) => p.purpose), muse);
        for (const row of before.body.purposes.slice(-4)) {
            assert.equal(row.defaultEffort, 'low', row.purpose);
            assert.equal(row.macBrainGuarded, false, row.purpose);
            assert.equal(row.saved, null, row.purpose);
            assert.equal(row.resolved.error.kind, 'no_provider', `${row.purpose}: only Meta may answer it, and Meta has no key`);
        }
        saveKey('meta');
        const after = await call('GET', '/ai');
        for (const row of after.body.purposes.slice(-4)) {
            assert.deepEqual(row.resolved, { provider: 'meta', model: 'muse-spark-1.3', effort: 'low', source: 'default' }, row.purpose);
        }
        // Nothing existing moved to Meta: Gemini and Anthropic keep every purpose they had.
        for (const purpose of ['dm', 'tenant_studio', 'onboarding_draft']) {
            assert.equal(after.body.purposes.find((p: any) => p.purpose === purpose).resolved.provider, 'anthropic', purpose);
        }
        assertNoKey(JSON.stringify(after.body), 'GET /ai with a Meta key');
    });

    it('shows Meta (Muse) as a provider with its address left out, its key status, its default and suggested models, and the environment variable it falls back to unnamed', async () => {
        const { body } = await call('GET', '/ai');
        const meta = body.providers.find((p: any) => p.id === 'meta');
        assert.deepEqual(
            { label: meta.label, family: meta.family, keyRequired: meta.keyRequired, enabled: meta.enabled, defaultModel: meta.defaultModel, suggestedModels: meta.suggestedModels, baseUrl: meta.baseUrl, usable: meta.usable, problem: meta.problem },
            { label: 'Meta (Muse)', family: 'chat_completions', keyRequired: true, enabled: true, defaultModel: 'muse-spark-1.3', suggestedModels: ['muse-spark-1.3', 'muse-spark-1.2'], baseUrl: null, usable: false, problem: 'has no API key saved' },
        );
        assert.ok(!JSON.stringify(body).includes('api.meta.ai'), 'a fixed address is not sent to the card');
    });

    it('fails with the migration hint when v34 has not been applied', async () => {
        db.failOn(/FROM ai_usage/, Object.assign(new Error('relation "ai_usage" does not exist'), { code: '42P01' }));
        const { status, body } = await call('GET', '/ai');
        assert.equal(status, 500);
        assert.equal(body.migrationPending, true);
        assert.match(body.error, /migration v34/);
    });
});

// ─── PUT /ai ─────────────────────────────────────────────────────────────────────────────────

describe('PUT /ai', () => {
    const patch = {
        providers: { custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model', jsonMode: 'object' } },
        routing: { onboarding_draft: { provider: 'custom', model: 'my-model', effort: 'medium' } },
        prices: { 'my-model': { in: 0.4, out: 1.6 } },
        budgets: { dailyUsd: 12.5, tenantDailyUsd: 2 },
    };

    it('saves what it was sent, answers with the view it now holds, and audits it with names and no amounts', async () => {
        const { status, body } = await call('PUT', '/ai', { body: patch });
        assert.equal(status, 200);
        assert.deepEqual(JSON.parse(db.settings.get('ai.providers')!.value), { custom: { baseUrl: 'https://llm.example.com/v1', defaultModel: 'my-model', jsonMode: 'object' } });
        assert.deepEqual(JSON.parse(db.settings.get('ai.routing')!.value), { onboarding_draft: { provider: 'custom', model: 'my-model', effort: 'medium' } });
        assert.deepEqual(JSON.parse(db.settings.get('ai.prices')!.value), { 'my-model': { in: 0.4, out: 1.6 } });
        assert.equal(db.settings.get('ai.budget.daily_usd')!.value, '12.5');
        assert.equal(db.settings.get('ai.budget.tenant_daily_usd')!.value, '2');
        assert.equal(body.budgets.dailyUsd, 12.5);
        assert.equal(body.budgets.unlimited, false);
        assert.equal(body.providers.find((p: any) => p.id === 'custom').baseUrl, 'https://llm.example.com/v1');
        assert.equal(body.purposes[0].saved.provider, 'custom');

        assert.equal(db.audits.length, 1);
        const row = db.audits[0]!;
        assert.equal(row.action, AUDIT_ACTIONS.settingsAiConfigWrite);
        assert.equal(row.action, 'settings.ai_config_write');
        assert.equal(row.actor_user_id, USER);
        assert.equal(row.target_type, 'app');
        assert.deepEqual(row.detail, {
            providers: ['custom'], routes: { onboarding_draft: 'custom/my-model/medium' }, prices: ['my-model'], budgets: ['dailyUsd', 'tenantDailyUsd'],
        });
    });

    it('merges into what is saved: a second save of one route leaves the other routes alone', async () => {
        await call('PUT', '/ai', { body: patch });
        await call('PUT', '/ai', { body: { routing: { onboarding_proof: { provider: 'custom', model: 'other-model' } } } });
        assert.deepEqual(Object.keys(JSON.parse(db.settings.get('ai.routing')!.value)).sort(), ['onboarding_draft', 'onboarding_proof']);
        await call('PUT', '/ai', { body: { routing: { onboarding_draft: null }, budgets: { dailyUsd: null } } });
        assert.deepEqual(Object.keys(JSON.parse(db.settings.get('ai.routing')!.value)), ['onboarding_proof']);
        assert.equal(db.settings.has('ai.budget.daily_usd'), false);
    });

    it('saves a route for the DM purpose under its own key, audits it by name, and clears it with null', async () => {
        const saved = await call('PUT', '/ai', { body: { routing: { dm: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } } } });
        assert.equal(saved.status, 200);
        assert.deepEqual(JSON.parse(db.settings.get('ai.routing')!.value), { dm: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } });
        assert.deepEqual(saved.body.purposes.find((p: any) => p.purpose === 'dm').saved, { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' });
        assert.deepEqual(db.audits.at(-1)!.detail.routes, { dm: 'anthropic/claude-sonnet-5-5/low' });
        await call('PUT', '/ai', { body: { routing: { dm: null } } });
        assert.equal(db.settings.has('ai.routing'), false);
    });

    it('saves a route for WhatsApp replies on a provider that does not train on its input, and refuses one on Gemini, OpenRouter or Custom', async () => {
        const ok = await call('PUT', '/ai', { body: { routing: { dm_whatsapp: { provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low' } } } });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.body.purposes.find((p: any) => p.purpose === 'dm_whatsapp').saved, { provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low' });
        for (const provider of ['gemini', 'openrouter', 'custom']) {
            const refused = await call('PUT', '/ai', { body: { routing: { dm_whatsapp: { provider, model: 'x-model', effort: 'low' } } } });
            assert.equal(refused.status, 400, provider);
            assert.match(refused.body.error, /routing\.dm_whatsapp\.provider must be one of groq, anthropic, openai/, provider);
        }
        assert.deepEqual(JSON.parse(db.settings.get('ai.routing')!.value), { dm_whatsapp: { provider: 'groq', model: 'openai/gpt-oss-120b', effort: 'low' } }, 'the refused ones saved nothing');
    });

    it('saves a route for a Muse purpose on Meta and refuses one on any other provider, naming Meta and why, and saving nothing', async () => {
        const ok = await call('PUT', '/ai', { body: { routing: { perception_dm: { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' }, recall: { provider: 'meta' } } } });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.body.purposes.find((p: any) => p.purpose === 'perception_dm').saved, { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' });
        assert.deepEqual(ok.body.purposes.find((p: any) => p.purpose === 'recall').saved, { provider: 'meta', model: '', effort: 'low' });
        assert.deepEqual(db.audits.at(-1)!.detail.routes, { perception_dm: 'meta/muse-spark-1.3/low', recall: 'meta/default/low' });
        for (const provider of ['anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'custom']) {
            const refused = await call('PUT', '/ai', { body: { routing: { reel_index: { provider, model: 'x-model', effort: 'low' } } } });
            assert.equal(refused.status, 400, provider);
            assert.equal(refused.body.error, 'routing.reel_index.provider must be one of meta, baseten: only Meta (Muse), hosted by Meta or by Baseten, is set up to answer this purpose.', provider);
        }
        assert.deepEqual(Object.keys(JSON.parse(db.settings.get('ai.routing')!.value)).sort(), ['perception_dm', 'recall'], 'the refused ones saved nothing');
    });

    it('saves a route for the reel indexer on Baseten, and refuses one on Baseten for every other purpose, naming the one it may answer and why, saving nothing', async () => {
        const ok = await call('PUT', '/ai', { body: { routing: { reel_index: { provider: 'baseten', model: 'meta-models/muse-spark-open-1026', effort: 'low' } } } });
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.body.purposes.find((p: any) => p.purpose === 'reel_index').saved, { provider: 'baseten', model: 'meta-models/muse-spark-open-1026', effort: 'low' });
        assert.deepEqual(db.audits.at(-1)!.detail.routes, { reel_index: 'baseten/meta-models/muse-spark-open-1026/low' });
        const others = ok.body.purposes.map((p: any) => p.purpose).filter((purpose: string) => purpose !== 'reel_index');
        assert.equal(others.length, 12);
        for (const purpose of others) {
            const refused = await call('PUT', '/ai', { body: { routing: { [purpose]: { provider: 'baseten', model: 'meta-models/muse-spark-open-1026', effort: 'low' } } } });
            assert.equal(refused.status, 400, purpose);
            assert.equal(refused.body.error, `routing.${purpose}.provider Baseten may answer only reel_index: it watches the owner's own published reels, and no message, comment or follower data goes to it.`, purpose);
        }
        assert.deepEqual(Object.keys(JSON.parse(db.settings.get('ai.routing')!.value)), ['reel_index'], 'the refused ones saved nothing');
        assert.equal(db.audits.length, 1, 'and audited nothing');
    });

    it('refuses a Contributor-mode model as a route or as Meta\'s default model, for any purpose: Meta may train on what it is sent', async () => {
        for (const body of [
            { routing: { dm: { provider: 'meta', model: 'muse-spark-1.3-contributor', effort: 'low' } } },
            { routing: { perception_dm: { provider: 'meta', model: 'muse-spark-1.2-contributor', effort: 'low' } } },
            { providers: { meta: { defaultModel: 'muse-spark-1.3-contributor' } } },
        ]) {
            const refused = await call('PUT', '/ai', { body });
            assert.equal(refused.status, 400, JSON.stringify(body));
            assert.match(refused.body.error, /is a Contributor-mode model: its provider may train on what it is sent, so no purpose may use one\. Use the Standard model\./);
        }
        assert.equal(db.settings.size, 0, 'nothing was saved');
        assert.equal(db.audits.length, 0, 'nothing was audited');
        // The Standard model is fine on the same routes.
        assert.equal((await call('PUT', '/ai', { body: { routing: { dm: { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' } }, providers: { meta: { defaultModel: 'muse-spark-1.2' } } } })).status, 200);
    });

    it('refuses a route for a usage label: `eval` and `key_test` label spend and are not purposes', async () => {
        for (const label of ['eval', 'key_test']) {
            const { status, body } = await call('PUT', '/ai', { body: { routing: { [label]: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } } } });
            assert.equal(status, 400, label);
            assert.match(body.error, /is not a purpose: use .*\bdm\b/, label);
        }
        assert.equal(db.settings.has('ai.routing'), false);
    });

    it('refuses the whole body, writing nothing and auditing nothing, when any part of it is invalid', async () => {
        const { status, body } = await call('PUT', '/ai', { body: { ...patch, routing: { onboarding_draft: { provider: 'mistral' } } } });
        assert.equal(status, 400);
        assert.match(body.error, /provider must be one of/);
        assert.equal(body.problems.length, 1);
        assert.equal(db.settings.size, 0);
        assert.equal(db.audits.length, 0);
    });

    it('answers 400 for an empty change, a base URL that is not public https, and a body that is not an object', async () => {
        for (const body of [{}, { providers: { custom: { baseUrl: 'http://10.0.0.1' } } }, 'x', null, []]) {
            const reply = await call('PUT', '/ai', { body });
            assert.equal(reply.status, 400, JSON.stringify(body));
        }
        assert.equal(db.settings.size, 0);
    });

    it('cannot be used to save a key: there is no key field, and what it refuses it does not repeat', async () => {
        const reply = await call('PUT', '/ai', { body: { providers: { anthropic: { apiKey: FAKE_KEYS.anthropic } }, keys: { openai: FAKE_KEYS.openai } } });
        assert.equal(reply.status, 400);
        assertNoKey(JSON.stringify(reply.body), 'the 400');
        assert.equal(db.settings.size, 0);
    });
});

// ─── Keys ────────────────────────────────────────────────────────────────────────────────────

describe('PUT /ai/keys/:provider: checked with the provider first, saved only if it accepts the key', () => {
    it('saves a key the provider accepts, encrypted, and answers with its status and no key', async () => {
        const { status, body } = await call('PUT', '/ai/keys/anthropic', { body: { apiKey: `  ${FAKE_KEYS.anthropic}\n` } });
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'anthropic', key: { set: true, source: 'database', last4: 'ant1', envFallback: false } });
        const stored = db.settings.get('ai.providers.anthropic.api_key')!;
        assert.equal(stored.is_secret, true);
        assert.match(stored.value, /^enc:v1:/);
        assertNoKey(stored.value, 'the stored value');
        assert.equal(hits.length, 1);
        assert.equal(hits[0]!.url, 'https://api.anthropic.com/v1/models?limit=1');
        assert.equal(hits[0]!.headers['x-api-key'], FAKE_KEYS.anthropic, 'trimmed, and only in the header');
    });

    it('records the check as a `key_test` row with no tokens, no cost and no tenant, and audits the save without the key', async () => {
        await call('PUT', '/ai/keys/anthropic', { body: { apiKey: FAKE_KEYS.anthropic } });
        const rows = usageOf('key_test');
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0]!.provider, rows[0]!.outcome, rows[0]!.creator_id, rows[0]!.input_tokens, rows[0]!.output_tokens, rows[0]!.usd], ['anthropic', 'ok', null, 0, 0, 0]);
        assert.deepEqual(db.audits.map((a) => [a.action, a.detail]), [['settings.ai_key_write', { provider: 'anthropic', change: 'saved', warning: null }]]);
        assert.equal(db.audits[0]!.actor_user_id, USER);
        assertNoKey(JSON.stringify(db.audits), 'the audit row');
    });

    it('refuses a key the provider refuses with 400 (never 401 or 403), saves nothing, and does not repeat the key its error echoed', async () => {
        const bad = FAKE_KEYS.anthropic.replace('ant1', 'xxxx');
        const { status, body } = await call('PUT', '/ai/keys/anthropic', { body: { apiKey: bad } });
        assert.equal(status, 400);
        assert.equal(body.kind, 'auth');
        assert.match(body.error, /^Anthropic refused this key: /);
        assertNoKey(JSON.stringify(body), 'the refusal', [bad]);
        assert.ok(!JSON.stringify(body).includes(bad.slice(8, -4)));
        assert.equal(db.settings.size, 0, 'nothing saved: the key in use keeps answering');
        assert.equal(db.audits.length, 0);
        assert.deepEqual(usageOf('key_test').map((u) => u.outcome), ['auth'], 'the failed check is on the record too');
        assertNoKey(logs.join('\n') + JSON.stringify(db.usage), 'the log and the rows', [bad]);
    });

    it('answers 502 and saves nothing when the provider could not be reached', async () => {
        providerAnswer = () => jsonResponse(503, { error: 'overloaded' });
        const { status, body } = await call('PUT', '/ai/keys/anthropic', { body: { apiKey: FAKE_KEYS.anthropic } });
        assert.equal(status, 502);
        assert.match(body.error, /Could not reach Anthropic to check the key.*Nothing was saved; try again\./);
        assert.equal(body.kind, 'server');
        assert.equal(db.settings.size, 0);
        providerAnswer = () => { throw new TypeError('fetch failed'); };
        assert.equal((await call('PUT', '/ai/keys/anthropic', { body: { apiKey: FAKE_KEYS.anthropic } })).status, 502);
    });

    it('does not ask the provider about something that is plainly not a key', async () => {
        for (const apiKey of [undefined, '', '   ', 'short', 'has a space in the middle of it', 42]) {
            const { status } = await call('PUT', '/ai/keys/anthropic', { body: { apiKey } });
            assert.equal(status, 400, JSON.stringify(apiKey));
        }
        assert.equal(hits.length, 0);
        assert.equal(db.settings.size, 0);
    });

    it('checks OpenRouter\'s key against /key, which its public model list would never refuse', async () => {
        const { status } = await call('PUT', '/ai/keys/openrouter', { body: { apiKey: FAKE_KEYS.openrouter } });
        assert.equal(status, 200);
        assert.equal(hits[0]!.url, 'https://openrouter.ai/api/v1/key');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.openrouter}`);
    });

    it('checks Groq\'s key against its model list with a bearer header, then saves it encrypted under its own setting', async () => {
        const { status, body } = await call('PUT', '/ai/keys/groq', { body: { apiKey: `  ${FAKE_KEYS.groq}\n` } });
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'groq', key: { set: true, source: 'database', last4: 'grq6', envFallback: false } });
        assert.equal(hits.length, 1);
        assert.equal(hits[0]!.method, 'GET');
        assert.equal(hits[0]!.url, 'https://api.groq.com/openai/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.groq}`);
        const stored = db.settings.get('ai.providers.groq.api_key')!;
        assert.equal(stored.is_secret, true);
        assert.match(stored.value, /^enc:v1:/);
        assertNoKey(stored.value, 'the stored value');
        assert.deepEqual(db.audits.map((a) => [a.action, a.detail]), [['settings.ai_key_write', { provider: 'groq', change: 'saved', warning: null }]]);
        assert.deepEqual(usageOf('key_test').map((u) => [u.provider, u.outcome]), [['groq', 'ok']]);
        assertNoKey(JSON.stringify(db.audits) + JSON.stringify(db.usage), 'the audit and usage rows');
    });

    it('refuses a Groq key Groq refuses with 400, saves nothing, and does not repeat the key its error echoed', async () => {
        const bad = FAKE_KEYS.groq.replace('grq6', 'xxxx');
        const { status, body } = await call('PUT', '/ai/keys/groq', { body: { apiKey: bad } });
        assert.equal(status, 400);
        assert.equal(body.kind, 'auth');
        assert.match(body.error, /^Groq refused this key: /);
        assertNoKey(JSON.stringify(body), 'the refusal', [bad]);
        assert.ok(!JSON.stringify(body).includes(bad.slice(8, -4)));
        assert.equal(db.settings.size, 0);
        assert.equal(db.audits.length, 0);
        assertNoKey(logs.join('\n') + JSON.stringify(db.usage), 'the log and the rows', [bad]);
    });

    it('checks Meta\'s key against its model list with a bearer header, then saves it encrypted under its own setting, and a Test of it records no tokens', async () => {
        const { status, body } = await call('PUT', '/ai/keys/meta', { body: { apiKey: `  ${FAKE_KEYS.meta}\n` } });
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'meta', key: { set: true, source: 'database', last4: 'met7', envFallback: false } });
        assert.equal(hits.length, 1);
        assert.equal(hits[0]!.method, 'GET');
        assert.equal(hits[0]!.url, 'https://api.meta.ai/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.meta}`);
        assert.equal(hits[0]!.raw, '', 'the check is a GET with no body: it spends nothing');
        const stored = db.settings.get('ai.providers.meta.api_key')!;
        assert.equal(stored.is_secret, true);
        assert.match(stored.value, /^enc:v1:/);
        assertNoKey(stored.value, 'the stored value');
        assert.deepEqual(db.audits.map((a) => [a.action, a.detail]), [['settings.ai_key_write', { provider: 'meta', change: 'saved', warning: null }]]);
        assert.deepEqual(usageOf('key_test').map((u) => [u.provider, u.outcome, u.input_tokens, u.output_tokens]), [['meta', 'ok', 0, 0]]);
        assertNoKey(JSON.stringify(db.audits) + JSON.stringify(db.usage), 'the audit and usage rows');
    });

    it('refuses a Meta key Meta refuses with 401, saves nothing, and does not repeat the key its error echoed', async () => {
        const bad = FAKE_KEYS.meta.replace('met7', 'xxxx');
        const { status, body } = await call('PUT', '/ai/keys/meta', { body: { apiKey: bad } });
        assert.equal(status, 400);
        assert.equal(body.kind, 'auth');
        assert.match(body.error, /^Meta refused this key: /);
        assertNoKey(JSON.stringify(body), 'the refusal', [bad]);
        assert.ok(!JSON.stringify(body).includes(bad.slice(8, -4)));
        assert.equal(db.settings.size, 0);
        assert.equal(db.audits.length, 0);
        assertNoKey(logs.join('\n') + JSON.stringify(db.usage), 'the log and the rows', [bad]);
    });

    it('checks Baseten\'s key against its model list with a bearer header, then saves it encrypted under its own setting, and a check of it records no tokens', async () => {
        const { status, body } = await call('PUT', '/ai/keys/baseten', { body: { apiKey: `  ${FAKE_KEYS.baseten}\n` } });
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'baseten', key: { set: true, source: 'database', last4: 'bas9', envFallback: false } });
        assert.equal(hits.length, 1);
        assert.equal(hits[0]!.method, 'GET');
        assert.equal(hits[0]!.url, 'https://inference.baseten.co/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.baseten}`);
        assert.equal(hits[0]!.raw, '', 'the check is a GET with no body: it spends nothing');
        const stored = db.settings.get('ai.providers.baseten.api_key')!;
        assert.equal(stored.is_secret, true);
        assert.match(stored.value, /^enc:v1:/);
        assertNoKey(stored.value, 'the stored value');
        assert.deepEqual(db.audits.map((a) => [a.action, a.detail]), [['settings.ai_key_write', { provider: 'baseten', change: 'saved', warning: null }]]);
        assert.deepEqual(usageOf('key_test').map((u) => [u.provider, u.outcome, u.input_tokens, u.output_tokens]), [['baseten', 'ok', 0, 0]]);
        assertNoKey(JSON.stringify(db.audits) + JSON.stringify(db.usage), 'the audit and usage rows');
    });

    it('refuses a Baseten key Baseten refuses with 401, saves nothing, and does not repeat the key its error echoed (whole, or by its shape)', async () => {
        const bad = FAKE_KEYS.baseten.replace('bas9', 'xxxx');
        const { status, body } = await call('PUT', '/ai/keys/baseten', { body: { apiKey: bad } });
        assert.equal(status, 400);
        assert.equal(body.kind, 'auth');
        assert.match(body.error, /^Baseten refused this key: /);
        assertNoKey(JSON.stringify(body), 'the refusal', [bad]);
        assert.ok(!JSON.stringify(body).includes(bad.slice(8, -4)));
        assert.equal(db.settings.size, 0);
        assert.equal(db.audits.length, 0);
        assertNoKey(logs.join('\n') + JSON.stringify(db.usage), 'the log and the rows', [bad]);
    });

    it('forgets Baseten\'s saved key on DELETE, and with BASETEN_API_KEY set the environment answers again', async () => {
        saveKey('baseten');
        process.env.BASETEN_API_KEY = FAKE_KEYS.openai;
        const { status, body } = await call('DELETE', '/ai/keys/baseten');
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'baseten', key: { set: true, source: 'env', last4: null, envFallback: true } });
        assert.equal(db.settings.has('ai.providers.baseten.api_key'), false);
    });

    it('forgets Meta\'s saved key on DELETE, and with META_MODEL_API_KEY set the environment answers again', async () => {
        saveKey('meta');
        process.env.META_MODEL_API_KEY = FAKE_KEYS.openai;
        const { status, body } = await call('DELETE', '/ai/keys/meta');
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'meta', key: { set: true, source: 'env', last4: null, envFallback: true } });
        assert.equal(db.settings.has('ai.providers.meta.api_key'), false);
    });

    it('needs Custom\'s base URL to be saved first, then checks the key against that endpoint', async () => {
        const first = await call('PUT', '/ai/keys/custom', { body: { apiKey: FAKE_KEYS.custom } });
        assert.equal(first.status, 400);
        assert.match(first.body.error, /base URL first/);
        assert.equal(hits.length, 0);
        await call('PUT', '/ai', { body: { providers: { custom: { baseUrl: 'https://llm.example.com/v1' } } } });
        const ok = await call('PUT', '/ai/keys/custom', { body: { apiKey: FAKE_KEYS.custom } });
        assert.equal(ok.status, 200);
        assert.equal(hits[0]!.url, 'https://llm.example.com/v1/models');
        assert.equal(ok.body.key.last4, 'cus5');
    });

    it('saves Custom\'s key with a warning when its endpoint has no model list to prove it with', async () => {
        await call('PUT', '/ai', { body: { providers: { custom: { baseUrl: 'https://llm.example.com/v1' } } } });
        providerAnswer = () => jsonResponse(404, { error: 'not found' });
        const { status, body } = await call('PUT', '/ai/keys/custom', { body: { apiKey: FAKE_KEYS.custom } });
        assert.equal(status, 200);
        assert.equal(body.warning, 'no_model_list');
        assert.ok(db.settings.has('ai.providers.custom.api_key'));
        assert.equal(db.audits.at(-1)!.detail.warning, 'no_model_list');
    });

    it('sends Gemini to the existing route, which checks the DM bot\'s models, and touches nothing', async () => {
        for (const method of ['PUT', 'DELETE']) {
            const { status, body } = await call(method, '/ai/keys/gemini', { body: { apiKey: FAKE_KEYS.gemini } });
            assert.equal(status, 400);
            assert.equal(body.code, 'USE_GEMINI_KEY_ROUTE');
            assert.match(body.error, /\/api\/admin\/gemini-key/);
            assertNoKey(JSON.stringify(body), 'the pointer');
        }
        assert.equal(hits.length, 0);
        assert.equal(db.settings.size, 0);
    });

    it('404s a provider that does not exist', async () => {
        assert.equal((await call('PUT', '/ai/keys/mistral', { body: { apiKey: FAKE_KEYS.anthropic } })).status, 404);
        assert.equal((await call('DELETE', '/ai/keys/mistral')).status, 404);
    });
});

describe('DELETE /ai/keys/:provider', () => {
    it('forgets the saved key, says whether the environment answers now, and audits it', async () => {
        saveKey('anthropic');
        process.env.ANTHROPIC_API_KEY = FAKE_KEYS.openai;
        const { status, body } = await call('DELETE', '/ai/keys/anthropic');
        assert.equal(status, 200);
        assert.equal(db.settings.has('ai.providers.anthropic.api_key'), false);
        assert.deepEqual(body, { provider: 'anthropic', key: { set: true, source: 'env', last4: null, envFallback: true } });
        assert.deepEqual(db.audits.map((a) => [a.action, a.detail]), [['settings.ai_key_write', { provider: 'anthropic', change: 'removed' }]]);
        assertNoKey(JSON.stringify(body) + JSON.stringify(db.audits), 'the response and audit');
    });

    it('is allowed when nothing would answer afterwards: revoking a leaked key must not be blocked', async () => {
        saveKey('openai');
        const { status, body } = await call('DELETE', '/ai/keys/openai');
        assert.equal(status, 200);
        assert.deepEqual(body.key, { set: false, source: null, last4: null, envFallback: false });
    });
});

// ─── Test ────────────────────────────────────────────────────────────────────────────────────

describe('POST /ai/test', () => {
    it('{provider} checks the key in force with the free call and records a `key_test` row', async () => {
        saveKey('anthropic');
        const { status, body } = await call('POST', '/ai/test', { body: { provider: 'anthropic' } });
        assert.equal(status, 200);
        assert.equal(body.ok, true);
        assert.equal(body.provider, 'anthropic');
        assert.ok(body.elapsedMs >= 0);
        assert.equal(hits[0]!.headers['x-api-key'], FAKE_KEYS.anthropic);
        assert.deepEqual(usageOf('key_test').map((u) => [u.provider, u.outcome, u.usd]), [['anthropic', 'ok', 0]]);
        assert.equal(generated.length, 0, 'a key check sends no prompt');
        assert.equal(db.audits.length, 0, 'it writes no setting');
    });

    it('answers 200 with ok false and the kind when the provider refuses the saved key, and records that', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic.replace('ant1', 'zzzz'), true);
        const { status, body } = await call('POST', '/ai/test', { body: { provider: 'anthropic' } });
        assert.equal(status, 200);
        assert.equal(body.ok, false);
        assert.equal(body.error.kind, 'auth');
        assertNoKey(JSON.stringify(body) + logs.join('\n'), 'the answer and the log', [FAKE_KEYS.anthropic.replace('ant1', 'zzzz')]);
        assert.deepEqual(usageOf('key_test').map((u) => u.outcome), ['auth']);
    });

    it('with a key from the environment tests that one', async () => {
        process.env.OPENROUTER_API_KEY = FAKE_KEYS.openrouter;
        const { body } = await call('POST', '/ai/test', { body: { provider: 'openrouter' } });
        assert.equal(body.ok, true);
    });

    it('with GROQ_API_KEY tests Groq\'s model list with it', async () => {
        process.env.GROQ_API_KEY = FAKE_KEYS.groq;
        const { body } = await call('POST', '/ai/test', { body: { provider: 'groq' } });
        assert.equal(body.ok, true);
        assert.equal(hits[0]!.url, 'https://api.groq.com/openai/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.groq}`);
    });

    it('with META_MODEL_API_KEY tests Meta\'s model list with it', async () => {
        process.env.META_MODEL_API_KEY = FAKE_KEYS.meta;
        const { body } = await call('POST', '/ai/test', { body: { provider: 'meta' } });
        assert.equal(body.ok, true);
        assert.equal(hits[0]!.url, 'https://api.meta.ai/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.meta}`);
    });

    it('with BASETEN_API_KEY tests Baseten\'s model list with it', async () => {
        process.env.BASETEN_API_KEY = FAKE_KEYS.baseten;
        const { body } = await call('POST', '/ai/test', { body: { provider: 'baseten' } });
        assert.equal(body.ok, true);
        assert.equal(hits[0]!.url, 'https://inference.baseten.co/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.baseten}`);
    });

    it('lists only Meta\'s open models from Baseten\'s model list, for "Load models"', async () => {
        saveKey('baseten');
        const { status, body } = await call('GET', '/ai/models/baseten');
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'baseten', models: ['meta-models/muse-spark-open-1026'], truncated: false });
    });

    it('{purpose: dm} on a Baseten route that got in by hand is refused by name, with no call and no spend, and GET /ai shows the route as refused and still saved', async () => {
        saveKey('baseten');
        saveKey('anthropic');
        // Not through PUT /ai (which refuses it): a stored setting edited by hand, which `pickRoute` must still refuse.
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'baseten', model: 'meta-models/muse-spark-open-1026', effort: 'low' } }));
        const tested = await call('POST', '/ai/test', { body: { purpose: 'dm' } });
        assert.equal(tested.status, 200);
        assert.equal(tested.body.ok, false);
        assert.equal(tested.body.error.kind, 'no_provider');
        assert.match(tested.body.error.message, /The route for dm uses Baseten\. Baseten may answer only reel_index/);
        assert.equal(generated.length, 0, 'nothing reached a provider');
        assert.equal(hits.length, 0);
        const view = await call('GET', '/ai');
        const dm = view.body.purposes.find((p: any) => p.purpose === 'dm');
        assert.deepEqual(dm.saved, { provider: 'baseten', model: 'meta-models/muse-spark-open-1026', effort: 'low' });
        assert.equal(dm.resolved.error.kind, 'no_provider');
        assert.match(dm.resolved.error.message, /Baseten may answer only reel_index/);
    });

    it('{purpose: reel_index} tests the reel indexer\'s route on Baseten as `key_test`, priced from the table, with the 4 000 floor under the admin\'s 200', async () => {
        saveKey('baseten');
        db.setSetting('ai.routing', JSON.stringify({ reel_index: { provider: 'baseten', model: 'meta-models/muse-spark-open-1026', effort: 'low' } }));
        generateAnswer = () => ({
            json: { ok: true }, usage: { in: 15, out: 190 }, billed: [{ model: 'meta-models/muse-spark-open-1026', in: 15, out: 190 }],
            model: 'meta-models/muse-spark-open-1026', provider: 'baseten', stopReason: 'end_turn', elapsed_ms: 2700,
        });
        const { status, body } = await call('POST', '/ai/test', { body: { purpose: 'reel_index' } });
        assert.equal(status, 200);
        assert.deepEqual(
            { ok: body.ok, purpose: body.purpose, provider: body.provider, model: body.model, usage: body.usage, priced: body.priced },
            { ok: true, purpose: 'reel_index', provider: 'baseten', model: 'meta-models/muse-spark-open-1026', usage: { in: 15, out: 190 }, priced: true },
        );
        assert.equal(generated[0]!.provider, 'baseten');
        assert.equal(generated[0]!.apiKey, FAKE_KEYS.baseten);
        assert.equal(generated[0]!.maxTokens, 4000);
        assert.deepEqual(usageOf('key_test').map((u) => [u.provider, u.outcome, u.priced]), [['baseten', 'ok', true]]);
    });

    it('refuses a provider with no key, Custom with no base URL, an unknown provider, and a body that is neither or both', async () => {
        assert.match((await call('POST', '/ai/test', { body: { provider: 'openai' } })).body.error, /No API key is saved for OpenAI/);
        assert.match((await call('POST', '/ai/test', { body: { provider: 'groq' } })).body.error, /No API key is saved for Groq/);
        assert.match((await call('POST', '/ai/test', { body: { provider: 'meta' } })).body.error, /No API key is saved for Meta\./);
        assert.match((await call('POST', '/ai/test', { body: { provider: 'baseten' } })).body.error, /No API key is saved for Baseten\./);
        assert.match((await call('POST', '/ai/test', { body: { provider: 'custom' } })).body.error, /has no base URL saved/);
        for (const body of [{ provider: 'mistral' }, {}, { provider: 'anthropic', purpose: 'onboarding_draft' }, { purpose: 'key_test' }, { purpose: 'eval' }, { purpose: 'nope' }]) {
            assert.equal((await call('POST', '/ai/test', { body })).status, 400, JSON.stringify(body));
        }
        assert.equal(hits.length, 0);
        assert.equal(db.usage.length, 0);
    });

    it('{purpose} sends one tiny structured call down that route, as `key_test`, charged to no tenant', async () => {
        saveKey('anthropic');
        const { status, body } = await call('POST', '/ai/test', { body: { purpose: 'onboarding_draft' } });
        assert.equal(status, 200);
        assert.deepEqual(
            { ok: body.ok, purpose: body.purpose, provider: body.provider, model: body.model, usage: body.usage, usd: body.usd, priced: body.priced },
            { ok: true, purpose: 'onboarding_draft', provider: 'anthropic', model: 'claude-opus-5-5', usage: { in: 40, out: 6 }, usd: 0.00028, priced: true }
        );
        assert.equal(generated.length, 1);
        assert.deepEqual(generated[0]!.schema, { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] });
        assert.equal(generated[0]!.effort, 'low');
        assert.equal(generated[0]!.user, 'ping');
        const rows = usageOf('key_test');
        assert.equal(rows.length, 1);
        assert.deepEqual([rows[0]!.creator_id, rows[0]!.outcome, rows[0]!.input_tokens, rows[0]!.output_tokens], [null, 'ok', 40, 6]);
        assert.equal(usageOf('onboarding_draft').length, 0, 'it is a test, not onboarding spend');
    });

    it('{purpose: perception_dm} tests a Muse route as `key_test` on Meta, at effort low with the Muse floor of 4 000 tokens under the admin\'s 200, priced from the table', async () => {
        saveKey('meta');
        generateAnswer = () => ({
            json: { ok: true }, usage: { in: 15, out: 190 }, billed: [{ model: 'muse-spark-1.3', in: 15, out: 190 }],
            model: 'muse-spark-1.3', provider: 'meta', stopReason: 'end_turn', elapsed_ms: 3100,
        });
        const { status, body } = await call('POST', '/ai/test', { body: { purpose: 'perception_dm' } });
        assert.equal(status, 200);
        assert.deepEqual(
            { ok: body.ok, purpose: body.purpose, provider: body.provider, model: body.model, usage: body.usage, usd: body.usd, priced: body.priced },
            { ok: true, purpose: 'perception_dm', provider: 'meta', model: 'muse-spark-1.3', usage: { in: 15, out: 190 }, usd: 0.00082625, priced: true },
        );
        assert.equal(generated.length, 1);
        assert.equal(generated[0]!.provider, 'meta');
        assert.equal(generated[0]!.apiKey, FAKE_KEYS.meta);
        assert.equal(generated[0]!.effort, 'low');
        assert.equal(generated[0]!.maxTokens, 4000, 'the Test asks for 200; Muse Spark reasons first, so the layer raises it');
        assert.deepEqual(usageOf('key_test').map((u) => [u.provider, u.model, u.outcome, u.priced]), [['meta', 'muse-spark-1.3', 'ok', true]]);
        assert.equal(usageOf('perception_dm').length, 0, 'it is a test, not perception spend');
    });

    it('{purpose: perception_dm} with Meta\'s key missing says `no_provider` and never moves to another provider', async () => {
        saveKey('anthropic');
        const { body } = await call('POST', '/ai/test', { body: { purpose: 'perception_dm' } });
        assert.equal(body.ok, false);
        assert.equal(body.error.kind, 'no_provider');
        assert.equal(generated.length, 0);
    });

    it('goes through the router: a saved route\'s provider answers, and the Mac guard does not apply (no tenant)', async () => {
        saveKey('anthropic');
        db.setSetting('ai.routing', JSON.stringify({ tenant_monteur_think: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } }));
        const { body } = await call('POST', '/ai/test', { body: { purpose: 'tenant_monteur_think' } });
        assert.equal(body.ok, true);
        assert.equal(generated[0]!.model, 'claude-sonnet-5-5');
    });

    it('{purpose: dm} tests the DM route: the saved model answers, it is recorded as `key_test` and not as DM spend, and the Mac guard does not come into it', async () => {
        saveKey('anthropic');
        db.setSetting('ai.routing', JSON.stringify({ dm: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } }));
        const { status, body } = await call('POST', '/ai/test', { body: { purpose: 'dm' } });
        assert.equal(status, 200);
        assert.deepEqual({ ok: body.ok, purpose: body.purpose, provider: body.provider }, { ok: true, purpose: 'dm', provider: 'anthropic' });
        assert.equal(generated.length, 1);
        assert.equal(generated[0]!.model, 'claude-sonnet-5-5');
        assert.equal(usageOf('key_test').length, 1);
        assert.equal(usageOf('dm').length, 0, 'a Test is not DM spend');
        assert.equal(usageOf('eval').length, 0);
    });

    it('reports a failed route test as ok false with the kind, and records what it was billed', async () => {
        saveKey('anthropic');
        generateAnswer = () => { throw new AiError({ kind: 'refusal', provider: 'anthropic', model: 'claude-opus-5-5', message: 'declined', usage: { in: 40, out: 0 } }); };
        const { status, body } = await call('POST', '/ai/test', { body: { purpose: 'onboarding_draft' } });
        assert.equal(status, 200);
        assert.equal(body.ok, false);
        assert.equal(body.error.kind, 'refusal');
        assert.deepEqual(usageOf('key_test').map((u) => [u.outcome, u.input_tokens]), [['refusal', 40]]);
    });

    it('is refused by the budget like any call, and says so', async () => {
        saveKey('anthropic');
        db.setSetting('ai.budget.daily_usd', '0');
        const { status, body } = await call('POST', '/ai/test', { body: { purpose: 'onboarding_draft' } });
        assert.equal(status, 200);
        assert.equal(body.ok, false);
        assert.equal(body.error.kind, 'budget');
        assert.equal(generated.length, 0);
        assert.deepEqual(usageOf('key_test').map((u) => u.outcome), ['budget']);
    });

    it('with no provider at all says `no_provider`, and records it', async () => {
        const { body } = await call('POST', '/ai/test', { body: { purpose: 'onboarding_draft' } });
        assert.equal(body.ok, false);
        assert.equal(body.error.kind, 'no_provider');
        assert.deepEqual(usageOf('key_test').map((u) => u.outcome), ['no_provider']);
    });
});

// ─── Models, usage ───────────────────────────────────────────────────────────────────────────

describe('GET /ai/models/:provider', () => {
    it('lists the provider\'s models with the saved key', async () => {
        saveKey('anthropic');
        const { status, body } = await call('GET', '/ai/models/anthropic');
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'anthropic', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'], truncated: false });
        assert.equal(hits[0]!.url, 'https://api.anthropic.com/v1/models?limit=1000');
        assert.equal(usageOf('key_test').length, 0, 'listing is not a test');
    });

    it('lists Groq\'s chat models with the saved key, without its speech and text-to-speech models', async () => {
        saveKey('groq');
        const { status, body } = await call('GET', '/ai/models/groq');
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'groq', models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.3-70b-versatile'], truncated: false });
        assert.equal(hits[0]!.url, 'https://api.groq.com/openai/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.groq}`);
        assert.equal((await call('GET', '/ai/models/openrouter')).status, 400, 'a provider with no key is still refused');
    });

    it('lists Meta\'s Standard chat models with the saved key: not the Contributor twins that train on what is sent, not its image, speech or segmentation models', async () => {
        saveKey('meta');
        const { status, body } = await call('GET', '/ai/models/meta');
        assert.equal(status, 200);
        assert.deepEqual(body, { provider: 'meta', models: ['muse-wonder-1.0', 'muse-spark-1.3', 'muse-spark-1.2', 'muse-spark-1.1'], truncated: false });
        assert.equal(hits[0]!.url, 'https://api.meta.ai/v1/models');
        assert.equal(hits[0]!.headers.authorization, `Bearer ${FAKE_KEYS.meta}`);
        assert.ok(!JSON.stringify(body).includes('contributor'));
    });

    it('lists Custom\'s models from its saved base URL', async () => {
        await call('PUT', '/ai', { body: { providers: { custom: { baseUrl: 'https://llm.example.com/v1' } } } });
        assert.deepEqual((await call('GET', '/ai/models/custom')).body.models, ['my-model', 'other-model']);
    });

    it('is 400 with the provider\'s reason when it refuses the key, 502 when it cannot be reached, and never 401', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic.replace('ant1', 'zzzz'), true);
        const refused = await call('GET', '/ai/models/anthropic');
        assert.equal(refused.status, 400);
        assert.equal(refused.body.kind, 'auth');
        assertNoKey(JSON.stringify(refused.body), 'the refusal', [FAKE_KEYS.anthropic.replace('ant1', 'zzzz')]);
        providerAnswer = () => jsonResponse(500, {});
        assert.equal((await call('GET', '/ai/models/anthropic')).status, 502);
    });

    it('is 400 for a provider with no key or no base URL, and 404 for one that does not exist', async () => {
        assert.equal((await call('GET', '/ai/models/openai')).status, 400);
        assert.equal((await call('GET', '/ai/models/custom')).status, 400);
        assert.equal((await call('GET', '/ai/models/mistral')).status, 404);
        assert.equal(hits.length, 0);
    });

    it('caps a very long list', async () => {
        saveKey('anthropic');
        providerAnswer = () => jsonResponse(200, { data: Array.from({ length: 700 }, (_, i) => ({ id: `model-${i}` })) });
        const { body } = await call('GET', '/ai/models/anthropic');
        assert.equal(body.models.length, 500);
        assert.equal(body.truncated, true);
    });
});

describe('GET /ai/usage', () => {
    it('summarises today and the month, by purpose and tenant', async () => {
        db.seedUsage({ usd: 0.25, at: new Date(), creator_id: OWNER, purpose: 'onboarding_draft', input_tokens: 100, output_tokens: 50 });
        const { status, body } = await call('GET', '/ai/usage');
        assert.equal(status, 200);
        assert.equal(body.period, 'day');
        assert.equal(body.today.calls, 1);
        assert.equal(body.today.usd, 0.25);
        assert.deepEqual(body.byPurpose.map((p: any) => [p.purpose, p.calls, p.tokensIn, p.tokensOut]), [['onboarding_draft', 1, 100, 50]]);
        assert.equal(body.byTenant[0].creatorId, OWNER);
        assert.equal((await call('GET', '/ai/usage', { query: { period: 'month' } })).body.period, 'month');
        assert.equal((await call('GET', '/ai/usage', { query: { period: 'year' } })).body.period, 'day', 'anything else is the day');
    });
});

// ─── Masking, end to end ─────────────────────────────────────────────────────────────────────

describe('masking: no key is ever in a response, a log, an audit row or a usage row', () => {
    it('after every key has been saved, tested, listed, replaced and removed, and a provider has echoed each back', async () => {
        providerAnswer = (hit) => {
            // A provider that repeats whatever credential it was sent in its own error text.
            const sent = hit.headers['x-api-key'] ?? hit.headers.authorization ?? '';
            if (sent.includes('wrong')) return jsonResponse(401, { error: { message: `Incorrect API key provided: ${sent}` } });
            return goodProvider(hit);
        };
        const bodies: unknown[] = [];
        // The status is asserted too: a response the guard withheld is a 500 with no key in it, which would pass a search for a key.
        const send = async (method: string, url: string, body?: unknown, expected = 200) => {
            const r = await call(method, url, { body });
            assert.equal(r.status, expected, `${method} ${url}: ${JSON.stringify(r.body).slice(0, 200)}`);
            bodies.push(r.body);
            return r;
        };

        await send('PUT', '/ai', { providers: { custom: { baseUrl: 'https://llm.example.com/v1' } } });
        await send('PUT', '/ai/keys/anthropic', { apiKey: FAKE_KEYS.anthropic });
        await send('PUT', '/ai/keys/openrouter', { apiKey: FAKE_KEYS.openrouter });
        await send('PUT', '/ai/keys/groq', { apiKey: FAKE_KEYS.groq });
        await send('PUT', '/ai/keys/custom', { apiKey: FAKE_KEYS.custom });
        await send('PUT', '/ai/keys/anthropic', { apiKey: FAKE_KEYS.anthropic.replace('ant1', 'wrong') }, 400);
        await send('PUT', '/ai/keys/groq', { apiKey: FAKE_KEYS.groq.replace('grq6', 'wrong') }, 400);
        saveKey('gemini');
        saveKey('openai');
        process.env.OPENAI_API_KEY = FAKE_KEYS.openai;
        await send('GET', '/ai');
        await send('POST', '/ai/test', { provider: 'anthropic' });
        await send('POST', '/ai/test', { provider: 'openrouter' });
        await send('POST', '/ai/test', { provider: 'groq' });
        await send('POST', '/ai/test', { purpose: 'onboarding_draft' });
        await send('GET', '/ai/models/anthropic');
        await send('GET', '/ai/models/groq');
        await send('GET', '/ai/models/custom');
        await send('GET', '/ai/usage');
        await send('PUT', '/ai/keys/gemini', { apiKey: FAKE_KEYS.gemini }, 400);
        await send('PUT', '/ai', { routing: { tenant_studio: { provider: 'openai', model: 'gpt-6-astra' } }, prices: { 'gpt-6-astra': { in: 2, out: 8 } } });
        await send('DELETE', '/ai/keys/anthropic');
        await send('DELETE', '/ai/keys/custom');
        await send('DELETE', '/ai/keys/groq');
        await send('GET', '/ai');

        const everything = [...Object.values(FAKE_KEYS), FAKE_KEYS.anthropic.replace('ant1', 'wrong'), FAKE_KEYS.groq.replace('grq6', 'wrong')];
        assert.ok(bodies.length >= 22);
        assertNoKey(JSON.stringify(bodies), 'a response', everything);
        assertNoKey(logs.join('\n'), 'the log', everything);
        assertNoKey(JSON.stringify(db.audits), 'an audit row', everything);
        assertNoKey(JSON.stringify(db.usage), 'a usage row', everything);
        // The rows that hold a key hold it encrypted, never as it was pasted.
        for (const [name, row] of db.settings) assertNoKey(row.value, `setting ${name}`, everything);
        assert.ok(db.audits.length >= 6, 'and the writes were audited');
    });

    it('withholds a response that would carry a saved key, instead of sending it (a key typed into a field that is shown back)', async () => {
        saveKey('anthropic');
        // A key-shaped string is also a legal model id. Saved as one, it would be shown back by every view.
        const put = await call('PUT', '/ai', { body: { providers: { anthropic: { defaultModel: FAKE_KEYS.anthropic } } } });
        assert.equal(put.status, 500);
        assert.match(put.body.error, /withheld/);
        assertNoKey(JSON.stringify(put.body), 'the withheld response');
        assert.ok(logs.some((l) => l.includes('admin.ai_response_blocked')));
        const get = await call('GET', '/ai');
        assert.equal(get.status, 500);
        assertNoKey(JSON.stringify(get.body), 'the next response');
        // Clearing the field puts the screen back.
        const clear = await call('PUT', '/ai', { body: { providers: { anthropic: { defaultModel: null } } } });
        assert.equal(clear.status, 200);
        assertNoKey(JSON.stringify(clear.body), 'the cleared view');
    });
});
