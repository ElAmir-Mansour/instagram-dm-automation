/**
 * The DM sales turn (docs/DM_SALES_PLAN.md S6): one inbound message in, at most one reply out, the conversation's state moved on.
 * Behind `ai_agents.sales_mode` (`mode.ts`); the old path is the pipeline's own and this module is never reached for it.
 *
 *   1. state       the conversation's sales state is read, and `last_inbound_at` stamped (`store.ts`)
 *   2. burst       a message that is no longer the one to answer (a later one is waiting, or somebody already replied) stands down
 *   3. agent       the owner's persona and knowledge base; a switched-off agent says nothing, as it always did
 *   4. prefilter   refund, complaint, opt-out and insult are decided BEFORE a model sees the message (`prefilter.ts`): no model, no sales text
 *   5. model       `mark_seen` and `typing_on` (best effort), then the structured answer through the AI providers layer, purpose `dm`
 *   6. coerce      the answer made true to its own shape (`coerce.ts`): a recommendation needs an offer with a link, a refund is a handoff
 *   7. rules       `decideTurn` (`flow.ts`): THE CODE DECIDES THE STAGE; the model only proposes one
 *   8. guard       the model's text is stripped of links and checked against the data (`guard.ts`); a violation asks the model once more
 *                  with a correction, and a second one is the kit's safe line and a handoff, never the text
 *   9. link        `send_link` is the only way a link is sent, and the server writes it (`linkFor`), after the text, within 900 UTF-8 bytes
 *  10. send        the same quota, disclosure and Send API the old path uses
 *  11. record      the reply, its `ai_meta` and the new state, in one statement (`recordTurn`)
 *  12. follow-up   a reply that carried a link queues the ONE nudge for it (`followupJob.ts`, S9): due hours later, re-checked when it runs
 *
 * **The conversation's facts go with the customer's message, not in the system prompt.** `buildSalesPrompt` makes the system text the same
 * on every turn of one tenant (`prefix`) so the layer's prompt cache (`cacheSystem`) can hit within a live back-and-forth; the stage and
 * the qualifier count change turn to turn, so they ride in front of the last user message instead.
 *
 * **Never silence.** A model that fails (no key, no route, an outage, a timeout, a refused budget, an answer with nothing to send) is
 * answered by the legacy Gemini path ONCE when the agent's `gemini_fallback` is on (the owner's setting, as for the engine switch), and
 * otherwise by a hand-off: the kit's line, the bot paused, a person to answer.
 *
 * **Where a conversation began** (S10, `bridge.ts`): when the person commented a keyword and was sent a link in the private reply, the latest such
 * campaign inside the window is stored on `conversations.source_campaign_id`, the turn starts at `recommend` (a conversation that is just beginning),
 * and "they commented «keyword» and were sent the link to <offer>" is among the facts. Read beside the history, and never able to fail the turn:
 * no source is the turn it would have been.
 *
 * **The owner's A/B wording experiment** (S14, `variants.ts`): when one is running, a NEW conversation is given an arm by a hash of its id, the arm's
 * guidance (how to open the first reply, how to word the offer of the link) rides in the conversation's facts, the arm is written with the turn's own
 * record, and `ai_meta.variant` says which arm a reply came from. Read beside the history; it can only ever mean "no arm", never a failed turn.
 *
 * **Another channel** (`transport.ts`, WhatsApp): given a `transport`, the turn sends, shows "typing" and finishes its bookkeeping through it, answers on
 * its own AI purpose (`dm_whatsapp`, providers that do not train on what they are sent) and NEVER falls back to Gemini. The history's customer rows pass through
 * the transport's `readable` (a WhatsApp entry link's ` #ref` is not for the model; the stored row is untouched). Given none, it is Instagram and
 * Messenger exactly as before: every line that differs is under `transport`, and `turn.test.ts` pins the request bodies of the other path and the history it reads.
 *
 * **Meta Muse perception** (`perceived`, docs/specs/005-muse-sees): a message with no words (a shared reel, a photo) can be READ by a model first
 * (`src/services/perception/`), and this turn then answers the description, which is the row's `text`. Four things change for such a turn and for no
 * other: the refund/complaint prefilter does not read the description (a model's "a screenshot of a refund policy" is not a customer asking for a refund,
 * R9: only words a person typed are read for it); the description is told to the model as a fact, the facts block's "What the customer sent"; a personal
 * document goes to a person without a model ever being asked; and the legacy Gemini path is never the fallback (its key may be a free-tier one, which
 * trains on what it is sent), so a model that fails is a hand-off. The reply's `ai_meta` also says it was perceived and why it did what it did
 * (`traceReason`, built by the code, not written by the model). Absent (every turn there was before), none of this exists, not even a key in `ai_meta`.
 *
 * Once a turn is recorded, `handoff.ts` tells the owner when it handed the conversation over (or sent a hot lead its link): best effort,
 * after the customer has been answered, and never able to change the reply or the state. What this module does not do: send the
 * follow-up itself (S9's job does, `followupJob.ts`).
 */
