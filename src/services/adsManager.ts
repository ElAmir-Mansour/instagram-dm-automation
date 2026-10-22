/**
 * The Ads screen: the whole ad account from AutoReply (every campaign, also those made in Ads Manager or by other tools), spend
 * today and this month, payment status, and the controls: pause, resume, change a budget or end date, delete. Boosts made from the
 * Posts screen are campaigns here too, and their controls go through `adBoosts.ts` so the boost record stays right.
 *
 * Money rules (the cap itself is `adsCap.ts`, one rule for everything):
 *   - switching a campaign on, or raising an active one's budget, needs the owner's confirmation, a payment method on the account (when
 *     Meta says there is none), the worst case this month under the monthly cap, and a daily budget at most the max daily budget;
 *   - `enforceMonthlyCaps` (hourly, from the drain) pauses every active campaign in the account once the month's spend reaches the cap or
 *     today's budgets would carry it past: the cap holds after switch-on too, also for campaigns made elsewhere.
 * Writes that check the cap run under the tenant's boost lock (`lockTenantBoosts`), so two at once cannot both fit.
 */
import { describeError, log } from '../utils/log.js';
import { queryOne, queryRows } from '../db/query.js';
import {
    activateBoost, AdsError, committedThisMonth, deleteBoost, lockTenantBoosts, metaRefusal, pauseBoost, readAdsSettings, requireConfig,
    updateBoost, type AdBoostRow,
} from './adBoosts.js';
import {
    CAMPAIGN_FIELDS, campaignBudget, campaignInsights, checkWorstCase, isActive, lifetimeSpend, oneDayRemaining, readCampaigns, readMonth, readSpend,
    remainingThisMonth, shouldPauseAll, type CampaignBudget, type RawCampaign,
} from './adsCap.js';
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from './appSettings.js';
import {
    deleteAdObject, fetchAccountState, getNode, graphTime, roundMoney, toMinorUnits, updateObject, type AdAccountState, type BoostInsights,
} from './metaAds.js';
import { withTransaction } from './studio/common.js';

// ─── Views ────────────────────────────────────────────────────────────────────────────────

export interface CampaignView {
    id: string;
    name: string;
    objective: string | null;
    status: string | null;
    effectiveStatus: string | null;
    budget: Omit<CampaignBudget, 'holderId' | 'adsetId'>;
    startTime: string | null;
    endTime: string | null;
    insights: BoostInsights | null;
    boostId: string | null;
    postId: string | null;
}

function toCampaignView(c: RawCampaign, currency: string, boost: { id: string; scheduled_post_id: string | null } | undefined): CampaignView {
    const { holderId: _holder, adsetId: _adset, ...budget } = campaignBudget(c, currency);
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

/** Everything the Ads screen shows: the account, spend today and this month, every listed campaign. */
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
    const othersRemaining = raw.filter(isActive).reduce((sum, c) => sum + remainingThisMonth(c, account.currency, lifetimeSpend(c), now, account.timezoneOffsetHours), 0);
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
    let c: RawCampaign;
    try {
        c = await getNode(id, { fields: CAMPAIGN_FIELDS }, token, 'campaign');
    } catch (err) {
        throw metaRefusal(err);
    }
    return toCampaignView(c, currency, (await boostsByCampaign(creatorId)).get(id));
}

async function accountOf(adAccountId: string, token: string): Promise<AdAccountState> {
    try {
        return await fetchAccountState(adAccountId, token);
    } catch (err) {
        throw metaRefusal(err);
    }
}

async function month(adAccountId: string, token: string, account: AdAccountState, excludeId: string, now: Date) {
    try {
        return await readMonth(adAccountId, token, account.currency, account.timezoneOffsetHours, excludeId, now);
    } catch (err) {
        throw new AdsError(502, 'META_ERROR', err instanceof Error ? err.message : String(err));
    }
}

/** The boost row follows Meta's status only while it is a live boost: a completed or failed one keeps its history. */
async function followBoost(boost: AdBoostRow | null, status: 'active' | 'paused'): Promise<void> {
    if (boost && (boost.status === 'active' || boost.status === 'paused')) await updateBoost(boost.id, { status });
}

/**
 * Pause or resume a campaign. Resuming is the step that spends, so it needs a payment method (unless Meta did not say), the worst case
 * to fit under the cap, and a daily budget within the max. A boost that has never run is activated through `activateBoost`, which also
 * moves its window to start now.
 */
