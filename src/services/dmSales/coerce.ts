/**
 * Making the model's answer true (docs/DM_SALES_PLAN.md §3, "coerceSalesReply downgrades bad output"). Pure, and it never throws.
 *
 * `responseSchema` is a strong constraint and not a guarantee, and this answer has more to get wrong than the old one: seven fields,
 * four of them enums, two of them promises about what the server will do. Each way it can be wrong has one answer, and the answer is
 * always the smaller claim, as `coerceAiResponse` does for the old path:
 *
 *   - A field of the wrong type, or an enum value that is not in the list, reads as the safe one ('other', 'none', 'reply'). The
 *     person on the other end gets the words the model wrote, which is what they were waiting for; the structure was a presentation detail.
 *   - An `offer_id` the prompt did not list is 'none'. A reply that recommends or sends a link and names no offer is only a reply:
 *     there is nothing to link to, and the server will not guess which one was meant.
 *   - **An offer without a link is never recommended and never gets one** (the owner's rule): `recommend` and `send_link` for an offer
 *     that has no `url` become a handoff, reason `unsure`, so a person answers and the model's text is not sent.
 *   - The answer must agree with itself: a handoff reason means a handoff, and a handoff with no reason is `unsure`; a person who
 *     asked for a refund or a human (the intents) is handed off whatever the action says; a person who opted out is closed.
 *   - The text is capped at 900 UTF-8 bytes (Instagram counts bytes, not letters), on a character boundary, less what the server adds
 *     after it (`reserveBytes`: the link).
 *
 * What it does not decide is the stage: the model proposes one and `nextStage` (S6) disposes. The text's own safety (links, numbers) is
 * `guard.ts`; this only reads the shape.
 */
import {
    HANDOFF_REASONS, INTENTS, MAX_QUICK_REPLIES, MAX_REPLY_BYTES, NEXT_ACTIONS, NO_OFFER, QUICK_REPLY_PAYLOAD_MAX, QUICK_REPLY_TITLE_MAX, STAGES,
    type HandoffReason, type Intent, type NextAction, type SalesQuickReply, type SalesReply, type Stage,
} from './types.js';
import { capUtf8Bytes, graphemes } from './text.js';

/** The offers of the prompt, as far as coercion needs them. */
export interface SalesOfferRef {
    id: string;
    /** Whether the offer has a URL for the server to send. */
    hasLink: boolean;
}

export interface CoerceOptions {
    offers: readonly SalesOfferRef[];
    /** What the stage reads as when the model's is not one of the eight: the conversation's own. */
    fallbackStage?: Stage;
    /** Bytes the server adds after the text (a link and the space before it), taken off the cap. */
    reserveBytes?: number;
}

