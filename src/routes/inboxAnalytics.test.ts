/**
 * UX wave 3's server half: the inbox's platform and sender (I8, I4), the Analytics window (A1),
 * "why DMs fail" (A5) and `since=` on the interactions log (O9).
 *
 * Every handler is pulled off the router's own stack and run against a stubbed `pool.query`, the
 * way api.test.ts drives the edit route: what is asserted is the SQL each one sends — the tenant
 * filter, the window, the bound parameters — and the shape it answers with. Nothing here reaches
 * Postgres or Meta.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import apiRouter, {
    conversationPlatformOf, messageSenderOf, parseSinceParam, statsWindowDays,
} from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

function handlerFor(method: string, path: string) {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
}

interface Sent { sql: string; params: unknown[] }

/** Run one route with `pool.query` answered by `answer`, and collect what it sent and said. */
async function call(
    method: string, path: string,
    req: { query?: Record<string, unknown>; params?: Record<string, string>; body?: unknown },
    answer: (sql: string, params: unknown[]) => { rows: unknown[] } = () => ({ rows: [] }),
) {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
    const sent: Sent[] = [];
    const original = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const out = answer(sql, params);
        return { ...out, rowCount: out.rows.length };
    };
    try {
        await handlerFor(method, path)(
            { query: {}, params: {}, body: {}, ...req, session: { userId: 'u-1', role: 'user', tenantId: TENANT }, headers: {} },
            res,
            () => {}
        );
    } finally {
        (pool as unknown as { query: unknown }).query = original;
    }
    return { res, sent };
}

const count = (n: number) => ({ rows: [{ count: n, total: n }] });

// ─── I8 / I4: the inbox reads ────────────────────────────────────────────────────────────
describe('GET /conversations — the platform (I8)', () => {
    it('always carries `platform`, null when the column is absent (before v26) or unattributed', async () => {
        const { res } = await call('get', '/conversations', { query: {} }, (sql) => (
            /COUNT\(\*\)/.test(sql)
                ? { rows: [{ total: 4 }] }
                : { rows: [
                    { id: 'a', platform: 'instagram' },
                    { id: 'b', platform: 'facebook' },
                    { id: 'c', platform: null },
                    { id: 'd' },                       // a database without v26: no key at all
                ] }
        ));
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.data.map((r: any) => [r.id, r.platform]), [
            ['a', 'instagram'], ['b', 'facebook'], ['c', null], ['d', null],
        ]);
    });

    it('answers null for anything that is not one of the two', () => {
        for (const v of ['instagram', 'facebook']) assert.equal(conversationPlatformOf(v), v);
        for (const v of [undefined, null, '', 'tiktok', 'Instagram', 1]) assert.equal(conversationPlatformOf(v), null);
    });
});

describe('GET /conversations/:id/messages — the sender (I4)', () => {
    it('carries `sender` on every row, null for an old row or a database without v26', async () => {
        const { res } = await call('get', '/conversations/:id/messages', { params: { id: CONV } }, (sql) => (
            /SELECT 1 FROM conversations/.test(sql)
                ? { rows: [{ '?column?': 1 }] }
                // Newest first, as the query orders them; the route reverses.
                : { rows: [{ id: 'm3', sender: 'operator' }, { id: 'm2', sender: 'ai' }, { id: 'm1', sender: 'customer' }, { id: 'm0' }] }
        ));
        assert.deepEqual(res.body.map((r: any) => [r.id, r.sender]), [
            ['m0', null], ['m1', 'customer'], ['m2', 'ai'], ['m3', 'operator'],
        ]);
    });

    it('answers null for anything that is not one of the four', () => {
        for (const v of ['customer', 'ai', 'operator', 'automation']) assert.equal(messageSenderOf(v), v);
        for (const v of [undefined, null, '', 'bot', 'AI']) assert.equal(messageSenderOf(v), null);
    });
});

describe('POST /conversations/:id/messages — the operator’s reply is marked as theirs (I4)', () => {
    it('writes sender = operator on the outbound row', async () => {
        const originalPost = metaHttp.post;
        (metaHttp as any).post = async () => ({ data: { message_id: 'sent-1' } });
        try {
            const { res, sent } = await call('post', '/conversations/:id/messages', { params: { id: CONV }, body: { text: 'أهلاً' } }, (sql) => (
                /FROM conversations c/.test(sql)
                    ? { rows: [{ id: CONV, instagram_user_id: 'user-1', page_access_token: 'EAAGplain' }] }
                    : { rows: [] }
            ));
            assert.equal(res.statusCode, 200);
            const insert = sent.find((s) => /INSERT INTO messages/.test(s.sql))!;
            assert.match(insert.sql, /raw_payload, sender\) VALUES \(\$1, \$2, 'outbound', 'text', \$3, \$4, 'operator'\)/);
            assert.deepEqual(insert.params.slice(0, 3), [CONV, TENANT, 'أهلاً']);
        } finally {
            (metaHttp as any).post = originalPost;
        }
    });
});

