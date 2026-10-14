/**
 * What Gemini can return, versus what Meta will accept.
 *
 * `responseSchema` is a strong constraint and not a guarantee, and this pipeline had no layer
 * between `JSON.parse` of model output and the Meta Send API — the parse was annotated
 * `AiResponse` and nothing checked that claim. Each case below produced a Meta rejection or a
 * TypeError from inside the success path, four months after the last real DM went through.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink, type LogLevel } from '../utils/log.js';
import {
    coerceAiResponse, decideAgent, DEFAULT_MODEL, dmResponseSchema, dmSystemInstruction, GEMINI_FIRST_ATTEMPT_MS, GEMINI_RETRY_MIN_BUDGET_MS,
    GEMINI_RETRY_WAIT_MAX_MS, GEMINI_RETRY_WAIT_MIN_MS, GEMINI_TIMEOUT_MS, generateAiResponse, isTransientGeminiError, setGeminiClock,
    type DmContext, resolveModel, starterPersona, SUPPORTED_MODELS,
} from './ai.js';
import { generateDmReply } from './dmEngine.js';
import { setAiCaller } from './aiProviders/generate.js';
import { goldenPath } from './profile/golden.js';
import { legacyContext } from './profile/context.js';
import { ELAMIR_AGENT } from './studio/testFixtures.js';
import { STUDIO_MODELS } from './studio/generate.js';
import { toMetaMessage } from '../webhook/meta-payload.js';

// The downgrade path logs a warning by design; keep the assertions readable.
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

describe('coerceAiResponse', () => {
    it('passes a well-formed text reply through unchanged', () => {
        assert.deepEqual(coerceAiResponse({ message_type: 'text', text: 'مرحبا' }), {
            message_type: 'text',
            text: 'مرحبا',
        });
    });

    it('keeps a well-formed carousel', () => {
        const result = coerceAiResponse({
            message_type: 'carousel',
            text: 'اختر',
            carousel_elements: [{ title: 'كورس' }, { title: 'كورس 2' }],
        });
        assert.equal(result.message_type, 'carousel');
        assert.equal(result.carousel_elements?.length, 2);
    });

    it('downgrades a carousel with no elements to text', () => {
        // The bug: `toMetaMessage` built `elements: undefined`, and Meta answered "param
        // message must be a non-empty object" — an error about the send, for a fault in the
        // model's reply.
        const result = coerceAiResponse({ message_type: 'carousel', text: 'اختر من التالي' });

        assert.equal(result.message_type, 'text');
        assert.equal(result.text, 'اختر من التالي');
        assert.deepEqual(toMetaMessage(result), { text: 'اختر من التالي' });
    });

    it('downgrades a carousel whose elements are all unusable', () => {
        const result = coerceAiResponse({
            message_type: 'carousel',
            text: 'حسنا',
            carousel_elements: [{ subtitle: 'no title' }, null, 'nonsense'],
        });
        assert.equal(result.message_type, 'text');
    });

    it('downgrades a quick_reply with no quick replies', () => {
        const result = coerceAiResponse({ message_type: 'quick_reply', text: 'نعم أو لا؟' });

        assert.equal(result.message_type, 'text');
        assert.deepEqual(toMetaMessage(result), { text: 'نعم أو لا؟' });
    });

    it('drops individual quick replies that are missing a title or payload', () => {
        // Meta rejects the whole message if any one button is malformed, so keeping the good
        // ones is the difference between a usable reply and none.
        const result = coerceAiResponse({
            message_type: 'quick_reply',
            text: 'اختر',
            quick_replies: [
                { title: 'كورس', payload: 'COURSE' },
                { title: 'no payload' },
                { payload: 'NO_TITLE' },
                { title: 7, payload: 'NUMERIC_TITLE' },
            ],
        });

        assert.equal(result.message_type, 'quick_reply');
        assert.deepEqual(result.quick_replies, [{ title: 'كورس', payload: 'COURSE' }]);
    });

    it('coerces a non-string text rather than throwing on .substring', () => {
        // `enforceMetaConstraints` called `response.text.substring(0, 1000)` directly, so a
        // numeric `text` threw a TypeError from the success path and was logged as
        // `dm.pipeline_failed` with a message that never mentioned Gemini.
        assert.equal(coerceAiResponse({ message_type: 'text', text: 42 }).text, '42');
        assert.equal(coerceAiResponse({ message_type: 'text', text: null }).text, '');
    });

    it('refuses to stringify an object into a customer-facing reply', () => {
        // `String({})` is "[object Object]". Sending that is worse than an empty reply, which
        // the caller turns into a failure.
        assert.equal(coerceAiResponse({ message_type: 'text', text: { nested: true } }).text, '');
    });

    it('falls back to text for a message_type the model invented', () => {
        const result = coerceAiResponse({ message_type: 'video_template', text: 'أهلا' });
        assert.deepEqual(result, { message_type: 'text', text: 'أهلا' });
    });

    it('survives nothing at all', () => {
        for (const input of [undefined, null, {}, 'a string', 42, []]) {
            const result = coerceAiResponse(input);
            assert.equal(result.message_type, 'text', `input ${JSON.stringify(input)}`);
            assert.equal(typeof result.text, 'string');
        }
    });
});

/**
 * Whether the agent is allowed to speak at all.
 *
 * Both halves of this rule have shipped broken. The disabled case was fixed by selecting
 * `is_active` instead of filtering on it — before that, a switched-off agent returned zero
 * rows and the fallback answered the customer anyway. The unconfigured case was left
 * substituting, and it was worse: a tenant created through `POST /api/admin/tenants` had no
 * `ai_agents` row, so there was nothing for the off switch to be false on, and their bot
 * answered their real customers in a persona nobody chose while `dm.sent` logged success.
 *
 * Neither path had a test. This is that test.
 */
