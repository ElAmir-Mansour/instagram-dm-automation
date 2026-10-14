/**
 * `profile_drafts`: every statement the draft engine runs against it, and the row they return (docs/onboarding/03 §4).
 * This is the ONE module that names the table (a test fails if another does): what a scraped page and a model's answer
 * become is stored here and only here, and no agent reads it (03 §3.5).
 *
 * Three rules every statement follows:
 *
 *   1. **The lease is the claim.** `CLAIM_SQL` is a single UPDATE whose WHERE clause is the whole mutual exclusion: the draft is
 *      active, nobody holds it (no lease, or one that ran out), and its next try is due. Whoever's UPDATE returns the row owns the
 *      draft for `LEASE_MS`. There is no read-then-write anywhere, so two callers cannot both think they won.
 *   2. **Every write is guarded by the owner.** Each statement a step uses to save its work says `AND lease_owner = $2`. An
 *      invocation that was too slow (its lease ran out and another took the draft), or whose draft was superseded in the
 *      meantime, writes nothing and finds out (`rowCount` 0 → `LeaseLost`) instead of overwriting the one that now owns it.
 *   3. **Time is the database's.** `NOW()` everywhere a deadline is compared, never an instance's clock: serverless instances
 *      disagree by seconds, and a lease is a promise between them.
 *
 * Statements take an `Exec` (the pool, or a client inside a transaction).
 */
import type { Exec } from '../studio/common.js';
import { ACTIVE_STATUSES, type DraftStatus } from './draftStep.js';
import type { DraftInputs } from './draftInputs.js';
import type { DraftOrigin, DraftRow } from './draftTypes.js';

export type { DraftOrigin, DraftRow } from './draftTypes.js';

export const DRAFT_COLUMNS = 'id, creator_id, origin, requested_by, inputs, inputs_hash, prompt_version, status, attempts, next_attempt_at, lease_until, lease_owner, sources, sources_status, draft, partial, usage, error, error_kind, created_at, updated_at, finished_at';

const ACTIVE_LIST = ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ');

/** A write that found the draft no longer ours: the lease ran out and another caller took it, or it was superseded. */
export class LeaseLost extends Error {
    constructor(readonly draftId: string, readonly what: string) {
        super(`The draft ${draftId} is no longer held by this caller (${what}).`);
        this.name = 'LeaseLost';
    }
}

// ─── Reading ────────────────────────────────────────────────────────────────────────────────

export const SELECT_BY_ID_SQL = `SELECT ${DRAFT_COLUMNS} FROM profile_drafts WHERE id = $1`;

/** The tenant's draft as it stands: the newest one that was not replaced. */
export const SELECT_CURRENT_SQL = `SELECT ${DRAFT_COLUMNS} FROM profile_drafts WHERE creator_id = $1 AND status <> 'superseded' ORDER BY created_at DESC, id DESC LIMIT 1`;

/** A draft that already answers these inputs: one in flight, or a finished one younger than 24 hours. */
export const SELECT_REUSABLE_SQL = `SELECT ${DRAFT_COLUMNS} FROM profile_drafts
     WHERE creator_id = $1 AND inputs_hash = $2
       AND (status IN (${ACTIVE_LIST}) OR (status = 'ready' AND finished_at > NOW() - INTERVAL '24 hours'))
     ORDER BY created_at DESC, id DESC LIMIT 1`;

/** The drafts a caller may claim now, oldest first: the sweep's list. */
export const SELECT_DUE_SQL = `SELECT id FROM profile_drafts
     WHERE status IN (${ACTIVE_LIST})
       AND (lease_until IS NULL OR lease_until < NOW())
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
     ORDER BY created_at, id LIMIT $1`;

export async function loadDraft(exec: Exec, id: string): Promise<DraftRow | null> {
    const { rows } = await exec.query<DraftRow>(SELECT_BY_ID_SQL, [id]);
    return rows[0] ?? null;
}

export async function loadCurrentDraft(exec: Exec, creatorId: string): Promise<DraftRow | null> {
    const { rows } = await exec.query<DraftRow>(SELECT_CURRENT_SQL, [creatorId]);
    return rows[0] ?? null;
}

export async function findReusableDraft(exec: Exec, creatorId: string, hash: string): Promise<DraftRow | null> {
    const { rows } = await exec.query<DraftRow>(SELECT_REUSABLE_SQL, [creatorId, hash]);
    return rows[0] ?? null;
}

export async function listDueDraftIds(exec: Exec, limit: number): Promise<string[]> {
    const { rows } = await exec.query<{ id: string }>(SELECT_DUE_SQL, [limit]);
    return rows.map((r) => r.id);
}

// ─── Starting and superseding ───────────────────────────────────────────────────────────────

