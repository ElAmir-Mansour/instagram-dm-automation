/**
 * Plumbing the Studio services share: the error they throw, the transaction helper, and the
 * small validators every route body goes through.
 */
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { pool } from '../../config/db.js';
import type { ErrorCode, ErrorParams } from '../errorCodes.js';

/**
 * A refusal the route answers as-is: `status` and `{ error, problems?, code?, params? }` (STUDIO.md §4). A refusal with a
 * `code` goes out through `sendError` (src/services/errorCodes.ts): the same `error` string as ever, plus `code` and `params`
 * for the dashboard to translate. One without a code is answered exactly as it always was.
 *
 * Thrown from the services rather than returned, so a check deep inside a transaction rolls
 * everything back on its way out instead of each caller remembering to.
 */
export class StudioError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly problems?: string[],
        /** A machine-readable reason the route sends beside `error`: a key of ERROR_CODES, e.g. `NEEDS_API_BRAIN`. */
        readonly code?: ErrorCode,
        /** Values the translated sentence for `code` interpolates. Plain data, never a secret. */
        readonly params?: ErrorParams
    ) {
        super(message);
        this.name = 'StudioError';
    }
}

/** A refusal made of validation problems: one sentence when there is one, a count otherwise. */
export function problemsError(problems: string[], what: string, status = 400, code?: ErrorCode, params?: ErrorParams): StudioError {
    const message = problems.length === 1 ? problems[0]! : `${problems.length} problems with ${what}.`;
    return new StudioError(status, message, problems, code, params);
}

/** The pool, or a client inside a transaction — every write helper here takes either. */
export interface Exec {
    query<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * BEGIN … COMMIT on one client, ROLLBACK on any throw.
 *
 * `pool.connect()` rather than `pool.query('BEGIN')`: each `pool.query` may land on a
 * different connection, and a transaction spread across two connections is no transaction.
 */
export async function withTransaction<T>(fn: (client: Exec) => Promise<T>): Promise<T> {
    const client: PoolClient = await pool.connect();
    try {
        await client.query('BEGIN');
        const out = await fn(client as unknown as Exec);
        await client.query('COMMIT');
        return out;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * One tenant's campaign-and-post writes, one at a time: the Studio's schedule and the Monteur's
 * approve both choose a slot or plan a campaign and then insert, so two at once could take the
 * same slot or create two campaigns on one keyword. Held until the transaction ends.
 */
export async function lockTenantPublishing(exec: Exec, creatorId: string): Promise<void> {
    await exec.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`publishing:${creatorId}`]);
}

/**
 * The mutex every writer of a tenant's settings takes before it reads a settings row: the profile store's save
 * (which mirrors into `studio_settings` and `growth_settings`) and the Studio and Growth settings writers (which
 * read a row, change it, and write the whole row back). Without it a settings write that read before a save and
 * wrote after it would put the stale row back over the mirror, and a rollback would find the old values.
 *
 * It is the tenant's `creators` row, `FOR NO KEY UPDATE`, held until the transaction ends. That conflicts with itself
 * and with every UPDATE of the row, but not with the `FOR KEY SHARE` that an insert into a table referencing
 * `creators` takes, so a webhook writing an interaction for the tenant is never held up behind a save. A row that
 * does not exist locks nothing, which is why this and not the settings row is the mutex: a tenant's first settings
 * write has no settings row yet.
 *
 * Lock order, everywhere: creators, then creator_profiles, then studio_settings, then growth_settings.
 */
export async function lockTenantSettings(exec: Exec, creatorId: string): Promise<void> {
    await exec.query('SELECT id FROM creators WHERE id = $1 FOR NO KEY UPDATE', [creatorId]);
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A route's `:id`, or a 404. Checked before any query because Postgres answers a malformed
 * uuid literal with an error, which would surface as a 500 rather than "no such thing".
 */
export function requireId(raw: unknown, what: string): string {
    if (typeof raw !== 'string' || !UUID_PATTERN.test(raw)) throw new StudioError(404, `No such ${what}.`);
    return raw.toLowerCase();
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed text, cut to `max` UTF-16 units, or null when absent or blank. */
export function clipText(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return text ? text.slice(0, max) : null;
}

export function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/** Order-preserving de-duplication. */
export function unique<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}

/**
 * Said when a Studio table or column is missing, instead of an opaque 500. v24 (the Monteur) adds
 * a settings column every Studio route reads, so either migration can be the one missing.
 */
export const STUDIO_MIGRATION_HINT =
    'The database is missing migration v21 or v24 (src/config/migration_v21_studio.sql, migration_v24_monteur.sql). '
    + 'Apply them with `npm run migrate`, then reload.';
