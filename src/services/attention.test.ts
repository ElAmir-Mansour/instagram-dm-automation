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
import { TENANT_HEALTH_SQL } from './health.js';
import { invalidateModulesCache } from './modules.js';
import { invalidateTenantCache } from './tenant.js';
import {
    bucketFailed, buildAttention, CONNECTIONS_ATTENTION_SQL, compareItems, dominantReason, FAILED_POSTS_DETAIL_SQL, failureCode, failureReason, getAttention,
    OVERDUE_GRACE_MINUTES, POST_FAILED_OLD_DAYS, POSTS_ATTENTION_SQL, THREADS_NEEDING_PERSON_SQL, threadFacts,
    REEL_REVIEW_ATTENTION_SQL, STUDIO_JOBS_WAITING_SQL, THREADS_ATTENTION_SQL, TIKTOK_DRAFTS_ATTENTION_SQL, TIKTOK_DRAFT_DAYS,
    WORKER_OFFLINE_MINUTES, workerOfflineFact, type AttentionFacts, type AttentionItem, type StudioFacts,
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

    it('waiting threads are an item of their own (U2): the Inbox count and the nav badge include them, so Today must say them too', () => {
        const out = buildAttention(facts({ waiting: { count: 4, oldestAt: iso(20) } }));
        assert.deepEqual(out.items, [{
            type: 'thread_waiting', severity: 'warning', count: 4,
            sentence: { key: 'attention.thread_waiting', params: { n: 4 } },
            action: { verb: 'attention.verb.reply', href: '#/inbox?filter=todo' },
            oldestAt: iso(20),
        }]);
        assert.equal(out.counts.inbox, 4);
    });

    it('carries the threads whose 24 h window has closed, as ids, so Today can Mark them handled (U2, DW-T3)', () => {
        const closed = { count: 2, ids: ['a', 'b'], oldestAt: iso(5000) };
        const out = buildAttention(facts({
            handoff: { count: 3, oldestAt: iso(6000), reasons: [], closed }, waiting: { count: 1, oldestAt: iso(20), closed: { count: 0, ids: [], oldestAt: null } },
        }));
        assert.deepEqual(out.items.find((i) => i.type === 'handoff')!.detail, { closed });
        assert.equal('detail' in out.items.find((i) => i.type === 'thread_waiting')!, false, 'nothing closed, nothing carried');
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
    // The modules read is cached per workspace for 30 s: each test starts from what it arranges, so what a test counts never depends on the one before it.
    invalidateModulesCache();
    (metaHttp as any).get = async (url: string) => { graph.push(`GET ${url}`); throw new Error('the attention summary must not call Meta'); };
    (metaHttp as any).post = async (url: string) => { graph.push(`POST ${url}`); throw new Error('the attention summary must not call Meta'); };
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originalGet;
    (metaHttp as any).post = originalPost;
});

/** Route each statement to the answer for it, by what it reads. Anything not arranged answers no rows. */
function install(answer: Partial<Record<
    'health' | 'worker' | 'threads' | 'posts' | 'failedRows' | 'connections' | 'queue' | 'schema' | 'studioJobs' | 'tiktok' | 'reels' | 'owner' | 'setting', Answer
>>) {
    // The owner is cached for 30 s across tests; each install starts from what it arranges.
    invalidateTenantCache();
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: flat(sql), params });
        const text = flat(sql);
        const kind =
            text === flat(THREADS_ATTENTION_SQL) ? 'threads'
            : text === flat(POSTS_ATTENTION_SQL) ? 'posts'
            : text === flat(FAILED_POSTS_DETAIL_SQL) ? 'failedRows'
            : text === flat(CONNECTIONS_ATTENTION_SQL) ? 'connections'
            : text === flat(STUDIO_JOBS_WAITING_SQL) ? 'studioJobs'
            : text === flat(TIKTOK_DRAFTS_ATTENTION_SQL) ? 'tiktok'
            : text === flat(REEL_REVIEW_ATTENTION_SQL) ? 'reels'
            : /FROM creators ORDER BY created_at/.test(text) ? 'owner'
            : /FROM app_settings WHERE key = \$1/.test(text) ? 'setting'
            : /FROM studio_workers/.test(sql) ? 'worker'
            : /FROM schema_migrations/.test(sql) ? 'schema'
            : /FROM jobs\s*$/.test(sql.trim()) ? 'queue'
            : /FROM creators c\s+LEFT JOIN LATERAL/.test(sql) ? 'health'
            : null;
        assert.ok(kind, `an unexpected statement: ${flat(sql).slice(0, 120)}`);
        // The owner is the tenant under test unless a test says otherwise: the Mac works for it.
        const out = (answer[kind] ?? (kind === 'owner' ? () => [{ id: TENANT }] : undefined))?.(sql, params);
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
            ['post_failed', 1], ['connection_broken', 1], ['handoff', 3], ['post_overdue', 2], ['thread_waiting', 4],
        ]);
        const handoff = out.items.find((i) => i.type === 'handoff')!;
        assert.deepEqual(handoff.sentence.params, { n: 3, reason: 'refund' });
        assert.equal(handoff.oldestAt, iso(500), 'the oldest across both reasons');
    });

    it('scopes every statement to the tenant it was asked about', async () => {
        install({ health: () => [healthRow()] });
        await getAttention(TENANT, { now: NOW });
        assert.equal(sent.length, 12);
        // Every statement but three: who the owner is (no parameters), the Mac's sign-in flag (a platform setting, by its key), and the workspace's modules
        // document (a setting, by a key that ends in the tenant's id).
        const tenantless = (sql: string) => /FROM creators ORDER BY created_at/.test(sql) || /FROM app_settings/.test(sql);
        for (const s of sent.filter((x) => !tenantless(x.sql))) assert.equal(s.params[0], TENANT, s.sql.slice(0, 80));
        assert.equal(sent.filter((x) => tenantless(x.sql)).length, 3);
        assert.deepEqual(sent.filter((x) => /FROM app_settings/.test(x.sql) && String(x.params[0]).endsWith(TENANT)).map((x) => x.params[0]), [`tenant.modules.${TENANT}`], 'only this tenant\'s own row');
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
        assert.equal(sent.length, 12, 'tenant health, worker, threads, posts, the failed rows, connections, the owner, waiting jobs, TikTok drafts, clips to review, the sign-in flag, and the workspace\'s modules document');
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
        for (const broken of ['health', 'worker', 'threads', 'posts', 'failedRows', 'connections'] as const) {
            install({ health: () => [healthRow()], [broken]: () => new Error(`${broken} is down`) });
            await assert.rejects(getAttention(TENANT, { now: NOW }), new RegExp(`${broken} is down`), broken);
        }
    });
});

