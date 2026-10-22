/**
 * AI proposals (A7, spec Story 3, FR-045…FR-049): the shapes every file of this folder shares, and the PORTS through which it reaches
 * the parts of the Ads Manager built in other phases.
 *
 *   input.ts    the model's input: aggregates only (FR-049). Never lead answers, contact data or message text.
 *   prompt.ts   the one system prompt and user message, the same on the Mac and on the providers layer.
 *   schema.ts   the output schemas (contracts/ai-proposal.schema.md) and their validators.
 *   checks.ts   the server checks after the model answers: schema → evidence → policy → money.
 *   store.ts    `ads_proposals` (v55) and its state machine.
 *   service.ts  request, the two routes to a model (the owner's Mac via a Studio `ads_think` job; everyone else on their own key via the
 *               providers layer), advance, approve, reject, expiry, the daily review.
 *   ports.ts    the default ports and `setProposalPorts`, so the policy check (A4), the money rule (A1), the stored copy (A2), the queue (A2)
 *               and the builder's spec → ops mapping (A4/A5) are wired in one place and stubbed in tests.
 *
 * Nothing here calls Meta while drafting (contract step 5: Meta's `validate_only` runs on approval only).
 */

// ─── Campaign spec: A4's `spec.ts` is the one shape and the one mapping to Meta ──────────────────────────────────────────

import type { CampaignSpec } from '../spec.js';
export type { CampaignSpec };
export type BudgetKind = 'daily' | 'lifetime';

// ─── The model's input (contracts/ai-proposal.schema.md "Input") ──────────────────────────────────────────────────────────

export type ProposalTask = 'draft_campaign' | 'review';

export interface Last7d {
    spend: number | null;
    results: number | null;
    costPerResult: number | null;
    conversations: number | null;
    costPerConversation: number | null;
    ctr: number | null;
    frequency: number | null;
    trackedClicks: number | null;
    handoffs: number | null;
}

export interface InputObject {
    /** `ads_objects.id`: what a review item's `targets` name. */
    id: string;
    level: 'campaign' | 'adset' | 'ad';
    name: string;
    goal: string | null;
    status: string;
    budget: { kind: 'daily' | 'lifetime' | 'none'; amount: number | null } | null;
    targetingSummary: unknown;
    last7d: Last7d;
}

export interface ProposalInput {
    tenant: { lang: 'ar' | 'en'; currency: string; timezone: string; countries: string[] };
    limits: { maxDailyBudget: number | null; monthlyCap: number | null; remainingThisMonth: number | null; metaMinimumDaily: Record<string, number> };
    offers: { id: string; title: string; price: string | null; url_is_tracked: boolean; summary: string }[];
    request: string | null;
    post: { id: string; platform: string; caption: string; kind: string; organic: { views: number | null; reach: number | null; saves: number | null; skipRate: number | null } } | null;
    /**
     * The tenant's own recently published posts (at most 5), the creatives a draft from words alone may use: an ad needs a real post
     * or uploaded media, and a model cannot invent either. An extension of the contract's input; captions are the tenant's own words.
     */
    recentPosts?: { id: string; platform: string; caption: string; kind: string }[];
    policy: { rules: { id: string; severity: 'block' | 'warn'; description: string }[] };
    account: { objects: InputObject[]; audiences: { id: string; kind: string; name: string; size: number | null }[] };
    /** How many days of results the stored copy holds (the daily review needs ≥ 3). Not sent to the model. */
    daysOfData?: number;
    task: ProposalTask;
}

// ─── The model's output (contracts/ai-proposal.schema.md "Output") ───────────────────────────────────────────────────────

export interface DraftOutput {
    spec: CampaignSpec;
    rationale: string;
    assumptions: string[];
    expected: { metric: 'conversations' | 'link_clicks' | 'reach' | 'leads'; range: [number, number] | null };
}

/** `resume` is never drafted by the model (not in REVIEW_KINDS): only a rule proposes it (A9, `rule_raise`), because resuming raises spend. */
export type ReviewKind = 'pause' | 'lower_budget' | 'raise_budget' | 'shift_budget' | 'new_ad_from_post' | 'audience' | 'resume';

export type ReviewChange = { percent: number } | { from: string; to: string; amount: number } | { spec: CampaignSpec };

export interface ReviewItem {
    kind: ReviewKind;
    targets: string[];
    change: ReviewChange;
    /** `7d` for the model's review (the schema refuses any other); a split test's own length (`<days>d`) for a test_winner (studies.ts). */
    evidence: { window: string; numbers: Record<string, number> };
    rationale: string;
}

