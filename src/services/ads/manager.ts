/**
 * The Ads screen: the whole ad account from AutoReply (every campaign, also those made in Ads Manager or by other tools), spend
 * today and this month, payment status, and the controls: pause, resume, change a budget or end date, delete. Boosts made from the
 * Posts screen are campaigns here too, and their controls go through `adBoosts.ts` so the boost record stays right.
 *
 * Money rules (the rule itself is src/services/ads/money.ts, one rule for everything):
 *   - switching a campaign on, or raising an active one's budget, needs the owner's confirmation, a payment method on the account (when
 *     Meta says there is none), the worst case this month under the monthly cap, and a daily budget at most the max daily budget;
 *   - the guard (src/services/ads/guard.ts, hourly from the drain) pauses every active campaign in the account once the month's spend
 *     reaches the cap or one more day would carry it past: the cap holds after switch-on too, also for campaigns made elsewhere.
 * A write that spends reads Meta first, then re-checks and records itself under the tenant's lock (`checkAndStartSpend`), then calls Meta:
 * no Graph call runs inside a database transaction, and two at once cannot both fit.
 */
import { log } from '../../utils/log.js';
import { queryOne, queryRows } from '../../db/query.js';
import {
    activateBoost, AdsError, deleteBoost, metaRefusal, pauseBoost, requireConfig, updateBoost, type AdBoostRow,
} from '../adBoosts.js';
import {
    CAMPAIGN_FIELDS, campaignBudget, campaignInsights, checkAndStartSpend, checkDailyMax, isActive,
    lifetimeSpend, moneyFor, readMonth, remainingThisMonth, type CampaignBudget, type MonthPicture,
    type RawCampaign,
} from './money.js';
import { objectKeyFor, refusalOf, runRecorded, writeNow } from './actions.js';
import { enqueue } from './ops.js';
import { MetaApiError } from '../instagram.js';
import {
    fetchAccountState, getNode, graphTime, roundMoney, toMinorUnits, type AdAccountState, type BoostInsights,
} from './metaAds.js';

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

// The Ads screen's Overview now reads the stored copy only (src/services/ads/overview.ts); kept importable from here for one phase.
export { readOverview, type AdsOverview, type OverviewMoney } from './overview.js';

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

