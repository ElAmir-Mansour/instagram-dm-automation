/**
 * Ads rules, the stored half: `ads_rules` and `ads_rule_runs` (migration v56, data-model.md). Every query is scoped to the tenant.
 *
 * Saving a rule IS approving it (contracts/dashboard-api.md "Rules"): `approved_by`/`approved_at` are set on every save that changes
 * what the rule does, so the evaluator only ever runs what the owner last saw.
 */
import { queryOne, queryRows } from '../../db/query.js';
import type { MatchedEntry, RuleAction, RuleCondition, RuleMinData, RuleScope, RuleSpec, RunOutcome, BlindReason } from './rulesEval.js';
import { isBlind, ruleRaises } from './rulesEval.js';

interface RuleRow {
    id: string;
    creator_id: string;
    name: string;
    enabled: boolean;
    scope: { level: RuleScope['level']; object_ids: string[] | 'all' };
    conditions: RuleCondition[];
    min_data: RuleMinData;
    actions: RuleAction[];
    approved_by: string | null;
    approved_at: Date | null;
    last_ok_at: Date | null;
    created_at: Date;
    updated_at: Date;
    last_ran_at?: Date | null;
    last_outcome?: RunOutcome | null;
}

interface RunRow {
    id: string;
    rule_id: string;
    ran_at: Date;
    outcome: RunOutcome;
    matched: MatchedEntry[] | { reason: BlindReason; detail?: string };
    ops: string[];
    proposal_id: string | null;
}

export interface StoredRule extends RuleSpec {
    id: string;
    creatorId: string;
    enabled: boolean;
    approvedBy: string | null;
    approvedAt: Date | null;
    lastOkAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    lastRun: { ranAt: Date; outcome: RunOutcome } | null;
}

export interface RuleView extends RuleSpec {
    id: string;
    enabled: boolean;
    raises: boolean;
    approvedBy: string | null;
    approvedAt: string | null;
    lastOkAt: string | null;
    createdAt: string;
    updatedAt: string;
    lastRun: { ranAt: string; outcome: RunOutcome } | null;
    blind: boolean;
}

