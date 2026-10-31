/**
 * The vocabulary of the Muse benchmark (docs/specs/005-muse-sees FR-019, `scripts/eval-muse.mts`): what a case is, what an arm does with it, and what comes back.
 *
 * Types and closed lists, nothing else, so the cases (data), the arms, the metrics, the report and the chart all read one definition. The checks themselves are NOT
 * defined here: expected action, invented numbers and claims, links, byte cap, language and the judge are the DM sales evaluation's (`dmSales/__evals__`), reused as they are.
 *
 * The benchmark is not part of the app: nothing outside this folder imports it. It is run by hand against the live Meta API, and never from `npm test` or CI.
 */
import type { SoftCriterion, TurnExpectation } from '../../dmSales/__evals__/types.js';
import type { FixtureName, Variety } from '../../dmSales/__evals__/types.js';

// ─── What an arm did ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the customer was given, as one of a few kinds. The first five are what a case may EXPECT; the rest are only ever what an arm did:
 *
 *   answer        the sales turn answered, or asked one question, from the account's own information
 *   recommend     the sales turn recommended the offer that fits, or sent its link
 *   resend        the fixed line that asks them to send it again, because the media could not be read with confidence
 *   handoff       the chat went to a person (the sales turn, or a personal document, which no model is asked about)
 *   thank_named   a story mention thanked by the name of what was shared
 *   thank         a story mention thanked, without saying what was shared (today's line)
 *   generic_line  today's fixed "I can't open that here" line
 *   silent        nothing was sent (today's once-a-day rule, or a sticker)
 *   error         a model call failed and no answer was made
 */
export const ACTION_CLASSES = ['answer', 'recommend', 'resend', 'handoff', 'thank_named', 'thank', 'generic_line', 'silent', 'error'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

/** The actions a case may ask for. */
export const EXPECTABLE_ACTIONS = ['answer', 'recommend', 'resend', 'handoff', 'thank_named'] as const satisfies readonly ActionClass[];
export type ExpectableAction = (typeof EXPECTABLE_ACTIONS)[number];

/** What each arm is called in the code and in the report, and the suite of cases it runs. */
export const ARM_IDS = ['meta', 'today', 'voice', 'today_voice', 'memory_visual', 'memory_transcript'] as const;
export type ArmId = (typeof ARM_IDS)[number];

export type Suite = 'media' | 'voice' | 'memory';

// ─── The cases ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const CASE_KINDS = ['image', 'video', 'story_mention', 'reel', 'voice'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/**
 * Where a case's media is from. `file` is read from `--media-dir` (so no media is in the repo); `synthetic` is drawn at run time (`synthetic.ts`); `caption` is a
 * reel by another creator, of which an Instagram DM carries only the caption: there is nothing to watch.
 */
export type CaseSource =
    | { kind: 'file'; file: string; caption: string | null }
    | { kind: 'synthetic'; card: 'id_card' | 'story_card' }
    | { kind: 'caption'; caption: string };

/**
 * What it takes for a description to count as understood. `shows`: every group has at least one of its words (any case, any script) in what Muse reported it saw or
 * heard; `unreadable`: it said, instead of guessing, that it could not read it; `personal`: it recognised a personal document.
 */
export type Understood = { mode: 'shows'; groups: string[][] } | { mode: 'unreadable' } | { mode: 'personal' };

export interface CaseExpectation {
    /** Any one of these is right. */
    action: ExpectableAction[];
    /** The sales evaluation's own expectation, for what a model's words must satisfy (`checks.ts`): offers, language, patterns, judged criteria. */
    turn: TurnExpectation;
    /** Regular expressions the reply must never match: the facts that must NOT be invented (a price seen in a picture or typed, another creator's link). */
    forbid: string[];
}

export interface MuseCase {
    id: string;
    title: string;
    kind: CaseKind;
    /** A reel only: the account's own (watched, or read from the library) or another creator's (the caption only). */
    owner: 'own' | 'other' | null;
    source: CaseSource;
    /** What the customer typed with it, or null for nothing. */
    typed: string | null;
    fixture: FixtureName;
    /** How the person writes, for the report. */
    writes: Variety;
    /** Today's once-a-day rule: the fixed line was already sent today, and they have written nothing since. */
    priorAck: boolean;
    /** What the voice note says, as it was meant (a voice case only): the word error rate is read against it. */
    reference: string | null;
    understood: Understood;
    expect: CaseExpectation;
    note: string | null;
}

export type ParsedCases = { cases: MuseCase[]; memory: MemoryQuestion[]; openWeights: OpenWeightsSpec | null };

// ─── The memory questions and the reel analysis ─────────────────────────────────────────────────────────────────────────

/** One question a follower might ask of the library. `expect.reel` picks the right reel by what its analysis says; `none` is a topic with no reel. */
export interface MemoryQuestion {
    id: string;
    ask: string;
    /** The answer is only SHOWN on screen: it is in no narration, so a library of transcripts cannot find it. */
    visualOnly: boolean;
    expect: { reel: string[][] } | { none: true };
}

/** What the open-weights comparison reads the analysis of one reel against. */
export interface OpenWeightsSpec {
    file: string;
    durationS: number;
    /** Each group is one fact the analysis must contain: any one of its words, in any script. */
    facts: { name: string; any: string[] }[];
}

// ─── What came back ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Failure {
    caseId: string;
    arm: ArmId;
    /** The check that failed, or what went wrong, as a short name. */
    what: string;
    /** One line, for a person reading the report. */
    reason: string;
}

/** Invented facts found in one reply: the harness's check names with what they found. */
export interface InventedFacts {
    /** In what the model wrote, before the guard. */
    draft: string[];
    /** In what the customer is sent: after the guard took out a link or refused the reply. */
    sent: string[];
}

export interface ArmCaseResult {
    arm: ArmId;
    caseId: string;
    status: 'ran' | 'skipped';
    /** Why it did not run. */
    note: string | null;
    /** Did it understand what was sent? Null when the arm has no notion of it (it did not run). */
    understood: boolean | null;
    understoodWhy: string | null;
    action: ActionClass;
    actionOk: boolean;
    actionWhy: string | null;
    /** What was seen or heard, as stored: the English description, or the transcript. */
    seen: string | null;
    /** What the customer is sent. Empty: nothing. */
    reply: string;
    /** The product's own one line of why, for the Meta arm. */
    trace: string | null;
    invented: InventedFacts;
    /** Every hard check that failed, with its one line. The invented-fact ones are among them. */
    failures: Failure[];
    /** Milliseconds from the message to the reply: reading it and writing the answer. Excludes the download and the Send API. */
    ms: number;
    usd: number;
    tokensIn: number;
    tokensOut: number;
    /** Model calls made for this case, retries and a second try included. */
    calls: number;
    judge: { mean: number; lowest: number; notes: string } | null;
}

export interface Rate {
    n: number;
    of: number;
    /** 0 to 100, or null for no cases. */
    pct: number | null;
}

export interface ArmSummary {
    arm: ArmId;
    suite: Suite;
    label: string;
    /** The models behind it, as a short phrase for the table. */
    models: string;
    cases: number;
    understood: Rate;
    expectedAction: Rate;
    /** Replies in which an invented fact REACHED the customer. */
    inventedSent: number;
    /** Replies whose first draft had one, which the guard then stopped. */
    inventedDraft: number;
    p50Ms: number | null;
    p90Ms: number | null;
    /** Replies the customer was sent (something, not nothing). */
    replies: number;
    usd: number;
    usdPerReply: number | null;
    /** The judge's mean over every score it gave, or null when it did not run. */
    judgeMean: number | null;
    failures: Failure[];
}

/** What the report says of an arm that did not run. */
export interface SkippedArm {
    arm: ArmId | 'memory' | 'open_weights';
    label: string;
    why: string;
}

export type { SoftCriterion };