describe('decideAgent', () => {
    const configured = {
        is_active: true,
        system_prompt: 'a real persona',
        knowledge_base: 'real facts',
        model: DEFAULT_MODEL,
        temperature: 0.2,
    };

    it('lets a configured, enabled agent speak with its own settings', () => {
        const decision = decideAgent(configured, false);

        assert.equal(decision.speak, true);
        assert.equal(decision.speak && decision.agent.system_prompt, 'a real persona');
        // A deliberate temperature must survive: `|| 0.7` used to turn a chosen 0 — picked
        // precisely to stop the agent improvising about prices — back into 0.7.
        assert.equal(decision.speak && decision.agent.temperature, 0.2);
    });

    it('says nothing for a creator with no agent row at all', () => {
        // The bug. There is no `is_active` to be false on, so the disabled branch cannot help,
        // and substituting a default persona means answering a stranger on a customer's
        // account with words nobody approved.
        assert.deepEqual(decideAgent(null, false), { speak: false, reason: 'unconfigured' });
        assert.deepEqual(decideAgent(undefined, false), { speak: false, reason: 'unconfigured' });
    });

    it('says nothing for a disabled agent', () => {
        assert.deepEqual(decideAgent({ ...configured, is_active: false }, false),
            { speak: false, reason: 'disabled' });
    });

    it('never substitutes a fallback persona on a real customer path', () => {
        // The specific regression to guard: whatever else changes here, a real inbound DM must
        // never be answered with a prompt the tenant did not write.
        for (const stored of [null, undefined, { ...configured, is_active: false }]) {
            const decision = decideAgent(stored, false);
            assert.equal(decision.speak, false, JSON.stringify(stored));
        }
    });

    it('distinguishes unconfigured from disabled, because the fixes differ', () => {
        // "Nobody has set this up" sends an operator to AI Settings; "somebody turned it off"
        // means leave it alone. Collapsing them is what made the original bug invisible.
        assert.notEqual(
            (decideAgent(null, false) as { reason: string }).reason,
            (decideAgent({ ...configured, is_active: false }, false) as { reason: string }).reason
        );
    });

    it('still answers in the sandbox when nothing is configured', () => {
        // The dashboard's test box has to work before an agent exists — trying a prompt out is
        // how you decide what to configure. Its fallback persona never reaches a real person.
        const decision = decideAgent(null, true);

        assert.equal(decision.speak, true);
        assert.equal(decision.speak && typeof decision.agent.system_prompt, 'string');
    });

    it('still answers in the sandbox when the agent is switched off', () => {
        // Otherwise the toggle you are about to flip silently breaks the tool that helps you
        // decide whether to flip it.
        const decision = decideAgent({ ...configured, is_active: false }, true);

        assert.equal(decision.speak, true);
        assert.equal(decision.speak && decision.agent.system_prompt, 'a real persona');
    });
});

/** Runs `fn` with the log captured, and returns the parsed lines. */
function captureLog(fn: () => void): Array<Record<string, unknown>> {
    const lines: Array<Record<string, unknown>> = [];
    const previous = setLogSink((_level, line) => { lines.push(JSON.parse(line)); });
    try {
        fn();
    } finally {
        setLogSink(previous);
    }
    return lines;
}

/**
 * Which model a stored `ai_agents.model` actually runs on.
 *
 * The supported list is all that stands between a dashboard-settable string and the request
 * path, and it is also what went stale: it kept the Gemini 1.5 and 2.0 models after Google
 * stopped serving them, so a row naming one went out as-is and every DM on it failed.
 */
