/**
 * THE money rule (research R7): one rule for everything that can start or raise spend, and the `remaining` every screen shows.
 *
 *   worst case this month = what Meta says the ad account spent this month (every campaign, also those made in Ads Manager)
 *                         + what every ACTIVE campaign can still spend before the month ends (`remainingThisMonth`)
 *                         + what is about to run: activations and budget raises already checked and sent, not yet visible at Meta
 *                         + the candidate (the thing being switched on, or the new budget's extra)
 *   and it must be at most the owner's monthly cap.
 *
 * - The month is the AD ACCOUNT's calendar month (Meta's `this_month` is in the account's time zone).
 * - A daily budget counts today at 1.75× (Meta may spend up to 75% over a daily budget on one day; its week stays within 7× daily, so
 *   only the current day is raised) and each later day of the window once. A lifetime budget counts its whole unspent part, because
 *   Meta may spend it early.
 * - The daily max applies to the average a day: a daily budget as it is, a lifetime one as `amount / days`.
 *
 * It replaces v1's two models: `checkBoostBudget`'s local UTC-month sum of boost rows is gone, and `adsCap.ts` (now re-exports of this
 * file) was the start of this one.
 *
 * Spending runs in three steps, so no Meta call is ever made inside a database transaction (the transaction pooler would hold a
 * connection, and a lock, for up to 40 s of Graph retries):
 *   1. the live month is read from Meta, outside any transaction (`readMonth`);
 *   2. a SHORT transaction takes the tenant's lock (`lockMoney`), re-checks with what is about to run (`aboutToRun`), and records the
 *      spend as a `running` op in `ads_ops` (`startSpendOp`), which makes it "about to run" for anyone checking after it;
 *   3. Meta is called, then the op is marked done / failed / verify (`finishSpendOp`).
 * A second activation racing the first therefore counts the first: either its op is still running, or it finished after the second's
 * month was read (anything finished up to two minutes before that read is counted too, so Meta's own lag cannot hide it).
 */
import { describeError, log } from '../../utils/log.js';
import { queryOne } from '../../db/query.js';
import { withTransaction, type Exec } from '../studio/common.js';
import { AdsGraphError } from './graph.js';
import {
    currencyOffset, fetchAccountState, fromMinorUnits, getNode, num, readInsights, roundMoney, toMinorUnits, type AdAccountState,
    type BoostInsights, type BoostObjective,
} from './metaAds.js';

export { currencyOffset, fromMinorUnits, toMinorUnits, roundMoney };

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Meta may spend up to 75% over a daily budget on one day (v24+ budget rules). */
export const DAILY_OVERSPEND = 1.75;

/** The highest amount anything here accepts, in major units: an extra zero or three is refused, not spent. */
export const MONEY_MAX = 1_000_000;

const cents = (n: number): number => Math.round(n * 100);

// ─── Pure: what Meta's budgets can still spend ────────────────────────────────────────────────

/** What Graph returns for a budget holder (a campaign or an ad set): budgets in MINOR units, as strings. */
export interface RawBudgetHolder {
    id?: string;
    status?: string;
    daily_budget?: string | number;
    lifetime_budget?: string | number;
    start_time?: string;
    end_time?: string;
    stop_time?: string;
}

export interface RawCampaign extends RawBudgetHolder {
    id: string;
    name?: string;
    objective?: string;
    effective_status?: string;
    adsets?: { data?: RawBudgetHolder[] };
    insights?: { data?: unknown[] };
}

export interface CampaignBudget {
    kind: 'daily' | 'lifetime' | 'none';
    /** Major units: the daily amount for `daily`, the total for `lifetime`. */
    amount: number | null;
    /** Where the budget lives, i.e. what an edit writes to. */
    level: 'campaign' | 'adset' | null;
    /** The id an edit writes to. Internal: not sent to the screen. */
    holderId: string | null;
    /** The single ad set's id, where an end date is written (a campaign's `stop_time` is derived from its ad sets). */
    adsetId: string | null;
    editable: boolean;
}