/** Serialises two starts for one tenant, so neither can insert beside the other's active draft. Held until the transaction ends. */
export const LOCK_TENANT_DRAFTS_SQL = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
export const lockTenantDrafts = (exec: Exec, creatorId: string): Promise<unknown> => exec.query(LOCK_TENANT_DRAFTS_SQL, [`profile_drafts:${creatorId}`]);

/** New inputs replace the old draft, whether it is still being made or is finished and unconfirmed. A draft that failed stays as history. */
export const SUPERSEDE_SQL = `UPDATE profile_drafts
       SET status = 'superseded', finished_at = NOW(), lease_until = NULL, lease_owner = NULL, next_attempt_at = NULL, updated_at = NOW()
     WHERE creator_id = $1 AND status IN (${ACTIVE_LIST}, 'ready')`;

export const INSERT_SQL = `INSERT INTO profile_drafts (creator_id, origin, requested_by, inputs, inputs_hash, prompt_version)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING ${DRAFT_COLUMNS}`;

/** Drafts a tenant has started today, counted in `app_rate_limit_counters` like the send quotas: increment first, then compare. */
export const COUNT_START_SQL = `INSERT INTO app_rate_limit_counters (bucket, window_start, count)
     VALUES ($1, date_trunc('day', NOW()), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = app_rate_limit_counters.count + 1
     RETURNING count`;

export async function supersedeDrafts(exec: Exec, creatorId: string): Promise<number> {
    const result = await exec.query(SUPERSEDE_SQL, [creatorId]);
    return result.rowCount ?? 0;
}

export async function insertDraft(
    exec: Exec,
    row: { creatorId: string; origin: DraftOrigin; requestedBy: string | null; inputs: DraftInputs; hash: string; promptVersion: string },
): Promise<DraftRow> {
    const { rows } = await exec.query<DraftRow>(INSERT_SQL, [row.creatorId, row.origin, row.requestedBy, JSON.stringify(row.inputs), row.hash, row.promptVersion]);
    return rows[0]!;
}

/** The bucket a tenant's daily count is kept in (`app_rate_limit_counters.bucket` is 50 characters: this is 42). */
export const startBucket = (creatorId: string): string => `draft:${creatorId}`;

export async function countStart(exec: Exec, creatorId: string): Promise<number> {
    const { rows } = await exec.query<{ count: number }>(COUNT_START_SQL, [startBucket(creatorId)]);
    return Number(rows[0]?.count ?? 0);
}

// ─── The lease ──────────────────────────────────────────────────────────────────────────────

/**
 * Take the draft. One statement, so exactly one caller gets the row:
 *
 *   - `status IN (active)`        a finished draft is nobody's;
 *   - `lease_until < NOW()`       nobody holds it, or the holder ran out its lease (it died, or was too slow);
 *   - `next_attempt_at <= NOW()`  its back-off is over.
 *
 * `attempts` goes up by one when it is taken over from an owner that never let go (`lease_owner IS NOT NULL`: a clean release
 * clears it). That is how a draft whose invocation keeps dying (a timeout, an out-of-memory) uses up its tries and ends, instead
 * of being retried for ever.
 */
export const CLAIM_SQL = `UPDATE profile_drafts
       SET lease_until = NOW() + make_interval(secs => $3::double precision),
           lease_owner = $2,
           attempts = attempts + CASE WHEN lease_owner IS NOT NULL THEN 1 ELSE 0 END,
           updated_at = NOW()
     WHERE id = $1
       AND status IN (${ACTIVE_LIST})
       AND (lease_until IS NULL OR lease_until < NOW())
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
     RETURNING ${DRAFT_COLUMNS}`;

export async function claimDraft(exec: Exec, id: string, owner: string, leaseMs: number): Promise<DraftRow | null> {
    const { rows } = await exec.query<DraftRow>(CLAIM_SQL, [id, owner, leaseMs / 1000]);
    return rows[0] ?? null;
}

/** Let go, if it is still ours. A draft whose lease is released is claimable at once (unless it is in back-off). */
export const RELEASE_SQL = `UPDATE profile_drafts SET lease_until = NULL, lease_owner = NULL, updated_at = NOW() WHERE id = $1 AND lease_owner = $2`;

export async function releaseDraft(exec: Exec, id: string, owner: string): Promise<void> {
    await exec.query(RELEASE_SQL, [id, owner]);
}

// ─── Saving a step ──────────────────────────────────────────────────────────────────────────

const ACTIVE_GUARD = `status IN (${ACTIVE_LIST})`;

async function guarded(exec: Exec, id: string, what: string, sql: string, params: unknown[]): Promise<DraftRow> {
    const { rows } = await exec.query<DraftRow>(sql, params);
    if (!rows[0]) throw new LeaseLost(id, what);
    return rows[0];
}

