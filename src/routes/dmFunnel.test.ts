/**
 * The two server halves of the inbox's sales view (DM plan S11, S12):
 *
 *   `GET /api/dm/funnel?days=7|30|90`   the funnel card: the window, the tenant, what it answers and what it refuses
 *   `GET /api/conversations`            the stage and the link clicks each thread now carries
 *
 * Every handler is pulled off the router's own stack and run against a stubbed `pool.query`, like inboxDetail.test.ts. What is asserted is the
 * SQL each one sends (the tenant is always `$1`, and always the SESSION's), the shape it answers with, and what it does when a part of it is
 * not available. Nothing here reaches Postgres. The numbers themselves are `dmFunnel.test.ts`'s, and `dmFunnel.sql.test.ts` runs the statements.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { DM_FUNNEL_CLICKS_SQL, DM_FUNNEL_CONVERSATIONS_SQL, DM_FUNNEL_REPLY_SQL, DM_FUNNEL_VARIANTS_SQL } from '../services/dmFunnel.js';
import { LINK_CLICKS_SQL } from '../services/inboxDetail.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CONV_A = '33333333-3333-4333-8333-333333333333';
const CONV_B = '44444444-4444-4444-8444-444444444444';

/** The log lines of the test so far, parsed: `{ event, level, … }`. */
let logs: Array<Record<string, unknown>> = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
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

async function call(
    path: string,
    req: { query?: Record<string, unknown>; tenant?: string },
    answer: (sql: string, params: unknown[]) => { rows: unknown[] } | Error = () => ({ rows: [] }),
) {
    const headers: Record<string, string> = {};
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        set(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
    const sent: Sent[] = [];
    const original = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const out = answer(sql, params);
        if (out instanceof Error) throw out;
        return { ...out, rowCount: out.rows.length };
    };
    try {
        await handlerFor('get', path)(
            { query: req.query ?? {}, params: {}, body: {}, session: { userId: 'u-1', role: 'user', tenantId: req.tenant ?? TENANT }, headers: {} },
            res,
            () => {}
        );
    } finally {
        (pool as unknown as { query: unknown }).query = original;
    }
    return { res, sent, headers };
}

const same = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const FUNNEL_STATEMENTS = [DM_FUNNEL_CONVERSATIONS_SQL, DM_FUNNEL_CLICKS_SQL, DM_FUNNEL_REPLY_SQL].map(same);

/** What the three funnel statements answer: one linked conversation with a person's click, answered in 4 s. */
function funnelRows(sql: string): { rows: unknown[] } {
    const flat = same(sql);
    if (flat === FUNNEL_STATEMENTS[0]) {
        return { rows: [{ id: CONV_A, stage: 'link', qualifier_turns: 1, links_sent: 1, last_link_at: new Date(), followups_sent: 0, handoff_at: null, handoff_reason: null, opted_out_at: null, stages_seen: ['link'] }] };
    }
    if (flat === FUNNEL_STATEMENTS[1]) return { rows: [{ conversation_id: CONV_A, is_prefetch: false, n: 2 }, { conversation_id: CONV_A, is_prefetch: true, n: 5 }] };
    if (flat === FUNNEL_STATEMENTS[2]) return { rows: [{ n: 1, p50_ms: 4000, p90_ms: 4000 }] };
    return { rows: [] };
}

