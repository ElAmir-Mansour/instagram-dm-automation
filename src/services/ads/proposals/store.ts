/**
 * `ads_proposals` (v55): storage and the state machine.
 *
 *   drafting → open | failed
 *   open     → approved | rejected | expired
 *   approved → applying | failed
 *   applying → applied | failed
 *
 * Every move goes through `transitionProposal`, which locks the row, checks `PROPOSAL_TRANSITIONS` and refuses anything else with
 * 409 INVALID: a proposal can never be approved twice, approved after it expired, or rejected while its ops are running.
 *
 * Postgres only, no Meta. `expireProposals` runs from the daily cron.
 */
import { pool } from '../../../config/db.js';
import { queryOne, queryRows, type SqlParam } from '../../../db/query.js';
import { withTransaction, type Exec } from '../../studio/common.js';
import {
    DRAFTING_STALE_HOURS, PROPOSAL_TRANSITIONS, ProposalError, type ProposalChecks, type ProposalEffect, type ProposalKind, type ProposalModel,
    type ProposalPayload, type ProposalRow, type ProposalSource, type ProposalState, type ProposalView,
} from './types.js';

const COLUMNS = `id, creator_id, kind, source, request_text, post_ref, payload, rationale, evidence, effect, checks, state, error, model, attempt,
    decided_by, decided_at, expires_at, created_at, updated_at`;

export const PROPOSAL_STATES: readonly ProposalState[] = ['drafting', 'open', 'approved', 'applying', 'applied', 'failed', 'rejected', 'expired'];

/** The text a failed Mac draft is given by the daily sweep. */
export const STALE_DRAFT_ERROR = 'Claude on the Mac did not answer within 24 hours (the Mac was asleep or its worker stopped). Ask again.';

type Iso = string;
interface DbRow extends Omit<ProposalRow, 'decided_at' | 'expires_at' | 'created_at' | 'updated_at'> {
    decided_at: Date | Iso | null;
    expires_at: Date | Iso;
    created_at: Date | Iso;
    updated_at: Date | Iso;
}

const iso = (v: Date | Iso | null): Iso | null => (v === null ? null : v instanceof Date ? v.toISOString() : new Date(v).toISOString());

function toRow(r: DbRow): ProposalRow {
    return { ...r, attempt: Number(r.attempt) || 1, decided_at: iso(r.decided_at), expires_at: iso(r.expires_at)!, created_at: iso(r.created_at)!, updated_at: iso(r.updated_at)! };
}

export interface NewProposal {
    creatorId: string;
    kind: ProposalKind;
    source: ProposalSource;
    requestText?: string | null;
    postRef?: { postId: string; platform: string } | null;
    state?: ProposalState;
    payload?: ProposalPayload | null;
    rationale?: string | null;
    evidence?: Record<string, unknown> | null;
    effect?: ProposalEffect | null;
    checks?: ProposalChecks | null;
    model?: ProposalModel | null;
}

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

