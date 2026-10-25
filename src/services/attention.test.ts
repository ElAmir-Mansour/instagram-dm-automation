/**
 * The attention summary: what needs the owner, in what order, and what is deliberately left out.
 *
 * Two layers, as in dmFunnel.test.ts. `buildAttention` is pure: facts in, items and nav counts out, so every rule about WHICH items
 * exist, their words, severity, link and order is pinned here with no database. The statements are asserted as text and as bound
 * parameters against a stubbed `pool.query`, because what they exclude (archived, handled, other tenants) is decided in SQL: the clause
 * that does it is named in a test, and removing it fails one. Nothing here reaches Postgres, Meta or the network, and one test makes
 * that a failure if it ever does.
 *
 * The statements were also run, once, against a real Postgres holding this repo's schema and every migration, on a hand-built world with
 * known answers (handoffs answered before and after, handled threads, archived and grouped posts, a second tenant). That is not part of
 * this suite, which has no database; the pull request says what it showed.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from './http.js';
import {
    buildAttention, CONNECTIONS_ATTENTION_SQL, compareItems, dominantReason, getAttention, OVERDUE_GRACE_MINUTES, POSTS_ATTENTION_SQL,
    THREADS_ATTENTION_SQL, type AttentionFacts, type AttentionItem,
} from './attention.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-10-19T09:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const none = { count: 0, oldestAt: null };
function facts(over: Partial<AttentionFacts> = {}): AttentionFacts {
    return {
        handoff: { ...none, reasons: [] },
        waiting: none,
        postsFailed: none,
        postsOverdue: none,
        connections: [{ integration: 'meta', broken: false, at: null }],
        ...over,
    };
}
const types = (items: AttentionItem[]) => items.map((i) => i.type);

describe('buildAttention: a calm tenant', () => {
    it('has no items and zero counts, and says nothing about a connection that works', () => {
        assert.deepEqual(buildAttention(facts()), { items: [], counts: { inbox: 0, studio: 0, scheduler: 0 } });
        const both = facts({ connections: [{ integration: 'meta', broken: false, at: null }, { integration: 'tiktok', broken: false, at: iso(5) }] });
        assert.deepEqual(buildAttention(both).items, []);
    });

    it('has nothing at all while nothing is connected yet: the Get-started panel speaks for it', () => {
        const loud = facts({
            handoff: { count: 3, oldestAt: iso(60), reasons: [{ reason: 'refund', count: 3 }] }, waiting: { count: 2, oldestAt: iso(30) },
            postsFailed: { count: 1, oldestAt: iso(900) }, postsOverdue: { count: 1, oldestAt: iso(40) }, connections: [],
        });
        assert.deepEqual(buildAttention(loud), { items: [], counts: { inbox: 0, studio: 0, scheduler: 0 } });
    });
});

describe('buildAttention: handoff', () => {
    const handoff = (over: Partial<AttentionFacts['handoff']> = {}) =>
        buildAttention(facts({ handoff: { count: 2, oldestAt: iso(300), reasons: [{ reason: 'refund', count: 2 }], ...over } })).items[0]!;

    it('is one warning, with its count, dominant reason, one verb and the To-do link', () => {
        assert.deepEqual(handoff(), {
            type: 'handoff', severity: 'warning', count: 2,
            sentence: { key: 'attention.handoff', params: { n: 2, reason: 'refund' } },
            action: { verb: 'attention.verb.reply', href: '#/inbox?filter=todo' },
            oldestAt: iso(300),
        });
    });

    it('names no reason when none of the threads carries one', () => {
        assert.deepEqual(handoff({ reasons: [] }).sentence.params, { n: 2 });
        assert.deepEqual(handoff({ reasons: [{ reason: 'none', count: 2 }] }).sentence.params, { n: 2 });
    });

    it('is absent at zero, and carries no oldestAt when it has no date', () => {
        assert.deepEqual(buildAttention(facts({ handoff: { count: 0, oldestAt: null, reasons: [] } })).items, []);
        assert.equal('oldestAt' in handoff({ oldestAt: null }), false);
    });

    it('counts into the Inbox, together with the waiting threads and each thread once', () => {
        const { counts } = buildAttention(facts({
            handoff: { count: 2, oldestAt: iso(300), reasons: [] }, waiting: { count: 3, oldestAt: iso(20) },
        }));
        assert.equal(counts.inbox, 5);
    });

    it('waiting threads raise the Inbox count but are not an item of their own', () => {
        const out = buildAttention(facts({ waiting: { count: 4, oldestAt: iso(20) } }));
        assert.deepEqual(out.items, []);
        assert.equal(out.counts.inbox, 4);
    });
});

describe('dominantReason', () => {
    it('is the most common, ties broken by name, never "none" or blank', () => {
        assert.equal(dominantReason([{ reason: 'refund', count: 1 }, { reason: 'complaint', count: 3 }]), 'complaint');
        assert.equal(dominantReason([{ reason: 'refund', count: 2 }, { reason: 'complaint', count: 2 }]), 'complaint');
        assert.equal(dominantReason([{ reason: 'none', count: 9 }, { reason: '', count: 9 }, { reason: 'abuse', count: 1 }]), 'abuse');
        assert.equal(dominantReason([]), null);
        assert.equal(dominantReason([{ reason: 'none', count: 2 }]), null);
        assert.equal(dominantReason([{ reason: 'refund', count: 0 }]), null);
    });
});

describe('buildAttention: posts', () => {
    it('a failed post is a danger that goes to Needs you', () => {
        const [item] = buildAttention(facts({ postsFailed: { count: 2, oldestAt: iso(2880) } })).items;
        assert.deepEqual(item, {
            type: 'post_failed', severity: 'danger', count: 2,
            sentence: { key: 'attention.post_failed', params: { n: 2 } },
            action: { verb: 'attention.verb.review', href: '#/posts?filter=needs-you' },
            oldestAt: iso(2880),
        });
    });

    it('an overdue post is a warning, and says how late counts as overdue', () => {
        const [item] = buildAttention(facts({ postsOverdue: { count: 1, oldestAt: iso(40) } })).items;
        assert.deepEqual(item, {
            type: 'post_overdue', severity: 'warning', count: 1,
            sentence: { key: 'attention.post_overdue', params: { n: 1, minutes: 15 } },
            action: { verb: 'attention.verb.review', href: '#/posts?filter=needs-you' },
            oldestAt: iso(40),
        });
        assert.equal(OVERDUE_GRACE_MINUTES, 15);
    });

    it('both feed the Scheduler count, and only they do', () => {
        const { counts } = buildAttention(facts({ postsFailed: { count: 2, oldestAt: iso(10) }, postsOverdue: { count: 1, oldestAt: iso(10) } }));
        assert.deepEqual(counts, { inbox: 0, studio: 0, scheduler: 3 });
    });
});

describe('buildAttention: connections', () => {
    it('a broken one is a danger that takes the owner to that integration, one item each', () => {
        const items = buildAttention(facts({
            connections: [
                { integration: 'meta', broken: false, at: null },
                { integration: 'tiktok', broken: true, at: iso(900) },
                { integration: 'youtube', broken: true, at: null },
            ],
        })).items;
        assert.deepEqual(items.map((i) => i.sentence.params), [{ platform: 'tiktok' }, { platform: 'youtube' }]);
        assert.deepEqual(items[0], {
            type: 'connection_broken', severity: 'danger', count: 1,
            sentence: { key: 'attention.connection_broken', params: { platform: 'tiktok' } },
            action: { verb: 'attention.verb.reconnect', href: '#/settings?s=tiktok' },
            oldestAt: iso(900),
        });
        assert.equal(items[1]!.action.href, '#/settings?s=youtube');
    });

    it('is not a nav count: Settings has no badge', () => {
        const { counts } = buildAttention(facts({ connections: [{ integration: 'meta', broken: true, at: iso(1) }] }));
        assert.deepEqual(counts, { inbox: 0, studio: 0, scheduler: 0 });
    });
});

describe('buildAttention: order', () => {
    const everything = facts({
        handoff: { count: 1, oldestAt: iso(100), reasons: [] },
        postsFailed: { count: 1, oldestAt: iso(500) },
        postsOverdue: { count: 1, oldestAt: iso(50) },
        connections: [
            { integration: 'meta', broken: true, at: iso(10) },
            { integration: 'tiktok', broken: true, at: iso(900) },
            { integration: 'youtube', broken: true, at: null },
        ],
    });

    it('severity first, then the longest waiting, undated last', () => {
        const out = buildAttention(everything).items;
        assert.deepEqual(out.map((i) => `${i.severity}:${i.type}:${i.sentence.params.platform ?? ''}`), [
            'danger:connection_broken:tiktok',    // waited 900 min
            'danger:post_failed:',                // waited 500 min
            'danger:connection_broken:meta',      // waited 10 min
            'danger:connection_broken:youtube',   // no date: after every dated one
            'warning:handoff:',                   // 100 min
            'warning:post_overdue:',              // 50 min
        ]);
    });

    it('is the same whatever order the facts arrive in', () => {
        const forward = buildAttention(everything).items;
        const reversed = buildAttention({ ...everything, connections: [...everything.connections].reverse() }).items;
        assert.deepEqual(reversed, forward);
    });

    it('compareItems is a total order: two items alike in severity, date and type still sort the same both ways', () => {
        const base: AttentionItem = {
            type: 'connection_broken', severity: 'danger', count: 1, sentence: { key: 'k', params: { platform: 'a' } }, action: { verb: 'v', href: '#' },
        };
        const other: AttentionItem = { ...base, sentence: { key: 'k', params: { platform: 'b' } } };
        assert.equal(Math.sign(compareItems(base, other)), -Math.sign(compareItems(other, base)));
        assert.notEqual(compareItems(base, other), 0);
        assert.equal(compareItems(base, base), 0);
    });

    it('lists only the types this change implements', () => {
        assert.deepEqual([...new Set(types(buildAttention(everything).items))].sort(), ['connection_broken', 'handoff', 'post_failed', 'post_overdue']);
    });
});

// ─── The statements ──────────────────────────────────────────────────────────────────────────

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('the statements exclude what is not the owner’s to do', () => {
    it('threads: handled ones and other tenants never count', () => {
        const sql = flat(THREADS_ATTENTION_SQL);
        assert.match(sql, /WHERE c\.creator_id = \$1 AND c\.handled_at IS NULL AND/);
    });

    it('threads: a handoff ends with an operator reply at or after it; a missing handoff_at is never answered', () => {
        const sql = flat(THREADS_ATTENTION_SQL);
        assert.match(sql, /c\.stage = 'handoff' AND NOT \(c\.handoff_at IS NOT NULL AND fx\.last_operator_at IS NOT NULL AND fx\.last_operator_at >= c\.handoff_at\)/);
        assert.match(sql, /m3\.direction = 'outbound' AND m3\.sender = 'operator'/);
    });

    it('threads: waiting is the bot off and the newest message the customer’s, and only when it is not already a handoff', () => {
        const sql = flat(THREADS_ATTENTION_SQL);
        assert.match(sql, /THEN 'handoff' WHEN c\.is_bot_active = false AND lm\.direction = 'inbound' THEN 'waiting' END AS kind/);
        assert.match(sql, /ORDER BY m\.created_at DESC LIMIT 1/);
    });

    it('threads: aggregated in SQL, one row per kind and reason', () => {
        assert.match(flat(THREADS_ATTENTION_SQL), /GROUP BY t\.kind, t\.reason$/);
    });

    it('posts: archived ones never count, FAILED is the only failure, and PENDING is overdue only after the grace', () => {
        const sql = flat(POSTS_ATTENTION_SQL);
        assert.match(sql, /WHERE s\.creator_id = \$1 AND s\.archived_at IS NULL AND s\.status IN \('FAILED', 'PENDING'\)/);
        assert.match(sql, /FILTER \(WHERE s\.status = 'FAILED'\)/);
        assert.match(sql, /FILTER \(WHERE s\.status = 'PENDING' AND s\.scheduled_time < NOW\(\) - make_interval\(mins => \$2\)\)/);
    });

    it('posts: a post that went to several platforms is one', () => {
        assert.match(flat(POSTS_ATTENTION_SQL), /COUNT\(DISTINCT COALESCE\(s\.group_id, s\.id\)\)/);
    });

    it('connections: Meta only with a token, and "broken" is the stored status, never a live answer', () => {
        const sql = flat(CONNECTIONS_ATTENTION_SQL);
        assert.match(sql, /\(c\.token_status = 'invalid'\) AS broken/);
        assert.match(sql, /c\.page_access_token IS NOT NULL/);
        assert.match(sql, /pc\.status IN \('invalid', 'revoked'\)/);
        assert.match(sql, /WHERE pc\.creator_id = \$1/);
    });
});

// ─── getAttention against a stubbed pool ─────────────────────────────────────────────────────

interface Sent { sql: string; params: unknown[] }
type Answer = (sql: string, params: unknown[]) => unknown[] | Error | undefined;

let sent: Sent[];
let graph: string[];
const originalQuery = pool.query;
const originalGet = metaHttp.get;
const originalPost = metaHttp.post;

beforeEach(() => {
    sent = [];
    graph = [];
    (metaHttp as any).get = async (url: string) => { graph.push(`GET ${url}`); throw new Error('the attention summary must not call Meta'); };
    (metaHttp as any).post = async (url: string) => { graph.push(`POST ${url}`); throw new Error('the attention summary must not call Meta'); };
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originalGet;
    (metaHttp as any).post = originalPost;
});

/** Route each statement to the answer for it, by what it reads. Anything not arranged answers no rows. */
function install(answer: Partial<Record<'health' | 'worker' | 'threads' | 'posts' | 'connections' | 'queue' | 'schema', Answer>>) {
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: flat(sql), params });
        const text = flat(sql);
        const kind =
            text === flat(THREADS_ATTENTION_SQL) ? 'threads'
            : text === flat(POSTS_ATTENTION_SQL) ? 'posts'
            : text === flat(CONNECTIONS_ATTENTION_SQL) ? 'connections'
            : /FROM studio_workers/.test(sql) ? 'worker'
            : /FROM schema_migrations/.test(sql) ? 'schema'
            : /FROM jobs\s*$/.test(sql.trim()) ? 'queue'
            : /FROM creators c\s+LEFT JOIN LATERAL/.test(sql) ? 'health'
            : null;
        assert.ok(kind, `an unexpected statement: ${flat(sql).slice(0, 120)}`);
        const out = answer[kind]?.(sql, params);
        if (out instanceof Error) throw out;
        const rows = out ?? [];
        return { rows, rowCount: rows.length };
    };
}