import { queryCount } from '../../db/query.js';
import { checkFairSendQuota } from '../../utils/rateLimiter.js';
import { describeError, log } from '../../utils/log.js';
import { applyDisclosure, toMetaMessage, type MetaMessagePayload } from '../../webhook/meta-payload.js';
import { decideAgent, generateAiResponse, type AiResponse } from '../ai.js';
import { generate } from '../aiProviders/generate.js';
import { DM_MAX_TOKENS, DM_TIMEOUT_MS, failureOf, readDmEngine, type DmFailure } from '../dmEngine.js';
import { sendDirectMessage, sendSenderAction, type SenderAction } from '../instagram.js';
import type { LlmTurn } from '../llm/types.js';
import { traceReason } from '../perception/trace.js';
import type { PerceptionKind } from '../perception/types.js';
import type { ProfileContext } from '../profile/context.js';
import { kitFor, type SalesKit } from '../profile/kits.js';
import { bridgeFacts, commentSource, openingStage } from './bridge.js';
import { coerceSalesReply, type SalesOfferRef } from './coerce.js';
import {
    abuseDecision, decideTurn, handoffDecision, loopDecision, MAX_AI_REPLIES_PER_HOUR, optOutDecision, unchangedDecision, type TurnDecision,
} from './flow.js';
import { scheduleFollowup } from './followupJob.js';
import { guardReply, type GuardedReply, type Violation } from './guard.js';
import { noticeFor, notifyOwner } from './handoff.js';
import { intentForPayload } from './iceBreakers.js';
import { linkFor } from './link.js';
import { prefilter, type PrefilterDecision } from './prefilter.js';
import { buildSalesPrompt, creatorName, salesFactsBlock } from './prompt.js';
import { readConversationVariant, readVariantConfig } from './variantStore.js';
import { activeVariants, chooseVariant, variantGuidance, type VariantChoice } from './variants.js';
import { salesReplySchema } from './schema.js';
import type { SalesTransport, SentMessage } from './transport.js';
import { salesTurns, STRUCTURED_TEMPLATE_TEXT } from './history.js';
import { loadAgent, loadHistory, loadSalesState, recordTurn, supersession, type HistoryRow, type SalesState, type TurnRecord } from './store.js';
import { capUtf8Bytes, utf8Bytes } from './text.js';
import { MAX_REPLY_BYTES, NO_OFFER, type Intent, type SalesQuickReply, type SalesFacts, type SalesReply } from './types.js';

/** How much of the conversation the model reads: the last twelve messages (DM plan §3). */
export const SALES_HISTORY_WINDOW = 12;

/** Instagram's limit on a message's text, in UTF-8 bytes (assumption A3). A reply is capped lower (`MAX_REPLY_BYTES`) so a disclosure fits in front. */
export const META_TEXT_BYTES = 1000;

// ─── Words for the model ─────────────────────────────────────────────────────────────────────

/** The conversation as the model's turns (`history.ts`): kept importable from here, where the turn that reads it lives. */
export { salesTurns } from './history.js';

/**
 * The correction after a reply the guard refused: what it said that the data does not, and what to do instead. Plain English whatever the
 * customer's language (the reply's language is theirs, which the rules already say), and shown to nobody but the model.
 */
export function claimCorrection(violations: readonly Violation[], owner: string): string {
    const found = [...new Set(violations.map((v) => `${v.kind}: ${v.found}`))].slice(0, 6).join('; ');
    return `Your last reply was NOT sent: it stated something the information above does not give (${found}). Write the reply again without any number, price, discount, coupon, `
        + `free offer or link that the information above does not contain. If you cannot answer without one, say you will check with ${owner}: next_action = handoff, handoff_reason = unsure. Reply in the same format.`;
}

// ─── Words for the customer ──────────────────────────────────────────────────────────────────

/**
 * What is sent for a reply: the model's text, then the link on its own line, within `MAX_REPLY_BYTES` of UTF-8 together. The text is cut
 * to what the link leaves room for (whole characters, `capUtf8Bytes`), never the link. Pure.
 */
export function composeText(text: string, link: string | null): string {
    if (!link) return capUtf8Bytes(text.trim(), MAX_REPLY_BYTES);
    const tail = `\n${link}`;
    const head = capUtf8Bytes(text.trim(), Math.max(0, MAX_REPLY_BYTES - utf8Bytes(tail)));
    return head ? `${head}${tail}` : link;
}

/** A reply as Meta's Send API takes it: the text, with its buttons when it has any. */
export function salesPayload(text: string, quick: readonly SalesQuickReply[]): MetaMessagePayload {
    if (quick.length === 0) return { text };
    return { text, quick_replies: quick.map((q) => ({ content_type: 'text', title: q.title, payload: q.payload })) };
}

/** The disclosure in front of a reply, or on its own when the reply is too long to carry it (the 1,000-byte limit is on the whole text). */
export function withDisclosure(payload: MetaMessagePayload, line: string): { payload: MetaMessagePayload; standalone: string | null } {
    const carried = applyDisclosure(payload, line);
    if (carried.standalone === null && utf8Bytes(carried.payload.text ?? '') > META_TEXT_BYTES) return { payload, standalone: line };
    return carried;
}

// ─── The turn ────────────────────────────────────────────────────────────────────────────────

