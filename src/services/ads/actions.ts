/**
 * The owner's actions on stored objects (tasks T052, T054): pause, resume, budget, end date, archive and delete, each one an `ads_ops` row
 * (ops.ts) instead of a direct Graph call. The Campaigns tab's routes (src/routes/adsObjects.ts) and v1's adapters (adsManager.ts,
 * adBoosts.ts) both come through here, so the rules are in one place:
 *
 *   - anything that can start or raise spend needs `confirm`, a payment method (when Meta said there is none), the daily max, and the money
 *     rule: the month is read live OUTSIDE any transaction, then `checkAndStartSpend` re-checks under the tenant's lock and ENQUEUES the op
 *     inside that same transaction (`record`), so a pending op already counts as "about to run" for the next check (money.ts);
 *   - every op carries an idempotency key, so a double press or a replayed request returns the op it already made;
 *   - delete is a separate, confirmed op and never runs on an ACTIVE object; "end it" is archive.
 *
 * `runNow` (the v1 adapters) waits for the inline attempt and reports what happened; the new routes answer with the op at once and let the
 * screen poll `GET /api/ads/ops/:id`.
 */
import type { Exec } from '../studio/common.js';
import { AdsError, metaRefusal } from '../adBoosts.js';
import { CAMPAIGN_FIELDS, checkAndStartSpend, checkDailyMax, isActive, lifetimeSpend, readMonth, remainingThisMonth, type RawCampaign } from './money.js';
import { fromMinorUnits, getNode, graphTime, roundMoney, toMinorUnits } from './metaAds.js';
import { childrenOf, getObject, type ObjectRow } from './mirror.js';
import { AdsObjectNotFoundError, NotOwnObjectError, ownObject as checkOwnObject } from './ownership.js';
import type { GraphParams } from './graph.js';
import { copyParams } from './lifecycle.js';
import { BUDGET_EDITS_PER_HOUR, editsLeftThisHour, enqueue, getOp, runOpInline, type AdsOpKind, type EnqueueInput, type OpActor, type OpPayload, type OpView } from './ops.js';
import { readAdsSettings, readHealth, type AdsSettings } from './settings.js';
import { waitUntil } from '../../utils/waitUntil.js';

export type ConfiguredSettings = AdsSettings & { adAccountId: string; maxDailyBudget: number; monthlyCap: number };

export interface ActionContext {
    creatorId: string;
    actor: OpActor;
    /** A key the client sent with the press (`requestId`), so a retried request maps to the same op. Else a 10 s bucket. */
    requestId?: string | null;
    /** true: wait for the inline attempt (v1 adapters). false: hand it to `waitUntil` and answer with the queued op. */
    wait?: boolean;
    now?: Date;
}

async function configured(creatorId: string): Promise<{ settings: ConfiguredSettings; token: string }> {
    const { settings, token } = await readAdsSettings(creatorId);
    if (!token || !settings.adAccountId || !settings.maxDailyBudget || !settings.monthlyCap) {
        throw new AdsError(409, 'ADS_NOT_CONFIGURED', 'Set the ad account, the ads token, the max daily budget and the monthly cap in Settings first.');
    }
    return { settings: settings as ConfiguredSettings, token };
}

/**
 * The stored object the request names (our uuid or Meta's id), only when it is the tenant's AND in the tenant's current ad account: a request
 * cannot reach into another tenant's rows, nor into an account the tenant has switched away from. The one place routes resolve `:id`.
 */
export async function ownObject(creatorId: string, adAccountId: string | null, id: unknown): Promise<ObjectRow> {
    if (typeof id !== 'string' || !/^[0-9a-zA-Z-]{5,40}$/.test(id)) throw new AdsError(404, 'NOT_FOUND', 'No such object.');
    const row = await getObject(creatorId, id);
    if (row && adAccountId && row.adAccountId === adAccountId) return row;
    // Not this tenant's object in its current account. The A11 check (ads/ownership.ts) says whose it is: another tenant's, or one from an
    // account this tenant left, is NOT_OWN_OBJECT, logged and audited; an id nobody has is NOT_FOUND.
    try {
        await checkOwnObject(creatorId, adAccountId, id);
    } catch (err) {
        if (err instanceof NotOwnObjectError) throw new AdsError(403, 'NOT_OWN_OBJECT', err.message);
        if (!(err instanceof AdsObjectNotFoundError)) throw err;
    }
    throw new AdsError(404, 'NOT_FOUND', 'No such object in your ad account.');
}