export async function setCampaignStatus(creatorId: string, rawId: unknown, status: unknown, now = new Date()): Promise<CampaignView> {
    if (status !== 'ACTIVE' && status !== 'PAUSED') throw new AdsError(400, 'INVALID', 'The status is ACTIVE or PAUSED.', 'status');
    const id = campaignId(rawId);
    const { settings, token } = await requireConfig(creatorId);
    const account = await accountOf(settings.adAccountId, token);
    const campaign = await ownCampaign(settings.adAccountId, id, token);
    const boost = await boostFor(creatorId, id);

    if (status === 'PAUSED') {
        if (boost && (boost.status === 'active' || (boost.status === 'paused' && boost.activated_at))) await pauseBoost(creatorId, boost.id);
        else {
            try {
                await updateObject(id, { status: 'PAUSED' }, token, 'pause campaign');
            } catch (err) {
                throw metaRefusal(err);
            }
            await followBoost(boost, 'paused');
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
        const budget = campaignBudget(campaign, account.currency);
        if (budget.kind === 'daily' && budget.amount !== null && Math.round(budget.amount * 100) > Math.round(settings.maxDailyBudget * 100)) {
            throw new AdsError(400, 'BUDGET_OVER_DAILY_MAX', `Its daily budget ${budget.amount} is over your max daily budget of ${settings.maxDailyBudget}. Lower it first.`);
        }
        const m = await month(settings.adAccountId, token, account, id, now);
        const mine = remainingThisMonth(campaign, account.currency, lifetimeSpend(campaign), now, account.timezoneOffsetHours);
        const check = checkWorstCase({ spentThisMonth: m.spentThisMonth, othersRemaining: m.othersRemaining, thisRemaining: mine, monthlyCap: settings.monthlyCap });
        if (!check.ok) {
            throw new AdsError(400, 'BUDGET_OVER_MONTHLY_CAP',
                `Switching this on could bring this month to ${check.worstCase}, over your monthly cap of ${settings.monthlyCap}. Lower its budget, pause another campaign, or raise the cap.`);
        }
        try {
            await updateObject(id, { status: 'ACTIVE' }, token, 'resume campaign');
        } catch (err) {
            throw metaRefusal(err);
        }
    });
    await followBoost(boost, 'active');
    log('info', 'ads.campaign_resumed', { creator_id: creatorId, campaign_id: id });
    return viewOf(creatorId, id, token, account.currency);
}

export interface BudgetInput {
    amount?: unknown;
    endTime?: unknown;
    /** Required to RAISE an active campaign's budget: that spends more, so the screen asks first. */
    confirm?: unknown;
}

/**
 * Change a campaign's budget (daily amount, or lifetime total) and optionally its end. Only where the budget has one home (the campaign,
 * or its single ad set); the end date is written on the single ad set (a campaign's `stop_time` is derived from its ad sets). A daily
 * budget, or a boost's total spread over its days, is held to the max daily budget; raising an active campaign needs `confirm` and the
 * new worst case under the cap.
 */