/** What the pipeline hands a turn. */
export interface SalesTurnInput {
    creator: { id: string; page_access_token: string };
    /** The Facebook Page id when the DM is a Messenger one; undefined for Instagram (the endpoint `me`). */
    pageId: string | undefined;
    conversation: { id: string };
    /** The message being answered: its row, the sender and the text stored for it (`dmPromptText`). */
    inbound: { id: string; senderId: string; text: string; /** The code of the quick reply they tapped, when it was a tap: the model is told which button it was. */ payload?: string };
    /** The profile's DM context: language, offers, the owner's name and hours. */
    ctx: ProfileContext<'dm'>;
    /** Whether the automated-service disclosure goes in front of this reply, and its words (the pipeline's `needsDisclosure`). */
    disclosure: { needed: boolean; line: string };
    /**
     * Where the words go when this is not Instagram or Messenger (a WhatsApp conversation): see `transport.ts` for what changes. Absent, the Send API
     * and everything below are exactly what they were; `creator.page_access_token` and `pageId` are then the Instagram or Messenger ones, and with a
     * transport they are not read.
     */
    transport?: SalesTransport;
    /**
     * A3: what the facts block says about the click-to-message ad this conversation began from. Given by the webhook only when the owner switched
     * `ads.bot_context` on and the conversation is an ad one; absent, the prompt is byte for byte what it was.
     */
    ad?: SalesFacts['ad'];
    /** Meta Muse perception: this turn answers something a model READ for the customer. See the top of the file. Absent: a turn exactly as it always was. */
    perceived?: PerceivedTurn;
}

/** What a perceived turn is told, by the pipeline (`src/webhook/messaging.ts`), from the perception it stored (`src/services/perception/`). */
export interface PerceivedTurn {
    /** What was read: the trace says it, and a kind is all it needs. */
    kind: PerceptionKind;
    /**
     * `inbound.text` is the model's DESCRIPTION of what they sent (`[shared reel] A reel about …`), not words they typed, so the refund/complaint prefilter does not read it
     * (R9), and the reply is answered from the description alone. False when the words are theirs: typed (a reply to a story that has some: the story is only context) or
     * SPOKEN (a voice note's transcript is what they said, and a refund asked for aloud is a refund asked for), and the prefilter then reads them as ever.
     */
    describedText: boolean;
    /** The facts block's "What the customer sent: …" line (`perceivedFact`), already one line. Null: nothing to add. */
    sent: string | null;
    /** How the trace begins, naming how it was looked at (`readPhrase`: "Watched a shared reel"). Absent: "Read <what>". */
    read?: string;
    /** The media is a personal document: the chat is handed to a person and the model is never asked, whatever the person's words say. */
    personal?: boolean;
}

export type SalesTurnOutcome =
    | 'sent'          // a reply went out
    | 'handoff'       // the hand-off line went out, and the bot is paused
    | 'opt_out'       // the opt-out line went out, and the bot is paused
    | 'calm'          // the first insult: one calm line
    | 'paused'        // nothing sent: a second insult, or a loop
    | 'superseded'    // a later message (or a reply) took this one's place
    | 'agent_off';    // the owner's agent is switched off: nothing to say

export type SalesTurnResult =
    /** `modelFailed` is set only for a turn with a transport, when the model could not answer and the conversation was handed to a person: the reason, for the channel's own record. */
    | { kind: 'done'; outcome: SalesTurnOutcome; modelFailed?: string }
    /** The tenant's (or the app's) hourly send quota is spent: nothing was sent. The pipeline retries or gives up, as it does for the old path. */
    | { kind: 'quota'; count: number; limit: number; blockedBy: string | null };

/** The prefilter's signals as the intents they stand for, for `last_intent`. */
const INTENT_OF: Record<'refund' | 'complaint' | 'opt_out' | 'abuse', Intent> = {
    refund: 'refund_or_complaint', complaint: 'refund_or_complaint', opt_out: 'opt_out', abuse: 'abuse',
};

interface Answer {
    json: unknown;
    model: string;
    provider: string;
    usageId: string;
    ms: number;
}

/** What `evaluate` made of one answer. */
interface Evaluated {
    reply: SalesReply;
    repaired: string[];
    decision: TurnDecision;
    /** The link to put after the text: only when the decision's action is `send_link`. */
    link: string | null;
    /** The model's text, cleaned and checked: null when what is sent is not the model's text. */
    guarded: GuardedReply | null;
    /** The model's words are what is sent, and there are none. */
    empty: boolean;
}

/** What `conclude` is given to say and record. */
interface Ending {
    intent: Intent | null;
    offerId: string | null;
    /** The words to send; null sends nothing. */
    text: string | null;
    link: string | null;
    quick: readonly SalesQuickReply[];
    meta: Record<string, unknown>;
    /** A payload built elsewhere (the legacy Gemini answer, which may be a carousel), sent as it is. */
    payload?: MetaMessagePayload;
    messageType?: string;
}

/** What is sent for the model's own text: a reply, or a close that is not an opt-out. */
const sendsModelText = (d: TurnDecision): boolean => d.effect === 'reply' || (d.effect === 'close' && !d.optOut);

/**
 * The one line of why for a perceived turn's reply: the ending's own (a personal document), else built from what was read and what the code decided. A model that
 * failed is recognised by the `model_failed` the ending records, never by a guess.
 */
function perceivedReason(perceived: PerceivedTurn, decision: TurnDecision, o: Ending): string {
    if (typeof o.meta.reason === 'string') return o.meta.reason;
    return traceReason({
        kind: perceived.kind, effect: decision.effect, action: decision.action, handoffReason: decision.handoffReason, intent: o.intent,
        modelFailed: typeof o.meta.model_failed === 'string',
        ...(perceived.read ? { read: perceived.read } : {}),
    });
}

