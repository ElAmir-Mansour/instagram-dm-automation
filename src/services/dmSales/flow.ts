/**
 * Where a sales conversation goes next (docs/DM_SALES_PLAN.md §4). Pure.
 *
 * **The code decides the stage. The model only proposes.** The model's answer names a stage, an action and an offer; this module takes
 * them as a proposal and applies the rules that must hold whatever it says:
 *
 *   - `link` is a stage a conversation is in only because a link was actually sent this turn (`send_link`, with an offer that has an
 *     address: `coerce.ts` has already refused the rest). A model that writes "here you go" in a plain reply is not in `link`.
 *   - `handoff` and `closed` are entered by an action (`handoff`, `close`) and by nothing else, and `closed` is not left for a sale: a
 *     person who has said no, or asked to be left alone, is not recommended anything again unless THEY say they want to buy.
 *   - A reply moves a conversation only forward along the flow (new → qualify → recommend, with `objection` a side state, and `link`
 *     only left for an objection). `follow_up` is the follow-up job's (S9), never a model's.
 *   - **Two qualifying questions, then recommend.** A third is not allowed: the turn asks the model once more with a correction, and a
 *     model that still asks is recorded as `recommend` anyway (the conversation is out of questions; the stage must say so).
 *   - **An insult gets one calm line; the second pauses the bot** and says nothing more. A person who asks to be left alone is told once.
 *
 * `nextStage` is the stage alone. `decideTurn` is the whole decision (what to send, what to record, whether to ask the model again), and
 * is what `turn.ts` follows. Both are functions of their arguments: no database, no clock, no model.
 */
import { MAX_QUALIFIER_TURNS, type HandoffReason, type Intent, type NextAction, type SalesReply, type Stage } from './types.js';

/** Insults before the bot stops answering: the first is answered, the second is not. */
export const MAX_ABUSE_STRIKES = 2;

/** The bot's own replies to one conversation in an hour, above which it pauses itself: a loop (two bots, a flood) must end by itself. */
export const MAX_AI_REPLIES_PER_HOUR = 15;

/** What the code knows about the conversation before this turn. */
export interface FlowFacts {
    /** Qualifying questions asked so far. */
    qualifierTurns: number;
    /** Insults so far. */
    abuseStrikes: number;
    /**
     * This is the second try, after a correction. A rule that can only be enforced by writing the reply again has had its one chance: the
     * decision then takes what the model gave and records the stage the rule demands.
     */
    final?: boolean;
}

/**
 * The stages a model's plain reply (no question, no recommendation, no link) may move a conversation to, from each stage. `handoff` is
 * left the way a new conversation starts: the bot only answers again after somebody resumed it, and what it says then is a fresh start.
 */
const REPLY_MOVES: Readonly<Record<Stage, readonly Stage[]>> = {
    new: ['new', 'qualify', 'recommend', 'objection'],
    qualify: ['qualify', 'recommend', 'objection'],
    recommend: ['recommend', 'objection'],
    objection: ['objection', 'recommend', 'qualify'],
    link: ['link', 'objection'],
    follow_up: ['follow_up', 'link', 'objection', 'recommend'],
    handoff: ['new', 'qualify', 'recommend', 'objection'],
    closed: ['closed', 'recommend'],
};

const isObjection = (intent: Intent): boolean => intent.startsWith('objection_');

/** Actions that sell: they pitch an offer, ask a qualifying question or send a link. */
const SELLS: ReadonlySet<NextAction> = new Set<NextAction>(['ask_qualifier', 'recommend', 'send_link']);

/** A conversation that is closed stays closed unless the person says they want to buy. */
const staysClosed = (prev: Stage, intent: Intent): boolean => prev === 'closed' && intent !== 'ready_to_buy';

