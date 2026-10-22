/**
 * The Ads screen: the whole ad account from AutoReply (every campaign, also those made in Ads Manager or by other tools), spend
 * today and this month, payment status, and the controls: pause, resume, change a budget or end date, delete. Boosts made from the
 * Posts screen are campaigns here too, and their controls go through `adBoosts.ts` so the boost record stays right.
 *
 * THE MONEY RULE for a campaign that is not a boost: it may be switched on, or its budget raised, only if the WORST CASE this month
 * fits under the owner's monthly cap. Worst case = what Meta says the account spent this month + the most every active campaign
 * could still spend before the month ends (`remainingThisMonth`): a lifetime budget's unspent part, or a daily budget × the days left
 * in its window this month. It is checked under the same per-tenant lock as boosts. A daily budget is also held to the max daily
 * budget. And nothing is switched on while Meta says the account has no payment method: the API cannot add one, so the screen links
 * to Meta's billing page instead.
 */
import { describeError, log } from '../utils/log.js';
import { queryOne, queryRows } from '../db/query.js';
import {
    activateBoost, AdsError, committedThisMonth, deleteBoost, lockTenantBoosts, metaRefusal, pauseBoost, requireConfig,
    updateBoost, type AdBoostRow,
} from './adBoosts.js';
import {
    deleteAdObject, fetchAccountState, fromMinorUnits, getNode, graphTime, num, readInsights, roundMoney, toMinorUnits, updateObject,
    type AdAccountState, type BoostInsights, type BoostObjective,
} from './metaAds.js';
import { withTransaction } from './studio/common.js';

const DAY_MS = 86_400_000;

// ─── Pure ─────────────────────────────────────────────────────────────────────────────────

/** What Graph returns for a budget holder (a campaign or an ad set): budgets in MINOR units, as strings. */
interface RawBudgetHolder {
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
    if (minor(c.daily_budget) > 0) return { kind: 'daily', amount: fromMinorUnits(minor(c.daily_budget), currency), level: 'campaign', holderId: c.id, editable: true };
    if (minor(c.lifetime_budget) > 0) return { kind: 'lifetime', amount: fromMinorUnits(minor(c.lifetime_budget), currency), level: 'campaign', holderId: c.id, editable: true };
    const sets = c.adsets?.data ?? [];
    if (sets.length === 1) {
        const s = sets[0]!;
        if (minor(s.daily_budget) > 0) return { kind: 'daily', amount: fromMinorUnits(minor(s.daily_budget), currency), level: 'adset', holderId: s.id ?? null, editable: Boolean(s.id) };
        if (minor(s.lifetime_budget) > 0) return { kind: 'lifetime', amount: fromMinorUnits(minor(s.lifetime_budget), currency), level: 'adset', holderId: s.id ?? null, editable: Boolean(s.id) };
    }
    return { kind: 'none', amount: null, level: null, holderId: null, editable: false };
}

