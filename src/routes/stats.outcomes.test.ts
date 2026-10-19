/**
 * The outcome split in the stats endpoints (UX overhaul US1, T033/T040/T041; audit OV-03, OV-18, OV-20, CA-03, OV-31).
 *
 * Before: `successRate` was sent ÷ every row, so a person who already had their reply, or a send cap doing its job, counted as a
 * failure of the account; Overview, Analytics and the campaign cards each wore the resulting red. After: every stats route says what
 * became of each DM (delivered / by design / needs the owner / waiting / blocked), and the rate is delivered ÷ (delivered + actionable).
 *
 * Each handler is pulled off the router's own stack and run against a stubbed `pool.query`, like inboxAnalytics.test.ts. What is
 * asserted is the SQL each one sends (the tenant filter, the window, the zone, that the patterns come from `failureReasons.ts`) and
 * what the route makes of the rows the database would answer. Whether the SQL's CASE agrees with `classifyOutcome` row by row is
 * `src/services/outcomes.sql.test.ts`'s, which also runs against a real Postgres when it is given one. Nothing here reaches Postgres or Meta.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { OUTCOMES } from '../services/outcomes.js';
import { setLogSink } from '../utils/log.js';
import apiRouter, { campaignStatsLimit, CAMPAIGN_STATS_DEFAULT_LIMIT, CAMPAIGN_STATS_MAX_LIMIT } from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

let events: Array<{ level: string; event: string }> = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { events.push({ level, event: JSON.parse(line).event }); });
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
type Answer = (sql: string, params: unknown[]) => { rows: unknown[] } | Error;

/** Run one route with `pool.query` answered by `answer`; the profile and settings reads that give the zone answer `zone` (null: unset). */
async function call(
    path: string,
    req: { query?: Record<string, unknown> } = {},
    answer: Answer = () => ({ rows: [] }),
    options: { zone?: string | null; role?: string } = {},
) {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
    const sent: Sent[] = [];
    const original = pool.query;
    const zone = options.zone === undefined ? null : options.zone;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        // What `tenantTimezone` reads: the profile's identity zone first.
        if (/FROM creator_profiles/.test(flat)) {
            return zone === null ? { rows: [], rowCount: 0 } : { rows: [{ profile_schema: 1, identity_timezone: zone }], rowCount: 1 };
        }
        if (/FROM studio_settings/.test(flat)) return { rows: [], rowCount: 0 };
        sent.push({ sql: flat, params });
        const out = answer(flat, params);
        if (out instanceof Error) throw out;
        return { ...out, rowCount: out.rows.length };
    };
    try {
        await handlerFor('get', path)(
            { query: {}, params: {}, body: {}, headers: {}, ...req, session: { userId: 'u-1', role: options.role ?? 'user', tenantId: TENANT } },
            res,
            () => {},
        );
    } finally {
        (pool as unknown as { query: unknown }).query = original;
    }
    return { res, sent };
}

const split = (delivered: number, by_design: number, actionable: number, pending = 0, blocked = 0) =>
    ({ delivered, by_design, actionable, pending, blocked });

/** `/stats` asks ten questions; every one but the outcome split is a COUNT(*) AS count, answered with `over.count`. */
function statsAnswer(outcome: Record<string, number>, over: Record<string, number> = {}): Answer {
    return (sql) => (/FILTER \(WHERE o\.outcome = 'delivered'\)/.test(sql)
        ? { rows: [outcome] }
        : { rows: [{ count: over.count ?? 0 }] });
}

