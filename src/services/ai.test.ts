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
import { coerceAiResponse } from './ai.js';
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