const minor = (value: unknown): number => num(value);

/**
 * Where a campaign's budget lives. A campaign budget (Advantage campaign budget) is edited on the campaign; otherwise a campaign with
 * ONE ad set (every boost) is edited on that ad set. Several ad sets with their own budgets are "set per ad set": shown, not editable
 * here (Ads Manager does that well, and summing them into one number to edit would be a guess).
 */
export function campaignBudget(c: RawCampaign, currency: string): CampaignBudget {
    const sets = c.adsets?.data ?? [];
    const single = sets.length === 1 && sets[0]!.id ? sets[0]!.id! : null;
    if (minor(c.daily_budget) > 0) return { kind: 'daily', amount: fromMinorUnits(minor(c.daily_budget), currency), level: 'campaign', holderId: c.id, adsetId: single, editable: true };
    if (minor(c.lifetime_budget) > 0) return { kind: 'lifetime', amount: fromMinorUnits(minor(c.lifetime_budget), currency), level: 'campaign', holderId: c.id, adsetId: single, editable: true };
    if (sets.length === 1) {
        const s = sets[0]!;
        if (minor(s.daily_budget) > 0) return { kind: 'daily', amount: fromMinorUnits(minor(s.daily_budget), currency), level: 'adset', holderId: s.id ?? null, adsetId: single, editable: Boolean(s.id) };
        if (minor(s.lifetime_budget) > 0) return { kind: 'lifetime', amount: fromMinorUnits(minor(s.lifetime_budget), currency), level: 'adset', holderId: s.id ?? null, adsetId: single, editable: Boolean(s.id) };
    }
    return { kind: 'none', amount: null, level: null, holderId: null, adsetId: null, editable: false };
}

/**
 * The first instant of the NEXT calendar month in the account's timezone, as a UTC time. `offsetHours` is the account's UTC offset
 * (Meta's `timezone_offset_hours_utc`, e.g. 3 for Riyadh); 0 when unknown.
 */
export function accountMonthEnd(now: Date, offsetHours: number): number {
    const local = new Date(now.getTime() + offsetHours * HOUR_MS);
    return Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - offsetHours * HOUR_MS;
}

/** Whole days of a window left inside the account's month, from now (or the window's start, if later). Rounded up: a day begun counts. */
export function daysLeftThisMonth(start: Date | null, end: Date | null, now: Date, offsetHours = 0): number {
    const monthEnd = accountMonthEnd(now, offsetHours);
    const from = Math.max(now.getTime(), start?.getTime() ?? 0);
    const to = Math.min(monthEnd, end?.getTime() ?? Infinity);
    return to > from ? Math.ceil((to - from) / DAY_MS) : 0;
}

function date(value: unknown): Date | null {
    if (typeof value !== 'string' || !value) return null;
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
}

/** A daily amount over `days` days of window: today at 1.75× when the window is already open, every other day once. */
function dailyOver(amount: number, days: number, openNow: boolean): number {
    if (days <= 0) return 0;
    return openNow ? amount * (DAILY_OVERSPEND + days - 1) : amount * days;
}

/** The most one budget holder can still spend this month, in minor units. `spentMinor` is its lifetime spend (for a lifetime budget). */
function holderRemaining(h: RawBudgetHolder, spentMinor: number, now: Date, offsetHours: number): number {
    const start = date(h.start_time);
    const end = date(h.end_time ?? h.stop_time);
    if (minor(h.lifetime_budget) > 0) {
        if (end && end.getTime() <= now.getTime()) return 0;
        return Math.max(0, minor(h.lifetime_budget) - spentMinor);
    }
    if (minor(h.daily_budget) > 0) {
        const openNow = !start || start.getTime() <= now.getTime();
        return dailyOver(minor(h.daily_budget), daysLeftThisMonth(start, end, now, offsetHours), openNow);
    }
    return 0;
}

