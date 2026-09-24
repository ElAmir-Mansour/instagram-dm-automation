/**
 * Plumbing the Studio services share: the error they throw, the transaction helper, and the
 * small validators every route body goes through.
 */
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { pool } from '../../config/db.js';

/**
 * A refusal the route answers as-is: `status` and `{ error, problems? }` (STUDIO.md §4).
 *
 * Thrown from the services rather than returned, so a check deep inside a transaction rolls
 * everything back on its way out instead of each caller remembering to.
 */
export class StudioError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly problems?: string[]
    ) {
        super(message);
        this.name = 'StudioError';
    }
}

/** A refusal made of validation problems: one sentence when there is one, a count otherwise. */
export function problemsError(problems: string[], what: string, status = 400): StudioError {
    const message = problems.length === 1 ? problems[0]! : `${problems.length} problems with ${what}.`;
    return new StudioError(status, message, problems);
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

/** Said when a Studio table is missing, instead of an opaque 500. */
export const STUDIO_MIGRATION_HINT =
    'The database is missing migration v21 (src/config/migration_v21_studio.sql). '
    + 'Apply it with `npm run migrate`, then reload.';
