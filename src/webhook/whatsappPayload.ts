/**
 * A reply, as WhatsApp's Cloud API takes it (docs/specs/001-whatsapp-agent/contracts/outbound-send.md section 2, research R10). Pure: no I/O, no clock,
 * no logging. `toWhatsAppMessage(body, recipient)` is the one shaper, so the agent's reply, the operator's manual reply and anything later all become
 * the same request bodies, and the limits live here and nowhere else.
 *
 * **Exactly one message per reply** (review M14). Nothing here makes two: a reply that has buttons AND a link carries the link in its text.
 *
 *   the reply has                      the message is
 *   ---------------------------------  ---------------------------------------------------------------------------------------------------------
 *   text only                          `text`: body up to 4,096 characters, `preview_url` when the text holds a URL
 *   1 to 3 quick replies               `interactive.button`: body up to 1,024, title up to 20, id up to 256
 *   4 to 10 quick replies, or `list`   `interactive.list`: body up to 4,096, one section, a row's title up to 24, description up to 72, id up to 200,
 *                                      the button up to 20
 *   one link and nothing else          `interactive.cta_url`: body up to 1,024 (the text), `display_text` up to 20. Longer text is sent as a plain
 *                                      text message with the link after it: a cut would drop what the person is told
 *
 * A body over its limit is cut at the end of a sentence (`cutAtSentence`); a trailing link line is kept whole, because a link cut off in the
 * middle is worse than a shorter sentence.
 *
 * ## Addressing
 *
 * A phone number is addressed `{ messaging_product: 'whatsapp', recipient_type: 'individual', to: <digits> }`; a BSUID
 * `{ …, recipient: <BSUID> }` and NO `to` (when both are present Meta takes the phone number). Never both. The sender passes the contact's phone
 * when Meta has given one and the BSUID otherwise (`recipientOf` in services/channels/send.ts): a test number's allowed list is checked by phone,
 * so a BSUID-addressed reply to a listed number failed with 131030 (2026-10-19).
 * Confirmed on Meta's page for business-scoped user ids (read 2026-10-19): "To message by BSUID, put the BSUID in `recipient` and omit `to`",
 * with this exact body for a text message, and "these changes apply to all message types".
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids.md
 *
 * Limits, each read on Meta's page for the message type on 2026-10-19:
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages.md   (1,024 / 20 / 256 / 3)
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages.md            (4,096 / 20 / 24 / 200 / 24 / 72 / 10)
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-cta-url-messages.md         (1,024 / 20)
 * and 4,096 for a text body (the send-messages page). A list's section title is documented as required, even for one section.
 */
import type { WhatsAppSendPayload } from '../services/whatsapp.js';

export const TEXT_BODY_MAX = 4096;
export const BUTTON_BODY_MAX = 1024;
export const BUTTON_TITLE_MAX = 20;
export const BUTTON_ID_MAX = 256;
export const MAX_BUTTONS = 3;
export const LIST_BODY_MAX = 4096;
export const LIST_BUTTON_MAX = 20;
export const LIST_SECTION_TITLE_MAX = 24;
export const LIST_ROW_ID_MAX = 200;
export const LIST_ROW_TITLE_MAX = 24;
export const LIST_ROW_DESCRIPTION_MAX = 72;
export const MAX_LIST_ROWS = 10;
export const CTA_BODY_MAX = 1024;
export const CTA_LABEL_MAX = 20;

/** A reply, whatever it will travel as. The same shape as `ReplyBody` in contracts/outbound-send.md. */
export interface WhatsAppReplyBody {
    text: string;
    /** The buttons of a reply: `payload` is what comes back as the tapped button's id. */
    quickReplies?: ReadonlyArray<{ title: string; payload: string }>;
    /** One link, with the words on its button. */
    link?: { url: string; label: string };
    /** A list the agent offers: `button` opens it, each row says what it is. */
    list?: { button: string; rows: ReadonlyArray<{ id: string; title: string; description?: string }> };
}

/** A reply that cannot be made into a message at all (no words, an address that is not an address). The caller records it as a failure. */
export class WhatsAppShapeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WhatsAppShapeError';
    }
}

/** A phone number in E.164 digits (`E164_DIGITS` in whatsappAgent.ts, copied so this file stays free of the database module that one imports). */
const PHONE_DIGITS = /^\d{8,15}$/;