/** The live month, read before any lock is taken. */
async function month(adAccountId: string, token: string, account: AdAccountState, excludeId: string, now: Date): Promise<MonthPicture> {
    try {
        return await readMonth(adAccountId, token, account.currency, account.timezoneOffsetHours, excludeId, now);
    } catch (err) {
        throw err instanceof MetaApiError ? metaRefusal(err) : new AdsError(502, 'META_ERROR', err instanceof Error ? err.message : String(err));
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
export async function setCampaignStatus(creatorId: string, rawId: unknown, status: unknown, now = new Date(), actor: { userId: string | null } = { userId: null }): Promise<CampaignView> {
    if (status !== 'ACTIVE' && status !== 'PAUSED') throw new AdsError(400, 'INVALID', 'The status is ACTIVE or PAUSED.', 'status');
    const id = campaignId(rawId);
    const { settings, token } = await requireConfig(creatorId);
    const account = await accountOf(settings.adAccountId, token);
    const campaign = await ownCampaign(settings.adAccountId, id, token);
    const boost = await boostFor(creatorId, id);

    if (status === 'PAUSED') {
        if (boost && (boost.status === 'active' || (boost.status === 'paused' && boost.activated_at))) await pauseBoost(creatorId, boost.id);
        else {
            const op = await writeNow(creatorId, settings.adAccountId, { kind: 'status', metaId: id, params: { status: 'PAUSED' } }, { userId: actor.userId, via: 'owner' });
            if (op.state === 'done') await followBoost(boost, 'paused');
        }
        log('info', 'ads.campaign_paused', { creator_id: creatorId, campaign_id: id });
        return viewOf(creatorId, id, token, account.currency);
    }

    if (account.hasPaymentMethod === false) {
        throw new AdsError(409, 'PAYMENT_METHOD_MISSING', 'This ad account has no payment method, so nothing can run. Add one in Meta (the button on this screen), then try again.');
    }
    if (boost && boost.status === 'paused' && !boost.activated_at) {
        await activateBoost(creatorId, boost.id, now, actor);
        return viewOf(creatorId, id, token, account.currency);
    }

    const budget = campaignBudget(campaign, account.currency);
    if (budget.kind === 'daily' && budget.amount !== null) {
        const daily = checkDailyMax({ kind: 'daily', amount: budget.amount, days: null }, settings.maxDailyBudget);
        if (!daily.ok) throw new AdsError(400, 'OVER_DAILY_MAX', `${daily.message} Lower it first.`);
    }
    const m = await month(settings.adAccountId, token, account, id, now);
    const mine = remainingThisMonth(campaign, account.currency, lifetimeSpend(campaign), now, account.timezoneOffsetHours);
    const key = await objectKeyFor(creatorId, id);
    let opId: string;
    try {
        ({ opId } = await checkAndStartSpend({
            creatorId, adAccountId: settings.adAccountId, objectKey: key, kind: 'status', month: m, candidate: mine, monthlyCap: settings.monthlyCap,
            payload: { to: 'ACTIVE', campaign_id: id }, actor: { userId: actor.userId, via: 'owner' },
            record: async (tx, payload) => (await enqueue({
                creatorId, adAccountId: settings.adAccountId, objectKey: key, kind: 'status', actor: { userId: actor.userId, via: 'owner' },
                idempotencyKey: `${creatorId}:v1:resume:${id}:${Math.floor(now.getTime() / 10_000)}`,
                payload: { ...payload, exec: { method: 'POST', path: id, params: { status: 'ACTIVE' } } },
            }, tx)).id,
        }));
    } catch (err) {
        throw metaRefusal(err);
    }
    const [op] = await runRecorded(creatorId, [opId]);
    const refused = op ? refusalOf(op) : null;
    if (refused) throw refused;
    if (op?.state === 'done') await followBoost(boost, 'active');
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
export async function setCampaignBudget(creatorId: string, rawId: unknown, body: BudgetInput, now = new Date(), actor: { userId: string | null } = { userId: null }): Promise<CampaignView> {
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
    if (budget.kind === 'daily' || (budget.kind === 'lifetime' && boost)) {
        const daily = checkDailyMax(budget.kind === 'daily' ? { kind: 'daily', amount: value, days: null } : { kind: 'lifetime', amount: value, days: boost!.days }, settings.maxDailyBudget);
        if (!daily.ok) throw new AdsError(400, 'OVER_DAILY_MAX', daily.message, 'amount');
    }
    const spent = lifetimeSpend(campaign);
    if (budget.kind === 'lifetime' && value <= spent) {
        throw new AdsError(400, 'INVALID', `This campaign has already spent ${spent}: the total must be more than that.`, 'amount');
    }
    const raising = budget.amount !== null && Math.round(value * 100) > Math.round(budget.amount * 100);
    if (isActive(campaign) && raising && body.confirm !== true) {
        throw new AdsError(400, 'INVALID', 'Raising a running campaign\'s budget spends more: confirm it.', 'confirm');
    }

    const field = budget.kind === 'daily' ? 'daily_budget' : 'lifetime_budget';
    const minorValue = String(toMinorUnits(value, account.currency));
    // The campaign as it would be after the edit, for the money rule.
    const sets = campaign.adsets?.data ?? [];
    const after: RawCampaign = {
        ...campaign,
        ...(budget.level === 'campaign' ? { [field]: minorValue } : {}),
        adsets: { data: sets.map((s) => (s.id === budget.adsetId ? { ...s, ...(budget.level === 'adset' ? { [field]: minorValue } : {}), ...(end ? { end_time: end.toISOString() } : {}) } : s)) },
    };

    let opId: string | null = null;
    if (boost && boost.status !== 'active' && !boost.activated_at) {
        // A boost that has not run reserves nothing: its new total must fit what is left, as a new boost's would (Activate checks again).
        const total = budget.kind === 'lifetime' ? value : roundMoney(value * boost.days);
        const money = await moneyFor(creatorId, settings, token, { kind: 'lifetime', amount: total, days: boost.days }, now);
        if (money.reason === 'OVER_MONTHLY_CAP') {
            throw new AdsError(400, 'OVER_MONTHLY_CAP', `This boost could spend ${total}, but only ${money.remaining} of your monthly cap is left.`, 'amount');
        }
    } else if (isActive(campaign) && raising) {
        // A raise on a running campaign: its extra worst case must fit, checked live then under the lock, and recorded before Meta is called.
        const m = await month(settings.adAccountId, token, account, id, now);
        const extra = remainingThisMonth(after, account.currency, spent, now, account.timezoneOffsetHours) - remainingThisMonth(campaign, account.currency, spent, now, account.timezoneOffsetHours);
        try {
            ({ opId } = await checkAndStartSpend({
                creatorId, adAccountId: settings.adAccountId, objectKey: await objectKeyFor(creatorId, budget.holderId!), kind: 'budget', month: { ...m, othersRemaining: roundMoney(m.othersRemaining + remainingThisMonth(campaign, account.currency, spent, now, account.timezoneOffsetHours)) },
                candidate: roundMoney(Math.max(0, extra)), monthlyCap: settings.monthlyCap,
                payload: { campaign_id: id, holder_id: budget.holderId, [field]: minorValue }, actor: { userId: actor.userId, via: 'owner' },
                record: async (tx, payload) => (await enqueue({
                    creatorId, adAccountId: settings.adAccountId, objectKey: await objectKeyFor(creatorId, budget.holderId!), kind: 'budget', actor: { userId: actor.userId, via: 'owner' },
                    idempotencyKey: `${creatorId}:v1:budget:${budget.holderId}:${minorValue}:${Math.floor(now.getTime() / 10_000)}`,
                    payload: { ...payload, adsetMetaId: budget.adsetId ?? budget.holderId!, exec: { method: 'POST', path: budget.holderId!, params: { [field]: minorValue } } },
                }, tx)).id,
            }));
        } catch (err) {
            throw metaRefusal(err);
        }
    }

    // Through the queue (ads/ops.ts): the raise was recorded under the lock above; a cut or a paused campaign's change is a plain op.
    const budgetOp = opId
        ? (await runRecorded(creatorId, [opId]))[0]
        : await writeNow(creatorId, settings.adAccountId, { kind: 'budget', metaId: budget.holderId!, params: { [field]: minorValue }, extraPayload: { adsetMetaId: budget.adsetId ?? budget.holderId! } }, { userId: actor.userId, via: 'owner' });
    const refusedBudget = budgetOp ? refusalOf(budgetOp) : null;
    if (refusedBudget) throw refusedBudget;
    if (end) await writeNow(creatorId, settings.adAccountId, { kind: 'update', metaId: budget.adsetId!, params: { end_time: graphTime(end) } }, { userId: actor.userId, via: 'owner' });
    if (boost) {
        const total = budget.kind === 'lifetime' ? value : roundMoney(value * boost.days);
        await updateBoost(boost.id, {
            planned_total: total,
            daily_budget: budget.kind === 'lifetime' ? roundMoney(value / boost.days) : value,
            ...(end ? { ends_at: end } : {}),
        });
    }
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
        // v1's Delete ends the campaign by ARCHIVING it (tasks T052); a delete at Meta is the Campaigns tab's separate, confirmed action.
        const op = await writeNow(creatorId, settings.adAccountId, { kind: 'archive', metaId: id, params: { status: 'ARCHIVED' } });
        if (boost && op.state === 'done') await updateBoost(boost.id, { status: 'deleted' });
    }
    log('info', 'ads.campaign_deleted', { creator_id: creatorId, campaign_id: id, boost: Boolean(boost) });
    return { ok: true };
}