function idempotencyKey(ctx: ActionContext, what: string, now: Date): string {
    const press = ctx.requestId && /^[A-Za-z0-9_-]{8,80}$/.test(ctx.requestId) ? ctx.requestId : `t${Math.floor(now.getTime() / 10_000)}`;
    return `${ctx.creatorId}:${what}:${press}`;
}

/** Run the op inline: awaited for the v1 adapters, handed to `waitUntil` otherwise. Returns the op as it now stands. */
async function kick(ctx: ActionContext, op: OpView): Promise<OpView> {
    if (op.state !== 'pending') return op;
    if (ctx.wait) {
        await runOpInline(op.id, { creatorId: ctx.creatorId });
        return (await getOp(ctx.creatorId, op.id)) ?? op;
    }
    waitUntil(runOpInline(op.id, { creatorId: ctx.creatorId }));
    return op;
}

/** An op that ended `failed` as the error the screen shows (v1 adapters only; the queue view shows it on the badge). */
export function refusalOf(op: OpView): AdsError | null {
    if (op.state !== 'failed') return null;
    const r = (op.result ?? {}) as { code?: unknown; message?: unknown; retryAt?: unknown; subcode?: unknown };
    const message = typeof r.message === 'string' ? r.message : 'Meta refused the change.';
    const retryAt = typeof r.retryAt === 'string' ? new Date(r.retryAt) : null;
    if (r.code === 'EDIT_LIMIT') return new AdsError(429, 'EDIT_LIMIT', message, undefined, undefined, { retryAt });
    if (r.code === 'TOKEN_INVALID') return new AdsError(409, 'TOKEN_INVALID', 'Meta no longer accepts the ads token: generate a new one and paste it in Settings.', 'token');
    return new AdsError(502, 'META_ERROR', message, undefined, typeof r.code === 'number' ? r.code : undefined, { metaSubcode: typeof r.subcode === 'number' ? r.subcode : undefined });
}

interface PlainWrite {
    objectKey: string;
    kind: AdsOpKind;
    metaId: string;
    params?: GraphParams;
    method?: 'POST' | 'DELETE';
    extraPayload?: OpPayload;
}

/** A write that cannot raise spend (pause, archive, delete, a lower budget, an end date): enqueued as it is. */
export async function enqueueWrite(ctx: ActionContext, adAccountId: string, w: PlainWrite, exec?: Exec): Promise<OpView> {
    const now = ctx.now ?? new Date();
    const input: EnqueueInput = {
        creatorId: ctx.creatorId, adAccountId, objectKey: w.objectKey, kind: w.kind, actor: ctx.actor,
        idempotencyKey: idempotencyKey(ctx, `${w.kind}:${w.objectKey}:${JSON.stringify(w.params ?? {})}`, now),
        payload: { exec: { method: w.method ?? 'POST', path: w.metaId, ...(w.params ? { params: w.params } : {}) }, ...(w.extraPayload ?? {}) },
    };
    const op = await enqueue(input, exec);
    return exec ? op : kick(ctx, op);
}

// ─── The campaign an object spends through ────────────────────────────────────────────────────

/** The campaign row above (or at) an object. */
async function campaignOf(creatorId: string, row: ObjectRow): Promise<ObjectRow | null> {
    let cur: ObjectRow | null = row;
    for (let i = 0; cur && cur.level !== 'campaign' && i < 3; i++) cur = cur.parentId ? await getObject(creatorId, cur.parentId) : null;
    return cur && cur.level === 'campaign' ? cur : null;
}

/** The campaign as Meta has it now (1 point): the money rule needs its live budgets and lifetime spend. Its account must be ours. */
async function liveCampaign(adAccountId: string, metaId: string, token: string): Promise<RawCampaign> {
    let c: RawCampaign & { account_id?: string };
    try {
        c = await getNode(metaId, { fields: `${CAMPAIGN_FIELDS},account_id` }, token, 'campaign');
    } catch (err) {
        throw metaRefusal(err);
    }
    if (typeof c?.id !== 'string' || String(c.account_id ?? '') !== adAccountId) throw new AdsError(404, 'NOT_FOUND', 'No such campaign in your ad account.');
    return c;
}