const OFF = new Set(['PAUSED', 'DELETED', 'ARCHIVED']);

/**
 * The most a campaign can still spend before this month ends, in major units: its own budget, or the sum over its running ad sets. The
 * campaign's lifetime spend is set against an ad set's lifetime budget only when the campaign has exactly one ad set in all; with
 * several, nothing is subtracted, which can only over-count (the safe side).
 */
export function remainingThisMonth(c: RawCampaign, currency: string, spentLifetime: number, now: Date, offsetHours = 0): number {
    const spentMinor = toMinorUnits(spentLifetime, currency);
    if (minor(c.daily_budget) > 0 || minor(c.lifetime_budget) > 0) return roundMoney(fromMinorUnits(holderRemaining(c, spentMinor, now, offsetHours), currency));
    const all = c.adsets?.data ?? [];
    const running = all.filter((s) => !OFF.has(String(s.status ?? '')));
    const total = running.reduce((sum, s) => sum + holderRemaining(s, all.length === 1 ? spentMinor : 0, now, offsetHours), 0);
    return roundMoney(fromMinorUnits(total, currency));
}

/**
 * One more day of a campaign: each running daily budget at 1.75× (if its window is open within the day), and each lifetime budget's whole
 * unspent part (Meta may spend a lifetime budget early). What the hourly guard adds to this month's spend to decide whether today could
 * pass the cap.
 */
export function oneDayRemaining(c: RawCampaign, currency: string, spentLifetime: number, now: Date): number {
    const open = (h: RawBudgetHolder) => {
        const start = date(h.start_time);
        const end = date(h.end_time ?? h.stop_time);
        return (!start || start.getTime() <= now.getTime() + DAY_MS) && (!end || end.getTime() > now.getTime());
    };
    const spentMinor = toMinorUnits(spentLifetime, currency);
    const holderDay = (h: RawBudgetHolder, spent: number) => {
        if (!open(h)) return 0;
        if (minor(h.daily_budget) > 0) return minor(h.daily_budget) * DAILY_OVERSPEND;
        if (minor(h.lifetime_budget) > 0) return Math.max(0, minor(h.lifetime_budget) - spent);
        return 0;
    };
    if (minor(c.daily_budget) > 0 || minor(c.lifetime_budget) > 0) return roundMoney(fromMinorUnits(holderDay(c, spentMinor), currency));
    const all = c.adsets?.data ?? [];
    const total = all.filter((s) => !OFF.has(String(s.status ?? ''))).reduce((sum, s) => sum + holderDay(s, all.length === 1 ? spentMinor : 0), 0);
    return roundMoney(fromMinorUnits(total, currency));
}

// ─── Pure: the rule ─────────────────────────────────────────────────────────────────────────

export interface WorstCaseInput {
    spentThisMonth: number;
    /** What every ACTIVE campaign (the one being changed aside) can still spend this month. */
    othersRemaining: number;
    /** Checked and sent, not yet visible at Meta. */
    aboutToRun: number;
    /** What the change being checked adds. 0 to ask what is left. */
    candidate: number;
}

export function worstCase(input: WorstCaseInput): number {
    return roundMoney(input.spentThisMonth + input.othersRemaining + Math.max(0, input.aboutToRun) + Math.max(0, input.candidate));
}

export interface CandidateCheck {
    fits: boolean;
    /** The worst case with the candidate. */
    worstCase: number;
    /** What anything new may still add this month: the cap minus the worst case WITHOUT the candidate, never below 0. */
    remaining: number;
    reason: 'OVER_MONTHLY_CAP' | null;
}

/** The rule. Compared in cents, so 0.1 + 0.2 is 0.3. */
export function checkCandidate(input: WorstCaseInput & { monthlyCap: number }): CandidateCheck {
    const withIt = worstCase(input);
    const without = worstCase({ ...input, candidate: 0 });
    const remaining = Math.max(0, cents(input.monthlyCap) - cents(without)) / 100;
    const fits = cents(withIt) <= cents(input.monthlyCap);
    return { fits, worstCase: withIt, remaining, reason: fits ? null : 'OVER_MONTHLY_CAP' };
}

