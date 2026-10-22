/**
 * Ads rules, the pure half (research R14, FR-054…FR-056): what a rule is, whether its conditions hold for an object, and what it may do
 * about it. No database, no Meta: `rules.ts` feeds this the stored copy and carries out the plan.
 *
 * The owner's decision (2026-10-22): once he has approved a rule, the PROTECTIVE actions run on their own (pause, lower the budget by a
 * percentage, notify). Anything that can raise spend (raise the budget, resume) never runs on its own: it becomes a proposal he approves
 * each time, and the proposal re-runs the money rule when he does. So the planner only ever emits:
 *   - `op`       pause / lower budget: enqueued as an `ads_ops` row with `actor.via = 'rule'`
 *   - `notify`   an alert, nothing changes at Meta
 *   - `propose`  raise budget / resume: an `ads_proposals` row of kind `rule_raise`
 *
 * Why our own evaluator and not Meta's `adrules_library`: Meta's rules cannot ask for approval, cannot see our monthly cap or our
 * alerts, and its CHANGE_BUDGET would bypass our money rule and the 4-budget-changes-per-hour accounting (research R14).
 */

// ─── The shape of a rule ──────────────────────────────────────────────────────────────────────

export const RULE_METRICS = [
    'spend', 'results', 'cost_per_result', 'cost_per_conversation', 'ctr', 'frequency', 'cpm', 'budget_pace', 'rejected',
] as const;
export type RuleMetric = (typeof RULE_METRICS)[number];

export const RULE_OPS = ['>', '>=', '<', '<='] as const;
export type RuleOp = (typeof RULE_OPS)[number];

export const RULE_WINDOWS = ['today', '3d', '7d'] as const;
export type RuleWindow = (typeof RULE_WINDOWS)[number];

export const RULE_LEVELS = ['campaign', 'adset', 'ad'] as const;
export type RuleLevel = (typeof RULE_LEVELS)[number];

export const RULE_ACTIONS = ['pause', 'lower_budget', 'notify', 'raise_budget', 'resume'] as const;
export type RuleActionType = (typeof RULE_ACTIONS)[number];

/** The actions that never run on their own: they become a proposal (owner decision 2026-10-22). */
export const SPEND_RAISING: ReadonlySet<RuleActionType> = new Set(['raise_budget', 'resume']);

export interface RuleCondition { metric: RuleMetric; op: RuleOp; value: number; window: RuleWindow }
export interface RuleScope { level: RuleLevel; objectIds: string[] | 'all' }
export interface RuleMinData { impressions?: number; spend?: number }
export interface RuleAction { type: RuleActionType; percent?: number }

export interface RuleSpec {
    name: string;
    scope: RuleScope;
    conditions: RuleCondition[];
    minData: RuleMinData;
    actions: RuleAction[];
}

/** Limits on what a saved rule may say. */
export const RULE_LIMITS = {
    nameMax: 80,
    conditionsMax: 5,
    objectIdsMax: 200,
    lowerPercent: { min: 5, max: 90 },
    raisePercent: { min: 5, max: 100 },
} as const;

/** Metrics that read the account's insights; the others read the object itself. */
const STATUS_METRICS: ReadonlySet<RuleMetric> = new Set(['rejected']);

