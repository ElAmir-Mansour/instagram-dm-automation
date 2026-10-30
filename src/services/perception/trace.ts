/**
 * The one line the inbox shows under a reply the agent gave to something it SAW, or after it looked in the owner's video library: what it read or found, what it did and
 * why (docs/specs/005-muse-sees US5, data-model.md "Decision trace"). It is stored as `ai_meta.reason` of the outbound row, beside `ai_meta.perceived: true` and, when a reel
 * of the library was recalled, `ai_meta.recalled: true`.
 *
 * **Built by the code, never written by a model.** The sales schema is pinned (adding a field would change its golden), and a reason a model wrote about its own decision
 * is a claim, where this is a record: every word of it comes from the kind of thing that was read and from the decision the code itself made (`decideTurn`), so it cannot
 * say something that did not happen. English, one line, nothing the customer sent or the media showed: only closed lists. Pure.
 */
import type { TurnEffect } from '../dmSales/flow.js';
import type { HandoffReason, Intent, NextAction } from '../dmSales/types.js';
import { readNoun } from './how.js';
import { watchFrom } from './text.js';
import type { PerceptionKind } from './types.js';

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
    /** What was read. Absent for a turn that read nothing: a typed question the video library was looked into for. */
    kind?: PerceptionKind;
    /**
     * The owner's video library was asked (`recall.ts`) and the reply was given with its answer: a reel was found (and the second the reply says to watch from, 0 meaning
     * from the start), or nothing in it covered what they asked, which the reply said.
     */
    recall?: { found: true; second: number } | { found: false };
    /**
     * How the line begins when it says more than "Read a photo": what was read AND how it was looked at (`readPhrase`: "Watched a shared reel", "Read the caption of a
     * shared reel"), so that the trace never claims more than the agent did. Absent: "Read <what>".
     */
    read?: string;
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

/** What the library gave, as a phrase to put after what was read, or to begin the line with (`opening` capitalises it then). */
function recallPhrase(recall: NonNullable<TraceInput['recall']>): string {
    if (!recall.found) return 'looked in the video library and found nothing on it';
    return recall.second > 0 ? `found a video in the library (from ${watchFrom(recall.second)})` : 'found a video in the library';
}

/** How the line begins: what was read and how, then what the library gave, in the order they happened. */
function opening(t: TraceInput): string {
    const read = t.kind ? (t.read ?? `Read ${readNoun(t.kind)}`) : null;
    const recall = t.recall ? recallPhrase(t.recall) : null;
    if (read && recall) return `${read}, and ${recall}`;
    if (read) return read;
    return recall ? `${recall.charAt(0).toUpperCase()}${recall.slice(1)}` : 'Answered';
}

export function traceReason(t: TraceInput): string {
    const read = opening(t);
    if (t.personal && t.kind) return `Read ${readNoun(t.kind)}: it is a personal document, so the chat went to a person without describing it.`;
    if (t.modelFailed) return `${read}, but the model could not answer: a person was told.`;

    let line: string;
    if (t.effect === 'calm') line = `${read}; sent one calm line`;
    else if (t.effect === 'pause') line = `${read}; stopped replying`;
    else if (t.effect === 'handoff') line = `${read}; ${DID.handoff}${HANDED[t.handoffReason] ? `, because ${HANDED[t.handoffReason]}` : ''}`;
    else {
        const because = t.intent ? BECAUSE[t.intent] : undefined;
        line = `${read}; ${DID[t.action]}${because ? `, because ${because}` : ''}`;
    }
    return `${line}.`;
}
