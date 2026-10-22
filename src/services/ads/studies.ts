/**
 * Split tests (Ads Manager phase A12, spec Story 10, FR-060): two to seven versions of an ad, or two to five ad sets, run against each other
 * by Meta for a set daily budget and dates; Meta names the winner; the app proposes keeping it.
 *
 * ─── At Meta ────────────────────────────────────────────────────────────────
 * `POST /{business_id}/ad_studies` (the business portfolio, not the ad account):
 * - creative: `type: SPLIT_TEST_V2`, each cell exactly ONE ad (`ads: [id]`), `creative_test_config: { daily_budget }` in minor units,
 *   `cooldown_start_time = start_time`, `observation_end_time = end_time`. The ads share their ad set, so both arms share the audience.
 * - audience: `type: SPLIT_TEST`, each cell one ad set (`adsets: [id]`); the arms' budgets are the ad sets' own, set equal here.
 * Every cell carries `treatment_percentage`; they add up to 100 (an equal split). Times are unix seconds.
 * Results: `GET /{study}/objectives` → `GET /{objective}?fields=results`. `high_performer_ids` is the authoritative outcome for creative
 * tests (`winner_ad_object_id` and `winner_confidence` are always null there); `confidence_by_ad_object_id` gives each arm's confidence.
 *
 * ─── Money ──────────────────────────────────────────────────────────────────
 * Every arm is made PAUSED by the builder and stays paused when the study is created, so creating spends nothing. Starting is the one
 * spending action: it needs `confirm: true`, re-runs the money rule on the worst case (the test's daily budget for every day, plus the
 * budget of any paused parent it switches on), and then activates the arms, then their parents, each through A2's own money-checked switch.
 *
 * ─── Ports ──────────────────────────────────────────────────────────────────
 * The queue, the stored copy, the money rule and proposals belong to phases A1, A2 and A7. This file reaches them only through
 * `StudyPorts`, so its rules are tested with stubs and the wiring is one small file. GET reads Postgres only (FR-015).
 */
import { roundMoney, toMinorUnits } from './money.js';
import type { OpPayload } from './ops.js';
import type { ReviewItem } from './proposals/types.js';

export type StudyType = 'creative' | 'audience';
export type StudyState = 'creating' | 'ready' | 'running' | 'ended' | 'stopped' | 'failed';

/** How many arms Meta takes per type (SPLIT_TEST_V2 allows 2–7; audience tests are kept small so each arm gets enough budget). */
export const STUDY_ARMS: Readonly<Record<StudyType, { min: number; max: number }>> = Object.freeze({
    creative: { min: 2, max: 7 },
    audience: { min: 2, max: 5 },
});
export const STUDY_MAX_DAYS = 30;
export const STUDY_NAME_MAX = 80;
/** A running test's results are read at most this often; the final read waits half a day after the end for Meta to settle. */
export const RESULTS_EVERY_MS = 6 * 3_600_000;
export const FINAL_AFTER_END_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;

export interface StudyCell {
    name: string;
    /** The ads_objects id. */
    objectId: string;
    metaId: string;
    objectName: string | null;
    level: 'ad' | 'adset';
    treatmentPercentage: number;
}

export interface StudyResult {
    winnerObjectIds: string[];
    highPerformerIds: string[];
    /** 0–100, one decimal; keyed by ads_objects id. */
    confidenceByObjectId: Record<string, number>;
    /** True once the test has ended and this is Meta's last word. */
    final: boolean;
    /** Final, and Meta could not separate the arms (no winner, or every arm a "high performer"). */
    noWinner: boolean;
    checkedAt: string;
}

export interface StudyRow {
    id: string;
    creatorId: string;
    adAccountId: string;
    businessId: string;
    metaId: string | null;
    type: StudyType;
    name: string;
    cells: StudyCell[];
    dailyBudget: number;
    currency: string;
    startTime: Date;
    endTime: Date;
    state: StudyState;
    result: StudyResult | null;
    opId: string | null;
    proposalId: string | null;
    error: string | null;
    createdBy: string | null;
    resultsCheckedAt: Date | null;
    createdAt: Date;
}

export type NewStudyRow = Omit<StudyRow, 'metaId' | 'state' | 'result' | 'opId' | 'proposalId' | 'error' | 'resultsCheckedAt' | 'createdAt'>;
export type StudyPatch = Partial<Pick<StudyRow, 'metaId' | 'state' | 'result' | 'opId' | 'proposalId' | 'error' | 'resultsCheckedAt'>>;

/** One stored-copy row, as much of it as a test needs. */
export interface StudyObject {
    id: string;
    level: 'campaign' | 'adset' | 'ad' | 'creative';
    metaId: string | null;
    name: string | null;
    status: string | null;
    parentId: string | null;
    budgetKind: 'daily' | 'lifetime' | 'none';
    budgetAmount: number | null;
    currency: string;
    adAccountId: string;
}