export type ParseResult = { ok: true; spec: RuleSpec } | { ok: false; error: string; field: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate a rule from the dashboard (camelCase, the API shape). Refuses rather than repairs: a rule acts on money unattended, so a
 * half-understood rule is worse than none.
 */
export function parseRuleSpec(body: unknown): ParseResult {
    if (!isObj(body)) return { ok: false, error: 'A rule is an object.', field: 'rule' };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, error: 'Give the rule a name.', field: 'name' };
    if (name.length > RULE_LIMITS.nameMax) return { ok: false, error: `The name is longer than ${RULE_LIMITS.nameMax} characters.`, field: 'name' };

    const s = body.scope;
    if (!isObj(s) || !RULE_LEVELS.includes(s.level as RuleLevel)) return { ok: false, error: 'Choose campaigns, ad sets or ads.', field: 'scope.level' };
    let objectIds: string[] | 'all';
    if (s.objectIds === 'all') objectIds = 'all';
    else if (Array.isArray(s.objectIds) && s.objectIds.length > 0 && s.objectIds.length <= RULE_LIMITS.objectIdsMax
        && s.objectIds.every((id) => typeof id === 'string' && UUID_RE.test(id))) objectIds = [...new Set(s.objectIds as string[])];
    else return { ok: false, error: 'Choose "all" or at least one item.', field: 'scope.objectIds' };
    const scope: RuleScope = { level: s.level as RuleLevel, objectIds };

    if (!Array.isArray(body.conditions) || body.conditions.length === 0) return { ok: false, error: 'Add at least one condition.', field: 'conditions' };
    if (body.conditions.length > RULE_LIMITS.conditionsMax) return { ok: false, error: `At most ${RULE_LIMITS.conditionsMax} conditions.`, field: 'conditions' };
    const conditions: RuleCondition[] = [];
    for (const [i, c] of body.conditions.entries()) {
        const field = `conditions.${i}`;
        if (!isObj(c)) return { ok: false, error: 'A condition is an object.', field };
        if (!RULE_METRICS.includes(c.metric as RuleMetric)) return { ok: false, error: 'Unknown metric.', field: `${field}.metric` };
        if (!RULE_OPS.includes(c.op as RuleOp)) return { ok: false, error: 'Unknown comparison.', field: `${field}.op` };
        if (!finite(c.value) || c.value < 0 || c.value > 1_000_000) return { ok: false, error: 'The value is a number of 0 or more.', field: `${field}.value` };
        const window = c.window === undefined ? 'today' : c.window;
        if (!RULE_WINDOWS.includes(window as RuleWindow)) return { ok: false, error: 'Choose today, 3 days or 7 days.', field: `${field}.window` };
        conditions.push({ metric: c.metric as RuleMetric, op: c.op as RuleOp, value: c.value, window: window as RuleWindow });
    }

    const md = body.minData === undefined || body.minData === null ? {} : body.minData;
    if (!isObj(md)) return { ok: false, error: 'The minimum data is an object.', field: 'minData' };
    const minData: RuleMinData = {};
    for (const k of ['impressions', 'spend'] as const) {
        const v = md[k];
        if (v === undefined || v === null || v === '') continue;
        if (!finite(v) || v < 0) return { ok: false, error: 'The minimum is a number of 0 or more.', field: `minData.${k}` };
        if (v > 0) minData[k] = v;
    }

    if (!Array.isArray(body.actions) || body.actions.length === 0) return { ok: false, error: 'Add at least one action.', field: 'actions' };
    const actions: RuleAction[] = [];
    const seen = new Set<RuleActionType>();
    for (const [i, a] of body.actions.entries()) {
        const field = `actions.${i}`;
        if (!isObj(a) || !RULE_ACTIONS.includes(a.type as RuleActionType)) return { ok: false, error: 'Unknown action.', field };
        const type = a.type as RuleActionType;
        if (seen.has(type)) return { ok: false, error: 'Each action once.', field };
        seen.add(type);
        if (type === 'lower_budget' || type === 'raise_budget') {
            const lim = type === 'lower_budget' ? RULE_LIMITS.lowerPercent : RULE_LIMITS.raisePercent;
            if (!finite(a.percent) || a.percent < lim.min || a.percent > lim.max) {
                return { ok: false, error: `The percentage is between ${lim.min} and ${lim.max}.`, field: `${field}.percent` };
            }
            actions.push({ type, percent: Math.round(a.percent) });
        } else {
            actions.push({ type });
        }
    }
    // Protecting and raising in one rule contradict each other (the same condition cannot mean "spend less" and "spend more").
    const protects = actions.some((a) => a.type === 'pause' || a.type === 'lower_budget');
    const raises = actions.some((a) => SPEND_RAISING.has(a.type));
    if (protects && raises) return { ok: false, error: 'A rule either protects (pause, lower) or raises (raise, resume), not both.', field: 'actions' };
    if (seen.has('raise_budget') && seen.has('resume')) return { ok: false, error: 'Raise or resume, not both.', field: 'actions' };
    if (seen.has('pause') && seen.has('lower_budget')) return { ok: false, error: 'Pause or lower, not both.', field: 'actions' };
    if (conditions.some((c) => c.metric === 'rejected') && (protects || raises)) {
        return { ok: false, error: 'A rejected ad can only be notified about.', field: 'actions' };
    }
    if (conditions.some((c) => c.metric === 'budget_pace') && scope.level === 'ad') {
        return { ok: false, error: 'Ads have no budget of their own: pace is for campaigns and ad sets.', field: 'conditions' };
    }

    return { ok: true, spec: { name, scope, conditions, minData, actions } };
}