/** Every budget under the campaign switched on: what it can spend if this activation goes through (the conservative candidate). */
function allOn(c: RawCampaign): RawCampaign {
    return { ...c, status: 'ACTIVE', effective_status: 'ACTIVE', adsets: c.adsets?.data ? { data: c.adsets.data.map((s) => ({ ...s, status: 'ACTIVE' })) } : c.adsets };
}

async function paymentCheck(creatorId: string): Promise<{ currency: string | null; offsetHours: number; tz: string | null }> {
    const health = await readHealth(creatorId);
    if (health.account?.hasPaymentMethod === false) {
        throw new AdsError(409, 'PAYMENT_METHOD_MISSING', 'This ad account has no payment method, so nothing can run. Add one in Meta (the button on the Overview), then try again.');
    }
    return { currency: health.account?.currency ?? null, offsetHours: health.account?.timezoneOffsetHours ?? 0, tz: health.account?.timezone ?? null };
}

// ─── Status ───────────────────────────────────────────────────────────────────────────────────

/**
 * Pause or switch on. Switching on spends: `confirm`, the payment method, the daily max of a daily budget and the money rule. A campaign is
 * the switch for everything under it, so the candidate is the campaign's whole remaining this month, with its ad sets all on.
 */
export async function requestStatus(ctx: ActionContext, row: ObjectRow, status: unknown, confirm: unknown): Promise<OpView> {
    if (status !== 'ACTIVE' && status !== 'PAUSED') throw new AdsError(400, 'INVALID', 'The status is ACTIVE or PAUSED.', 'status');
    if (row.level === 'creative' || !row.metaId) throw new AdsError(409, 'INVALID', 'This object cannot be switched on or off.');
    if (row.status === 'ARCHIVED' || row.status === 'DELETED') throw new AdsError(409, 'INVALID', 'This object has ended; make a new one instead.');
    const { settings, token } = await configured(ctx.creatorId);
    if (status === 'PAUSED') {
        return enqueueWrite(ctx, settings.adAccountId, { objectKey: row.id, kind: 'status', metaId: row.metaId, params: { status: 'PAUSED' } });
    }
    if (confirm !== true) throw new AdsError(400, 'INVALID', 'Switching this on spends money: confirm it.', 'confirm');
    const acct = await paymentCheck(ctx.creatorId);
    const campaign = await campaignOf(ctx.creatorId, row);
    if (!campaign?.metaId) throw new AdsError(409, 'INVALID', 'The campaign above this is not in the stored copy yet; refresh and try again.');
    const now = ctx.now ?? new Date();
    const live = await liveCampaign(settings.adAccountId, campaign.metaId, token);
    const currency = acct.currency ?? row.currency;
    for (const holder of [live, ...(live.adsets?.data ?? [])]) {
        const minor = Number(holder.daily_budget ?? 0);
        if (minor > 0) {
            const daily = checkDailyMax({ kind: 'daily', amount: fromMinorUnits(minor, currency), days: null }, settings.maxDailyBudget);
            if (!daily.ok) throw new AdsError(400, 'OVER_DAILY_MAX', `${daily.message} Lower it first.`);
        }
    }
    let month;
    try {
        month = await readMonth(settings.adAccountId, token, currency, acct.offsetHours, campaign.metaId, now);
    } catch (err) {
        throw metaRefusal(err);
    }
    // Switching on something under a campaign that is already running adds no more than the campaign's own remaining, which the month
    // already counts as "others" unless we left it out: we did (excludeCampaignId), so the candidate is always the whole campaign, all on.
    const candidate = remainingThisMonth(allOn(live), currency, lifetimeSpend(live), now, acct.offsetHours);
    const key = idempotencyKey(ctx, `status:${row.id}:ACTIVE`, now);
    let opId: string;
    try {
        ({ opId } = await checkAndStartSpend({
            creatorId: ctx.creatorId, adAccountId: settings.adAccountId, objectKey: row.id, kind: 'status', month, candidate, monthlyCap: settings.monthlyCap,
            payload: { to: 'ACTIVE', campaign_id: campaign.metaId }, actor: { userId: ctx.actor.userId, via: ctx.actor.via },
            record: async (tx, payload) => (await enqueue({
                creatorId: ctx.creatorId, adAccountId: settings.adAccountId, objectKey: row.id, kind: 'status', actor: ctx.actor, idempotencyKey: key,
                payload: { ...payload, exec: { method: 'POST', path: row.metaId!, params: { status: 'ACTIVE' } } },
            }, tx)).id,
        }));
    } catch (err) {
        throw metaRefusal(err);
    }
    const op = await getOp(ctx.creatorId, opId);
    if (!op) throw new AdsError(500, 'META_ERROR', 'The change was not recorded; try again.');
    return kick(ctx, op);
}

