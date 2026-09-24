/**
 * Studio workers and their credentials (STUDIO.md §5, §10).
 *
 * A worker is a machine that polls this app for jobs: a Mac today, perhaps a hosted renderer
 * later. It carries no session, only a bearer token, and the token RESOLVES ITS TENANT. The
 * worker claims only that tenant's jobs, its uploads are stored as that tenant's, and every
 * result it posts is applied to that tenant's rows. Without that binding, a scan queued by one
 * tenant could be run against another tenant's course folder, and the lessons upserted into
 * whoever asked.
 *
 * Only the SHA-256 of a token is stored. The token is shown once, when it is created. A
 * token is found by its hash, so there is no string comparison here to time: learning
 * anything from the lookup would need a SHA-256 preimage.
 */
import crypto from 'crypto';
import { queryOne, queryRows } from '../../db/query.js';
import type { StudioWorkerRow } from '../../db/rows.js';
import { clipText, StudioError } from './common.js';

/** "Online" means an authenticated call within this long. The worker polls every 5–30s. */
export const WORKER_ONLINE_WINDOW_MS = 90_000;

/** Active credentials per tenant. Each one is a standing key to the tenant's media store. */
export const MAX_ACTIVE_WORKERS = 10;

/** Recognisable in a config file or a leaked log line, like `ghp_` is. */
const TOKEN_PREFIX = 'sws_';

export function mintWorkerToken(): string {
    return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

export function hashWorkerToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
}

export interface AuthenticatedWorker {
    id: string;
    creatorId: string;
    name: string;
}

export type WorkerAuth =
    | { ok: true; worker: AuthenticatedWorker }
    | { ok: false; reason: 'missing' | 'invalid' };

/**
 * Resolve an `Authorization` header to a worker, and record that it called.
 *
 * One statement does both, so "every worker call updates last_seen_at" cannot be forgotten by
 * a route. A revoked worker, or one whose tenant has been deactivated, matches nothing.
 */
export async function authenticateWorker(authorization: string | undefined): Promise<WorkerAuth> {
    // Only a real `Bearer ` prefix counts, as in requireAuth.
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!presented) return { ok: false, reason: 'missing' };

    const row = await queryOne<Pick<StudioWorkerRow, 'id' | 'creator_id' | 'name'>>(
        `UPDATE studio_workers w
            SET last_seen_at = NOW()
           FROM creators c
          WHERE w.token_hash = $1
            AND w.revoked_at IS NULL
            AND c.id = w.creator_id
            AND c.is_active = TRUE
      RETURNING w.id, w.creator_id, w.name`,
        [hashWorkerToken(presented)]
    );
    if (!row) return { ok: false, reason: 'invalid' };
    return { ok: true, worker: { id: row.id, creatorId: row.creator_id, name: row.name } };
}

export interface WorkerView {
    id: string;
    name: string;
    last_seen_at: Date | null;
    created_at: Date;
    online: boolean;
}

type WorkerColumns = Pick<StudioWorkerRow, 'id' | 'name' | 'last_seen_at' | 'created_at'>;
const WORKER_COLUMNS = 'id, name, last_seen_at, created_at';

function isOnline(lastSeen: Date | null, now: number): boolean {
    return lastSeen !== null && now - new Date(lastSeen).getTime() <= WORKER_ONLINE_WINDOW_MS;
}

export function presentWorker(row: WorkerColumns, now: number = Date.now()): WorkerView {
    return {
        id: row.id,
        name: row.name,
        last_seen_at: row.last_seen_at,
        created_at: row.created_at,
        online: isOnline(row.last_seen_at, now),
    };
}

/** The tenant's live workers, newest first. Revoked ones are gone for every purpose. */
export async function listWorkers(creatorId: string): Promise<WorkerView[]> {
    const rows = await queryRows<WorkerColumns>(
        `SELECT ${WORKER_COLUMNS} FROM studio_workers
          WHERE creator_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC`,
        [creatorId]
    );
    const now = Date.now();
    return rows.map((row) => presentWorker(row, now));
}

/** A new worker and its token. The token is in this return value and nowhere else, ever. */
export async function createWorker(creatorId: string, rawName: unknown): Promise<{ worker: WorkerView; token: string }> {
    const name = clipText(rawName, 100);
    if (!name) throw new StudioError(400, 'Name the worker, e.g. "Mac Studio".');

    const active = await queryOne<{ n: number }>(
        'SELECT COUNT(*)::int AS n FROM studio_workers WHERE creator_id = $1 AND revoked_at IS NULL',
        [creatorId]
    );
    if ((active?.n ?? 0) >= MAX_ACTIVE_WORKERS) {
        throw new StudioError(409, `This account already has ${MAX_ACTIVE_WORKERS} workers. Revoke one you no longer use first.`);
    }

    const token = mintWorkerToken();
    const row = await queryOne<WorkerColumns>(
        `INSERT INTO studio_workers (creator_id, name, token_hash)
         VALUES ($1, $2, $3)
         RETURNING ${WORKER_COLUMNS}`,
        [creatorId, name, hashWorkerToken(token)]
    );
    if (!row) throw new Error('studio_workers insert returned no row.');
    return { worker: presentWorker(row), token };
}

/** Revoke. The token stops working with this write; the row stays as the record of it. */
export async function revokeWorker(creatorId: string, workerId: string): Promise<WorkerView> {
    const row = await queryOne<WorkerColumns>(
        `UPDATE studio_workers SET revoked_at = NOW()
          WHERE id = $1 AND creator_id = $2 AND revoked_at IS NULL
      RETURNING ${WORKER_COLUMNS}`,
        [workerId, creatorId]
    );
    if (!row) throw new StudioError(404, 'No such worker.');
    return presentWorker(row);
}

/** The status card's `worker`: the most recently seen live worker. */
export async function workerSummary(
    creatorId: string, now: number = Date.now()
): Promise<{ online: boolean; lastSeen: string | null; name: string | null }> {
    const row = await queryOne<Pick<StudioWorkerRow, 'name' | 'last_seen_at'>>(
        `SELECT name, last_seen_at FROM studio_workers
          WHERE creator_id = $1 AND revoked_at IS NULL
          ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
          LIMIT 1`,
        [creatorId]
    );
    if (!row) return { online: false, lastSeen: null, name: null };
    return {
        online: isOnline(row.last_seen_at, now),
        lastSeen: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        name: row.name,
    };
}
