/**
 * The vocabulary of the DM sales evaluation (docs/DM_SALES_PLAN.md §11, E1): what a golden conversation is, what it expects of each
 * reply, and what running one gives back. Types and a few closed lists, nothing else, so the cases (data), the checks, the runner, the
 * judge and the report all read one definition and a value added here is in each of them from the same commit.
 *
 * The harness is not part of the app: nothing under `src/` outside this folder imports it, and it reads no tenant, no conversation and
 * no database row. It is run by hand (`scripts/eval-dm-sales.mts`) before a prompt or kit change, and in CI with a stub caller.
 */
import type { LlmSchema } from '../../llm/schema.js';
import type { LlmTurn } from '../../llm/types.js';
import type { PrefilterSignal } from '../prefilter.js';
import type { ViolationKind } from '../guard.js';
import type { HandoffReason, Intent, NextAction, SalesFacts, SalesReply, Stage } from '../types.js';

// ─── The cases ───────────────────────────────────────────────────────────────────────────────

/**
 * Whose data the prompt is built from. Always a name in this list, never a tenant id (`fixtures.ts`, and the refusal in `refusal.ts`):
 *
 *   owner-ar          the owner's profile as production holds it, with his sales block typed in and NO price the bot may say
 *   owner-ar-priced   the same with a price whose valid-until date has not passed, so 49 USD is the one number it may quote
 *   coach-en          the English control tenant (a fitness coach), with a live price
 */
export const FIXTURE_NAMES = ['owner-ar', 'owner-ar-priced', 'coach-en'] as const;
export type FixtureName = (typeof FIXTURE_NAMES)[number];

/** How a person writes, and how a reply must be written back. Arabic by variety (the dialects the owner's audience uses) or English. */
export const VARIETIES = ['gulf', 'egyptian', 'msa', 'english'] as const;
export type Variety = (typeof VARIETIES)[number];

/**
 * What the judge scores, 1 to 5 each (`judge.ts`). Everything else is checked in code (`checks.ts`):
 *   tone                  warm, natural, in the person's own register, not robotic
 *   helpfulness           answers what was asked, concisely, and moves the person forward
 *   no_pressure           no urgency, no superlatives, no guilt, no arguing twice
 *   right_recommendation  recommends the offer (and the part of it) that fits what they said, or nothing when nothing fits
 */
export const SOFT_CRITERIA = ['tone', 'helpfulness', 'no_pressure', 'right_recommendation'] as const;
export type SoftCriterion = (typeof SOFT_CRITERIA)[number];

/** What the customer is sent. `model` is the model's own words; the others are the kit's fixed lines (`kitFor(...).sales.lines`). */
export const SENT_KINDS = ['model', 'handoff', 'unsure', 'opt_out', 'calm', 'none'] as const;
export type SentKind = (typeof SENT_KINDS)[number];

/** Which part of the pipeline decides a turn: the keyword pre-filter, the model, or nobody (the bot is paused and sends nothing). */
export const ROUTES = ['model', 'prefilter', 'silent'] as const;
export type Route = (typeof ROUTES)[number];

/** What one reply must satisfy. Every field is optional: a field that is absent is not checked. Lists are the acceptable values. */
export interface TurnExpectation {
    /** Who decides the turn. Default `model`. */
    route?: Route;
    /** `route: 'prefilter'`: what the message must be caught as. */
    prefilter?: PrefilterSignal;
    /** What the customer is sent, one of. */
    sent?: SentKind[];
    next_action?: NextAction[];
    intent?: Intent[];
    stage?: Stage[];
    handoff_reason?: HandoffReason[];
    /** Offer ids, and `none`. */
    offer_id?: string[];
    /** The language of the reply, and with `lean` that it also uses words of that dialect (not merely avoids another's). Model text only. */
    reply_language?: { variety: Variety; lean?: boolean };
    /** Regular expressions (case-insensitive, Unicode) the model's text must match, every one of them. */
    must?: string[];
    /** Regular expressions the model's text must not match, any one. For what the guard cannot see: a lie that uses words the data also holds. */
    must_not?: string[];
    /**
     * Discount, coupon and "free" are words only the data may say (`guard.ts`). A refusal names them honestly («ما أقدر أعطيك خصم»), so a
     * case about asking for one lists the kinds its reply may name. A NUMBER is never allowed: it is not a kind here.
     */
    allow_claim_words?: ViolationKind[];
    /** What the judge scores for this reply. Empty or absent: not judged (a kit line, or a reply nobody needs to read for tone). */
    soft?: SoftCriterion[];
    /** Why the case expects this, for the person reading a failure. */
    note?: string;
}