// ─── Budget and end date ────────────────────────────────────────────────────────────────────────

export interface BudgetBody {
    kind?: unknown;
    amount?: unknown;
    endTime?: unknown;
    confirm?: unknown;
}

/**
 * A new daily or lifetime amount on the object that holds the budget (a campaign or an ad set), and optionally the ad set's end. The 4 an
 * hour limit is Meta's: refused up front with `EDIT_LIMIT` when the hour is used up (the queue would only hold it). A raise on a running
 * object needs `confirm` and the money rule; a cut never does.
 */
export async function requestBudget(ctx: ActionContext, row: ObjectRow, body: BudgetBody): Promise<{ op: OpView; endOp: OpView | null }> {
    const now = ctx.now ?? new Date();
    if (!row.metaId || (row.level !== 'campaign' && row.level !== 'adset')) throw new AdsError(409, 'BUDGET_NOT_EDITABLE', 'Only a campaign or an ad set has a budget.');
    if (row.budgetKind === 'none') throw new AdsError(409, 'BUDGET_NOT_EDITABLE', 'The budget of this campaign is on its ad sets: change it there.');
    if (body.kind !== undefined && body.kind !== row.budgetKind) throw new AdsError(400, 'INVALID', `This budget is ${row.budgetKind}; Meta cannot switch it to the other kind.`, 'kind');
    const amount = body.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.round(amount * 100) <= 0) throw new AdsError(400, 'INVALID', 'Enter an amount above 0.', 'amount');
    let end: Date | null = null;
    if (body.endTime !== undefined && body.endTime !== null && body.endTime !== '') {
        const t = typeof body.endTime === 'string' ? Date.parse(body.endTime) : NaN;
        if (Number.isNaN(t) || t <= now.getTime() + 3_600_000) throw new AdsError(400, 'INVALID', 'The end must be a date at least an hour from now.', 'endTime');
        if (row.level !== 'adset') throw new AdsError(400, 'INVALID', 'The end date is set on an ad set.', 'endTime');
        end = new Date(t);
    }
    const { settings, token } = await configured(ctx.creatorId);
    const value = roundMoney(amount);
    const days = row.budgetKind === 'lifetime' && row.startTime && (end ?? (row.endTime ? new Date(row.endTime) : null))
        ? Math.max(1, Math.ceil(((end ?? new Date(row.endTime!)).getTime() - Date.parse(row.startTime)) / 86_400_000))
        : null;
    if (row.budgetKind === 'daily' || days) {
        const daily = checkDailyMax(row.budgetKind === 'daily' ? { kind: 'daily', amount: value, days: null } : { kind: 'lifetime', amount: value, days }, settings.maxDailyBudget);
        if (!daily.ok) throw new AdsError(400, 'OVER_DAILY_MAX', daily.message, 'amount');
    }
    // The 4-an-hour rule counts on the ad set: the object itself, or the single ad set under a campaign budget.
    const adsetMetaId = row.level === 'adset' ? row.metaId : (await childrenOf(ctx.creatorId, row.id)).find((c) => c.level === 'adset')?.metaId ?? row.metaId;
    const left = (await editsLeftThisHour(ctx.creatorId, [adsetMetaId], now)).get(adsetMetaId) ?? BUDGET_EDITS_PER_HOUR;
    if (left <= 0) throw new AdsError(429, 'EDIT_LIMIT', 'Meta allows 4 budget changes an hour on an ad set; this one has used them.', 'amount', undefined, { retryAt: new Date(now.getTime() + 3_600_000) });

    const field = row.budgetKind === 'daily' ? 'daily_budget' : 'lifetime_budget';
    const minorValue = toMinorUnits(value, row.currency);
    // An unknown stored amount counts as a raise: fail closed, so the confirm and the money rule run.
    const raising = row.budgetAmount === null || Math.round(value * 100) > Math.round(row.budgetAmount * 100);
    const running = row.effectiveStatus === 'ACTIVE' || row.status === 'ACTIVE';
    const exec = { method: 'POST' as const, path: row.metaId, params: { [field]: minorValue } };
    let op: OpView;
    if (running && raising) {
        if (body.confirm !== true) throw new AdsError(400, 'INVALID', 'Raising a running budget spends more: confirm it.', 'confirm');
        const acct = await paymentCheck(ctx.creatorId);
        const campaign = await campaignOf(ctx.creatorId, row);
        if (!campaign?.metaId) throw new AdsError(409, 'INVALID', 'The campaign above this is not in the stored copy yet; refresh and try again.');
        const live = await liveCampaign(settings.adAccountId, campaign.metaId, token);
        const currency = acct.currency ?? row.currency;
        const spent = lifetimeSpend(live);
        const after: RawCampaign = row.level === 'campaign'
            ? { ...live, [field]: String(minorValue) }
            : { ...live, adsets: { data: (live.adsets?.data ?? []).map((s) => (s.id === row.metaId ? { ...s, [field]: String(minorValue) } : s)) } };
        const extra = roundMoney(Math.max(0, remainingThisMonth(after, currency, spent, now, acct.offsetHours) - (isActive(live) ? remainingThisMonth(live, currency, spent, now, acct.offsetHours) : 0)));
        let month;
        try {
            month = await readMonth(settings.adAccountId, token, currency, acct.offsetHours, campaign.metaId, now);
        } catch (err) {
            throw metaRefusal(err);
        }
        const key = idempotencyKey(ctx, `budget:${row.id}:${minorValue}`, now);
        let opId: string;
        try {
            ({ opId } = await checkAndStartSpend({
                creatorId: ctx.creatorId, adAccountId: settings.adAccountId, objectKey: row.id, kind: 'budget', candidate: extra, monthlyCap: settings.monthlyCap,
                month: { ...month, othersRemaining: roundMoney(month.othersRemaining + (isActive(live) ? remainingThisMonth(live, currency, spent, now, acct.offsetHours) : 0)) },
                payload: { campaign_id: campaign.metaId, adsetMetaId, tz: acct.tz ?? undefined }, actor: { userId: ctx.actor.userId, via: ctx.actor.via },
                record: async (tx, payload) => (await enqueue({
                    creatorId: ctx.creatorId, adAccountId: settings.adAccountId, objectKey: row.id, kind: 'budget', actor: ctx.actor, idempotencyKey: key,
                    payload: { ...payload, exec },
                }, tx)).id,
            }));
        } catch (err) {
            throw metaRefusal(err);
        }
        op = (await getOp(ctx.creatorId, opId))!;
        op = await kick(ctx, op);
    } else {
        op = await enqueueWrite(ctx, settings.adAccountId, { objectKey: row.id, kind: 'budget', metaId: row.metaId, params: { [field]: minorValue }, extraPayload: { adsetMetaId } });
    }
    const endOp = end
        ? await enqueueWrite(ctx, settings.adAccountId, { objectKey: row.id, kind: 'update', metaId: row.metaId, params: { end_time: graphTime(end) } })
        : null;
    return { op, endOp };
}