export interface RunView {
    id: string;
    ranAt: string;
    outcome: RunOutcome;
    reason: BlindReason | null;
    matched: MatchedEntry[];
    ops: string[];
    proposalId: string | null;
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

function fromRow(r: RuleRow): StoredRule {
    return {
        id: r.id,
        creatorId: r.creator_id,
        name: r.name,
        enabled: r.enabled,
        scope: { level: r.scope.level, objectIds: r.scope.object_ids },
        conditions: r.conditions,
        minData: r.min_data ?? {},
        actions: r.actions,
        approvedBy: r.approved_by,
        approvedAt: r.approved_at,
        lastOkAt: r.last_ok_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastRun: r.last_ran_at && r.last_outcome ? { ranAt: r.last_ran_at, outcome: r.last_outcome } : null,
    };
}

export function toRuleView(r: StoredRule, now: Date): RuleView {
    return {
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        scope: r.scope,
        conditions: r.conditions,
        minData: r.minData,
        actions: r.actions,
        raises: ruleRaises(r),
        approvedBy: r.approvedBy,
        approvedAt: iso(r.approvedAt),
        lastOkAt: iso(r.lastOkAt),
        createdAt: iso(r.createdAt) as string,
        updatedAt: iso(r.updatedAt) as string,
        lastRun: r.lastRun ? { ranAt: iso(r.lastRun.ranAt) as string, outcome: r.lastRun.outcome } : null,
        blind: r.enabled && isBlind(r, now),
    };
}

export function toRunView(r: RunRow): RunView {
    const blind = !Array.isArray(r.matched);
    return {
        id: r.id,
        ranAt: iso(r.ran_at) as string,
        outcome: r.outcome,
        reason: blind ? (r.matched as { reason: BlindReason }).reason ?? null : null,
        matched: blind ? [] : (r.matched as MatchedEntry[]),
        ops: r.ops ?? [],
        proposalId: r.proposal_id,
    };
}

const SELECT_RULE = `
    SELECT r.*, lr.ran_at AS last_ran_at, lr.outcome AS last_outcome
      FROM ads_rules r
      LEFT JOIN LATERAL (
        SELECT ran_at, outcome FROM ads_rule_runs WHERE rule_id = r.id AND creator_id = r.creator_id ORDER BY ran_at DESC LIMIT 1
      ) lr ON true`;

const scopeJson = (s: RuleScope): string => JSON.stringify({ level: s.level, object_ids: s.objectIds });

export async function listRules(creatorId: string): Promise<StoredRule[]> {
    const rows = await queryRows<RuleRow>(`${SELECT_RULE} WHERE r.creator_id = $1 ORDER BY r.created_at`, [creatorId]);
    return rows.map(fromRow);
}

export async function getRule(creatorId: string, id: string): Promise<StoredRule | null> {
    const row = await queryOne<RuleRow>(`${SELECT_RULE} WHERE r.creator_id = $1 AND r.id = $2`, [creatorId, id]);
    return row ? fromRow(row) : null;
}

export async function countRules(creatorId: string): Promise<number> {
    const row = await queryOne<{ n: number }>('SELECT count(*)::int AS n FROM ads_rules WHERE creator_id = $1', [creatorId]);
    return row?.n ?? 0;
}

/** At most this many rules per tenant: each one costs Meta points every hour. */
export const RULES_PER_TENANT = 25;

export async function createRule(creatorId: string, spec: RuleSpec, enabled: boolean, approvedBy: string | null): Promise<StoredRule> {
    const row = await queryOne<{ id: string }>(
        `INSERT INTO ads_rules (creator_id, name, enabled, scope, conditions, min_data, actions, approved_by, approved_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, now())
         RETURNING id`,
        [creatorId, spec.name, enabled, scopeJson(spec.scope), JSON.stringify(spec.conditions), JSON.stringify(spec.minData),
            JSON.stringify(spec.actions), approvedBy],
    );
    return (await getRule(creatorId, row!.id))!;
}

/**
 * Update a rule. A new spec re-approves it (who saved, now) and restarts the blind clock from the approval. Switching it back on also
 * restarts the clock: a rule that was off was not "not watching".
 */
export async function updateRule(
    creatorId: string, id: string, patch: { spec?: RuleSpec; enabled?: boolean }, approvedBy: string | null,
): Promise<StoredRule | null> {
    const s = patch.spec;
    const row = await queryOne<{ id: string }>(
        `UPDATE ads_rules SET
            name        = COALESCE($3, name),
            scope       = COALESCE($4::jsonb, scope),
            conditions  = COALESCE($5::jsonb, conditions),
            min_data    = COALESCE($6::jsonb, min_data),
            actions     = COALESCE($7::jsonb, actions),
            approved_by = CASE WHEN $3::text IS NOT NULL THEN $8 ELSE approved_by END,
            approved_at = CASE WHEN $3::text IS NOT NULL OR ($9::boolean AND NOT enabled) THEN now() ELSE approved_at END,
            enabled     = COALESCE($9, enabled),
            updated_at  = now()
          WHERE creator_id = $1 AND id = $2
          RETURNING id`,
        [creatorId, id, s ? s.name : null, s ? scopeJson(s.scope) : null, s ? JSON.stringify(s.conditions) : null,
            s ? JSON.stringify(s.minData) : null, s ? JSON.stringify(s.actions) : null, approvedBy, patch.enabled ?? null],
    );
    return row ? getRule(creatorId, id) : null;
}

export async function deleteRule(creatorId: string, id: string): Promise<boolean> {
    const row = await queryOne<{ id: string }>('DELETE FROM ads_rules WHERE creator_id = $1 AND id = $2 RETURNING id', [creatorId, id]);
    return row !== null;
}

export async function listRuns(creatorId: string, ruleId: string, limit = 50): Promise<RunView[]> {
    const rows = await queryRows<RunRow>(
        `SELECT id, rule_id, ran_at, outcome, matched, ops, proposal_id FROM ads_rule_runs
          WHERE creator_id = $1 AND rule_id = $2 ORDER BY ran_at DESC LIMIT $3`,
        [creatorId, ruleId, limit],
    );
    return rows.map(toRunView);
}

// ─── What the evaluator needs ─────────────────────────────────────────────────────────────────

/** The rules due an evaluation: on, approved, and not run in the last 55 minutes (hourly, with slack for the drain's own rhythm). */
export async function dueRules(limit = 200): Promise<StoredRule[]> {
    const rows = await queryRows<RuleRow>(
        `${SELECT_RULE}
          WHERE r.enabled AND r.approved_at IS NOT NULL
            AND (lr.ran_at IS NULL OR lr.ran_at < now() - interval '55 minutes')
          ORDER BY lr.ran_at NULLS FIRST
          LIMIT $1`,
        [limit],
    );
    return rows.map(fromRow);
}

export interface RunRecord {
    outcome: RunOutcome;
    matched: MatchedEntry[] | { reason: BlindReason; detail?: string };
    ops: string[];
    proposalId: string | null;
    at: Date;
}

/** Write the run row; a real evaluation also moves `last_ok_at`. */
export async function recordRun(creatorId: string, ruleId: string, run: RunRecord, ok: boolean): Promise<void> {
    await queryOne(
        `INSERT INTO ads_rule_runs (rule_id, creator_id, ran_at, outcome, matched, ops, proposal_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid[], $7)`,
        [ruleId, creatorId, run.at, run.outcome, JSON.stringify(run.matched), run.ops, run.proposalId],
    );
    if (ok) await queryOne('UPDATE ads_rules SET last_ok_at = $3 WHERE creator_id = $1 AND id = $2', [creatorId, ruleId, run.at]);
}

/** The objects this rule changed, notified about or proposed for since `since` (the cooldown). */
export async function recentlyActed(creatorId: string, ruleId: string, since: Date): Promise<Set<string>> {
    const rows = await queryRows<{ object_id: string }>(
        `SELECT DISTINCT m->>'objectId' AS object_id
           FROM ads_rule_runs, jsonb_array_elements(CASE WHEN jsonb_typeof(matched) = 'array' THEN matched ELSE '[]'::jsonb END) m
          WHERE creator_id = $1 AND rule_id = $2 AND ran_at >= $3 AND outcome IN ('acted', 'proposed')
            AND jsonb_array_length(m->'steps') > 0`,
        [creatorId, ruleId, since],
    );
    return new Set(rows.map((r) => r.object_id));
}