describe('POST /conversations/:id/messages — a Facebook thread is answered through its page', () => {
    const send = async (row: Record<string, unknown>): Promise<string[]> => {
        const urls: string[] = [];
        const originalPost = metaHttp.post;
        (metaHttp as any).post = async (url: string) => { urls.push(url); return { data: { message_id: 'sent-1' } }; };
        try {
            const { res } = await call('post', '/conversations/:id/messages', { params: { id: CONV }, body: { text: 'أهلاً' } }, (sql) => (
                /FROM conversations c/.test(sql)
                    ? { rows: [{ id: CONV, instagram_user_id: 'user-1', page_access_token: 'EAAGplain', facebook_page_id: 'FBPAGE1', ...row }] }
                    : { rows: [] }
            ));
            assert.equal(res.statusCode, 200);
        } finally {
            (metaHttp as any).post = originalPost;
        }
        return urls;
    };

    it('sends to /{page-id}/messages when the thread is a Facebook one', async () => {
        const urls = await send({ platform: 'facebook' });
        assert.equal(urls.length, 1);
        assert.match(urls[0]!, /\/FBPAGE1\/messages$/);
    });

    it('keeps /me/messages for Instagram and for threads written before v26', async () => {
        for (const platform of ['instagram', null, undefined]) {
            const urls = await send({ platform });
            assert.match(urls[0]!, /\/me\/messages$/, String(platform));
        }
    });
});

// ─── A1: the Analytics window ─────────────────────────────────────────────────────────────
describe('statsWindowDays', () => {
    it('is all time when absent, "all" or not a positive whole number — the old answer', () => {
        for (const v of [undefined, null, '', 'all', 'abc', '0', '-7', 0]) assert.equal(statsWindowDays(v), null, String(v));
    });

    it('is a number of days, clamped like the chart routes', () => {
        assert.equal(statsWindowDays('7'), 7);
        assert.equal(statsWindowDays('28'), 28);
        assert.equal(statsWindowDays('90'), 90);
        assert.equal(statsWindowDays('99999999999'), 365);
    });
});

describe('GET /stats — ?days= (A1)', () => {
    const interactionQueries = (sent: Sent[]) => sent.filter((s) => /FROM interactions i/.test(s.sql));

    it('sends no window without days, so Overview’s call is unchanged', async () => {
        const { res, sent } = await call('get', '/stats', { query: {} }, () => count(3));
        assert.equal(res.statusCode, 200);
        assert.ok(!sent.some((s) => /make_interval/.test(s.sql)));
        assert.equal(res.body.days, null);
        for (const s of interactionQueries(sent)) assert.deepEqual(s.params, [TENANT]);
    });

    it('windows the counts, the reach and the platform split — and nothing else', async () => {
        const { res, sent } = await call('get', '/stats', { query: { days: '28' } }, () => count(3));
        assert.equal(res.body.days, 28);
        const windowed = sent.filter((s) => /i\.creator_id = \$1 AND i\.timestamp > NOW\(\) - make_interval\(days => \$2::int\)/.test(s.sql));
        // total, sent, failed, unique people, instagram, facebook.
        assert.equal(windowed.length, 6);
        for (const s of windowed) assert.deepEqual(s.params, [TENANT, 28]);
        assert.ok(windowed.some((s) => /COUNT\(DISTINCT i\.sender_username\)/.test(s.sql)), 'people reached');
        assert.ok(windowed.some((s) => /i\.platform = 'facebook'/.test(s.sql)), 'the platform split');
        // The rolling 24h and the campaign count keep their own questions.
        const today = sent.find((s) => /INTERVAL '24 hours'/.test(s.sql))!;
        assert.ok(!/make_interval/.test(today.sql));
        assert.deepEqual(today.params, [TENANT]);
        const campaigns = sent.find((s) => /FROM campaigns/.test(s.sql))!;
        assert.deepEqual(campaigns.params, [TENANT]);
    });

    it('keeps the response shape', async () => {
        const { res } = await call('get', '/stats', { query: { days: '7' } }, () => count(2));
        for (const key of ['totalInteractions', 'sent', 'failed', 'successRate', 'activeCampaigns', 'activeCreators',
            'activeCreatorsScope', 'todayActivity', 'uniqueUsersReached', 'instagramCount', 'facebookCount']) {
            assert.ok(key in res.body, key);
        }
    });
});

describe('GET /stats/campaigns — ?days= (A1)', () => {
    it('puts the window in the JOIN, so a campaign with nothing in it still shows at zero', async () => {
        const { sent } = await call('get', '/stats/campaigns', { query: { days: '7' } });
        const [q] = sent;
        assert.match(q!.sql, /LEFT JOIN interactions i ON i\.campaign_id = c\.id AND i\.timestamp > NOW\(\) - make_interval\(days => \$2::int\) WHERE c\.creator_id = \$1/);
        assert.deepEqual(q!.params, [TENANT, 7]);
    });

    it('is all time without days, as before', async () => {
        const { res, sent } = await call('get', '/stats/campaigns', { query: {} }, () => ({ rows: [{ id: 'c1' }] }));
        assert.ok(!/make_interval/.test(sent[0]!.sql));
        assert.deepEqual(sent[0]!.params, [TENANT]);
        assert.deepEqual(res.body, [{ id: 'c1' }], 'still a bare array');
    });
});

