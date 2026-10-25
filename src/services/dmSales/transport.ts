/**
 * Where a sales turn's messages go when the conversation is not on Instagram or Messenger (docs/specs/001-whatsapp-agent, phase W5).
 *
 * The turn (`turn.ts`) was written for the Instagram and Messenger Send API and does that, byte for byte, when it is given no transport. Given one,
 * it hands the transport the message it would have sent and lets it do the sending, the read receipt and the bookkeeping that is the channel's own.
 * That is the whole of what is shared and the whole of what differs: the model, the rules, the guard, the flow and the record of a turn are one
 * code path for every channel, so a rule added for Instagram is a rule on WhatsApp the same day, and there is no second sales bot to drift.
 *
 * What a turn does differently when it has a transport (each is a line in `turn.ts`, and each is pinned by `turn.test.ts`):
 *   - the AI purpose is the channel's (`dm_whatsapp`), whose providers are limited to those that do not train on what they are sent, and the legacy
 *     Gemini path is NEVER the fallback for a model that failed: the customer's chat is handed to a person instead
 *   - the channel is a fact in the prompt, so the bot never calls this chat "Instagram"
 *   - the disclosure is folded into the one message, never a bubble of its own; Instagram's hourly send quota is not spent
 *   - no comment bridge, no A/B arm, no follow-up: those are Instagram's (a follow-up is a free-form message hours later, which the 24 h window may
 *     no longer allow, and WhatsApp has no consent or template layer yet)
 *   - the customer's words, as the model reads them, may be cleaned by the channel (`readable`): a WhatsApp entry link's tracking code is not something to
 *     show a model, and the stored row (what the inbox shows) is left exactly as it arrived
 */
import type { MetaMessagePayload } from '../../webhook/meta-payload.js';
import type { SendFailureReason } from '../channels/send.js';

/** What the channel says about a message it took. */
export interface SentMessage {
    /** The id the channel gave it; null when it gave none (a message that cannot be tracked). */
    wamid: string | null;
}

export interface SalesTransport {
    readonly channel: 'whatsapp';
    /**
     * Send ONE message: `payload` is the Instagram-shaped body the turn builds (`{ text, quick_replies? }`), with the disclosure already in its text. Throws
     * `SalesSendRefused` for a refusal (a closed window, a connection Meta refused, a billable message nobody allowed, a request Meta did not take).
     */
    send(payload: MetaMessagePayload): Promise<SentMessage>;
    /** The read receipt and the typing indicator, started while the model thinks. Best effort: never throws. */
    seen(): Promise<void>;
    /** After the turn is recorded: the channel's own bookkeeping for the row that holds the reply (the id a delivery status finds it by). Never throws. */
    recorded(replyId: string | null, sent: SentMessage): Promise<void>;
    /**
     * What the model reads of a message the CUSTOMER wrote (the history's inbound rows): the stored words with whatever the channel added to them taken out
     * (WhatsApp: the ` #ref` an entry link's prefilled message ends with). Pure, and the identity for a text that holds nothing of the kind: a turn whose
     * history rows and `inbound.text` come through the same function reads the message being answered once, not twice. Absent: the words as stored.
     */
    readable?(text: string): string;
}

/** The channel would not take the message. Carries what `sendWhatsAppReply` said, so whoever catches it can decide between a retry, a note and a handoff. */
export class SalesSendRefused extends Error {
    constructor(
        readonly reason: SendFailureReason,
        readonly info: { permanent: boolean; mayHaveLanded: boolean; attempted: boolean; code: number | null; closesAt: Date | null },
        detail: string
    ) {
        super(detail);
        this.name = 'SalesSendRefused';
    }
}