export type StudyOpState = 'pending' | 'running' | 'verify' | 'done' | 'failed' | 'cancelled';
export interface StudyOp {
    id: string;
    kind: string;
    state: StudyOpState;
    notBefore: string;
    result: unknown;
}

/** The `study` op (ads_ops, A2): the one Graph call this file builds itself. */
export interface StudyOpInput {
    creatorId: string;
    adAccountId: string;
    objectKey: string;
    kind: 'study';
    payload: OpPayload;
    idempotencyKey: string;
    dependsOn?: string | null;
    actor: { userId: string | null; via: 'owner' };
}

export interface StudyAccount {
    adAccountId: string;
    /** The ad account's offset from UTC now, in hours: a date the owner picks is midnight in the account's day. */
    timezoneOffsetHours: number;
    businessId: string | null;
    lang: 'ar' | 'en';
}

export interface MoneyAnswer {
    fits: boolean;
    reason: string | null;
    remaining: number | null;
    currency: string;
}

/**
 * The keep-the-winner proposal handed to A7 (`ads_proposals`, kind `test_winner`, source `study`), already `open`: a review item that pauses
 * the other arms, so approving it runs A7's own checks and `applyChange` (one PAUSED status op per arm).
 */
export interface WinnerProposal {
    kind: 'test_winner';
    source: 'study';
    state: 'open';
    payload: { task: 'review'; item: ReviewItem };
    rationale: string;
    evidence: { studyId: string; window: string; numbers: Record<string, number> };
}

export interface StudyStore {
    insert(row: NewStudyRow): Promise<StudyRow>;
    update(creatorId: string, id: string, patch: StudyPatch): Promise<StudyRow | null>;
    list(creatorId: string): Promise<StudyRow[]>;
    get(creatorId: string, id: string): Promise<StudyRow | null>;
    /** Every tenant's studies that can still change, least recently checked first. */
    open(limit: number): Promise<StudyRow[]>;
}

export interface StudyPorts {
    store: StudyStore;
    /** null: ads are not configured for the tenant. */
    account(creatorId: string): Promise<StudyAccount | null>;
    saveBusinessId(creatorId: string, businessId: string): Promise<void>;
    /** `GET /me/businesses` (1 point). */
    listBusinesses(creatorId: string): Promise<Array<{ id: string; name: string }>>;
    /** A Graph read through the pinned, paced client. */
    graphGet(creatorId: string, path: string, params: Record<string, string>): Promise<any>;
    getObject(creatorId: string, id: string): Promise<StudyObject | null>;
    /** The one money rule with a candidate of `amount` over `days` (A1's `lifetime:<amount>:<days>`). */
    money(creatorId: string, candidate: { amount: number; days: number }): Promise<MoneyAnswer>;
    enqueue(input: StudyOpInput): Promise<StudyOp>;
    /**
     * A2's switch for one stored object (actions.ts `requestStatus`): ACTIVE runs its own payment check, daily max and money rule on the
     * campaign all on, under its lock, with the owner's confirm; PAUSED never spends.
     */
    setStatus(creatorId: string, objectId: string, status: 'ACTIVE' | 'PAUSED', userId: string | null): Promise<StudyOp>;
    /** A2's budget write on a paused ad set (actions.ts `requestBudget`): a new daily amount, 4 an hour at most. */
    setDailyBudget(creatorId: string, objectId: string, amount: number, userId: string | null): Promise<StudyOp>;
    getOp(creatorId: string, id: string): Promise<StudyOp | null>;
    createProposal(creatorId: string, proposal: WinnerProposal): Promise<{ id: string }>;
    now(): Date;
}

export class StudyError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string,
        readonly field?: string,
        readonly extra: Record<string, unknown> = {},
    ) {
        super(message);
    }
}

// ─── Pure rules ──────────────────────────────────────────────────────────────