/** What the stage is after this turn. The model's `stage` is read as a proposal only for a plain reply, and only if the flow allows the move. */
export function nextStage(prev: Stage, reply: SalesReply, facts: Pick<FlowFacts, 'qualifierTurns'>): Stage {
    if (reply.next_action === 'handoff') return 'handoff';
    if (reply.next_action === 'close' || reply.intent === 'opt_out') return 'closed';
    if (staysClosed(prev, reply.intent)) return 'closed';

    switch (reply.next_action) {
        case 'send_link': return 'link';
        case 'recommend': return 'recommend';
        case 'ask_qualifier': return facts.qualifierTurns >= MAX_QUALIFIER_TURNS ? 'recommend' : 'qualify';
        default: break;
    }

    if (isObjection(reply.intent)) return 'objection';
    const from: Stage = prev === 'handoff' ? 'new' : prev;
    return REPLY_MOVES[prev].includes(reply.stage) ? reply.stage : from;
}

/** What the turn does with the conversation. */
export type TurnEffect =
    /** Send the reply. When `action` is `send_link` the server adds the link after it. */
    | 'reply'
    /** Send the hand-off line (never the model's text) and pause the bot until the owner resumes it. */
    | 'handoff'
    /** A polite close: the model's own words, or the opt-out line when the person asked to be left alone. */
    | 'close'
    /** The first insult: one calm line, the stage unchanged. */
    | 'calm'
    /** Pause the bot and send nothing: the second insult, or a conversation that is looping. */
    | 'pause';

export interface TurnDecision {
    effect: TurnEffect;
    /** The stage the conversation is in after this turn. */
    stage: Stage;
    /** What happens to the reply after the rules: `send_link` is the only one that makes the server add a link. */
    action: NextAction;
    /** Qualifying questions asked after this turn. */
    qualifierTurns: number;
    /** Insults after this turn. */
    abuseStrikes: number;
    handoffReason: HandoffReason;
    /** They asked to be left alone: send the opt-out line, record `opted_out_at`, pause the bot. */
    optOut: boolean;
    /** The rules that changed what the model proposed, for `messages.ai_meta`. */
    overrides: string[];
    /** Set: do not send this reply; ask the model once more, with this correction, and decide again. Never set on a `final` decision. */
    correction: string | null;
}

/** A decision with the plain-reply defaults, so each rule above names only what it changes. */
const decided =(over: Partial<TurnDecision>, base: Pick<TurnDecision, 'qualifierTurns' | 'abuseStrikes'>): TurnDecision => ({
    effect: 'reply', stage: 'new', action: 'reply', handoffReason: 'none', optOut: false, overrides: [], correction: null, ...base, ...over,
});

/**
 * The correction for a third qualifying question: written for the model, in plain English whatever language the customer writes in (the
 * reply's language is the customer's, which the rules already say), and never shown to anybody.
 */
export const QUALIFIER_CORRECTION =
    `You have already asked the ${MAX_QUALIFIER_TURNS} qualifying questions the rules allow, so do not ask another. Recommend the one offer that fits what they have told you `
    + '(next_action = recommend, offer_id = that offer), tying it to their goal, and offer to send the link. If they asked for the link, send it (next_action = send_link). Reply in the same format.';

/** An insult, as `turn.ts` knows it from the prefilter or from the model's own `abuse` intent: the first is answered, the second ends the bot's part. */
export function abuseDecision(prev: Stage, facts: Pick<FlowFacts, 'qualifierTurns' | 'abuseStrikes'>): TurnDecision {
    const strikes = facts.abuseStrikes + 1;
    const base = { qualifierTurns: facts.qualifierTurns, abuseStrikes: strikes };
    if (strikes >= MAX_ABUSE_STRIKES) {
        return decided({ effect: 'pause', stage: 'closed', action: 'close', handoffReason: 'abuse', overrides: ['abuse_pause'] }, base);
    }
    return decided({ effect: 'calm', stage: prev === 'handoff' ? 'new' : prev, action: 'reply', handoffReason: 'none', overrides: ['abuse_calm'] }, base);
}