/** Whole days of a window left inside this UTC month, from now (or the window's start, if later). Rounded up: a day begun is counted. */
export function daysLeftThisMonth(start: Date | null, end: Date | null, now: Date): number {
    const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
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
function holderRemaining(h: RawBudgetHolder, spentMinor: number, now: Date): number {
    const end = date(h.end_time ?? h.stop_time);
    if (minor(h.lifetime_budget) > 0) {
        if (end && end.getTime() <= now.getTime()) return 0;
        return Math.max(0, minor(h.lifetime_budget) - spentMinor);
    }
    if (minor(h.daily_budget) > 0) return minor(h.daily_budget) * daysLeftThisMonth(date(h.start_time), end, now);
    return 0;
}

/**
 * The most a campaign can still spend before this UTC month ends, in major units: its own budget, or the sum over its ad sets. With
 * ad-set lifetime budgets, the campaign's lifetime spend is shared out against them, which can only over-count (the safe side).
 */
export function remainingThisMonth(c: RawCampaign, currency: string, spentLifetime: number, now: Date): number {
    const spentMinor = toMinorUnits(spentLifetime, currency);
    if (minor(c.daily_budget) > 0 || minor(c.lifetime_budget) > 0) return roundMoney(fromMinorUnits(holderRemaining(c, spentMinor, now), currency));
    const sets = (c.adsets?.data ?? []).filter((s) => s.status !== 'PAUSED' && s.status !== 'DELETED' && s.status !== 'ARCHIVED');
    const total = sets.reduce((sum, s) => sum + holderRemaining(s, sets.length === 1 ? spentMinor : 0, now), 0);
    return roundMoney(fromMinorUnits(total, currency));
}

export type CapCheck = { ok: true; worstCase: number } | { ok: false; worstCase: number; left: number };

/** spentThisMonth + the others' remaining + this one's remaining must fit under the cap. */
export function checkWorstCase(input: { spentThisMonth: number; othersRemaining: number; thisRemaining: number; monthlyCap: number }): CapCheck {
    const c = (n: number) => Math.round(n * 100);
    const worstCase = roundMoney(input.spentThisMonth + input.othersRemaining + input.thisRemaining);
    if (c(worstCase) <= c(input.monthlyCap)) return { ok: true, worstCase };
    const left = Math.max(0, c(input.monthlyCap) - c(input.spentThisMonth + input.othersRemaining)) / 100;
    return { ok: false, worstCase, left };
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

// ─── Reading the account ──────────────────────────────────────────────────────────────────

/** The statuses listed: everything but deleted and archived. */
const LISTED_STATUSES = ['ACTIVE', 'PAUSED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED'];

const CAMPAIGN_FIELDS = [
    'id', 'name', 'objective', 'status', 'effective_status', 'daily_budget', 'lifetime_budget', 'start_time', 'stop_time',
    'adsets.limit(25){id,status,daily_budget,lifetime_budget,start_time,end_time}',
    'insights.date_preset(maximum){spend,reach,impressions,clicks,cpm,actions}',
].join(',');

async function readCampaigns(adAccountId: string, token: string): Promise<RawCampaign[]> {
    const data = await getNode(`act_${adAccountId}/campaigns`, {
        fields: CAMPAIGN_FIELDS, limit: '50', effective_status: JSON.stringify(LISTED_STATUSES),
    }, token, 'campaigns');
    return Array.isArray(data?.data) ? data.data.filter((c: any) => typeof c?.id === 'string') : [];
}

async function readCampaign(campaignId: string, token: string): Promise<RawCampaign> {
    const data = await getNode(campaignId, { fields: CAMPAIGN_FIELDS }, token, 'campaign');
    if (typeof data?.id !== 'string') throw new AdsError(404, 'CAMPAIGN_NOT_FOUND', 'No such campaign.');
    return data as RawCampaign;
}

async function readSpend(adAccountId: string, preset: 'today' | 'this_month', token: string): Promise<number | null> {
    try {
        const data = await getNode(`act_${adAccountId}/insights`, { fields: 'spend', date_preset: preset }, token, `spend ${preset}`);
        const row = Array.isArray(data?.data) ? data.data[0] : null;
        return row ? roundMoney(num(row.spend)) : 0;
    } catch (err) {
        log('warn', 'ads.spend_unreadable', { preset, ...describeError(err) });
        return null;
    }
}

export interface CampaignView {
    id: string;
    name: string;
    objective: string | null;
    status: string | null;
    effectiveStatus: string | null;
    budget: Omit<CampaignBudget, 'holderId'>;
    startTime: string | null;
    endTime: string | null;
    insights: BoostInsights | null;
    boostId: string | null;
    postId: string | null;
}

function toCampaignView(c: RawCampaign, currency: string, boost: { id: string; scheduled_post_id: string | null } | undefined): CampaignView {
    const { holderId: _holder, ...budget } = campaignBudget(c, currency);
    const sets = c.adsets?.data ?? [];
    const end = c.stop_time ?? (sets.length === 1 ? sets[0]!.end_time : undefined) ?? null;
    return {
        id: c.id,
        name: c.name ?? c.id,
        objective: c.objective ?? null,
        status: c.status ?? null,
        effectiveStatus: c.effective_status ?? null,
        budget,
        startTime: c.start_time ?? (sets.length === 1 ? sets[0]!.start_time ?? null : null),
        endTime: end,
        insights: campaignInsights(c),
        boostId: boost?.id ?? null,
        postId: boost?.scheduled_post_id ?? null,
    };
}

async function boostsByCampaign(creatorId: string): Promise<Map<string, { id: string; scheduled_post_id: string | null }>> {
    const rows = await queryRows<{ id: string; scheduled_post_id: string | null; campaign_id: string }>(
        "SELECT id, scheduled_post_id, campaign_id FROM ad_boosts WHERE creator_id = $1 AND campaign_id IS NOT NULL AND status <> 'deleted'",
        [creatorId]
    );
    return new Map(rows.map((r) => [r.campaign_id, r]));
}

export interface AdsOverview {
    configured: boolean;
    account: AdAccountState | null;
    accountError: string | null;
    spend: { today: number | null; thisMonth: number | null };
    limits: { maxDailyBudget: number | null; monthlyCap: number | null; committedThisMonth: number; worstCaseThisMonth: number | null };
    campaigns: CampaignView[];
}

function lifetimeSpend(c: RawCampaign): number {
    return campaignInsights(c)?.spend ?? 0;
}

/** Everything the Ads screen shows, read from Meta in four calls (account, two spend reads, campaigns). */
export async function readOverview(creatorId: string, now = new Date()): Promise<AdsOverview> {
    const { settings, token } = await requireConfig(creatorId);
    const committed = await committedThisMonth(null, creatorId, null, now);
    const limits = { maxDailyBudget: settings.maxDailyBudget, monthlyCap: settings.monthlyCap, committedThisMonth: committed, worstCaseThisMonth: null as number | null };
    let account: AdAccountState;
    try {
        account = await fetchAccountState(settings.adAccountId, token);
    } catch (err) {
        return { configured: true, account: null, accountError: metaRefusal(err).message, spend: { today: null, thisMonth: null }, limits, campaigns: [] };
    }
    const [today, thisMonth, raw, boosts] = await Promise.all([
        readSpend(settings.adAccountId, 'today', token),
        readSpend(settings.adAccountId, 'this_month', token),
        readCampaigns(settings.adAccountId, token).catch((err) => { throw metaRefusal(err); }),
        boostsByCampaign(creatorId),
    ]);
    const othersRemaining = raw.filter(isActive).reduce((sum, c) => sum + remainingThisMonth(c, account.currency, lifetimeSpend(c), now), 0);
    limits.worstCaseThisMonth = thisMonth === null ? null : roundMoney(thisMonth + othersRemaining);
    return {
        configured: true,
        account,
        accountError: null,
        spend: { today, thisMonth },
        limits,
        campaigns: raw.map((c) => toCampaignView(c, account.currency, boosts.get(c.id))),
    };
}

// ─── The controls ─────────────────────────────────────────────────────────────────────────

async function boostFor(creatorId: string, campaignId: string): Promise<AdBoostRow | null> {
    return queryOne<AdBoostRow>("SELECT * FROM ad_boosts WHERE creator_id = $1 AND campaign_id = $2 AND status <> 'deleted' LIMIT 1", [creatorId, campaignId]);
}

/** A campaign id is digits. Anything else is refused before it reaches a Graph URL. */
function campaignId(id: unknown): string {
    if (typeof id !== 'string' || !/^[0-9]{5,25}$/.test(id)) throw new AdsError(404, 'CAMPAIGN_NOT_FOUND', 'No such campaign.');
    return id;
}

/** The campaign must belong to the configured ad account: a request cannot reach into another account the token happens to see. */
async function ownCampaign(adAccountId: string, id: string, token: string): Promise<RawCampaign> {
    let c: RawCampaign & { account_id?: string };
    try {
        c = await getNode(id, { fields: `${CAMPAIGN_FIELDS},account_id` }, token, 'campaign');
    } catch (err) {
        throw metaRefusal(err);
    }
    if (typeof c?.id !== 'string' || String(c.account_id ?? '') !== adAccountId) throw new AdsError(404, 'CAMPAIGN_NOT_FOUND', 'No such campaign in your ad account.');
    return c;
}

async function viewOf(creatorId: string, id: string, token: string, currency: string): Promise<CampaignView> {
    const [c, boosts] = await Promise.all([readCampaign(id, token).catch((err) => { throw err instanceof AdsError ? err : metaRefusal(err); }), boostsByCampaign(creatorId)]);
    return toCampaignView(c, currency, boosts.get(id));
}

/**
 * Pause or resume a campaign. Resuming is the step that spends, so it needs a payment method on the account and the worst case to fit
 * under the cap; a boost that has never run is activated through `activateBoost`, which also moves its window to start now.
 */
export async function setCampaignStatus(creatorId: string, rawId: unknown, status: unknown, now = new Date()): Promise<CampaignView> {
    if (status !== 'ACTIVE' && status !== 'PAUSED') throw new AdsError(400, 'INVALID', 'The status is ACTIVE or PAUSED.', 'status');
    const id = campaignId(rawId);
    const { settings, token } = await requireConfig(creatorId);
    let account: AdAccountState;
    try {
        account = await fetchAccountState(settings.adAccountId, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    const campaign = await ownCampaign(settings.adAccountId, id, token);
    const boost = await boostFor(creatorId, id);

    if (status === 'PAUSED') {
        if (boost && boost.status === 'active') await pauseBoost(creatorId, boost.id);
        else {
            try {
                await updateObject(id, { status: 'PAUSED' }, token, 'pause campaign');
            } catch (err) {
                throw metaRefusal(err);
            }
            if (boost) await updateBoost(boost.id, { status: 'paused' });
        }
        log('info', 'ads.campaign_paused', { creator_id: creatorId, campaign_id: id });
        return viewOf(creatorId, id, token, account.currency);
    }

    if (account.hasPaymentMethod === false) {
        throw new AdsError(409, 'PAYMENT_METHOD_MISSING', 'This ad account has no payment method, so nothing can run. Add one in Meta (the button on this screen), then try again.');
    }
    if (boost && boost.status === 'paused' && !boost.activated_at) {
        await activateBoost(creatorId, boost.id, now);
        return viewOf(creatorId, id, token, account.currency);
    }

    await withTransaction(async (tx) => {
        await lockTenantBoosts(tx, creatorId);
        const [thisMonth, all] = await Promise.all([readSpend(settings.adAccountId, 'this_month', token), readCampaigns(settings.adAccountId, token)]);
        if (thisMonth === null) throw new AdsError(502, 'META_ERROR', 'Meta did not say what the account spent this month, so the cap cannot be checked. Try again.');
        const others = all.filter((c) => c.id !== id && isActive(c)).reduce((sum, c) => sum + remainingThisMonth(c, account.currency, lifetimeSpend(c), now), 0);
        const mine = remainingThisMonth(campaign, account.currency, lifetimeSpend(campaign), now);
        const check = checkWorstCase({ spentThisMonth: thisMonth, othersRemaining: others, thisRemaining: mine, monthlyCap: settings.monthlyCap });
        if (!check.ok) {
            throw new AdsError(400, 'BUDGET_OVER_MONTHLY_CAP',
                `Switching this on could bring this month to ${check.worstCase}, over your monthly cap of ${settings.monthlyCap}. Lower its budget, pause another campaign, or raise the cap.`);
        }
        const budget = campaignBudget(campaign, account.currency);
        if (budget.kind === 'daily' && budget.amount !== null && budget.amount > settings.maxDailyBudget) {
            throw new AdsError(400, 'BUDGET_OVER_DAILY_MAX', `Its daily budget ${budget.amount} is over your max daily budget of ${settings.maxDailyBudget}.`);
        }
        try {
            await updateObject(id, { status: 'ACTIVE' }, token, 'resume campaign');
        } catch (err) {
            throw metaRefusal(err);
        }
    });
    if (boost) await updateBoost(boost.id, { status: 'active' });
    log('info', 'ads.campaign_resumed', { creator_id: creatorId, campaign_id: id });
    return viewOf(creatorId, id, token, account.currency);
}

/**
 * Change a campaign's budget (daily amount, or lifetime total) and optionally its end. Only where the budget has one home (the campaign,
 * or its single ad set). A daily budget is held to the max daily budget; an active campaign's new worst case must fit under the cap.
 */
export async function setCampaignBudget(creatorId: string, rawId: unknown, body: { amount?: unknown; endTime?: unknown }, now = new Date()): Promise<CampaignView> {
    const id = campaignId(rawId);
    const amount = body.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.round(amount * 100) <= 0) throw new AdsError(400, 'INVALID', 'Enter an amount above 0.', 'amount');
    let end: Date | null = null;
    if (body.endTime !== undefined && body.endTime !== null && body.endTime !== '') {
        end = date(body.endTime);
        if (!end || end.getTime() <= now.getTime() + 3600_000) throw new AdsError(400, 'INVALID', 'The end must be a date at least an hour from now.', 'endTime');
    }
    const { settings, token } = await requireConfig(creatorId);
    let account: AdAccountState;
    try {
        account = await fetchAccountState(settings.adAccountId, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    const campaign = await ownCampaign(settings.adAccountId, id, token);
    const budget = campaignBudget(campaign, account.currency);
    if (!budget.editable || !budget.holderId) {
        throw new AdsError(409, 'BUDGET_NOT_EDITABLE', 'This campaign has a budget on each of several ad sets: change them in Ads Manager.');
    }
    const value = roundMoney(amount);
    if (budget.kind === 'daily' && value > settings.maxDailyBudget) {
        throw new AdsError(400, 'BUDGET_OVER_DAILY_MAX', `The daily budget ${value} is over your max daily budget of ${settings.maxDailyBudget}.`, 'amount');
    }
    const spent = lifetimeSpend(campaign);
    if (budget.kind === 'lifetime' && value <= spent) {
        throw new AdsError(400, 'INVALID', `This campaign has already spent ${spent}: the total must be more than that.`, 'amount');
    }
    const boost = await boostFor(creatorId, id);

    await withTransaction(async (tx) => {
        await lockTenantBoosts(tx, creatorId);
        // What the campaign would look like after the edit, for the cap.
        const field = budget.kind === 'daily' ? 'daily_budget' : 'lifetime_budget';
        const minorValue = String(toMinorUnits(value, account.currency));
        const after: RawCampaign = budget.level === 'campaign'
            ? { ...campaign, [field]: minorValue, ...(end ? { stop_time: end.toISOString() } : {}) }
            : { ...campaign, adsets: { data: [{ ...(campaign.adsets?.data?.[0] ?? {}), [field]: minorValue, ...(end ? { end_time: end.toISOString() } : {}) }] } };

        if (boost && boost.status !== 'active' && !boost.activated_at) {
            // A boost that has not run is counted at its planned total (adBoosts.ts): the new total must fit like a new boost would.
            const committed = await committedThisMonth(tx, creatorId, boost.id, now);
            const total = budget.kind === 'lifetime' ? value : value * boost.days;
            if (Math.round((committed + total) * 100) > Math.round(settings.monthlyCap * 100)) {
                throw new AdsError(400, 'BUDGET_OVER_MONTHLY_CAP', `This boost could spend ${total}, but only ${Math.max(0, roundMoney(settings.monthlyCap - committed))} of your monthly cap is left.`, 'amount');
            }
        } else if (isActive(campaign)) {
            const [thisMonth, all] = await Promise.all([readSpend(settings.adAccountId, 'this_month', token), readCampaigns(settings.adAccountId, token)]);
            if (thisMonth === null) throw new AdsError(502, 'META_ERROR', 'Meta did not say what the account spent this month, so the cap cannot be checked. Try again.');
            const others = all.filter((c) => c.id !== id && isActive(c)).reduce((sum, c) => sum + remainingThisMonth(c, account.currency, lifetimeSpend(c), now), 0);
            const check = checkWorstCase({ spentThisMonth: thisMonth, othersRemaining: others, thisRemaining: remainingThisMonth(after, account.currency, spent, now), monthlyCap: settings.monthlyCap });
            if (!check.ok) {
                throw new AdsError(400, 'BUDGET_OVER_MONTHLY_CAP', `This budget could bring this month to ${check.worstCase}, over your monthly cap of ${settings.monthlyCap}.`, 'amount');
            }
        }

        const params: Record<string, string> = { [field]: minorValue };
        if (end) params[budget.level === 'campaign' ? 'stop_time' : 'end_time'] = graphTime(end);
        try {
            await updateObject(budget.holderId!, params, token, 'budget');
        } catch (err) {
            throw metaRefusal(err);
        }
        if (boost) {
            const total = budget.kind === 'lifetime' ? value : roundMoney(value * boost.days);
            await updateBoost(boost.id, {
                planned_total: total,
                daily_budget: budget.kind === 'lifetime' ? roundMoney(value / boost.days) : value,
                ...(end ? { ends_at: end } : {}),
            });
        }
    });
    log('info', 'ads.campaign_budget', { creator_id: creatorId, campaign_id: id, kind: budget.kind, level: budget.level });
    return viewOf(creatorId, id, token, account.currency);
}

/** Delete a campaign at Meta (its ad sets and ads go with it). Never while it is on: pause first. */
export async function deleteCampaign(creatorId: string, rawId: unknown): Promise<{ ok: true }> {
    const id = campaignId(rawId);
    const { settings, token } = await requireConfig(creatorId);
    const campaign = await ownCampaign(settings.adAccountId, id, token);
    if (isActive(campaign)) throw new AdsError(409, 'CAMPAIGN_ACTIVE', 'Pause the campaign before deleting it.');
    const boost = await boostFor(creatorId, id);
    if (boost) {
        await deleteBoost(creatorId, boost.id);
    } else {
        try {
            await deleteAdObject(id, token);
        } catch (err) {
            throw metaRefusal(err);
        }
    }
    log('info', 'ads.campaign_deleted', { creator_id: creatorId, campaign_id: id, boost: Boolean(boost) });
    return { ok: true };
}

