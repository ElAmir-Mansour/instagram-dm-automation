import pg from 'pg';

const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL
});

async function main() {
    try {
        const res = await pool.query('SELECT id, status, error_log FROM scheduled_posts ORDER BY created_at DESC LIMIT 5');
        console.log('--- POST STATUS ---');
        console.log(JSON.stringify(res.rows, null, 2));
    } catch (err) {
        console.error('Error executing query:', err);
    } finally {
        await pool.end();
    }
}

main();