export async function setCampaignBudget(creatorId: string, rawId: unknown, body: BudgetInput, now = new Date()): Promise<CampaignView> {
    const id = campaignId(rawId);
    const amount = body.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.round(amount * 100) <= 0) throw new AdsError(400, 'INVALID', 'Enter an amount above 0.', 'amount');
    let end: Date | null = null;
    if (body.endTime !== undefined && body.endTime !== null && body.endTime !== '') {
        const t = typeof body.endTime === 'string' ? Date.parse(body.endTime) : NaN;
        if (Number.isNaN(t) || t <= now.getTime() + 3_600_000) throw new AdsError(400, 'INVALID', 'The end must be a date at least an hour from now.', 'endTime');
        end = new Date(t);
    }
    const { settings, token } = await requireConfig(creatorId);
    const account = await accountOf(settings.adAccountId, token);
    const campaign = await ownCampaign(settings.adAccountId, id, token);
    const budget = campaignBudget(campaign, account.currency);
    if (!budget.editable || !budget.holderId) {
        throw new AdsError(409, 'BUDGET_NOT_EDITABLE', 'This campaign has a budget on each of several ad sets: change them in Ads Manager.');
    }
    if (end && !budget.adsetId) {
        throw new AdsError(409, 'BUDGET_NOT_EDITABLE', 'This campaign has several ad sets, each with its own end date: change them in Ads Manager.', 'endTime');
    }
    const value = roundMoney(amount);
    const boost = await boostFor(creatorId, id);
    if (budget.kind === 'daily' && Math.round(value * 100) > Math.round(settings.maxDailyBudget * 100)) {
        throw new AdsError(400, 'BUDGET_OVER_DAILY_MAX', `The daily budget ${value} is over your max daily budget of ${settings.maxDailyBudget}.`, 'amount');
    }
    if (budget.kind === 'lifetime' && boost && Math.round((value / boost.days) * 100) > Math.round(settings.maxDailyBudget * 100)) {
        throw new AdsError(400, 'BUDGET_OVER_DAILY_MAX', `${value} over ${boost.days} day(s) is more than your max daily budget of ${settings.maxDailyBudget} a day.`, 'amount');
    }
    const spent = lifetimeSpend(campaign);
    if (budget.kind === 'lifetime' && value <= spent) {
        throw new AdsError(400, 'INVALID', `This campaign has already spent ${spent}: the total must be more than that.`, 'amount');
    }
    const raising = budget.amount !== null && Math.round(value * 100) > Math.round(budget.amount * 100);
    if (isActive(campaign) && raising && body.confirm !== true) {
        throw new AdsError(400, 'INVALID', 'Raising a running campaign\'s budget spends more: confirm it.', 'confirm');
    }

    await withTransaction(async (tx) => {
        await lockTenantBoosts(tx, creatorId);
        const field = budget.kind === 'daily' ? 'daily_budget' : 'lifetime_budget';
        const minorValue = String(toMinorUnits(value, account.currency));
        // The campaign as it would be after the edit, for the cap.
        const sets = campaign.adsets?.data ?? [];
        const after: RawCampaign = {
            ...campaign,
            ...(budget.level === 'campaign' ? { [field]: minorValue } : {}),
            adsets: { data: sets.map((s) => (s.id === budget.adsetId ? { ...s, ...(budget.level === 'adset' ? { [field]: minorValue } : {}), ...(end ? { end_time: end.toISOString() } : {}) } : s)) },
        };

        if (boost && boost.status !== 'active' && !boost.activated_at) {
            // A boost that has not run is a reservation (adBoosts.ts): the new total must fit like a new boost would.
            const committed = await committedThisMonth(tx, creatorId, boost.id, now);
            const total = budget.kind === 'lifetime' ? value : roundMoney(value * boost.days);
            if (Math.round((committed + total) * 100) > Math.round(settings.monthlyCap * 100)) {
                throw new AdsError(400, 'BUDGET_OVER_MONTHLY_CAP', `This boost could spend ${total}, but only ${Math.max(0, roundMoney(settings.monthlyCap - committed))} of your monthly cap is left.`, 'amount');
            }
        } else if (isActive(campaign)) {
            const m = await month(settings.adAccountId, token, account, id, now);
            const check = checkWorstCase({
                spentThisMonth: m.spentThisMonth, othersRemaining: m.othersRemaining,
                thisRemaining: remainingThisMonth(after, account.currency, spent, now, account.timezoneOffsetHours), monthlyCap: settings.monthlyCap,
            });
            if (!check.ok) {
                throw new AdsError(400, 'BUDGET_OVER_MONTHLY_CAP', `This budget could bring this month to ${check.worstCase}, over your monthly cap of ${settings.monthlyCap}.`, 'amount');
            }
        }

        try {
            await updateObject(budget.holderId!, { [field]: minorValue }, token, 'budget');
            if (end) await updateObject(budget.adsetId!, { end_time: graphTime(end) }, token, 'end date');
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
    log('info', 'ads.campaign_budget', { creator_id: creatorId, campaign_id: id, kind: budget.kind, level: budget.level, raised: raising });
    return viewOf(creatorId, id, token, account.currency);
}

/** Delete a campaign at Meta (its ad sets and ads go with it). Never while it is on: pause first. */
export async function deleteCampaign(creatorId: string, rawId: unknown): Promise<{ ok: true }> {
    const id = campaignId(rawId);
    const { settings, token } = await requireConfig(creatorId);
    const campaign = await ownCampaign(settings.adAccountId, id, token);
    if (isActive(campaign)) throw new AdsError(409, 'CAMPAIGN_ACTIVE', 'Pause the campaign before deleting it.');
    const boost = await boostFor(creatorId, id);
    if (boost && boost.status !== 'active' && boost.status !== 'creating') {
        await deleteBoost(creatorId, boost.id);
    } else {
        try {
            await deleteAdObject(id, token);
        } catch (err) {
            throw metaRefusal(err);
        }
        if (boost) await updateBoost(boost.id, { status: 'deleted' });
    }
    log('info', 'ads.campaign_deleted', { creator_id: creatorId, campaign_id: id, boost: Boolean(boost) });
    return { ok: true };
}

// ─── The guard ────────────────────────────────────────────────────────────────────────────

/** How often each tenant's account is checked against its cap. */
export const CAP_CHECK_INTERVAL_MS = 60 * 60_000;

/** Tenants with ads settings saved: the `ads.settings.<tenant>` rows. */
async function tenantsWithAds(): Promise<string[]> {
    const rows = await queryRows<{ key: string }>("SELECT key FROM app_settings WHERE key LIKE 'ads.settings.%'");
    return rows.map((r) => r.key.slice(TENANT_SETTING_PREFIXES.adsSettings.length)).filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id));
}

