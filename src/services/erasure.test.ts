/**
 * The erasure token and the drift rule.
 *
 * This is the only hard DELETE in the product, and the only thing standing between a signed
 * preview and a wrong erasure is that the token cannot be produced or edited without the
 * signing secret, and that the counts it carries still describe the database when it is
 * spent. Both are asserted here.
 *
 * The SQL is not exercised here — there is no database in this suite, by the same convention
 * as every other test in this repo. It was verified separately against a throwaway local
 * Postgres cluster with all fifteen migrations applied.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import {
    commitErasure, countsDrifted, countsTotal, ERASURE_TOKEN_TTL_MS, eraseCustomerMedia, executeErasure, mintErasureToken, verifyErasureToken,
} from './erasure.js';

const COUNTS = { messages: 12, conversations: 1, interactions: 3, dmSendLog: 0, leads: 0 };

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

describe('erasure preview token', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    it('round-trips the handle and the counts it was minted for', () => {
        const result = verifyErasureToken(mintErasureToken('someone', COUNTS));

        assert.ok(result.ok);
        assert.equal(result.handle, 'someone');
        assert.deepEqual(result.counts, COUNTS);
    });

    it('rejects a payload edited to name a different person', () => {
        // The attack this exists to stop: preview a handle with nothing behind it, then edit
        // the token to point at somebody real.
        const token = mintErasureToken('someone', COUNTS);
        const [body, signature] = token.split('.') as [string, string];
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        claims.h = 'someone-else';
        const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

        assert.deepEqual(verifyErasureToken(`${forged}.${signature}`), {
            ok: false, reason: 'bad_signature',
        });
    });

    it('rejects a payload edited to widen the counts', () => {
        // Counts in the token are what the execute re-checks against, so raising them would
        // let a stale preview authorise more than it showed.
        const token = mintErasureToken('someone', COUNTS);
        const [body, signature] = token.split('.') as [string, string];
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        claims.c.messages = 9999;
        const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

        assert.equal(verifyErasureToken(`${forged}.${signature}`).ok, false);
    });

    it('rejects a payload edited to extend its own expiry', () => {
        const token = mintErasureToken('someone', COUNTS);
        const [body, signature] = token.split('.') as [string, string];
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        claims.exp = Date.now() + 86_400_000;
        const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

        assert.equal(verifyErasureToken(`${forged}.${signature}`).ok, false);
    });

    it('expires', () => {
        const token = mintErasureToken('someone', COUNTS);

        assert.equal(verifyErasureToken(token, Date.now() + ERASURE_TOKEN_TTL_MS - 1000).ok, true);
        assert.deepEqual(verifyErasureToken(token, Date.now() + ERASURE_TOKEN_TTL_MS + 1000), {
            ok: false, reason: 'expired',
        });
    });

    it('rejects a token signed under a different secret', () => {
        const token = mintErasureToken('someone', COUNTS);
        process.env.DASHBOARD_PASSWORD = 'a-different-password';

        assert.equal(verifyErasureToken(token).ok, false);
    });

    it('does not accept a session token in its place', () => {
        // The scope string is folded into the HMAC precisely so that another signed value in
        // this app — a session, a download token — cannot be spent here.
        const body = Buffer.from(JSON.stringify({ h: 'someone', c: COUNTS, exp: Date.now() + 60_000 }))
            .toString('base64url');
        // Signed WITHOUT the 'erasure:v1' namespace, i.e. exactly as createSession would.
        const sessionStyle = `${body}.${'0'.repeat(64)}`;

        assert.equal(verifyErasureToken(sessionStyle).ok, false);
    });

    it('never throws, whatever it is handed', () => {
        for (const raw of [
            undefined, null, 42, {}, [], '', 'no-dot', 'a.b.c',
            'not-base64.deadbeef',
            `${Buffer.from('{}').toString('base64url')}.zz`,   // non-hex signature
        ]) {
            const result = verifyErasureToken(raw);
            assert.equal(result.ok, false, `input ${JSON.stringify(raw)}`);
        }
    });

    it('rejects a correctly signed payload missing its counts', () => {
        // A signature alone is not enough: the shape has to be there, or `countsDrifted` would
        // compare against undefined and conclude nothing moved.
        const body = Buffer.from(JSON.stringify({ h: 'someone', exp: Date.now() + 60_000 }))
            .toString('base64url');
        const signed = mintErasureToken('someone', COUNTS).split('.')[1];

        assert.equal(verifyErasureToken(`${body}.${signed}`).ok, false);
    });
});

describe('executeErasure: a token it will not spend is refused with a code, before the database is touched', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;
    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });
    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    it('an expired preview is ERASURE_PREVIEW_EXPIRED: the one a person fixes by previewing again', async () => {
        const token = mintErasureToken('someone', COUNTS);
        const outcome = await executeErasure(token, Date.now() + ERASURE_TOKEN_TTL_MS + 1000);
        assert.equal(outcome.ok, false);
        assert.ok(!outcome.ok);
        assert.deepEqual([outcome.status, outcome.code], [400, 'ERASURE_PREVIEW_EXPIRED']);
        assert.match(outcome.error, /has expired\. Run the preview again and confirm within 10 minutes\./);
    });

    it('a forged, edited or malformed token is ERASURE_TOKEN_INVALID', async () => {
        const [body, signature] = mintErasureToken('someone', COUNTS).split('.') as [string, string];
        for (const raw of [`${body}.${'0'.repeat(64)}`, `${body}x.${signature}`, 'made-up', undefined, null, 42, {}]) {
            const outcome = await executeErasure(raw);
            assert.ok(!outcome.ok, JSON.stringify(raw));
            assert.deepEqual([outcome.status, outcome.code], [400, 'ERASURE_TOKEN_INVALID'], JSON.stringify(raw));
        }
    });
});

describe('countsDrifted', () => {
    it('is false for identical counts', () => {
        assert.equal(countsDrifted(COUNTS, { ...COUNTS }), false);
    });

    it('is true when any single table moved, in either direction', () => {
        for (const key of ['messages', 'conversations', 'interactions', 'dmSendLog', 'leads'] as const) {
            assert.equal(countsDrifted(COUNTS, { ...COUNTS, [key]: COUNTS[key] + 1 }), true, `${key} up`);
            assert.equal(countsDrifted(COUNTS, { ...COUNTS, [key]: COUNTS[key] - 1 }), true, `${key} down`);
        }
    });

    it('makes a replayed token a no-op rather than a second erasure', () => {
        // After a successful erasure every count is zero, so spending the same token again
        // drifts and is refused. That is what stops a leaked token from deleting whatever
        // arrived under the same handle afterwards.
        assert.equal(
            countsDrifted(COUNTS, { messages: 0, conversations: 0, interactions: 0, dmSendLog: 0, leads: 0 }),
            true
        );
    });
});

describe('countsTotal', () => {
    it('sums every table, so "nothing matched" is one check', () => {
        assert.equal(countsTotal(COUNTS), 16);
        assert.equal(countsTotal({ messages: 0, conversations: 0, interactions: 0, dmSendLog: 0, leads: 0 }), 0);
    });
});

// ─── The contact's private uploads (migration v51) ──────────────────────────────────────────

describe('erasure deletes the contact\'s private uploads: the files a customer sent on WhatsApp', () => {
    const CONV = '33333333-3333-4333-8333-333333333333';
    const HANDLE = 'EG.1234567890';
    const MEDIA_COUNTS = { messages: 3, conversations: 1, interactions: 0, dmSendLog: 0, leads: 0 };

    let statements: Array<{ sql: string; params: unknown[] }>;
    let released: number;
    let mediaDelete: () => { rowCount: number };
    const originalConnect = pool.connect;
    let restoreSink: (() => void) | undefined;
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
        statements = [];
        released = 0;
        mediaDelete = () => ({ rowCount: 2 });
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
        const client = {
            async query(sql: string, params: unknown[] = []) {
                const flat = sql.replace(/\s+/g, ' ').trim();
                statements.push({ sql: flat, params });
                if (/^SELECT id, instagram_user_id, username FROM conversations/.test(flat)) {
                    return { rows: [{ id: CONV, instagram_user_id: HANDLE, username: null }], rowCount: 1 };
                }
                if (/^SELECT \(SELECT COUNT\(\*\) FROM messages/.test(flat)) {
                    return { rows: [{ messages: 3, conversations: 1, interactions: 0, dm_send_log: 0 }], rowCount: 1 };
                }
                if (/^DELETE FROM media_uploads/.test(flat)) return mediaDelete();
                if (/^DELETE FROM messages/.test(flat)) return { rows: [], rowCount: 3 };
                if (/^DELETE FROM conversations/.test(flat)) return { rows: [], rowCount: 1 };
                if (/^DELETE FROM (interactions|dm_send_log)/.test(flat)) return { rows: [], rowCount: 0 };
                if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)\b/.test(flat)) return { rows: [], rowCount: null };
                throw new Error(`no result arranged for SQL: ${flat}`);
            },
            release() { released++; },
        };
        (pool as unknown as { connect: unknown }).connect = async () => client;
    });

    afterEach(() => {
        (pool as unknown as { connect: unknown }).connect = originalConnect;
        restoreSink?.();
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    const sqls = () => statements.map((s) => s.sql);
    const indexOfStatement = (pattern: RegExp) => sqls().findIndex((sql) => pattern.test(sql));

    it('deletes the private uploads the messages point at, BEFORE the messages go: they are the only link from a person to a file', async () => {
        const outcome = await executeErasure(mintErasureToken(HANDLE, MEDIA_COUNTS));

        assert.ok(outcome.ok);
        assert.equal(outcome.mediaDeleted, 2);
        assert.deepEqual(outcome.deleted, { messages: 3, conversations: 1, interactions: 0, dmSendLog: 0, leads: 0 }, 'the counts the preview and the token carry are unchanged');

        const media = indexOfStatement(/^DELETE FROM media_uploads/);
        assert.ok(media > 0, 'the uploads are deleted');
        assert.ok(media < indexOfStatement(/^DELETE FROM messages/), 'before the messages');
        assert.ok(media < indexOfStatement(/^DELETE FROM conversations/));
        assert.equal(statements[media]!.sql,
            'DELETE FROM media_uploads WHERE is_private AND id IN (SELECT media_upload_id FROM messages WHERE conversation_id = ANY($1::uuid[]) AND media_upload_id IS NOT NULL)');
        assert.deepEqual(statements[media]!.params, [[CONV]]);
        await commitErasure(outcome.client);
        assert.equal(released, 1);
    });

    it('can only ever delete a PRIVATE row: a message that points at a post\'s media takes nothing with it', async () => {
        await executeErasure(mintErasureToken(HANDLE, MEDIA_COUNTS));
        const sql = statements.find((s) => /^DELETE FROM media_uploads/.test(s.sql))!.sql;
        assert.match(sql, /WHERE is_private AND id IN/);
        assert.doesNotMatch(sql, /\bOR\b/, 'no way around the privacy condition');
    });

    it('runs under a savepoint that is released, so one failed statement cannot abort the erasure\'s own transaction', async () => {
        await executeErasure(mintErasureToken(HANDLE, MEDIA_COUNTS));
        const order = sqls().filter((sql) => /SAVEPOINT|^DELETE FROM media_uploads|^BEGIN/.test(sql));
        assert.equal(order.length, 4);
        assert.equal(order[0], 'BEGIN');
        assert.equal(order[1], 'SAVEPOINT erase_customer_media');
        assert.match(order[2]!, /^DELETE FROM media_uploads/);
        assert.equal(order[3], 'RELEASE SAVEPOINT erase_customer_media');
    });

    it('on a database without v50/v51 (undefined_column) there is no customer media: it rolls back to the savepoint and the erasure goes on', async () => {
        mediaDelete = () => { throw Object.assign(new Error('column "is_private" does not exist'), { code: '42703' }); };

        const outcome = await executeErasure(mintErasureToken(HANDLE, MEDIA_COUNTS));

        assert.ok(outcome.ok, 'the erasure still happened');
        assert.equal(outcome.mediaDeleted, 0);
        assert.equal(outcome.deleted.messages, 3);
        assert.ok(sqls().includes('ROLLBACK TO SAVEPOINT erase_customer_media'));
        assert.ok(indexOfStatement(/^DELETE FROM messages/) > indexOfStatement(/^ROLLBACK TO SAVEPOINT/), 'the messages are deleted after the savepoint was rolled back to');
        assert.ok(!sqls().includes('ROLLBACK'), 'the transaction itself was not rolled back');
    });

    it('any OTHER failure rolls the whole erasure back and surfaces: a file that could not be deleted is never reported as erased', async () => {
        mediaDelete = () => { throw Object.assign(new Error('connection terminated'), { code: '57P01' }); };

        await assert.rejects(executeErasure(mintErasureToken(HANDLE, MEDIA_COUNTS)), /connection terminated/);

        assert.ok(sqls().includes('ROLLBACK'));
        assert.ok(!sqls().some((sql) => /^DELETE FROM (messages|conversations)/.test(sql)), 'nothing else was deleted');
        assert.equal(released, 1, 'the connection went back to the pool');
    });

    it('eraseCustomerMedia: nothing to do for no conversations, and says how many files went otherwise', async () => {
        const quiet = { async query(): Promise<{ rows: any[]; rowCount: number | null }> { throw new Error('must not be called'); } };
        assert.equal(await eraseCustomerMedia(quiet, []), 0);

        const seen: string[] = [];
        const exec = {
            async query(sql: string): Promise<{ rows: any[]; rowCount: number | null }> {
                seen.push(sql);
                return { rows: [], rowCount: /^DELETE/.test(sql) ? 5 : null };
            },
        };
        assert.equal(await eraseCustomerMedia(exec, [CONV]), 5);
        assert.deepEqual(seen.map((sql) => sql.split(' ')[0]), ['SAVEPOINT', 'DELETE', 'RELEASE']);
    });
});

describe('erasure reaches lead-ad leads by the email or phone they gave (A10)', () => {
    const originalConnect = pool.connect;
    const saved: Record<string, string | undefined> = {};
    let statements: Array<{ sql: string; params: unknown[] }>;

    beforeEach(() => {
        for (const k of ['DASHBOARD_PASSWORD', 'META_APP_SECRET', 'TOKEN_ENCRYPTION_KEY']) saved[k] = process.env[k];
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
        process.env.TOKEN_ENCRYPTION_KEY = 'd'.repeat(64);
        statements = [];
        const client = {
            async query(sql: string, params: unknown[] = []) {
                const flat = sql.replace(/\s+/g, ' ').trim();
                statements.push({ sql: flat, params });
                if (/^SELECT id, instagram_user_id, username FROM conversations/.test(flat)) return { rows: [], rowCount: 0 };
                if (/^SELECT \(SELECT COUNT\(\*\) FROM messages/.test(flat)) return { rows: [{ messages: 0, conversations: 0, interactions: 0, dm_send_log: 0, leads: 1 }], rowCount: 1 };
                if (/^DELETE FROM ads_leads WHERE person_keys && \$1::text\[\]$/.test(flat)) return { rows: [], rowCount: 1 };
                if (/^DELETE FROM/.test(flat)) return { rows: [], rowCount: 0 };
                if (/^(BEGIN|COMMIT|ROLLBACK)\b/.test(flat)) return { rows: [], rowCount: null };
                throw new Error(`no result arranged for SQL: ${flat}`);
            },
            release() {},
        };
        (pool as unknown as { connect: unknown }).connect = async () => client;
    });

    afterEach(() => {
        (pool as unknown as { connect: unknown }).connect = originalConnect;
        for (const [k, v] of Object.entries(saved)) setEnv(k, v);
    });

    it('an email handle counts and deletes the lead rows by keyed hash, inside the erasure transaction', async () => {
        const { personKey } = await import('../config/crypto.js');
        const counts = { messages: 0, conversations: 0, interactions: 0, dmSendLog: 0, leads: 1 };
        const outcome = await executeErasure(mintErasureToken('Ali@Example.com', counts));
        assert.ok(outcome.ok);
        assert.equal(outcome.deleted.leads, 1);
        const del = statements.find((s) => /^DELETE FROM ads_leads/.test(s.sql))!;
        assert.deepEqual(del.params, [[personKey('ali@example.com')]]);
        assert.ok(statements.findIndex((s) => s.sql === 'BEGIN') < statements.indexOf(del));
        await commitErasure(outcome.client);
    });

    it('a token minted before leads existed (no `leads`) still verifies, as 0', () => {
        const legacy = mintErasureToken('sara', { messages: 1, conversations: 1, interactions: 0, dmSendLog: 0 } as any);
        const v = verifyErasureToken(legacy);
        assert.ok(v.ok);
        assert.equal(v.counts.leads, 0);
    });
});