/** Whether the rule's actions raise spend (and so only ever propose). */
export function ruleRaises(spec: Pick<RuleSpec, 'actions'>): boolean {
    return spec.actions.some((a) => SPEND_RAISING.has(a.type));
}

// ─── Templates (T167) ──────────────────────────────────────────────────────────────────────────

export interface RuleTemplate { id: string; spec: Omit<RuleSpec, 'name'>; needsValue: boolean }

/**
 * The four templates the Rules tab offers. Names come from the dashboard's i18n (`ads.rules.tpl.<id>`); a value the owner must fill
 * (his currency's "too expensive") is `needsValue`.
 */
export const RULE_TEMPLATES: readonly RuleTemplate[] = [
    {
        id: 'cpc_high_pause',
        needsValue: true,
        spec: {
            scope: { level: 'ad', objectIds: 'all' },
            conditions: [{ metric: 'cost_per_conversation', op: '>', value: 15, window: '3d' }],
            minData: { impressions: 500 },
            actions: [{ type: 'pause' }, { type: 'notify' }],
        },
    },
    {
        id: 'spending_fast_notify',
        needsValue: false,
        spec: {
            scope: { level: 'adset', objectIds: 'all' },
            conditions: [{ metric: 'budget_pace', op: '>', value: 1.5, window: 'today' }],
            minData: {},
            actions: [{ type: 'notify' }],
        },
    },
    {
        id: 'frequency_lower',
        needsValue: false,
        spec: {
            scope: { level: 'adset', objectIds: 'all' },
            conditions: [{ metric: 'frequency', op: '>', value: 3, window: '7d' }],
            minData: { impressions: 1000 },
            actions: [{ type: 'lower_budget', percent: 20 }, { type: 'notify' }],
        },
    },
    {
        id: 'rejected_notify',
        needsValue: false,
        spec: {
            scope: { level: 'ad', objectIds: 'all' },
            conditions: [{ metric: 'rejected', op: '>=', value: 1, window: 'today' }],
            minData: {},
            actions: [{ type: 'notify' }],
        },
    },
];

// ─── Windows and metrics ──────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of `now` in the ad account's time zone (Meta's days are the account's days). */
export function accountDay(now: Date, offsetHours: number, daysBack = 0): string {
    return new Date(now.getTime() + offsetHours * 3_600_000 - daysBack * DAY_MS).toISOString().slice(0, 10);
}

/** The first and last day of a window, both inclusive. `3d` is today and the two days before it, `7d` today and the six before. */
export function windowDays(window: RuleWindow, now: Date, offsetHours: number): { from: string; to: string } {
    const back = window === 'today' ? 0 : window === '3d' ? 2 : 6;
    return { from: accountDay(now, offsetHours, back), to: accountDay(now, offsetHours) };
}

/** The share of the account's day already gone, never below one hour's worth (pace at 00:05 would be meaningless). */
export function dayElapsed(now: Date, offsetHours: number): number {
    const local = now.getTime() + offsetHours * 3_600_000;
    const sinceMidnight = local - Math.floor(local / DAY_MS) * DAY_MS;
    return Math.max(1 / 24, sinceMidnight / DAY_MS);
}

