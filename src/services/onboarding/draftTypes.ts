/**
 * The shapes the draft engine stores in a draft row's JSON columns, and the one the API answers with. Types only: nothing here runs,
 * so the pure modules (`draftView.ts`) and the ones that talk to the world (`draftSources.ts`, `drafts.ts`) can share them
 * without one importing the other.
 *
 *   sources         FetchedBundle      what the fetch found; the draft step reads it back, so a retry never fetches again
 *   sources_status  SourcesStatus      one line per source: ok, failed (and why) or skipped
 *   draft           DraftColumn        while drafting, the calls' answers so far; when done, the checked draft or the prefill
 *   usage           UsageLog           every step and call, with its elapsed_ms, for the Operations screen and the budget audit
 */
import type { InfographicSocial } from '../profile/types.js';
import type { LogoCandidate, PrimarySource } from './brand.js';
import type { DraftSignals, SampleCandidate } from './draftSignals.js';
import type { DraftCall } from './draftSchema.js';
import type { DraftInputs } from './draftInputs.js';
import type { CallFailure, DraftErrorKind, DraftStatus } from './draftStep.js';
import type { DraftSource } from './fence.js';
import type { Draft } from './validateDraft.js';
import type { WebsiteStatus } from './website.js';

// ─── The row ────────────────────────────────────────────────────────────────────────────────

export type DraftOrigin = 'admin_create' | 'wizard' | 'redraft';

/** A draft row as the engine reads it. `sources`, `draft` and `usage` are JSON the engine itself wrote. */
export interface DraftRow {
    id: string;
    creator_id: string;
    origin: DraftOrigin | null;
    requested_by: string | null;
    inputs: DraftInputs;
    inputs_hash: string;
    prompt_version: string;
    status: DraftStatus;
    attempts: number;
    next_attempt_at: Date | null;
    lease_until: Date | null;
    lease_owner: string | null;
    sources: unknown;
    sources_status: unknown;
    draft: unknown;
    partial: boolean | null;
    usage: unknown;
    error: string | null;
    error_kind: string | null;
    created_at: Date;
    updated_at: Date;
    finished_at: Date | null;
}

// ─── sources, sources_status ────────────────────────────────────────────────────────────────

export type SourceState = 'ok' | 'failed' | 'skipped';

/** One source's outcome. Counts, never content. */
export interface SourceReport {
    state: SourceState;
    /** The road it was read by: `business_discovery`, `own_token`, `safe_fetch`, `api_key`, `connected`, `typed`. */
    via: string | null;
    /** Why it gave nothing: a `SourceErrorKind`, a website status (`blocked`, `robots`, `unreachable`), `no_input`, `timeout`, `internal`. */
    kind: string | null;
    /** Whether the same read could work later. */
    retryable: boolean;
    /** For an operator and the log, scrubbed of credentials. */
    message: string | null;
    ms: number;
    counts: Record<string, number>;
    /** The site refused to be read: the wizard asks for the About text. */
    needsPaste?: boolean;
}

export interface SourcesStatus {
    instagram: SourceReport;
    website: SourceReport;
    youtube: SourceReport;
    typed: SourceReport;
}

/** What code found out, which the model is never asked to write. */
export interface DraftFacts {
    /** The username Instagram answered with. */
    handle: string | null;
    /** The handle typed is not the account that answered (own token only): the wizard asks "is this you?". */
    handleMismatch: boolean;
    igName: string | null;
    followers: number | null;
    mediaCount: number | null;
    siteHost: string | null;
    site: { status: WebsiteStatus; needsPaste: boolean; pages: Array<{ url: string; role: string }> } | null;
    brand: { primary: string | null; accent: string | null; ink: string; paper: string; source: PrimarySource | null } | null;
    /** Addresses only. A logo is saved as an upload only after the tenant confirms it. */
    logos: LogoCandidate[];
    socialLinks: Partial<Record<InfographicSocial, string>>;
    youtube: { id: string; title: string; handle: string | null; country: string | null; subscribers: number | null; via: string } | null;
    /** Addresses, emails and numbers the creator's own pages and profile hold, which `validateDraft` lets a model repeat. Not shown to a person. */
    knownUrls: string[];
    knownEmails: string[];
    knownPhones: string[];
    keywordsInUse: string[];
}