export interface ReviewOutput {
    items: ReviewItem[];
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// ─── Checks ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PolicyFinding {
    ruleId: string;
    severity: 'block' | 'warn';
    /** The text field it was found in, as a path: `ads[0].copy.primaryText`. */
    field: string;
    message: string;
}

/** What the money rule says about a candidate (A1's `/api/ads/money`, contracts/dashboard-api.md). */
export interface MoneyAnswer {
    fits: boolean;
    currency: string | null;
    /** The monthly cap minus this month's worst case WITHOUT the candidate. Null when it cannot be read. */
    remaining: number | null;
    maxDailyBudget: number | null;
    monthlyCap: number | null;
    reason: 'OVER_MONTHLY_CAP' | 'OVER_DAILY_MAX' | 'NOT_CONFIGURED' | 'UNREADABLE' | null;
}

export interface MoneyCandidate {
    kind: BudgetKind;
    /** Daily: per day. Lifetime: the whole amount. */
    amount: number;
    days: number;
}

export interface ProposalChecks {
    policy: PolicyFinding[];
    money: { ok: boolean; reason: string | null; note: string | null };
    meta_validate: { ok: boolean; error: string | null } | null;
    /** Review items the evidence check dropped, and why. */
    dropped?: { index: number; reason: string }[];
    /** Set when a regeneration was asked for, and why. */
    regenerated?: 'schema' | 'policy' | 'spec' | null;
    /** What the regeneration told the model (the failed checks), kept so the second try is asked with it. */
    feedback?: string[];
    /** The ops approving enqueued, so `applying` can be settled into `applied` or `failed`. */
    ops?: string[];
    /** A check that could not run because its phase is not wired yet (`ports.ts`). Approve refuses while one is listed. */
    unavailable?: ('policy' | 'money' | 'mirror' | 'apply')[];
}

export interface ProposalEffect {
    worstCaseDelta: number | null;
    newWorstCase: number | null;
    currency: string | null;
}

// ─── Storage (v55 `ads_proposals`, data-model.md) ────────────────────────────────────────────────────────────────────────

export type ProposalKind = 'new_campaign' | 'change' | 'rule_raise' | 'test_winner';
export type ProposalSource = 'request' | 'post' | 'daily_review' | 'rule' | 'study';
export type ProposalState = 'drafting' | 'open' | 'approved' | 'applying' | 'applied' | 'failed' | 'rejected' | 'expired';

/** Which moves are allowed. Anything else is refused (409 INVALID) and changes nothing. */
export const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalState, readonly ProposalState[]>> = Object.freeze({
    drafting: ['open', 'failed'],
    open: ['approved', 'rejected', 'expired'],
    approved: ['applying', 'failed'],
    applying: ['applied', 'failed'],
    applied: [],
    failed: [],
    rejected: [],
    expired: [],
});

export const PROPOSAL_TTL_DAYS = 7;
export const MAX_DAILY_REVIEW_PROPOSALS = 3;
export const MIN_DAYS_FOR_REVIEW = 3;
/** A Mac draft not answered in this long is failed by the daily cron ("the Mac did not answer"). */
export const DRAFTING_STALE_HOURS = 24;
/** The owner's words, at most. */
export const MAX_REQUEST_CHARS = 1000;

/** `model` column: who answered. `via: 'mac'` is Claude Code on the owner's Mac (no cost to anyone's API key). */
export interface ProposalModel {
    via: 'mac' | 'api';
    provider: string | null;
    model: string | null;
    effort: string | null;
    usd: number | null;
}

/** What the payload holds: a new campaign's spec, or the changes of one review item. */
export type ProposalPayload =
    | { task: 'draft_campaign'; spec: CampaignSpec; assumptions: string[]; expected: DraftOutput['expected'] }
    | { task: 'review'; item: ReviewItem };

export interface ProposalRow {
    id: string;
    creator_id: string;
    kind: ProposalKind;
    source: ProposalSource;
    request_text: string | null;
    /** The post a "Suggest a campaign" on a Posts card was for. */
    post_ref: { postId: string; platform: string } | null;
    payload: ProposalPayload | null;
    rationale: string | null;
    evidence: Record<string, unknown> | null;
    effect: ProposalEffect | null;
    checks: ProposalChecks | null;
    state: ProposalState;
    /** The reason for `failed`, or the owner's reason for `rejected`. */
    error: string | null;
    model: ProposalModel | null;
    /** 1, or 2 after a regeneration. */
    attempt: number;
    decided_by: string | null;
    decided_at: string | null;
    expires_at: string;
    created_at: string;
    updated_at: string;
}

