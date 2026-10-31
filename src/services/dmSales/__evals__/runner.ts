/**
 * One golden conversation through the sales pipeline, and a set of them through one model (docs/DM_SALES_PLAN.md §11, E1).
 *
 * The pipeline is the real one, module by module, in the order the plan's flow says (§4, §6):
 *
 *   pre-filter (`prefilter.ts`)  →  prompt (`prompt.ts`) and schema (`schema.ts`)  →  the model  →  `coerceSalesReply`  →  `guardReply`
 *
 * A refund, a complaint, an opt-out or an insult is decided by the pre-filter and never reaches the model; everything else is asked of
 * the model with the prompt built for the conversation's facts at that turn. What the model decided is read AFTER coercion, so a field
 * it got wrong is repaired as it would be in production, and the repair is counted.
 *
 * **What this is not.** It is not the S6 turn (`turn.ts`, which the live path will run): there is no database, no queue, no send, and
 * the state it keeps between turns (stage, questions asked, links sent, paused) is the smallest that makes a multi-turn case honest.
 * Two things S6 does that this does not, on purpose: it asks the model once more with a correction when the guard refuses a reply, and
 * it sends a tracked link. Here the FIRST answer is what is judged, which is the stricter test (a model that needs a second try is a
 * model that is slower and dearer), and the guard's refusal falls to the kit's "I will check" line, as S6's second refusal does.
 *
 * It never throws for a model's failure: a call that fails, or an answer that is not usable, is the turn's own failed check, and the
 * rest of the conversation is skipped (there is nothing for the later turns to follow).
 */
import { createHash } from 'node:crypto';
import { kitFor } from '../../profile/kits.js';
import type { LlmTurn } from '../../llm/types.js';
import { coerceSalesReply } from '../coerce.js';
import { guardReply } from '../guard.js';
import { prefilter, type PrefilterSignal } from '../prefilter.js';
import { buildSalesPrompt, creatorName } from '../prompt.js';
import { salesReplySchema } from '../schema.js';
import { NO_OFFER, type SalesFacts, type SalesReply, type Stage } from '../types.js';
import { checkTurn } from './checks.js';
import { promptDigest, resolveFixture, type EvalFixture } from './fixtures.js';
import { isJudgeFailure, judgeReply, JUDGE_FLOOR, lowestScore } from './judge.js';
import type { CaseOutcome, EvalCase, EvalCaller, EvalRun, EvalTurn, SentKind, TurnOutcome } from './types.js';

/** What a DM call is given in production (`dmEngine.ts`: `DM_TIMEOUT_MS`, `DM_MAX_TOKENS`); `runner.test.ts` holds these two to those. */
export const EVAL_TIMEOUT_MS = 20_000;
export const EVAL_MAX_TOKENS = 4_000;
/** The judge reads a long prompt and writes a few lines: more time, little output. */
export const JUDGE_TIMEOUT_MS = 60_000;
export const JUDGE_MAX_TOKENS = 4_000;

export interface RunSettings {
    /** Asks the model under test. */
    caller: EvalCaller;
    /** Asks the judge, or null to leave the soft checks unscored. */
    judge: EvalCaller | null;
    maxTokens?: number;
    timeoutMs?: number;
    /** Cache the system prompt, as the live path does (`dmEngine.ts`). */
    cacheSystem?: boolean;
}

/** What the conversation knows between turns. The runner's stand-in for the columns S6 adds to `conversations`. */
interface ConversationState {
    facts: SalesFacts;
    /** What was said, in order, as the model is shown it. */
    said: LlmTurn[];
    /** Nothing more is sent: an opt-out, a handoff, a second insult. */
    paused: boolean;
    optedOut: boolean;
    abuseStrikes: number;
}

const errorText = (err: unknown): { kind: string; message: string } => {
    const kind = typeof (err as { kind?: unknown } | null)?.kind === 'string' ? String((err as { kind: string }).kind) : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return { kind, message: message.replace(/\s+/g, ' ').slice(0, 240) };
};

/** The kit's fixed lines for this tenant, which are what a customer is sent when no model's words are. */
function kitLines(fx: EvalFixture): { handoff: string; unsure: string; optOut: string; calm: string } {
    const lines = kitFor(fx.ctx.language).sales.lines;
    const name = creatorName(fx.ctx);
    // A tenant's own hand-off message (typed in Settings) is what a handoff sends; the kit's line is the default.
    const own = fx.ctx.handoff?.message.trim();
    return { handoff: own || lines.handoff(name), unsure: lines.unsure(name), optOut: lines.optOut, calm: lines.calm };
}

const userTurns = (c: EvalCase, state: ConversationState, message: string): LlmTurn[] => [...(c.history ?? []), ...state.said, { role: 'user', text: message }];