/** 100 split over n arms in whole percents; the remainder goes to the first arms (3 → 34, 33, 33). */
export function equalSplit(n: number): number[] {
    const base = Math.floor(100 / n);
    const rest = 100 - base * n;
    return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 'YYYY-MM-DD' as midnight in the ad account's day; null when it is not a real date. */
export function accountMidnight(date: string, offsetHours: number): Date | null {
    const m = DATE_RE.exec(date);
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const utc = Date.UTC(y, mo - 1, d);
    const back = new Date(utc);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
    return new Date(utc - offsetHours * 3_600_000);
}

/** Today's date in the ad account's day, as 'YYYY-MM-DD'. */
export function accountToday(now: Date, offsetHours: number): string {
    return new Date(now.getTime() + offsetHours * 3_600_000).toISOString().slice(0, 10);
}

export interface StudyInput {
    type: StudyType;
    name: string | null;
    cellIds: string[];
    dailyBudget: number;
    start: Date;
    end: Date;
    days: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: string; error: string };

/**
 * The owner's request, checked before anything is read: the type, 2..max distinct arms, a positive daily budget, a start from tomorrow in
 * the account's day (Meta's earliest), 1–30 days, and `confirm: true`.
 */
export function parseStudyInput(body: unknown, now: Date, offsetHours: number): Parsed<StudyInput> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (b.type !== 'creative' && b.type !== 'audience') return { ok: false, field: 'type', error: 'Choose a creative test or an audience test.' };
    const type = b.type;
    let name: string | null = null;
    if (b.name !== undefined && b.name !== null && b.name !== '') {
        if (typeof b.name !== 'string' || b.name.trim().length > STUDY_NAME_MAX) return { ok: false, field: 'name', error: `The name is at most ${STUDY_NAME_MAX} characters.` };
        name = b.name.trim() || null;
    }
    const { min, max } = STUDY_ARMS[type];
    if (!Array.isArray(b.cells) || !b.cells.every((c) => typeof c === 'string' && c.length > 0 && c.length <= 64)) {
        return { ok: false, field: 'cells', error: 'Pick the versions to test.' };
    }
    const cellIds = b.cells as string[];
    if (new Set(cellIds).size !== cellIds.length) return { ok: false, field: 'cells', error: 'Each version can be in the test once.' };
    if (cellIds.length < min || cellIds.length > max) return { ok: false, field: 'cells', error: `A ${type} test has ${min} to ${max} versions.` };
    const daily = typeof b.dailyBudget === 'number' ? b.dailyBudget : Number.NaN;
    if (!Number.isFinite(daily) || daily <= 0 || daily > 1_000_000) return { ok: false, field: 'dailyBudget', error: 'Enter the daily budget for the test.' };
    const start = typeof b.start === 'string' ? accountMidnight(b.start, offsetHours) : null;
    if (!start) return { ok: false, field: 'start', error: 'Pick the start date.' };
    if ((b.start as string) <= accountToday(now, offsetHours)) return { ok: false, field: 'start', error: 'A test can start tomorrow at the earliest.' };
    const end = typeof b.end === 'string' ? accountMidnight(b.end, offsetHours) : null;
    if (!end) return { ok: false, field: 'end', error: 'Pick the end date.' };
    const days = Math.round((end.getTime() - start.getTime()) / DAY_MS);
    if (days < 1 || days > STUDY_MAX_DAYS) return { ok: false, field: 'end', error: `A test runs 1 to ${STUDY_MAX_DAYS} days.` };
    if (b.confirm !== true) return { ok: false, field: 'confirm', error: 'Confirm the test.' };
    return { ok: true, value: { type, name, cellIds, dailyBudget: roundMoney(daily), start, end, days } };
}

/**
 * The arms the stored copy holds for those ids, checked: all the tenant's (else NOT_OWN_OBJECT), the right level (ads for a creative test,
 * ad sets for an audience test), made at Meta, PAUSED, one ad account, one currency. A creative test's ads share one ad set (the shared
 * audience); an audience test's ad sets carry their own daily budget (a campaign budget cannot be split per arm).
 */
export function checkArms(type: StudyType, ids: string[], objects: Array<StudyObject | null>): StudyObject[] {
    const want = type === 'creative' ? 'ad' : 'adset';
    const arms: StudyObject[] = [];
    for (let i = 0; i < ids.length; i++) {
        const o = objects[i];
        if (!o) throw new StudyError(404, 'NOT_OWN_OBJECT', 'That version is not in this ad account.', 'cells');
        if (o.level !== want) throw new StudyError(400, 'INVALID', type === 'creative' ? 'A creative test compares ads.' : 'An audience test compares ad sets.', 'cells');
        if (!o.metaId) throw new StudyError(400, 'INVALID', 'A version is still being created at Meta; wait for it.', 'cells');
        if (o.status !== 'PAUSED') throw new StudyError(400, 'INVALID', 'Every version must be paused when the test is made.', 'cells');
        arms.push(o);
    }
    if (new Set(arms.map((a) => a.adAccountId)).size > 1 || new Set(arms.map((a) => a.currency)).size > 1) {
        throw new StudyError(400, 'INVALID', 'All versions must be in one ad account.', 'cells');
    }
    if (type === 'creative' && new Set(arms.map((a) => a.parentId)).size > 1) {
        throw new StudyError(400, 'INVALID', 'The ads in a creative test must be in the same ad set, so they share the audience.', 'cells');
    }
    if (type === 'audience' && arms.some((a) => a.budgetKind !== 'daily')) {
        throw new StudyError(400, 'INVALID', 'Each ad set in an audience test needs its own daily budget.', 'cells');
    }
    return arms;
}