/** The dashboard's view (contracts/dashboard-api.md "Proposals"). */
export interface ProposalView {
    id: string;
    kind: ProposalKind;
    source: ProposalSource;
    state: ProposalState;
    request: string | null;
    post: { postId: string; platform: string } | null;
    /** A new campaign's spec, or null for a change. */
    spec: CampaignSpec | null;
    /** A review item's change, or null for a new campaign. */
    change: { kind: ReviewKind; targets: string[]; change: ReviewChange } | null;
    rationale: string | null;
    assumptions: string[];
    expected: DraftOutput['expected'] | null;
    evidence: Record<string, unknown> | null;
    effect: ProposalEffect | null;
    checks: ProposalChecks | null;
    error: string | null;
    /** `mac`: Claude on the owner's Mac (can take minutes). `api`: the tenant's own provider key. */
    via: 'mac' | 'api' | null;
    expiresAt: string;
    createdAt: string;
    decidedAt: string | null;
}

// ─── Ports: the parts built in other phases ─────────────────────────────────────────────────────────────────────────────

/** A4's deterministic policy check (`src/services/ads/policy.ts`) and its rule descriptions. */
export interface PolicyPort {
    rules(lang: 'ar' | 'en'): { id: string; severity: 'block' | 'warn'; description: string }[];
    check(fields: { field: string; text: string }[], lang: 'ar' | 'en'): PolicyFinding[];
}

/** A1's one money rule (`src/services/ads/money.ts`, the same answer `/api/ads/money` gives). May read Meta: never call it in a transaction. */
export interface MoneyPort {
    check(creatorId: string, candidate: MoneyCandidate | null): Promise<MoneyAnswer>;
    /** Meta's minimum daily budget per goal in the account's currency (`/api/ads/minimum-budgets`), from the stored copy. */
    minimumDaily(creatorId: string): Promise<Record<string, number>>;
}

/** A2's stored copy (`ads_objects`, `ads_insights_daily`): Postgres only. */
export interface MirrorPort {
    snapshot(creatorId: string): Promise<{ currency: string | null; timezone: string | null; objects: InputObject[]; audiences: ProposalInput['account']['audiences']; daysOfData: number }>;
}

/** What approving enqueues. Every op carries `proposalId`; a new campaign is created PAUSED (A2's queue, A4/A5's spec → ops). */
export interface ApplyPort {
    /** A new campaign from a spec: its create ops, everything PAUSED. */
    createFromSpec(creatorId: string, spec: CampaignSpec, ctx: { proposalId: string; userId: string | null }): Promise<{ ops: { id: string; state: string; kind: string }[] }>;
    /** Exactly the ops one review item lists. */
    applyChange(creatorId: string, item: ReviewItem, ctx: { proposalId: string; userId: string | null }): Promise<{ ops: { id: string; state: string; kind: string }[] }>;
    /** Meta's `validate_only` for a spec, run on approval only. */
    validateSpec(creatorId: string, spec: CampaignSpec): Promise<{ ok: boolean; error: string | null }>;
}

/** A1's feature switch (`ads.enabled.<t>`): the tenants the daily review runs for. */
export interface TenantsPort {
    enabled(): Promise<string[]>;
}

/** A1's alerts (`ads_alerts`, once per kind, object and day; Telegram and email per the tenant's settings). */
export interface AlertsPort {
    send(creatorId: string, kind: 'proposal_ready', objectKey: string, detail: Record<string, unknown>): Promise<void>;
}

export interface ProposalPorts {
    policy: PolicyPort | null;
    money: MoneyPort | null;
    mirror: MirrorPort | null;
    apply: ApplyPort | null;
    tenants: TenantsPort | null;
    alerts: AlertsPort | null;
}

/** The error every proposals route answers with: `{ error, code, field? }`. */
export type ProposalErrorCode =
    | 'ADS_DISABLED' | 'ADS_NOT_CONFIGURED' | 'AI_NOT_CONFIGURED' | 'NOT_FOUND' | 'INVALID' | 'POLICY_BLOCKED'
    | 'OVER_DAILY_MAX' | 'OVER_MONTHLY_CAP' | 'BELOW_META_MINIMUM' | 'NOT_WIRED' | 'META_ERROR';

export class ProposalError extends Error {
    constructor(readonly status: number, readonly code: ProposalErrorCode, message: string, readonly field?: string, readonly findings?: PolicyFinding[]) {
        super(message);
        this.name = 'ProposalError';
    }
}
