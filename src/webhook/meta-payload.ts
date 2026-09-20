/**
 * Gemini's structured response → Meta Send API message payload.
 *
 * Pure data mapping, zero I/O. It sat inline in the webhook handler where the only way to
 * check a carousel was built correctly was to send one to a real person.
 */
import type { AiResponse } from '../services/ai.js';

export interface MetaQuickReply {
    content_type: string;
    title: string;
    payload: string;
}

export interface MetaMessagePayload {
    text?: string;
    quick_replies?: MetaQuickReply[];
    attachment?: {
        type: string;
        payload: Record<string, any>;
    };
}

/**
 * Meta rejects unknown keys inside template elements, so every field is copied explicitly
 * rather than spread — Gemini returns `url` and `payload` on every button regardless of type.
 */
export function toMetaMessage(aiRes: AiResponse): MetaMessagePayload {
    if (aiRes.message_type === 'text') {
        return { text: aiRes.text };
    }

    if (aiRes.message_type === 'quick_reply') {
        return {
            text: aiRes.text,
            quick_replies: aiRes.quick_replies?.map((qr) => ({
                content_type: 'text',
                title: qr.title,
                payload: qr.payload,
            })),
        };
    }

    if (aiRes.message_type === 'carousel') {
        return {
            attachment: {
                type: 'template',
                payload: {
                    template_type: 'generic',
                    elements: aiRes.carousel_elements?.map((el) => {
                        const cleanElement: Record<string, any> = {
                            title: el.title,
                        };
                        if (el.subtitle) cleanElement.subtitle = el.subtitle;
                        if (el.image_url) cleanElement.image_url = el.image_url;
                        if (el.buttons && el.buttons.length > 0) {
                            cleanElement.buttons = el.buttons.map((btn) => {
                                const cleanBtn: Record<string, any> = {
                                    type: btn.type,
                                    title: btn.title,
                                };
                                if (btn.type === 'web_url') {
                                    cleanBtn.url = btn.url;
                                } else {
                                    cleanBtn.payload = btn.payload;
                                }
                                return cleanBtn;
                            });
                        }
                        return cleanElement;
                    }),
                },
            },
        };
    }

    // An unrecognised message_type used to produce `{}`, which Meta rejects with a confusing
    // "param message must be a non-empty object". Fall back to the text Gemini did return.
    return { text: aiRes.text };
}

/**
 * Meta's Messenger Platform policy requires telling people they are talking to an automated
 * service "at the beginning of any conversation or message thread". Kept short because it
 * prefixes a real reply rather than replacing it.
 */
export const AI_DISCLOSURE_LINE = '🤖 رد آلي من المساعد الذكي';

export interface DisclosureResult {
    payload: MetaMessagePayload;
    /** Set when the disclosure could not ride along and must be sent as its own message. */
    standalone: string | null;
}

/**
 * Prefix the disclosure onto an outbound payload.
 *
 * Generic templates carry no `text` field — Meta rejects `text` sent alongside `attachment` —
 * so a carousel has to be preceded by its own plain-text message instead.
 */
export function applyDisclosure(
    payload: MetaMessagePayload,
    line: string = AI_DISCLOSURE_LINE
): DisclosureResult {
    if (typeof payload.text === 'string' && payload.text.trim().length > 0) {
        return { payload: { ...payload, text: `${line}\n${payload.text}` }, standalone: null };
    }
    return { payload, standalone: line };
}