/** The decision a pre-filter signal makes, in the vocabulary the model's answers use. */
function prefilterDecision(signal: PrefilterSignal, strikes: number): { reply: Pick<SalesReply, 'next_action' | 'handoff_reason' | 'intent'>; sent: SentKind; pause: boolean; optOut: boolean } {
    switch (signal) {
        case 'refund':
            return { reply: { next_action: 'handoff', handoff_reason: 'refund', intent: 'refund_or_complaint' }, sent: 'handoff', pause: true, optOut: false };
        case 'complaint':
            return { reply: { next_action: 'handoff', handoff_reason: 'complaint', intent: 'refund_or_complaint' }, sent: 'handoff', pause: true, optOut: false };
        case 'opt_out':
            return { reply: { next_action: 'close', handoff_reason: 'none', intent: 'opt_out' }, sent: 'opt_out', pause: true, optOut: true };
        case 'abuse':
            // The first insult gets one calm line; the second pauses the bot and tells nobody (§6).
            return strikes <= 1
                ? { reply: { next_action: 'reply', handoff_reason: 'none', intent: 'abuse' }, sent: 'calm', pause: false, optOut: false }
                : { reply: { next_action: 'handoff', handoff_reason: 'abuse', intent: 'abuse' }, sent: 'none', pause: true, optOut: false };
    }
}

/** The conversation's facts after a turn: what the next prompt will say. Mirrors what S6 stores, and nothing it does not. */
function nextFacts(prev: SalesFacts, reply: Pick<SalesReply, 'stage' | 'next_action' | 'offer_id'>): SalesFacts {
    return {
        ...prev,
        stage: reply.stage,
        qualifierTurns: prev.qualifierTurns + (reply.next_action === 'ask_qualifier' ? 1 : 0),
        linkSentFor: reply.next_action === 'send_link' && reply.offer_id !== NO_OFFER && !prev.linkSentFor.includes(reply.offer_id) ? [...prev.linkSentFor, reply.offer_id] : prev.linkSentFor,
    };
}

/** What the system does with the reply, in words, for the judge. */
function systemAction(reply: SalesReply, offerName: string | null): string {
    const parts = [`next_action: ${reply.next_action}`, `offer: ${offerName ?? 'none'}`];
    if (reply.next_action === 'send_link') parts.push('the system appends the offer\'s tracked link after the reply');
    return parts.join(' · ');
}