const chars = (value: string): string[] => Array.from(value);
const length = (value: string): number => chars(value).length;
const clip = (value: string, max: number): string => (length(value) <= max ? value : chars(value).slice(0, max).join(''));
const clean = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const SENTENCE_END = /[.!?؟…。]["'”’»)\]]*(?=\s|$)|\n/g;
const TRAILING_URL = /\n(https?:\/\/\S+)\s*$/;
const HAS_URL = /https?:\/\/\S+/i;
const ARABIC = /[؀-ۿ]/;

/**
 * `text` within `max` characters, cut after the last sentence that fits (or the last word, with an ellipsis, when no sentence ends in the second
 * half of what fits). A link on the last line is kept whole and the words before it are cut to leave room for it. Text already within `max` is
 * returned as it is.
 */
export function cutAtSentence(text: string, max: number): string {
    const value = text.trim();
    if (length(value) <= max) return value;

    const url = TRAILING_URL.exec(value);
    if (url) {
        const tail = `\n${url[1]}`;
        const room = max - length(tail);
        // A link that takes most of the room is not kept whole at the cost of every word: cut everything as plain text then.
        if (room >= Math.floor(max / 4)) return `${cutAtSentence(value.slice(0, url.index), room)}${tail}`;
    }

    const room = max - 1; // the ellipsis
    const head = chars(value).slice(0, max).join('');
    let end = -1;
    for (const match of head.matchAll(SENTENCE_END)) end = match.index! + match[0].length;
    if (end >= Math.floor(max / 2)) return head.slice(0, end).trimEnd();

    const fits = chars(value).slice(0, room).join('');
    const space = fits.search(/\s\S*$/);
    return `${(space >= Math.floor(max / 2) ? fits.slice(0, space) : fits).trimEnd()}…`;
}

/** `{ messaging_product, recipient_type, recipient }` for a BSUID, `{ ..., to }` for a phone number alone. Never both. */
function addressing(recipient: string): { messaging_product: 'whatsapp'; recipient_type: 'individual'; recipient: string } | { messaging_product: 'whatsapp'; recipient_type: 'individual'; to: string } {
    const who = clean(recipient);
    if (!who) throw new WhatsAppShapeError('A WhatsApp message needs a recipient.');
    const base = { messaging_product: 'whatsapp' as const, recipient_type: 'individual' as const };
    return PHONE_DIGITS.test(who.replace(/^\+/, '')) ? { ...base, to: who.replace(/^\+/, '') } : { ...base, recipient: who };
}

/** What one button or row says, kept only when it has an id and words, and only the first of any title or id already used. */
function usable<T extends { id: string; title: string }>(items: readonly T[]): T[] {
    const titles = new Set<string>();
    const ids = new Set<string>();
    const kept: T[] = [];
    for (const item of items) {
        if (!item.id || !item.title) continue;
        if (titles.has(item.title) || ids.has(item.id)) continue;
        titles.add(item.title);
        ids.add(item.id);
        kept.push(item);
    }
    return kept;
}

const isHttpUrl = (value: string): boolean => {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
};

/** The words of the button that opens a list made from quick replies, in the language the reply is written in. */
const listButtonFor = (text: string): string => (ARABIC.test(text) ? 'الخيارات' : 'Options');

/**
 * The Cloud API message for a reply, addressed to `recipient`. Throws `WhatsAppShapeError` for a reply with no words (every interactive message
 * needs a body, and an empty text is not a message).
 */
export function toWhatsAppMessage(body: WhatsAppReplyBody, recipient: string): WhatsAppSendPayload {
    const to = addressing(recipient);
    const text = clean(body.text);
    if (!text) throw new WhatsAppShapeError('A WhatsApp message needs words.');

    const link = body.link && isHttpUrl(clean(body.link.url)) ? { url: clean(body.link.url), label: clean(body.link.label) } : null;
    const buttons = usable((body.quickReplies ?? []).map((q) => ({ id: clean(q.payload), title: clean(q.title) })));
    const rows = body.list
        ? usable(body.list.rows.map((r) => ({ id: clean(r.id), title: clean(r.title), description: clean(r.description) })))
        : usable(buttons.map((b) => ({ ...b, description: '' })));
    const wantsList = body.list ? rows.length > 0 : buttons.length > MAX_BUTTONS;

    // A link that rides beside buttons or a list has no button of its own (one interactive message has one kind of action): it goes in the words.
    const withLink = (words: string): string => (link && !words.includes(link.url) ? `${words}\n${link.url}` : words);

    if (wantsList) {
        const listRows = rows.slice(0, MAX_LIST_ROWS).map((r) => ({
            id: clip(r.id, LIST_ROW_ID_MAX),
            title: clip(r.title, LIST_ROW_TITLE_MAX),
            ...(r.description ? { description: clip(r.description, LIST_ROW_DESCRIPTION_MAX) } : {}),
        }));
        const button = clip(clean(body.list?.button) || listButtonFor(text), LIST_BUTTON_MAX);
        return {
            ...to,
            type: 'interactive',
            interactive: {
                type: 'list',
                body: { text: cutAtSentence(withLink(text), LIST_BODY_MAX) },
                action: { button, sections: [{ title: clip(button, LIST_SECTION_TITLE_MAX), rows: listRows }] },
            },
        };
    }

    if (buttons.length > 0) {
        return {
            ...to,
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: cutAtSentence(withLink(text), BUTTON_BODY_MAX) },
                action: {
                    buttons: buttons.slice(0, MAX_BUTTONS).map((b) => ({ type: 'reply', reply: { id: clip(b.id, BUTTON_ID_MAX), title: clip(b.title, BUTTON_TITLE_MAX) } })),
                },
            },
        };
    }

    if (link && link.label && length(text) <= CTA_BODY_MAX) {
        return {
            ...to,
            type: 'interactive',
            interactive: {
                type: 'cta_url',
                body: { text },
                action: { name: 'cta_url', parameters: { display_text: clip(link.label, CTA_LABEL_MAX), url: link.url } },
            },
        };
    }

    const words = cutAtSentence(withLink(text), TEXT_BODY_MAX);
    return { ...to, type: 'text', text: { body: words, preview_url: HAS_URL.test(words) } };
}
