/**
 * THE monthly cap, one rule for every way money can be spent: a boost created or activated from Posts, a campaign switched on or given
 * a bigger budget from the Ads screen, and the hourly check that pauses everything once the month's spend reaches the cap.
 *
 *   worst case this month = what Meta says the account spent this month
 *                         + the most every active campaign could still spend before the month ends (`remainingThisMonth`)
 *                         + the most the thing being switched on could spend this month
 *
 * and it must be at most the owner's monthly cap. Campaigns made in Ads Manager or anywhere else count, because the spend and the
 * campaigns are read from Meta, not from our own rows. The month is the AD ACCOUNT's calendar month (Meta reports `this_month` in the
 * account's timezone), so a resume at 01:00 on the 1st in Cairo is not counted against the last hours of October in UTC.
 *
 * Pure parts first (tested in adsManager.test.ts / adsCap.test.ts), then the Graph reads. Imports only metaAds.ts, so both adBoosts.ts
 * and adsManager.ts can use it.
 */
import { describeError, log } from '../utils/log.js';
import { fromMinorUnits, getNode, num, readInsights, roundMoney, toMinorUnits, type BoostInsights, type BoostObjective } from './metaAds.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ─── Pure ─────────────────────────────────────────────────────────────────────────────────

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

function minor(value: unknown): number {
    return num(value);
}

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

/** The most one budget holder can still spend this month. `spentMinor` is what it has spent in its lifetime (for a lifetime budget). */
function holderRemaining(h: RawBudgetHolder, spentMinor: number, now: Date, offsetHours: number): number {
    const end = date(h.end_time ?? h.stop_time);
    if (minor(h.lifetime_budget) > 0) {
        if (end && end.getTime() <= now.getTime()) return 0;
        return Math.max(0, minor(h.lifetime_budget) - spentMinor);
    }
    if (minor(h.daily_budget) > 0) return minor(h.daily_budget) * daysLeftThisMonth(date(h.start_time), end, now, offsetHours);
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
 * One more day of a campaign: each running daily budget once (if its window is open now), and each lifetime budget's whole unspent part
 * (Meta may spend a lifetime budget early). What the hourly guard adds to this month's spend to decide whether today could pass the cap.
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
        if (minor(h.daily_budget) > 0) return minor(h.daily_budget);
        if (minor(h.lifetime_budget) > 0) return Math.max(0, minor(h.lifetime_budget) - spent);
        return 0;
    };
    if (minor(c.daily_budget) > 0 || minor(c.lifetime_budget) > 0) return roundMoney(fromMinorUnits(holderDay(c, spentMinor), currency));
    const all = c.adsets?.data ?? [];
    const total = all.filter((s) => !OFF.has(String(s.status ?? ''))).reduce((sum, s) => sum + holderDay(s, all.length === 1 ? spentMinor : 0), 0);
    return roundMoney(fromMinorUnits(total, currency));
}

export type CapCheck = { ok: true; worstCase: number } | { ok: false; worstCase: number; left: number };

/** spentThisMonth + the others' remaining + this one's remaining must fit under the cap. Compared in cents. */
export function checkWorstCase(input: { spentThisMonth: number; othersRemaining: number; thisRemaining: number; monthlyCap: number }): CapCheck {
    const c = (n: number) => Math.round(n * 100);
    const worstCase = roundMoney(input.spentThisMonth + input.othersRemaining + input.thisRemaining);
    if (c(worstCase) <= c(input.monthlyCap)) return { ok: true, worstCase };
    const left = Math.max(0, c(input.monthlyCap) - c(input.spentThisMonth + input.othersRemaining)) / 100;
    return { ok: false, worstCase, left };
}

/**
 * The hourly guard's decision: pause everything when the month's spend has reached the cap, or when today's budgets of the active
 * campaigns would carry it past (spent + one more day of every daily budget + every lifetime budget's unspent part > cap).
 */
export function shouldPauseAll(input: { spentThisMonth: number; nextDayRemaining: number; monthlyCap: number }): boolean {
    const c = (n: number) => Math.round(n * 100);
    return c(input.spentThisMonth) >= c(input.monthlyCap) || c(input.spentThisMonth + input.nextDayRemaining) > c(input.monthlyCap);
}

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

// ─── Reading from Meta ────────────────────────────────────────────────────────────────────

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
}

/** Spend this month and what the active campaigns could still add, for the cap. Throws when Meta did not say what was spent. */
export async function readMonth(adAccountId: string, token: string, currency: string, offsetHours: number, excludeCampaignId: string | null, now: Date): Promise<MonthPicture> {
    const [spent, campaigns] = await Promise.all([readSpend(adAccountId, 'this_month', token), readCampaigns(adAccountId, token)]);
    if (spent === null) throw new Error('Meta did not say what the account spent this month, so the cap cannot be checked. Try again in a minute.');
    const othersRemaining = campaigns
        .filter((c) => c.id !== excludeCampaignId && isActive(c))
        .reduce((sum, c) => sum + remainingThisMonth(c, currency, lifetimeSpend(c), now, offsetHours), 0);
    return { spentThisMonth: spent, othersRemaining: roundMoney(othersRemaining), campaigns };
}