/** The draft moved to the step it is now doing (`queued` → `fetching`). */
export const MARK_STATUS_SQL = `UPDATE profile_drafts SET status = $3, updated_at = NOW()
     WHERE id = $1 AND lease_owner = $2 AND ${ACTIVE_GUARD} RETURNING ${DRAFT_COLUMNS}`;

export const markStatus = (exec: Exec, id: string, owner: string, status: DraftStatus): Promise<DraftRow> => guarded(exec, id, `moving to ${status}`, MARK_STATUS_SQL, [id, owner, status]);

/** The fetch finished with something to draft from: keep it, so no retry fetches again. Still held: the same invocation goes on to draft. */
export const SAVE_FETCHED_SQL = `UPDATE profile_drafts
       SET status = 'drafting', sources = $3::jsonb, sources_status = $4::jsonb, usage = $5::jsonb,
           error = NULL, error_kind = NULL, next_attempt_at = NULL, updated_at = NOW()
     WHERE id = $1 AND lease_owner = $2 AND ${ACTIVE_GUARD} RETURNING ${DRAFT_COLUMNS}`;

export const saveFetched = (exec: Exec, id: string, owner: string, v: { sources: unknown; sourcesStatus: unknown; usage: unknown }): Promise<DraftRow> =>
    guarded(exec, id, 'saving the fetched sources', SAVE_FETCHED_SQL, [id, owner, JSON.stringify(v.sources), JSON.stringify(v.sourcesStatus), JSON.stringify(v.usage)]);

/**
 * A try failed in a way a later one may fix: remember what the status of each source was and what the calls answered so far,
 * count the attempt, and say when the next is due. The lease is let go with it, so the sweep can pick the draft up when due.
 */
export const SAVE_RETRY_SQL = `UPDATE profile_drafts
       SET attempts = $3, next_attempt_at = $4, error = $5, error_kind = $6,
           sources_status = COALESCE($7::jsonb, sources_status), draft = COALESCE($8::jsonb, draft), usage = $9::jsonb,
           lease_until = NULL, lease_owner = NULL, updated_at = NOW()
     WHERE id = $1 AND lease_owner = $2 AND ${ACTIVE_GUARD} RETURNING ${DRAFT_COLUMNS}`;

export const saveRetry = (
    exec: Exec, id: string, owner: string,
    v: { attempts: number; nextAttemptAt: Date; error: string; errorKind: string; sourcesStatus?: unknown; draft?: unknown; usage: unknown },
): Promise<DraftRow> =>
    guarded(exec, id, 'scheduling a retry', SAVE_RETRY_SQL, [
        id, owner, v.attempts, v.nextAttemptAt, v.error, v.errorKind,
        v.sourcesStatus === undefined ? null : JSON.stringify(v.sourcesStatus), v.draft === undefined ? null : JSON.stringify(v.draft), JSON.stringify(v.usage),
    ]);

export const FINISH_READY_SQL = `UPDATE profile_drafts
       SET status = 'ready', draft = $3::jsonb, partial = $4, usage = $5::jsonb, error = NULL, error_kind = NULL,
           next_attempt_at = NULL, lease_until = NULL, lease_owner = NULL, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND lease_owner = $2 AND ${ACTIVE_GUARD} RETURNING ${DRAFT_COLUMNS}`;

export const finishReady = (exec: Exec, id: string, owner: string, v: { draft: unknown; partial: boolean; usage: unknown }): Promise<DraftRow> =>
    guarded(exec, id, 'finishing the draft', FINISH_READY_SQL, [id, owner, JSON.stringify(v.draft), v.partial, JSON.stringify(v.usage)]);

/** A final failure. `draft` is the deterministic prefill (what code found) when there is one: the wizard still fills what it can. */
export const FINISH_FAILED_SQL = `UPDATE profile_drafts
       SET status = 'failed', error = $3, error_kind = $4, draft = $5::jsonb, sources_status = COALESCE($6::jsonb, sources_status), usage = $7::jsonb,
           next_attempt_at = NULL, lease_until = NULL, lease_owner = NULL, finished_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND lease_owner = $2 AND ${ACTIVE_GUARD} RETURNING ${DRAFT_COLUMNS}`;

export const finishFailed = (
    exec: Exec, id: string, owner: string,
    v: { error: string; errorKind: string; draft: unknown; sourcesStatus?: unknown; usage: unknown },
): Promise<DraftRow> =>
    guarded(exec, id, 'failing the draft', FINISH_FAILED_SQL, [
        id, owner, v.error, v.errorKind, v.draft === null || v.draft === undefined ? null : JSON.stringify(v.draft),
        v.sourcesStatus === undefined ? null : JSON.stringify(v.sourcesStatus), JSON.stringify(v.usage),
    ]);
