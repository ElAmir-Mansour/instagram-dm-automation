/**
 * The read-only guard for the live-system scripts.
 *
 * Production's DATABASE_URL is the Supabase transaction pooler, where a session setting
 * outlives the client and lands on a server connection the app gets next. So the property
 * pinned here is not only "these scripts cannot write" but "they leave nothing behind": every
 * statement runs inside its own `BEGIN READ ONLY … ROLLBACK`, the mode is read back inside that
 * same transaction, and no `SET` ever reaches the server.
 *
 * The client is a recording stand-in, not a database: what matters is the exact sequence of
 * statements sent, which a real server would only show indirectly.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { readOnly, safeQuery } from './live.mjs';

const BEGIN = 'BEGIN READ ONLY; SHOW transaction_read_only';

/** A client that records every statement and answers the guard's own two. */
function fakeClient({ mode = 'on', beginResult, onQuery } = {}) {
    const sent = [];
    return {
        sent,
        ended: false,
        async query(arg) {
            sent.push(arg);
            if (arg === BEGIN) return beginResult ?? [{ rows: [] }, { rows: [{ transaction_read_only: mode }] }];
            if (arg === 'ROLLBACK') return { rows: [] };
            if (onQuery) return onQuery(arg);
            return { rows: [{ ok: 1 }] };
        },
        async end() { this.ended = true; },
    };
}

describe('readOnly', () => {
    it('runs each statement alone inside BEGIN READ ONLY … ROLLBACK', async () => {
        const client = fakeClient();
        const db = readOnly(client);

        const res = await db.query('SELECT count(*) FROM jobs WHERE status = $1', ['failed']);
        await db.query('SELECT 1');

        assert.deepEqual(res.rows, [{ ok: 1 }]);
        assert.deepEqual(client.sent, [
            BEGIN,
            { text: 'SELECT count(*) FROM jobs WHERE status = $1', values: ['failed'], queryMode: 'extended' },
            'ROLLBACK',
            BEGIN,
            { text: 'SELECT 1', values: [], queryMode: 'extended' },
            'ROLLBACK',
        ]);
    });

    it('uses the extended protocol even without parameters, so one call cannot carry a COMMIT', async () => {
        const client = fakeClient();
        await readOnly(client).query('SELECT 1; COMMIT; UPDATE creators SET name = name');
        assert.equal(client.sent[1].queryMode, 'extended');
    });

    it('rolls back when the statement fails, and rethrows its error', async () => {
        const client = fakeClient({ onQuery: () => { throw new Error('relation "nope" does not exist'); } });
        await assert.rejects(readOnly(client).query('SELECT * FROM nope'), /relation "nope" does not exist/);
        assert.equal(client.sent.at(-1), 'ROLLBACK');
    });

    it('refuses to send the statement when the transaction is not read-only', async () => {
        const client = fakeClient({ mode: 'off' });
        await assert.rejects(readOnly(client).query('SELECT 1'), /not read-only/);
        assert.deepEqual(client.sent, [BEGIN, 'ROLLBACK']);
    });

    it('fails closed when the check comes back in an unexpected shape', async () => {
        for (const beginResult of [{ rows: [{ transaction_read_only: 'on' }] }, [{ rows: [] }], []]) {
            const client = fakeClient({ beginResult });
            await assert.rejects(readOnly(client).query('SELECT 1'), /not read-only/);
            assert.deepEqual(client.sent, [BEGIN, 'ROLLBACK']);
        }
    });

    it('sends no SET, before, between or after statements', async () => {
        const client = fakeClient();
        const db = readOnly(client);
        await db.query('SELECT 1');
        await db.end();

        assert.equal(client.ended, true);
        const text = client.sent.map((s) => (typeof s === 'string' ? s : s.text)).join('\n');
        assert.doesNotMatch(text, /\bSET\b/i);
    });

    it('keeps a run going after a failed check, still wrapping the next statement', async () => {
        let calls = 0;
        const client = fakeClient({ onQuery: () => { if (calls++ === 0) throw new Error('boom'); return { rows: [{ n: 2 }] }; } });
        const db = readOnly(client);

        assert.deepEqual(await safeQuery(db, 'SELECT bad'), { rows: [], error: 'boom' });
        assert.deepEqual(await safeQuery(db, 'SELECT good'), { rows: [{ n: 2 }] });
        assert.deepEqual(client.sent.filter((s) => typeof s === 'string'), [BEGIN, 'ROLLBACK', BEGIN, 'ROLLBACK']);
    });
});

describe('scripts/', () => {
    // A session-level read-only default on the transaction pooler outlives the script and
    // breaks writes for whichever app request gets that server connection next. `SET` without
    // SESSION is session-level too; only a transaction's own READ ONLY is safe there.
    it('never sets default_transaction_read_only at session level', () => {
        const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
        const files = readdirSync(root, { recursive: true })
            .filter((f) => /\.(mjs|js|ts)$/.test(f) && !f.endsWith('.test.mjs'));
        assert.ok(files.includes('diagnose.mjs'), 'the scan found no scripts');

        const offenders = files.filter((f) =>
            /SET\s+(SESSION\s+)?default_transaction_read_only\s*(=|TO)\s*'?on/i.test(readFileSync(path.join(root, f), 'utf8')));
        assert.deepEqual(offenders, []);
    });
});