/** What a fetch stores in a draft's `sources` column. */
export interface FetchedBundle {
    version: 1;
    sources: DraftSource[];
    candidates: SampleCandidate[];
    signals: DraftSignals;
    facts: DraftFacts;
}

// ─── draft ──────────────────────────────────────────────────────────────────────────────────

/** One call's state across tries (see `CallState`): what it answered, what went wrong, and whether it is given up on. */
export interface CallRecord {
    answer?: unknown;
    errors: CallFailure[];
    gaveUp: boolean;
    provider?: string;
    model?: string;
}

/** The `draft` column of a draft that is still `drafting`: the calls so far. Never shown. */
export interface AnswersColumn {
    stage: 'answers';
    calls: Record<DraftCall, CallRecord>;
}

/** What code found, kept with the checked draft: `DraftFacts` without the lists only `validateDraft` reads. */
export type DraftCode = Omit<DraftFacts, 'knownUrls' | 'knownEmails' | 'knownPhones' | 'keywordsInUse'>;

/**
 * The `draft` column of a draft that is done. `final`: a model's answer, checked in code. `prefill`: no model answered, and this
 * is only what code found (colours, the logo, the social links, the handle), so the wizard can still fill what it can.
 */
export interface ResultColumn {
    stage: 'final' | 'prefill';
    result: Draft;
    code: DraftCode;
    models: Partial<Record<DraftCall, { provider: string; model: string }>>;
    promptVersion: string;
}

export type DraftColumn = AnswersColumn | ResultColumn;

// ─── usage ──────────────────────────────────────────────────────────────────────────────────

export interface StepLog {
    step: 'fetch' | 'draft';
    at: string;
    elapsed_ms: number;
    outcome: 'ok' | 'retry' | 'failed';
    attempt: number;
    detail?: string;
}

export interface CallLog {
    call: DraftCall;
    provider: string;
    model: string;
    effort: string;
    usage_in: number;
    usage_out: number;
    usd: number;
    priced: boolean;
    elapsed_ms: number;
    outcome: 'ok' | DraftErrorKind;
    /** The `ai_usage` row, so an audit can join the two. */
    usage_id?: string;
}

export interface UsageLog {
    steps: StepLog[];
    calls: CallLog[];
    totals: { usd: number; usage_in: number; usage_out: number };
    /** Invocations that worked on it. */
    advances: number;
}

export const emptyUsage = (): UsageLog => ({ steps: [], calls: [], totals: { usd: 0, usage_in: 0, usage_out: 0 }, advances: 0 });

// ─── What the API answers ───────────────────────────────────────────────────────────────────

export type ViewAudience = 'tenant' | 'admin';

export interface DraftView {
    id: string;
    status: DraftStatus;
    origin: string | null;
    attempts: number;
    createdAt: string;
    updatedAt: string;
    finishedAt: string | null;
    /** A caller may POST `advance` now and expect it to do something. The wizard fires it when this turns true. */
    advanceable: boolean;
    /** Somebody is working on it right now. */
    working: boolean;
    /** Its next try is not due before this: back-off after a failed try. */
    retryAt: string | null;
    partial: boolean;
    /** What ended it, or what the last failed try said. A tenant sees the kind and a fixed sentence; an operator sees the provider's message too. */
    error: { kind: string; message: string } | null;
    /** No AI provider has a key: the wizard continues by hand (and the operator adds a key). */
    needsAiKey: boolean;
    inputs: { instagram: string | null; website: string | null; youtube: string | null; hasAbout: boolean; via: string };
    sourcesStatus: SourcesStatus | null;
    /** Ids and kinds of what was read, never the text. */
    sources: Array<{ id: string; kind: string }>;
    /** The checked draft, when it is `ready`. */
    draft: (Draft & { code: DraftCode; models: ResultColumn['models'] }) | null;
    /** What code found, when no model could be asked (`failed` with sources). */
    prefill: (Draft & { code: DraftCode }) | null;
    /** Admin only: steps, calls and cost. */
    usage?: UsageLog | null;
}