/**
 * THE cap after switch-on. For every tenant with ads configured, at most once an hour: if the month's spend has reached the monthly cap,
 * or one more day of every active campaign's budget would carry it past, every active campaign in the account is PAUSED (pausing spends
 * nothing and is undone with one tap on the Ads screen). Campaigns made in Ads Manager are paused too: the cap is the owner's ceiling for
 * the account, wherever a campaign came from. Fail-soft per tenant; a Meta that cannot be read pauses nothing and is retried next hour.
 */
export async function enforceMonthlyCaps(now = new Date()): Promise<{ checked: number; paused: number; failed: number }> {
    const out = { checked: 0, paused: 0, failed: 0 };
    for (const creatorId of await tenantsWithAds()) {
        const checkedKey = tenantSettingKey(TENANT_SETTING_PREFIXES.adsCapChecked, creatorId);
        const last = Date.parse((await getSetting(checkedKey)) ?? '');
        if (!Number.isNaN(last) && now.getTime() - last < CAP_CHECK_INTERVAL_MS) continue;
        await setSetting(checkedKey, now.toISOString(), null);

        const { settings, token } = await readAdsSettings(creatorId);
        if (!token || !settings.adAccountId || !settings.monthlyCap) continue;
        out.checked++;
        try {
            const account = await fetchAccountState(settings.adAccountId, token);
            const [spent, campaigns] = await Promise.all([readSpend(settings.adAccountId, 'this_month', token), readCampaigns(settings.adAccountId, token)]);
            if (spent === null) throw new Error('this month\'s spend unreadable');
            const active = campaigns.filter(isActive);
            const nextDay = nextDayRemaining(active, account, now);
            if (!shouldPauseAll({ spentThisMonth: spent, nextDayRemaining: nextDay, monthlyCap: settings.monthlyCap })) continue;
            const boosts = await boostsByCampaign(creatorId);
            for (const c of active) {
                await updateObject(c.id, { status: 'PAUSED' }, token, 'cap pause');
                const b = boosts.get(c.id);
                if (b) await queryOne("UPDATE ad_boosts SET status = 'paused', error = $2, updated_at = NOW() WHERE id = $1 AND status = 'active' RETURNING id",
                    [b.id, 'Paused automatically: this month reached your monthly spending cap.']);
                out.paused++;
            }
            log('warn', 'ads.cap_paused_all', { creator_id: creatorId, spent, next_day: nextDay, cap: settings.monthlyCap, paused: active.length });
        } catch (err) {
            out.failed++;
            log('warn', 'ads.cap_check_failed', { creator_id: creatorId, ...describeError(err) });
        }
    }
    return out;
}

/** One more day of the active campaigns (`oneDayRemaining` each). */
export function nextDayRemaining(active: readonly RawCampaign[], account: Pick<AdAccountState, 'currency'>, now: Date): number {
    return roundMoney(active.reduce((sum, c) => sum + oneDayRemaining(c, account.currency, lifetimeSpend(c), now), 0));
}