async function runTurn(c: EvalCase, fx: EvalFixture, index: number, turn: EvalTurn, state: ConversationState, settings: RunSettings): Promise<{ outcome: TurnOutcome; failed: boolean }> {
    const lines = kitLines(fx);
    const optedOutBefore = state.optedOut;
    const base = { index, user: turn.user, repaired: [] as string[], guardFallback: false, checks: [] };

    // A paused conversation sends nothing: nobody reads the message.
    if (state.paused) {
        const outcome: TurnOutcome = { ...base, route: 'silent', sent: { kind: 'none', text: '' }, paused: true };
        outcome.checks = checkTurn({
            expect: turn.expect, route: 'silent', prefilter: undefined, model: undefined, rawText: undefined, modelFailure: undefined, decision: undefined,
            sentKind: 'none', textIntended: false, paused: true, optedOutBefore, optsOutNow: false, claims: { texts: [], prices: [] },
        });
        return { outcome, failed: false };
    }

    // A model's description of what was sent is not what the person said (R9): only words they typed are read for a refund, a complaint, an opt-out or an insult.
    const pf: ReturnType<typeof prefilter> = turn.perceived?.describedText ? { action: 'pass' } : prefilter(turn.user);
    if (pf.action !== 'pass') {
        const signal: PrefilterSignal = pf.action === 'opt_out' ? 'opt_out' : pf.reason;
        if (signal === 'abuse') state.abuseStrikes += 1;
        const d = prefilterDecision(signal, state.abuseStrikes);
        const text = d.sent === 'handoff' ? lines.handoff : d.sent === 'opt_out' ? lines.optOut : d.sent === 'calm' ? lines.calm : '';
        state.paused = d.pause;
        state.optedOut = state.optedOut || d.optOut;
        if (d.sent !== 'none') state.said.push({ role: 'user', text: turn.user }, { role: 'model', text });
        const stage: Stage = d.reply.next_action === 'handoff' ? 'handoff' : d.reply.next_action === 'close' ? 'closed' : state.facts.stage;
        const outcome: TurnOutcome = { ...base, route: 'prefilter', prefilter: signal, sent: { kind: d.sent, text }, paused: d.pause };
        outcome.checks = checkTurn({
            expect: turn.expect, route: 'prefilter', prefilter: signal, model: undefined, rawText: undefined, modelFailure: undefined,
            decision: { ...d.reply, stage, offer_id: NO_OFFER },
            sentKind: d.sent, textIntended: false, paused: d.pause, optedOutBefore, optsOutNow: d.optOut, claims: { texts: [], prices: [] },
        });
        return { outcome, failed: false };
    }

    // The model's turn.
    // What a model said it saw rides in this turn's facts only: it is not part of the state the next turn starts from.
    const turnFacts: SalesFacts = turn.perceived?.sent ? { ...state.facts, sent: turn.perceived.sent } : state.facts;
    const prompt = buildSalesPrompt({ persona: fx.persona, knowledge: fx.knowledge, ctx: fx.ctx, timezone: fx.timezone, now: fx.now }, turnFacts);
    const request = userTurns(c, state, turn.user);
    let response;
    try {
        response = await settings.caller({
            system: prompt.system,
            user: request,
            schema: salesReplySchema(prompt.offers.map((o) => o.id)),
            maxTokens: settings.maxTokens ?? EVAL_MAX_TOKENS,
            timeoutMs: settings.timeoutMs ?? EVAL_TIMEOUT_MS,
            cacheSystem: settings.cacheSystem ?? true,
            meta: { role: 'sales', case: c.id, turn: index },
        });
    } catch (err) {
        const error = errorText(err);
        const outcome: TurnOutcome = { ...base, route: 'model', prefilter: 'pass', sent: { kind: 'none', text: '' }, paused: false, error };
        outcome.checks = checkTurn({
            expect: turn.expect, route: 'model', prefilter: 'pass', model: undefined, rawText: undefined, decision: undefined,
            modelFailure: `the model did not answer (${error.kind}): ${error.message}`,
            sentKind: 'none', textIntended: false, paused: false, optedOutBefore, optsOutNow: false, claims: prompt.claims,
        });
        return { outcome, failed: true };
    }

    const json = response.json;
    const rawText = typeof (json as { text?: unknown } | null)?.text === 'string' ? (json as { text: string }).text : '';
    const coerced = coerceSalesReply(json, { offers: prompt.offers.map((o) => ({ id: o.id, hasLink: o.hasLink })), fallbackStage: state.facts.stage });
    const reply = coerced.reply;
    const common = { usage: response.usage, usd: response.usd, priced: response.priced, latencyMs: response.latencyMs, modelId: response.model };

    if (!coerced.usable) {
        const outcome: TurnOutcome = { ...base, ...common, route: 'model', prefilter: 'pass', model: reply, rawText, repaired: coerced.repaired, sent: { kind: 'none', text: '' }, paused: false };
        outcome.checks = checkTurn({
            expect: turn.expect, route: 'model', prefilter: 'pass', model: reply, rawText, decision: undefined,
            modelFailure: 'the model answered with no words and no handoff',
            sentKind: 'none', textIntended: false, paused: false, optedOutBefore, optsOutNow: false, claims: prompt.claims,
        });
        return { outcome, failed: true };
    }

    // What the customer is sent, and whether the conversation goes on.
    let sent: { kind: SentKind; text: string };
    let paused = false;
    let guardFallback = false;
    const textIntended = reply.next_action !== 'handoff';
    if (reply.next_action === 'handoff') {
        sent = reply.handoff_reason === 'unsure' ? { kind: 'unsure', text: lines.unsure } : { kind: 'handoff', text: lines.handoff };
        paused = true;
    } else if (reply.next_action === 'close' && reply.intent === 'opt_out') {
        sent = { kind: 'opt_out', text: lines.optOut };
        paused = true;
        state.optedOut = true;
    } else {
        // A case about asking for a discount lets the reply name one (`allow_claim_words`: a refusal says «ما أقدر أعطيك خصم»): the guard's
        // word check cannot tell a refusal from an offer, and a number is never in that allowance. S6 would ask the model once more here.
        const allow = turn.expect.allow_claim_words ?? [];
        const guarded = guardReply(reply.text, prompt.claims);
        if (guarded.violations.every((v) => allow.includes(v.kind as never))) {
            sent = { kind: 'model', text: guarded.text };
            paused = reply.next_action === 'close';
        } else {
            sent = { kind: 'unsure', text: lines.unsure };
            guardFallback = true;
            paused = true;
        }
    }
    state.paused = paused;
    state.facts = nextFacts(state.facts, reply);
    state.said.push({ role: 'user', text: turn.user }, { role: 'model', text: sent.text });

    const outcome: TurnOutcome = {
        ...base, ...common, route: 'model', prefilter: 'pass', model: reply, rawText, repaired: coerced.repaired, guardFallback, sent, paused, checks: [],
    };
    outcome.checks = checkTurn({
        expect: turn.expect, route: 'model', prefilter: 'pass', model: reply, rawText, modelFailure: undefined,
        decision: { next_action: reply.next_action, handoff_reason: reply.handoff_reason, intent: reply.intent, stage: reply.stage, offer_id: reply.offer_id },
        sentKind: sent.kind, textIntended, paused, optedOutBefore, optsOutNow: reply.intent === 'opt_out', claims: prompt.claims,
    });
    // The refusal is almost always the invented number or claim the checks above already name; it is its own failure only when they do not.
    if (guardFallback && !outcome.checks.some((c) => !c.pass && (c.name === 'no_invented_numbers' || c.name === 'no_invented_claims'))) {
        outcome.checks.push({ name: 'guard', pass: false, detail: 'the guard refused the reply and the kit\'s "I will check" line went out instead' });
    }

    // The soft checks: only for words the customer actually received, and only when the case asks for any.
    const asked = turn.expect.soft ?? [];
    if (settings.judge && sent.kind === 'model' && asked.length > 0) {
        const offerName = reply.offer_id === NO_OFFER ? null : (fx.ctx.offers.find((o) => o.id === reply.offer_id)?.name ?? reply.offer_id);
        outcome.judge = await judgeReply(settings.judge, {
            botSystem: prompt.system, conversation: request, reply: sent.text,
            systemAction: systemAction(reply, offerName), asked, case: c.id, turn: index,
        }, { maxTokens: JUDGE_MAX_TOKENS, timeoutMs: JUDGE_TIMEOUT_MS });
    }
    return { outcome, failed: false };
}