describe('resolveModel', () => {
    it('runs every supported model as stored', () => {
        for (const model of SUPPORTED_MODELS) assert.equal(resolveModel(model), model);
    });

    it('answers a retired model with the default, and says so in the log', () => {
        // Every one of these was on the list until 2026-09-25, and the dashboard picker
        // offered gemini-1.5-flash by name. Google answers 404 for them now.
        for (const retired of ['gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro', 'gemini-2.0-flash', 'gemini-2.0-flash-lite']) {
            const lines = captureLog(() => assert.equal(resolveModel(retired), DEFAULT_MODEL, retired));
            assert.deepEqual(
                lines.map((l) => [l.level, l.event, l.configured, l.fallback]),
                [['warn', 'ai.unknown_model', retired, DEFAULT_MODEL]],
                'a stale row must be findable in the logs, not silently papered over',
            );
        }
    });

    it('answers a model cut from the list on 2026-10-04 with the default, and says so', () => {
        // Still served by Google, but 404 for this key (2.5 Pro, 2.5 Flash-Lite), looping in
        // structured replies (the Flash-Lites), free-tier-less (3.1 Pro) or redundant (3.6, 3.7).
        for (const cut of ['gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-3.7-flash']) {
            const lines = captureLog(() => assert.equal(resolveModel(cut), DEFAULT_MODEL, cut));
            assert.deepEqual(lines.map((l) => [l.event, l.configured]), [['ai.unknown_model', cut]]);
        }
    });

    it('falls back without a warning when no model is stored', () => {
        // NULL is what the column holds when nobody chose; a warning on every DM would be noise.
        for (const nothing of [null, undefined, '']) {
            const lines = captureLog(() => assert.equal(resolveModel(nothing), DEFAULT_MODEL));
            assert.deepEqual(lines, [], JSON.stringify(nothing));
        }
    });

    it('falls back on anything that is not a supported model id', () => {
        for (const junk of ['Gemini 2.5 Flash', 'GEMINI-2.5-FLASH', 42, { model: DEFAULT_MODEL }]) {
            captureLog(() => assert.equal(resolveModel(junk), DEFAULT_MODEL, JSON.stringify(junk)));
        }
    });
});

describe('DEFAULT_MODEL', () => {
    it('is itself on the supported list', () => {
        assert.ok(SUPPORTED_MODELS.has(DEFAULT_MODEL));
    });

    it('is a model the Studio never calls, so a carousel cannot spend a reply', () => {
        // Gemini's limits are per project and per model, and on the free tier a Flash model
        // allows about 20 requests a day. On 2026-09-24 the indexer ran on the DM bot's model
        // and spent its allowance, and the bot had nothing left for the day
        // (docs/STUDIO_GUIDE.md §8). The writer's chain is importable; the indexer's lives in
        // the Studio worker, in another repository, so it is copied from STUDIO.md §9.
        const indexerModels = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview'];
        assert.ok(!STUDIO_MODELS.includes(DEFAULT_MODEL), `${DEFAULT_MODEL} is in the Studio writer's chain`);
        assert.ok(!indexerModels.includes(DEFAULT_MODEL), `${DEFAULT_MODEL} is in the Studio indexer's chain`);
    });
});

/**
 * P8: the DM bot's wording is the tenant's. The goldens pin the owner's bytes (`profile/golden.test.ts`) and the second
 * tenants are in `profile/dmComments.test.ts`; this holds what is specific to `ai.ts`: the schema, the persona and the
 * sandbox fallback are functions of the DM context and nothing else.
 */