/** Summed results over a window, from the stored copy (`ads_insights_daily`). */
export interface WindowTotals {
    spend: number;
    impressions: number;
    reach: number;
    linkClicks: number;
    conversations: number;
    results: number;
}

/** What the evaluator knows about one object in scope. */
export interface RuleObject {
    id: string;            // ads_objects.id
    metaId: string;
    level: RuleLevel;
    name: string;
    status: string;        // the configured status: ACTIVE | PAUSED | ARCHIVED | DELETED
    effectiveStatus: string;
    budget: { kind: 'daily' | 'lifetime' | 'none'; amount: number | null; editable: boolean };
    /** The ad set whose 4-per-hour budget limit a budget change on this object counts against (itself for an ad set). */
    adsetMetaId: string | null;
    /** An op on this object is pending, running or being verified: the rule leaves it alone this time. */
    busy: boolean;
    totals: Partial<Record<RuleWindow, WindowTotals | null>>;
}

const REJECTED = new Set(['DISAPPROVED', 'WITH_ISSUES']);

/**
 * One metric over one window. `null` = cannot say (no rows, or a ratio over zero).
 * A cost per result with money spent and nothing bought is `Infinity`: "15 a conversation is too much" holds a fortiori when 20 has
 * bought none. `min_data` is what keeps that from firing on the first impressions.
 */
export function metricValue(metric: RuleMetric, window: RuleWindow, o: RuleObject, now: Date, offsetHours: number): number | null {
    if (metric === 'rejected') return REJECTED.has(o.effectiveStatus) ? 1 : 0;
    const t = o.totals[window];
    if (!t) return null;
    const per = (num: number, den: number, k = 1): number | null => (den > 0 ? (num / den) * k : null);
    switch (metric) {
        case 'spend': return t.spend;
        case 'results': return t.results;
        case 'cost_per_result': return t.results > 0 ? t.spend / t.results : t.spend > 0 ? Infinity : null;
        case 'cost_per_conversation': return t.conversations > 0 ? t.spend / t.conversations : t.spend > 0 ? Infinity : null;
        case 'ctr': return per(t.linkClicks, t.impressions, 100);
        case 'frequency': return per(t.impressions, t.reach);
        case 'cpm': return per(t.spend, t.impressions, 1000);
        case 'budget_pace': {
            // Today's spend as a share of today's budget, against the share of the day gone. 1 = on pace; 2 = twice as fast.
            const today = o.totals.today;
            if (!today || o.budget.kind !== 'daily' || !o.budget.amount) return null;
            return today.spend / o.budget.amount / dayElapsed(now, offsetHours);
        }
    }
}

export function compare(v: number, op: RuleOp, target: number): boolean {
    switch (op) {
        case '>': return v > target;
        case '>=': return v >= target;
        case '<': return v < target;
        case '<=': return v <= target;
    }
}

/** Whether the window's totals clear the rule's minimum data. Status metrics need none. */
export function hasMinData(t: WindowTotals | null | undefined, min: RuleMinData): boolean {
    if (!t) return false;
    if (min.impressions !== undefined && t.impressions < min.impressions) return false;
    if (min.spend !== undefined && t.spend < min.spend) return false;
    return true;
}

export type ObjectVerdict =
    | { kind: 'match'; values: Record<string, number | null> }
    | { kind: 'no_match'; values: Record<string, number | null> }
    | { kind: 'no_data'; values: Record<string, number | null> };

