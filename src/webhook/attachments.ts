/**
 * What a DM with no words in it is: a photo, a voice note, a shared reel, a sticker, a reply to a story, a message Instagram could not
 * show. Pure: no logging, no clock, nothing read from a database. `normalizeDm` (messaging.ts) asks it, `attachmentAck.ts` answers from it,
 * and the inbox draws the same kinds back out of `messages.message_type` (dashboard/js/pages/inbox.js, `WORDLESS_KINDS`).
 *
 * **Why this exists.** Until it did, `normalizeDm` returned null for any message with no text, no quick-reply payload and no story mention:
 * a customer's photo was never stored, never shown in the inbox and never acknowledged, and the person sat waiting for an answer to a
 * message nobody had seen. Now every such message is stored as an inbound row whose `message_type` is its kind and whose `text` is a
 * readable placeholder (`[photo]`), and the bot answers with one fixed line from the language kit (`kit.attachments`), never with a model:
 * a model asked to answer "[photo]" invents what is in it.
 *
 * **The shapes are Meta's, and only Meta's** (nothing here is inferred from a payload nobody has seen):
 *   - Instagram, `message.attachments[].type`: media, audio, file, image (an image, a GIF or a sticker), video, share (legacy, deprecated
 *     after Feb 2026), ig_post, story_mention, ig_reel, reel, story, ig_story; each `{ type, payload: { url } }`. `ephemeral` (view once)
 *     has NO payload. `message.reply_to.story = { url, id }` on a reply to a story, `message.is_unsupported: true` on a message Instagram
 *     cannot show, `message.is_deleted: true` on an unsend.
 *     https://developers.facebook.com/documentation/business-messaging/instagram-messaging/webhooks
 *     https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/story-mention
 *     https://developers.facebook.com/docs/instagram-platform/webhooks/examples
 *   - Messenger, `message.attachments[].type`: image, video, audio, file, sticker (`payload: { url, sticker_id }`; until 2026-08-30 an
 *     `image` may also carry `sticker_id`, and is then a sticker), reel and ig_reel (`title`, `reel_video_id`), post and ig_post
 *     (`url`, `title`, `id`), template (a shared product, `payload.product.elements[]`), fallback (`url`, `title`: usually WITH text, a
 *     shared link, which then is not word-less at all), appointment_booking (`booking_id`, `status`, `start_time`, `end_time`, `timezone`).
 *     https://developers.facebook.com/docs/messenger-platform/reference/webhook-events/messages
 *
 * `message_type` is the contract with the rest of the app: a row is word-less exactly when its `message_type` is one of
 * `WORDLESS_MESSAGE_TYPES` (the pipeline writes `'text'` for anything with words). The sales turn's `supersession` and the ack's own claim
 * statement both read it in SQL for that reason.
 */

/** The kinds, in the order this module and the inbox list them. `story_reply` is listed first when a message has one (see `describeWordless`). */
export const WORDLESS_KINDS = [
    'story_reply', 'image', 'video', 'audio', 'file', 'sticker', 'share', 'reel', 'story_share', 'story_mention', 'attachment',
] as const;

export type WordlessKind = (typeof WORDLESS_KINDS)[number];

/** The kinds as the strings the database holds, for the statements that tell a word-less row from one with words. */
export const WORDLESS_MESSAGE_TYPES: readonly string[] = WORDLESS_KINDS;

/** The `message_type` of the bot's one line for a word-less message: the claim statement and `supersession` both tell it apart by this. */
export const ATTACHMENT_ACK_TYPE = 'attachment_ack';

/**
 * What the stored row's `text` says for each kind: readable in a log or a model's history, never printed by the inbox (which draws a chip
 * from the kind). `[Story Mention]` is the text a story mention has always been stored as.
 */
export const WORDLESS_PLACEHOLDERS: Readonly<Record<WordlessKind, string>> = Object.freeze({
    story_reply: '[story reply]',
    image: '[photo]',
    video: '[video]',
    audio: '[voice note]',
    file: '[file]',
    sticker: '[sticker]',
    share: '[shared post]',
    reel: '[shared reel]',
    story_share: '[shared story]',
    story_mention: '[Story Mention]',
    attachment: '[attachment]',
});

/** Which line answers it: the kit's `mention` (a story mention), its `media` (anything the bot cannot open), or none (a sticker is a like). */
export type WordlessAck = 'media' | 'mention' | null;

export interface Wordless {
    /** The first of `kinds`: what `messages.message_type` holds. */
    kind: WordlessKind;
    /** Every kind in the message, once each, in order (a reply to a story first). */
    kinds: WordlessKind[];
    /** The placeholders of `kinds`, joined by one space: `[photo] [video]`. */
    placeholder: string;
    ack: WordlessAck;
}

/**
 * An attachment's Meta `type` as a kind. A sticker is also an `image` that carries a `sticker_id` (Messenger, until 2026-08-30). Exported for
 * `services/perception/media.ts`, which pairs each attachment's kind with its link: `describeWordless` says which kinds a message holds, not which link is which.
 */
export function kindOfAttachment(attachment: unknown): WordlessKind {
    const att = attachment && typeof attachment === 'object' ? (attachment as { type?: unknown; payload?: { sticker_id?: unknown } | null }) : null;
    const type = typeof att?.type === 'string' ? att.type.toLowerCase() : '';
    switch (type) {
        case 'image': return att?.payload?.sticker_id ? 'sticker' : 'image';
        case 'sticker': return 'sticker';
        case 'video': return 'video';
        case 'audio': return 'audio';
        case 'file': return 'file';
        case 'share': case 'ig_post': case 'post': case 'fallback': case 'template': return 'share';
        case 'ig_reel': case 'reel': return 'reel';
        case 'story': case 'ig_story': return 'story_share';
        case 'story_mention': return 'story_mention';
        // `media`, `ephemeral` (view once: no payload at all), `appointment_booking`, and whatever Meta adds next.
        default: return 'attachment';
    }
}

/**
 * What the message is when it has no words, or null when there is nothing to describe: not an object, no attachments (or an empty list),
 * no reply to a story and no `is_unsupported`. The caller decides when "no words" is true (`normalizeDm`: no text and no quick-reply
 * payload); this only says what the message holds besides them.
 *
 * `is_unsupported` with nothing else listed is an `attachment`: Instagram had something to show and could not say what.
 */
export function describeWordless(message: any): Wordless | null {
    if (!message || typeof message !== 'object') return null;

    const kinds: WordlessKind[] = [];
    const add = (kind: WordlessKind): void => { if (!kinds.includes(kind)) kinds.push(kind); };

    const story = message.reply_to?.story;
    if (story && typeof story === 'object') add('story_reply');
    if (Array.isArray(message.attachments)) for (const attachment of message.attachments) add(kindOfAttachment(attachment));
    if (kinds.length === 0 && message.is_unsupported === true) add('attachment');
    if (kinds.length === 0) return null;

    const kind = kinds[0]!;
    return {
        kind,
        kinds,
        placeholder: kinds.map((k) => WORDLESS_PLACEHOLDERS[k]).join(' '),
        ack: kind === 'story_mention' ? 'mention' : kinds.every((k) => k === 'sticker') ? null : 'media',
    };
}