/**
 * The hourly guard's decision: pause everything when the month's spend has reached the cap, or when one more day of the active
 * campaigns would carry it past (spent + one more day of every daily budget at 1.75× + every lifetime budget's unspent part > cap).
 */
export function shouldPauseAll(input: { spentThisMonth: number; nextDayRemaining: number; monthlyCap: number }): boolean {
    return cents(input.spentThisMonth) >= cents(input.monthlyCap) || cents(input.spentThisMonth + input.nextDayRemaining) > cents(input.monthlyCap);
}

/** v1's name for the same check, kept for one phase (adsManager.ts used it). */
export type CapCheck = { ok: true; worstCase: number } | { ok: false; worstCase: number; left: number };

export function checkWorstCase(input: { spentThisMonth: number; othersRemaining: number; thisRemaining: number; monthlyCap: number }): CapCheck {
    const c = checkCandidate({ spentThisMonth: input.spentThisMonth, othersRemaining: input.othersRemaining, aboutToRun: 0, candidate: input.thisRemaining, monthlyCap: input.monthlyCap });
    return c.fits ? { ok: true, worstCase: c.worstCase } : { ok: false, worstCase: c.worstCase, left: c.remaining };
}

// ─── Pure: a candidate ──────────────────────────────────────────────────────────────────────

/** Something about to spend: a daily budget over `days` (null: to the end of the month), or a lifetime total over `days`. */
export interface Candidate {
    kind: 'daily' | 'lifetime';
    /** Major units: the daily amount, or the lifetime total. */
    amount: number;
    days: number | null;
}

/** `daily:<amount>[:<days>]` or `lifetime:<amount>:<days>`, the `?candidate=` of `GET /api/ads/money`. Null when malformed. */
export function parseCandidate(value: unknown): Candidate | null {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^(daily|lifetime):(\d+(?:\.\d{1,2})?)(?::(\d{1,3}))?$/);
    if (!m) return null;
    const amount = Number(m[2]);
    const days = m[3] === undefined ? null : Number(m[3]);
    if (!(amount > 0) || amount > MONEY_MAX) return null;
    if (days !== null && (days < 1 || days > 366)) return null;
    if (m[1] === 'lifetime' && days === null) return null;
    return { kind: m[1] as Candidate['kind'], amount: roundMoney(amount), days };
}

/** What a candidate can spend this month: a lifetime total all of it, a daily budget 1.75× today and once each later day of its window. */
export function candidateRemaining(c: Candidate, now: Date, offsetHours: number): number {
    if (c.kind === 'lifetime') return roundMoney(c.amount);
    const end = c.days === null ? null : new Date(now.getTime() + c.days * DAY_MS);
    return roundMoney(dailyOver(c.amount, daysLeftThisMonth(null, end, now, offsetHours), true));
}

export type DailyMaxCheck = { ok: true; perDay: number } | { ok: false; code: 'OVER_DAILY_MAX'; perDay: number; message: string };

/** The max daily budget, held against the average a day. */
export function checkDailyMax(c: Candidate, maxDailyBudget: number): DailyMaxCheck {
    const perDay = c.kind === 'lifetime' ? c.amount / Math.max(1, c.days ?? 1) : c.amount;
    if (cents(perDay) <= cents(maxDailyBudget)) return { ok: true, perDay: roundMoney(perDay) };
    return {
        ok: false, code: 'OVER_DAILY_MAX', perDay: roundMoney(perDay),
        message: c.kind === 'lifetime'
            ? `${c.amount} over ${c.days} day(s) is more than your max daily budget of ${maxDailyBudget} a day.`
            : `The daily budget ${c.amount} is over your max daily budget of ${maxDailyBudget}.`,
    };
}

// ─── Pure: a campaign's own numbers ─────────────────────────────────────────────────────────

