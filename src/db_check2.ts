import { pool } from './config/db.js';

async function checkDb() {
    console.log('🔍 Querying DB for new messages...');
    try {
        const messages = await pool.query("SELECT id, conversation_id, direction, text, created_at FROM messages WHERE created_at > NOW() - INTERVAL '10 minutes' ORDER BY created_at DESC LIMIT 5");
        console.log('\n📨 Messages in last 10m:', messages.rows);
    } catch (err) {
        console.error('❌ DB Query Error:', err);
    } finally {
        await pool.end();
    }
}

checkDb();
