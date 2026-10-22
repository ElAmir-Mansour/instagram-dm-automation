/**
 * Ads rules (A9, T163): the evaluator and the planner, driven through fake deps and a fake store.
 *
 * Pinned:
 *   - conditions over spend, results, cost per result, cost per conversation, CTR, frequency and CPM on today / 3 days / 7 days, with a
 *     minimum-data threshold; all conditions must hold;
 *   - protective actions (pause, lower budget) are ops, within the 4-budget-changes-an-hour limit, never under Meta's minimum;
 *   - raise_budget and resume NEVER enqueue an op: they make one proposal (`rule_raise`) per run;
 *   - one action per object per evaluation, across rules; a 24 h cooldown per rule and object;
 *   - a run row for every outcome (ok, acted, proposed, skipped_no_data, blind) and `last_ok_at` only on a real evaluation;
 *   - `rule_blind` after 24 h without one; stale results are refreshed first, and a refused refresh is `blind`, never a guess.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    dayElapsed, evaluateObject, isBlind, metricValue, parseRuleSpec, planRule, RULE_TEMPLATES, windowDays,
    type PlannedStep, type RuleActedAlert, type RuleBlindAlert, type RuleObject, type RuleSpec, type WindowTotals,
} from './rulesEval.js';
import { evaluateTenantRules, rulePriority, type AccountForRules, type RefreshResult, type RulesDeps, type RulesStore, type StoredObject } from './rules.js';
import type { RunRecord, StoredRule } from './rulesStore.js';

const NOW = new Date('2026-10-22T12:00:00Z'); // 15:00 in Riyadh (UTC+3)
const C = '11111111-1111-4111-8111-111111111111';
const A1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const A3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

const totals = (p: Partial<WindowTotals> = {}): WindowTotals => ({ spend: 0, impressions: 0, reach: null, linkClicks: 0, conversations: 0, results: 0, ...p });

const obj = (p: Partial<RuleObject> & { id: string }): RuleObject => ({
    metaId: `m-${p.id.slice(-1)}`, level: 'ad', name: `Ad ${p.id.slice(-1)}`, status: 'ACTIVE', effectiveStatus: 'ACTIVE',
    budget: { kind: 'none', amount: null, editable: false }, adsetMetaId: null, busy: false, totals: {}, ...p,
});

const spec = (p: Partial<RuleSpec> = {}): RuleSpec => ({
    name: 'r', scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'cost_per_conversation', op: '>', value: 15, window: '3d' }],
    minData: { impressions: 500 }, actions: [{ type: 'pause' }], ...p,
});

const ctx = (p: Partial<Parameters<typeof planRule>[2]> = {}): Parameters<typeof planRule>[2] => ({
    now: NOW, offsetHours: 3, minDailyBudget: 1, editsLeft: new Map(), taken: new Set(), cooledDown: new Set(), ...p,
});

// ─── Validation ────────────────────────────────────────────────────────────────────────────────

describe('parseRuleSpec', () => {
    it('accepts every template once a name is added', () => {
        for (const t of RULE_TEMPLATES) {
            const r = parseRuleSpec({ name: t.id, ...t.spec });
            assert.equal(r.ok, true, `${t.id}: ${r.ok ? '' : r.error}`);
        }
    });

    it('refuses protecting and raising in one rule, pause with lower, raise with resume', () => {
        const base = { name: 'x', scope: { level: 'adset', objectIds: 'all' }, conditions: [{ metric: 'spend', op: '>', value: 1, window: 'today' }] };
        for (const actions of [[{ type: 'pause' }, { type: 'resume' }], [{ type: 'pause' }, { type: 'lower_budget', percent: 20 }], [{ type: 'raise_budget', percent: 10 }, { type: 'resume' }]]) {
            const r = parseRuleSpec({ ...base, actions });
            assert.equal(r.ok, false, JSON.stringify(actions));
        }
    });

    it('bounds the percentages and the condition count', () => {
        const base = { name: 'x', scope: { level: 'adset', objectIds: 'all' }, conditions: [{ metric: 'spend', op: '>', value: 1, window: 'today' }] };
        assert.equal(parseRuleSpec({ ...base, actions: [{ type: 'lower_budget', percent: 95 }] }).ok, false);
        assert.equal(parseRuleSpec({ ...base, actions: [{ type: 'lower_budget', percent: 4 }] }).ok, false);
        assert.equal(parseRuleSpec({ ...base, actions: [{ type: 'raise_budget', percent: 101 }] }).ok, false);
        assert.equal(parseRuleSpec({ ...base, actions: [{ type: 'raise_budget', percent: 100 }] }).ok, true);
        const six = Array.from({ length: 6 }, () => base.conditions[0]);
        assert.equal(parseRuleSpec({ ...base, conditions: six, actions: [{ type: 'notify' }] }).ok, false);
    });

    it('a rejected ad only notifies; pace is not for ads; frequency is today on campaigns or ads', () => {
        const r1 = parseRuleSpec({ name: 'x', scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'rejected', op: '>=', value: 1 }], actions: [{ type: 'pause' }] });
        assert.deepEqual(r1.ok ? null : r1.field, 'actions');
        assert.equal(parseRuleSpec({ name: 'x', scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'budget_pace', op: '>', value: 1.5, window: 'today' }], actions: [{ type: 'notify' }] }).ok, false);
        assert.equal(parseRuleSpec({ name: 'x', scope: { level: 'adset', objectIds: 'all' }, conditions: [{ metric: 'frequency', op: '>', value: 3, window: 'today' }], actions: [{ type: 'notify' }] }).ok, false);
        assert.equal(parseRuleSpec({ name: 'x', scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'frequency', op: '>', value: 3, window: '7d' }], actions: [{ type: 'notify' }] }).ok, false);
    });

    it('names the field it refuses', () => {
        const r = parseRuleSpec({ name: 'x', scope: { level: 'ad', objectIds: ['not-a-uuid'] }, conditions: [], actions: [] });
        assert.deepEqual(r.ok ? null : r.field, 'scope.objectIds');
        const r2 = parseRuleSpec({ name: 'x', scope: { level: 'ad', objectIds: 'all' }, conditions: [{ metric: 'roas', op: '>', value: 1, window: 'today' }], actions: [{ type: 'notify' }] });
        assert.deepEqual(r2.ok ? null : r2.field, 'conditions.0.metric');
    });
});

// ─── Metrics and windows ────────────────────────────────────────────────────────────────────────

describe('metrics over windows', () => {
    const o = obj({
        id: A1, budget: { kind: 'daily', amount: 20, editable: true },
        totals: {
            today: totals({ spend: 10, impressions: 2000, reach: 500, linkClicks: 40, conversations: 2, results: 2 }),
            '3d': totals({ spend: 45, impressions: 9000, linkClicks: 90, conversations: 3, results: 3 }),
        },
    });

    it('computes each metric from the window totals', () => {
        assert.equal(metricValue('spend', 'today', o, NOW, 3), 10);
        assert.equal(metricValue('results', '3d', o, NOW, 3), 3);
        assert.equal(metricValue('cost_per_result', '3d', o, NOW, 3), 15);
        assert.equal(metricValue('cost_per_conversation', 'today', o, NOW, 3), 5);
        assert.equal(metricValue('ctr', 'today', o, NOW, 3), 2);
        assert.equal(metricValue('cpm', '3d', o, NOW, 3), 5);
        assert.equal(metricValue('frequency', 'today', o, NOW, 3), 4);
    });

    it('frequency has no value without a reach (several days)', () => {
        assert.equal(metricValue('frequency', '3d', o, NOW, 3), null);
    });

    it('money spent and nothing bought is an infinite cost; nothing spent is no value', () => {
        assert.equal(metricValue('cost_per_conversation', 'today', obj({ id: A2, totals: { today: totals({ spend: 20, impressions: 900 }) } }), NOW, 3), Infinity);
        assert.equal(metricValue('cost_per_conversation', 'today', obj({ id: A2, totals: { today: totals() } }), NOW, 3), null);
    });

    it('pace is today\'s share of the daily budget against the share of the account\'s day gone', () => {
        // 15:00 in UTC+3 = 62.5% of the day; 10 of 20 spent = 50% → 0.8.
        assert.equal(Math.round(dayElapsed(NOW, 3) * 1000) / 1000, 0.625);
        assert.equal(metricValue('budget_pace', 'today', o, NOW, 3), 0.5 / 0.625);
    });

    it('windows are account days, inclusive of today', () => {
        assert.deepEqual(windowDays('today', NOW, 3), { from: '2026-10-22', to: '2026-10-22' });
        assert.deepEqual(windowDays('3d', NOW, 3), { from: '2026-10-20', to: '2026-10-22' });
        assert.deepEqual(windowDays('7d', new Date('2026-10-22T22:30:00Z'), 3), { from: '2026-10-17', to: '2026-10-23' });
    });

    it('min_data gates every metric condition; all conditions must hold', () => {
        const s = spec({ conditions: [{ metric: 'cost_per_conversation', op: '>', value: 10, window: '3d' }, { metric: 'ctr', op: '<', value: 1, window: '3d' }], minData: { impressions: 500 } });
        const thin = obj({ id: A1, totals: { '3d': totals({ spend: 30, impressions: 100 }) } });
        assert.equal(evaluateObject(s, thin, NOW, 3).kind, 'no_data');
        const both = obj({ id: A1, totals: { '3d': totals({ spend: 30, impressions: 1000, conversations: 2, linkClicks: 5 }) } });
        assert.equal(evaluateObject(s, both, NOW, 3).kind, 'match');
        const one = obj({ id: A1, totals: { '3d': totals({ spend: 30, impressions: 1000, conversations: 2, linkClicks: 50 }) } });
        assert.equal(evaluateObject(s, one, NOW, 3).kind, 'no_match');
    });
});

// ─── The plan ───────────────────────────────────────────────────────────────────────────────────

const expensive = (id: string, p: Partial<RuleObject> = {}): RuleObject =>
    obj({ id, totals: { '3d': totals({ spend: 40, impressions: 1200, conversations: 1 }) }, ...p });

describe('planRule', () => {
    it('pauses a matching active ad, and only active ones', () => {
        const plan = planRule(spec(), [expensive(A1), expensive(A2, { status: 'PAUSED', effectiveStatus: 'PAUSED' })], ctx());
        assert.equal(plan.matched.length, 1);
        assert.deepEqual(plan.matched[0]!.steps, [{ kind: 'op', objectId: A1, action: 'pause' }]);
    });

    it('lowers a daily budget by the percentage, never under Meta\'s minimum, within 4 changes an hour per ad set', () => {
        const s = spec({ scope: { level: 'adset', objectIds: 'all' }, actions: [{ type: 'lower_budget', percent: 20 }] });
        const set = (id: string, amount: number) => expensive(id, { level: 'adset', budget: { kind: 'daily', amount, editable: true }, adsetMetaId: `set-${id.slice(-1)}` });
        const c = ctx({ minDailyBudget: 9, editsLeft: new Map([['set-3', 0]]) });
        const plan = planRule(s, [set(A1, 50), set(A2, 10), set(A3, 50)], c);
        const steps = Object.fromEntries(plan.matched.map((m) => [m.objectId, m.steps[0] ?? m.skipped[0]]));
        assert.deepEqual(steps[A1], { kind: 'op', objectId: A1, action: 'lower_budget', from: 50, to: 40, adsetMetaId: 'set-1' });
        assert.deepEqual(steps[A2], { kind: 'op', objectId: A2, action: 'lower_budget', from: 10, to: 9, adsetMetaId: 'set-2' });
        assert.equal(steps[A3], 'edit_limit');
        assert.equal(c.editsLeft.get('set-1'), 3);
        const floor = planRule(s, [set(A1, 9)], ctx({ minDailyBudget: 9 }));
        assert.deepEqual(floor.matched[0]!.skipped, ['at_minimum']);
    });

    it('raise_budget and resume only ever propose', () => {
        const raise = spec({ conditions: [{ metric: 'cost_per_conversation', op: '<', value: 5, window: '3d' }], scope: { level: 'adset', objectIds: 'all' }, actions: [{ type: 'raise_budget', percent: 20 }] });
        const cheap = obj({ id: A1, level: 'adset', budget: { kind: 'daily', amount: 10, editable: true }, totals: { '3d': totals({ spend: 12, impressions: 900, conversations: 6 }) } });
        assert.deepEqual(planRule(raise, [cheap], ctx()).matched[0]!.steps, [{ kind: 'propose', objectId: A1, action: 'raise_budget', from: 10, to: 12 }]);
        const resume = { ...raise, actions: [{ type: 'resume' as const }] };
        const paused = { ...cheap, status: 'PAUSED', effectiveStatus: 'PAUSED' };
        assert.deepEqual(planRule(resume, [paused], ctx()).matched[0]!.steps, [{ kind: 'propose', objectId: A1, action: 'resume' }]);
        assert.equal(planRule(resume, [cheap], ctx()).matched.length, 0, 'resume watches paused objects only');
    });

    it('one action per object per evaluation, across rules', () => {
        const c = ctx();
        planRule(spec(), [expensive(A1)], c);
        const second = planRule(spec({ name: 'second' }), [expensive(A1)], c);
        assert.deepEqual(second.matched[0]!.steps, []);
        assert.deepEqual(second.matched[0]!.skipped, ['taken']);
    });

    it('leaves an object with a queued op alone, and respects the cooldown', () => {
        assert.deepEqual(planRule(spec(), [expensive(A1, { busy: true })], ctx()).matched[0]!.skipped, ['busy']);
        assert.deepEqual(planRule(spec(), [expensive(A1)], ctx({ cooledDown: new Set([A1]) })).matched[0]!.skipped, ['cooldown']);
    });

    it('notify rides along with an op, or stands alone', () => {
        const plan = planRule(spec({ actions: [{ type: 'pause' }, { type: 'notify' }] }), [expensive(A1)], ctx());
        assert.deepEqual(plan.matched[0]!.steps.map((s) => s.kind), ['op', 'notify']);
    });

    it('the rejected template notifies about a disapproved ad whatever its numbers', () => {
        const t = RULE_TEMPLATES.find((x) => x.id === 'rejected_notify')!;
        const plan = planRule({ name: 't', ...t.spec }, [obj({ id: A1, effectiveStatus: 'DISAPPROVED' }), obj({ id: A2 })], ctx());
        assert.deepEqual(plan.matched.map((m) => m.objectId), [A1]);
    });
});

describe('isBlind and priority', () => {
    it('is blind 24 h after the last real evaluation, or the approval when there was none', () => {
        const created = new Date('2026-10-20T00:00:00Z');
        assert.equal(isBlind({ lastOkAt: new Date('2026-10-21T13:00:00Z'), approvedAt: created, createdAt: created }, NOW), false);
        assert.equal(isBlind({ lastOkAt: new Date('2026-10-21T12:00:00Z'), approvedAt: created, createdAt: created }, NOW), true);
        assert.equal(isBlind({ lastOkAt: null, approvedAt: new Date('2026-10-22T00:00:00Z'), createdAt: created }, NOW), false);
    });

    it('orders pause before lower before notify before proposals', () => {
        const order = [[{ type: 'raise_budget' as const, percent: 10 }], [{ type: 'notify' as const }], [{ type: 'lower_budget' as const, percent: 10 }], [{ type: 'pause' as const }]]
            .map((actions) => rulePriority({ actions }));
        assert.deepEqual(order, [3, 2, 1, 0]);
    });
});

// ─── The evaluator with fakes ───────────────────────────────────────────────────────────────────

interface Harness {
    deps: RulesDeps;
    store: RulesStore;
    runs: Array<{ ruleId: string; run: RunRecord; ok: boolean }>;
    ops: Array<{ ruleId: string; step: PlannedStep; hourKey: string }>;
    proposals: Array<{ ruleId: string; objects: string[] }>;
    alerts: Array<{ alert: RuleActedAlert | RuleBlindAlert; key: string }>;
    refreshes: number;
}

function harness(o: {
    account?: AccountForRules; objects?: StoredObject[]; totals?: Record<string, WindowTotals>; syncedAt?: Date | null; refresh?: RefreshResult;
    cooled?: string[]; enqueueFails?: boolean;
} = {}): Harness {
    const h: Harness = { runs: [], ops: [], proposals: [], alerts: [], refreshes: 0 } as unknown as Harness;
    let n = 0;
    h.deps = {
        now: () => NOW,
        account: async () => o.account ?? { ok: true, adAccountId: '123', currency: 'SAR', offsetHours: 3, minDailyBudget: 4 },
        objects: async (_c, level, ids) => (o.objects ?? []).filter((x) => x.level === level && (ids === 'all' || ids.includes(x.id))),
        todaySyncedAt: async () => (o.syncedAt === undefined ? new Date(NOW.getTime() - 30 * 60_000) : o.syncedAt),
        refreshToday: async () => { h.refreshes++; return o.refresh ?? 'ok'; },
        totals: async (_c, _l, metaIds) => new Map(metaIds.map((m) => [m, o.totals?.[m] ?? totals()])),
        editsLeftThisHour: async (_c, ids) => new Map(ids.map((id) => [id, 4])),
        enqueue: async (_c, rule, step, _obj, hourKey) => {
            if (o.enqueueFails) throw new Error('EDIT_LIMIT');
            h.ops.push({ ruleId: rule.id, step, hourKey });
            return { id: `op-${++n}` };
        },
        propose: async (_c, rule, entries) => { h.proposals.push({ ruleId: rule.id, objects: entries.map((e) => e.objectId) }); return { id: `prop-${++n}` }; },
        alert: async (_c, alert, key) => { h.alerts.push({ alert, key }); },
    };
    h.store = {
        recordRun: async (_c, ruleId, run, ok) => { h.runs.push({ ruleId, run, ok }); },
        recentlyActed: async () => new Set(o.cooled ?? []),
    };
    return h;
}

const stored = (id: string, p: Partial<RuleSpec> = {}, extra: Partial<StoredRule> = {}): StoredRule => ({
    ...spec(p), id, creatorId: C, enabled: true, approvedBy: null, approvedAt: new Date('2026-10-22T08:00:00Z'), lastOkAt: new Date('2026-10-22T11:00:00Z'),
    createdAt: new Date('2026-10-22T08:00:00Z'), updatedAt: new Date('2026-10-22T08:00:00Z'), lastRun: null, ...extra,
});

const ad = (id: string, p: Partial<StoredObject> = {}): StoredObject => {
    const { totals: _t, ...rest } = obj({ id });
    return { ...rest, ...p };
};

describe('evaluateTenantRules', () => {
    it('acts: the pause is enqueued with the hour key, a run row says acted, one alert per object', async () => {
        const h = harness({ objects: [ad(A1)], totals: { 'm-1': totals({ spend: 40, impressions: 1200, conversations: 1 }) } });
        const r = await evaluateTenantRules(C, [stored('R1')], h.deps, h.store);
        assert.equal(r.ops, 1);
        assert.deepEqual(h.ops, [{ ruleId: 'R1', step: { kind: 'op', objectId: A1, action: 'pause' }, hourKey: '2026-10-22T12' }]);
        assert.equal(h.runs[0]!.run.outcome, 'acted');
        assert.deepEqual(h.runs[0]!.run.ops, ['op-1']);
        assert.equal(h.runs[0]!.ok, true);
        assert.equal(h.alerts.length, 1);
        assert.equal(h.alerts[0]!.key, `rule:R1:${A1}`);
        assert.equal(h.alerts[0]!.alert.kind, 'rule_acted');
    });

    it('nothing matched is ok; no alert', async () => {
        const h = harness({ objects: [ad(A1)], totals: { 'm-1': totals({ spend: 10, impressions: 1200, conversations: 5 }) } });
        await evaluateTenantRules(C, [stored('R1')], h.deps, h.store);
        assert.equal(h.runs[0]!.run.outcome, 'ok');
        assert.equal(h.ops.length + h.alerts.length, 0);
    });

    it('raises make ONE proposal for the run and no op', async () => {
        const s = { scope: { level: 'adset' as const, objectIds: 'all' as const }, conditions: [{ metric: 'cost_per_conversation' as const, op: '<' as const, value: 5, window: '3d' as const }], actions: [{ type: 'raise_budget' as const, percent: 20 }] };
        const set = (id: string) => ad(id, { level: 'adset', metaId: `m-${id.slice(-1)}`, budget: { kind: 'daily', amount: 10, editable: true }, adsetMetaId: `m-${id.slice(-1)}` });
        const cheap = totals({ spend: 12, impressions: 900, conversations: 6 });
        const h = harness({ objects: [set(A1), set(A2)], totals: { 'm-1': cheap, 'm-2': cheap } });
        await evaluateTenantRules(C, [stored('R1', s)], h.deps, h.store);
        assert.equal(h.ops.length, 0);
        assert.deepEqual(h.proposals, [{ ruleId: 'R1', objects: [A1, A2] }]);
        assert.equal(h.runs[0]!.run.outcome, 'proposed');
        assert.equal(h.runs[0]!.run.proposalId, 'prop-1');
    });

    it('not enough data is skipped_no_data and does not count as watching', async () => {
        const h = harness({ objects: [ad(A1)], totals: { 'm-1': totals({ spend: 40, impressions: 100 }) } });
        await evaluateTenantRules(C, [stored('R1')], h.deps, h.store);
        assert.equal(h.runs[0]!.run.outcome, 'skipped_no_data');
        assert.equal(h.runs[0]!.ok, false);
    });

    it('stale results are read again first; a refused read is blind, never a guess', async () => {
        const stale = new Date(NOW.getTime() - 3 * 3_600_000);
        const ok = harness({ objects: [ad(A1)], syncedAt: stale, refresh: 'ok', totals: { 'm-1': totals({ spend: 40, impressions: 1200 }) } });
        await evaluateTenantRules(C, [stored('R1'), stored('R2', { name: 'two', actions: [{ type: 'notify' }] })], ok.deps, ok.store);
        assert.equal(ok.refreshes, 1, 'one refresh per tenant per pass');
        assert.equal(ok.runs[0]!.run.outcome, 'acted');

        const h = harness({ objects: [ad(A1)], syncedAt: stale, refresh: 'throttled', totals: { 'm-1': totals({ spend: 40, impressions: 1200 }) } });
        await evaluateTenantRules(C, [stored('R1')], h.deps, h.store);
        assert.equal(h.runs[0]!.run.outcome, 'blind');
        assert.deepEqual(h.runs[0]!.run.matched, { reason: 'throttled' });
        assert.equal(h.ops.length, 0);
    });

    it('a dead token or an unconfigured account records blind for every rule', async () => {
        const h = harness({ account: { ok: false, reason: 'token_dead' } });
        await evaluateTenantRules(C, [stored('R1'), stored('R2')], h.deps, h.store);
        assert.deepEqual(h.runs.map((r) => r.run.outcome), ['blind', 'blind']);
        assert.deepEqual(h.runs.map((r) => (r.run.matched as { reason: string }).reason), ['token_dead', 'token_dead']);
    });

    it('rule_blind after 24 h without a real evaluation, with the reason', async () => {
        const h = harness({ account: { ok: false, reason: 'token_dead' } });
        await evaluateTenantRules(C, [stored('R1', {}, { lastOkAt: new Date('2026-10-21T10:00:00Z') })], h.deps, h.store);
        assert.equal(h.alerts.length, 1);
        assert.deepEqual(h.alerts[0], { alert: { kind: 'rule_blind', ruleId: 'R1', ruleName: 'r', reason: 'token_dead', hours: 26 }, key: 'rule:R1' });
    });

    it('a failed enqueue is recorded on the entry, not thrown', async () => {
        const h = harness({ objects: [ad(A1)], enqueueFails: true, totals: { 'm-1': totals({ spend: 40, impressions: 1200 }) } });
        await evaluateTenantRules(C, [stored('R1')], h.deps, h.store);
        const m = h.runs[0]!.run.matched as Array<{ skipped: string[]; steps: unknown[] }>;
        assert.deepEqual(m[0]!.skipped, ['edit_limit']);
        assert.deepEqual(m[0]!.steps, []);
        assert.equal(h.runs[0]!.run.outcome, 'ok');
    });

    it('an error inside one rule is a blind run with reason error; the next rule still runs', async () => {
        const h = harness({ objects: [ad(A1)] });
        let calls = 0;
        const objects = h.deps.objects;
        h.deps.objects = async (...a) => { if (calls++ === 0) throw new Error('boom'); return objects(...a); };
        await evaluateTenantRules(C, [stored('R1'), stored('R2')], h.deps, h.store);
        assert.equal(h.runs[0]!.run.outcome, 'blind');
        assert.equal((h.runs[0]!.run.matched as { reason: string }).reason, 'error');
        assert.equal(h.runs[1]!.run.outcome, 'skipped_no_data', 'the second rule still evaluated');
    });
});
