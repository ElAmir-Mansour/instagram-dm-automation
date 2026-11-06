import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { pool } from './db.js';

describe('the database pool on Vercel', () => {
    it('closes idle clients quickly, and hands the pool to attachDatabasePool so a paused instance holds no connection', () => {
        const idle = (pool as unknown as { options: { idleTimeoutMillis: number; max: number } }).options;
        assert.ok(idle.idleTimeoutMillis > 0 && idle.idleTimeoutMillis <= 10_000, `idleTimeoutMillis ${idle.idleTimeoutMillis}`);
        assert.equal(idle.max, 3);
        const source = readFileSync(new URL('./db.ts', import.meta.url), 'utf8');
        assert.match(source, /^attachDatabasePool\(pool\);$/m, 'the pool is attached once, at module load');
    });
});
