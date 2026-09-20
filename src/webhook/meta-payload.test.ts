/**
 * Pure data mapping with no I/O, and previously the only way to check a carousel was built
 * correctly was to send one to a real person and look at their phone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AiResponse } from '../services/ai.js';
import { AI_DISCLOSURE_LINE, applyDisclosure, toMetaMessage } from './meta-payload.js';

describe('toMetaMessage', () => {
    it('maps a plain text reply', () => {
        const payload = toMetaMessage({ message_type: 'text', text: 'أهلاً بك' });

        assert.deepEqual(payload, { text: 'أهلاً بك' });
    });

    it('maps quick replies with the content_type Meta expects', () => {
        const payload = toMetaMessage({
            message_type: 'quick_reply',
            text: 'اختر',
            quick_replies: [
                { title: 'الكورسات', payload: 'COURSES' },
                { title: 'التواصل', payload: 'CONTACT' },
            ],
        });

        assert.equal(payload.text, 'اختر');
        assert.deepEqual(payload.quick_replies, [
            { content_type: 'text', title: 'الكورسات', payload: 'COURSES' },
            { content_type: 'text', title: 'التواصل', payload: 'CONTACT' },
        ]);
        assert.equal('attachment' in payload, false);
    });

    it('passes quick reply titles through unchanged', () => {
        // The 20-character cap Meta enforces is applied upstream, in ai.ts's
        // enforceMetaConstraints, on Gemini's parsed response. This mapper does not re-apply
        // it, so anything that reaches it without going through generateAiResponse is
        // unbounded. Pinned so that stays a deliberate choice rather than a surprise.
        const long = 'ا'.repeat(45);
        const payload = toMetaMessage({
            message_type: 'quick_reply',
            text: 'اختر',
            quick_replies: [{ title: long, payload: 'P' }],
        });

        assert.equal(payload.quick_replies?.[0]?.title.length, 45);
    });

    it('builds a generic template for a carousel and omits text entirely', () => {
        const payload = toMetaMessage({
            message_type: 'carousel',
            text: 'هذه الكورسات',
            carousel_elements: [
                {
                    title: 'كورس الذكاء الاصطناعي',
                    subtitle: 'عربي بالكامل',
                    image_url: 'https://example.com/a.jpg',
                    buttons: [{ type: 'web_url', title: 'سجل الآن', url: 'https://example.com' }],
                },
            ],
        });

        // Meta rejects `text` sent alongside `attachment`, so the carousel branch drops it.
        assert.equal('text' in payload, false);
        assert.equal(payload.attachment?.type, 'template');
        assert.equal(payload.attachment?.payload.template_type, 'generic');
        assert.equal(payload.attachment?.payload.elements.length, 1);
    });

    it('copies only the fields each button type uses', () => {
        // Meta rejects unknown keys inside template elements, and Gemini returns both `url`
        // and `payload` on every button regardless of type — hence the explicit copying.
        const payload = toMetaMessage({
            message_type: 'carousel',
            text: '',
            carousel_elements: [
                {
                    title: 'كرت',
                    buttons: [
                        { type: 'web_url', title: 'رابط', url: 'https://example.com', payload: 'LEAKED' },
                        { type: 'postback', title: 'زر', url: 'https://leaked.example', payload: 'PICK' },
                    ],
                },
            ],
        });

        const buttons = payload.attachment?.payload.elements[0].buttons;
        assert.deepEqual(buttons[0], { type: 'web_url', title: 'رابط', url: 'https://example.com' });
        assert.deepEqual(buttons[1], { type: 'postback', title: 'زر', payload: 'PICK' });
    });

    it('omits optional element fields rather than sending them empty', () => {
        const payload = toMetaMessage({
            message_type: 'carousel',
            text: '',
            carousel_elements: [{ title: 'كرت بلا تفاصيل' }],
        });

        const element = payload.attachment?.payload.elements[0];
        assert.deepEqual(Object.keys(element), ['title']);
    });

    it('falls back to the text Gemini returned for an unrecognised message_type', () => {
        // This used to produce `{}`, which Meta rejects with a confusing
        // "param message must be a non-empty object".
        const weird = { message_type: 'sticker', text: 'نص احتياطي' } as unknown as AiResponse;

        assert.deepEqual(toMetaMessage(weird), { text: 'نص احتياطي' });
    });
});

describe('applyDisclosure', () => {
    it('prefixes the disclosure onto a text payload', () => {
        const result = applyDisclosure({ text: 'أهلاً' });

        assert.equal(result.payload.text, `${AI_DISCLOSURE_LINE}\nأهلاً`);
        assert.equal(result.standalone, null);
    });

    it('keeps quick replies attached to the disclosed message', () => {
        const result = applyDisclosure({
            text: 'اختر',
            quick_replies: [{ content_type: 'text', title: 'كورسات', payload: 'C' }],
        });

        assert.equal(result.payload.quick_replies?.length, 1);
        assert.equal(result.standalone, null);
    });

    it('sends the disclosure as its own message ahead of a carousel', () => {
        // A generic template carries no `text` field — Meta rejects `text` alongside
        // `attachment` — so the disclosure cannot ride along and has to precede it.
        const carousel = { attachment: { type: 'template', payload: { template_type: 'generic', elements: [] } } };
        const result = applyDisclosure(carousel);

        assert.equal(result.standalone, AI_DISCLOSURE_LINE);
        assert.equal('text' in result.payload, false);
        assert.deepEqual(result.payload, carousel);
    });

    it('treats a blank text field as no text', () => {
        assert.equal(applyDisclosure({ text: '   ' }).standalone, AI_DISCLOSURE_LINE);
        assert.equal(applyDisclosure({}).standalone, AI_DISCLOSURE_LINE);
    });

    it('does not mutate the payload it was handed', () => {
        const original = { text: 'أهلاً' };
        applyDisclosure(original);

        assert.equal(original.text, 'أهلاً');
    });

    it('accepts a custom disclosure line', () => {
        const result = applyDisclosure({ text: 'أهلاً' }, 'automated');

        assert.equal(result.payload.text, 'automated\nأهلاً');
    });
});