describe('the DM wording is a function of the DM context', () => {
    const ctx = (code: 'ar' | 'en', register: 'gulf' | 'msa' | 'egyptian' | 'levantine' | null, offerKind: DmContext['who']['offerKind']): DmContext => ({
        language: { code, register, digits: code === 'ar' ? 'arabic-indic' : 'latin', dir: code === 'ar' ? 'rtl' : 'ltr' },
        who: { kind: null, role: '', niche: '', domain: 'general', offerKind },
    });

    it('dmResponseSchema asks for the language of the surface and names the button for what is sold', () => {
        const text = (c: DmContext): string => dmResponseSchema(c).properties.text.description;
        const payload = (c: DmContext): string => dmResponseSchema(c).properties.quick_replies.items.properties.payload.description;
        assert.match(text(ctx('ar', 'gulf', 'course')), /Must be written in Arabic if appropriate\.$/);
        assert.match(text(ctx('en', null, 'course')), /Must be written in English if appropriate\.$/);
        assert.match(payload(ctx('ar', 'gulf', 'course')), /e\.g\., GO_TO_COURSE_1\.$/);
        for (const kind of ['program', 'product', 'service', 'coaching', 'mixed', null] as const) {
            assert.match(payload(ctx('en', null, kind)), /e\.g\., GO_TO_OFFER_1\.$/, String(kind));
        }
    });

    it('dmResponseSchema changes nothing else: the same structure whatever the context', () => {
        const strip = (c: DmContext): string => JSON.stringify(dmResponseSchema(c)).replace(/Arabic|English/, 'LANG').replace(/GO_TO_(COURSE|OFFER)_1/, 'GO_TO_X_1');
        assert.equal(strip(ctx('ar', 'gulf', 'course')), strip(ctx('en', null, 'product')));
        assert.equal(strip(ctx('ar', 'msa', null)), strip(ctx('ar', 'egyptian', 'service')));
    });

    it('dmSystemInstruction keeps the persona and the knowledge base as they are, verbatim, in every language', () => {
        for (const c of [ctx('ar', 'gulf', 'course'), ctx('ar', 'levantine', 'product'), ctx('en', null, 'program')]) {
            const text = dmSystemInstruction('PERSONA', 'KB\nLINE 2', c);
            assert.ok(text.startsWith('PERSONA\n\n=== '), c.language.code);
            assert.ok(text.includes('===\nKB\nLINE 2\n\n=== '), c.language.code);
            assert.equal(text.split('\n').filter((line) => /^[123]\. /.test(line)).length, 3, 'three rules');
        }
        assert.match(dmSystemInstruction('p', null, ctx('en', null, 'program')), /===\nnull\n\n/, 'a null knowledge base is interpolated as it always was');
    });

    it('starterPersona is in the language asked for', () => {
        assert.equal(starterPersona('ar'), 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.');
        assert.equal(starterPersona('en'), 'You are a smart assistant who answers followers\' questions in English.');
    });

    it('the sandbox\'s starter persona follows the language it is told, Arabic when told nothing; a real customer path never gets one', () => {
        const persona = (d: ReturnType<typeof decideAgent>): string | undefined => (d.speak ? d.agent.system_prompt : undefined);
        assert.equal(persona(decideAgent(null, true, 'en')), starterPersona('en'));
        assert.equal(persona(decideAgent(null, true, 'ar')), starterPersona('ar'));
        assert.equal(persona(decideAgent(null, true)), starterPersona('ar'));
        assert.deepEqual(decideAgent(null, false, 'en'), { speak: false, reason: 'unconfigured' });
    });
});


/**
 * DM plan S3: the Gemini engine is the call the bot has always made. A tenant on engine `gemini` (every row, until somebody flips it)
 * must send Gemini exactly the request it sent before `ai_agents.engine` existed: the URL, the body down to the byte, the key header
 * and the timeout. Pinned here against the owner's goldens (the system instruction and the response schema he is served), and against
 * `generateAiResponse` called directly, which is what the pipeline called before the dispatch was put in front of it.
 */
describe('the gemini engine sends Gemini the request it always has (DM plan S3)', () => {
    const TENANT = '55555555-5555-4555-8555-555555555555';
    const CONVERSATION = '66666666-6666-4666-8666-666666666666';
    const ctx = legacyContext('dm');
    const agent = { is_active: true, ...ELAMIR_AGENT, model: 'gemini-2.5-flash', temperature: 0.7 };

    let history: { direction: string; text: string }[];
    let posts: { url: string; payload: unknown; config: unknown }[];
    let layerCalled: number;
    let undo: (() => void)[];

    beforeEach(() => {
        history = [];
        posts = [];
        layerCalled = 0;
        const query = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            // The engine read is answered by a row that says `gemini`; the agent read by the same row without the engine columns.
            if (/^SELECT engine, gemini_fallback FROM ai_agents/.test(sql)) return { rows: [{ engine: 'gemini', gemini_fallback: true }], rowCount: 1 };
            if (/FROM ai_agents WHERE creator_id = \$1/.test(sql)) return { rows: [agent], rowCount: 1 };
            // A copy: both callers `.reverse()` what they are handed, and the real driver hands each call its own array.
            if (/SELECT direction, text/.test(sql)) return { rows: [...history], rowCount: history.length };
            if (/FROM app_settings WHERE key/.test(sql)) return { rows: [], rowCount: 0 };
            throw new Error(`no result arranged for SQL: ${sql}`);
        };
        const post = axios.post;
        (axios as any).post = async (url: string, payload: unknown, config: unknown) => {
            posts.push({ url, payload, config });
            return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'أهلاً' }) }] } }] } };
        };
        const caller = setAiCaller(async () => { layerCalled++; throw new Error('the layer must not be called by the gemini engine'); });
        const key = process.env.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = 'test-gemini-key';
        undo = [
            () => { (pool as unknown as { query: unknown }).query = query; },
            () => { (axios as any).post = post; },
            () => { setAiCaller(caller); },
            () => { if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; },
        ];
    });
    afterEach(() => { for (const f of undo) f(); });

    const golden = (name: string, ext: 'txt' | 'json'): string => readFileSync(goldenPath(name, ext), 'utf8');

    it('is the pinned request: the endpoint, the key in a header, the first attempt\'s 18 s deadline, and a body built from the goldens', async () => {
        const reply = await generateDmReply(CONVERSATION, 'كم السعر؟', TENANT, undefined, ctx);

        assert.equal(reply.kind, 'reply');
        assert.equal(posts.length, 1);
        assert.equal(layerCalled, 0);
        const [call] = posts;
        assert.equal(call!.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
        assert.deepEqual(call!.config, { headers: { 'x-goog-api-key': 'test-gemini-key' }, timeout: GEMINI_FIRST_ATTEMPT_MS });
        assert.equal(GEMINI_FIRST_ATTEMPT_MS, 18_000);
        const expectedBody = {
            contents: [{ role: 'user', parts: [{ text: 'كم السعر؟' }] }],
            systemInstruction: { parts: [{ text: golden('dm.system-instruction', 'txt') }] },
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: JSON.parse(golden('dm.response-schema', 'json')),
                temperature: 0.7,
            },
        };
        assert.equal(JSON.stringify(call!.payload), JSON.stringify(expectedBody), 'the bytes of the body, key order included');
    });

    it('is, for every shape of conversation, the request `generateAiResponse` makes on its own', async () => {
        const conversations: { direction: string; text: string }[][] = [
            [],
            [{ direction: 'inbound', text: 'سؤال' }],
            [{ direction: 'inbound', text: 'سؤال' }, { direction: 'outbound', text: 'جواب' }],
            Array.from({ length: 8 }, (_, i) => ({ direction: i % 2 ? 'outbound' : 'inbound', text: `رسالة ${i}` })),
        ];
        for (const rows of conversations) {
            history = rows;
            posts = [];
            await generateDmReply(CONVERSATION, 'سؤال', TENANT, undefined, ctx);
            const viaDispatch = JSON.stringify(posts);
            posts = [];
            await generateAiResponse(CONVERSATION, 'سؤال', TENANT, undefined, ctx);
            assert.equal(viaDispatch, JSON.stringify(posts), `${rows.length} stored messages`);
        }
    });

    it('is the sandbox\'s request too: the model and temperature on screen reach Gemini, and the engine\'s own fields do not', async () => {
        await generateDmReply(CONVERSATION, 'x', TENANT, { model: 'gemini-3.8-flash', temperature: 0, engine: 'gemini', gemini_fallback: false }, ctx);
        const direct = posts[0]!;
        posts = [];
        await generateAiResponse(CONVERSATION, 'x', TENANT, { model: 'gemini-3.8-flash', temperature: 0 }, ctx);
        assert.equal(JSON.stringify(posts), JSON.stringify([direct]));
        assert.match(direct.url, /models\/gemini-3\.8-flash:generateContent$/);
    });
});


