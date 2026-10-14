/**
 * The proof samples' rows: `voice_examples` (v34) and the day's counter. The one place the proof names either table in a statement.
 *
 * Every statement is scoped to the tenant (`creator_id = $…`), so an id from another tenant's page finds nothing. A card is the NEWEST row
 * of its kind: a regenerate leaves the old sample behind as `rejected` and inserts a new one, so "current" needs no flag that could be left
 * set on two rows (`currentCards`).
 *
 * `voice_examples.kind` is `caption` or `comment_dm` here. The comment card's other texts (the public replies, the keyword, the match
 * mode) live in `input`, which a verdict MERGES into (`input || $6`) and never replaces, so what the card was made from survives a verdict.
 */
import { randomUUID } from 'node:crypto';
import type { Exec } from '../studio/common.js';
import { PROOF_KINDS, type ProofKind } from './proofRules.js';

export interface ProofRow {
    id: string;
    profile_version: number | null;
    kind: ProofKind;
    /** What the sample was made from, and what the tenant said about it (`reasons`); JSONB, so anything could be in it. */
    input: Record<string, unknown>;
    model_output: string;
    final_text: string | null;
    verdict: 'approved' | 'edited' | 'rejected' | null;
    verdict_by: 'tenant' | 'admin' | null;
    tenant_confirmed_at: Date | string | null;
    model: string | null;
    created_at: Date | string;
}

export const PROOF_COLUMNS = 'id, profile_version, kind, input, model_output, final_text, verdict, verdict_by, tenant_confirmed_at, model, created_at';
const KINDS_LIST = PROOF_KINDS.map((k) => `'${k}'`).join(', ');

/** The newest rows, newest first. A tenant has two cards and at most four attempts of each: 50 is far more than it ever holds. */
export const LIST_SQL = `SELECT ${PROOF_COLUMNS} FROM voice_examples WHERE creator_id = $1 AND kind IN (${KINDS_LIST}) ORDER BY created_at DESC, id LIMIT 50`;
export const LOAD_SQL = `SELECT ${PROOF_COLUMNS} FROM voice_examples WHERE id = $1 AND creator_id = $2 AND kind IN (${KINDS_LIST})`;
/** The comment card's newest sample the TENANT stood behind: what the first campaign is made from (`proofCampaign.ts`). */
export const CONFIRMED_COMMENT_SQL = `SELECT ${PROOF_COLUMNS} FROM voice_examples WHERE creator_id = $1 AND kind = 'comment_dm' AND verdict IN ('approved', 'edited') AND tenant_confirmed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
export const INSERT_SQL = `INSERT INTO voice_examples (id, creator_id, profile_version, kind, input, model_output, model) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING ${PROOF_COLUMNS}`;

/**
 * A verdict. `tenant_confirmed_at` is set when the TENANT judged and cleared when an admin did: an admin's approval waits for the tenant
 * (02 §2), and a tenant's own word later is what confirms it (a verdict by the tenant on that row sets it again). `input` is merged, never replaced.
 */
export const VERDICT_SQL = `UPDATE voice_examples
       SET verdict = $3, final_text = $4, verdict_by = $5::text,
           tenant_confirmed_at = CASE WHEN $5::text = 'tenant' THEN NOW() ELSE NULL END,
           input = input || $6::jsonb
     WHERE id = $1 AND creator_id = $2 AND kind IN (${KINDS_LIST})
 RETURNING ${PROOF_COLUMNS}`;

/**
 * One more round today, or nothing. Atomic: the row is created at 1, or counted up ONLY while it is under the limit, and a refusal returns
 * no row and counts nothing (so a refused tenant's counter stops at the limit instead of climbing). The bucket is `proof:<tenant id>`
 * (`app_rate_limit_counters.bucket` is 50 characters: this is 42), the window the UTC day, like the draft's.
 */
export const COUNT_ROUND_SQL = `INSERT INTO app_rate_limit_counters (bucket, window_start, count) VALUES ($1, date_trunc('day', NOW()), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = app_rate_limit_counters.count + 1
     WHERE app_rate_limit_counters.count < $2
     RETURNING count`;

export const roundBucket = (creatorId: string): string => `proof:${creatorId}`;

export async function listProofRows(exec: Exec, creatorId: string): Promise<ProofRow[]> {
    const { rows } = await exec.query<ProofRow>(LIST_SQL, [creatorId]);
    return rows;
}

export async function loadProofRow(exec: Exec, creatorId: string, id: string): Promise<ProofRow | null> {
    const { rows } = await exec.query<ProofRow>(LOAD_SQL, [id, creatorId]);
    return rows[0] ?? null;
}

export async function loadConfirmedComment(exec: Exec, creatorId: string): Promise<ProofRow | null> {
    const { rows } = await exec.query<ProofRow>(CONFIRMED_COMMENT_SQL, [creatorId]);
    return rows[0] ?? null;
}

export interface NewProofRow {
    creatorId: string;
    profileVersion: number | null;
    kind: ProofKind;
    input: Record<string, unknown>;
    modelOutput: string;
    model: string | null;
}

export async function insertProofRow(exec: Exec, row: NewProofRow): Promise<ProofRow> {
    const { rows } = await exec.query<ProofRow>(INSERT_SQL, [
        randomUUID(), row.creatorId, row.profileVersion, row.kind, JSON.stringify(row.input), row.modelOutput, row.model,
    ]);
    return rows[0]!;
}

export interface VerdictWrite {
    verdict: 'approved' | 'edited' | 'rejected';
    finalText: string | null;
    by: 'tenant' | 'admin';
    /** Merged into `input` (`{ reasons: [...] }`, `{ hint: '…' }`). */
    input: Record<string, unknown>;
}

export async function writeVerdict(exec: Exec, creatorId: string, id: string, write: VerdictWrite): Promise<ProofRow | null> {
    const { rows } = await exec.query<ProofRow>(VERDICT_SQL, [id, creatorId, write.verdict, write.finalText, write.by, JSON.stringify(write.input)]);
    return rows[0] ?? null;
}

/** True when the round was counted; false when the tenant has used up the day's. */
export async function countRound(exec: Exec, creatorId: string, limit: number): Promise<boolean> {
    const { rows } = await exec.query<{ count: number }>(COUNT_ROUND_SQL, [roundBucket(creatorId), limit]);
    return rows.length > 0;
}

/** The current card of each kind: the newest row of it, whatever its verdict. Pure. */
export function currentCards(rows: readonly ProofRow[]): Map<ProofKind, ProofRow> {
    const at = (r: ProofRow): number => (r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(String(r.created_at)));
    const out = new Map<ProofKind, ProofRow>();
    for (const row of [...rows].sort((a, b) => at(b) - at(a))) if (!out.has(row.kind)) out.set(row.kind, row);
    return out;
}
