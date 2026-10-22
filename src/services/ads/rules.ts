/**
 * Ads rules, the evaluator (research R14, FR-054…FR-056, FLOWS.md §7.7). Called from the drain; each enabled, approved rule is
 * evaluated about once an hour (`rulesStore.dueRules`).
 *
 * For one tenant, one pass:
 *   1. the account: configured, token alive. If not, every due rule records a `blind` run (and nothing else happens).
 *   2. per rule, in order pause → lower → notify → raise/resume (`rulePriority`), so a protective action claims an object first:
 *      a. its objects from the stored copy (`ads_objects`), with "an op is already queued on it" (`busy`);
 *      b. today's rows read again from Meta when older than 2 h, within the pacer's budget. If that is refused (throttled) or fails
 *         and the rows are still stale, the rule does not judge on old numbers: a `blind` run;
 *      c. the window totals from `ads_insights_daily`, then `planRule` (rulesEval.ts);
 *      d. pause / lower budget → ONE op each in `ads_ops` (`actor.via = 'rule'`, idempotency key per rule, object and hour), within
 *         the 4-budget-changes-per-hour accounting; raise / resume → ONE `ads_proposals` row (`rule_raise`) for the whole run;
 *         every object acted on or notified about → one `rule_acted` alert (deduped per object a day by `ads_alerts`);
 *      e. the run row (always), `last_ok_at` on a real evaluation, and `rule_blind` once the rule has gone 24 h without one.
 *
 * Nothing here calls Meta inside a transaction: the refresh goes through the pacer, and the writes go through the queue.
 */
import { describeError, log } from '../../utils/log.js';
import {
    isBlind, isOk, outcomeOf, planRule, RULE_COOLDOWN_MS, STALE_AFTER_MS, windowDays,
    type BlindReason, type MatchedEntry, type PlannedStep, type RuleLevel, type RuleObject, type RuleSpec, type RuleWindow,
    type RuleActedAlert, type RuleBlindAlert, type RunOutcome, type WindowTotals,
} from './rulesEval.js';
import type { RunRecord, StoredRule } from './rulesStore.js';

/** What the evaluator needs to know about the tenant's ad account. */
export type AccountForRules =
    | { ok: true; adAccountId: string; currency: string; offsetHours: number; minDailyBudget: number | null }
    | { ok: false; reason: BlindReason };

/** An object as the stored copy has it, before the window totals are added. */
export type StoredObject = Omit<RuleObject, 'totals'>;

export type RefreshResult = 'ok' | 'throttled' | 'failed';

/** The evaluator's reach into the rest of the ads domain. `rulesWiring.ts` binds it to the stored copy, the queue and the alerts. */
export interface RulesDeps {
    now(): Date;
    account(creatorId: string): Promise<AccountForRules>;
    objects(creatorId: string, level: RuleLevel, ids: string[] | 'all'): Promise<StoredObject[]>;
    /** When today's results were last read from Meta for the tenant (sync.ts `todayAt`); null = never. */
    todaySyncedAt(creatorId: string): Promise<Date | null>;
    /** Read today's results again now, within the pacer's budget (sync.ts `syncInsights(…, 'today')`). */
    refreshToday(creatorId: string): Promise<RefreshResult>;
    totals(creatorId: string, level: RuleLevel, metaIds: string[], from: string, to: string): Promise<Map<string, WindowTotals>>;
    editsLeftThisHour(creatorId: string, adsetMetaIds: string[]): Promise<Map<string, number>>;
    enqueue(creatorId: string, rule: StoredRule, step: Extract<PlannedStep, { kind: 'op' }>, object: StoredObject, hourKey: string): Promise<{ id: string }>;
    propose(creatorId: string, rule: StoredRule, entries: MatchedEntry[], currency: string): Promise<{ id: string }>;
    alert(creatorId: string, alert: RuleActedAlert | RuleBlindAlert, objectKey: string): Promise<void>;
}

/** The persistence the evaluator writes through (rulesStore.ts in production, a fake in tests). */
export interface RulesStore {
    recordRun(creatorId: string, ruleId: string, run: RunRecord, ok: boolean): Promise<void>;
    recentlyActed(creatorId: string, ruleId: string, since: Date): Promise<Set<string>>;
}