const ARM_LETTERS = 'ABCDEFG';

export function buildCells(type: StudyType, arms: StudyObject[]): StudyCell[] {
    const shares = equalSplit(arms.length);
    return arms.map((a, i) => ({
        name: ARM_LETTERS[i]!,
        objectId: a.id,
        metaId: a.metaId!,
        objectName: a.name,
        level: type === 'creative' ? 'ad' : 'adset',
        treatmentPercentage: shares[i]!,
    }));
}

export function defaultStudyName(type: StudyType, start: Date, lang: 'ar' | 'en'): string {
    const day = start.toISOString().slice(0, 10);
    if (lang === 'ar') return `${type === 'creative' ? 'اختبار نسختين' : 'اختبار جمهورين'} ${day}`;
    return `${type === 'creative' ? 'Creative test' : 'Audience test'} ${day}`;
}

/** The `POST /{business_id}/ad_studies` params (Graph form encoding turns the arrays and objects into JSON). */
export function buildStudyParams(s: { type: StudyType; metaName: string; cells: StudyCell[]; start: Date; end: Date; dailyBudget: number; currency: string }): Record<string, string | number | object> {
    const start = Math.floor(s.start.getTime() / 1000);
    const end = Math.floor(s.end.getTime() / 1000);
    const common = { name: s.metaName, start_time: start, end_time: end };
    if (s.type === 'creative') {
        return {
            ...common,
            type: 'SPLIT_TEST_V2',
            cells: s.cells.map((c) => ({ name: c.name, treatment_percentage: c.treatmentPercentage, ads: [c.metaId] })),
            creative_test_config: { daily_budget: toMinorUnits(s.dailyBudget, s.currency) },
            cooldown_start_time: start,
            observation_end_time: end,
        };
    }
    return {
        ...common,
        type: 'SPLIT_TEST',
        cells: s.cells.map((c) => ({ name: c.name, treatment_percentage: c.treatmentPercentage, adsets: [c.metaId] })),
    };
}

/** An audience test's equal split: each ad set's daily budget becomes the test's daily budget over the arms, to the cent. */
export function armDailyBudget(dailyBudget: number, arms: number): number {
    return Math.floor((dailyBudget / arms) * 100) / 100;
}

/** What starting can spend at most: the test's daily budget every day, plus the budget of every paused parent switched on with it. */
export function startWorstCase(dailyBudget: number, days: number, parents: StudyObject[]): number {
    let total = dailyBudget * days;
    for (const p of parents) {
        if (p.budgetKind === 'daily' && p.budgetAmount) total += p.budgetAmount * days;
        else if (p.budgetKind === 'lifetime' && p.budgetAmount) total += p.budgetAmount;
    }
    return roundMoney(total);
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface ParsedResults {
    highPerformerIds: string[];
    winnerId: string | null;
    winnerConfidence: number | null;
    confidenceById: Record<string, number>;
}

/** Meta's confidence as 0–100 with one decimal: a fraction (0.87) or a percent (87) both read as 87. */
export function normaliseConfidence(value: unknown): number | null {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
    const pct = n <= 1 ? n * 100 : n;
    return pct > 100 ? null : Math.round(pct * 10) / 10;
}

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : []);

/**
 * An objective's `results`, whatever shape this version answers in: an object, a JSON string, or a list of either. The ids and
 * confidences of every entry are merged.
 */
export function parseObjectiveResults(raw: unknown): ParsedResults {
    const out: ParsedResults = { highPerformerIds: [], winnerId: null, winnerConfidence: null, confidenceById: {} };
    const visit = (v: unknown): void => {
        if (typeof v === 'string') {
            try {
                visit(JSON.parse(v));
            } catch {
                /* not JSON: nothing to read */
            }
            return;
        }
        if (Array.isArray(v)) {
            v.forEach(visit);
            return;
        }
        if (!v || typeof v !== 'object') return;
        const o = v as Record<string, unknown>;
        if ('results' in o && !('high_performer_ids' in o)) visit(o.results);
        for (const id of idList(o.high_performer_ids)) if (!out.highPerformerIds.includes(id)) out.highPerformerIds.push(id);
        if ((typeof o.winner_ad_object_id === 'string' || typeof o.winner_ad_object_id === 'number') && !out.winnerId) out.winnerId = String(o.winner_ad_object_id);
        const wc = normaliseConfidence(o.winner_confidence);
        if (wc !== null && out.winnerConfidence === null) out.winnerConfidence = wc;
        const byId = o.confidence_by_ad_object_id;
        if (byId && typeof byId === 'object' && !Array.isArray(byId)) {
            for (const [id, c] of Object.entries(byId as Record<string, unknown>)) {
                const n = normaliseConfidence(c);
                if (n !== null) out.confidenceById[id] = n;
            }
        }
    };
    visit(raw);
    return out;
}