// ─── The Studio's items (research USE-1, USE-4) ──────────────────────────────────────────────

const studioFacts = (over: Partial<StudioFacts> = {}): StudioFacts => ({
    signedOutAt: null, workerOffline: null, tiktokDrafts: none, reelReview: none, ...over,
});
const studioItems = (over: Partial<StudioFacts>) => buildAttention(facts({ studio: studioFacts(over) }));

describe('buildAttention: the Studio', () => {
    it('says nothing, and counts nothing, when the Studio has nothing for the owner (or the caller sends no Studio facts)', () => {
        assert.deepEqual(studioItems({}), { items: [], counts: { inbox: 0, studio: 0, scheduler: 0 } });
        assert.deepEqual(buildAttention(facts()), { items: [], counts: { inbox: 0, studio: 0, scheduler: 0 } });
    });

    it('Claude signed out on the Mac is a danger with one action, the way to fix it, dated from the first failure', () => {
        const out = studioItems({ signedOutAt: iso(600) });
        assert.deepEqual(out.items, [{
            type: 'mac_signed_out', severity: 'danger', count: 1,
            sentence: { key: 'attention.mac_signed_out', params: {} },
            action: { verb: 'attention.verb.howToFix', href: '#/help/worker#claude-signed-out' },
            oldestAt: iso(600),
        }]);
        assert.equal(out.counts.studio, 1);
    });

    it('the worker being offline is a warning that names how many jobs wait and the window', () => {
        const out = studioItems({ workerOffline: { jobs: 3, oldestAt: iso(120), lastSeenAt: iso(100) } });
        assert.deepEqual(out.items, [{
            type: 'worker_offline', severity: 'warning', count: 1,
            sentence: { key: 'attention.worker_offline', params: { n: 3, minutes: WORKER_OFFLINE_MINUTES } },
            action: { verb: 'attention.verb.howToFix', href: '#/help/worker#worker-offline' },
            oldestAt: iso(120),
        }]);
        assert.equal(out.counts.studio, 1, 'one problem, however many jobs wait');
    });

    it('TikTok drafts and clips to review count one each, and link to where they are handled', () => {
        const out = studioItems({ tiktokDrafts: { count: 4, oldestAt: iso(35 * 1440) }, reelReview: { count: 2, oldestAt: iso(90) } });
        const tiktok = out.items.find((i) => i.type === 'tiktok_draft')!;
        const reels = out.items.find((i) => i.type === 'reel_review')!;
        assert.deepEqual(tiktok.sentence, { key: 'attention.tiktok_draft', params: { n: 4, days: TIKTOK_DRAFT_DAYS } });
        assert.equal(tiktok.severity, 'info');
        assert.deepEqual(reels.sentence, { key: 'attention.reel_review', params: { n: 2 } });
        assert.deepEqual(reels.action, { verb: 'attention.verb.review', href: '#/monteur' });
        assert.equal(out.counts.studio, 6);
    });

    it('puts the sign-in danger first, and counts every Studio thing into counts.studio only', () => {
        const out = buildAttention(facts({
            postsFailed: { count: 1, oldestAt: iso(10) },
            studio: studioFacts({ signedOutAt: iso(5), workerOffline: { jobs: 1, oldestAt: iso(60), lastSeenAt: null }, reelReview: { count: 1, oldestAt: iso(30) } }),
        }));
        assert.equal(out.items[0]!.type, 'post_failed', 'danger, oldest first (a post that failed 10 min ago is older than a sign-in 5 min ago)');
        assert.deepEqual(types(out.items), ['post_failed', 'mac_signed_out', 'worker_offline', 'reel_review']);
        assert.deepEqual(out.counts, { inbox: 0, studio: 3, scheduler: 1 });
    });

    it('a tenant with nothing connected still gets nothing', () => {
        assert.deepEqual(
            buildAttention(facts({ connections: [], studio: studioFacts({ signedOutAt: iso(5), reelReview: { count: 3, oldestAt: iso(5) } }) })),
            { items: [], counts: { inbox: 0, studio: 0, scheduler: 0 } },
        );
    });
});