/** Pause first, then lower, then notify-only, then the rules that only propose: one action per object per evaluation. */
export function rulePriority(r: Pick<RuleSpec, 'actions'>): number {
    const t = new Set(r.actions.map((a) => a.type));
    if (t.has('pause')) return 0;
    if (t.has('lower_budget')) return 1;
    if (t.has('raise_budget') || t.has('resume')) return 3;
    return 2;
}

/** The hour an op belongs to, for its idempotency key: a retried drain in the same hour cannot enqueue the same change twice. */
export const hourKey = (d: Date): string => d.toISOString().slice(0, 13);

const metricWindows = (spec: RuleSpec): RuleWindow[] =>
    [...new Set(spec.conditions.filter((c) => c.metric !== 'rejected').map((c) => c.window))];

export interface TenantPassResult { rules: number; outcomes: Partial<Record<RunOutcome, number>>; ops: number; proposals: number }

/** Evaluate these (due) rules of one tenant. Never throws: a failing rule records a `blind` run with reason `error`. */
export async function evaluateTenantRules(creatorId: string, rules: StoredRule[], deps: RulesDeps, store: RulesStore): Promise<TenantPassResult> {
    const result: TenantPassResult = { rules: 0, outcomes: {}, ops: 0, proposals: 0 };
    const now = deps.now();
    const ordered = [...rules].sort((a, b) => rulePriority(a) - rulePriority(b));

    let account: AccountForRules;
    try {
        account = await deps.account(creatorId);
    } catch (err) {
        log('error', 'ads.rules_account_failed', { creatorId, ...describeError(err) });
        account = { ok: false, reason: 'error' };
    }

    const taken = new Set<string>();
    const editsLeft = new Map<string, number>();
    let fresh: 'fresh' | BlindReason | null = null;

    for (const rule of ordered) {
        result.rules++;
        let run: RunRecord;
        try {
            run = account.ok
                ? await evaluateRule(creatorId, rule, account, deps, store, { now, taken, editsLeft, fresh: async () => (fresh ??= await freshness(creatorId, deps, now)) })
                : { outcome: 'blind', matched: { reason: account.reason }, ops: [], proposalId: null, at: now };
        } catch (err) {
            log('error', 'ads.rule_eval_failed', { creatorId, ruleId: rule.id, ...describeError(err) });
            run = { outcome: 'blind', matched: { reason: 'error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) }, ops: [], proposalId: null, at: now };
        }

        const ok = isOk(run.outcome);
        try {
            await store.recordRun(creatorId, rule.id, run, ok);
        } catch (err) {
            log('error', 'ads.rule_run_record_failed', { creatorId, ruleId: rule.id, ...describeError(err) });
        }
        result.outcomes[run.outcome] = (result.outcomes[run.outcome] ?? 0) + 1;
        result.ops += run.ops.length;
        if (run.proposalId) result.proposals++;

        if (!ok && isBlind(rule, now)) {
            const reason = Array.isArray(run.matched) ? 'no_data' : run.matched.reason;
            const since = rule.lastOkAt ?? rule.approvedAt ?? rule.createdAt;
            await deps.alert(creatorId, {
                kind: 'rule_blind', ruleId: rule.id, ruleName: rule.name, reason, hours: Math.floor((now.getTime() - since.getTime()) / 3_600_000),
            }, `rule:${rule.id}`).catch((err) => log('error', 'ads.rule_blind_alert_failed', { creatorId, ruleId: rule.id, ...describeError(err) }));
        }
    }
    return result;
}

/** Today's rows fresh enough to judge on, or read again; else why not. */
async function freshness(creatorId: string, deps: RulesDeps, now: Date): Promise<'fresh' | BlindReason> {
    const at = await deps.todaySyncedAt(creatorId);
    if (at && now.getTime() - at.getTime() <= STALE_AFTER_MS) return 'fresh';
    const r = await deps.refreshToday(creatorId);
    return r === 'ok' ? 'fresh' : r === 'throttled' ? 'throttled' : 'stale';
}

interface PassState {
    now: Date;
    taken: Set<string>;
    editsLeft: Map<string, number>;
    /** Whether today's rows are fresh (read again if they were not), or why not: asked once per tenant per pass. */
    fresh(): Promise<'fresh' | BlindReason>;
}

async function evaluateRule(
    creatorId: string, rule: StoredRule, account: Extract<AccountForRules, { ok: true }>, deps: RulesDeps, store: RulesStore, pass: PassState,
): Promise<RunRecord> {
    const { now } = pass;
    const level = rule.scope.level;
    const stored = await deps.objects(creatorId, level, rule.scope.objectIds);
    const windows = metricWindows(rule);
    const metaIds = stored.map((o) => o.metaId);
    const totalsBy: Partial<Record<RuleWindow, Map<string, WindowTotals>>> = {};

    if (windows.length > 0 && metaIds.length > 0) {
        // Every window includes today, so today's rows must be fresh before any judgement on numbers.
        const state = await pass.fresh();
        if (state !== 'fresh') return { outcome: 'blind', matched: { reason: state }, ops: [], proposalId: null, at: now };

        for (const w of windows) {
            const { from, to } = windowDays(w, now, account.offsetHours);
            totalsBy[w] = await deps.totals(creatorId, level, metaIds, from, to);
        }
    }

    const objects: RuleObject[] = stored.map((o) => ({
        ...o,
        totals: Object.fromEntries(windows.map((w) => [w, totalsBy[w]?.get(o.metaId) ?? null])),
    }));

    // Budget changes left this hour, read once per ad set per pass.
    if (rule.actions.some((a) => a.type === 'lower_budget')) {
        const missing = [...new Set(objects.map((o) => o.adsetMetaId).filter((id): id is string => id !== null && !pass.editsLeft.has(id)))];
        if (missing.length > 0) for (const [k, v] of await deps.editsLeftThisHour(creatorId, missing)) pass.editsLeft.set(k, v);
    }

    const cooledDown = await store.recentlyActed(creatorId, rule.id, new Date(now.getTime() - RULE_COOLDOWN_MS));
    const plan = planRule(rule, objects, {
        now, offsetHours: account.offsetHours, minDailyBudget: account.minDailyBudget, editsLeft: pass.editsLeft, taken: pass.taken, cooledDown,
    });

    const ops: string[] = [];
    const toPropose: MatchedEntry[] = [];
    const byId = new Map(stored.map((o) => [o.id, o]));

    for (const entry of plan.matched) {
        const object = byId.get(entry.objectId)!;
        for (const step of [...entry.steps]) {
            if (step.kind === 'op') {
                try {
                    ops.push((await deps.enqueue(creatorId, rule, step, object, hourKey(now))).id);
                } catch (err) {
                    // EDIT_LIMIT, RATE_LIMITED and the like: recorded on the entry, tried again at the next evaluation.
                    entry.skipped.push('edit_limit');
                    entry.steps = entry.steps.filter((s) => s !== step);
                    log('warn', 'ads.rule_enqueue_failed', { creatorId, ruleId: rule.id, objectId: entry.objectId, ...describeError(err) });
                }
            } else if (step.kind === 'propose' && !toPropose.includes(entry)) {
                toPropose.push(entry);
            }
        }
    }

    // Raises and resumes: ONE proposal for the whole run, waiting for the owner (owner decision 2026-10-22).
    let proposalId: string | null = null;
    if (toPropose.length > 0) {
        try {
            proposalId = (await deps.propose(creatorId, rule, toPropose, account.currency)).id;
        } catch (err) {
            log('error', 'ads.rule_propose_failed', { creatorId, ruleId: rule.id, ...describeError(err) });
            for (const e of toPropose) e.steps = e.steps.filter((s) => s.kind !== 'propose');
        }
    }

    // One `rule_acted` alert per object that something happened to (changed, proposed or "tell me"); ads_alerts dedupes it per day.
    let notified = 0;
    for (const entry of plan.matched) {
        if (entry.steps.length === 0) continue;
        try {
            await deps.alert(creatorId, {
                kind: 'rule_acted', ruleId: rule.id, ruleName: rule.name, objectName: entry.name, steps: entry.steps, values: entry.values,
                currency: account.currency, proposalId,
            }, `rule:${rule.id}:${entry.objectId}`);
            if (entry.steps.some((s) => s.kind === 'notify')) notified++;
        } catch (err) {
            log('error', 'ads.rule_acted_alert_failed', { creatorId, ruleId: rule.id, ...describeError(err) });
        }
    }

    const outcome = outcomeOf(plan, { ops: ops.length, notified, proposed: proposalId !== null });
    return { outcome, matched: plan.matched, ops, proposalId, at: now };
}