export async function runSalesTurn(input: SalesTurnInput): Promise<SalesTurnResult> {
    const startedAt = Date.now();
    const { creator, conversation, inbound, ctx, transport } = input;
    const kit = kitFor(ctx.language).sales;
    const owner = creatorName(ctx, kit);
    const logBase = { creator_id: creator.id, conversation_id: conversation.id };

    const state = await loadSalesState(conversation.id);

    /** The A/B arm this conversation is in, once the turn knows it (S14): what `ai_meta.variant` records, and what the record assigns when it is new. */
    let variantId: string | null = null;
    let variantAssign: string | null = null;

    /** What every ending shares: the quota, the disclosure, the send, and the one statement that records the reply with the new state. */
    const conclude = async (decision: TurnDecision, o: Ending): Promise<SalesTurnResult> => {
        const record: TurnRecord = {
            conversationId: conversation.id, creatorId: creator.id,
            stage: decision.stage, qualifierTurns: decision.qualifierTurns, abuseStrikes: decision.abuseStrikes,
            intent: o.intent,
            offerId: decision.effect === 'reply' && o.offerId && o.offerId !== NO_OFFER ? o.offerId : null,
            linkedOfferId: decision.action === 'send_link' && o.offerId && o.offerId !== NO_OFFER ? o.offerId : null,
            pauseBot: decision.effect === 'handoff' || decision.effect === 'pause' || decision.optOut,
            handoffReason: decision.effect === 'handoff' || decision.effect === 'pause' ? decision.handoffReason : null,
            stampHandoff: decision.stage === 'handoff',
            optOut: decision.optOut,
            variant: variantAssign,
            message: null,
        };
        const outcome: SalesTurnOutcome = decision.effect === 'handoff' ? 'handoff' : decision.optOut ? 'opt_out'
            : decision.effect === 'calm' ? 'calm' : decision.effect === 'pause' ? 'paused' : 'sent';
        const done = (): SalesTurnResult => {
            log('info', 'dm.sales_turn', {
                ...logBase, outcome, effect: decision.effect, stage: decision.stage, action: decision.action, intent: o.intent,
                handoff_reason: decision.handoffReason, overrides: decision.overrides, engine: o.meta.engine, duration_ms: Date.now() - startedAt,
            });
            return { kind: 'done', outcome, ...(transport && typeof o.meta.model_failed === 'string' ? { modelFailed: o.meta.model_failed } : {}) };
        };

        /** Recorded: now, and only now, the owner is told (when this turn is one he needs to hear of). `notifyOwner` never throws. */
        const finish = async (): Promise<SalesTurnResult> => {
            const plan = noticeFor(decision, { intent: o.intent, linkSent: o.link !== null });
            if (plan) await notifyOwner({ creatorId: creator.id, conversationId: conversation.id, plan, language: ctx.language.code });
            return done();
        };

        if (o.text === null && o.payload === undefined) {
            await recordTurn(record);
            return finish();
        }

        const payload = o.payload ?? salesPayload(o.text ?? '', o.quick);
        const messageType = o.messageType ?? (payload.quick_replies ? 'quick_reply' : 'text');

        // One quota check per reply, as the old path does it: a disclosure that travels as its own message is still one reply. The quota is Instagram's
        // (a pool shared by every tenant's Instagram and Messenger sends): WhatsApp's own limits are Meta's, and the sender answers for them.
        if (!transport) {
            const quota = await checkFairSendQuota(creator.id, 'dm');
            if (!quota.allowed) {
                log('error', 'dm.quota_exhausted', {
                    ...logBase, count: quota.count, limit: quota.limit, blocked_by: quota.blockedBy, app_count: quota.app.count, app_limit: quota.app.limit, source: 'dm',
                });
                return { kind: 'quota', count: quota.count, limit: quota.limit, blockedBy: quota.blockedBy };
            }
        }

        let outgoing = payload;
        let sent: SentMessage | null = null;
        if (transport) {
            // One message, whatever it carries (review M14): the disclosure is a line in front of the words, never a bubble of its own. WhatsApp's limits
            // (4,096 characters, 1,024 beside buttons) leave room for it, and the shaper cuts at a sentence if they ever do not.
            if (input.disclosure.needed) {
                const carried = applyDisclosure(payload, input.disclosure.line);
                outgoing = carried.standalone === null ? carried.payload : { ...payload, text: carried.standalone };
            }
            sent = await transport.send(outgoing);
            log('info', 'dm.sent', { ...logBase, message_type: messageType, disclosed: input.disclosure.needed, sales: true, channel: transport.channel });
        } else {
            if (input.disclosure.needed) {
                const disclosed = withDisclosure(payload, input.disclosure.line);
                outgoing = disclosed.payload;
                if (disclosed.standalone) {
                    log('info', 'dm.disclosure_standalone', logBase);
                    await sendDirectMessage(inbound.senderId, { text: disclosed.standalone }, creator.page_access_token, input.pageId);
                }
            }
            await sendDirectMessage(inbound.senderId, outgoing, creator.page_access_token, input.pageId);
            log('info', 'dm.sent', { ...logBase, message_type: messageType, disclosed: input.disclosure.needed, sales: true });
        }

        // Recorded only after the send landed, so a failed first reply still discloses next time: the statement the old path uses.
        if (input.disclosure.needed) await queryCount('UPDATE conversations SET ai_disclosed_at = NOW() WHERE id = $1', [conversation.id]);

        record.message = {
            type: messageType,
            text: payload.text || STRUCTURED_TEMPLATE_TEXT,
            // What the reply itself was, as the old path stores it: the disclosure is a prefix on the wire, not part of what the bot said.
            payload,
            aiMeta: {
                ...o.meta, intent: o.intent, offer_id: o.offerId ?? NO_OFFER, stage: decision.stage, next_action: decision.action,
                handoff_reason: decision.handoffReason, latency_ms: Date.now() - startedAt,
                ...(variantId ? { variant: variantId } : {}),
                ...(transport ? { channel: transport.channel } : {}),
                // The decision trace (US5): that this reply answered something that was read, and the one line of why. Only for such a turn, so every other reply's
                // `ai_meta` has not one key more than it had.
                ...(input.perceived ? { perceived: true, reason: perceivedReason(input.perceived, decision, o) } : {}),
            },
        };
        const recorded = await recordTurn(record);
        // The channel's own bookkeeping for the row just written (WhatsApp: the id a delivery status finds the message by). Never throws.
        if (transport && sent) await transport.recorded(recorded.replyId, sent);

        // 12. A link just went out: queue the ONE follow-up for it (`followupJob.ts`). After the record, best effort and never throwing, so a
        // failure to queue can never make this job run again and answer the person twice. Only a sales turn is here, so `sales_mode = 'off'`
        // (and a test sender who is not listed) queues nothing. A conversation on another channel says so, and `scheduleFollowup` queues nothing for it.
        if (record.linkedOfferId && o.link) {
            await scheduleFollowup({
                creatorId: creator.id, conversationId: conversation.id, senderId: inbound.senderId, pageId: input.pageId,
                offerId: record.linkedOfferId, recorded,
                ...(transport ? { channel: transport.channel } : {}),
            });
        }
        return finish();
    };

    // 2. Is this still the message to answer?
    const gone = await supersession(conversation.id, inbound.id);
    if (gone.newerUnhandled || gone.answered) {
        log('info', 'dm.sales_superseded', { ...logBase, newer_unhandled: gone.newerUnhandled, answered: gone.answered });
        return { kind: 'done', outcome: 'superseded' };
    }

    // 3. The agent. The owner's switch is honoured exactly as `generateAiResponse` honours it: off or unconfigured, say nothing.
    const agentChoice = decideAgent(await loadAgent(creator.id), false, ctx.language.code);
    if (!agentChoice.speak) {
        log(agentChoice.reason === 'unconfigured' ? 'warn' : 'debug', `ai.${agentChoice.reason}`, { creator_id: creator.id });
        return { kind: 'done', outcome: 'agent_off' };
    }
    const agent = agentChoice.agent;

    // A conversation that is looping ends itself, quietly (15 bot replies in an hour is not a conversation).
    if (state.aiRepliesLastHour >= MAX_AI_REPLIES_PER_HOUR) {
        log('error', 'dm.sales_reply_cap', { ...logBase, replies_last_hour: state.aiRepliesLastHour });
        return conclude(loopDecision(state), { intent: null, offerId: null, text: null, link: null, quick: [], meta: { engine: 'rule' } });
    }

    // A personal document (an ID, a card, a receipt with personal data): a person looks, and no model is asked what it shows or what to say. The customer is told
    // exactly what a refund is told: a person has been told. Nothing about what was in it is said to anyone, here or in the owner's alert.
    if (input.perceived?.personal) {
        const decision = handoffDecision('unsure', state);
        log('info', 'dm.sales_personal_media', logBase);
        return conclude(decision, {
            intent: null, offerId: null, text: lineFor(decision, null, ctx, kit, owner, 'handoff'), link: null, quick: [],
            meta: { engine: 'rule', reason: traceReason({ kind: input.perceived.kind, effect: decision.effect, action: decision.action, handoffReason: decision.handoffReason, intent: null, personal: true }) },
        });
    }

    // 4. Before any model: the messages that need a person, or a stop, or a calm word. A DESCRIPTION is not read for them (R9): what a model said it saw is not what
    // the person said, and a screenshot of a refund policy is not a refund request.
    const pre: PrefilterDecision = input.perceived?.describedText ? { action: 'pass' } : prefilter(inbound.text);
    if (pre.action !== 'pass') {
        const signal = pre.action === 'opt_out' ? 'opt_out' : pre.reason;
        const decision = decisionForPrefilter(pre, state);
        log('info', 'dm.sales_prefilter', { ...logBase, action: pre.action, signal, also: pre.also });
        return conclude(decision, {
            intent: INTENT_OF[signal], offerId: null, text: lineFor(decision, null, ctx, kit, owner), link: null, quick: [],
            meta: { engine: 'prefilter', prefilter: signal },
        });
    }

    // 5. The model. The prompt's static part is the same on every turn of this tenant (cacheable); the facts of this conversation ride with the message.
    const prompt = buildSalesPrompt({ persona: agent.system_prompt, knowledge: agent.knowledge_base, ctx, timezone: ctx.timezone, now: new Date() });
    // Where the conversation began (S10), read beside the history: one statement that never throws (`commentSource`). A source is a conversation that
    // began with a comment and the link in its private reply, which moves where a fresh one starts and what the model is told, and nothing else.
    // Neither is for another channel: a comment's private reply and the owner's A/B wording are Instagram's and Messenger's, and a WhatsApp conversation
    // is not given an arm in an experiment that was set up to compare how Instagram replies are worded.
    const [source, history, experiment] = await Promise.all([
        transport ? Promise.resolve(null) : commentSource({ conversationId: conversation.id, creatorId: creator.id, senderId: inbound.senderId, platform: input.pageId ? 'facebook' : 'instagram' }),
        loadHistory(conversation.id, SALES_HISTORY_WINDOW).then((rows) => readableHistory(rows, transport)),
        transport ? Promise.resolve(null) : readVariantConfig(creator.id),
    ]);

    // S14: the owner's wording experiment, when one is RUNNING. Only a conversation with no bot reply yet is new; the arm is the one it already has, or
    // the one its id hashes to. A tenant with no experiment goes no further than the read above, and every failure here is "no arm".
    const firstReply = !history.some((h) => h.direction === 'outbound' && h.sender === 'ai');
    let chosenVariant: VariantChoice = { variant: null, assign: null };
    if (activeVariants(experiment)) {
        const stored = await readConversationVariant(conversation.id, creator.id);
        if (stored.ok) {
            chosenVariant = chooseVariant({ config: experiment, stored: stored.variant, conversationId: conversation.id, isNew: firstReply });
            variantAssign = chosenVariant.assign;
            variantId = stored.variant ?? chosenVariant.assign;
        }
    }
    const guidance = variantGuidance(chosenVariant.variant, firstReply);
    const bridged = source ? bridgeFacts(source, ctx.offers) : null;
    const stage = openingStage(state, source);
    // A tap on one of the owner's own buttons (an ice breaker or a menu item, S13) says what it asks by its code: the model is told that, in the
    // schema's own words, and not left to read it from the title. Any other payload (a quick reply this bot offered, a campaign's) says nothing here.
    const tappedIntent = intentForPayload(inbound.payload);
    const factsBlock = salesFactsBlock(ctx, {
        stage: stage === 'handoff' ? 'new' : stage, qualifierTurns: state.qualifierTurns,
        linkSentFor: [...new Set([...state.offersLinked, ...(bridged?.linkSentFor ?? [])])],
        ...(bridged ? { comment: bridged.comment } : {}),
        ...(tappedIntent ? { tapped: { intent: tappedIntent } } : {}),
        ...(guidance ? { variant: guidance } : {}),
        ...(transport ? { channel: transport.channel } : {}),
        ...(input.ad ? { ad: input.ad } : {}),
        // What a model said it saw, said last, next to the customer's message. It is NOT among the guard's facts below: a number or a price in a picture is not one the
        // reply may state unless the information above gives it.
        ...(input.perceived?.sent ? { sent: input.perceived.sent } : {}),
    });
    const schema = salesReplySchema(prompt.offers.map((o) => o.id));
    const baseTurns = salesTurns(history, inbound.text, owner, factsBlock, inbound.payload);
    const offers = new Map(ctx.offers.map((o) => [o.id, o]));
    const refs: SalesOfferRef[] = prompt.offers.map((o) => ({ id: o.id, hasLink: o.hasLink }));

    /** Never silence: the legacy Gemini path once, when the owner wants it; else a hand-off. */
    const modelFailed = async (failure: DmFailure): Promise<SalesTurnResult> => {
        if (transport || input.perceived) {
            // Never the legacy Gemini path for another channel (review C1): its key may be a free-tier one, which trains on what it is sent, and a
            // customer's WhatsApp words do not go there. Not the engine setting, not `gemini_fallback`: a person has the chat. `dm.engine_failed` says why.
            // The same for a turn that answers what a model READ (FR-006b): what the customer sent is not told to a provider that may train on it.
            log('error', 'dm.engine_failed', {
                ...logBase, source: 'dm', engine: 'providers', reason: failure.reason, message: failure.message, fallback: 'never',
                ...(transport ? { channel: transport.channel } : {}), sales: true, ...(input.perceived ? { perceived: true } : {}),
            });
            const decision = handoffDecision('unsure', state);
            return conclude(decision, {
                intent: null, offerId: null, text: lineFor(decision, null, ctx, kit, owner, 'handoff'), link: null, quick: [],
                meta: { engine: 'rule', model_failed: failure.reason },
            });
        }
        const { geminiFallback } = await readDmEngine(creator.id);
        let legacy: AiResponse | null = null;
        if (geminiFallback) {
            log('warn', 'dm.engine_fallback', { ...logBase, source: 'dm', from: 'providers', to: 'gemini', reason: failure.reason, message: failure.message, sales: true });
            try {
                legacy = await generateAiResponse(conversation.id, inbound.text, creator.id, undefined, ctx);
            } catch (err) {
                const second = failureOf(err);
                log('error', 'dm.engine_failed', {
                    ...logBase, source: 'dm', engine: 'providers', reason: failure.reason, message: failure.message,
                    fallback: 'failed', fallback_reason: second.reason, fallback_message: second.message, sales: true,
                });
            }
        } else {
            log('error', 'dm.engine_failed', { ...logBase, source: 'dm', engine: 'providers', reason: failure.reason, message: failure.message, fallback: 'off', sales: true });
        }
        if (legacy) {
            // Gemini's answer knows nothing of the flow, so the flow does not move for it.
            const payload = toMetaMessage(legacy);
            return conclude(unchangedDecision(state.stage, state, ['model_failed']), {
                intent: null, offerId: null, text: payload.text ?? null, link: null, quick: [], payload, messageType: legacy.message_type,
                meta: { engine: 'gemini_fallback', fell_back_from: failure.reason },
            });
        }
        const decision = handoffDecision('unsure', state);
        return conclude(decision, {
            intent: null, offerId: null, text: lineFor(decision, null, ctx, kit, owner, 'handoff'), link: null, quick: [],
            meta: { engine: 'rule', model_failed: failure.reason },
        });
    };

    const ask = async (turns: LlmTurn[]): Promise<{ ok: true; answer: Answer } | { ok: false; failure: DmFailure }> => {
        try {
            const result = await generate({
                // `dm_whatsapp` answers only from providers that do not train on what they are sent (`aiProviders/purposes.ts`); any other is `no_provider`.
                purpose: transport ? 'dm_whatsapp' : 'dm', creatorId: creator.id, system: prompt.prefix, user: turns, schema, maxTokens: DM_MAX_TOKENS, timeoutMs: DM_TIMEOUT_MS, cacheSystem: true,
            });
            return { ok: true, answer: { json: result.json, model: result.model, provider: result.provider, usageId: result.usageId, ms: result.elapsed_ms } };
        } catch (err) {
            return { ok: false, failure: failureOf(err) };
        }
    };

    /** An answer, coerced, ruled on and checked. Async only because the link may be a tracked one (S7) that has to be created. */
    const evaluate = async (json: unknown, final: boolean): Promise<Evaluated> => {
        let { reply, repaired } = coerceSalesReply(json, { offers: refs, fallbackStage: stage });
        const decision = decideTurn(stage, reply, { qualifierTurns: state.qualifierTurns, abuseStrikes: state.abuseStrikes, final });

        let link: string | null = null;
        const offer = offers.get(reply.offer_id);
        if (decision.action === 'send_link' && offer) {
            link = await linkFor(offer, { id: conversation.id, creatorId: creator.id });
            // The link takes room out of the 900 bytes: the text is cut again to fit beside it.
            ({ reply, repaired } = coerceSalesReply(json, { offers: refs, fallbackStage: stage, reserveBytes: utf8Bytes(`\n${link}`) }));
        }

        let guarded: GuardedReply | null = null;
        let empty = false;
        if (sendsModelText(decision)) {
            // The link the server is inserting is on the allowlist, so a model that repeats it (it is never shown it) is not stripped of it.
            // The keyword they commented was shown to the model in the facts, so it is data like the rest (a keyword with a digit in it is no invented number).
            const claims = {
                ...prompt.claims,
                texts: bridged?.comment.keyword ? [...prompt.claims.texts, bridged.comment.keyword] : prompt.claims.texts,
                allowedLinks: [...(prompt.claims.allowedLinks ?? []), ...(link ? [link] : [])],
            };
            guarded = guardReply(reply.text, claims);
            empty = guarded.text.trim().length === 0;
        }
        return { reply, repaired, decision, link, guarded, empty };
    };

    // `mark_seen` and `typing_on` go out while the model thinks, and are done before anything is sent.
    const seenAndTyping = transport ? transport.seen() : startSenderActions(inbound.senderId, creator.page_access_token, input.pageId);

    // The first try, and ONE more with a correction when the answer broke a rule only a rewrite can mend.
    let chosen: Evaluated | null = null;
    let answer: Answer | null = null;
    let retried: 'claims' | 'flow' | null = null;
    let attempts = 0;
    let turns = baseTurns;
    for (let attempt = 0; attempt < 2; attempt++) {
        attempts = attempt + 1;
        const asked = await ask(turns);
        if (!asked.ok) {
            await seenAndTyping;
            return modelFailed(asked.failure);
        }
        answer = asked.answer;
        const evaluated = await evaluate(asked.answer.json, attempt === 1);
        if (evaluated.empty) {
            await seenAndTyping;
            return modelFailed({ reason: 'empty_reply', message: 'The model returned a structured response with no usable text.' });
        }
        const violations = evaluated.guarded?.violations ?? [];
        if (violations.length > 0) {
            log('warn', 'dm.claim_blocked', {
                ...logBase, attempt: attempts, violations: violations.map((v) => `${v.kind}:${v.found}`), links_removed: evaluated.guarded?.linksRemoved.length ?? 0,
            });
        }
        const correction = violations.length > 0 ? claimCorrection(violations, owner) : evaluated.decision.correction;
        if (!correction) {
            chosen = evaluated;
            break;
        }
        if (attempt === 1) {
            // Written again and still wrong. The kit's safe line, and a person: never the text.
            await seenAndTyping;
            const decision = handoffDecision('unsure', state);
            return conclude(decision, {
                intent: evaluated.reply.intent, offerId: null, text: lineFor(decision, null, ctx, kit, owner, 'unsure'), link: null, quick: [],
                meta: answerMeta(answer, attempts, 'claims', evaluated),
            });
        }
        retried = violations.length > 0 ? 'claims' : 'flow';
        turns = [...baseTurns, { role: 'model', text: evaluated.guarded?.text || evaluated.reply.text || '…' }, { role: 'user', text: correction }];
    }
    await seenAndTyping;
    if (!chosen || !answer) return modelFailed({ reason: 'no_answer', message: 'The model gave no answer to act on.' });

    const { decision } = chosen;

    // A message with no words is answered after a read that takes seconds, and its siblings arrive in them: three photos in a burst are ONE answer, the newest's, and so are
    // two voice notes. The check made at the top of the turn could not see a sibling whose own read had not finished, so it is made again now that the answer is written and
    // before it is sent. Only for a turn whose text a read made (a description, or a voice note's words: typed words are ready when they arrive), and only for a plain
    // reply: a hand-off, an opt-out and a calm word are decisions that must not be lost to a message that has not been read yet.
    if (input.perceived && (input.perceived.describedText || input.perceived.kind === 'audio') && decision.effect === 'reply') {
        const late = await supersession(conversation.id, inbound.id);
        if (late.newerUnhandled || late.answered) {
            log('info', 'dm.sales_superseded', { ...logBase, newer_unhandled: late.newerUnhandled, answered: late.answered, late: true });
            return { kind: 'done', outcome: 'superseded' };
        }
    }

    return conclude(decision, {
        intent: chosen.reply.intent,
        offerId: chosen.reply.offer_id,
        text: lineFor(decision, chosen, ctx, kit, owner),
        link: chosen.link,
        quick: sendsModelText(decision) ? chosen.reply.quick_replies : [],
        meta: answerMeta(answer, attempts, retried, chosen),
    });
}