describe('workerOfflineFact: the 30-minute rule', () => {
    const jobs = (minutesAgo: number, n = 2) => ({ n, oldestAt: iso(minutesAgo) });

    it('is null with no waiting jobs, however long the worker has been silent', () => {
        assert.equal(workerOfflineFact({ n: 0, oldestAt: null }, iso(5000), NOW), null);
    });

    it('is null while the worker called within the window', () => {
        assert.equal(workerOfflineFact(jobs(300), iso(WORKER_OFFLINE_MINUTES - 1), NOW), null);
    });

    it('is null for a job queued moments ago, even for a Mac that has been asleep for hours', () => {
        assert.equal(workerOfflineFact(jobs(2), iso(600), NOW), null);
    });

    it('is raised once the worker AND the oldest job have both been quiet for the window', () => {
        const fact = workerOfflineFact(jobs(WORKER_OFFLINE_MINUTES + 1), iso(WORKER_OFFLINE_MINUTES + 1), NOW);
        assert.deepEqual(fact, { jobs: 2, oldestAt: iso(WORKER_OFFLINE_MINUTES + 1), lastSeenAt: iso(WORKER_OFFLINE_MINUTES + 1) });
    });

    it('a worker that never called is offline too', () => {
        assert.ok(workerOfflineFact(jobs(120), null, NOW));
    });
});

describe('getAttention: the Studio facts', () => {
    it('reads each rule from its own statement, binds the days as a parameter, and calls nobody', async () => {
        install({
            health: () => [healthRow()],
            worker: () => [{ name: 'Mac', last_seen_at: new Date(NOW - 3 * 3600_000) }],
            studioJobs: () => [{ n: 2, oldest_at: new Date(iso(200)) }],
            tiktok: () => [{ n: 4, oldest_at: new Date(iso(35 * 1440)) }],
            reels: () => [{ n: 1, oldest_at: new Date(iso(50)) }],
            setting: () => [{ value: iso(400), is_secret: false }],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
        });
        const out = await getAttention(TENANT, { now: NOW });
        assert.deepEqual(types(out.items).sort(), ['mac_signed_out', 'reel_review', 'tiktok_draft', 'worker_offline']);
        assert.equal(out.counts.studio, 1 + 1 + 4 + 1);
        const tiktok = sent.find((s) => s.sql === flat(TIKTOK_DRAFTS_ATTENTION_SQL))!;
        assert.deepEqual(tiktok.params, [TENANT, TIKTOK_DRAFT_DAYS]);
        assert.deepEqual(graph, []);
    });

    it('does not tell a tenant the Mac does not work for to sign in on it, and does not read the flag for it', async () => {
        const OTHER = '22222222-2222-4222-8222-222222222222';
        install({
            health: () => [healthRow()],
            owner: () => [{ id: TENANT }],
            setting: () => [{ value: iso(400), is_secret: false }],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
        });
        const out = await getAttention(OTHER, { now: NOW });
        assert.deepEqual(out.items, []);
        assert.equal(sent.some((s) => s.sql === flat('SELECT value, is_secret FROM app_settings WHERE key = $1') && s.params[0] === 'mac.claude_signed_out_at'), false);
    });

    it('the statements exclude what is not the owner’s to do: archived TikTok rows, jobs not due yet, other states', () => {
        assert.match(flat(TIKTOK_DRAFTS_ATTENTION_SQL), /s\.creator_id = \$1/);
        assert.match(flat(TIKTOK_DRAFTS_ATTENTION_SQL), /s\.status = 'IN_INBOX'/);
        assert.match(flat(TIKTOK_DRAFTS_ATTENTION_SQL), /s\.archived_at IS NULL/);
        assert.match(flat(STUDIO_JOBS_WAITING_SQL), /not_before <= NOW\(\)/);
        assert.match(flat(STUDIO_JOBS_WAITING_SQL), /creator_id = \$1/);
        assert.match(flat(REEL_REVIEW_ATTENTION_SQL), /creator_id = \$1 AND status = 'review'/);
    });

    it('fails whole when a Studio read fails', async () => {
        for (const broken of ['studioJobs', 'tiktok', 'reels'] as const) {
            install({ health: () => [healthRow()], [broken]: () => new Error(`${broken} is down`) });
            await assert.rejects(getAttention(TENANT, { now: NOW }), new RegExp(`${broken} is down`), broken);
        }
    });
});