export interface EvalTurn {
    /** What the person writes. */
    user: string;
    expect: TurnExpectation;
}

export interface EvalCase {
    id: string;
    title: string;
    fixture: FixtureName;
    /** How the person writes, for the report and the language check. */
    writes: Variety;
    /** Where the conversation starts, as the prompt's last block says it. Default: new, no qualifier asked, no link sent. */
    facts?: Partial<Pick<SalesFacts, 'stage' | 'qualifierTurns' | 'linkSentFor' | 'comment'>>;
    /** What was said before the first turn, scripted and never checked. Starts with a user turn. */
    history?: LlmTurn[];
    turns: EvalTurn[];
}

// ─── Calling a model ─────────────────────────────────────────────────────────────────────────

/** What is being asked of the model, and who is asking: the sales turn or the judge. */
export interface CallMeta {
    role: 'sales' | 'judge';
    case: string;
    turn: number;
}

export interface ModelRequest {
    system: string;
    user: LlmTurn[];
    schema: LlmSchema;
    maxTokens: number;
    timeoutMs: number;
    cacheSystem: boolean;
    meta: CallMeta;
}

export interface UsageNumbers {
    in: number;
    out: number;
    cacheRead?: number;
    cacheWrite?: number;
}

export interface ModelResponse {
    json: unknown;
    /** The model that answered. */
    model: string;
    usage: UsageNumbers;
    /** US dollars, as the providers layer priced the call. */
    usd: number;
    /** False: a model with no price, charged at the table's ceiling. */
    priced: boolean;
    /** Wall-clock milliseconds the call took. */
    latencyMs: number;
}

/**
 * One call to a model. Throws when the call fails (an `AiError` from the providers layer in a real run); the runner records it as the
 * turn's failure. The real one is `scripts/eval-dm-sales.mts`'s, through `generate`; a test or the CI dry run passes a stub (`stub.ts`).
 */
export type EvalCaller = (request: ModelRequest) => Promise<ModelResponse>;

// ─── Results ─────────────────────────────────────────────────────────────────────────────────

export interface CheckResult {
    /** Stable name, as the report prints it. */
    name: string;
    pass: boolean;
    /** What was found, on a failure; empty on a pass. */
    detail: string;
}

export interface JudgeScore {
    scores: Partial<Record<SoftCriterion, number>>;
    /** The judge's own words on the weakest point. */
    notes: string;
    usd: number;
    usage: UsageNumbers;
}

/** A judge call that failed or answered something that is not a score: the turn is not judged, and the report says so. */
export interface JudgeFailure {
    error: string;
}

export interface TurnOutcome {
    index: number;
    user: string;
    route: Route;
    /** What the pre-filter said about the message (`pass`, or the signal). Absent on a silent turn: nothing read it. */
    prefilter?: PrefilterSignal | 'pass';
    /** The model's answer after `coerceSalesReply` (what it decided, repaired to be true to its shape). Absent when no model was asked. */
    model?: SalesReply;
    /** The model's own text, before the guard took anything out of it. */
    rawText?: string;
    /** Fields `coerceSalesReply` had to repair, by name. */
    repaired: string[];
    /** The guard ruled the model's text unsendable and the kit's line went out instead. */
    guardFallback: boolean;
    /** What the customer received: the model's text after the guard, a kit line, or nothing. */
    sent: { kind: SentKind; text: string };
    /** After this turn: nothing more is sent (an opt-out, a handoff, a second insult). */
    paused: boolean;
    error?: { kind: string; message: string };
    usage?: UsageNumbers;
    usd?: number;
    priced?: boolean;
    latencyMs?: number;
    /** The model that answered, as the provider said. */
    modelId?: string;
    checks: CheckResult[];
    judge?: JudgeScore | JudgeFailure;
}

export interface CaseOutcome {
    id: string;
    title: string;
    fixture: FixtureName;
    writes: Variety;
    turns: TurnOutcome[];
    /** Turns that never ran because an earlier one failed to get an answer. */
    skipped: number;
    /** Every hard check passed on every turn, and no judged score was below the floor. */
    pass: boolean;
}

export interface EvalRun {
    /** The model under test, as asked for. */
    model: string;
    provider: string;
    effort: string;
    judgeModel: string | null;
    cases: CaseOutcome[];
    /** Digest of the prompts the run was built on, so two reports can be told to be about the same prompt. */
    promptDigest: string;
    /** Digest of the conversations and their expectations. */
    casesDigest: string;
}
