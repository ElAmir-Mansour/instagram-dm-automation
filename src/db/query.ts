/**
 * Typed query helpers.
 *
 * `pool.query(...)` returns `QueryResult<any>`, and `any` is contagious: every value read out
 * of a row is `any`, every function it is passed to accepts it, and `strict` stops meaning
 * anything the moment a request touches the database. `@types/pg` does accept a row generic
 * — `pool.query<CreatorRow>(...)` — but nothing makes a call site supply one, so in practice
 * none did.
 *
 * These helpers make the generic the only way through, and fold in the two patterns that were
 * repeated at nearly every call site:
 *
 *   - `result.rows[0]` is `T | undefined` under `noUncheckedIndexedAccess`, so every caller
 *     wrote `?.` or `!` — the first hides a missing row, the second asserts it away.
 *     `queryOne` returns `T | null` and says so.
 *   - "did this statement affect anything" was `(result.rowCount ?? 0) === 0`, spelled
 *     slightly differently each time. `queryCount` returns a number.
 *
 * This is deliberately not an ORM or a query builder. The SQL in this codebase is good, it is
 * reviewable, and several statements (the `ON CONFLICT` idempotency claims, the atomic
 * publish claim) depend on Postgres specifics a builder would obscure. The problem was never
 * the SQL — it was that the results were untyped.
 *
 * The type parameter is an assertion, not a validation: nothing checks at runtime that the
 * columns selected match the type named. What it buys is that the claim is written down once,
 * next to the query, where a reviewer can check it against the SQL.
 */
import type { QueryResultRow } from 'pg';
import { pool } from '../config/db.js';

/** Values `pg` accepts as bound parameters. */
export type SqlParam = string | number | boolean | Date | Buffer | null | undefined | readonly unknown[];

/** All matching rows, typed. */
export async function queryRows<T extends QueryResultRow>(
    sql: string,
    params: readonly SqlParam[] = []
): Promise<T[]> {
    const result = await pool.query<T>(sql, params as unknown[]);
    return result.rows;
}

/**
 * The first row, or null.
 *
 * Returning null rather than `undefined` is a small deliberate choice: `undefined` is what an
 * out-of-range index gives you, so it reads as "the query returned fewer rows than expected",
 * while `null` reads as "the query answered, and the answer is nothing". The distinction
 * matters at the call sites that treat a missing row as a real state — no creator configured,
 * no AI agent set up — rather than as an error.
 */
export async function queryOne<T extends QueryResultRow>(
    sql: string,
    params: readonly SqlParam[] = []
): Promise<T | null> {
    const result = await pool.query<T>(sql, params as unknown[]);
    return result.rows[0] ?? null;
}

/**
 * Rows affected by an INSERT/UPDATE/DELETE.
 *
 * Note this is `rowCount`, not `rows.length`: a statement with no RETURNING clause reports
 * the former and has none of the latter. Several idempotency checks in this codebase depend
 * on the difference.
 */
export async function queryCount(sql: string, params: readonly SqlParam[] = []): Promise<number> {
    const result = await pool.query(sql, params as unknown[]);
    return result.rowCount ?? 0;
}