// ─── U2: why a post failed, old versus recent, and what the closed threads are ───────────────

describe('failureReason: what the owner can do about a failed post', () => {
    it('reads the pipeline’s own words, and the first match wins', () => {
        assert.equal(failureReason('Replaced: the reel is being remade with Claude.'), 'replaced');
        assert.equal(failureReason('TikTok post init: Until TikTok approves this app, direct posts only work when your TikTok account is set to private. Switch it.'), 'tiktok_private');
        assert.equal(failureReason('(#190) Invalid OAuth access token (Code: 190)'), 'token');
        assert.equal(failureReason('Media upload failed: the video could not be processed'), 'media');
        assert.equal(failureReason('Something nobody wrote a rule for'), 'other');
        assert.equal(failureReason(null), 'other');
        assert.equal(failureReason(''), 'other');
    });
});

describe('bucketFailed: recent against older than 14 days, one post per group', () => {
    const day = 86_400_000;
    const row = (id: string, group: string | null, daysAgo: number, error: string) =>
        ({ id, group_id: group, scheduled_time: new Date(NOW - daysAgo * day), error_log: error });
    const TT = 'TikTok post init: Until TikTok approves this app, direct posts only work when your TikTok account is set to private.';
    const rows = [
        row('t1', 'g1', 35, TT), row('t2', 'g2', 33, TT),
        row('p1', 'g3', -70, 'Replaced: the reel is being remade with Claude.'), row('p2', 'g3', -70, 'Replaced: the reel is being remade with Claude.'),
        row('m1', null, 2, 'Media upload failed'),
    ];

    it('splits at the cut by scheduled time: a post dated in the future is recent, never old', () => {
        const { recent, old } = bucketFailed(rows, NOW);
        assert.equal(POST_FAILED_OLD_DAYS, 14);
        assert.equal(old.count, 2);
        assert.equal(recent.count, 2);
        assert.deepEqual(old.reasons.map((r) => [r.reason, r.count]), [['tiktok_private', 2]]);
        assert.deepEqual(recent.reasons.map((r) => [r.reason, r.count]).sort(), [['media', 1], ['replaced', 1]]);
    });

    it('counts a post that went to several platforms once, and keeps every row of it for Archive', () => {
        const { recent } = bucketFailed(rows, NOW);
        assert.equal(recent.reasons.find((r) => r.reason === 'replaced')!.count, 1, 'two rows, one post');
        assert.deepEqual([...recent.ids].sort(), ['m1', 'p1', 'p2']);
    });

    it('dates each bucket and each reason by its earliest post', () => {
        const { old } = bucketFailed(rows, NOW);
        assert.equal(old.oldestAt, new Date(NOW - 35 * day).toISOString());
        assert.equal(old.reasons[0]!.oldestAt, new Date(NOW - 35 * day).toISOString());
    });

    it('is empty for no rows', () => {
        const { recent, old } = bucketFailed([], NOW);
        assert.deepEqual([recent.count, old.count, recent.ids, old.reasons], [0, 0, [], []]);
    });
});

describe('buildAttention: failed posts split (U2, DW-T2)', () => {
    const day = 86_400_000;
    const split = bucketFailed([
        { id: 'o1', group_id: null, scheduled_time: new Date(NOW - 40 * day), error_log: 'TikTok approves this app, set to private' },
        { id: 'r1', group_id: null, scheduled_time: new Date(NOW - 3 * day), error_log: 'Media upload failed' },
    ], NOW);

    it('a recent failure is the red card; older ones are one quiet info line with their count, and each carries why and which rows', () => {
        const out = buildAttention(facts({ postsFailed: { count: 2, oldestAt: iso(1) }, failedPosts: split }));
        const recent = out.items.find((i) => i.type === 'post_failed')!;
        const old = out.items.find((i) => i.type === 'post_failed_old')!;
        assert.equal(recent.severity, 'danger');
        assert.equal(old.severity, 'info');
        assert.deepEqual(old.sentence, { key: 'attention.post_failed_old', params: { n: 1, days: 14 } });
        assert.deepEqual(recent.detail, { reasons: [{ reason: 'media', count: 1, oldestAt: new Date(NOW - 3 * day).toISOString() }], ids: ['r1'] });
        assert.deepEqual(old.detail!.ids, ['o1']);
        assert.equal(old.action.href, '#/posts?filter=needs-you');
    });

    it('both stay in the Scheduler badge: the count is the same truth as before the split', () => {
        const out = buildAttention(facts({ postsFailed: { count: 2, oldestAt: iso(1) }, failedPosts: split }));
        assert.equal(out.counts.scheduler, 2);
    });

    it('only old failures: no red card at all', () => {
        const onlyOld = bucketFailed([{ id: 'o1', group_id: null, scheduled_time: new Date(NOW - 40 * day), error_log: null }], NOW);
        const out = buildAttention(facts({ postsFailed: { count: 1, oldestAt: iso(1) }, failedPosts: onlyOld }));
        assert.deepEqual(types(out.items), ['post_failed_old']);
    });

    it('a count with no rows behind it is still said, as the one item it always was', () => {
        const out = buildAttention(facts({ postsFailed: { count: 3, oldestAt: iso(1) }, failedPosts: bucketFailed([], NOW) }));
        assert.deepEqual(out.items.map((i) => [i.type, i.count]), [['post_failed', 3]]);
        assert.equal('detail' in out.items[0]!, false);
    });
});

