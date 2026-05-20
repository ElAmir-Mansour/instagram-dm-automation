#!/usr/bin/env node
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

const migrationSqlPath = path.join(__dirname, '../src/config/schema_migration_v2.sql');

async function run() {
    try {
        console.log('Reading migration file:', migrationSqlPath);
        const sql = fs.readFileSync(migrationSqlPath, 'utf8');
        console.log('Connecting to database...');
        const client = await pool.connect();
        console.log('Running migration...');
        await client.query(sql);
        console.log('✅ Migration applied successfully.');
        client.release();
    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        await pool.end();
    }
}

run();
