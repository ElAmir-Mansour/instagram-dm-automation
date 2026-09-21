import pkg from 'pg';
import { log } from '../utils/log.js';
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