describe('getAttention: U2 statements and facts', () => {
    it('reads the failed rows, groups them into the two items, and carries the closed threads', async () => {
        const day = 86_400_000;
        install({
            health: () => [healthRow()],
            threads: () => [{ kind: 'handoff', reason: 'refund', n: 2, oldest_at: new Date(iso(9000)), closed_n: 1, closed_oldest_at: new Date(iso(9000)), closed_ids: ['c1'] }],
            posts: () => [{ failed: 2, failed_oldest_at: new Date(NOW - 40 * day), overdue: 0, overdue_oldest_at: null }],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
            failedRows: () => [
                { id: 'o1', group_id: null, scheduled_time: new Date(NOW - 40 * day), error_log: 'Replaced: remade' },
                { id: 'r1', group_id: null, scheduled_time: new Date(NOW - 1 * day), error_log: 'Media upload failed' },
            ],
        });
        const out = await getAttention(TENANT, { now: NOW });
        assert.deepEqual(out.items.map((i) => i.type).sort(), ['handoff', 'post_failed', 'post_failed_old']);
        assert.deepEqual(out.items.find((i) => i.type === 'handoff')!.detail, { closed: { count: 1, ids: ['c1'], oldestAt: iso(9000) } });
        assert.equal(out.counts.scheduler, 2);
        assert.equal(sent.some((s) => s.sql === flat(FAILED_POSTS_DETAIL_SQL) && s.params[0] === TENANT), true);
    });

    it('QA-02: a thread handed over 16 days ago whose customer wrote yesterday carries the reply window from that message, not the handoff', async () => {
        const day = 86_400_000;
        const lastMessage = new Date(NOW - 22 * 3_600_000);
        install({
            health: () => [healthRow()],
            threads: () => [{
                kind: 'handoff', reason: 'refund', n: 1, oldest_at: new Date(NOW - 16 * day),
                last_inbound_at: lastMessage, open_n: 1, open_oldest_inbound_at: lastMessage, closed_n: 0,
            }],
            posts: () => [{ failed: 0, failed_oldest_at: null, overdue: 0, overdue_oldest_at: null }],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
            failedRows: () => [],
        });
        const out = await getAttention(TENANT, { now: NOW });
        const item = out.items.find((i) => i.type === 'handoff')!;
        assert.equal(item.oldestAt, new Date(NOW - 16 * day).toISOString(), 'the handoff stays what sorts the item');
        assert.deepEqual(item.detail, { window: { lastInboundAt: lastMessage.toISOString(), open: 1, closesAt: new Date(NOW + 2 * 3_600_000).toISOString() } });
    });

    it('QA-02: a window already closed says so (open 0, no closing time), and a thread with no customer message says nothing', () => {
        const closedAt = new Date(NOW - 5 * 86_400_000);
        const closed = threadFacts([{ kind: 'waiting', reason: null, n: 1, oldest_at: closedAt, last_inbound_at: closedAt, open_n: 0, closed_n: 1, closed_oldest_at: closedAt, closed_ids: ['c1'] }]);
        const out = buildAttention(facts({ ...closed }));
        assert.deepEqual(out.items.find((i) => i.type === 'thread_waiting')!.detail!.window, { lastInboundAt: closedAt.toISOString(), open: 0, closesAt: null });
        const none = buildAttention(facts({ ...threadFacts([{ kind: 'waiting', reason: null, n: 1, oldest_at: closedAt }]) }));
        assert.equal('detail' in none.items.find((i) => i.type === 'thread_waiting')!, false);
    });

    it('QA-02: across several threads the newest message and the soonest-closing open window win', () => {
        const a = new Date(NOW - 3_600_000); const b = new Date(NOW - 20 * 3_600_000); const c = new Date(NOW - 30 * 3_600_000);
        const merged = threadFacts([
            { kind: 'waiting', reason: null, n: 2, oldest_at: c, last_inbound_at: a, open_n: 2, open_oldest_inbound_at: b, closed_n: 0 },
            { kind: 'waiting', reason: null, n: 1, oldest_at: c, last_inbound_at: c, open_n: 0, closed_n: 1, closed_ids: ['x'], closed_oldest_at: c },
        ]).waiting;
        assert.equal(merged.lastInboundAt, a.toISOString());
        assert.deepEqual(merged.open, { count: 2, oldestInboundAt: b.toISOString() });
    });

    it('QA-02: the threads statement asks for the newest customer message and the open windows with the same 24 h rule as the closed ones', () => {
        const sql = flat(THREADS_ATTENTION_SQL);
        assert.match(sql, /MAX\(t\.last_inbound_at\) AS last_inbound_at/);
        assert.match(sql, /COUNT\(\*\) FILTER \(WHERE t\.last_inbound_at >= NOW\(\) - make_interval\(hours => 24\)\)::int AS open_n/);
        assert.match(sql, /MIN\(t\.last_inbound_at\) FILTER \(WHERE t\.last_inbound_at >= NOW\(\) - make_interval\(hours => 24\)\) AS open_oldest_inbound_at/);
    });

    it('the failed-rows statement follows the count’s rule: this tenant, FAILED, not archived', () => {
        const sql = flat(FAILED_POSTS_DETAIL_SQL);
        assert.match(sql, /s\.creator_id = \$1/);
        assert.match(sql, /s\.status = 'FAILED'/);
        assert.match(sql, /s\.archived_at IS NULL/);
        assert.match(sql, /LIMIT 400$/);
    });

    it('the threads statement counts a closed window from the customer’s LAST inbound message, 24 h back, and shares its inner select with the sweep', () => {
        const sql = flat(THREADS_ATTENTION_SQL);
        assert.match(sql, /closed_n/);
        assert.match(sql, /m4\.direction = 'inbound'/);
        assert.match(sql, /make_interval\(hours => 24\)/);
        assert.ok(sql.includes(flat(THREADS_NEEDING_PERSON_SQL)), 'one rule, written once');
    });
});

