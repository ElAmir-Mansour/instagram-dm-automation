/**
 * What a DM with no words is (`attachments.ts`), one case per row of its table, on the shapes Meta documents and nothing else:
 *
 *   Instagram  https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks
 *              https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/story-mention
 *              https://developers.facebook.com/docs/instagram-platform/webhooks/examples
 *   Messenger  https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages
 *
 * Every `message` below is the part of a messaging event that those pages show under `message`: an attachment is `{ type, payload }` with
 * the payload fields the page lists for that type, `ephemeral` has no payload, a reply to a story is `reply_to.story = { url, id }`, and
 * an unsupported message is `is_unsupported: true`. No field is made up for a test: the CDN links are placeholders for what Meta sends.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    ATTACHMENT_ACK_TYPE, describeWordless, WORDLESS_KINDS, WORDLESS_MESSAGE_TYPES, WORDLESS_PLACEHOLDERS, type Wordless, type WordlessKind,
} from './attachments.js';

const CDN = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=1';

/** What a message of one attachment is, in the three fields the pipeline reads. */
function describeOne(message: unknown): Pick<Wordless, 'kind' | 'placeholder' | 'ack'> {
    const got = describeWordless(message);
    assert.ok(got, JSON.stringify(message));
    return { kind: got.kind, placeholder: got.placeholder, ack: got.ack };
}

describe('describeWordless — Instagram', () => {
    it('an image, a video, an audio clip and a file: each its own kind, answered with the "I can\'t open it" line', () => {
        assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type: 'image', payload: { url: CDN } }] }), { kind: 'image', placeholder: '[photo]', ack: 'media' });
        assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type: 'video', payload: { url: CDN } }] }), { kind: 'video', placeholder: '[video]', ack: 'media' });
        assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type: 'audio', payload: { url: CDN } }] }), { kind: 'audio', placeholder: '[voice note]', ack: 'media' });
        assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type: 'file', payload: { url: CDN } }] }), { kind: 'file', placeholder: '[file]', ack: 'media' });
    });

    it('a shared post: `share` (the legacy type) and `ig_post`', () => {
        for (const type of ['share', 'ig_post']) {
            assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type, payload: { url: CDN } }] }), { kind: 'share', placeholder: '[shared post]', ack: 'media' }, type);
        }
    });

    it('a shared reel: `ig_reel` and `reel`', () => {
        for (const type of ['ig_reel', 'reel']) {
            assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type, payload: { url: CDN } }] }), { kind: 'reel', placeholder: '[shared reel]', ack: 'media' }, type);
        }
    });

    it('a shared story: `story` and `ig_story`', () => {
        for (const type of ['story', 'ig_story']) {
            assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type, payload: { url: CDN } }] }), { kind: 'story_share', placeholder: '[shared story]', ack: 'media' }, type);
        }
    });

    it('a story mention: the placeholder it has always been stored as, and the mention line instead of the media one', () => {
        // The shape the Story Mention page shows: one attachment of type story_mention, whose payload is the CDN link of the story.
        const message = { mid: 'm', attachments: [{ type: 'story_mention', payload: { url: CDN } }] };
        assert.deepEqual(describeOne(message), { kind: 'story_mention', placeholder: '[Story Mention]', ack: 'mention' });
    });

    it('a view-once photo (`ephemeral`, which has NO payload) and a `media` attachment: a plain attachment', () => {
        assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type: 'ephemeral' }] }), { kind: 'attachment', placeholder: '[attachment]', ack: 'media' });
        assert.deepEqual(describeOne({ mid: 'm', attachments: [{ type: 'media', payload: { url: CDN } }] }), { kind: 'attachment', placeholder: '[attachment]', ack: 'media' });
    });

    it('a message Instagram could not show (`is_unsupported`, nothing attached): a plain attachment', () => {
        assert.deepEqual(describeOne({ mid: 'm', is_unsupported: true }), { kind: 'attachment', placeholder: '[attachment]', ack: 'media' });
    });

    it('a reply to a story with nothing typed: a story reply, listed first', () => {
        const only = describeWordless({ mid: 'm', reply_to: { story: { url: CDN, id: '17887498072083520' } } });
        assert.deepEqual(only, { kind: 'story_reply', kinds: ['story_reply'], placeholder: '[story reply]', ack: 'media' });

        const withImage = describeWordless({ mid: 'm', reply_to: { story: { url: CDN, id: '17887498072083520' } }, attachments: [{ type: 'image', payload: { url: CDN } }] });
        assert.deepEqual(withImage, { kind: 'story_reply', kinds: ['story_reply', 'image'], placeholder: '[story reply] [photo]', ack: 'media' });
    });

    it('two attachments (the Webhooks page\'s image and video): both kinds, one placeholder of each', () => {
        const got = describeWordless({ mid: 'm', attachments: [{ type: 'image', payload: { url: CDN } }, { type: 'video', payload: { url: CDN } }] });
        assert.deepEqual(got, { kind: 'image', kinds: ['image', 'video'], placeholder: '[photo] [video]', ack: 'media' });
    });

    it('three photos are one kind, and one placeholder', () => {
        const got = describeWordless({ mid: 'm', attachments: Array.from({ length: 3 }, () => ({ type: 'image', payload: { url: CDN } })) });
        assert.deepEqual(got, { kind: 'image', kinds: ['image'], placeholder: '[photo]', ack: 'media' });
    });
});

