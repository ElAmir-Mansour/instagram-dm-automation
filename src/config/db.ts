import pkg from 'pg';
const { Pool } = pkg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    // Essential for serverless/pgBouncer
    connectionTimeoutMillis: 10000, // Wait up to 10s to connect
    idleTimeoutMillis: 30000,       // Close idle clients after 30s
    max: 10                         // Limit max connections
});