// ─── T040: /stats ─────────────────────────────────────────────────────────────────────────────
describe('GET /stats — the outcome split', () => {
    it('answers `outcomes` and a success rate of delivered ÷ (delivered + actionable): by-design rows never count as failed', async () => {
        // 100 comment DMs: 58 delivered, 31 not sent on purpose (the 24 h cap, "already had its reply"), 11 that need the owner.
        // The old rate was sent ÷ all = 58%, in red. The honest one leaves the 31 out of it: 58 ÷ (58 + 11) = 84%.
        const { res } = await call('/stats', {}, statsAnswer(split(58, 31, 11), { count: 100 }));
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.outcomes, split(58, 31, 11));
        assert.equal(res.body.successRate, 84);
    });

    it('is null, not 0 and not 100, when nothing has been attempted', async () => {
        // Only by-design and pending rows: no DM was attempted, so there is no rate to be proud of or ashamed of.
        const { res } = await call('/stats', {}, statsAnswer(split(0, 5, 0, 2)));
        assert.equal(res.body.successRate, null);
        assert.deepEqual(res.body.outcomes, split(0, 5, 0, 2));
        const none = await call('/stats', {}, statsAnswer(split(0, 0, 0)));
        assert.equal(none.res.body.successRate, null);
    });

    it('is 0% only when something was attempted and all of it failed for a reason that needs the owner', async () => {
        const { res } = await call('/stats', {}, statsAnswer(split(0, 4, 6)));
        assert.equal(res.body.successRate, 0);
    });

    it('is 100% when everything attempted was delivered, however much was skipped on purpose', async () => {
        const { res } = await call('/stats', {}, statsAnswer(split(12, 40, 0, 1, 3)));
        assert.equal(res.body.successRate, 100);
    });

    it('keeps every legacy field, and `failed` still counts every FAILED row, expected or not', async () => {
        const { res } = await call('/stats', {}, statsAnswer(split(3, 2, 1), { count: 9 }));
        for (const key of ['totalInteractions', 'sent', 'failed', 'successRate', 'activeCampaigns', 'activeCreators',
            'activeCreatorsScope', 'todayActivity', 'uniqueUsersReached', 'instagramCount', 'facebookCount', 'days']) {
            assert.ok(key in res.body, key);
        }
        assert.equal(res.body.failed, 9, 'the legacy count is the FAILED rows, unchanged');
    });

    it('classifies the same window and tenant as the other counts, with the patterns from failureReasons.ts', async () => {
        const { sent } = await call('/stats', { query: { days: '28' } }, statsAnswer(split(1, 0, 0)));
        const q = sent.find((s) => /FILTER \(WHERE o\.outcome = 'delivered'\)/.test(s.sql))!;
        assert.ok(q, 'an outcome query is sent');
        assert.match(q.sql, /FROM interactions i CROSS JOIN LATERAL \(SELECT CASE i\.status /);
        assert.match(q.sql, /WHERE i\.creator_id = \$1 AND i\.timestamp > NOW\(\) - make_interval\(days => \$2::int\)$/);
        assert.deepEqual(q.params, [TENANT, 28]);
        // One source of the patterns: the SQL carries the wording `failureReasons.ts` matches, not a copy typed here.
        assert.ok(q.sql.includes('Replied publicly with the link instead'));
        assert.ok(q.sql.includes('already had its private reply|already has a reply'));
        assert.ok(q.sql.includes('Skipped: hourly DM quota'));
        for (const o of OUTCOMES) assert.ok(q.sql.includes(`FILTER (WHERE o.outcome = '${o}')::int AS ${o}`), o);
    });

    it('counts all time without a window, as Overview and Analytics ask', async () => {
        const { sent } = await call('/stats', {}, statsAnswer(split(1, 0, 0)));
        const q = sent.find((s) => /FILTER \(WHERE o\.outcome = 'delivered'\)/.test(s.sql))!;
        assert.ok(!/make_interval/.test(q.sql));
        assert.deepEqual(q.params, [TENANT]);
    });
});