describe('describeWordless — Messenger', () => {
    it('a sticker is `sticker` with a sticker_id, and is the one kind that gets no line (it is a like)', () => {
        const got = describeWordless({ mid: 'm', attachments: [{ type: 'sticker', payload: { url: CDN, sticker_id: 369239263222822 } }] });
        assert.deepEqual(got, { kind: 'sticker', kinds: ['sticker'], placeholder: '[sticker]', ack: null });
    });

    it('an `image` that carries a `sticker_id` is a sticker too (until 2026-08-30 Messenger sends them so)', () => {
        const got = describeWordless({ mid: 'm', attachments: [{ type: 'image', payload: { url: CDN, sticker_id: 369239263222822 } }] });
        assert.deepEqual(got, { kind: 'sticker', kinds: ['sticker'], placeholder: '[sticker]', ack: null });
        // And without one it is a photo.
        assert.equal(describeOne({ mid: 'm', attachments: [{ type: 'image', payload: { url: CDN } }] }).kind, 'image');
    });

    it('a sticker next to a photo is not "only stickers": the line is sent', () => {
        const got = describeWordless({ mid: 'm', attachments: [{ type: 'sticker', payload: { url: CDN, sticker_id: 369239263222822 } }, { type: 'image', payload: { url: CDN } }] });
        assert.deepEqual(got, { kind: 'sticker', kinds: ['sticker', 'image'], placeholder: '[sticker] [photo]', ack: 'media' });
    });

    it('a shared post: `post` and `ig_post`, with the title and id Messenger lists', () => {
        for (const type of ['post', 'ig_post']) {
            const got = describeOne({ mid: 'm', attachments: [{ type, payload: { url: CDN, title: 'A post', id: '17887498072083520' } }] });
            assert.deepEqual(got, { kind: 'share', placeholder: '[shared post]', ack: 'media' }, type);
        }
    });

    it('a shared reel: `reel` and `ig_reel`, with the title and reel_video_id Messenger lists', () => {
        for (const type of ['reel', 'ig_reel']) {
            const got = describeOne({ mid: 'm', attachments: [{ type, payload: { url: CDN, title: 'A reel', reel_video_id: '1234567890' } }] });
            assert.deepEqual(got, { kind: 'reel', placeholder: '[shared reel]', ack: 'media' }, type);
        }
    });

    it('a shared product (`template`, `payload.product.elements[]`) is a shared post', () => {
        const got = describeOne({ mid: 'm', attachments: [{ type: 'template', payload: { product: { elements: [] } } }] });
        assert.deepEqual(got, { kind: 'share', placeholder: '[shared post]', ack: 'media' });
    });

    it('a `fallback` (a shared link) with no text is a shared post', () => {
        const got = describeOne({ mid: 'm', attachments: [{ type: 'fallback', payload: { url: CDN, title: 'A page' } }] });
        assert.deepEqual(got, { kind: 'share', placeholder: '[shared post]', ack: 'media' });
    });

    it('an appointment booking is a plain attachment', () => {
        const got = describeOne({ mid: 'm', attachments: [{ type: 'appointment_booking', payload: { booking_id: 'b-1', status: 'confirmed', start_time: '2026-10-20T10:00:00+0000', end_time: '2026-10-20T11:00:00+0000', timezone: 'UTC' } }] });
        assert.deepEqual(got, { kind: 'attachment', placeholder: '[attachment]', ack: 'media' });
    });
});

describe('describeWordless — nothing to describe', () => {
    it('is null when there is no message, or it is not an object', () => {
        for (const message of [undefined, null, 'text', 42, true]) assert.equal(describeWordless(message), null, String(message));
    });

    it('is null for no attachments, an empty list, and a message that is only text', () => {
        assert.equal(describeWordless({ mid: 'm' }), null);
        assert.equal(describeWordless({ mid: 'm', attachments: [] }), null);
        assert.equal(describeWordless({ mid: 'm', text: 'كم السعر؟' }), null);
        assert.equal(describeWordless({ mid: 'm', is_unsupported: false }), null);
    });

    it('is null when `attachments` is not a list, and tolerates an entry that is not an attachment', () => {
        assert.equal(describeWordless({ mid: 'm', attachments: { type: 'image' } }), null);
        assert.equal(describeOne({ mid: 'm', attachments: [null] }).kind, 'attachment');
    });
});

describe('the kinds', () => {
    it('are the contract with the database and the inbox: every kind has a placeholder, and the types list is the kinds', () => {
        assert.deepEqual([...WORDLESS_MESSAGE_TYPES], [...WORDLESS_KINDS]);
        assert.deepEqual(Object.keys(WORDLESS_PLACEHOLDERS).sort(), [...WORDLESS_KINDS].sort());
        assert.equal(new Set(Object.values(WORDLESS_PLACEHOLDERS)).size, WORDLESS_KINDS.length, 'one placeholder per kind');
        const kinds: readonly WordlessKind[] = WORDLESS_KINDS;
        assert.ok(kinds.every((kind) => kind.length <= 50), 'fits messages.message_type (VARCHAR(50))');
    });

    it('never name the ack\'s own type, which is what tells the bot\'s line from a customer\'s message', () => {
        assert.equal(ATTACHMENT_ACK_TYPE, 'attachment_ack');
        assert.ok(!WORDLESS_MESSAGE_TYPES.includes(ATTACHMENT_ACK_TYPE));
        for (const reserved of ['text', 'quick_reply', 'carousel']) assert.ok(!WORDLESS_MESSAGE_TYPES.includes(reserved), reserved);
    });
});
