/**
 * The Overview tab (`GET /api/ads/overview`, tasks T055) from the STORED copy only: no Meta call (research R2, FR-015, SC-005). v1 read the
 * account, spend twice and every campaign live on each view, about 4 points of the Limited tier's 60 per 5 minutes; a few refreshes could
 * lock the account out of the API, the cap guard included.
 *
 *   account      the last health check's snapshot (ads/health.ts, daily and on Settings' "Test connection")
 *   spend        today and this month from `ads_insights_daily`, in the ad account's days (ads/sync.ts: today every 4 h, 28 days daily)
 *   money        the money rule over the stored copy: spent + what every ACTIVE campaign can still spend this month + what is about to run.
 *                The month's spend can lag Meta by up to a few hours, so this is the picture, not the gate: every switch-on and raise
 *                re-reads the month live and re-checks under the lock (ads/actions.ts).
 *   attention    what needs the owner: rejected ads, ads with issues, billing, changes that failed in the last day
 *   queued       changes not sent yet (pending, sending, checking), with the object's name
 */
import type { AccountSnapshot } from './settings.js';
import { readAdsSettings, readHealth, setupSteps, tokenView, type SetupStep } from './settings.js';
import { guardState } from './health.js';
import { aboutToRun, checkCandidate, isActive, remainingThisMonth, roundMoney, toMinorUnits, type RawCampaign } from './money.js';
import { listObjects, lastSyncedAt, resultsFor, reviewReasons, spendFromMirror, type ObjectRow } from './mirror.js';
import { listOps, type OpView } from './ops.js';
import { dayInTz } from './sync.js';

export interface AttentionItem {
    kind: 'rejected' | 'issues' | 'billing' | 'op_failed';
    objectId: string | null;
    title: string;
    detail: string | null;
    at: string | null;
    /** The Help Center section that explains it (`ads#<section>`). */
    helpSection: string;
}

export interface OverviewMoney {
    currency: string;
    spentToday: number | null;
    spentThisMonth: number | null;
    worstCaseThisMonth: number | null;
    monthlyCap: number;
    remaining: number | null;
    maxDailyBudget: number;
    monthBoundaryTz: string;
    excludesTax: true;
}

export type AdsOverview =
    | { configured: false; steps: SetupStep[]; money: null; helpUrl: string }
    | {
        configured: true;
        steps: SetupStep[];
        tokenHealth: string;
        guard: { lastCheckedAt: string | null; blind: boolean };
        helpUrl: string;
        account: AccountSnapshot | null;
        accountError: string | null;
        spend: { today: number | null; thisMonth: number | null };
        limits: { maxDailyBudget: number; monthlyCap: number; worstCaseThisMonth: number | null };
        money: OverviewMoney | null;
        counts: { campaigns: number; active: number; attention: number };
        attention: AttentionItem[];
        queued: Array<OpView & { objectName: string | null }>;
        /** When the stored copy was last refreshed (the structure); null before the first sync. */
        syncedAt: string | null;
        /** The first day whose results Meta may still revise (the last 3 days are provisional). */
        provisionalFrom: string | null;
    };

/** A stored campaign as the money rule reads Meta's: budgets in minor units, ad sets under it, its spend as the lifetime insight. */
export function rawFromMirror(c: ObjectRow, adsets: ObjectRow[], spent: number): RawCampaign {
    const holder = (r: ObjectRow) => ({
        id: r.metaId ?? r.id,
        status: r.status ?? undefined,
        ...(r.budgetKind === 'daily' && r.budgetAmount !== null ? { daily_budget: String(toMinorUnits(r.budgetAmount, r.currency)) } : {}),
        ...(r.budgetKind === 'lifetime' && r.budgetAmount !== null ? { lifetime_budget: String(toMinorUnits(r.budgetAmount, r.currency)) } : {}),
        ...(r.startTime ? { start_time: r.startTime } : {}),
        ...(r.endTime ? { end_time: r.endTime } : {}),
    });
    return {
        ...holder(c),
        id: c.metaId ?? c.id,
        objective: c.objective ?? undefined,
        effective_status: c.effectiveStatus ?? undefined,
        adsets: { data: adsets.map(holder) },
        insights: { data: [{ spend: String(spent) }] },
    };
}

function monthStart(today: string): string {
    return `${today.slice(0, 8)}01`;
}

const ATTENTION_STATUSES: Record<string, AttentionItem['kind']> = { DISAPPROVED: 'rejected', WITH_ISSUES: 'issues', PENDING_BILLING_INFO: 'billing' };