/**
 * The history as the model reads it, for a channel that cleans the customer's words (`SalesTransport.readable`): only the INBOUND rows pass through it, and a
 * turn with no transport (Instagram, Messenger) gets the very array it was handed, so what those channels read is not touched by any of this.
 */
function readableHistory(rows: HistoryRow[], transport: SalesTransport | undefined): HistoryRow[] {
    const readable = transport?.readable;
    if (!readable) return rows;
    return rows.map((row) => (row.direction === 'inbound' && typeof row.text === 'string' ? { ...row, text: readable(row.text) } : row));
}

/** The prefilter's verdict as the decision `flow.ts` makes of it. */
function decisionForPrefilter(pre: Exclude<PrefilterDecision, { action: 'pass' }>, state: SalesState): TurnDecision {
    if (pre.action === 'opt_out') return optOutDecision(state);
    if (pre.reason === 'abuse') return abuseDecision(state.stage, state);
    return handoffDecision(pre.reason, state, pre.also.includes('opt_out'));
}

/**
 * The words that go out for a decision: the kit's line for every ending that is not the model's own text (it is never the model's, which
 * is the point of a hand-off), and the model's text, cleaned, with its link after it, for a reply. null: nothing is sent.
 *
 * `which` picks the hand-off line when the reason alone does not say: a model that failed hands over with "a person has been told", a
 * claim the data could not support with "I will check with the owner".
 */
