/**
 * The vocabulary of the DM sales turn (docs/DM_SALES_PLAN.md §3 and §4): the closed lists the model answers from, the shape of an
 * answer, and the few limits Meta sets on one.
 *
 * Pure and shared by the five modules of this folder, so the schema the model is given, the coercion that reads its answer and the
 * prompt that explains it all draw on one list: a value added here is in the schema, the repair and the prompt from the same commit.
 *
 * Nothing in this folder is called from the live DM path yet (S6 wires it).
 */

/** What the person is doing in this message. The model names it; the server decides what it means. */
export const INTENTS = [
    'greeting', 'info', 'price', 'level_fit', 'objection_price', 'objection_time', 'objection_trust', 'ready_to_buy', 'support',
    'refund_or_complaint', 'wants_human', 'off_topic', 'abuse', 'opt_out', 'other',
] as const;

/** Where the conversation is in the sales flow (§4). The model proposes one; `nextStage` (S6) decides. */
export const STAGES = ['new', 'qualify', 'recommend', 'objection', 'link', 'follow_up', 'handoff', 'closed'] as const;

/** What the server should do with the reply. `send_link` is the only way a link is ever sent: the model never writes one. */
export const NEXT_ACTIONS = ['reply', 'ask_qualifier', 'recommend', 'send_link', 'handoff', 'close'] as const;

/** Why the conversation goes to a person. 'none' stands in for a nullable field, which Anthropic's schema limits would rather not have. */
export const HANDOFF_REASONS = ['none', 'unsure', 'refund', 'complaint', 'wants_human', 'hot_lead', 'abuse'] as const;

export type Intent = (typeof INTENTS)[number];
export type Stage = (typeof STAGES)[number];
export type NextAction = (typeof NEXT_ACTIONS)[number];
export type HandoffReason = (typeof HANDOFF_REASONS)[number];

/** `offer_id` when the reply is about no one offer. */
export const NO_OFFER = 'none';

/**
 * Instagram's text limit is 1,000 BYTES, not characters (docs/DM_SALES_PLAN.md §2, assumption A3), and Arabic is about two bytes a
 * letter. A sales reply is capped at 900, which leaves room for the link the server adds after it.
 */
export const MAX_REPLY_BYTES = 900;

/** Quick replies: Meta allows 13 with a 20-character title; a sales turn offers at most three (§3). */
export const MAX_QUICK_REPLIES = 3;
export const QUICK_REPLY_TITLE_MAX = 20;
export const QUICK_REPLY_PAYLOAD_MAX = 64;

export interface SalesQuickReply {
    title: string;
    payload: string;
}

/**
 * What the model answers, after `coerceSalesReply` has made it true. The text carries no link and no price of the model's own: the
 * server inserts the link from the offer, and `guard.ts` checks every number. On `next_action: 'handoff'` the caller sends the kit's
 * line, not this text.
 */
export interface SalesReply {
    text: string;
    quick_replies: SalesQuickReply[];
    intent: Intent;
    stage: Stage;
    next_action: NextAction;
    /** An offer id from the prompt, or 'none'. */
    offer_id: string;
    handoff_reason: HandoffReason;
}

/**
 * What the prompt's last block says about this conversation (§3: "static parts first, conversation facts last"). S6 reads these from
 * its own columns; they are listed here so the prompt and the state agree on their shape.
 */
export interface SalesFacts {
    stage: Stage;
    /** Qualifier questions already asked: the flow allows two, then the bot must recommend. */
    qualifierTurns: number;
    /** The ids of the offers whose link this conversation has already been sent. */
    linkSentFor: readonly string[];
    /** They commented a keyword and were sent an offer's link; `offerId` is null when the campaign matched no offer. */
    comment?: { keyword: string; offerId: string | null };
    /**
     * They tapped one of OUR buttons (an ice breaker or a persistent-menu item, S13) and `intent` is what its code stands for
     * (`intentForPayload`): the model is told what the button asked, so it does not have to guess it from the title.
     */
    tapped?: { intent: Intent };
    /**
     * The owner's A/B wording for this conversation's arm (S14, `variants.ts`): how to open the FIRST reply (null once the bot has spoken, or when the arm
     * says nothing about it) and how to word the offer of the link. Wording only: the rules above it in the prompt still hold.
     */
    variant?: { opening: string | null; cta: string | null };
    /**
     * The channel, said only for a WhatsApp conversation: the rules and the persona were written for Instagram and Messenger, and the model must not
     * call this chat one of them. Absent for Instagram and Messenger, whose facts block is therefore byte for byte what it was before the field existed
     * (`prompt.test.ts` pins it).
     */
    channel?: 'whatsapp';
    /**
     * A3: the click-to-message ad this conversation began from, when the owner switched `ads.bot_context` on (`ads/attribution.ts` `adFactsFor`).
     * Absent (the default, and every conversation that did not begin from an ad), the facts block is byte for byte what it was (`prompt.test.ts`).
     */
    ad?: { name: string; offerTitle: string | null; primaryText: string | null; tapped: string | null };
    /**
     * Meta Muse perception (`services/perception/`): what the customer sent that had no words, as `perceivedFact` words it ("What the customer sent: a shared
     * reel. What it shows: …"), already one line. Given only for a message Meta's model read, and said last in the facts block, next to the customer's message.
     * Absent (every tenant whose switches are off, and every message that has words), the facts block is byte for byte what it was (`prompt.test.ts`).
     * It is NOT among the guard's facts: a number seen in media is not one the reply may state.
     */
    sent?: string;
    /**
     * The video recall found for this message ("Relevant video: <link> (watch from 0:13): …", or "No video on this topic yet"), already one line, said after
     * `sent`. Absent unless the owner's video memory is on and the message asked for a video. The turn puts the same line into the guard's facts, so the
     * second it names passes the number check.
     */
    video?: string;
    /**
     * What the agent can take in (`perception/senses.ts`: "Voice notes the customer sends in this chat are heard and answered…"), already one line, said after `video`.
     * Given only when the customer's words mention a voice note or a photo and the gate would let the next one be read. Absent (every tenant whose switches are off, and
     * every message without such a word), the facts block is byte for byte what it was. It holds no number, price or link, so it is not among the guard's facts.
     */
    senses?: string;
}

/** A reply is never more than this many qualifier questions deep (§4). */
export const MAX_QUALIFIER_TURNS = 2;
