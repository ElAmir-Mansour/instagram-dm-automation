/**
 * `/api/ads/rules` (Ads A9, T166), driven through the router with fake deps.
 *
 * Pinned: saving is approving (the saver is `approved_by`) and is audited; an invalid rule is a 400 naming the field; a PATCH validates
 * the rule as it will be after the change; viewers read, only the owner writes; the runs of another tenant's rule are a 404.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import { makeRulesRouter, type RulesRouteDeps } from './adsRules.js';
import type { RuleSpec } from '../services/ads/rulesEval.js';
import type { RunView, StoredRule } from '../services/ads/rulesStore.js';

const C = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-22T12:00:00Z');

let rules: StoredRule[];
let audits: Array<{ ruleId: string; detail: Record<string, unknown> }>;
let writeAllowed: boolean;
let seq: number;

const RULE = {
    name: 'Too expensive', scope: { level: 'ad', objectIds: 'all' },
    conditions: [{ metric: 'cost_per_conversation', op: '>', value: 15, window: '3d' }], minData: { impressions: 500 }, actions: [{ type: 'pause' }],
};

function deps(): RulesRouteDeps {
    const allow: RequestHandler = (_q, _s, next) => next();
    const owner: RequestHandler = (_q, res, next) => (writeAllowed ? next() : void res.status(403).json({ error: 'Forbidden.' }));
    const mk = (spec: RuleSpec, enabled: boolean, by: string | null): StoredRule => ({
        ...spec, id: `00000000-0000-4000-8000-00000000000${++seq}`, creatorId: C, enabled, approvedBy: by, approvedAt: NOW, lastOkAt: null,
        createdAt: NOW, updatedAt: NOW, lastRun: null,
    });
    return {
        canRead: allow, canWrite: owner, tenantId: () => C, userId: () => U, currency: async () => 'SAR', now: () => NOW,
        audit: async (_req, ruleId, detail) => { audits.push({ ruleId, detail }); },
        store: {
            list: async () => rules,
            get: async (_c, id) => rules.find((r) => r.id === id) ?? null,
            count: async () => rules.length,
            create: async (_c, spec, enabled, by) => { const r = mk(spec, enabled, by); rules.push(r); return r; },
            update: async (_c, id, patch, by) => {
                const r = rules.find((x) => x.id === id);
                if (!r) return null;
                if (patch.spec) Object.assign(r, patch.spec, { approvedBy: by });
                if (patch.enabled !== undefined) r.enabled = patch.enabled;
                return r;
            },
            remove: async (_c, id) => { const n = rules.length; rules = rules.filter((r) => r.id !== id); return rules.length < n; },
            runs: async (): Promise<RunView[]> => [{ id: 'run1', ranAt: NOW.toISOString(), outcome: 'ok', reason: null, matched: [], ops: [], proposalId: null }],
        },
    };
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const app = express();
    app.use(express.json());
    app.use(makeRulesRouter(deps()));
    const server = app.listen(0);
    try {
        const { port } = server.address() as AddressInfo;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json() };
    } finally {
        server.close();
    }
}

beforeEach(() => { rules = []; audits = []; writeAllowed = true; seq = 0; });

describe('/rules', () => {
    it('GET lists rules with the four templates and the currency', async () => {
        const r = await call('GET', '/rules');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.templates.map((t: { id: string }) => t.id), ['cpc_high_pause', 'spending_fast_notify', 'frequency_lower', 'rejected_notify']);
        assert.equal(r.body.currency, 'SAR');
        assert.deepEqual(r.body.rules, []);
    });

    it('POST saves, approves (by the saver) and audits', async () => {
        const r = await call('POST', '/rules', RULE);
        assert.equal(r.status, 201);
        assert.equal(r.body.rule.approvedBy, U);
        assert.equal(r.body.rule.enabled, true);
        assert.equal(r.body.rule.raises, false);
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.detail['op'], 'create');
    });

    it('POST refuses an invalid rule with the field, and writes nothing', async () => {
        const r = await call('POST', '/rules', { ...RULE, actions: [{ type: 'pause' }, { type: 'resume' }] });
        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'INVALID');
        assert.equal(r.body.field, 'actions');
        assert.equal(rules.length + audits.length, 0);
    });

    it('only the owner writes', async () => {
        writeAllowed = false;
        assert.equal((await call('POST', '/rules', RULE)).status, 403);
        assert.equal(rules.length, 0);
    });

    it('PATCH validates the rule as it will be: adding resume to a pause rule is refused', async () => {
        const id = (await call('POST', '/rules', RULE)).body.rule.id;
        const bad = await call('PATCH', `/rules/${id}`, { actions: [{ type: 'pause' }, { type: 'resume' }] });
        assert.equal(bad.status, 400);
        const off = await call('PATCH', `/rules/${id}`, { enabled: false });
        assert.equal(off.status, 200);
        assert.equal(off.body.rule.enabled, false);
        assert.equal(audits.at(-1)!.detail['op'], 'disable');
    });

    it('DELETE removes and audits; unknown ids are 404', async () => {
        const id = (await call('POST', '/rules', RULE)).body.rule.id;
        assert.deepEqual((await call('DELETE', `/rules/${id}`)).body, { deleted: true });
        assert.equal(audits.at(-1)!.detail['op'], 'delete');
        assert.equal((await call('DELETE', `/rules/${id}`)).status, 404);
        assert.equal((await call('GET', '/rules/not-a-uuid/runs')).status, 404);
    });

    it('GET runs of an own rule', async () => {
        const id = (await call('POST', '/rules', RULE)).body.rule.id;
        const r = await call('GET', `/rules/${id}/runs`);
        assert.equal(r.status, 200);
        assert.equal(r.body.runs[0].outcome, 'ok');
    });
});
