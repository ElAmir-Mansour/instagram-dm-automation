/**
 * The one line the inbox shows under a reply the agent gave to something it SAW: what it read, what it did and why (docs/specs/005-muse-sees US5, data-model.md "Decision
 * trace"). It is stored as `ai_meta.reason` of the outbound row, beside `ai_meta.perceived: true`.
 *
 * **Built by the code, never written by a model.** The sales schema is pinned (adding a field would change its golden), and a reason a model wrote about its own decision
 * is a claim, where this is a record: every word of it comes from the kind of thing that was read and from the decision the code itself made (`decideTurn`), so it cannot
 * say something that did not happen. English, one line, nothing the customer sent or the media showed: only closed lists. Pure.
 */
import type { TurnEffect } from '../dmSales/flow.js';
import type { HandoffReason, Intent, NextAction } from '../dmSales/types.js';
import type { PerceptionKind } from './types.js';

/** What was read, as a noun phrase. */
const READ: Readonly<Record<PerceptionKind, string>> = Object.freeze({
    reel: 'a shared reel',
    share: 'a shared post',
    story_reply: 'a reply to the account\'s story',
    story_share: 'a shared story',
    story_mention: 'a story mention',
    image: 'a photo',
    video: 'a video',
    audio: 'a voice note',
});

/** What the turn did, as a verb phrase, by the action the code settled on. */
const DID: Readonly<Record<NextAction, string>> = Object.freeze({
    reply: 'answered from the account\'s own information',
    ask_qualifier: 'asked one question to place them',
    recommend: 'recommended the offer that fits',
    send_link: 'sent the offer\'s link',
    handoff: 'handed the chat to a person',
    close: 'closed politely',
});

/** Why, by what the person was doing: the model's `intent`, as the code recorded it. Nothing for the ones that say nothing. */
const BECAUSE: Readonly<Partial<Record<Intent, string>>> = Object.freeze({
    greeting: 'they said hello',
    info: 'they want to know more',
    price: 'they asked about the price',
    level_fit: 'they asked whether it suits them',
    objection_price: 'the price worries them',
    objection_time: 'time worries them',
    objection_trust: 'trust worries them',
    ready_to_buy: 'they are ready to buy',
    support: 'they need help',
    wants_human: 'they asked for a person',
    refund_or_complaint: 'they raised a refund or a complaint',
    off_topic: 'it is off topic',
    opt_out: 'they asked to be left alone',
});

/** Why a person was needed, when the model handed the chat over. */
const HANDED: Readonly<Partial<Record<HandoffReason, string>>> = Object.freeze({
    unsure: 'the information it has does not answer this',
    refund: 'they raised a refund',
    complaint: 'they raised a complaint',
    wants_human: 'they asked for a person',
    hot_lead: 'they are ready to buy',
    abuse: 'the messages were abusive',
});

export interface TraceInput {
    /** What was read. */
    kind: PerceptionKind;
    /** What the turn did, and the action it settled on (`TurnDecision`). */
    effect: TurnEffect;
    action: NextAction;
    handoffReason: HandoffReason;
    intent: Intent | null;
    /** The media is a personal document: nothing was described, and no model was asked. */
    personal?: boolean;
    /** The model could not answer at all, and the chat went to a person. */
    modelFailed?: boolean;
}

/** The longest the line may get: it sits under a bubble. Every combination of the closed lists is inside it (`trace.test.ts` walks them all), so nothing is ever cut. */
export const REASON_MAX_CHARS = 200;

export function traceReason(t: TraceInput): string {
    const read = READ[t.kind];
    if (t.personal) return `Read ${read}: it is a personal document, so the chat went to a person without describing it.`;
    if (t.modelFailed) return `Read ${read}, but the model could not answer: a person was told.`;

    let line: string;
    if (t.effect === 'calm') line = `Read ${read}; sent one calm line`;
    else if (t.effect === 'pause') line = `Read ${read}; stopped replying`;
    else if (t.effect === 'handoff') line = `Read ${read}; ${DID.handoff}${HANDED[t.handoffReason] ? `, because ${HANDED[t.handoffReason]}` : ''}`;
    else {
        const because = t.intent ? BECAUSE[t.intent] : undefined;
        line = `Read ${read}; ${DID[t.action]}${because ? `, because ${because}` : ''}`;
    }
    return `${line}.`;
}
