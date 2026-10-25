/**
 * Ads rules, wired to the rest of the ads domain (FLOWS.md §11.7): the stored copy (`mirror.ts`), today's results (`sync.ts`), the
 * paced queue (`actions.ts` → `ops.ts`), A7's proposals (`proposals/store.ts`) and the alerts (`notify.ts`). `rules.ts` holds the
 * evaluation; this file only answers its questions and carries out its plan.
 *
 * `evaluateDueRules` is the drain's entry: every enabled, approved rule that has not run for 55 minutes, tenant by tenant, until the
 * deadline. The ops it enqueues are sent by `drainAdsOps` right after it in the same drain (and tried inline at once).
 */
import { pool } from '../../config/db.js';
import { writeAudit } from '../audit.js';
import { describeError, log } from '../../utils/log.js';
import { enqueueWrite } from './actions.js';
import { toMinorUnits } from './money.js';
import { listObjects, resultOf, resultsFor, type ObjectRow } from './mirror.js';
import { notifyAds, type AdsAlertTarget } from './notify.js';
import { editsLeftThisHour, listOps } from './ops.js';
import { insertProposal } from './proposals/store.js';
import type { ReviewItem } from './proposals/types.js';
import { evaluateTenantRules, type AccountForRules, type RulesDeps, type RulesStore, type StoredObject } from './rules.js';
import type { MatchedEntry, RuleLevel, WindowTotals } from './rulesEval.js';
import { dueRules, recentlyActed, recordRun, type StoredRule } from './rulesStore.js';
import { isAdsEnabled, isConfigured, isQueueStopped, readAdsSettings, readAlerts, readHealth } from './settings.js';
import { readSyncState, syncInsights } from './sync.js';

/** The audit actor of everything a rule does on its own. */
export const ADS_RULE_ACTOR_EMAIL = 'ads:rule';

/** How long a refresh of today's results may take inside one evaluation. */
const REFRESH_BUDGET_MS = 20_000;

export const dbRulesStore: RulesStore = { recordRun, recentlyActed };

/** One tenant's deps: the account and the objects' optimisation goals are remembered for the pass. */
export function makeRulesDeps(): RulesDeps {
    let account: Extract<AccountForRules, { ok: true }> & { name: string | null } | null = null;
    const goals = new Map<string, string | null>();
    let busy: { creatorId: string; keys: Set<string> } | null = null;

    const target = (creatorId: string): AdsAlertTarget => ({
        creatorId, adAccountId: account?.adAccountId ?? null, accountName: account?.name ?? null, offsetHours: account?.offsetHours ?? 0,
    });

    return {
        now: () => new Date(),

        async account(creatorId) {
            if (!(await isAdsEnabled(creatorId))) return { ok: false, reason: 'not_configured' };
            const { settings, token } = await readAdsSettings(creatorId);
            if (!isConfigured(settings, token) || !settings.adAccountId) return { ok: false, reason: 'not_configured' };
            const health = await readHealth(creatorId);
            if (isQueueStopped(health)) return { ok: false, reason: 'token_dead' };
            const a = health.account;
            if (!a) return { ok: false, reason: 'not_configured' };
            account = { ok: true, adAccountId: settings.adAccountId, currency: a.currency, offsetHours: a.timezoneOffsetHours, minDailyBudget: a.minDailyBudget, name: a.name };
            return account;
        },

        async objects(creatorId, level, ids) {
            if (!busy || busy.creatorId !== creatorId) {
                busy = { creatorId, keys: new Set((await listOps(creatorId, ['pending', 'running', 'verify'], 500)).map((o) => o.objectKey)) };
            }
            const rows = (await listObjects(creatorId, { level })).filter((r) => r.metaId && r.adAccountId === account?.adAccountId);
            const wanted = ids === 'all' ? rows : rows.filter((r) => ids.includes(r.id));
            // The 4-budget-changes-an-hour rule counts on the ad set: itself, or the (first) ad set under a campaign budget.
            const adsetOf = new Map<string, string>();
            if (level === 'campaign') {
                for (const s of await listObjects(creatorId, { level: 'adset' })) if (s.parentId && s.metaId && !adsetOf.has(s.parentId)) adsetOf.set(s.parentId, s.metaId);
            }
            return wanted.map((r): StoredObject => {
                goals.set(r.metaId!, r.optimizationGoal);
                return toStoredObject(r, level, busy!.keys, adsetOf);
            });
        },

        async todaySyncedAt(creatorId) {
            const at = (await readSyncState(creatorId)).todayAt;
            return at ? new Date(at) : null;
        },

        async refreshToday(creatorId) {
            try {
                const r = await syncInsights(creatorId, 'today', { deadline: Date.now() + REFRESH_BUDGET_MS });
                if (r.complete) return 'ok';
                return r.skipped === 'pacer' || r.skipped === 'throttle' ? 'throttled' : 'failed';
            } catch (err) {
                log('warn', 'ads.rules_refresh_failed', { creator_id: creatorId, ...describeError(err) });
                return 'failed';
            }
        },

        async totals(creatorId, level, metaIds, from, to) {
            const { totals } = await resultsFor(creatorId, level, metaIds, from, to);
            const out = new Map<string, WindowTotals>();
            for (const [metaId, t] of totals) {
                out.set(metaId, {
                    spend: t.spend, impressions: t.impressions, reach: t.reach, linkClicks: t.linkClicks, conversations: t.conversations,
                    results: resultOf(goals.get(metaId) ?? null, t) ?? 0,
                });
            }
            return out;
        },

        editsLeftThisHour: (creatorId, adsetMetaIds) => editsLeftThisHour(creatorId, adsetMetaIds),

        async enqueue(creatorId, rule, step, object, hourKey) {
            if (!account) throw new Error('No ad account for this pass.');
            const ctx = {
                creatorId, actor: { userId: null, via: 'rule' as const }, wait: false,
                // One change per rule, object and hour: a drain that runs twice in the hour finds the op it already made.
                requestId: `r-${rule.id}-${hourKey}`,
            };
            const op = step.action === 'pause'
                ? await enqueueWrite(ctx, account.adAccountId, { objectKey: object.id, kind: 'status', metaId: object.metaId, params: { status: 'PAUSED' } })
                : await enqueueWrite(ctx, account.adAccountId, {
                    objectKey: object.id, kind: 'budget', metaId: object.metaId, params: { daily_budget: toMinorUnits(step.to, account.currency) },
                    extraPayload: { ...(step.adsetMetaId ? { adsetMetaId: step.adsetMetaId } : {}), rule_id: rule.id },
                });
            await writeAudit({ userId: null, email: ADS_RULE_ACTOR_EMAIL }, {
                action: 'ads.rule_acted', targetType: 'ads_rule', targetId: rule.id,
                detail: { op_id: op.id, object_id: object.id, action: step.action, ...(step.action === 'lower_budget' ? { from: step.from, to: step.to } : {}) },
            });
            return { id: op.id };
        },

        async propose(creatorId, rule, entries, currency) {
            const lang = (await readAlerts(creatorId)).lang;
            const row = await insertProposal(pool, {
                creatorId, kind: 'rule_raise', source: 'rule', state: 'open',
                payload: { task: 'review', item: proposalItem(rule, entries, lang) },
                rationale: proposalRationale(rule, entries.length, lang),
                evidence: { ruleId: rule.id, matched: entries.map((e) => ({ objectId: e.objectId, name: e.name, values: e.values })) },
                checks: { policy: [], money: { ok: true, reason: null, note: null }, meta_validate: null },
                effect: { worstCaseDelta: 0, newWorstCase: null, currency },
            });
            await writeAudit({ userId: null, email: ADS_RULE_ACTOR_EMAIL }, {
                action: 'ads.rule_acted', targetType: 'ads_rule', targetId: rule.id, detail: { proposal_id: row.id, objects: entries.map((e) => e.objectId) },
            });
            return { id: row.id };
        },

        async alert(creatorId, a, objectKey) {
            await notifyAds(a, target(creatorId), { objectKey });
        },
    };
}