/**
 * Meta's answer in the study's terms: the winning arms (high performers, else the declared winner, never an id that is not an arm),
 * each arm's confidence by ads_objects id, and whether this is the last word. Every arm a high performer is no winner either.
 */
export function decideResult(cells: StudyCell[], parsed: ParsedResults, endTime: Date, now: Date): StudyResult {
    const byMeta = new Map(cells.map((c) => [c.metaId, c.objectId]));
    let winners = parsed.highPerformerIds.filter((id) => byMeta.has(id));
    if (winners.length === 0 && parsed.winnerId && byMeta.has(parsed.winnerId)) winners = [parsed.winnerId];
    const confidenceByObjectId: Record<string, number> = {};
    for (const [metaId, c] of Object.entries(parsed.confidenceById)) {
        const objectId = byMeta.get(metaId);
        if (objectId) confidenceByObjectId[objectId] = c;
    }
    if (parsed.winnerId && parsed.winnerConfidence !== null && byMeta.has(parsed.winnerId)) {
        confidenceByObjectId[byMeta.get(parsed.winnerId)!] ??= parsed.winnerConfidence;
    }
    const final = now.getTime() >= endTime.getTime() + FINAL_AFTER_END_MS;
    const separated = winners.length > 0 && winners.length < cells.length;
    return {
        winnerObjectIds: separated ? winners.map((id) => byMeta.get(id)!) : [],
        highPerformerIds: parsed.highPerformerIds,
        confidenceByObjectId,
        final,
        noWinner: final && !separated,
        checkedAt: now.toISOString(),
    };
}

/** The proposal to keep the winner: pause every other arm. None until the result is final and separates the arms. */
export function winnerProposal(study: Pick<StudyRow, 'id' | 'name' | 'cells' | 'startTime' | 'endTime' | 'dailyBudget' | 'currency'>, result: StudyResult, lang: 'ar' | 'en'): WinnerProposal | null {
    if (!result.final || result.noWinner || result.winnerObjectIds.length === 0) return null;
    const losers = study.cells.filter((c) => !result.winnerObjectIds.includes(c.objectId));
    if (losers.length === 0) return null;
    const winners = study.cells.filter((c) => result.winnerObjectIds.includes(c.objectId));
    const label = (c: StudyCell) => `${c.name}${c.objectName ? ` (${c.objectName})` : ''}`;
    const conf = (c: StudyCell) => result.confidenceByObjectId[c.objectId];
    const topConf = conf(winners[0]!);
    const rationale = lang === 'ar'
        ? `انتهى اختبار «${study.name}». رأت ميتا أن ${winners.map(label).join('، ')} الأفضل أداءً${topConf !== undefined ? ` بثقة ${topConf}%` : ''}. نقترح إيقاف ${losers.map(label).join('، ')} والإبقاء على الفائز.`
        : `The test "${study.name}" has ended. Meta found ${winners.map(label).join(', ')} performed best${topConf !== undefined ? ` with ${topConf}% confidence` : ''}. Proposal: pause ${losers.map(label).join(', ')} and keep the winner.`;
    const days = Math.round((study.endTime.getTime() - study.startTime.getTime()) / DAY_MS);
    // Numbers only: the Proposals card formats each as a number (`ads.proposals.measure.<key>`).
    const numbers: Record<string, number> = { days, dailyBudget: study.dailyBudget };
    for (const c of study.cells) {
        const v = conf(c);
        if (v !== undefined) numbers[`confidence_${c.name}`] = v;
    }
    const window = `${days}d`;
    return {
        kind: 'test_winner',
        source: 'study',
        state: 'open',
        payload: { task: 'review', item: { kind: 'pause', targets: losers.map((c) => c.objectId), change: { percent: -100 }, evidence: { window, numbers }, rationale } },
        rationale,
        evidence: { studyId: study.id, window, numbers },
    };
}

/** The create op's outcome on the row: Meta's id makes it ready; a failure keeps Meta's words. */
export function reconcileCreate(op: StudyOp | null): StudyPatch | null {
    if (!op) return null;
    if (op.state === 'done') {
        const r = op.result as { id?: unknown } | null;
        const id = r && (typeof r.id === 'string' || typeof r.id === 'number') ? String(r.id) : null;
        return id ? { state: 'ready', metaId: id, error: null } : { state: 'failed', error: 'Meta answered without a study id.' };
    }
    if (op.state === 'failed' || op.state === 'cancelled') {
        const r = op.result as { message?: unknown } | null;
        return { state: 'failed', error: r && typeof r.message === 'string' ? r.message : 'Meta refused the test.' };
    }
    return null;
}

