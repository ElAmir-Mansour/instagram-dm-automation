/**
 * What Gemini can return, versus what Meta will accept.
 *
 * `responseSchema` is a strong constraint and not a guarantee, and this pipeline had no layer
 * between `JSON.parse` of model output and the Meta Send API — the parse was annotated
 * `AiResponse` and nothing checked that claim. Each case below produced a Meta rejection or a
 * TypeError from inside the success path, four months after the last real DM went through.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { coerceAiResponse, decideAgent, DEFAULT_MODEL, resolveModel, SUPPORTED_MODELS } from './ai.js';
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