/** A person is needed: the conversation is handed over with `reason`, and the bot stays quiet until the owner resumes it. */
export function handoffDecision(reason: Exclude<HandoffReason, 'none'>, facts: Pick<FlowFacts, 'qualifierTurns' | 'abuseStrikes'>, optOut = false): TurnDecision {
    return decided({ effect: 'handoff', stage: 'handoff', action: 'handoff', handoffReason: reason, optOut }, facts);
}

/** They asked to be left alone: told once, recorded, and nothing after. */
export function optOutDecision(facts: Pick<FlowFacts, 'qualifierTurns' | 'abuseStrikes'>): TurnDecision {
    return decided({ effect: 'close', stage: 'closed', action: 'close', optOut: true }, facts);
}

/**
 * A reply that moves nothing: the stage, the counts and the offer stay as they were. What is sent when the model could not be asked and the
 * legacy Gemini path answered instead: it knows nothing of the flow, so the flow does not move for it.
 */
export function unchangedDecision(prev: Stage, facts: Pick<FlowFacts, 'qualifierTurns' | 'abuseStrikes'>, overrides: string[] = []): TurnDecision {
    return decided({ stage: prev, overrides }, facts);
}

/** The conversation is looping (too many replies in an hour): the bot pauses itself, quietly, and a person looks. */
export function loopDecision(facts: Pick<FlowFacts, 'qualifierTurns' | 'abuseStrikes'>): TurnDecision {
    return decided({ effect: 'pause', stage: 'handoff', action: 'handoff', handoffReason: 'unsure', overrides: ['reply_cap'] }, facts);
}

/**
 * What to do with the model's answer, given where the conversation is. `reply` is `coerceSalesReply`'s: it already agrees with itself (a
 * handoff has a reason, a recommendation has an offer with a link). This applies the flow's rules on top and says what happens.
 */
export function decideTurn(prev: Stage, reply: SalesReply, facts: FlowFacts): TurnDecision {
    const base = { qualifierTurns: facts.qualifierTurns, abuseStrikes: facts.abuseStrikes };

    // An insult, whichever way it was recognised.
    if (reply.intent === 'abuse' || reply.handoff_reason === 'abuse') return abuseDecision(prev, facts);

    const overrides: string[] = [];
    let action = reply.next_action;

    if (action === 'handoff') {
        return decided({ effect: 'handoff', stage: 'handoff', action: 'handoff', handoffReason: reply.handoff_reason === 'none' ? 'unsure' : reply.handoff_reason }, base);
    }
    if (action === 'close' || reply.intent === 'opt_out') {
        return decided({ effect: 'close', stage: 'closed', action: 'close', optOut: reply.intent === 'opt_out' }, base);
    }

    // No further sales to a person who has said no: only their own "I want it" reopens the conversation.
    if (staysClosed(prev, reply.intent) && SELLS.has(action)) {
        overrides.push('closed_no_sales');
        action = 'reply';
    }

    // Two qualifying questions, then recommend. A third is written again once, and recorded as the recommendation it should have been.
    if (action === 'ask_qualifier' && facts.qualifierTurns >= MAX_QUALIFIER_TURNS) {
        overrides.push('qualifier_cap');
        if (!facts.final) {
            return decided({ stage: prev, action: 'reply', overrides, correction: QUALIFIER_CORRECTION }, base);
        }
        action = 'reply';
        return decided({ stage: 'recommend', action, overrides: [...overrides, 'qualifier_cap_kept'] }, base);
    }

    const stage = nextStage(prev, { ...reply, next_action: action }, facts);
    const proposed = reply.stage;
    if (proposed !== stage && action === reply.next_action && !isObjection(reply.intent)) overrides.push(`stage:${proposed}->${stage}`);
    return decided({
        stage,
        action,
        qualifierTurns: base.qualifierTurns + (action === 'ask_qualifier' ? 1 : 0),
        overrides,
    }, base);
}