// ─── The screen's view ───────────────────────────────────────────────────────

export interface StudyView {
    id: string;
    metaId: string | null;
    type: StudyType;
    name: string;
    state: StudyState;
    dailyBudget: number;
    currency: string;
    start: string;
    end: string;
    days: number;
    cells: Array<StudyCell & { winner: boolean; confidence: number | null }>;
    result: StudyResult | null;
    proposalId: string | null;
    error: string | null;
    createdAt: string;
    adsManagerUrl: string;
}

export function toStudyView(row: StudyRow): StudyView {
    const winners = new Set(row.result?.winnerObjectIds ?? []);
    return {
        id: row.id,
        metaId: row.metaId,
        type: row.type,
        name: row.name,
        state: row.state,
        dailyBudget: row.dailyBudget,
        currency: row.currency,
        start: row.startTime.toISOString(),
        end: row.endTime.toISOString(),
        days: Math.round((row.endTime.getTime() - row.startTime.getTime()) / DAY_MS),
        cells: row.cells.map((c) => ({ ...c, winner: winners.has(c.objectId), confidence: row.result?.confidenceByObjectId[c.objectId] ?? null })),
        result: row.result,
        proposalId: row.proposalId,
        error: row.error,
        createdAt: row.createdAt.toISOString(),
        adsManagerUrl: `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${row.adAccountId.replace(/^act_/, '')}`,
    };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

async function requireAccount(ports: StudyPorts, creatorId: string): Promise<StudyAccount> {
    const account = await ports.account(creatorId);
    if (!account) throw new StudyError(409, 'ADS_NOT_CONFIGURED', 'Connect the ad account first.');
    return account;
}

function refuseMoney(answer: MoneyAnswer): void {
    if (answer.fits) return;
    const code = answer.reason ?? 'OVER_MONTHLY_CAP';
    throw new StudyError(code === 'NOT_CONFIGURED' ? 409 : 400, code === 'NOT_CONFIGURED' ? 'ADS_NOT_CONFIGURED' : code,
        'This test does not fit the limits you set.', 'dailyBudget', { remaining: answer.remaining, currency: answer.currency });
}

/**
 * The business portfolio studies are made under: the saved one, else the only one the token sees (saved for next time). None, or more
 * than one, asks the owner to pick (409 BUSINESS_REQUIRED with the choices).
 */
export async function resolveBusinessId(ports: StudyPorts, creatorId: string, saved: string | null): Promise<string> {
    if (saved) return saved;
    const choices = await ports.listBusinesses(creatorId);
    if (choices.length === 1) {
        await ports.saveBusinessId(creatorId, choices[0]!.id);
        return choices[0]!.id;
    }
    throw new StudyError(409, 'BUSINESS_REQUIRED', choices.length === 0
        ? 'Split tests need a Meta business portfolio, and this token cannot see one.'
        : 'Pick the Meta business portfolio for split tests.', 'businessId', { choices });
}

/** Make a test: checked, money-checked, stored, and one `study` op queued. The arms stay paused; nothing is spent. */
export async function createStudy(ports: StudyPorts, creatorId: string, userId: string | null, body: unknown): Promise<{ study: StudyView; ops: StudyOp[] }> {
    const account = await requireAccount(ports, creatorId);
    const now = ports.now();
    const parsed = parseStudyInput(body, now, account.timezoneOffsetHours);
    if (!parsed.ok) throw new StudyError(400, 'INVALID', parsed.error, parsed.field);
    const input = parsed.value;
    const objects = await Promise.all(input.cellIds.map((id) => ports.getObject(creatorId, id)));
    const arms = checkArms(input.type, input.cellIds, objects);
    if (arms[0]!.adAccountId !== account.adAccountId) throw new StudyError(404, 'NOT_OWN_OBJECT', 'That version is not in this ad account.', 'cells');
    refuseMoney(await ports.money(creatorId, { amount: roundMoney(input.dailyBudget * input.days), days: input.days }));
    const businessId = await resolveBusinessId(ports, creatorId, account.businessId);
    const cells = buildCells(input.type, arms);
    const name = input.name ?? defaultStudyName(input.type, input.start, account.lang);
    const row = await ports.store.insert({
        id: crypto.randomUUID(), creatorId, adAccountId: account.adAccountId, businessId, type: input.type, name, cells,
        dailyBudget: input.dailyBudget, currency: arms[0]!.currency, startTime: input.start, endTime: input.end, createdBy: userId,
    });
    const ops: StudyOp[] = [];
    // An audience test's arms are the ad sets' own budgets: made equal first, while they are paused.
    if (input.type === 'audience') {
        const each = armDailyBudget(input.dailyBudget, arms.length);
        for (const a of arms) ops.push(await ports.setDailyBudget(creatorId, a.id, each, userId));
    }
    const create = await ports.enqueue({
        creatorId, adAccountId: account.adAccountId, objectKey: `study:${row.id}`, kind: 'study', idempotencyKey: `study:${row.id}:create`,
        actor: { userId, via: 'owner' },
        payload: {
            // `edge` makes it a create: its name gets the op's `AR·<op id>` tag, and a timed-out create is looked for by that tag before
            // it is ever sent again (ops.ts), so one test is never made twice.
            exec: { method: 'POST', path: `${businessId}/ad_studies`, edge: 'ad_studies', params: buildStudyParams({ type: input.type, metaName: name, cells, start: input.start, end: input.end, dailyBudget: input.dailyBudget, currency: row.currency }) },
            studyId: row.id,
        },
    });
    ops.push(create);
    const stored = (await ports.store.update(creatorId, row.id, { opId: create.id, ...(reconcileCreate(create) ?? {}) })) ?? row;
    return { study: toStudyView(stored), ops };
}

async function loadStudy(ports: StudyPorts, creatorId: string, id: string): Promise<StudyRow> {
    const row = await ports.store.get(creatorId, id);
    if (!row) throw new StudyError(404, 'NOT_FOUND', 'That test does not exist.');
    return row;
}

/** The paused parents starting switches on with the arms: a creative test's ad set and campaign, an audience test's campaigns. */
async function pausedParents(ports: StudyPorts, creatorId: string, row: StudyRow): Promise<StudyObject[]> {
    const seen = new Map<string, StudyObject>();
    const arms = await Promise.all(row.cells.map((c) => ports.getObject(creatorId, c.objectId)));
    let level: Array<StudyObject | null> = arms;
    for (let depth = 0; depth < 2; depth++) {
        const parentIds = [...new Set(level.map((o) => o?.parentId).filter((p): p is string => !!p))];
        level = await Promise.all(parentIds.map((p) => ports.getObject(creatorId, p)));
        for (const p of level) if (p && (p.level === 'adset' || p.level === 'campaign') && p.status === 'PAUSED' && p.metaId) seen.set(p.id, p);
    }
    return [...seen.values()];
}

/**
 * Start a ready test: confirm, the money rule on the worst case (the test's own budget included, which A2's switch does not see), then
 * the arms switched on, then their parents, the campaign last, so nothing runs until everything is set. Each switch is A2's, with its own
 * payment check and money rule; one it refuses stops the start there, and what was switched on before it sits under a paused parent.
 */
export async function startStudy(ports: StudyPorts, creatorId: string, userId: string | null, id: string, body: unknown): Promise<{ study: StudyView; ops: StudyOp[] }> {
    if ((body as { confirm?: unknown } | null)?.confirm !== true) throw new StudyError(400, 'INVALID', 'Confirm the start: it spends money.', 'confirm');
    let row = await loadStudy(ports, creatorId, id);
    row = await reconcile(ports, row);
    if (row.state !== 'ready') throw new StudyError(409, 'INVALID', row.state === 'creating' ? 'The test is still being made at Meta.' : 'This test cannot be started.', 'state');
    const now = ports.now();
    if (now.getTime() >= row.endTime.getTime()) throw new StudyError(409, 'INVALID', 'The test\'s dates have passed.', 'state');
    const days = Math.max(1, Math.ceil((row.endTime.getTime() - Math.max(now.getTime(), row.startTime.getTime())) / DAY_MS));
    const parents = await pausedParents(ports, creatorId, row);
    // An audience test's arms ARE its budget; a creative test's parent ad set spends beside the test ads.
    const counted = row.type === 'creative' ? parents : parents.filter((p) => p.level === 'campaign');
    const worst = startWorstCase(row.dailyBudget, days, counted);
    refuseMoney(await ports.money(creatorId, { amount: worst, days }));
    const order = [
        ...row.cells.map((c) => c.objectId),
        ...parents.filter((p) => p.level === 'adset').map((p) => p.id),
        ...parents.filter((p) => p.level === 'campaign').map((p) => p.id),
    ];
    const ops: StudyOp[] = [];
    for (const objectId of order) ops.push(await ports.setStatus(creatorId, objectId, 'ACTIVE', userId));
    const stored = (await ports.store.update(creatorId, row.id, { state: 'running' })) ?? row;
    return { study: toStudyView(stored), ops };
}

/** Stop a test: pause its arms (and a creative test's ad set). No confirm; stopping only lowers spend. */
export async function stopStudy(ports: StudyPorts, creatorId: string, userId: string | null, id: string): Promise<{ study: StudyView; ops: StudyOp[] }> {
    const row = await loadStudy(ports, creatorId, id);
    if (row.state !== 'ready' && row.state !== 'running') throw new StudyError(409, 'INVALID', 'This test is not running.', 'state');
    const targets = row.cells.map((c) => c.objectId);
    if (row.type === 'creative' && row.state === 'running') {
        const arm = await ports.getObject(creatorId, row.cells[0]!.objectId);
        if (arm?.parentId) targets.push(arm.parentId);
    }
    const ops: StudyOp[] = [];
    if (row.state === 'running') {
        for (const objectId of targets) ops.push(await ports.setStatus(creatorId, objectId, 'PAUSED', userId));
    }
    const stored = (await ports.store.update(creatorId, row.id, { state: 'stopped' })) ?? row;
    return { study: toStudyView(stored), ops };
}

/** A `creating` row takes its create op's outcome (no Meta call). */
async function reconcile(ports: StudyPorts, row: StudyRow): Promise<StudyRow> {
    if (row.state !== 'creating' || !row.opId) return row;
    const patch = reconcileCreate(await ports.getOp(row.creatorId, row.opId));
    return patch ? ((await ports.store.update(row.creatorId, row.id, patch)) ?? row) : row;
}

/** GET /studies: Postgres only (the stored rows and the queue). */
export async function listStudies(ports: StudyPorts, creatorId: string): Promise<{ studies: StudyView[]; businessId: string | null }> {
    const account = await ports.account(creatorId);
    const rows = await Promise.all((await ports.store.list(creatorId)).map((r) => reconcile(ports, r)));
    return { studies: rows.map(toStudyView), businessId: account?.businessId ?? null };
}

/** Read one running test's result from Meta (2 points), store it, and on the final read open the keep-the-winner proposal once. */
export async function checkStudyResult(ports: StudyPorts, row: StudyRow): Promise<StudyRow> {
    const now = ports.now();
    const objectives = await ports.graphGet(row.creatorId, `${row.metaId}/objectives`, { fields: 'id,name,is_primary' });
    const list = Array.isArray(objectives?.data) ? (objectives.data as Array<{ id?: unknown; is_primary?: unknown }>) : [];
    const primary = list.find((o) => o.is_primary === true) ?? list[0];
    let parsed: ParsedResults = { highPerformerIds: [], winnerId: null, winnerConfidence: null, confidenceById: {} };
    if (primary && (typeof primary.id === 'string' || typeof primary.id === 'number')) {
        const objective = await ports.graphGet(row.creatorId, String(primary.id), { fields: 'results' });
        parsed = parseObjectiveResults(objective?.results ?? objective);
    }
    const result = decideResult(row.cells, parsed, row.endTime, now);
    let patch: StudyPatch = { result, resultsCheckedAt: now };
    if (result.final) {
        patch = { ...patch, state: 'ended' };
        if (!row.proposalId) {
            const account = await ports.account(row.creatorId);
            const proposal = winnerProposal(row, result, account?.lang ?? 'ar');
            if (proposal) patch.proposalId = (await ports.createProposal(row.creatorId, proposal)).id;
        }
    }
    return (await ports.store.update(row.creatorId, row.id, patch)) ?? row;
}

/**
 * The results poll, run from the ads sync: creates are reconciled from the queue; a running test is read every 6 h and once more
 * half a day after it ends; a ready test whose dates passed without a start is stopped. One study's failure (a throttle included) is logged
 * and left for the next run, never retried here.
 */
export async function pollStudies(ports: StudyPorts, deadline: number, onError: (row: StudyRow, err: unknown) => void = () => {}): Promise<{ checked: number; ended: number; failed: number }> {
    const counts = { checked: 0, ended: 0, failed: 0 };
    for (const open of await ports.store.open(50)) {
        if (Date.now() >= deadline) break;
        try {
            const row = await reconcile(ports, open);
            const now = ports.now().getTime();
            if (row.state === 'ready' && now >= row.endTime.getTime()) {
                await ports.store.update(row.creatorId, row.id, { state: 'stopped', error: 'The test was never started.' });
                continue;
            }
            if (row.state !== 'running' || !row.metaId || now < row.startTime.getTime()) continue;
            const due = !row.resultsCheckedAt || now - row.resultsCheckedAt.getTime() >= RESULTS_EVERY_MS || (now >= row.endTime.getTime() + FINAL_AFTER_END_MS);
            if (!due) continue;
            const after = await checkStudyResult(ports, row);
            counts.checked++;
            if (after.state === 'ended') counts.ended++;
        } catch (err) {
            counts.failed++;
            onError(open, err);
        }
    }
    return counts;
}
