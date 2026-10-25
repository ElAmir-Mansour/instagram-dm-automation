/**
 * Rules under `/api/ads/rules` (Ads Manager phase A9; contracts/dashboard-api.md "Rules"; src/services/ads/rules*.ts). Mounted inside
 * `adsRouter`, so the ADS_DISABLED gate runs first and the tenant is the session's.
 *
 *   GET    /rules              viewer+  { rules, templates, limits, currency }
 *   POST   /rules              owner    a rule → 201 { rule }. SAVING IS APPROVING: `approved_by` is the saver, audited `ads.rule_saved`
 *   PATCH  /rules/:id          owner    any of the rule's fields and `enabled` → { rule }. A changed rule is approved again by whoever saves
 *   DELETE /rules/:id          owner    → { deleted: true }
 *   GET    /rules/:id/runs     viewer+  { runs }: the last 50 evaluations, newest first
 *
 * Errors `{ error, code, field? }`. Nothing here calls Meta: rules are evaluated by the drain (`rulesWiring.evaluateDueRules`).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { actorFromSession, AUDIT_ACTIONS, writeAudit } from '../services/audit.js';
import { parseRuleSpec, RULE_LIMITS, RULE_TEMPLATES, type RuleSpec } from '../services/ads/rulesEval.js';
import {
    countRules, createRule, deleteRule, getRule, listRules, listRuns, RULES_PER_TENANT, toRuleView, updateRule, type RunView, type StoredRule,
} from '../services/ads/rulesStore.js';
import { readHealth } from '../services/ads/settings.js';
import { getTenantId, requireTenantRole } from '../services/tenant.js';
import { describeError, log } from '../utils/log.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RulesRouteDeps {
    canRead: RequestHandler;
    canWrite: RequestHandler;
    tenantId(req: Request): string;
    userId(req: Request): string | null;
    currency(creatorId: string): Promise<string | null>;
    audit(req: Request, ruleId: string, detail: Record<string, unknown>): Promise<void>;
    now(): Date;
    store: {
        list(creatorId: string): Promise<StoredRule[]>;
        get(creatorId: string, id: string): Promise<StoredRule | null>;
        count(creatorId: string): Promise<number>;
        create(creatorId: string, spec: RuleSpec, enabled: boolean, approvedBy: string | null): Promise<StoredRule>;
        update(creatorId: string, id: string, patch: { spec?: RuleSpec; enabled?: boolean }, approvedBy: string | null): Promise<StoredRule | null>;
        remove(creatorId: string, id: string): Promise<boolean>;
        runs(creatorId: string, ruleId: string): Promise<RunView[]>;
    };
}

export const defaultRulesDeps: RulesRouteDeps = {
    canRead: requireTenantRole('viewer'),
    canWrite: requireTenantRole('owner'),
    tenantId: getTenantId,
    userId: (req) => req.session?.userId ?? null,
    currency: async (creatorId) => (await readHealth(creatorId)).account?.currency ?? null,
    audit: async (req, ruleId, detail) => {
        await writeAudit(await actorFromSession(req.session), { action: AUDIT_ACTIONS.adsRuleSaved, targetType: 'ads_rule', targetId: ruleId, detail });
    },
    now: () => new Date(),
    store: { list: listRules, get: getRule, count: countRules, create: createRule, update: updateRule, remove: deleteRule, runs: (c, r) => listRuns(c, r) },
};

const body = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

function fail(res: Response, err: unknown, what: string): void {
    log('error', `ads.rules_${what}_failed`, describeError(err));
    res.status(500).json({ error: `Failed to ${what.replace(/_/g, ' ')}.` });
}

/** What the audit row says about a rule: its shape, never more. */
const auditOf = (r: StoredRule): Record<string, unknown> => ({
    name: r.name, enabled: r.enabled, level: r.scope.level, objects: r.scope.objectIds === 'all' ? 'all' : r.scope.objectIds.length,
    conditions: r.conditions, min_data: r.minData, actions: r.actions,
});

