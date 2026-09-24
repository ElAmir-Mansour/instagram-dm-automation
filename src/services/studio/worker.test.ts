/**
 * Worker credentials. The token is the only thing a worker carries, and it decides which
 * tenant everything the worker does lands in, so what matters here is: a missing or wrong
 * token resolves to nothing, the right one to exactly its own tenant, and the token itself is
 * never written anywhere — only its hash.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { StudioError } from './common.js';
import {
    authenticateWorker, createWorker, hashWorkerToken, MAX_ACTIVE_WORKERS, mintWorkerToken, revokeWorker,
    WORKER_ONLINE_WINDOW_MS, workerSummary,
} from './worker.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const WORKER_A = '44444444-4444-4444-8444-444444444444';

let statements: { sql: string; params: unknown[] }[] = [];
let respond: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] });
const originalQuery = pool.query;

beforeEach(() => {
    statements = [];
    respond = () => ({ rows: [] });
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        const flat = sql.replace(/\s+/g, ' ');
        statements.push({ sql: flat, params });
        const r = respond(flat, params);
        return { rows: r.rows, rowCount: r.rows.length };
    };
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
});

describe('worker tokens', () => {
    it('are fresh each time, recognisable, and hashed with SHA-256', () => {
        const a = mintWorkerToken();
        const b = mintWorkerToken();
        assert.notEqual(a, b);
        assert.match(a, /^sws_[A-Za-z0-9_-]{43}$/);
        assert.match(hashWorkerToken(a), /^[0-9a-f]{64}$/);
        assert.notEqual(hashWorkerToken(a), hashWorkerToken(b));
    });
});

describe('authenticateWorker', () => {
    it('refuses a missing or non-Bearer header without touching the database', async () => {
        assert.deepEqual(await authenticateWorker(undefined), { ok: false, reason: 'missing' });
        assert.deepEqual(await authenticateWorker(''), { ok: false, reason: 'missing' });
        assert.deepEqual(await authenticateWorker('Basic abc'), { ok: false, reason: 'missing' });
        assert.deepEqual(await authenticateWorker('Bearer    '), { ok: false, reason: 'missing' });
        assert.equal(statements.length, 0);
    });

    it('refuses a token no live worker holds', async () => {
        const result = await authenticateWorker(`Bearer ${mintWorkerToken()}`);
        assert.deepEqual(result, { ok: false, reason: 'invalid' });
    });

    it('resolves the right token to its worker and tenant, and records the call in the same statement', async () => {
        const token = mintWorkerToken();
        respond = (sql, params) => (/UPDATE studio_workers/.test(sql) && params[0] === hashWorkerToken(token)
            ? { rows: [{ id: WORKER_A, creator_id: TENANT_A, name: 'Mac Studio' }] }
            : { rows: [] });

        const result = await authenticateWorker(`Bearer ${token}`);
        assert.deepEqual(result, { ok: true, worker: { id: WORKER_A, creatorId: TENANT_A, name: 'Mac Studio' } });

        const [lookup] = statements;
        assert.equal(statements.length, 1, 'one round trip: find and touch together');
        assert.match(lookup!.sql, /SET last_seen_at = NOW\(\)/);
        // A revoked worker, and a worker of a deactivated tenant, must match nothing.
        assert.match(lookup!.sql, /w\.revoked_at IS NULL/);
        assert.match(lookup!.sql, /c\.is_active = TRUE/);
        // The token is looked up by its hash; the token itself never reaches the database.
        assert.deepEqual(lookup!.params, [hashWorkerToken(token)]);
    });
});

describe('createWorker', () => {
    it('requires a name', async () => {
        await assert.rejects(createWorker(TENANT_A, '  '), (err: unknown) => err instanceof StudioError && err.status === 400);
        await assert.rejects(createWorker(TENANT_A, undefined), (err: unknown) => err instanceof StudioError && err.status === 400);
    });

    it('refuses another worker once the tenant has the maximum', async () => {
        respond = (sql) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ n: MAX_ACTIVE_WORKERS }] } : { rows: [] });
        await assert.rejects(createWorker(TENANT_A, 'Mac'), (err: unknown) => err instanceof StudioError && err.status === 409);
        assert.ok(!statements.some((s) => /INSERT/.test(s.sql)));
    });

    it('returns the token once, and writes only its hash', async () => {
        respond = (sql, params) => {
            if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: 0 }] };
            if (/INSERT INTO studio_workers/.test(sql)) {
                return { rows: [{ id: WORKER_A, name: params[1], last_seen_at: null, created_at: new Date() }] };
            }
            return { rows: [] };
        };
        const { worker, token } = await createWorker(TENANT_A, ' Mac Studio ');
        assert.equal(worker.name, 'Mac Studio');
        assert.equal(worker.online, false);
        assert.ok(!('token_hash' in worker), 'the hash is not served either');

        const insert = statements.find((s) => /INSERT INTO studio_workers/.test(s.sql))!;
        assert.deepEqual(insert.params, [TENANT_A, 'Mac Studio', hashWorkerToken(token)]);
        assert.ok(!statements.some((s) => s.params.includes(token)), 'the token is in no statement at all');
    });
});

describe('revokeWorker', () => {
    it('is scoped to the tenant, and 404s a worker that is gone or already revoked', async () => {
        await assert.rejects(revokeWorker(TENANT_A, WORKER_A), (err: unknown) => err instanceof StudioError && err.status === 404);
        const [update] = statements;
        assert.match(update!.sql, /WHERE id = \$1 AND creator_id = \$2 AND revoked_at IS NULL/);
        assert.deepEqual(update!.params, [WORKER_A, TENANT_A]);
    });
});

describe('workerSummary', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');

    it('is online within 90 seconds of the last call, and offline after', async () => {
        respond = () => ({ rows: [{ name: 'Mac', last_seen_at: new Date(now - 30_000) }] });
        assert.deepEqual(await workerSummary(TENANT_A, now), {
            online: true, lastSeen: new Date(now - 30_000).toISOString(), name: 'Mac',
        });
        respond = () => ({ rows: [{ name: 'Mac', last_seen_at: new Date(now - WORKER_ONLINE_WINDOW_MS - 1) }] });
        assert.equal((await workerSummary(TENANT_A, now)).online, false);
    });

    it('reads as offline, with nothing to name, when the tenant has no worker', async () => {
        assert.deepEqual(await workerSummary(TENANT_A, now), { online: false, lastSeen: null, name: null });
        assert.match(statements[0]!.sql, /revoked_at IS NULL/);
    });
});