// ─── T041: /stats/daily ───────────────────────────────────────────────────────────────────────
describe('GET /stats/daily — assistant replies, the outcome split, and the tenant’s zone', () => {
    const row = (day: string, over: Record<string, number> = {}) =>
        ({ day, sent: 0, failed: 0, delivered: 0, by_design: 0, actionable: 0, pending: 0, blocked: 0, assistant_replies: 0, ...over });

    it('buckets days in the tenant’s own zone, bound as a parameter', async () => {
        const { res, sent } = await call('/stats/daily', { query: { days: '7' } }, () => ({ rows: [row('2026-10-19')] }), { zone: 'Asia/Dubai' });
        assert.equal(res.statusCode, 200);
        const q = sent[0]!;
        assert.deepEqual(q.params, [TENANT, 7, 'Asia/Dubai']);
        // Every date is cut with AT TIME ZONE and the bound zone: the series' own today, the interactions' day and the replies' day.
        assert.equal((q.sql.match(/AT TIME ZONE \$3::text/g) || []).length >= 5, true);
        assert.ok(!/CURRENT_DATE/.test(q.sql), 'the database session’s date (UTC) is no longer "today"');
        assert.ok(!/AT TIME ZONE 'UTC'/.test(q.sql));
    });

    it('reads a tenant that never chose a zone in UTC, as before', async () => {
        const { sent } = await call('/stats/daily', { query: { days: '7' } }, () => ({ rows: [] }), { zone: null });
        assert.deepEqual(sent[0]!.params, [TENANT, 7, 'UTC']);
    });

    it('counts the assistant’s replies: outbound messages with sender = ai, of this tenant’s conversations only', async () => {
        const { sent } = await call('/stats/daily', { query: {} }, () => ({ rows: [] }), { zone: 'Asia/Dubai' });
        const sql = sent[0]!.sql;
        assert.match(sql, /FROM messages m JOIN conversations cv ON cv\.id = m\.conversation_id WHERE cv\.creator_id = \$1 AND m\.direction = 'outbound' AND m\.sender = 'ai'/);
        assert.match(sql, /COUNT\(\*\)::int AS assistant_replies/);
        // The operator's own replies and the customer's messages are not the assistant's.
        assert.ok(!/sender IN/.test(sql) && !/'operator'/.test(sql));
    });

    it('classifies each day’s comment DMs, and the interactions are the tenant’s own', async () => {
        const { sent } = await call('/stats/daily', { query: {} }, () => ({ rows: [] }));
        const sql = sent[0]!.sql;
        assert.match(sql, /WHERE i\.creator_id = \$1 AND i\.timestamp >= \(SELECT first_day FROM span\)::timestamp AT TIME ZONE \$3::text/);
        for (const o of OUTCOMES) assert.ok(sql.includes(`FILTER (WHERE o.outcome = '${o}')::int AS ${o}`), o);
        assert.ok(sql.includes('Replied publicly with the link instead'));
    });

    it('zero-fills every day: the series is generated first and the two counts are joined onto it', async () => {
        const { sent } = await call('/stats/daily', { query: { days: '7' } });
        const sql = sent[0]!.sql;
        assert.match(sql, /FROM series LEFT JOIN comment_dms c ON c\.day = series\.day LEFT JOIN assistant a ON a\.day = series\.day ORDER BY series\.day ASC/);
        assert.match(sql, /generate_series\(span\.first_day::timestamp, span\.last_day::timestamp, '1 day'::interval\)/);
    });

    it('answers the rows as the database gave them: a bare array, `day` a calendar day, every count a number', async () => {
        const rows = [row('2026-10-18', { sent: 4, failed: 1, delivered: 4, by_design: 1 }), row('2026-10-19', { assistant_replies: 3, delivered: 2, sent: 2, actionable: 1, failed: 1 })];
        const { res } = await call('/stats/daily', { query: { days: '2' } }, () => ({ rows }));
        assert.ok(Array.isArray(res.body));
        assert.deepEqual(res.body, rows);
        const first = (res.body as Array<Record<string, unknown>>)[0]!;
        for (const key of ['day', 'sent', 'failed', 'delivered', 'by_design', 'actionable', 'pending', 'blocked', 'assistant_replies']) {
            assert.ok(key in first, key);
        }
    });

    it('keeps the 30-day default and the clamp', async () => {
        assert.equal((await call('/stats/daily', { query: {} })).sent[0]!.params[1], 30);
        assert.equal((await call('/stats/daily', { query: { days: '99999' } })).sent[0]!.params[1], 365);
        assert.equal((await call('/stats/daily', { query: { days: '-3' } })).sent[0]!.params[1], 30);
    });

    it('still draws the chart when the zone cannot be read: UTC, and a warning', async () => {
        events = [];
        const original = pool.query;
        let first = true;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            if (first && /FROM creator_profiles/.test(sql)) { first = false; throw new Error('connection reset'); }
            return { rows: [], rowCount: 0, _p: params };
        };
        const res: any = { statusCode: 200, body: null, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
        try {
            await handlerFor('get', '/stats/daily')({ query: {}, params: {}, body: {}, headers: {}, session: { userId: 'u', role: 'user', tenantId: TENANT } }, res, () => {});
        } finally {
            (pool as unknown as { query: unknown }).query = original;
        }
        assert.equal(res.statusCode, 200);
        assert.ok(events.some((e) => e.event === 'api.stats_daily_timezone_unreadable' && e.level === 'warn'));
    });

    it('retries in UTC when the database does not know a zone the profile named (22023), and says so', async () => {
        // The JavaScript side accepts every zone Intl can format; a database that lacks one must not take the chart down.
        events = [];
        const { res, sent } = await call('/stats/daily', { query: { days: '3' } }, (_sql, params) => {
            if (params[2] !== 'UTC') return Object.assign(new Error('time zone "Asia/Dubai" not recognized'), { code: '22023' });
            return { rows: [row('2026-10-19')] };
        }, { zone: 'Asia/Dubai' });
        assert.equal(res.statusCode, 200, 'answered from the UTC retry');
        assert.deepEqual(sent.map((s) => s.params[2]), ['Asia/Dubai', 'UTC']);
        assert.ok(events.some((e) => e.event === 'api.stats_daily_timezone_unknown'));
    });

    it('does not retry for any other database error', async () => {
        const { res, sent } = await call('/stats/daily', { query: {} }, () => Object.assign(new Error('deadlock'), { code: '40P01' }), { zone: 'Asia/Dubai' });
        assert.equal(res.statusCode, 500);
        assert.equal(sent.length, 1);
    });

    it('is 500 with a sentence, not a stack, when the read fails', async () => {
        const { res } = await call('/stats/daily', { query: {} }, () => new Error('boom'));
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to fetch daily stats.' });
    });
});