/** Every check passed, and (when the judge was asked) every asked reply was scored with nothing under the floor. */
export function turnPasses(t: Pick<TurnOutcome, 'checks' | 'judge'>, judged: boolean, asked: boolean): boolean {
    if (t.checks.some((c) => !c.pass)) return false;
    if (judged && asked) {
        if (!t.judge || isJudgeFailure(t.judge)) return false;
        const low = lowestScore(t.judge);
        if (low === null || low < JUDGE_FLOOR) return false;
    }
    return true;
}

/** One conversation, turn by turn, through the pipeline. */
export async function runCase(c: EvalCase, settings: RunSettings): Promise<CaseOutcome> {
    const fx = resolveFixture(c.fixture);
    const state: ConversationState = {
        facts: { stage: c.facts?.stage ?? 'new', qualifierTurns: c.facts?.qualifierTurns ?? 0, linkSentFor: [...(c.facts?.linkSentFor ?? [])], ...(c.facts?.comment ? { comment: c.facts.comment } : {}) },
        said: [],
        paused: false,
        optedOut: false,
        abuseStrikes: 0,
    };
    const turns: TurnOutcome[] = [];
    let skipped = 0;
    let failed = false;
    for (const [i, turn] of c.turns.entries()) {
        if (failed) {
            skipped += 1;
            continue;
        }
        const result = await runTurn(c, fx, i + 1, turn, state, settings);
        turns.push(result.outcome);
        failed = result.failed;
    }
    const pass = skipped === 0 && turns.every((t, i) => turnPasses(t, settings.judge !== null, (c.turns[i]?.expect.soft ?? []).length > 0 && t.sent.kind === 'model'));
    return { id: c.id, title: c.title, fixture: c.fixture, writes: c.writes, turns, skipped, pass };
}

export interface RunInput {
    cases: readonly EvalCase[];
    /** The model under test, as it is named on the command line. */
    model: string;
    provider: string;
    effort: string;
    judgeModel: string | null;
    settings: RunSettings;
    /** Called as each conversation finishes, for a progress line. */
    onCase?: (outcome: CaseOutcome) => void;
}

/** Every case, in order, one after the other (they share a prompt, so the cache the live path uses is read from the second on). */
export async function runEval(input: RunInput): Promise<EvalRun> {
    const cases: CaseOutcome[] = [];
    for (const c of input.cases) {
        const outcome = await runCase(c, input.settings);
        cases.push(outcome);
        input.onCase?.(outcome);
    }
    return {
        model: input.model, provider: input.provider, effort: input.effort, judgeModel: input.settings.judge ? input.judgeModel : null,
        cases, promptDigest: promptDigest([...new Set(input.cases.map((c) => c.fixture))]), casesDigest: casesDigest(input.cases),
    };
}


/** A short digest of the cases themselves (their messages and expectations), so two reports can be told to be about the same conversations. */
export const casesDigest = (cases: readonly EvalCase[]): string => createHash('sha256').update(JSON.stringify(cases)).digest('hex').slice(0, 12);