// ─── Archive and delete ─────────────────────────────────────────────────────────────────────────

/** "End it": the object stops and its results stay. Meta archives everything under it with it. */
export async function requestArchive(ctx: ActionContext, row: ObjectRow): Promise<OpView> {
    if (!row.metaId || row.level === 'creative') throw new AdsError(409, 'INVALID', 'This object cannot be archived.');
    if (row.status === 'ARCHIVED' || row.status === 'DELETED') throw new AdsError(409, 'INVALID', 'This object has already ended.');
    const { settings } = await configured(ctx.creatorId);
    return enqueueWrite(ctx, settings.adAccountId, { objectKey: row.id, kind: 'archive', metaId: row.metaId, params: { status: 'ARCHIVED' } });
}

/** Delete at Meta: a separate, confirmed action, never on a running object (pause or archive first). */
export async function requestDelete(ctx: ActionContext, row: ObjectRow, confirm: unknown): Promise<OpView> {
    if (confirm !== true) throw new AdsError(400, 'INVALID', 'Deleting cannot be undone: confirm it.', 'confirm');
    if (!row.metaId || row.level === 'creative') throw new AdsError(409, 'INVALID', 'This object cannot be deleted from here.');
    if (row.status === 'ACTIVE' || row.effectiveStatus === 'ACTIVE') throw new AdsError(409, 'CAMPAIGN_ACTIVE', 'Pause it before deleting it.');
    if (row.status === 'DELETED') throw new AdsError(409, 'INVALID', 'This object is already deleted.');
    const { settings } = await configured(ctx.creatorId);
    return enqueueWrite(ctx, settings.adAccountId, { objectKey: row.id, kind: 'delete', metaId: row.metaId, method: 'DELETE' });
}