export function makeRulesRouter(deps: RulesRouteDeps = defaultRulesDeps): Router {
    const router = Router();

    router.get('/rules', deps.canRead, async (req, res) => {
        try {
            const creatorId = deps.tenantId(req);
            const [rules, currency] = await Promise.all([deps.store.list(creatorId), deps.currency(creatorId)]);
            const now = deps.now();
            res.json({ rules: rules.map((r) => toRuleView(r, now)), templates: RULE_TEMPLATES, limits: { ...RULE_LIMITS, perTenant: RULES_PER_TENANT }, currency });
        } catch (err) {
            fail(res, err, 'read_rules');
        }
    });

    router.post('/rules', deps.canWrite, async (req, res) => {
        try {
            const creatorId = deps.tenantId(req);
            const parsed = parseRuleSpec(body(req));
            if (!parsed.ok) return void res.status(400).json({ error: parsed.error, code: 'INVALID', field: parsed.field });
            if ((await deps.store.count(creatorId)) >= RULES_PER_TENANT) {
                return void res.status(409).json({ error: `At most ${RULES_PER_TENANT} rules: delete one first.`, code: 'INVALID', field: 'rule' });
            }
            const enabled = body(req)['enabled'] !== false;
            const rule = await deps.store.create(creatorId, parsed.spec, enabled, deps.userId(req));
            await deps.audit(req, rule.id, { op: 'create', ...auditOf(rule) });
            res.status(201).json({ rule: toRuleView(rule, deps.now()) });
        } catch (err) {
            fail(res, err, 'save_rule');
        }
    });

    router.patch('/rules/:id', deps.canWrite, async (req, res) => {
        try {
            const creatorId = deps.tenantId(req);
            const id = String(req.params['id'] ?? '');
            const current = UUID.test(id) ? await deps.store.get(creatorId, id) : null;
            if (!current) return void res.status(404).json({ error: 'No such rule.', code: 'NOT_FOUND' });
            const b = body(req);
            if (b['enabled'] !== undefined && typeof b['enabled'] !== 'boolean') return void res.status(400).json({ error: 'enabled is true or false.', code: 'INVALID', field: 'enabled' });
            const specKeys = ['name', 'scope', 'conditions', 'minData', 'actions'] as const;
            let spec: RuleSpec | undefined;
            if (specKeys.some((k) => b[k] !== undefined)) {
                // The whole rule is validated as it will be after the change: a partial edit cannot leave a contradiction behind.
                const merged = Object.fromEntries(specKeys.map((k) => [k, b[k] !== undefined ? b[k] : current[k]]));
                const parsed = parseRuleSpec(merged);
                if (!parsed.ok) return void res.status(400).json({ error: parsed.error, code: 'INVALID', field: parsed.field });
                spec = parsed.spec;
            }
            const enabled = typeof b['enabled'] === 'boolean' ? b['enabled'] : undefined;
            if (!spec && enabled === undefined) return void res.json({ rule: toRuleView(current, deps.now()) });
            const rule = await deps.store.update(creatorId, id, { spec, enabled }, deps.userId(req));
            if (!rule) return void res.status(404).json({ error: 'No such rule.', code: 'NOT_FOUND' });
            await deps.audit(req, rule.id, { op: spec ? 'update' : enabled ? 'enable' : 'disable', ...auditOf(rule) });
            res.json({ rule: toRuleView(rule, deps.now()) });
        } catch (err) {
            fail(res, err, 'save_rule');
        }
    });

    router.delete('/rules/:id', deps.canWrite, async (req, res) => {
        try {
            const creatorId = deps.tenantId(req);
            const id = String(req.params['id'] ?? '');
            const current = UUID.test(id) ? await deps.store.get(creatorId, id) : null;
            if (!current || !(await deps.store.remove(creatorId, id))) return void res.status(404).json({ error: 'No such rule.', code: 'NOT_FOUND' });
            await deps.audit(req, id, { op: 'delete', ...auditOf(current) });
            res.json({ deleted: true });
        } catch (err) {
            fail(res, err, 'delete_rule');
        }
    });

    router.get('/rules/:id/runs', deps.canRead, async (req, res) => {
        try {
            const creatorId = deps.tenantId(req);
            const id = String(req.params['id'] ?? '');
            const rule = UUID.test(id) ? await deps.store.get(creatorId, id) : null;
            if (!rule) return void res.status(404).json({ error: 'No such rule.', code: 'NOT_FOUND' });
            res.json({ runs: await deps.store.runs(creatorId, id) });
        } catch (err) {
            fail(res, err, 'read_rule_runs');
        }
    });

    return router;
}

export const adsRulesRouter = makeRulesRouter();
