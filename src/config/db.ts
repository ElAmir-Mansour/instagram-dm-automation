import pkg from 'pg';
import type { PoolClient } from 'pg';
import { log } from '../utils/log.js';
import { countStatement, isTallying } from '../utils/timing.js';
const { Pool } = pkg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // Essential for serverless/pgBouncer
    connectionTimeoutMillis: 10000, // Wait up to 10s to connect
    idleTimeoutMillis: 30000,       // Close idle clients after 30s

    // 3, not 10. This is a per-lambda pool, and Vercel runs many lambdas concurrently —
    // so the real connection count is `max` x (concurrent instances), against a shared
    // Supabase pooler. At max: 10, twenty warm instances would ask for two hundred
    // connections, and the pooler starts refusing rather than queueing. A single request
    // here never needs more than a couple: the handlers are sequential, and the one place
    // that fans out (the job drain) is budgeted. ARCHITECTURE.md §3.3 / §7 Stage 1.
    max: 3
});

/**
 * `pg` emits 'error' on the Pool when an *idle* client fails — a routine event with Supabase
 * (connection limits, restarts, idle reaping). EventEmitter throws unhandled 'error' events,
 * so without this listener a dropped idle connection took down the whole warm instance,
 * failing any in-flight webhook with an opaque 500.
 */
pool.on('error', (err) => {
    log('error', 'db.idle_client_error', { message: err.message });
});

/**
 * Every statement this pool sends is counted against the timing tally of the work that sent it (src/utils/timing.ts): what a job's
 * `job.succeeded` and a DM's `dm.timing` report as `db_statements`, because the database is an ocean away from the functions and the
 * number of round trips is the question. Outside a tally (a dashboard request) `countStatement` does nothing. A client checked out
 * for a transaction (`pool.connect()`: the AI budget's reservation) is handed out behind a proxy that counts its statements the same
 * way, and only inside a tally; the callback form, which `pool.query` itself uses, passes straight through, so nothing is counted twice.
 * Exported for the test, which hands it a pool of its own.
 */
export function countStatements(target: { query: (...args: any[]) => unknown; connect: (...args: any[]) => unknown }): void {
    const sendStatement = target.query.bind(target);
    target.query = (...args: unknown[]) => countStatement(sendStatement(...args));

    const checkOut = target.connect.bind(target);
    target.connect = (...args: unknown[]) => {
        if (args.length > 0 || !isTallying()) return checkOut(...args);
        return (checkOut() as Promise<PoolClient>).then(countingClient);
    };
}

countStatements(pool as any);

/** A checked-out client whose `query` is counted. Everything else is the client's own, bound to it. */
function countingClient(client: PoolClient): PoolClient {
    const query = client.query as (...args: unknown[]) => unknown;
    return new Proxy(client, {
        get(target, key) {
            if (key === 'query') return (...args: unknown[]) => countStatement(query.apply(target, args));
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