/**
 * Gemini 2.5 Flash answers 503 or hangs now and then. Inside ONE `generateAiResponse` call a transient failure is retried once,
 * quickly, so the DM is answered in seconds rather than after the job runner's backoff and the worker's next poll (100-175 s on
 * 2026-10-14). The whole exchange, retry included, stays inside the 30 s the call always had. The clock is simulated: the stubbed
 * `axios.post` advances it by however long the attempt "took", and `sleep` advances it by the wait, so no test waits for real.
 */
describe('generateAiResponse retries a transient Gemini failure once, inside the 30 s budget', () => {
    const TENANT = '77777777-7777-4777-8777-777777777777';
    const CONVERSATION = '88888888-8888-4888-8888-888888888888';
    const KEY = 'test-gemini-key';
    const ctx = legacyContext('dm');
    const agent = { is_active: true, ...ELAMIR_AGENT, model: 'gemini-2.5-flash', temperature: 0.7 };
    const OK = { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'أهلاً' }) }] } }] } };

    /** What an attempt does: hangs until its own timeout, or takes `ms` of simulated time, then resolves with `ok` or throws `fail`. */
    type Step = { hang?: true; ms?: number; ok?: unknown; fail?: unknown };
    type PostConfig = { headers: Record<string, string>; timeout: number };

    /** What axios throws on a non-2xx: the response, plus the request it would be rude to log (the URL and the key header). */
    const httpError = (status: number, message = 'The model is overloaded. Please try again later.') =>
        Object.assign(new Error(`Request failed with status code ${status}`), {
            code: status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST',
            response: { status, data: { error: { code: status, status: status === 503 ? 'UNAVAILABLE' : 'INVALID_ARGUMENT', message } } },
            config: { url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', headers: { 'x-goog-api-key': KEY } },
        });
    const netError = (code: string, message: string) =>
        Object.assign(new Error(message), { code, config: { headers: { 'x-goog-api-key': KEY } } });
    const timeoutError = (ms: number) => netError('ECONNABORTED', `timeout of ${ms}ms exceeded`);

    let t: number;
    let sleeps: number[];
    let random: number;
    let steps: Step[];
    let posts: { url: string; payload: unknown; config: PostConfig }[];
    let lines: { level: LogLevel; line: string }[];
    let undo: (() => void)[];

    beforeEach(() => {
        t = 1_000_000;
        sleeps = [];
        random = 0.5;
        steps = [];
        posts = [];
        lines = [];
        const query = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            if (/FROM ai_agents WHERE creator_id = \$1/.test(sql)) return { rows: [agent], rowCount: 1 };
            if (/SELECT direction, text/.test(sql)) return { rows: [], rowCount: 0 };
            if (/FROM app_settings WHERE key/.test(sql)) return { rows: [], rowCount: 0 };
            throw new Error(`no result arranged for SQL: ${sql}`);
        };
        const post = axios.post;
        (axios as any).post = async (url: string, payload: unknown, config: PostConfig) => {
            posts.push({ url, payload, config });
            const step = steps.shift();
            if (!step) throw new Error('the test arranged no more attempts');
            if (step.hang) {
                t += config.timeout;
                throw timeoutError(config.timeout);
            }
            t += step.ms ?? 0;
            if (step.fail) throw step.fail;
            return step.ok ?? OK;
        };
        const clock = setGeminiClock({
            now: () => t,
            sleep: async (ms) => { sleeps.push(ms); t += ms; },
            random: () => random,
        });
        const sink = setLogSink((level, line) => { lines.push({ level, line }); });
        const key = process.env.GEMINI_API_KEY;
        process.env.GEMINI_API_KEY = KEY;
        undo = [
            () => { (pool as unknown as { query: unknown }).query = query; },
            () => { (axios as any).post = post; },
            () => { setGeminiClock(clock); },
            () => { setLogSink(sink); },
            () => { if (key === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = key; },
        ];
    });
    afterEach(() => { for (const f of undo) f(); });

    const generate = (overrides?: Parameters<typeof generateAiResponse>[3]) =>
        generateAiResponse(CONVERSATION, 'كم السعر؟', TENANT, overrides, ctx);
    const retryLines = () => lines.map((l) => JSON.parse(l.line)).filter((l) => l.event === 'ai.gemini_retry');

    it('503 then success: one retry, and the success is the answer', async () => {
        steps = [{ ms: 400, fail: httpError(503) }, { ms: 3_000 }];
        const reply = await generate();

        assert.deepEqual(reply, { message_type: 'text', text: 'أهلاً' });
        assert.equal(posts.length, 2);
        assert.equal(sleeps.length, 1);
        assert.equal(retryLines().length, 1);
    });

    for (const status of [500, 503, 429]) {
        it(`HTTP ${status} is retried`, async () => {
            steps = [{ ms: 200, fail: httpError(status) }, { ms: 2_000 }];
            const reply = await generate();
            assert.equal(reply?.text, 'أهلاً');
            assert.equal(posts.length, 2);
        });
    }

    it('503 twice: two calls, then it throws like any Gemini failure, naming the status', async () => {
        steps = [{ ms: 300, fail: httpError(503) }, { ms: 300, fail: httpError(503) }, { ms: 0 }];
        await assert.rejects(generate(), /Gemini request failed \[HTTP 503\]: The model is overloaded/);
        assert.equal(posts.length, 2, 'never a third');
        assert.equal(retryLines().length, 1, 'one retry was announced, not two');
    });

    it('a timeout, then success: the hung attempt cost its 18 s, the retry answers', async () => {
        steps = [{ hang: true }, { ms: 5_000 }];
        const reply = await generate();
        assert.equal(reply?.text, 'أهلاً');
        assert.equal(posts.length, 2);
        assert.equal(retryLines()[0].code, 'ECONNABORTED');
    });

    for (const [code, message] of [['ECONNRESET', 'read ECONNRESET'], ['ETIMEDOUT', 'connect ETIMEDOUT']] as const) {
        it(`${code} is retried`, async () => {
            steps = [{ ms: 100, fail: netError(code, message) }, { ms: 2_000 }];
            assert.equal((await generate())?.text, 'أهلاً');
            assert.equal(posts.length, 2);
        });
    }

    it('a timeout twice: two calls, then it throws', async () => {
        steps = [{ hang: true }, { hang: true }];
        await assert.rejects(generate(), /Gemini request failed: timeout of \d+ms exceeded/);
        assert.equal(posts.length, 2);
    });

    for (const status of [400, 401, 403, 404]) {
        it(`HTTP ${status} is not retried`, async () => {
            steps = [{ ms: 100, fail: httpError(status, 'API key not valid') }, { ms: 0 }];
            await assert.rejects(generate(), new RegExp(`\\[HTTP ${status}\\]`));
            assert.equal(posts.length, 1);
            assert.equal(sleeps.length, 0);
            assert.equal(retryLines().length, 0);
        });
    }

    it('a safety block and an answer that is not JSON are not retried: they are not transport failures', async () => {
        steps = [{ ok: { data: { candidates: [], promptFeedback: { blockReason: 'SAFETY' } } } }, { ms: 0 }];
        await assert.rejects(generate(), /blockReason: SAFETY/);
        assert.equal(posts.length, 1);

        posts = [];
        steps = [{ ok: { data: { candidates: [{ content: { parts: [{ text: '{"message_type": "te' }] } }] } } }, { ms: 0 }];
        await assert.rejects(generate(), /not valid JSON/);
        assert.equal(posts.length, 1);
    });

    describe('the time budget', () => {
        it('the first attempt is given 18 s, the wait is 0.5-1.5 s, and the retry gets what is left of 30 s', async () => {
            random = 1; // the longest wait: the tightest budget for the retry
            steps = [{ hang: true }, { ms: 1_000 }];
            await generate();

            assert.equal(posts[0]!.config.timeout, 18_000);
            assert.deepEqual(sleeps, [1_500]);
            assert.equal(posts[1]!.config.timeout, 30_000 - 18_000 - 1_500);
        });

        it('the worst case, both attempts hanging to their timeouts, ends within 30 s and uses all of it', async () => {
            for (const r of [0, 1]) {
                t = 1_000_000;
                posts = [];
                sleeps = [];
                random = r;
                const start = t;
                steps = [{ hang: true }, { hang: true }];
                await assert.rejects(generate(), /timeout of/);
                assert.equal(t - start, GEMINI_TIMEOUT_MS, `random ${r}: took ${t - start} ms`);
                assert.ok(posts[1]!.config.timeout >= GEMINI_RETRY_MIN_BUDGET_MS, `retry timeout ${posts[1]!.config.timeout}`);
            }
        });

        it('whatever the wait and however fast the first failure, the retry has at least 10 s and the total never passes 30 s', async () => {
            for (const r of [0, 0.25, 0.5, 0.75, 1]) {
                for (const firstMs of [0, 300, 5_000, 18_000]) {
                    t = 1_000_000;
                    posts = [];
                    sleeps = [];
                    random = r;
                    const start = t;
                    steps = [{ ms: firstMs, fail: httpError(503) }, { hang: true }];
                    await assert.rejects(generate());
                    const label = `random ${r}, first attempt ${firstMs} ms`;
                    assert.equal(posts.length, 2, label);
                    assert.ok(sleeps[0]! >= GEMINI_RETRY_WAIT_MIN_MS && sleeps[0]! <= GEMINI_RETRY_WAIT_MAX_MS, `${label}: wait ${sleeps[0]}`);
                    assert.ok(posts[1]!.config.timeout >= GEMINI_RETRY_MIN_BUDGET_MS, `${label}: retry timeout ${posts[1]!.config.timeout}`);
                    assert.ok(t - start <= GEMINI_TIMEOUT_MS, `${label}: took ${t - start} ms`);
                }
            }
            // The constants fit together: the first attempt, the longest wait and the floor are within the budget.
            assert.ok(GEMINI_FIRST_ATTEMPT_MS + GEMINI_RETRY_WAIT_MAX_MS + GEMINI_RETRY_MIN_BUDGET_MS <= GEMINI_TIMEOUT_MS);
        });

        it('a fast failure leaves the retry nearly the whole budget', async () => {
            random = 0.5;
            steps = [{ ms: 300, fail: httpError(503) }, { ms: 1_000 }];
            await generate();
            assert.deepEqual(sleeps, [1_000]);
            assert.equal(posts[1]!.config.timeout, 30_000 - 300 - 1_000);
        });

        it('a first attempt that overran leaves less than the floor: the first error is thrown and the budget is not exceeded', async () => {
            steps = [{ ms: 25_000, fail: timeoutError(18_000) }, { ms: 0 }];
            await assert.rejects(generate(), /timeout of 18000ms exceeded/);
            assert.equal(posts.length, 1);
            assert.equal(sleeps.length, 0);
            assert.equal(retryLines()[0].retrying, false);
        });
    });

    describe('the request', () => {
        const golden = (name: string, ext: 'txt' | 'json'): string => readFileSync(goldenPath(name, ext), 'utf8');

        it('is the same on the retry as on the first attempt, and both are the owner\'s golden body: only the timeout differs', async () => {
            steps = [{ ms: 300, fail: httpError(503) }, { ms: 2_000 }];
            await generate();

            const [first, second] = posts;
            const expectedBody = {
                contents: [{ role: 'user', parts: [{ text: 'كم السعر؟' }] }],
                systemInstruction: { parts: [{ text: golden('dm.system-instruction', 'txt') }] },
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: JSON.parse(golden('dm.response-schema', 'json')),
                    temperature: 0.7,
                },
            };
            assert.equal(first!.url, second!.url);
            assert.equal(JSON.stringify(first!.payload), JSON.stringify(second!.payload), 'the bytes of the body');
            assert.equal(JSON.stringify(first!.payload), JSON.stringify(expectedBody));
            assert.deepEqual(first!.config.headers, { 'x-goog-api-key': KEY });
            assert.deepEqual(second!.config.headers, first!.config.headers);
            assert.deepEqual(Object.keys(first!.config).sort(), ['headers', 'timeout'], 'nothing else was added to the call');
            assert.deepEqual(Object.keys(second!.config).sort(), ['headers', 'timeout']);
            assert.notEqual(first!.config.timeout, second!.config.timeout);
        });

        it('is the sandbox\'s too: the same retry, with the model and temperature on screen', async () => {
            steps = [{ ms: 300, fail: httpError(503) }, { ms: 2_000 }];
            const reply = await generate({ model: 'gemini-3.8-flash', temperature: 0 });

            assert.equal(reply?.text, 'أهلاً');
            assert.equal(posts.length, 2);
            for (const p of posts) assert.match(p.url, /models\/gemini-3\.8-flash:generateContent$/);
            assert.equal(JSON.stringify(posts[0]!.payload), JSON.stringify(posts[1]!.payload));
        });
    });

    describe('the log', () => {
        it('says ai.gemini_retry with the status and the attempt, and never the key, the URL or the headers', async () => {
            steps = [{ ms: 300, fail: httpError(503) }, { ms: 2_000 }];
            await generate();

            const [retry] = retryLines();
            assert.equal(retry.level, 'warn');
            assert.equal(retry.attempt, 1);
            assert.equal(retry.http_status, 503);
            assert.equal(retry.gemini_status, 'UNAVAILABLE');
            assert.equal(retry.model, 'gemini-2.5-flash');
            assert.equal(retry.retrying, true);
            assert.equal(retry.wait_ms, sleeps[0]);
            const everything = lines.map((l) => l.line).join('\n');
            assert.ok(!everything.includes(KEY), 'the key is in no line');
            assert.ok(!everything.includes('generativelanguage'), 'nor is the request URL');
            assert.ok(!/x-goog-api-key/i.test(everything), 'nor the header');
        });

        it('a network failure carries its code, not an HTTP status', async () => {
            steps = [{ ms: 100, fail: netError('ECONNRESET', 'read ECONNRESET') }, { ms: 2_000 }];
            await generate();
            const [retry] = retryLines();
            assert.equal(retry.code, 'ECONNRESET');
            assert.equal(retry.http_status, undefined);
        });
    });
});

describe('isTransientGeminiError', () => {
    const http = (status: number) => ({ response: { status } });

    it('is HTTP 503, 429 and 500, a socket reset and a timeout', () => {
        for (const status of [503, 429, 500]) assert.equal(isTransientGeminiError(http(status)), true, String(status));
        for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']) assert.equal(isTransientGeminiError({ code }), true, code);
    });

    it('is not any other 4xx, a plain error, or anything that is not an error at all', () => {
        for (const status of [400, 401, 403, 404, 413, 422]) assert.equal(isTransientGeminiError(http(status)), false, String(status));
        // Its HTTP status is the verdict: a 400 that carries a timeout-looking code is still a 400.
        assert.equal(isTransientGeminiError({ ...http(400), code: 'ECONNABORTED' }), false);
        assert.equal(isTransientGeminiError(new Error('Gemini returned no content')), false);
        assert.equal(isTransientGeminiError({ code: 'ERR_BAD_REQUEST' }), false);
        for (const nothing of [undefined, null, 'timeout', 503]) assert.equal(isTransientGeminiError(nothing), false);
    });
});