const OBJECTIVE_TO_BOOST: Record<string, BoostObjective> = {
    OUTCOME_ENGAGEMENT: 'ENGAGEMENT',
    OUTCOME_AWARENESS: 'AWARENESS',
    OUTCOME_TRAFFIC: 'TRAFFIC',
};

export function campaignInsights(c: RawCampaign): BoostInsights | null {
    const objective = OBJECTIVE_TO_BOOST[c.objective ?? ''];
    const insights = readInsights(objective ?? 'AWARENESS', c.insights ?? { data: [] });
    if (!insights) return null;
    // An objective outside the three Boost uses has no single "result" here: say nothing rather than a wrong number.
    return objective ? insights : { ...insights, results: 0 };
}

export function isActive(c: Pick<RawCampaign, 'status' | 'effective_status'>): boolean {
    return c.status === 'ACTIVE';
}

export function lifetimeSpend(c: RawCampaign): number {
    return campaignInsights(c)?.spend ?? 0;
}

// ─── Reading from Meta (until the stored copy of A2 replaces it) ────────────────────────────

/** The statuses listed: everything but deleted and archived. */
const LISTED_STATUSES = ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'];

export const CAMPAIGN_FIELDS = [
    'id', 'name', 'objective', 'status', 'effective_status', 'daily_budget', 'lifetime_budget', 'start_time', 'stop_time',
    'adsets.limit(100){id,status,daily_budget,lifetime_budget,start_time,end_time}',
    'insights.date_preset(maximum){spend,reach,impressions,clicks,cpm,actions}',
].join(',');

/** At most this many pages of 50: an account with more than 500 live campaigns is not one this screen is for. */
const MAX_PAGES = 10;

/**
 * Every listed campaign, page by page with the `after` cursor (never by following Meta's `next` URL, which can carry a token). Throws
 * when there are more than MAX_PAGES pages: a cap check that silently missed campaigns would under-count.
 */
export async function readCampaigns(adAccountId: string, token: string): Promise<RawCampaign[]> {
    const out: RawCampaign[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const params: Record<string, string> = { fields: CAMPAIGN_FIELDS, limit: '50', effective_status: JSON.stringify(LISTED_STATUSES) };
        if (after) params['after'] = after;
        const data = await getNode(`act_${adAccountId}/campaigns`, params, token, 'campaigns');
        for (const c of Array.isArray(data?.data) ? data.data : []) if (typeof c?.id === 'string') out.push(c as RawCampaign);
        const next = data?.paging?.next ? data?.paging?.cursors?.after : null;
        if (typeof next !== 'string' || !next) return out;
        after = next;
    }
    throw new Error(`More than ${MAX_PAGES * 50} campaigns in this ad account: the cap cannot be checked from here.`);
}

/** The account's spend for a preset, major units. Null when Meta did not answer (the caller refuses rather than guess). */
export async function readSpend(adAccountId: string, preset: 'today' | 'this_month', token: string): Promise<number | null> {
    try {
        const data = await getNode(`act_${adAccountId}/insights`, { fields: 'spend', date_preset: preset }, token, `spend ${preset}`);
        const row = Array.isArray(data?.data) ? data.data[0] : null;
        return row ? roundMoney(num(row.spend)) : 0;
    } catch (err) {
        log('warn', 'ads.spend_unreadable', { preset, ...describeError(err) });
        return null;
    }
}

export interface MonthPicture {
    spentThisMonth: number;
    /** The most every active campaign but `excludeCampaignId` could still spend this month. */
    othersRemaining: number;
    campaigns: RawCampaign[];
    /** When Meta was read: what finished after (a little before) this is not in the picture yet. */
    readAt: Date;
}

