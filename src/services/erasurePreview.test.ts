/**
 * The erasure preview names the workspaces and dates the rows (UX overhaul, User Story 1; audit ER-01, ER-02).
 *
 * Matching is cross-tenant on purpose: `resolveErasureTarget` has no `creator_id` filter, so one erasure removes a person from every
 * client's inbox. The preview used to show only counts, so the operator could not tell. It now returns:
 *
 *   - `byTenant: [{ tenantId, name, rows }]`: the workspaces that hold rows, most first. A row with no workspace (before migration v12)
 *     is grouped under null, not dropped.
 *   - `ranges`: the oldest and newest date per data type over ALL the matched rows (MIN and MAX). The sample is the newest five, so it
 *     cannot say when the oldest row is.
 *
 * There is no database in this suite (by the same convention as erasure.test.ts), so the pool is stubbed and these pin what the
 * function does with what comes back and what it asks for. The SQL itself was run against a throwaway local Postgres seeded with two
 * workspaces, a legacy row with no workspace and a case-different username: the per-workspace rows added up to `countsTotal` (8 of 8).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from '../routes/admin.js';
import { countsTotal, previewErasure } from './erasure.js';

interface Issued { sql: string; params: unknown[] }

const ALPHA = 'aaaaaaaa-0000-4000-8000-000000000001';
const BETA = 'aaaaaaaa-0000-4000-8000-000000000002';

/** Rows the stub database answers with, by what is being asked. Each test changes only the part it is about. */
function database(over: Partial<Record<'tenants' | 'ranges' | 'conversations' | 'counts' | 'resolved', any[]>> = {}) {
    return {
        resolved: over.resolved ?? [
            { id: 'c1', instagram_user_id: '111', username: 'Sara' },
            { id: 'c2', instagram_user_id: '111', username: 'sara' },
        ],
        counts: over.counts ?? [{ messages: 3, conversations: 2, interactions: 2, dm_send_log: 1 }],
        tenants: over.tenants ?? [
            { creator_id: ALPHA, name: 'Alpha', row_count: 4 },
            { creator_id: BETA, name: 'Beta', row_count: 3 },
            { creator_id: null, name: null, row_count: 1 },
        ],
        ranges: over.ranges ?? [{
            conversations_first: new Date('2026-01-02T00:00:00Z'), conversations_last: new Date('2026-05-06T00:00:00Z'),
            messages_first: new Date('2026-01-02T00:00:00Z'), messages_last: new Date('2026-05-06T00:00:00Z'),
            interactions_first: new Date('2026-02-01T00:00:00Z'), interactions_last: new Date('2026-06-01T00:00:00Z'),
            dm_send_log_first: null, dm_send_log_last: null,
        }],
        conversations: over.conversations ?? [
            { id: 'c2', creator_id: BETA, creator_name: 'Beta', instagram_user_id: '111', username: 'sara', last_message_at: new Date('2026-05-06T00:00:00Z') },
        ],
    };
}