/** All conditions must hold (AND). One condition without enough data makes the object `no_data`. */
export function evaluateObject(spec: Pick<RuleSpec, 'conditions' | 'minData'>, o: RuleObject, now: Date, offsetHours: number): ObjectVerdict {
    const values: Record<string, number | null> = {};
    let noData = false;
    let all = true;
    for (const c of spec.conditions) {
        const key = `${c.metric}:${c.window}`;
        const statusOnly = STATUS_METRICS.has(c.metric);
        if (!statusOnly && !hasMinData(o.totals[c.window], spec.minData)) {
            values[key] = null;
            noData = true;
            continue;
        }
        const v = metricValue(c.metric, c.window, o, now, offsetHours);
        values[key] = v === null || Number.isFinite(v) ? v : null;
        if (v === null) { noData = true; continue; }
        if (!compare(v, c.op, c.value)) all = false;
    }
    // A condition that is already false decides it even if another lacks data: "no match" is a real answer.
    if (!all) return { kind: 'no_match', values };
    if (noData) return { kind: 'no_data', values };
    return { kind: 'match', values };
}

/** Which objects a rule watches this time. A resume rule looks at paused objects; every other rule at those delivering. */
export function eligible(spec: Pick<RuleSpec, 'actions' | 'conditions'>, o: RuleObject): boolean {
    if (o.status === 'DELETED' || o.status === 'ARCHIVED') return false;
    if (spec.conditions.some((c) => c.metric === 'rejected')) return true;
    if (spec.actions.some((a) => a.type === 'resume')) return o.status === 'PAUSED';
    return o.status === 'ACTIVE' && o.effectiveStatus === 'ACTIVE';
}

// ─── The plan ─────────────────────────────────────────────────────────────────────────────────

export type PlannedStep =
    | { kind: 'op'; objectId: string; action: 'pause' }
    | { kind: 'op'; objectId: string; action: 'lower_budget'; from: number; to: number; adsetMetaId: string | null }
    | { kind: 'notify'; objectId: string }
    | { kind: 'propose'; objectId: string; action: 'raise_budget'; from: number; to: number }
    | { kind: 'propose'; objectId: string; action: 'resume' };

/** Why a matched object was left alone. Recorded in the run's `matched`. */
export type SkipReason = 'busy' | 'already_paused' | 'no_budget' | 'at_minimum' | 'edit_limit' | 'cooldown' | 'taken';

export interface MatchedEntry {
    objectId: string;
    metaId: string;
    name: string;
    values: Record<string, number | null>;
    steps: PlannedStep[];
    skipped: SkipReason[];
}

export interface PlanContext {
    now: Date;
    offsetHours: number;
    /** Meta's minimum daily budget for the account, in major units. A lowered budget never goes under it. */
    minDailyBudget: number | null;
    /** Budget changes left this hour, by ad set meta id (Meta: 4 per ad set per hour). Absent = unknown = assume 4. Decremented here. */
    editsLeft: Map<string, number>;
    /** Objects that already got a change from an earlier rule in this same evaluation: one action per object per evaluation. */
    taken: Set<string>;
    /** Objects this rule acted on or proposed for within the cooldown, so a 20% cut is not repeated every hour. */
    cooledDown: ReadonlySet<string>;
}

export const RULE_COOLDOWN_MS = 24 * 3_600_000;