describe('GET /dm/funnel', () => {
    it('answers the last 30 days by default: three statements, each bound to the session\'s tenant and a window start, and one read of the tenant\'s A/B experiment', async () => {
        const before = Date.now();
        const { res, sent: all, headers } = await call('/dm/funnel', {}, funnelRows);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.days, 30);
        assert.equal(headers['cache-control'], 'no-store');
        const sent = all.filter((s) => !s.sql.includes('FROM app_settings'));
        assert.deepEqual(sent.map((s) => s.sql).sort(), [...FUNNEL_STATEMENTS].sort());
        const experiment = all.filter((s) => s.sql.includes('FROM app_settings'));
        assert.deepEqual(experiment.map((s) => s.params), [[`dm.variants.${TENANT}`]], 'the tenant\'s own row of the A/B experiment, and nothing else is read for it');
        assert.equal(res.body.variants, undefined, 'a tenant with no saved experiment has no A/B section, and no statement about arms is sent');
        for (const s of sent) {
            assert.equal(s.params.length, 2);
            assert.equal(s.params[0], TENANT, 'the tenant is the session\'s');
            const since = s.params[1] as Date;
            assert.ok(since instanceof Date);
            assert.ok(Math.abs(before - 30 * 86_400_000 - since.getTime()) < 5_000, 'thirty days back');
        }
    });

    it('takes 7 or 90 days when asked, and answers in the shape the card draws', async () => {
        const week = await call('/dm/funnel', { query: { days: '7' } }, funnelRows);
        assert.equal(week.res.body.days, 7);
        const quarter = await call('/dm/funnel', { query: { days: '90' } }, funnelRows);
        assert.equal(quarter.res.body.days, 90);
        const body = quarter.res.body;
        assert.deepEqual(Object.keys(body).sort(), ['clicks', 'conversations', 'days', 'outcomes', 'rates', 'reply', 'since', 'steps']);
        assert.equal(body.conversations, 1);
        assert.deepEqual(body.steps.map((s: { id: string; count: number }) => [s.id, s.count]), [['conversations', 1], ['qualified', 1], ['recommended', 1], ['link_sent', 1], ['clicked', 1]]);
        assert.deepEqual(body.clicks, { people: 1, human: 2, preview: 5 }, 'the previews are shown beside the clicks, never in them');
        assert.deepEqual(body.reply, { sample: 1, median_ms: 4000, p90_ms: 4000 });
    });

    const SAVED = JSON.stringify({
        v: 1,
        config: {
            enabled: true,
            variants: [
                { id: 'A', label: 'Warm', weight: 50, opening: '', cta: '' },
                { id: 'B', label: 'Direct', weight: 50, opening: 'Open with one short question.', cta: '' },
            ],
        },
    });
    const withExperiment = (arms: (sql: string) => { rows: unknown[] } | Error) => (sql: string): { rows: unknown[] } | Error => {
        if (sql.includes('FROM app_settings')) return { rows: [{ value: SAVED, is_secret: false }] };
        if (same(sql) === same(DM_FUNNEL_VARIANTS_SQL)) return arms(sql);
        return funnelRows(sql);
    };

    it('with a saved experiment, asks which arm each conversation was given (one more statement, the tenant and the window) and answers the A/B section', async () => {
        const { res, sent } = await call('/dm/funnel', {}, withExperiment(() => ({ rows: [{ id: CONV_A, sales_variant: 'B' }] })));
        assert.equal(res.statusCode, 200);
        const arms = sent.filter((s) => s.sql === same(DM_FUNNEL_VARIANTS_SQL));
        assert.equal(arms.length, 1);
        assert.equal(arms[0]!.params[0], TENANT);
        assert.ok(arms[0]!.params[1] instanceof Date);
        const v = res.body.variants;
        assert.equal(v.running, true);
        assert.equal(v.min_sample, 30);
        assert.deepEqual(v.arms.map((a: { id: string; label: string; conversations: number; link_sent: number; clicked: number; enough: boolean }) => [a.id, a.label, a.conversations, a.link_sent, a.clicked, a.enough]),
            [['A', 'Warm', 0, 0, 0, false], ['B', 'Direct', 1, 1, 1, false]]);
        assert.equal(v.arms[1].link.pct, null, 'one conversation is not a rate');
        assert.equal(JSON.stringify(res.body).includes(CONV_A), false, 'no conversation id');
    });

    it('answers the funnel without the A/B section when the arm column is not there (v42 not applied): a warning, never a failed funnel', async () => {
        logs = [];
        const { res } = await call('/dm/funnel', {}, withExperiment(() => Object.assign(new Error('column c.sales_variant does not exist'), { code: '42703' })));
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.conversations, 1);
        assert.equal(res.body.variants, undefined);
        assert.ok(logs.some((l) => l.event === 'dm.funnel_variants_unavailable'));
    });

    it('refuses any other window, and a list or an object where one number belongs, without touching the database', async () => {
        for (const days of ['1', '0', '14', '365', 'abc', ['7', '30'], { a: '7' }]) {
            const { res, sent } = await call('/dm/funnel', { query: { days } }, funnelRows);
            assert.equal(res.statusCode, 400, JSON.stringify(days));
            assert.deepEqual(res.body, { error: 'days must be 7, 30 or 90.' });
            assert.deepEqual(sent, []);
        }
    });

    it('is the tenant\'s own: another session binds its own tenant, and nothing in the request can name a different one', async () => {
        // The experiment row is keyed by the tenant too (`dm.variants.<tenant>`): the id in the key is the session's.
        const own = (id: string) => (p: unknown) => p === id || p === `dm.variants.${id}`;
        const mine = await call('/dm/funnel', { tenant: OTHER_TENANT, query: { tenant: TENANT, creator_id: TENANT, tenantId: TENANT } }, funnelRows);
        assert.equal(mine.res.statusCode, 200);
        for (const s of mine.sent) {
            assert.ok(own(OTHER_TENANT)(s.params[0]), String(s.params[0]));
            assert.ok(!s.params.some((p) => String(p).includes(TENANT)), 'a tenant id from the query string never reaches SQL');
        }
        const first = await call('/dm/funnel', { tenant: TENANT }, funnelRows);
        for (const s of first.sent) assert.ok(own(TENANT)(s.params[0]), String(s.params[0]));
    });

    it('holds no conversation id in its answer', async () => {
        const { res } = await call('/dm/funnel', {}, funnelRows);
        assert.equal(JSON.stringify(res.body).includes(CONV_A), false);
    });

    it('is mounted below the router\'s sign-in, live-session and tenant gates, like the inbox it sits in', () => {
        const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
        const mount = source.indexOf("router.get('/dm/funnel'");
        assert.ok(mount > 0);
        for (const gate of ['router.use(requireAuth);', 'router.use(requireLiveSession);', 'router.use(resolveTenant);']) {
            const at = source.indexOf(gate);
            assert.ok(at > 0 && at < mount, `${gate} comes before the funnel`);
        }
    });

    it('says what to do when the database is behind a migration, and says nothing of the error otherwise', async () => {
        const missing = await call('/dm/funnel', {}, () => Object.assign(new Error('relation "tracked_links" does not exist'), { code: '42P01' }));
        assert.equal(missing.res.statusCode, 503);
        assert.match(missing.res.body.error, /npm run migrate/);

        logs = [];
        const broken = await call('/dm/funnel', {}, () => new Error('connection to server at "db.internal.example" failed, password=hunter2'));
        assert.equal(broken.res.statusCode, 500);
        assert.deepEqual(broken.res.body, { error: 'Failed to build the funnel.' });
        assert.ok(logs.some((l) => l.event === 'api.dm_funnel_failed'));
    });
});

