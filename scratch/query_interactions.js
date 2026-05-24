import pg from 'pg';

const connectionString = "postgresql://postgres.qgrpmahkhkmtqljpyhgm:%40Autoresponse%40123@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true";

async function run() {
    const pool = new pg.Pool({ connectionString });
    try {
        console.log('Querying recent interactions...');
        const res = await pool.query('SELECT * FROM interactions ORDER BY timestamp DESC LIMIT 10');
        console.log('Recent Interactions:');
        console.dir(res.rows, { depth: null });
    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

run();