export async function insertProposal(exec: Exec, p: NewProposal): Promise<ProposalRow> {
    const { rows } = await exec.query<DbRow>(
        `INSERT INTO ads_proposals (creator_id, kind, source, request_text, post_ref, state, payload, rationale, evidence, effect, checks, model)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb)
         RETURNING ${COLUMNS}`,
        [p.creatorId, p.kind, p.source, p.requestText ?? null, json(p.postRef), p.state ?? 'drafting', json(p.payload), p.rationale ?? null,
            json(p.evidence), json(p.effect), json(p.checks), json(p.model)],
    );
    if (!rows[0]) throw new Error('ads_proposals insert returned no row.');
    return toRow(rows[0]);
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getProposal(creatorId: string, id: string, exec: Exec = pool): Promise<ProposalRow | null> {
    if (!ID.test(id)) return null;
    const { rows } = await exec.query<DbRow>(`SELECT ${COLUMNS} FROM ads_proposals WHERE id = $1 AND creator_id = $2`, [id, creatorId]);
    return rows[0] ? toRow(rows[0]) : null;
}

export async function listProposals(creatorId: string, states: ProposalState[] | null, limit = 50): Promise<ProposalRow[]> {
    const rows = await queryRows<DbRow>(
        `SELECT ${COLUMNS} FROM ads_proposals
          WHERE creator_id = $1 AND ($2::text[] IS NULL OR state = ANY($2::text[]))
          ORDER BY created_at DESC LIMIT $3`,
        [creatorId, states && states.length ? states : null, Math.max(1, Math.min(200, limit))],
    );
    return rows.map(toRow);
}

export type ProposalPatch = Partial<Pick<ProposalRow, 'payload' | 'rationale' | 'evidence' | 'effect' | 'checks' | 'error' | 'model' | 'attempt' | 'decided_by' | 'decided_at'>>;

const PATCHABLE: ReadonlyArray<keyof ProposalPatch> = ['payload', 'rationale', 'evidence', 'effect', 'checks', 'error', 'model', 'attempt', 'decided_by', 'decided_at'];
const JSON_COLUMNS = new Set(['payload', 'evidence', 'effect', 'checks', 'model']);

/** Whether `from → to` is a move the machine allows. */
export const canMove = (from: ProposalState, to: ProposalState): boolean => PROPOSAL_TRANSITIONS[from].includes(to);

/**
 * Move one proposal, with the row locked: refused with 409 INVALID unless the move is allowed from the state it is in NOW. `patch` is
 * written in the same statement. Pass a transaction's client to make it part of a larger change; else it runs in its own.
 */
export async function transitionProposal(exec: Exec | null, creatorId: string, id: string, to: ProposalState, patch: ProposalPatch = {}): Promise<ProposalRow> {
    const run = async (tx: Exec): Promise<ProposalRow> => {
        const { rows } = await tx.query<DbRow>(`SELECT ${COLUMNS} FROM ads_proposals WHERE id = $1 AND creator_id = $2 FOR UPDATE`, [id, creatorId]);
        const current = rows[0] ? toRow(rows[0]) : null;
        if (!current) throw new ProposalError(404, 'NOT_FOUND', 'No such proposal.');
        if (!canMove(current.state, to)) throw new ProposalError(409, 'INVALID', `This proposal is ${current.state}; it cannot become ${to}.`);
        const sets = ['state = $3', 'updated_at = NOW()'];
        const params: SqlParam[] = [id, creatorId, to];
        for (const key of PATCHABLE) {
            if (!(key in patch)) continue;
            params.push(JSON_COLUMNS.has(key) ? json(patch[key]) : (patch[key] as SqlParam) ?? null);
            sets.push(`${key} = $${params.length}${JSON_COLUMNS.has(key) ? '::jsonb' : ''}`);
        }
        const updated = await tx.query<DbRow>(`UPDATE ads_proposals SET ${sets.join(', ')} WHERE id = $1 AND creator_id = $2 RETURNING ${COLUMNS}`, params);
        return toRow(updated.rows[0]!);
    };
    return exec ? run(exec) : withTransaction(run);
}

/** A field change that is not a move (a drafting row's attempt, the ops an applying row is waiting for). */
export async function patchProposal(creatorId: string, id: string, expectState: ProposalState, patch: ProposalPatch): Promise<ProposalRow | null> {
    const sets = ['updated_at = NOW()'];
    const params: SqlParam[] = [id, creatorId, expectState];
    for (const key of PATCHABLE) {
        if (!(key in patch)) continue;
        params.push(JSON_COLUMNS.has(key) ? json(patch[key]) : (patch[key] as SqlParam) ?? null);
        sets.push(`${key} = $${params.length}${JSON_COLUMNS.has(key) ? '::jsonb' : ''}`);
    }
    const row = await queryOne<DbRow>(`UPDATE ads_proposals SET ${sets.join(', ')} WHERE id = $1 AND creator_id = $2 AND state = $3 RETURNING ${COLUMNS}`, params);
    return row ? toRow(row) : null;
}

/** A drafting row that ended with nothing to propose (a review with no change worth making) is removed: it was never anything else. */
export async function deleteDrafting(creatorId: string, id: string): Promise<void> {
    await pool.query(`DELETE FROM ads_proposals WHERE id = $1 AND creator_id = $2 AND state = 'drafting'`, [id, creatorId]);
}

/**
 * The daily sweep: open proposals past `expires_at` become `expired` (7 days, FR-047), and drafts that have waited more than 24 hours
 * (a Mac that never answered) become `failed`. Every tenant, two statements.
 */
export async function expireProposals(now: Date = new Date()): Promise<{ expired: number; staleDrafts: number }> {
    const expired = await pool.query(
        `UPDATE ads_proposals SET state = 'expired', updated_at = NOW() WHERE state = 'open' AND expires_at <= $1`, [now],
    );
    const stale = await pool.query(
        `UPDATE ads_proposals SET state = 'failed', error = $2, updated_at = NOW()
          WHERE state = 'drafting' AND created_at <= $1::timestamptz - make_interval(hours => $3)`,
        [now, STALE_DRAFT_ERROR, DRAFTING_STALE_HOURS],
    );
    return { expired: expired.rowCount ?? 0, staleDrafts: stale.rowCount ?? 0 };
}

/** How many daily-review proposals a tenant got since `since` (the cap is 3 a day). */
export async function countDailyReviewSince(creatorId: string, since: Date): Promise<number> {
    const row = await queryOne<{ n: number | string }>(
        `SELECT COUNT(*)::int AS n FROM ads_proposals WHERE creator_id = $1 AND source = 'daily_review' AND created_at >= $2`, [creatorId, since],
    );
    return Number(row?.n ?? 0);
}

export function toProposalView(r: ProposalRow): ProposalView {
    const p = r.payload;
    return {
        id: r.id,
        kind: r.kind,
        source: r.source,
        state: r.state,
        request: r.request_text,
        post: r.post_ref,
        spec: p?.task === 'draft_campaign' ? p.spec : p?.task === 'review' && 'spec' in p.item.change ? p.item.change.spec : null,
        change: p?.task === 'review' ? { kind: p.item.kind, targets: p.item.targets, change: p.item.change } : null,
        rationale: r.rationale,
        assumptions: p?.task === 'draft_campaign' ? p.assumptions : [],
        expected: p?.task === 'draft_campaign' ? p.expected : null,
        evidence: r.evidence,
        effect: r.effect,
        checks: r.checks,
        error: r.error,
        via: r.model?.via ?? null,
        expiresAt: r.expires_at,
        createdAt: r.created_at,
        decidedAt: r.decided_at,
    };
}