describe('the tenant health count of failed posts is the attention count (U2: Today said 4, the tenant page said 2)', () => {
    it('the health statement counts FAILED, not archived, a post on several platforms once: the words of POSTS_ATTENTION_SQL', () => {
        const health = flat(TENANT_HEALTH_SQL);
        assert.match(health, /COUNT\(DISTINCT COALESCE\(s\.group_id, s\.id\)\) FILTER \(WHERE s\.status = 'FAILED' AND s\.archived_at IS NULL\)::int AS posts_failed_open/);
        const attention = flat(POSTS_ATTENTION_SQL);
        assert.match(attention, /FILTER \(WHERE s\.status = 'FAILED'\)/);
        assert.match(attention, /s\.archived_at IS NULL/);
    });
});

// ─── Modules (U3, contract §1.3, §12.1 and §12.2) ─────────────────────────────────────────────────────

describe('buildAttention with the workspace\'s modules', () => {
    const EVERY = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results', 'growth', 'studio', 'explainers', 'ads', 'tiktok', 'youtube', 'whatsapp', 'muse'];
    const COMPANY = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'];
    const day = 86_400_000;
    const failed = bucketFailed([
        { id: 'o1', group_id: null, scheduled_time: new Date(NOW - 40 * day), error_log: 'Media upload failed' },
        { id: 'r1', group_id: null, scheduled_time: new Date(NOW - 3 * day), error_log: 'Media upload failed' },
    ], NOW);

    /** Every kind of item at once, so a module that leaks shows. */
    const LOUD = (): AttentionFacts => facts({
        handoff: { count: 2, oldestAt: iso(300), reasons: [{ reason: 'refund', count: 2 }], closed: { count: 1, ids: ['c1'], oldestAt: iso(3000) } },
        waiting: { count: 3, oldestAt: iso(20) },
        postsFailed: { count: 2, oldestAt: iso(1) },
        failedPosts: failed,
        postsOverdue: { count: 1, oldestAt: iso(40) },
        connections: [
            { integration: 'meta', broken: true, at: iso(10) }, { integration: 'tiktok', broken: true, at: iso(20) }, { integration: 'youtube', broken: true, at: iso(30) },
        ],
        studio: studioFacts({
            signedOutAt: iso(600), workerOffline: { jobs: 2, oldestAt: iso(120), lastSeenAt: iso(100) },
            tiktokDrafts: { count: 4, oldestAt: iso(40 * 1440) }, reelReview: { count: 2, oldestAt: iso(90) },
        }),
    });

    it('with every module on (as a list, a set, or null), is exactly what it was with no modules at all, on every shape of facts', () => {
        const fixtures: AttentionFacts[] = [
            facts(), LOUD(), facts({ postsFailed: { count: 2, oldestAt: iso(2880) } }), facts({ failedPosts: failed, postsFailed: { count: 2, oldestAt: iso(1) } }),
            facts({ connections: [] }), facts({ studio: studioFacts({ signedOutAt: iso(5) }) }),
            facts({ handoff: { count: 1, oldestAt: iso(5), reasons: [] }, connections: [{ integration: 'tiktok', broken: true, at: null }] }),
        ];
        for (const f of fixtures) {
            const plain = buildAttention(f);
            assert.deepEqual(buildAttention(f, EVERY), plain);
            assert.deepEqual(buildAttention(f, new Set(EVERY)), plain);
            assert.deepEqual(buildAttention(f, null), plain);
            assert.deepEqual(buildAttention(f, undefined), plain);
        }
    });

    it('a company workspace has no TikTok draft, no reel to review, no Mac item, and `counts.studio` is 0', () => {
        const out = buildAttention(LOUD(), COMPANY);
        const found = types(out.items);
        for (const gone of ['tiktok_draft', 'reel_review', 'mac_signed_out', 'worker_offline']) assert.equal(found.includes(gone as never), false, gone);
        assert.equal(out.counts.studio, 0);
        // And what a company does have is still there.
        for (const kept of ['handoff', 'thread_waiting', 'post_failed', 'post_failed_old', 'post_overdue', 'connection_broken']) assert.equal(found.includes(kept as never), true, kept);
        assert.equal(out.counts.inbox, 5);
        assert.equal(out.counts.scheduler, 3);
    });

    it('a broken Meta connection is every workspace\'s, but TikTok\'s and YouTube\'s only when it has them', () => {
        const brokenOf = (modules: string[]) => buildAttention(LOUD(), modules).items.filter((i) => i.type === 'connection_broken').map((i) => i.sentence.params['platform']).sort();
        assert.deepEqual(brokenOf(COMPANY), ['meta']);
        assert.deepEqual(brokenOf([...COMPANY, 'tiktok']), ['meta', 'tiktok']);
        assert.deepEqual(brokenOf([...COMPANY, 'youtube']), ['meta', 'youtube']);
        assert.deepEqual(brokenOf([]), ['meta'], 'no module at all still tells you your Meta connection is broken');
    });

    it('with the scheduler off there are no post_* items and `counts.scheduler` is 0', () => {
        const out = buildAttention(LOUD(), EVERY.filter((m) => m !== 'scheduler'));
        assert.equal(types(out.items).some((t) => t.startsWith('post_')), false);
        assert.equal(out.counts.scheduler, 0);
        assert.notEqual(out.counts.inbox, 0, 'the other counts stay');
    });

    it('with the inbox off there are no handoff or waiting items and `counts.inbox` is 0', () => {
        const out = buildAttention(LOUD(), EVERY.filter((m) => m !== 'inbox'));
        assert.equal(types(out.items).some((t) => t === 'handoff' || t === 'thread_waiting'), false);
        assert.equal(out.counts.inbox, 0);
    });

    it('with the Studio off its Mac and reel items go, and with TikTok off alone its draft goes while the Studio\'s stay', () => {
        const noStudio = buildAttention(LOUD(), EVERY.filter((m) => m !== 'studio'));
        assert.equal(types(noStudio.items).some((t) => t === 'reel_review' || t === 'mac_signed_out' || t === 'worker_offline'), false);
        assert.equal(types(noStudio.items).includes('tiktok_draft'), true, 'TikTok is its own module');
        assert.equal(noStudio.counts.studio, 0);
        const noTikTok = buildAttention(LOUD(), EVERY.filter((m) => m !== 'tiktok'));
        assert.equal(types(noTikTok.items).includes('tiktok_draft'), false);
        assert.equal(noTikTok.counts.studio, 4, 'the sign-in, the worker and the two clips: the draft is not counted where it is not shown');
    });

    it('a workspace with nothing connected still gets nothing, whatever it has', () => {
        assert.deepEqual(buildAttention(facts({ connections: [], handoff: { count: 2, oldestAt: iso(1), reasons: [] } }), COMPANY), { items: [], counts: { inbox: 0, studio: 0, scheduler: 0 } });
    });
});