/**
 * Duplicate a campaign, ad set or ad (`POST /{id}/copies`, A5): the copy is ALWAYS created PAUSED, with ` · copy AR·<key>` added to every
 * name in it, and it re-enters Meta's review and learning. Not a spend: nothing runs until it is switched on like any other object. The
 * sync brings the copy into the stored copy; the op's result names its id. `deep` copies everything under it too.
 */
export async function requestDuplicate(ctx: ActionContext, row: ObjectRow, deep: unknown): Promise<OpView> {
    if (!row.metaId || row.level === 'creative') throw new AdsError(409, 'INVALID', 'This object cannot be duplicated.');
    if (row.status === 'DELETED') throw new AdsError(409, 'INVALID', 'A deleted object cannot be duplicated.');
    const { settings } = await configured(ctx.creatorId);
    const now = ctx.now ?? new Date();
    // The key in the name is the press's own, so a retried press is one copy (the op's idempotency key) with one recognisable name.
    const key = idempotencyKey(ctx, `copy:${row.id}`, now).replace(/[^A-Za-z0-9]/g, '').slice(-12);
    return enqueueWrite(ctx, settings.adAccountId, {
        objectKey: row.id, kind: 'update', metaId: `${row.metaId}/copies`,
        params: copyParams(key, row.level === 'ad' ? false : deep !== false) as GraphParams,
    });
}

// ─── v1 adapters (Boost and the old campaign routes): the same ops, waited for ────────────────────────────────────────────────────

/** The queue key for a Meta id: the stored row's uuid when the sync has it, else the Meta id itself (still one key per object). */
export async function objectKeyFor(creatorId: string, metaId: string): Promise<string> {
    return (await getObject(creatorId, metaId))?.id ?? metaId;
}

/**
 * A v1 write through the queue, waited for: done or still queued returns the op (a queued one is sent by the drain; v1's answer shape does
 * not change), a failed one throws the error v1 threw. Pacing, the per-object limits and the audit row now apply to v1 too.
 */
export async function writeNow(creatorId: string, adAccountId: string, w: Omit<PlainWrite, 'objectKey'> & { objectKey?: string }, actor: OpActor = { userId: null, via: 'owner' }): Promise<OpView> {
    const objectKey = w.objectKey ?? await objectKeyFor(creatorId, w.metaId);
    const op = await enqueueWrite({ creatorId, actor, wait: true }, adAccountId, { ...w, objectKey });
    const refused = refusalOf(op);
    if (refused) throw refused;
    return op;
}

/** Run ops recorded inside a caller's transaction (they were invisible until it committed), in order, waiting for each. */
export async function runRecorded(creatorId: string, opIds: string[]): Promise<OpView[]> {
    const out: OpView[] = [];
    for (const id of opIds) {
        await runOpInline(id, { creatorId });
        const op = await getOp(creatorId, id);
        if (!op) continue;
        out.push(op);
        if (op.state !== 'done') break;
    }
    return out;
}