// ─── T040: /stats/campaigns ───────────────────────────────────────────────────────────────────
describe('GET /stats/campaigns — the outcome split, and limit=all', () => {
    it('lists five by default, as a leaderboard', async () => {
        const { sent } = await call('/stats/campaigns', { query: {} });
        assert.match(sent[0]!.sql, /ORDER BY total_triggers DESC LIMIT 5$/);
        assert.equal(CAMPAIGN_STATS_DEFAULT_LIMIT, 5);
    });

    it('lists every campaign with limit=all', async () => {
        const { sent } = await call('/stats/campaigns', { query: { limit: 'all' } });
        assert.ok(!/LIMIT/.test(sent[0]!.sql));
        assert.match(sent[0]!.sql, /ORDER BY total_triggers DESC$/);
    });

    it('takes a number, clamped, and otherwise the default', () => {
        assert.equal(campaignStatsLimit('all'), null);
        assert.equal(campaignStatsLimit('3'), 3);
        assert.equal(campaignStatsLimit('1'), 1);
        assert.equal(campaignStatsLimit('99999'), CAMPAIGN_STATS_MAX_LIMIT);
        for (const v of [undefined, null, '', '0', '-1', '2.5', 'ALL', 'abc', '5; DROP TABLE campaigns', ['all'], { a: 1 }, 7]) {
            assert.equal(campaignStatsLimit(v), 5, JSON.stringify(v));
        }
    });

    it('never interpolates anything from the request into the LIMIT', async () => {
        const { sent } = await call('/stats/campaigns', { query: { limit: '3; DROP TABLE campaigns' } });
        assert.match(sent[0]!.sql, /LIMIT 5$/);
    });

    it('adds the split to every row and keeps the legacy counts, still a bare array', async () => {
        const rows = [{ id: 'c1', trigger_keyword: 'promo', total_triggers: 10, sent_count: 6, failed_count: 3, ...split(6, 2, 1, 1, 0) }];
        const { res } = await call('/stats/campaigns', { query: {} }, () => ({ rows }));
        assert.deepEqual(res.body, rows);
    });

    it('keeps the window in the JOIN, so a campaign with nothing in it still shows at zero, and counts by outcome after it', async () => {
        const { sent } = await call('/stats/campaigns', { query: { days: '7' } });
        assert.match(sent[0]!.sql, /LEFT JOIN interactions i ON i\.campaign_id = c\.id AND i\.timestamp > NOW\(\) - make_interval\(days => \$2::int\) LEFT JOIN LATERAL \(SELECT CASE i\.status /);
        // COUNT(i.id): a campaign with no interaction in the window (id NULL) is in none of the buckets, however NULL classifies.
        assert.match(sent[0]!.sql, /COUNT\(i\.id\) FILTER \(WHERE o\.outcome = 'actionable'\)::int AS actionable/);
        assert.deepEqual(sent[0]!.params, [TENANT, 7]);
    });
});

// ─── T040: /stats/failures ────────────────────────────────────────────────────────────────────
describe('GET /stats/failures — expected against actionable', () => {
    it('asks the database for how many of the window’s failures were expected, with the same patterns', async () => {
        const { sent } = await call('/stats/failures', { query: {} });
        assert.match(sent[0]!.sql, /\(SUM\(CASE WHEN CASE WHEN i\.error_log ~\* \$re\$.*END THEN COUNT\(\*\) ELSE 0 END\) OVER \(\)\)::int AS expected_total/);
        assert.ok(sent[0]!.sql.includes('Replied publicly with the link instead'));
    });

    it('answers expected_total and actionable_total over every FAILED row, even beyond the reasons it lists', async () => {
        const rows = [
            { error_log: 'Private Reply Failed: Error validating access token (Code: 190)', count: 2, last_at: new Date('2026-10-18T08:00:00Z'), total: 40, expected_total: 31 },
            { error_log: 'Skipped: recipient already received an automated DM within 24 hours.', count: 1, last_at: new Date('2026-10-18T09:00:00Z'), total: 40, expected_total: 31 },
        ];
        const { res } = await call('/stats/failures', { query: {} }, () => ({ rows }));
        assert.equal(res.body.total, 40);
        assert.equal(res.body.expected_total, 31, 'the database’s count wins over the two groups it sent');
        assert.equal(res.body.actionable_total, 9);
        assert.equal(res.body.reasons.find((r: any) => r.reason_code === 'recipient_cap').expected, true);
        assert.equal(res.body.reasons.find((r: any) => r.reason_code === '190').expected, false);
    });

    it('counts from the groups when the database sent no expected_total, and never above the total', async () => {
        const rows = [{ error_log: 'Skipped: hourly DM quota reached (181/180).', count: 4, last_at: null, total: 4 }];
        const { res } = await call('/stats/failures', { query: {} }, () => ({ rows }));
        assert.equal(res.body.expected_total, 4);
        assert.equal(res.body.actionable_total, 0);
    });
});

// ─── T040: GET /campaigns ─────────────────────────────────────────────────────────────────────
describe('GET /campaigns — counts.all', () => {
    const campaign = (over: Record<string, unknown> = {}) => ({
        id: 'c1', creator_id: TENANT, trigger_keyword: 'promo', is_active: true,
        total_interactions: 12, sent_count: 7, failed_count: 4,
        outcome_delivered: 7, outcome_by_design: 3, outcome_actionable: 1, outcome_pending: 1, outcome_blocked: 0,
        ...over,
    });

    it('folds the split into counts.all and keeps the legacy fields', async () => {
        const { res } = await call('/campaigns', {}, () => ({ rows: [campaign()] }));
        assert.equal(res.statusCode, 200);
        const [c] = res.body;
        assert.deepEqual(c.counts, { all: split(7, 3, 1, 1, 0) });
        assert.equal(c.total_interactions, 12);
        assert.equal(c.sent_count, 7);
        assert.equal(c.failed_count, 4);
        assert.equal(c.trigger_keyword, 'promo');
    });

    it('does not leak the temporary outcome_* columns into the response', async () => {
        const { res } = await call('/campaigns', {}, () => ({ rows: [campaign()] }));
        assert.deepEqual(Object.keys(res.body[0]).filter((k) => k.startsWith('outcome_')), []);
    });

    it('a campaign nothing has fired for is five zeros, not missing', async () => {
        const { res } = await call('/campaigns', {}, () => ({ rows: [campaign({
            total_interactions: 0, sent_count: 0, failed_count: 0,
            outcome_delivered: 0, outcome_by_design: 0, outcome_actionable: 0, outcome_pending: 0, outcome_blocked: 0,
        })] }));
        assert.deepEqual(res.body[0].counts.all, split(0, 0, 0, 0, 0));
    });

    it('classifies per campaign, in its own tenant, with the lateral outcome', async () => {
        const { sent } = await call('/campaigns', {}, () => ({ rows: [] }));
        assert.match(sent[0]!.sql, /FROM campaigns c LEFT JOIN interactions i ON i\.campaign_id = c\.id LEFT JOIN LATERAL \(SELECT CASE i\.status .* AS outcome\) o ON TRUE WHERE c\.creator_id = \$1 GROUP BY c\.id ORDER BY c\.created_at DESC/);
        assert.match(sent[0]!.sql, /COUNT\(i\.id\) FILTER \(WHERE o\.outcome = 'by_design'\)::int AS outcome_by_design/);
        assert.deepEqual(sent[0]!.params, [TENANT]);
    });
});

// ─── T042 (server half): GET /interactions ────────────────────────────────────────────────────
describe('GET /interactions — outcome on every row, and ?outcome=', () => {
    const answerRows = (rows: unknown[]) => (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ total: rows.length }] } : { rows });

    it('tags each row with its outcome from the one classifier, and changes nothing else on it', async () => {
        const rows = [
            { id: '1', status: 'SENT', error_log: null },
            { id: '2', status: 'FAILED', error_log: 'Skipped: recipient already received an automated DM within 24 hours.' },
            { id: '3', status: 'FAILED', error_log: 'Private Reply Failed: Error validating access token (Code: 190)' },
            { id: '4', status: 'PENDING', error_log: null },
            { id: '5', status: 'USER_BLOCKED_DMS', error_log: null },
        ];
        const { res } = await call('/interactions', { query: {} }, answerRows(rows));
        assert.deepEqual(res.body.data.map((r: any) => [r.id, r.outcome]), [
            ['1', 'delivered'], ['2', 'by_design'], ['3', 'actionable'], ['4', 'pending'], ['5', 'blocked'],
        ]);
        assert.equal(res.body.data[2].error_log, rows[2]!.error_log);
        assert.equal(res.body.data[2].status, 'FAILED');
    });

    it('filters by outcome, in the rows and in the total, with the value bound and the SQL from the one source', async () => {
        const { sent } = await call('/interactions', { query: { outcome: 'actionable', status: 'FAILED' } }, answerRows([]));
        for (const q of sent) {
            assert.ok(q.sql.includes(' = $3'), 'the outcome is a bound parameter');
            assert.match(q.sql, /AND CASE i\.status WHEN 'SENT' THEN 'delivered' .* END = \$3/);
            assert.deepEqual(q.params.slice(0, 3), [TENANT, 'FAILED', 'actionable']);
        }
    });

    it('ignores an outcome it does not know, instead of filtering to nothing or passing it on', async () => {
        const { sent } = await call('/interactions', { query: { outcome: "x' OR 1=1 --" } }, answerRows([]));
        for (const q of sent) assert.ok(!/CASE i\.status/.test(q.sql));
        assert.deepEqual(sent[0]!.params, [TENANT]);
    });
});