describe('failureReason reuses the failure translator\'s names (UI.failure)', () => {
    it('reads the texts production holds for a post the way the dashboard names them', () => {
        assert.equal(failureReason('Held: waiting for TikTok to approve the app (2026-11-12).'), 'tiktok_private');
        assert.equal(failureReason('Private Reply Failed: Error validating access token: Session has expired on Monday, 18-May-26 04:00:00 PDT. (Code: 190)'), 'token');
        assert.equal(failureReason('Error validating access token: The user has not authorized application 847772258381375.'), 'token');
        assert.equal(failureReason('storage answered HTTP 400 to the upload: {"statusCode":"413","error":"Payload too large"}'), 'media');
        assert.equal(failureReason('Replaced: the reel is being remade with Claude.'), 'replaced');
        assert.equal(failureCode('Held: waiting for TikTok to approve the app'), 'TIKTOK_HELD_APPROVAL');
        assert.equal(failureCode('TikTok post init: Until TikTok approves this app, direct posts only work when your TikTok account is set to private.'), 'TIKTOK_PRIVATE_ONLY');
        assert.equal(failureCode('something nobody wrote a rule for'), null);
        assert.equal(failureCode(null), null);
    });

    it('keeps every answer the mapping gave before (a held TikTok post is a rule, not a fault, like the private-account one)', () => {
        assert.equal(failureReason('(#190) Invalid OAuth access token (Code: 190)'), 'token');
        assert.equal(failureReason('Media upload failed: the video could not be processed'), 'media');
        assert.equal(failureReason('Abandoned after 5 publish attempts — each claim went stale without completing. Check the access token and the media URL.'), 'token');
    });
});