export function toStoredObject(r: ObjectRow, level: RuleLevel, busyKeys: ReadonlySet<string>, adsetOf: ReadonlyMap<string, string>): StoredObject {
    return {
        id: r.id,
        metaId: r.metaId!,
        level,
        name: r.name ?? r.metaId!,
        status: r.status ?? '',
        effectiveStatus: r.effectiveStatus ?? '',
        budget: { kind: r.budgetKind, amount: r.budgetAmount, editable: level !== 'ad' && r.budgetKind !== 'none' },
        adsetMetaId: level === 'adset' ? r.metaId : level === 'campaign' ? adsetOf.get(r.id) ?? r.metaId : null,
        busy: busyKeys.has(r.id),
    };
}

/** The proposal a rule makes: one review item over every object it matched (A7 applies it with `requestBudget` / `requestStatus`). */
export function proposalItem(rule: StoredRule, entries: MatchedEntry[], lang: 'ar' | 'en'): ReviewItem {
    const raise = rule.actions.find((a) => a.type === 'raise_budget');
    const numbers: Record<string, number> = {};
    for (const e of entries) for (const [k, v] of Object.entries(e.values)) if (typeof v === 'number' && Number.isFinite(v)) numbers[`${e.name} · ${k}`] = Math.round(v * 100) / 100;
    return {
        kind: raise ? 'raise_budget' : 'resume',
        targets: entries.map((e) => e.objectId),
        change: { percent: raise ? raise.percent ?? 0 : 0 },
        evidence: { window: '7d', numbers },
        rationale: proposalRationale(rule, entries.length, lang),
    };
}

export function proposalRationale(rule: Pick<StoredRule, 'name'>, n: number, lang: 'ar' | 'en'): string {
    return lang === 'ar'
        ? `تحققت شروط القاعدة «${rule.name}» على ${n} من العناصر. الزيادة في الإنفاق لا تُنفَّذ إلا بموافقتك، وتبقى ضمن حدودك.`
        : `The rule "${rule.name}" matched ${n} item(s). An increase in spend only happens with your approval, and stays within your caps.`;
}

export interface RulesSweep { tenants: number; rules: number; acted: number; proposed: number; blind: number; stoppedAtDeadline: boolean }

/** The drain's share: due rules, grouped by tenant, until `deadline` (epoch ms). Never throws. */
export async function evaluateDueRules(deadline: number): Promise<RulesSweep> {
    const out: RulesSweep = { tenants: 0, rules: 0, acted: 0, proposed: 0, blind: 0, stoppedAtDeadline: false };
    let due: StoredRule[];
    try {
        due = await dueRules();
    } catch (err) {
        log('error', 'ads.rules_due_failed', describeError(err));
        return out;
    }
    const byTenant = new Map<string, StoredRule[]>();
    for (const r of due) byTenant.set(r.creatorId, [...(byTenant.get(r.creatorId) ?? []), r]);
    for (const [creatorId, rules] of byTenant) {
        if (Date.now() >= deadline) {
            out.stoppedAtDeadline = true;
            break;
        }
        const r = await evaluateTenantRules(creatorId, rules, makeRulesDeps(), dbRulesStore);
        out.tenants++;
        out.rules += r.rules;
        out.acted += r.outcomes.acted ?? 0;
        out.proposed += r.outcomes.proposed ?? 0;
        out.blind += r.outcomes.blind ?? 0;
    }
    return out;
}