// ─── A5: why DMs fail ─────────────────────────────────────────────────────────────────────
describe('GET /stats/failures (A5)', () => {
    it('reads this tenant’s FAILED rows of the window, parameterised', async () => {
        const { res, sent } = await call('get', '/stats/failures', { query: { days: '30' } });
        assert.equal(res.statusCode, 200);
        const [q] = sent;
        assert.match(q!.sql, /WHERE i\.creator_id = \$1 AND i\.status = 'FAILED' AND i\.timestamp > NOW\(\) - make_interval\(days => \$2::int\)/);
        assert.match(q!.sql, /GROUP BY i\.error_log/);
        assert.deepEqual(q!.params, [TENANT, 30]);
    });

    it('defaults to 30 days and clamps what it is given', async () => {
        assert.deepEqual((await call('get', '/stats/failures', { query: {} })).sent[0]!.params, [TENANT, 30]);
        assert.deepEqual((await call('get', '/stats/failures', { query: { days: '99999' } })).sent[0]!.params, [TENANT, 365]);
    });

    it('answers { days, total, reasons: [{ reason_code, count, sample, last_at }] }, top six', async () => {
        const rows = [
            { error_log: 'Private Reply Failed: Error validating access token (Code: 190)', count: 7, last_at: new Date('2026-09-26T08:00:00Z'), total: 12 },
            { error_log: 'Skipped: recipient already received an automated DM within 24 hours.', count: 5, last_at: new Date('2026-09-27T08:00:00Z'), total: 12 },
        ];
        const { res } = await call('get', '/stats/failures', { query: {} }, () => ({ rows }));
        assert.deepEqual(res.body, {
            days: 30,
            total: 12,
            reasons: [
                { reason_code: '190', count: 7, sample: rows[0]!.error_log, last_at: '2026-09-26T08:00:00.000Z' },
                { reason_code: 'recipient_cap', count: 5, sample: rows[1]!.error_log, last_at: '2026-09-27T08:00:00.000Z' },
            ],
        });
    });

    it('is 500 with a sentence, not a stack, when the read fails', async () => {
        const { res } = await call('get', '/stats/failures', { query: {} }, () => { throw new Error('boom'); });
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to fetch failure reasons.' });
    });
});

// ─── O9: since= on the interactions log ───────────────────────────────────────────────────
describe('parseSinceParam', () => {
    it('is null when absent, and a UTC ISO instant when it is one', () => {
        assert.equal(parseSinceParam(undefined), null);
        assert.equal(parseSinceParam(''), null);
        assert.equal(parseSinceParam('2026-09-26T21:00:00.000Z'), '2026-09-26T21:00:00.000Z');
        assert.equal(parseSinceParam('2026-09-27T00:00:00+03:00'), '2026-09-26T21:00:00.000Z');
        assert.equal(parseSinceParam('2026-09-27'), '2026-09-27T00:00:00.000Z');
    });

    it('is undefined — a 400 — for anything that is not a real date-time', () => {
        for (const v of ['yesterday', '1695772800', '2026-02-31', '2026-13-01', '2026-09-27T25:00', '2026-09-27 00:00',
            "2026-09-27'; DROP TABLE interactions;--", ['2026-09-27'], { a: 1 }, 'x'.repeat(41)]) {
            assert.equal(parseSinceParam(v), undefined, JSON.stringify(v));
        }
    });
});

describe('GET /interactions — ?since= (O9)', () => {
    it('refuses garbage with a 400 and reads nothing', async () => {
        const { res, sent } = await call('get', '/interactions', { query: { since: 'today' } });
        assert.equal(res.statusCode, 400);
        assert.match(res.body.error, /since must be an ISO 8601 date-time/);
        assert.equal(sent.length, 0);
    });

    it('filters the rows AND the total from that instant, bound as a parameter', async () => {
        const { res, sent } = await call('get', '/interactions', { query: { since: '2026-09-27T00:00:00+03:00', status: 'FAILED', limit: '100' } },
            (sql) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ total: 140 }] } : { rows: [] }));
        assert.equal(res.statusCode, 200);
        const [countQ, dataQ] = sent;
        for (const q of [countQ!, dataQ!]) {
            assert.match(q.sql, /i\.creator_id = \$1 AND i\.timestamp >= \$2::timestamptz AND i\.status = \$3/);
            assert.deepEqual(q.params.slice(0, 3), [TENANT, '2026-09-26T21:00:00.000Z', 'FAILED']);
        }
        assert.deepEqual(dataQ!.params.slice(3), [100, 0]);
        assert.equal(res.body.pagination.total, 140, 'the total answers for the same window');
    });

    it('is the whole log without since, as before', async () => {
        const { sent } = await call('get', '/interactions', { query: {} }, (sql) => (/COUNT/.test(sql) ? { rows: [{ total: 0 }] } : { rows: [] }));
        assert.ok(!sent.some((s) => /timestamptz/.test(s.sql)));
        assert.deepEqual(sent[0]!.params, [TENANT]);
    });
});