function lineFor(
    d: TurnDecision, chosen: Evaluated | null, ctx: ProfileContext<'dm'>, kit: SalesKit, owner: string, which?: 'handoff' | 'unsure'
): string | null {
    switch (d.effect) {
        case 'pause': return null;
        case 'calm': return kit.lines.calm;
        case 'handoff': {
            const unsure = which ? which === 'unsure' : d.handoffReason === 'unsure';
            return capUtf8Bytes(unsure ? kit.lines.unsure(owner) : (ctx.handoff?.message.trim() || kit.lines.handoff(owner)), MAX_REPLY_BYTES);
        }
        case 'close': return d.optOut ? kit.lines.optOut : modelText(chosen);
        default: return modelText(chosen);
    }
}

/** The model's own words after the guard, with the server's link after them (unless the model's text already holds exactly that link). */
function modelText(chosen: Evaluated | null): string | null {
    if (!chosen?.guarded) return null;
    const { link, guarded } = chosen;
    return composeText(guarded.text, link && !guarded.text.includes(link) ? link : null);
}

/** What `messages.ai_meta` says about a model's answer: the proposal, what the code made of it, and what it cost to get. */
function answerMeta(answer: Answer, attempts: number, retried: 'claims' | 'flow' | null, ev: Evaluated): Record<string, unknown> {
    return {
        engine: 'providers',
        proposed_stage: ev.reply.stage,
        proposed_action: ev.reply.next_action,
        model: answer.model,
        provider: answer.provider,
        usage_id: answer.usageId,
        model_ms: answer.ms,
        attempts,
        guard: {
            retried,
            violations: (ev.guarded?.violations ?? []).map((v) => `${v.kind}:${v.found}`),
            links_removed: ev.guarded?.linksRemoved.length ?? 0,
            women_emoji_removed: ev.guarded?.womenEmojiRemoved ?? 0,
            repaired: ev.repaired,
            overrides: ev.decision.overrides,
        },
    };
}

/** `mark_seen` and `typing_on`, started now and awaited by the caller before it sends: best effort, so each failure is logged and ignored. */
function startSenderActions(recipientId: string, token: string, pageId: string | undefined): Promise<void> {
    const one = async (action: SenderAction): Promise<void> => {
        try {
            await sendSenderAction(recipientId, action, token, pageId);
        } catch (err) {
            log('warn', 'dm.sender_action_failed', { action, ...describeError(err) });
        }
    };
    return Promise.all([one('mark_seen'), one('typing_on')]).then(() => undefined);
}
