import pkg from 'pg';
import { log } from '../utils/log.js';
const { Pool } = pkg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // Essential for serverless/pgBouncer
    connectionTimeoutMillis: 10000, // Wait up to 10s to connect
    idleTimeoutMillis: 30000,       // Close idle clients after 30s
    max: 10                         // Limit max connections
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