export async function readOverview(creatorId: string, now = new Date()): Promise<AdsOverview> {
    const { settings, token } = await readAdsSettings(creatorId);
    const health = await readHealth(creatorId);
    const steps = setupSteps(settings, Boolean(token), health);
    if (!token || !settings.adAccountId || !settings.maxDailyBudget || !settings.monthlyCap) {
        return { configured: false, steps, money: null, helpUrl: '#/help/ads' };
    }
    const adAccountId = settings.adAccountId;
    const account = health.account;
    const tz = account?.timezone ?? 'UTC';
    const today = dayInTz(now, tz);
    const [guard, objects, ops, syncedAt, spend] = await Promise.all([
        guardState(creatorId, now),
        listObjects(creatorId),
        listOps(creatorId, ['pending', 'running', 'verify', 'failed'], 200),
        lastSyncedAt(creatorId),
        spendFromMirror(creatorId, adAccountId, today, monthStart(today)),
    ]);
    const mine = objects.filter((o) => o.adAccountId === adAccountId);
    const campaigns = mine.filter((o) => o.level === 'campaign');
    const byId = new Map(mine.map((o) => [o.id, o]));
    const hasResults = spend.syncedAt !== null;

    // The money rule over the stored copy (see the header).
    let money: OverviewMoney | null = null;
    const currency = account?.currency ?? campaigns[0]?.currency ?? null;
    if (currency) {
        const active = campaigns.filter((c) => isActive({ status: c.status ?? undefined }) && c.metaId);
        const spentBy = active.length
            ? (await resultsFor(creatorId, 'campaign', active.map((c) => c.metaId!), '2000-01-01', today)).totals
            : new Map();
        const othersRemaining = roundMoney(active.reduce((sum, c) => {
            const adsets = mine.filter((o) => o.level === 'adset' && o.parentId === c.id);
            const spent = spentBy.get(c.metaId!)?.spend ?? 0;
            return sum + remainingThisMonth(rawFromMirror(c, adsets, spent), currency, spent, now, account?.timezoneOffsetHours ?? 0);
        }, 0));
        const readAt = spend.syncedAt ? new Date(spend.syncedAt) : now;
        const check = hasResults
            ? checkCandidate({ spentThisMonth: spend.spentThisMonth, othersRemaining, aboutToRun: await aboutToRun(null, creatorId, readAt, null), candidate: 0, monthlyCap: settings.monthlyCap })
            : null;
        money = {
            currency,
            spentToday: hasResults ? spend.spentToday : null,
            spentThisMonth: hasResults ? spend.spentThisMonth : null,
            worstCaseThisMonth: check?.worstCase ?? null,
            monthlyCap: settings.monthlyCap,
            remaining: check?.remaining ?? null,
            maxDailyBudget: settings.maxDailyBudget,
            monthBoundaryTz: account?.timezone ?? 'UTC',
            excludesTax: true,
        };
    }

    const attention: AttentionItem[] = [];
    for (const o of mine) {
        const kind = o.effectiveStatus ? ATTENTION_STATUSES[o.effectiveStatus] : undefined;
        if (!kind) continue;
        attention.push({
            kind, objectId: o.id, title: o.name ?? o.metaId ?? '', detail: reviewReasons(o.review)[0] ?? null, at: o.syncedAt,
            helpSection: kind === 'billing' ? 'account-health' : 'statuses',
        });
    }
    const dayAgo = now.getTime() - 86_400_000;
    for (const op of ops) {
        if (op.state !== 'failed' || !op.finishedAt || Date.parse(op.finishedAt) < dayAgo) continue;
        const target = byId.get(op.objectKey);
        const r = (op.result ?? {}) as { message?: unknown };
        attention.push({
            kind: 'op_failed', objectId: target?.id ?? null, title: target?.name ?? op.objectKey, detail: typeof r.message === 'string' ? r.message.slice(0, 300) : null,
            at: op.finishedAt, helpSection: 'queued-changes',
        });
    }

    const provisional = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
    return {
        configured: true,
        steps,
        tokenHealth: tokenView(settings, token, health, now).health,
        guard,
        helpUrl: '#/help/ads',
        account,
        accountError: health.accountError,
        spend: { today: money?.spentToday ?? null, thisMonth: money?.spentThisMonth ?? null },
        limits: { maxDailyBudget: settings.maxDailyBudget, monthlyCap: settings.monthlyCap, worstCaseThisMonth: money?.worstCaseThisMonth ?? null },
        money,
        counts: { campaigns: campaigns.length, active: campaigns.filter((c) => c.status === 'ACTIVE').length, attention: attention.length },
        attention,
        queued: ops.filter((op) => op.state !== 'failed').map((op) => ({ ...op, objectName: byId.get(op.objectKey)?.name ?? null })),
        syncedAt,
        provisionalFrom: hasResults ? provisional : null,
    };
}