describe('previewErasure: byTenant and ranges', () => {
    const restore: Array<() => void> = [];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        saved.pw = process.env.DASHBOARD_PASSWORD; saved.app = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });
    afterEach(() => {
        while (restore.length) restore.pop()!();
        for (const [key, value] of [['DASHBOARD_PASSWORD', saved.pw], ['META_APP_SECRET', saved.app]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    /** Replace the pool's query with a dispatcher over `rows`, recording every statement and its parameters. */
    function stub(rows = database()): Issued[] {
        const issued: Issued[] = [];
        const originalQuery = pool.query;
        const previousSink = setLogSink(() => {});
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            issued.push({ sql, params });
            // The ranges statement names `conversations_first`, the workspaces one is the only UNION, and the counts one is the only
            // `AS dm_send_log`; check in that order, because the later statements contain the earlier ones' table names.
            const pick = (): any[] => {
                if (/conversations_first/.test(sql)) return rows.ranges;
                if (/UNION ALL/.test(sql)) return rows.tenants;
                if (/AS dm_send_log\b/.test(sql)) return rows.counts;
                if (/FROM conversations cv/.test(sql)) return rows.conversations;
                if (/char_length/.test(sql)) return [{ id: 'm1', direction: 'inbound', message_type: 'text', text_length: 9, has_raw_payload: true, created_at: new Date('2026-05-06T00:00:00Z'), text: 'SECRET-MESSAGE-BODY' }];
                if (/SELECT id, comment_id/.test(sql)) return [];
                if (/SELECT id, instagram_user_id, username/.test(sql)) return rows.resolved;
                throw new Error(`unexpected statement: ${sql.slice(0, 80)}`);
            };
            const result = pick();
            return { rows: result, rowCount: result.length };
        };
        restore.push(() => {
            (pool as unknown as { query: unknown }).query = originalQuery;
            setLogSink(previousSink);
        });
        return issued;
    }

    it('lists every workspace that holds rows, most first, with its name and row count, and keeps rows that belong to none', async () => {
        stub();
        const preview = await previewErasure('sara');

        assert.deepEqual(preview.byTenant, [
            { tenantId: ALPHA, name: 'Alpha', rows: 4 },
            { tenantId: BETA, name: 'Beta', rows: 3 },
            { tenantId: null, name: null, rows: 1 },
        ]);
        assert.equal(preview.byTenant.reduce((sum, w) => sum + w.rows, 0), countsTotal(preview.counts), 'the workspaces account for every row');
    });

    it('rows arrive as numbers whatever the driver hands back (a bigint comes as a string)', async () => {
        stub(database({ tenants: [{ creator_id: ALPHA, name: 'Alpha', row_count: '12' }] }));
        const preview = await previewErasure('sara');
        assert.strictEqual(preview.byTenant[0]!.rows, 12);
    });

    it('a handle that matches nothing has no workspaces, no dates and no token', async () => {
        stub(database({
            resolved: [],
            counts: [{ messages: 0, conversations: 0, interactions: 0, dm_send_log: 0 }],
            tenants: [],
            ranges: [{ conversations_first: null, conversations_last: null, messages_first: null, messages_last: null, interactions_first: null, interactions_last: null, dm_send_log_first: null, dm_send_log_last: null }],
            conversations: [],
        }));
        const preview = await previewErasure('nobody');

        assert.equal(preview.found, false);
        assert.deepEqual(preview.byTenant, []);
        assert.equal(preview.token, null);
        for (const type of ['conversations', 'messages', 'interactions', 'dmSendLog', 'leads'] as const) {
            assert.deepEqual(preview.ranges[type], { first: null, last: null }, type);
        }
    });

    it('the first and last date of every data type are ISO strings over all matched rows, null where a table has none', async () => {
        stub();
        const { ranges } = await previewErasure('sara');

        assert.deepEqual(ranges, {
            conversations: { first: '2026-01-02T00:00:00.000Z', last: '2026-05-06T00:00:00.000Z' },
            messages: { first: '2026-01-02T00:00:00.000Z', last: '2026-05-06T00:00:00.000Z' },
            interactions: { first: '2026-02-01T00:00:00.000Z', last: '2026-06-01T00:00:00.000Z' },
            dmSendLog: { first: null, last: null },
            leads: { first: null, last: null },
        });
    });

    it('an answer with no range row at all is all nulls rather than a crash', async () => {
        stub(database({ ranges: [] }));
        const { ranges } = await previewErasure('sara');
        assert.deepEqual(ranges.messages, { first: null, last: null });
    });

    it('the workspace and range statements match on exactly what the count and the delete match on, with the same parameters', async () => {
        const issued = stub();
        await previewErasure('sara');

        const counts = issued.find((q) => /AS dm_send_log\b/.test(q.sql))!;
        const tenants = issued.find((q) => /UNION ALL/.test(q.sql))!;
        const ranges = issued.find((q) => /conversations_first/.test(q.sql))!;
        assert.ok(counts && tenants && ranges);

        // The same four lists, in the same order: conversation ids, lower-cased usernames, Instagram ids, and the lead keys of the handle as an
        // email or phone (erasure.ts `countErasure`; none for an Instagram handle).
        assert.deepEqual(tenants.params, counts.params);
        assert.deepEqual(ranges.params, counts.params);
        assert.deepEqual(counts.params, [['c1', 'c2'], ['sara'], ['sara', '111'], []]);

        for (const { sql } of [tenants, ranges]) {
            assert.match(sql, /conversation_id = ANY\(\$1::uuid\[\]\)/, 'messages by conversation');
            assert.match(sql, /lower\(sender_username\) = ANY\(\$2::text\[\]\)/, 'comments by lower-cased username');
            assert.match(sql, /recipient_id = ANY\(\$3::text\[\]\)/, 'the send log by recipient');
        }
        assert.match(tenants.sql, /id = ANY\(\$1::uuid\[\]\)/, 'conversations by id');
        for (const { sql } of [counts, tenants, ranges]) assert.match(sql, /FROM ads_leads\s+WHERE person_keys && \$4::text\[\]/, 'leads by keyed hash');
        assert.doesNotMatch(tenants.sql, /creators WHERE|creator_id = \$/, 'no filter by workspace: matching is cross-tenant');
    });

    it('no message text leaves the server: no statement selects the body, and a body the database handed back is not in the answer', async () => {
        const issued = stub();
        const preview = await previewErasure('sara');

        for (const { sql } of issued) {
            const withoutLengthAndCasts = sql.replace(/char_length\(COALESCE\(text, ''\)\)/g, '').replace(/::text\[\]/g, '');
            assert.doesNotMatch(withoutLengthAndCasts, /\btext\b/, `a statement reads the message body: ${sql.slice(0, 60)}`);
        }
        const body = JSON.stringify(preview);
        assert.ok(!body.includes('SECRET-MESSAGE-BODY'));
        assert.ok(!Array.isArray(preview.sample), 'the sample is an object of metadata');
        assert.deepEqual(Object.keys(preview.sample), ['conversations', 'messages', 'interactions']);
        assert.equal(preview.sample.messages[0]!.textLength, 9);
    });
});

// ─── The route hands it on unchanged ────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/erasure/preview', () => {
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
        saved.pw = process.env.DASHBOARD_PASSWORD; saved.app = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });
    afterEach(() => {
        for (const [key, value] of [['DASHBOARD_PASSWORD', saved.pw], ['META_APP_SECRET', saved.app]] as const) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    function call(handle: string): Promise<{ status: number; body: any }> {
        return new Promise((resolve) => {
            const req = {
                method: 'GET', url: '/erasure/preview', originalUrl: '/erasure/preview', body: {}, query: { handle }, params: {}, headers: {},
                session: { userId: null, role: 'platform_admin', tenantId: 't-1', tokenVersion: 0 },
            } as unknown as Request;
            const res = {
                statusCode: 200,
                status(code: number) { (this as any).statusCode = code; return this; },
                json(body: unknown) { resolve({ status: (this as any).statusCode, body }); return this; },
                setHeader() { return this; },
            } as unknown as Response;
            adminRouter(req, res, () => resolve({ status: 0, body: null }));
        });
    }

    it('answers with the workspaces and the date ranges beside the counts, the matched identifiers and a token', async () => {
        const rows = database();
        const originalQuery = pool.query;
        const previousSink = setLogSink(() => {});
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            const result = /conversations_first/.test(sql) ? rows.ranges
                : /UNION ALL/.test(sql) ? rows.tenants
                : /AS dm_send_log\b/.test(sql) ? rows.counts
                : /FROM conversations cv/.test(sql) ? rows.conversations
                : /SELECT id, instagram_user_id, username/.test(sql) ? rows.resolved
                : [];
            return { rows: result, rowCount: result.length };
        };
        try {
            const reply = await call('sara');
            assert.equal(reply.status, 200);
            assert.deepEqual(reply.body.byTenant.map((w: any) => [w.name, w.rows]), [['Alpha', 4], ['Beta', 3], [null, 1]]);
            assert.equal(reply.body.ranges.messages.first, '2026-01-02T00:00:00.000Z');
            assert.deepEqual(reply.body.matched.usernames, ['sara']);
            assert.deepEqual(reply.body.matched.instagramUserIds, ['sara', '111']);
            assert.equal(reply.body.counts.messages, 3);
            assert.equal(typeof reply.body.token, 'string');
            assert.ok(!Array.isArray(reply.body.sample));
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
            setLogSink(previousSink);
        }
    });
});
