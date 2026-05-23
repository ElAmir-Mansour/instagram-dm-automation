import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const migrations = [
    '../src/config/migration_v4_campaign_active.sql',
    '../src/config/migration_v5_indexes.sql'
];

async function run() {
    try {
        console.log('Connecting to database...');
        const client = await pool.connect();
        
        for (const relativePath of migrations) {
            const fullPath = path.join(__dirname, relativePath);
            console.log('Reading migration file:', fullPath);
            const sql = fs.readFileSync(fullPath, 'utf8');
            console.log(`Running migration: ${path.basename(fullPath)}...`);
            await client.query(sql);
            console.log(`✅ Applied ${path.basename(fullPath)} successfully.`);
        }
        
        client.release();
    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        await pool.end();
    }
}

run();