/** Spend this month and what the active campaigns could still add. Throws when Meta did not say what was spent. Never inside a transaction. */
export async function readMonth(adAccountId: string, token: string, currency: string, offsetHours: number, excludeCampaignId: string | null, now: Date): Promise<MonthPicture> {
    const readAt = new Date();
    const [spent, campaigns] = await Promise.all([readSpend(adAccountId, 'this_month', token), readCampaigns(adAccountId, token)]);
    if (spent === null) throw new Error('Meta did not say what the account spent this month, so the cap cannot be checked. Try again in a minute.');
    const othersRemaining = campaigns
        .filter((c) => c.id !== excludeCampaignId && isActive(c))
        .reduce((sum, c) => sum + remainingThisMonth(c, currency, lifetimeSpend(c), now, offsetHours), 0);
    return { spentThisMonth: spent, othersRemaining: roundMoney(othersRemaining), campaigns, readAt };
}

// ─── The database: the lock and what is about to run ────────────────────────────────────────

/** One tenant's money checks and the writes that follow them, one at a time. Held until the transaction ends. */
export async function lockMoney(exec: Exec, creatorId: string): Promise<void> {
    await exec.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ads:${creatorId}`]);
}

/** Anything that finished this long before a month picture was read may still be missing from it (Meta's own lag). */
export const VISIBILITY_LAG_MS = 120_000;

const ABOUT_TO_RUN_SQL = `
    SELECT COALESCE(SUM((payload->>'worst_case_delta')::numeric), 0)::text AS total
      FROM ads_ops
     WHERE creator_id = $1
       AND payload ? 'worst_case_delta'
       AND ($3::text IS NULL OR object_key <> $3)
       AND (state IN ('pending', 'running')
            OR (state = 'verify' AND created_at > NOW() - INTERVAL '24 hours')
            OR (state = 'done' AND finished_at > $2))`;

/**
 * What is checked and sent but may not be in a month picture read at `pictureReadAt`: every pending or running spend op, a `verify`
 * one (it may have landed) for a day, and a done one that finished after the picture (minus Meta's lag). `excludeKey` leaves out the
 * object being checked, whose own op is the candidate.
 */
export async function aboutToRun(exec: Exec | null, creatorId: string, pictureReadAt: Date, excludeKey: string | null): Promise<number> {
    const params = [creatorId, new Date(pictureReadAt.getTime() - VISIBILITY_LAG_MS), excludeKey];
    const row = exec ? (await exec.query<{ total: string }>(ABOUT_TO_RUN_SQL, params)).rows[0] : await queryOne<{ total: string }>(ABOUT_TO_RUN_SQL, params);
    return roundMoney(Number(row?.total ?? 0));
}

export interface SpendOpInput {
    creatorId: string;
    adAccountId: string;
    /** The campaign (or other object) the op writes to. */
    objectKey: string;
    kind: 'status' | 'budget' | 'spend_cap';
    /** What the op sends, plus `worst_case_delta` for anything that raises spend. Never a token. */
    payload: Record<string, unknown>;
    actor: { userId: string | null; via: 'owner' | 'rule' | 'proposal' | 'guard' };
}

/** Inside the locked transaction: the spend is recorded as running, so it counts for everyone checking after this commits. */
export async function startSpendOp(exec: Exec, op: SpendOpInput): Promise<string> {
    const res = await exec.query<{ id: string }>(
        `INSERT INTO ads_ops (creator_id, ad_account_id, object_key, kind, payload, state, attempts, actor, started_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'running', 1, $6::jsonb, NOW()) RETURNING id`,
        [op.creatorId, op.adAccountId, op.objectKey, op.kind, JSON.stringify(op.payload), JSON.stringify(op.actor)]
    );
    return res.rows[0]!.id;
}

/**
 * After Meta answered (outside the transaction). `verify` is a call that may have landed (a timeout, a dropped connection): it keeps
 * counting as about to run for a day, because the campaign may be spending.
 */
export async function finishSpendOp(creatorId: string, id: string, state: 'done' | 'failed' | 'verify', result: Record<string, unknown> | null = null): Promise<void> {
    try {
        await queryOne(`UPDATE ads_ops SET state = $2, result = $3::jsonb, finished_at = NOW() WHERE id = $1 AND creator_id = $4 RETURNING id`, [id, state, result === null ? null : JSON.stringify(result), creatorId]);
    } catch (err) {
        // The op stays `running`, which keeps counting it: the safe side. Logged so it can be found.
        log('error', 'ads.op_finish_failed', { op_id: id, state, ...describeError(err) });
    }
}

/** The money rule said no. `check` has the numbers the screen shows. */
export class MoneyRefused extends Error {
    constructor(readonly check: CandidateCheck, readonly monthlyCap: number, readonly month: Omit<MonthPicture, 'campaigns'>, readonly aboutToRun: number) {
        super(`This could bring this month to ${check.worstCase}, over your monthly cap of ${monthlyCap} (spent ${month.spentThisMonth}, running campaigns could add ${roundMoney(month.othersRemaining + aboutToRun)}). Lower the budget, pause a campaign, or raise the cap.`);
        this.name = 'MoneyRefused';
    }
}

export interface SpendAttempt extends Omit<SpendOpInput, 'payload'> {
    /** The live picture, read OUTSIDE any transaction just before this. */
    month: Omit<MonthPicture, 'campaigns'>;
    /** What the change adds this month (an activation: the campaign's whole remaining; a raise: the new remaining minus the old). */
    candidate: number;
    monthlyCap: number;
    payload: Record<string, unknown>;
    /** The caller's own writes, inside the same locked transaction (a boost row's FOR UPDATE and its `activated_at`). Throw to refuse. */
    inside?: (tx: Exec) => Promise<void>;
    /**
     * Records the spend instead of `startSpendOp` (A2: the paced queue). Gets the payload with `worst_case_delta` added and returns the id
     * of the op that carries it, enqueued `pending` inside this locked transaction: pending counts as about to run for everyone after us.
     */
    record?: (tx: Exec, payload: Record<string, unknown>) => Promise<string>;
}

/**
 * Step 2 of spending (see the top of the file): a short transaction under the tenant's lock that re-checks the rule with what is about to
 * run, then records this spend as a running op. Throws `MoneyRefused` when it does not fit. Call Meta only after this returns, and then
 * `finishSpendOp` with the outcome.
 */
export async function checkAndStartSpend(a: SpendAttempt): Promise<{ opId: string; check: CandidateCheck }> {
    return withTransaction(async (tx) => {
        await lockMoney(tx, a.creatorId);
        const about = await aboutToRun(tx, a.creatorId, a.month.readAt, a.objectKey);
        const check = checkCandidate({ spentThisMonth: a.month.spentThisMonth, othersRemaining: a.month.othersRemaining, aboutToRun: about, candidate: a.candidate, monthlyCap: a.monthlyCap });
        if (!check.fits) throw new MoneyRefused(check, a.monthlyCap, a.month, about);
        if (a.inside) await a.inside(tx);
        const payload = { ...a.payload, worst_case_delta: roundMoney(Math.max(0, a.candidate)) };
        const opId = a.record
            ? await a.record(tx, payload)
            : await startSpendOp(tx, { creatorId: a.creatorId, adAccountId: a.adAccountId, objectKey: a.objectKey, kind: a.kind, actor: a.actor, payload });
        return { opId, check };
    });
}

/** A Graph failure that may have happened after Meta acted on it: no answer at all, or a 5xx. */
export function mayHaveLanded(err: unknown): boolean {
    // Refused by our own pacer, or throttled by Meta: nothing was sent, or Meta said no.
    if (err instanceof AdsGraphError && err.klass !== 'other') return false;
    const e = err as { status?: unknown; cause?: { response?: { status?: unknown } } };
    const status = typeof e?.status === 'number' ? e.status : typeof e?.cause?.response?.status === 'number' ? e.cause.response.status : null;
    return status === null ? !(err as { metaCode?: unknown })?.metaCode : status >= 500;
}

// ─── The picture every screen shows ─────────────────────────────────────────────────────────

export interface MoneyLimits {
    adAccountId: string;
    monthlyCap: number;
    maxDailyBudget: number;
}

export interface MoneyAnswer {
    currency: string | null;
    fits: boolean;
    remaining: number | null;
    worstCase: number | null;
    spentThisMonth: number | null;
    monthlyCap: number | null;
    maxDailyBudget: number | null;
    reason: 'OVER_MONTHLY_CAP' | 'OVER_DAILY_MAX' | 'NOT_CONFIGURED' | 'UNREADABLE' | null;
    monthBoundaryTz: string | null;
    /** Every figure excludes tax: Meta's invoices are the accounting record (FR-014). */
    excludesTax: true;
}

interface CachedPicture {
    at: number;
    account: Pick<AdAccountState, 'currency' | 'timezoneOffsetHours' | 'timezoneName'>;
    month: Omit<MonthPicture, 'campaigns'>;
}

/** Instance-memory cache of each tenant's live picture, so a dialog opened twice in a minute spends Meta's points once. */
const PICTURE_TTL_MS = 60_000;
const pictures = new Map<string, CachedPicture>();

export function forgetMoneyPicture(creatorId?: string): void {
    if (creatorId) pictures.delete(creatorId);
    else pictures.clear();
}

/**
 * `GET /api/ads/money`: what is left this month, and whether a candidate fits, by the same rule as activation (which re-reads Meta fresh
 * and re-checks under the lock). Never throws for Meta: a picture it could not read is `UNREADABLE`, which fits nothing.
 */
export async function moneyFor(creatorId: string, limits: MoneyLimits | null, token: string | null, candidate: Candidate | null, now = new Date()): Promise<MoneyAnswer> {
    const empty: MoneyAnswer = { currency: null, fits: false, remaining: null, worstCase: null, spentThisMonth: null, monthlyCap: limits?.monthlyCap ?? null, maxDailyBudget: limits?.maxDailyBudget ?? null, reason: 'NOT_CONFIGURED', monthBoundaryTz: null, excludesTax: true };
    if (!limits || !token) return empty;
    let picture = pictures.get(creatorId);
    if (!picture || now.getTime() - picture.at > PICTURE_TTL_MS) {
        try {
            const account = await fetchAccountState(limits.adAccountId, token);
            const { campaigns: _campaigns, ...month } = await readMonth(limits.adAccountId, token, account.currency, account.timezoneOffsetHours, null, now);
            picture = { at: now.getTime(), account, month };
            pictures.set(creatorId, picture);
        } catch (err) {
            log('warn', 'ads.money_unreadable', { creator_id: creatorId, ...describeError(err) });
            return { ...empty, reason: 'UNREADABLE' };
        }
    }
    const about = await aboutToRun(null, creatorId, picture.month.readAt, null);
    const offset = picture.account.timezoneOffsetHours;
    const candidateAmount = candidate ? candidateRemaining(candidate, now, offset) : 0;
    const check = checkCandidate({ spentThisMonth: picture.month.spentThisMonth, othersRemaining: picture.month.othersRemaining, aboutToRun: about, candidate: candidateAmount, monthlyCap: limits.monthlyCap });
    const daily = candidate ? checkDailyMax(candidate, limits.maxDailyBudget) : null;
    const overDaily = daily !== null && !daily.ok;
    return {
        currency: picture.account.currency,
        fits: check.fits && !overDaily,
        remaining: check.remaining,
        worstCase: check.worstCase,
        spentThisMonth: picture.month.spentThisMonth,
        monthlyCap: limits.monthlyCap,
        maxDailyBudget: limits.maxDailyBudget,
        reason: overDaily ? 'OVER_DAILY_MAX' : check.reason,
        monthBoundaryTz: picture.account.timezoneName ?? (offset ? `UTC${offset >= 0 ? '+' : ''}${offset}` : 'UTC'),
        excludesTax: true,
    };
}
