/**
 * Closing the application's own pool to a script that is meant to read through `connectReadOnly` and nothing else.
 *
 * `profile/store.ts` and the settings readers import `config/db.ts`, which builds the real pool from DATABASE_URL the moment
 * it is loaded. The live scripts never hand that pool a query (they pass their read-only connection as `exec`), but "never
 * hands it one" is a property of the code as it is today. `forbidPool()` makes it a property of the run: `pool.query` and
 * `pool.connect` throw, so a builder or a reader that reaches for the pool instead of the connection it was given fails
 * loudly, by name, instead of quietly reading (or writing) production on a second connection.
 *
 * The prompt surface's stand-in for the pool (`withRows` in `promptSurface.ts`) puts back what it found, which here is
 * these stubs, so the Growth builders still run against the rows they are given and nothing else does.
 */
import { pool } from '../../config/db.js';

export const POOL_REFUSAL = 'the application pool is closed to this script: it reads only through connectReadOnly';

/** Replaces the pool's `query` and `connect` with stubs that throw. Returns the function that puts them back. */
export function forbidPool(): () => void {
    const original = { query: pool.query, connect: pool.connect };
    (pool as any).query = async (): Promise<never> => { throw new Error(`${POOL_REFUSAL} (pool.query was called)`); };
    (pool as any).connect = async (): Promise<never> => { throw new Error(`${POOL_REFUSAL} (pool.connect was called)`); };
    return () => {
        (pool as any).query = original.query;
        (pool as any).connect = original.connect;
    };
}