// ─── GET /conversations: the stage and the link clicks ───────────────────────────────────────────

describe('GET /conversations: the sales view of each thread', () => {
    const listRows = (sql: string, params: unknown[], clicks: { rows: unknown[] } | Error): { rows: unknown[] } | Error => {
        if (/SELECT COUNT\(\*\)::int as total/.test(sql)) return { rows: [{ total: 2 }] };
        if (same(sql) === same(LINK_CLICKS_SQL)) return clicks;
        return {
            rows: [
                { id: CONV_A, platform: 'instagram', stage: 'link', last_intent: 'ready_to_buy', handoff_reason: null, handoff_at: null, last_link_at: new Date('2026-10-14T09:00:00Z'), opted_out_at: null, followups_sent: 0 },
                { id: CONV_B, platform: 'instagram' },   // a database without v39
            ],
        };
    };

    it('asks for the click counts of exactly the threads on the page, for the session\'s tenant, once', async () => {
        const { res, sent } = await call('/conversations', {}, (sql, params) => listRows(sql, params, { rows: [] }));
        assert.equal(res.statusCode, 200);
        const clickQueries = sent.filter((s) => s.sql === same(LINK_CLICKS_SQL));
        assert.equal(clickQueries.length, 1);
        assert.deepEqual(clickQueries[0]!.params, [TENANT, [CONV_A, CONV_B]]);
    });

    it('counts a PERSON\'s clicks only: the statement filters previews out of `clicks`, and counts them on their own', () => {
        const sql = same(LINK_CLICKS_SQL);
        assert.match(sql, /COUNT\(lc\.id\) FILTER \(WHERE NOT lc\.is_prefetch\)::int AS clicks/);
        assert.match(sql, /COUNT\(lc\.id\) FILTER \(WHERE lc\.is_prefetch\)::int AS prefetch/);
        assert.match(sql, /MAX\(lc\.clicked_at\) FILTER \(WHERE NOT lc\.is_prefetch\) AS last_click_at/);
        assert.match(sql, /WHERE tl\.creator_id = \$1 AND tl\.conversation_id = ANY\(\$2::uuid\[\]\)/);
    });

    it('answers each thread with its stage, intent, handoff and link facts typed, and its link clicks (null when it has no link)', async () => {
        const clicks = { rows: [{ conversation_id: CONV_A, links: 1, clicks: 3, prefetch: 4, last_click_at: new Date('2026-10-14T10:30:00Z') }] };
        const { res } = await call('/conversations', {}, (sql, params) => listRows(sql, params, clicks));
        const [a, b] = res.body.data;
        assert.equal(a.stage, 'link');
        assert.equal(a.last_intent, 'ready_to_buy');
        assert.equal(a.last_link_at, '2026-10-14T09:00:00.000Z');
        assert.deepEqual(a.link_clicks, { links: 1, clicks: 3, prefetch: 4, last_click_at: '2026-10-14T10:30:00.000Z' });
        for (const key of ['stage', 'last_intent', 'handoff_reason', 'handoff_at', 'last_link_at', 'opted_out_at', 'followups_sent', 'link_clicks']) {
            assert.equal(b[key], null, `${key} is null, not absent, on a database without the migrations`);
        }
    });

    it('a stage that is not one of the flow\'s is no stage', async () => {
        const { res } = await call('/conversations', {}, (sql) => (
            /COUNT\(\*\)/.test(sql) ? { rows: [{ total: 1 }] } : same(sql) === same(LINK_CLICKS_SQL) ? { rows: [] } : { rows: [{ id: CONV_A, stage: '<img src=x onerror=alert(1)>' }] }
        ));
        assert.equal(res.body.data[0].stage, null);
    });

    it('is never held up by the click counts: a failing lookup is logged, and the list is answered without them', async () => {
        logs = [];
        const { res } = await call('/conversations', {}, (sql, params) => listRows(sql, params, Object.assign(new Error('relation "tracked_links" does not exist'), { code: '42P01' })));
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.data.length, 2);
        assert.equal(res.body.data[0].link_clicks, null);
        assert.equal(res.body.data[0].stage, 'link', 'and the rest of the thread is untouched');
        assert.ok(logs.some((l) => l.event === 'inbox.detail_failed' && l.what === 'link_clicks'));
    });

    it('asks nothing of the click table for an empty page', async () => {
        const { sent } = await call('/conversations', {}, (sql) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ total: 0 }] } : { rows: [] }));
        assert.equal(sent.some((s) => s.sql === same(LINK_CLICKS_SQL)), false);
    });
});