export interface RulePlan {
    evaluated: number;
    noData: number;
    matched: MatchedEntry[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Evaluate a rule over its objects and plan what it does. Mutates `ctx.taken` and `ctx.editsLeft` so the next rule in the same
 * evaluation sees what this one claimed.
 */
export function planRule(spec: RuleSpec, objects: readonly RuleObject[], ctx: PlanContext): RulePlan {
    const editsLeft = ctx.editsLeft;
    const plan: RulePlan = { evaluated: 0, noData: 0, matched: [] };
    const effect = spec.actions.find((a) => a.type !== 'notify') ?? null;
    const notify = spec.actions.some((a) => a.type === 'notify');

    for (const o of objects) {
        if (!eligible(spec, o)) continue;
        const v = evaluateObject(spec, o, ctx.now, ctx.offsetHours);
        if (v.kind === 'no_data') { plan.noData++; continue; }
        plan.evaluated++;
        if (v.kind !== 'match') continue;

        const entry: MatchedEntry = { objectId: o.id, metaId: o.metaId, name: o.name, values: v.values, steps: [], skipped: [] };
        if (ctx.cooledDown.has(o.id)) {
            entry.skipped.push('cooldown');
            plan.matched.push(entry);
            continue;
        }

        if (effect) {
            const skip = ((): SkipReason | null => {
                if (ctx.taken.has(o.id)) return 'taken';
                if (o.busy) return 'busy';
                switch (effect.type) {
                    case 'pause':
                        if (o.status === 'PAUSED') return 'already_paused';
                        entry.steps.push({ kind: 'op', objectId: o.id, action: 'pause' });
                        return null;
                    case 'lower_budget': {
                        if (o.budget.kind !== 'daily' || !o.budget.amount || !o.budget.editable) return 'no_budget';
                        const floor = ctx.minDailyBudget ?? 0;
                        const to = Math.max(floor, round2(o.budget.amount * (1 - (effect.percent ?? 0) / 100)));
                        if (to >= o.budget.amount) return 'at_minimum';
                        const adset = o.adsetMetaId;
                        if (adset !== null) {
                            const left = editsLeft.get(adset) ?? 4;
                            if (left <= 0) return 'edit_limit';
                            editsLeft.set(adset, left - 1);
                        }
                        entry.steps.push({ kind: 'op', objectId: o.id, action: 'lower_budget', from: o.budget.amount, to, adsetMetaId: adset });
                        return null;
                    }
                    case 'raise_budget': {
                        if (o.budget.kind !== 'daily' || !o.budget.amount || !o.budget.editable) return 'no_budget';
                        const to = round2(o.budget.amount * (1 + (effect.percent ?? 0) / 100));
                        entry.steps.push({ kind: 'propose', objectId: o.id, action: 'raise_budget', from: o.budget.amount, to });
                        return null;
                    }
                    case 'resume':
                        entry.steps.push({ kind: 'propose', objectId: o.id, action: 'resume' });
                        return null;
                    default:
                        return null;
                }
            })();
            if (skip) entry.skipped.push(skip);
            else ctx.taken.add(o.id);
        }
        if (notify) entry.steps.push({ kind: 'notify', objectId: o.id });
        plan.matched.push(entry);
    }
    return plan;
}

// ─── Outcomes and blindness ───────────────────────────────────────────────────────────────────

export type RunOutcome = 'ok' | 'acted' | 'proposed' | 'skipped_no_data' | 'blind';

/** Why a rule could not evaluate at all. */
export type BlindReason = 'not_configured' | 'token_dead' | 'throttled' | 'stale' | 'error';

/**
 * The run's outcome from what was carried out: an op or an alert sent = `acted`; only a proposal = `proposed`; objects to watch but
 * none with enough data = `skipped_no_data`; otherwise `ok` (nothing in scope, or nothing matched).
 */
export function outcomeOf(plan: RulePlan, done: { ops: number; notified: number; proposed: boolean }): RunOutcome {
    if (done.ops > 0 || done.notified > 0) return 'acted';
    if (done.proposed) return 'proposed';
    if (plan.evaluated === 0 && plan.noData > 0) return 'skipped_no_data';
    return 'ok';
}

/** A run that counts as "watching": the rule looked at real numbers. */
export function isOk(outcome: RunOutcome): boolean {
    return outcome === 'ok' || outcome === 'acted' || outcome === 'proposed';
}

export const BLIND_AFTER_MS = 24 * 3_600_000;

/** The rule has not managed a real evaluation for 24 hours (since it was approved, if it never has). */
export function isBlind(rule: { lastOkAt: Date | null; approvedAt: Date | null; createdAt: Date }, now: Date): boolean {
    const since = rule.lastOkAt ?? rule.approvedAt ?? rule.createdAt;
    return now.getTime() - since.getTime() >= BLIND_AFTER_MS;
}

/** Today's rows older than this are read again from Meta before a rule uses them (R14). */
export const STALE_AFTER_MS = 2 * 3_600_000;