const healthRow = (over: Record<string, unknown> = {}) => ({
    id: TENANT, name: 'A', is_active: true, instagram_page_id: 'ig', facebook_page_id: null,
    token_status: 'valid', token_last_checked_at: null, token_error: null, token_expires_at: null, token_data_access_expires_at: null,
    last_comment_at: new Date(iso(12)), last_inbound_dm_at: new Date(iso(180)), last_job_at: new Date(iso(3)),
    dm_this_hour: 0, jobs_pending: 2, jobs_running: 0, jobs_failed: 1, jobs_oldest_pending_at: new Date(iso(7)),
    posts_pending: 0, posts_failed_7d: 0, ...over,
});

describe('getAttention', () => {
    it('answers the contract’s shape for a calm, connected tenant, with the heartbeat read from columns', async () => {
        install({
            health: () => [healthRow()],
            worker: () => [{ name: 'Mac', last_seen_at: new Date(NOW - 30_000) }],
            posts: () => [{ failed: 0, failed_oldest_at: null, overdue: 0, overdue_oldest_at: null }],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
        });
        const out = await getAttention(TENANT, { now: NOW });
        assert.equal(out.checkedAt, '2026-10-19T09:00:00.000Z');
        assert.deepEqual(out.items, []);
        assert.deepEqual(out.counts, { inbox: 0, studio: 0, scheduler: 0 });
        assert.deepEqual(out.heartbeat, {
            lastCommentAt: iso(12), lastDmAt: iso(180), lastWebhookAt: iso(3),
            queue: { pending: 2, oldestPendingAt: iso(7), failed: 1 },
            worker: { online: true, lastSeenAt: new Date(NOW - 30_000).toISOString() },
        });
    });

    it('assembles items and counts from the three fact queries', async () => {
        install({
            health: () => [healthRow()],
            threads: () => [
                { kind: 'handoff', reason: 'refund', n: 2, oldest_at: new Date(iso(300)) },
                { kind: 'handoff', reason: 'complaint', n: 1, oldest_at: new Date(iso(500)) },
                { kind: 'waiting', reason: null, n: 4, oldest_at: new Date(iso(20)) },
            ],
            posts: () => [{ failed: 1, failed_oldest_at: new Date(iso(2000)), overdue: 2, overdue_oldest_at: new Date(iso(60)) }],
            connections: () => [{ integration: 'meta', broken: false, at: null }, { integration: 'youtube', broken: true, at: new Date(iso(30)) }],
        });
        const out = await getAttention(TENANT, { now: NOW });

        assert.deepEqual(out.counts, { inbox: 7, studio: 0, scheduler: 3 });
        assert.deepEqual(out.items.map((i) => [i.type, i.count]), [
            ['post_failed', 1], ['connection_broken', 1], ['handoff', 3], ['post_overdue', 2],
        ]);
        const handoff = out.items.find((i) => i.type === 'handoff')!;
        assert.deepEqual(handoff.sentence.params, { n: 3, reason: 'refund' });
        assert.equal(handoff.oldestAt, iso(500), 'the oldest across both reasons');
    });

    it('scopes every statement to the tenant it was asked about', async () => {
        install({ health: () => [healthRow()] });
        await getAttention(TENANT, { now: NOW });
        assert.equal(sent.length, 5);
        for (const s of sent) assert.equal(s.params[0], TENANT, s.sql.slice(0, 80));
    });

    it('binds the grace as a parameter, not into the text', async () => {
        install({ health: () => [healthRow()] });
        await getAttention(TENANT, { now: NOW });
        const posts = sent.find((s) => s.sql === flat(POSTS_ATTENTION_SQL))!;
        assert.deepEqual(posts.params, [TENANT, OVERDUE_GRACE_MINUTES]);
    });

    it('is a handful of reads, and every one is the database: no Graph call is ever made', async () => {
        install({ health: () => [healthRow()] });
        await getAttention(TENANT, { now: NOW });
        assert.equal(sent.length, 5, 'tenant health, worker, threads, posts, connections');
        assert.deepEqual(graph, []);
    });

    it('adds the platform count for a platform admin only, from the signals that exist', async () => {
        const queue: Answer = () => [{ pending: 0, running: 0, failed: 0, done: 0, cancelled: 0, oldest_pending_at: null, stale: 2 }];
        const schema: Answer = () => [{ filename: 'schema.sql' }];
        install({ health: () => [healthRow()], queue, schema });

        const plain = await getAttention(TENANT, { now: NOW });
        assert.equal('platform' in plain.counts, false, 'a tenant never sees the platform count');

        const admin = await getAttention(TENANT, { now: NOW, platformAdmin: true });
        assert.equal(admin.counts.platform, 2, 'a stale claim, and migrations pending');
    });

    it('is zero platform problems when nothing is stale and the schema is current', async () => {
        const { EXPECTED_MIGRATIONS } = await import('../config/migrations.js');
        install({
            health: () => [healthRow()],
            queue: () => [{ pending: 0, running: 0, failed: 0, done: 0, cancelled: 0, oldest_pending_at: null, stale: 0 }],
            schema: () => EXPECTED_MIGRATIONS.map((filename) => ({ filename })),
        });
        assert.equal((await getAttention(TENANT, { now: NOW, platformAdmin: true })).counts.platform, 0);
    });

    it('reads a tenant with no health row, no worker and no facts as empty, not as an error', async () => {
        install({});
        const out = await getAttention(TENANT, { now: NOW });
        assert.deepEqual(out.heartbeat, {
            lastCommentAt: null, lastDmAt: null, lastWebhookAt: null,
            queue: { pending: 0, oldestPendingAt: null, failed: 0 }, worker: { online: false, lastSeenAt: null },
        });
        assert.deepEqual(out.items, []);
    });

    it('fails whole when any read fails: a half-answer would read as "nothing needs you"', async () => {
        for (const broken of ['health', 'worker', 'threads', 'posts', 'connections'] as const) {
            install({ health: () => [healthRow()], [broken]: () => new Error(`${broken} is down`) });
            await assert.rejects(getAttention(TENANT, { now: NOW }), new RegExp(`${broken} is down`), broken);
        }
    });
});