describe('a failure is dated (so Today can say when it failed)', () => {
    const row = (id: string, failedAt: Date | null) => ({ id, group_id: null, scheduled_time: new Date(NOW - 3 * 86_400_000), error_log: 'Media upload failed', failed_at: failedAt });

    it('carries the latest attempt of each reason as `failedAt`, only when a row said when', () => {
        const { recent } = bucketFailed([row('a', new Date(NOW - 5 * 3_600_000)), row('b', new Date(NOW - 2 * 3_600_000)), row('c', null)], NOW);
        assert.deepEqual(recent.reasons, [{ reason: 'media', count: 3, oldestAt: new Date(NOW - 3 * 86_400_000).toISOString(), failedAt: new Date(NOW - 2 * 3_600_000).toISOString() }]);
    });

    it('leaves the shape as it always was for a row without a date', () => {
        const { recent } = bucketFailed([row('a', null)], NOW);
        assert.equal('failedAt' in recent.reasons[0]!, false);
    });

    it('selects `claimed_at` (the last attempt) as `failed_at`: `scheduled_posts` has no `updated_at`', () => {
        assert.match(FAILED_POSTS_DETAIL_SQL, /s\.claimed_at AS failed_at/);
        assert.doesNotMatch(FAILED_POSTS_DETAIL_SQL, /updated_at/);
    });
});

describe('getAttention for a company workspace reads its modules document and builds nothing of the Studio', () => {
    it('asks for the document once, and drops the Studio\'s items', async () => {
        const doc = JSON.stringify({ v: 1, on: ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'], preset: 'company', metaConnect: 'self' });
        install({
            health: () => [healthRow()],
            worker: () => [],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
            studioJobs: () => [{ n: 3, oldest_at: new Date(NOW - 3 * 3_600_000) }],
            tiktok: () => [{ n: 2, oldest_at: new Date(NOW - 40 * 86_400_000) }],
            reels: () => [{ n: 2, oldest_at: new Date(NOW - 3_600_000) }],
            // Somebody else is the platform owner: the owner's workspace is never narrowed, whatever its document says.
            owner: () => [{ id: '99999999-9999-4999-8999-999999999999' }],
            setting: (_sql, params) => (params[0] === `tenant.modules.${TENANT}` ? [{ value: doc, is_secret: false }] : []),
        });
        const out = await getAttention(TENANT, { now: NOW });
        assert.deepEqual(types(out.items), []);
        assert.equal(out.counts.studio, 0);
        assert.equal(sent.filter((s) => /FROM app_settings/.test(s.sql) && s.params[0] === `tenant.modules.${TENANT}`).length, 1);
    });

    it('is unchanged for a workspace with no document: the same Studio things are said', async () => {
        install({
            health: () => [healthRow()],
            worker: () => [],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
            tiktok: () => [{ n: 2, oldest_at: new Date(NOW - 40 * 86_400_000) }],
            reels: () => [{ n: 2, oldest_at: new Date(NOW - 3_600_000) }],
        });
        const out = await getAttention(TENANT, { now: NOW });
        assert.deepEqual(types(out.items).sort(), ['reel_review', 'tiktok_draft']);
        assert.equal(out.counts.studio, 4);
    });
});

describe('the platform owner\'s attention is unchanged by a document', () => {
    it('says the Studio\'s things for the owner even if a document written by hand leaves the Studio out', async () => {
        const doc = JSON.stringify({ v: 1, on: ['inbox'], preset: 'custom', metaConnect: 'self' });
        install({
            health: () => [healthRow()],
            worker: () => [],
            connections: () => [{ integration: 'meta', broken: false, at: null }],
            reels: () => [{ n: 2, oldest_at: new Date(NOW - 3_600_000) }],
            setting: (_sql, params) => (params[0] === `tenant.modules.${TENANT}` ? [{ value: doc, is_secret: false }] : []),
        });
        const out = await getAttention(TENANT, { now: NOW });
        assert.deepEqual(types(out.items), ['reel_review']);
        assert.equal(out.counts.studio, 2);
    });
});