export interface CoercedSalesReply {
    reply: SalesReply;
    /** What had to be repaired, by field, for the log. Empty for an answer that was already true. */
    repaired: string[];
    /**
     * Whether there is something to send: text, or a handoff (whose message is the kit's). False for a model that answered with no
     * words and no reason to be silent, which the caller treats as a failed turn.
     */
    usable: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function oneOf<T extends string>(value: unknown, list: readonly T[], fallback: T, field: string, repaired: string[]): T {
    if (typeof value === 'string' && (list as readonly string[]).includes(value)) return value as T;
    if (value !== undefined) repaired.push(field);
    return fallback;
}

/** A model that wrote a number or a boolean meant it as text; an object or a list is not text and is not guessed at. */
function textOf(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

/** Control characters are not text (a model can emit them); newlines and tabs are. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** At most `max` graphemes: a title is cut by what a person sees as a character, never in the middle of one. */
const cutGraphemes = (text: string, max: number): string => graphemes(text).slice(0, max).join('');

function quickRepliesOf(value: unknown, repaired: string[]): SalesQuickReply[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        repaired.push('quick_replies');
        return [];
    }
    const out: SalesQuickReply[] = [];
    const titles = new Set<string>();
    for (const item of value) {
        if (!isObj(item) || typeof item.title !== 'string') {
            repaired.push('quick_replies');
            continue;
        }
        const title = cutGraphemes(item.title.replace(CONTROL, '').replace(/\s+/g, ' ').trim(), QUICK_REPLY_TITLE_MAX).trim();
        if (!title || titles.has(title)) continue;
        // A payload is a code the server maps to a meaning, never text a customer reads: letters, digits and underscores, or a numbered default.
        const code = (typeof item.payload === 'string' ? item.payload : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, QUICK_REPLY_PAYLOAD_MAX);
        titles.add(title);
        out.push({ title, payload: code || `QR_${out.length + 1}` });
        if (out.length === MAX_QUICK_REPLIES) break;
    }
    if (value.length > MAX_QUICK_REPLIES) repaired.push('quick_replies');
    return out;
}

/** The answer the model gave, as a `SalesReply` that is true to its own shape. Never throws. */
export function coerceSalesReply(parsed: unknown, options: CoerceOptions): CoercedSalesReply {
    const raw = isObj(parsed) ? parsed : {};
    const repaired: string[] = [];
    if (!isObj(parsed)) repaired.push('answer');

    const intent: Intent = oneOf(raw.intent, INTENTS, 'other', 'intent', repaired);
    const stage: Stage = oneOf(raw.stage, STAGES, options.fallbackStage ?? 'new', 'stage', repaired);
    let nextAction: NextAction = oneOf(raw.next_action, NEXT_ACTIONS, 'reply', 'next_action', repaired);
    let handoffReason: HandoffReason = oneOf(raw.handoff_reason, HANDOFF_REASONS, 'none', 'handoff_reason', repaired);

    const known = new Map(options.offers.map((o) => [o.id, o]));
    let offerId = typeof raw.offer_id === 'string' && known.has(raw.offer_id) ? raw.offer_id : NO_OFFER;
    if (raw.offer_id !== undefined && raw.offer_id !== NO_OFFER && offerId === NO_OFFER) repaired.push('offer_id');

    // What the answer says it will do has to be possible.
    if ((nextAction === 'recommend' || nextAction === 'send_link') && offerId === NO_OFFER) {
        repaired.push('next_action');
        nextAction = 'reply';
    } else if ((nextAction === 'recommend' || nextAction === 'send_link') && !known.get(offerId)?.hasLink) {
        // No link, no recommendation: a person answers, and the model's text, which recommends it, is not sent.
        repaired.push('next_action');
        nextAction = 'handoff';
        handoffReason = 'unsure';
        offerId = NO_OFFER;
    }

    // The answer has to agree with itself.
    if (handoffReason !== 'none' && nextAction !== 'handoff') {
        repaired.push('next_action');
        nextAction = 'handoff';
    }
    if (intent === 'refund_or_complaint' && nextAction !== 'handoff') {
        repaired.push('next_action');
        nextAction = 'handoff';
        if (handoffReason === 'none') handoffReason = 'complaint';
    }
    if (intent === 'wants_human' && nextAction !== 'handoff') {
        repaired.push('next_action');
        nextAction = 'handoff';
        if (handoffReason === 'none') handoffReason = 'wants_human';
    }
    if (nextAction === 'handoff' && handoffReason === 'none') {
        repaired.push('handoff_reason');
        handoffReason = 'unsure';
    }
    if (intent === 'opt_out' && nextAction !== 'handoff' && nextAction !== 'close') {
        repaired.push('next_action');
        nextAction = 'close';
    }

    const cap = Math.max(100, MAX_REPLY_BYTES - Math.max(0, options.reserveBytes ?? 0));
    const text = capUtf8Bytes(textOf(raw.text).replace(CONTROL, '').replace(/[ \t]+\n/g, '\n').trim(), cap);
    if (raw.text !== undefined && typeof raw.text !== 'string') repaired.push('text');

    const reply: SalesReply = {
        text, quick_replies: quickRepliesOf(raw.quick_replies, repaired), intent, stage, next_action: nextAction, offer_id: offerId, handoff_reason: handoffReason,
    };
    return { reply, repaired, usable: text.length > 0 || nextAction === 'handoff' };
}
