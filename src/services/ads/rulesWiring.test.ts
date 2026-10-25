/**
 * Ads rules' wiring (A9): the proposal a rule makes is an A7 review item that only A7's approval applies, and the stored copy's rows
 * become the evaluator's objects with the right budget holder for Meta's 4-an-hour limit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proposalItem, toStoredObject } from './rulesWiring.js';
import type { ObjectRow } from './mirror.js';
import type { MatchedEntry } from './rulesEval.js';
import type { StoredRule } from './rulesStore.js';

const rule = (actions: StoredRule['actions']): StoredRule => ({
    id: 'r1', creatorId: 'c', name: 'Cheap chats', enabled: true, scope: { level: 'adset', objectIds: 'all' },
    conditions: [{ metric: 'cost_per_conversation', op: '<', value: 5, window: '3d' }], minData: {}, actions,
    approvedBy: null, approvedAt: null, lastOkAt: null, createdAt: new Date(), updatedAt: new Date(), lastRun: null,
});
const entry = (id: string): MatchedEntry => ({ objectId: id, metaId: `m${id}`, name: `Set ${id}`, values: { 'cost_per_conversation:3d': 3.333, 'ctr:3d': null }, steps: [], skipped: [] });

describe('proposalItem', () => {
    it("a raise is A7's raise_budget by the rule's percent over every matched object", () => {
        const item = proposalItem(rule([{ type: 'raise_budget', percent: 20 }]), [entry('a'), entry('b')], 'en');
        assert.equal(item.kind, 'raise_budget');
        assert.deepEqual(item.targets, ['a', 'b']);
        assert.deepEqual(item.change, { percent: 20 });
        assert.deepEqual(item.evidence.numbers, { 'Set a · cost_per_conversation:3d': 3.33, 'Set b · cost_per_conversation:3d': 3.33 });
        assert.match(item.rationale, /only happens with your approval/);
    });

    it('a resume is its own kind, with no percentage', () => {
        const item = proposalItem(rule([{ type: 'resume' }]), [entry('a')], 'ar');
        assert.equal(item.kind, 'resume');
        assert.deepEqual(item.change, { percent: 0 });
        assert.match(item.rationale, /بموافقتك/);
    });
});

describe('toStoredObject', () => {
    const row = (p: Partial<ObjectRow>): ObjectRow => ({
        id: 'o1', creatorId: 'c', adAccountId: '1', level: 'campaign', metaId: 'm1', parentId: null, name: 'Camp', origin: 'meta', status: 'ACTIVE',
        effectiveStatus: 'ACTIVE', objective: null, destinationType: null, optimizationGoal: null, budgetKind: 'daily', budgetAmount: 30, currency: 'SAR',
        startTime: null, endTime: null, targetingSummary: null, review: null, appMeta: {}, raw: null, syncedAt: null, ...p,
    });

    it('a campaign budget counts against its first ad set; an ad has no budget; a queued op makes it busy', () => {
        const camp = toStoredObject(row({}), 'campaign', new Set(['o1']), new Map([['o1', 'set9']]));
        assert.equal(camp.adsetMetaId, 'set9');
        assert.equal(camp.busy, true);
        assert.deepEqual(camp.budget, { kind: 'daily', amount: 30, editable: true });
        const ad = toStoredObject(row({ level: 'ad', budgetKind: 'none', budgetAmount: null }), 'ad', new Set(), new Map());
        assert.equal(ad.adsetMetaId, null);
        assert.equal(ad.budget.editable, false);
        assert.equal(toStoredObject(row({ level: 'adset', metaId: 'm7' }), 'adset', new Set(), new Map()).adsetMetaId, 'm7');
    });
});
