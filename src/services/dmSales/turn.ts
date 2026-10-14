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
 *
 * **The conversation's facts go with the customer's message, not in the system prompt.** `buildSalesPrompt` makes the system text the same
 * on every turn of one tenant (`prefix`) so the layer's prompt cache (`cacheSystem`) can hit within a live back-and-forth; the stage and
 * the qualifier count change turn to turn, so they ride in front of the last user message instead.
 *
 * **Never silence.** A model that fails (no key, no route, an outage, a timeout, a refused budget, an answer with nothing to send) is
 * answered by the legacy Gemini path ONCE when the agent's `gemini_fallback` is on (the owner's setting, as for the engine switch), and
 * otherwise by a hand-off: the kit's line, the bot paused, a person to answer.
 *
 * What this module does not do: tell the owner (S8's notification), send a follow-up (S9), or know where a conversation began (S10).
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
import type { ProfileContext } from '../profile/context.js';
import { kitFor, type SalesKit } from '../profile/kits.js';
import { coerceSalesReply, type SalesOfferRef } from './coerce.js';
import {
    abuseDecision, decideTurn, handoffDecision, loopDecision, MAX_AI_REPLIES_PER_HOUR, optOutDecision, unchangedDecision, type TurnDecision,
} from './flow.js';
import { guardReply, type GuardedReply, type Violation } from './guard.js';
import { linkFor } from './link.js';
import { prefilter, type PrefilterDecision } from './prefilter.js';
import { buildSalesPrompt, creatorName, salesFactsBlock } from './prompt.js';
import { salesReplySchema } from './schema.js';
import { salesTurns, STRUCTURED_TEMPLATE_TEXT } from './history.js';
import { loadAgent, loadHistory, loadSalesState, recordTurn, supersession, type SalesState, type TurnRecord } from './store.js';
import { capUtf8Bytes, utf8Bytes } from './text.js';
import { MAX_REPLY_BYTES, NO_OFFER, type Intent, type SalesQuickReply, type SalesReply } from './types.js';

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
    | { kind: 'done'; outcome: SalesTurnOutcome }
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

export async function runSalesTurn(input: SalesTurnInput): Promise<SalesTurnResult> {
    const startedAt = Date.now();
    const { creator, conversation, inbound, ctx } = input;
    const kit = kitFor(ctx.language).sales;
    const owner = creatorName(ctx, kit);
    const logBase = { creator_id: creator.id, conversation_id: conversation.id };

    const state = await loadSalesState(conversation.id);

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
            message: null,
        };
        const outcome: SalesTurnOutcome = decision.effect === 'handoff' ? 'handoff' : decision.optOut ? 'opt_out'
            : decision.effect === 'calm' ? 'calm' : decision.effect === 'pause' ? 'paused' : 'sent';
        const done = (): SalesTurnResult => {
            log('info', 'dm.sales_turn', {
                ...logBase, outcome, effect: decision.effect, stage: decision.stage, action: decision.action, intent: o.intent,
                handoff_reason: decision.handoffReason, overrides: decision.overrides, engine: o.meta.engine, duration_ms: Date.now() - startedAt,
            });
            return { kind: 'done', outcome };
        };

        if (o.text === null && o.payload === undefined) {
            await recordTurn(record);
            return done();
        }

        const payload = o.payload ?? salesPayload(o.text ?? '', o.quick);
        const messageType = o.messageType ?? (payload.quick_replies ? 'quick_reply' : 'text');

        // One quota check per reply, as the old path does it: a disclosure that travels as its own message is still one reply.
        const quota = await checkFairSendQuota(creator.id, 'dm');
        if (!quota.allowed) {
            log('error', 'dm.quota_exhausted', {
                ...logBase, count: quota.count, limit: quota.limit, blocked_by: quota.blockedBy, app_count: quota.app.count, app_limit: quota.app.limit, source: 'dm',
            });
            return { kind: 'quota', count: quota.count, limit: quota.limit, blockedBy: quota.blockedBy };
        }

        let outgoing = payload;
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
            },
        };
        await recordTurn(record);
        return done();
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

    // 4. Before any model: the messages that need a person, or a stop, or a calm word.
    const pre = prefilter(inbound.text);
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
    const factsBlock = salesFactsBlock(ctx, {
        stage: state.stage === 'handoff' ? 'new' : state.stage, qualifierTurns: state.qualifierTurns, linkSentFor: state.offersLinked,
    });
    const schema = salesReplySchema(prompt.offers.map((o) => o.id));
    const baseTurns = salesTurns(await loadHistory(conversation.id, SALES_HISTORY_WINDOW), inbound.text, owner, factsBlock, inbound.payload);
    const offers = new Map(ctx.offers.map((o) => [o.id, o]));
    const refs: SalesOfferRef[] = prompt.offers.map((o) => ({ id: o.id, hasLink: o.hasLink }));

    /** Never silence: the legacy Gemini path once, when the owner wants it; else a hand-off. */
    const modelFailed = async (failure: DmFailure): Promise<SalesTurnResult> => {
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
                purpose: 'dm', creatorId: creator.id, system: prompt.prefix, user: turns, schema, maxTokens: DM_MAX_TOKENS, timeoutMs: DM_TIMEOUT_MS, cacheSystem: true,
            });
            return { ok: true, answer: { json: result.json, model: result.model, provider: result.provider, usageId: result.usageId, ms: result.elapsed_ms } };
        } catch (err) {
            return { ok: false, failure: failureOf(err) };
        }
    };

    /** An answer, coerced, ruled on and checked. Async only because the link may be a tracked one (S7) that has to be created. */
    const evaluate = async (json: unknown, final: boolean): Promise<Evaluated> => {
        let { reply, repaired } = coerceSalesReply(json, { offers: refs, fallbackStage: state.stage });
        const decision = decideTurn(state.stage, reply, { qualifierTurns: state.qualifierTurns, abuseStrikes: state.abuseStrikes, final });

        let link: string | null = null;
        const offer = offers.get(reply.offer_id);
        if (decision.action === 'send_link' && offer) {
            link = await linkFor(offer, { id: conversation.id, creatorId: creator.id });
            // The link takes room out of the 900 bytes: the text is cut again to fit beside it.
            ({ reply, repaired } = coerceSalesReply(json, { offers: refs, fallbackStage: state.stage, reserveBytes: utf8Bytes(`\n${link}`) }));
        }

        let guarded: GuardedReply | null = null;
        let empty = false;
        if (sendsModelText(decision)) {
            // The link the server is inserting is on the allowlist, so a model that repeats it (it is never shown it) is not stripped of it.
            const claims = { ...prompt.claims, allowedLinks: [...(prompt.claims.allowedLinks ?? []), ...(link ? [link] : [])] };
            guarded = guardReply(reply.text, claims);
            empty = guarded.text.trim().length === 0;
        }
        return { reply, repaired, decision, link, guarded, empty };
    };

    // `mark_seen` and `typing_on` go out while the model thinks, and are done before anything is sent.
    const seenAndTyping = startSenderActions(inbound.senderId, creator.page_access_token, input.pageId);

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
    return conclude(decision, {
        intent: chosen.reply.intent,
        offerId: chosen.reply.offer_id,
        text: lineFor(decision, chosen, ctx, kit, owner),
        link: chosen.link,
        quick: sendsModelText(decision) ? chosen.reply.quick_replies : [],
        meta: answerMeta(answer, attempts, retried, chosen),
    });
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
