/**
 * `syncInsights` end to end against a stubbed pool, a stubbed `metaHttp` and a stubbed
 * `debug_token`. Nothing reaches Meta or a database: the Graph stub throws on any path it was
 * not arranged for, because `.env` holds live credentials.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import type { GrowthSyncState } from '../../db/rows.js';
import { setLogSink } from '../../utils/log.js';
import { metaHttp } from '../http.js';
import { API_VERSION, GRAPH_BASE } from '../instagram.js';
import { GrowthError } from './common.js';
import { GraphSession, usagePercent } from './graph.js';
import { FB_VIDEO_POST_METRICS, IG_FEED_METRICS, IG_REELS_METRICS } from './mapping.js';
import { runSync, syncAllTenants, syncInsights, type SyncDeps } from './sync.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-25T12:00:00Z');
const ALL_SCOPES = ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement', 'read_insights'];

// ─── Stubs ───────────────────────────────────────────────────────────────────────────────

let statements: { sql: string; params: any[] }[] = [];
let previousState: GrowthSyncState | null = null;
let creator: Record<string, unknown> | null = null;
let claimRow: Record<string, unknown> | null = { last_sync_at: NOW };
let failTenantRead = false;
const original = { query: pool.query, connect: pool.connect, get: metaHttp.get, post: metaHttp.post };

function respond(sql: string, params: any[]): { rows: any[]; rowCount?: number } {
    if (/FROM creators WHERE id/.test(sql)) {
        if (failTenantRead) throw new Error('connection reset');
        return { rows: creator ? [{ ...creator }] : [] };
    }
    if (/SELECT id FROM creators WHERE is_active/.test(sql)) return { rows: [{ id: TENANT }, { id: 'tenant-2' }] };
    if (/SELECT last_sync FROM growth_settings/.test(sql)) return { rows: previousState ? [{ last_sync: previousState }] : [] };
    if (/INSERT INTO growth_settings \(creator_id, last_sync_at\)/.test(sql)) return { rows: claimRow ? [claimRow] : [] };
    if (/SELECT CEIL/.test(sql)) return { rows: [{ wait: 420 }] };
    if (/FROM scheduled_posts/.test(sql)) return { rows: [{ id: 'sched-1', published_post_id: 'FB:555 | IG:1790' }] };
    if (/SELECT to_char\(max\(day\)/.test(sql)) return { rows: [{ day: null }] };
    if (/INSERT INTO post_insights|INSERT INTO account_insights_daily/.test(sql)) {
        return { rows: [], rowCount: JSON.parse(params[2]).length };
    }
    return { rows: [], rowCount: 0 };
}

let gets: string[] = [];
let batches: string[][] = [];
let answer: (relativeUrl: string) => { code: number; body: unknown } = () => ({ code: 500, body: {} });

const metric = (name: string, value: unknown) => ({ name, values: [{ value }] });
const ok = (data: unknown[]) => ({ code: 200, body: { data } });
const refused = (code: number, message = 'refused') => ({ code: 400, body: { error: { code, message } } });

/** The Graph as it answers for a 36-follower account with one reel, one image and one Facebook video. */
function defaultAnswer(url: string): { code: number; body: unknown } {
    if (url.startsWith('1790/insights')) return ok([metric('views', 130), metric('reach', 110), metric('ig_reels_avg_watch_time', 3200)]);
    if (url.startsWith('1791/insights')) return ok([metric('views', 14), metric('reach', 6), metric('saved', 1)]);
    if (url.startsWith('100_1/insights')) return ok([metric('post_media_view', 800), metric('post_reactions_by_type_total', { like: 3, love: 1 })]);
    if (url.includes('breakdown=follow_type')) {
        return ok([{ name: url.includes('metric=views') ? 'views' : 'reach', total_value: { breakdowns: [{ results: [
            { dimension_values: ['FOLLOWER'], value: 1 }, { dimension_values: ['NON_FOLLOWER'], value: 60 },
        ] }] } }]);
    }
    if (url.includes('breakdown=media_product_type')) {
        return ok([{ name: 'reach', total_value: { breakdowns: [{ results: [{ dimension_values: ['REEL'], value: 61 }] }] } }]);
    }
    if (url.startsWith('ig-1/insights')) return ok([{ name: 'reach', total_value: { value: 61 } }, { name: 'views', total_value: { value: 79 } }]);
    if (url.startsWith('page-1/insights')) {
        return ok([{ name: 'page_follows', values: [{ value: 118, end_time: '2026-09-25T07:00:00+0000' }] }]);
    }
    return { code: 404, body: { error: { code: 803, message: `no answer arranged for ${url}` } } };
}

function graphGet(url: string): { data: unknown } {
    const path = url.replace(`${GRAPH_BASE}/`, '');
    gets.push(path);
    if (path === 'ig-1') return { data: { followers_count: 36, username: 'elamir', media_count: 46 } };
    if (path === 'ig-1/media') {
        return {
            data: {
                data: [
                    { id: '1790', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-09-20T18:00:00+0000', like_count: 3, comments_count: 0, caption: 'reel' },
                    { id: '1791', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', timestamp: '2026-09-19T18:00:00+0000', like_count: 2, comments_count: 1 },
                ],
                paging: { cursors: { after: 'x' } },
            },
        };
    }
    if (path === 'page-1') return { data: { followers_count: 118 } };
    if (path === 'page-1/posts') {
        return { data: { data: [{ id: '100_1', created_time: '2026-09-21T10:00:00+0000', attachments: { data: [{ media_type: 'video', target: { id: '555' } }] } }] } };
    }
    throw Object.assign(new Error(`no GET arranged for ${path}`), { response: { status: 400, data: { error: { code: 100, message: 'unarranged' } } } });
}

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    previousState = null;
    creator = { id: TENANT, instagram_page_id: 'ig-1', facebook_page_id: 'page-1', page_access_token: 'tok' };
    claimRow = { last_sync_at: NOW };
    failTenantRead = false;
    gets = [];
    batches = [];
    answer = defaultAnswer;
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const r = respond(flat, params);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as any).query = run;
    (pool as any).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).get = async (url: string) => graphGet(url);
    (metaHttp as any).post = async (url: string, form: URLSearchParams) => {
        assert.equal(url, `${GRAPH_BASE}/`, 'only batches are POSTed');
        const items = JSON.parse(form.get('batch')!) as { method: string; relative_url: string }[];
        assert.ok(items.length <= 50, 'Meta takes at most 50 per batch');
        batches.push(items.map((i) => i.relative_url));
        return { data: items.map((i) => { const a = answer(i.relative_url); return { code: a.code, body: JSON.stringify(a.body) }; }), headers: {} };
    };
});

afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
    (metaHttp as any).get = original.get;
    (metaHttp as any).post = original.post;
});

const deps = (scopes: string[] | Error, isValid = true): Partial<SyncDeps> => ({
    now: () => NOW,
    inspect: async () => {
        if (scopes instanceof Error) throw scopes;
        return { isValid, scopes, error: isValid ? null : 'Meta reports the token as not valid: expired' };
    },
});
const upserted = (table: 'post_insights' | 'account_insights_daily', platform: string) => {
    const s = statements.find((x) => x.sql.startsWith(`INSERT INTO ${table}`) && x.params[1] === platform);
    return s ? (JSON.parse(s.params[2]) as any[]) : [];
};
const savedState = (): GrowthSyncState => JSON.parse(statements.find((s) => /INSERT INTO growth_settings \(creator_id, last_sync\)/.test(s.sql))!.params[1]);
const allBatchUrls = () => batches.flat();

// ─── Permission states ───────────────────────────────────────────────────────────────────

describe('syncInsights — permission states', () => {
    it('without the insights scopes: syncs posts with their public counts, asks for no insights, names both scopes', async () => {
        const state = await syncInsights(TENANT, deps(['instagram_basic', 'pages_read_engagement']));

        assert.equal(batches.length, 0, 'no insights request is made for a scope the token lacks');
        assert.equal(state.instagram.status, 'missing_permission');
        assert.equal(state.facebook.status, 'missing_permission');
        assert.deepEqual(state.missing, ['instagram_manage_insights', 'read_insights']);
        const posts = upserted('post_insights', 'instagram');
        assert.deepEqual(posts.map((p) => [p.media_id, p.metrics]), [['1790', { likes: 3, comments: 0 }], ['1791', { likes: 2, comments: 1 }]]);
        assert.deepEqual(upserted('account_insights_daily', 'instagram'), [{ day: '2026-09-25', metrics: { followers: 36 } }]);
        assert.deepEqual(upserted('account_insights_daily', 'facebook'), [{ day: '2026-09-25', metrics: { followers: 118 } }]);
        assert.deepEqual(savedState().missing, state.missing, 'the state the status endpoint reads is saved');
    });

    it('an invalid token: both not_connected with the reason, and no Meta call', async () => {
        const state = await syncInsights(TENANT, deps([], false));
        assert.equal(gets.length + batches.length, 0);
        assert.equal(state.instagram.status, 'not_connected');
        assert.match(String(state.instagram.error), /not valid/);
        assert.deepEqual(state.missing, []);
    });

    it('when debug_token can’t be asked, Meta’s own #10 refusals mark the permission missing', async () => {
        answer = (url) => (url.includes('/insights') ? refused(10, '(#10) Application does not have permission for this action') : defaultAnswer(url));
        const state = await syncInsights(TENANT, deps(new Error('timeout')));
        assert.equal(state.scopes, null);
        assert.equal(state.instagram.status, 'missing_permission');
        assert.ok(state.missing.includes('instagram_manage_insights'));
        assert.equal(state.instagram.with_insights, 0);
    });
});

// ─── With the scopes ─────────────────────────────────────────────────────────────────────

describe('syncInsights — with instagram_manage_insights and read_insights', () => {
    it('asks each post for its family’s verified metric set, batched', async () => {
        await syncInsights(TENANT, deps(ALL_SCOPES));
        const urls = allBatchUrls();
        assert.ok(urls.includes(`1790/insights?metric=${IG_REELS_METRICS.join(',')}`));
        assert.ok(urls.includes(`1791/insights?metric=${IG_FEED_METRICS.join(',')}`));
        assert.ok(urls.includes(`100_1/insights?metric=${FB_VIDEO_POST_METRICS.join(',')}`), 'a Facebook video gets the video metrics');
        assert.ok(!urls.some((u) => u.includes('follows_and_unfollows') || u.includes('follower_count')), 'not asked under 100 followers');
    });

    it('maps the insights over the public counts and links each post to the row that published it', async () => {
        const state = await syncInsights(TENANT, deps(ALL_SCOPES));
        const [reel, album] = upserted('post_insights', 'instagram');
        assert.deepEqual(reel.metrics, { likes: 3, comments: 0, views: 130, reach: 110, avg_watch_time_ms: 3200 });
        assert.equal(reel.scheduled_post_id, 'sched-1', 'IG:1790 in published_post_id');
        assert.equal(album.scheduled_post_id, null);
        const [fb] = upserted('post_insights', 'facebook');
        assert.deepEqual(fb.metrics, { views: 800, likes: 4 });
        assert.equal(fb.scheduled_post_id, 'sched-1', 'FB:555 is the video id the /videos publish returned');
        assert.equal(state.instagram.with_insights, 2);
        assert.equal(state.instagram.status, 'ok');
    });

    it('stores 28 account days with the follower / non-follower and surface splits, and Facebook’s running follower total', async () => {
        await syncInsights(TENANT, deps(ALL_SCOPES));
        const days = upserted('account_insights_daily', 'instagram');
        assert.equal(days.length, 29, '28 insight days and today’s follower count');
        const yesterday = days.find((d) => d.day === '2026-09-24')!;
        assert.deepEqual(yesterday.metrics, {
            reach: 61, views: 79, reach_followers: 1, reach_non_followers: 60, views_followers: 1, views_non_followers: 60,
            reach_by_surface: { REEL: 61 },
        });
        const fbDays = upserted('account_insights_daily', 'facebook');
        assert.deepEqual(fbDays.find((d) => d.day === '2026-09-24')!.metrics, { followers: 118 });
    });
});

// ─── A refused metric name ───────────────────────────────────────────────────────────────

describe('syncInsights — (#100) on one metric name', () => {
    const RETIRED = 'ig_reels_video_view_total_time';

    beforeEach(() => {
        answer = (url) => {
            const [path, query = ''] = url.split('?');
            const names = /metric=([^&]*)/.exec(query)?.[1]?.split(',') ?? [];
            if (path === '1790/insights' && names.includes(RETIRED)) return refused(100, 'The value must be a valid insights metric');
            if (path === '1790/insights' && names.length === 1) return ok([metric(names[0]!, 7)]);
            return defaultAnswer(url);
        };
    });

    it('probes the post one metric at a time, asks again with what answered, and remembers the refused name', async () => {
        const state = await syncInsights(TENANT, deps(ALL_SCOPES));
        const urls = allBatchUrls();
        assert.ok(urls.includes(`1790/insights?metric=${RETIRED}`), 'the probe asks for each name alone');
        const working = IG_REELS_METRICS.filter((m) => m !== RETIRED).join(',');
        assert.ok(urls.includes(`1790/insights?metric=${working}`), 'then asks again without the refused one');
        assert.equal(upserted('post_insights', 'instagram')[0].metrics.views, 130);
        assert.deepEqual(state.unsupported, { version: API_VERSION, metrics: { ig_reels: [RETIRED] } });
    });

    it('does not ask for a remembered name again', async () => {
        previousState = { ...(await syncInsights(TENANT, deps(ALL_SCOPES))) };
        batches = [];
        await syncInsights(TENANT, deps(ALL_SCOPES));
        assert.ok(!allBatchUrls().some((u) => u.startsWith('1790/') && u.includes(RETIRED)));
    });

    it('forgets refused names when the API version changes', async () => {
        previousState = { ...(await syncInsights(TENANT, deps(ALL_SCOPES))), unsupported: { version: 'v1.0', metrics: { ig_reels: [RETIRED] } } };
        batches = [];
        await syncInsights(TENANT, deps(ALL_SCOPES));
        assert.ok(allBatchUrls().includes(`1790/insights?metric=${IG_REELS_METRICS.join(',')}`));
    });
});

// ─── The 10-minute limit and the cron ────────────────────────────────────────────────────

describe('runSync and syncAllTenants', () => {
    it('refuses a second sync inside 10 minutes with 429 and the seconds to wait', async () => {
        claimRow = null;
        const err = await runSync(TENANT, deps(ALL_SCOPES)).then(() => null, (e) => e);
        assert.ok(err instanceof GrowthError);
        assert.equal(err.status, 429);
        assert.equal(err.extra?.retryAfter, 420);
        assert.equal(gets.length, 0, 'nothing reached Meta');
    });

    it('answers { synced, lastSync } when the slot is free', async () => {
        const out = await runSync(TENANT, deps(['instagram_basic']));
        assert.equal(out.lastSync, NOW.toISOString());
        assert.equal(out.synced.instagram.posts, 2);
    });

    it('the daily sweep keeps going past a tenant that fails, and skips one synced minutes ago', async () => {
        let n = 0;
        const realRespond = respond;
        (pool as any).query = async (sql: string, params: any[] = []) => {
            const flat = sql.replace(/\s+/g, ' ').trim();
            statements.push({ sql: flat, params });
            if (/INSERT INTO growth_settings \(creator_id, last_sync_at\)/.test(flat)) {
                n++;
                return { rows: n === 2 ? [] : [{ last_sync_at: NOW }], rowCount: n === 2 ? 0 : 1 };
            }
            if (/FROM creators WHERE id/.test(flat)) throw new Error('connection reset');
            const r = realRespond(flat, params);
            return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
        };
        const out = await syncAllTenants({ deps: deps(ALL_SCOPES) });
        assert.deepEqual(out, { tenants: 2, synced: 0, skipped: 1, failed: 1 });
    });

    it('stops quietly, with the reason, when migration v22 is missing', async () => {
        (pool as any).query = async (sql: string) => {
            if (/growth_settings/.test(sql)) throw Object.assign(new Error('relation "growth_settings" does not exist'), { code: '42P01' });
            if (/SELECT id FROM creators/.test(sql)) return { rows: [{ id: TENANT }], rowCount: 1 };
            return { rows: [], rowCount: 0 };
        };
        const out = await syncAllTenants({ deps: deps(ALL_SCOPES) });
        assert.equal(out.skippedReason, 'migration v22 is not applied');
        assert.equal(out.failed, 0);
    });
});

// ─── Rate-limit headroom ─────────────────────────────────────────────────────────────────

describe('GraphSession — rate limits', () => {
    it('reads the highest percentage from X-App-Usage and X-Business-Use-Case-Usage', () => {
        assert.equal(usagePercent({ 'x-app-usage': '{"call_count":12,"total_cputime":3,"total_time":5}' }), 12);
        assert.equal(usagePercent({ 'x-business-use-case-usage': '{"1784":[{"type":"instagram","call_count":85,"total_time":9}]}' }), 85);
        assert.equal(usagePercent({ 'x-app-usage': 'not json' }), 0);
    });

    it('stops batching once a usage header passes 80%', async () => {
        (metaHttp as any).post = async (_url: string, form: URLSearchParams) => {
            const items = JSON.parse(form.get('batch')!) as unknown[];
            batches.push([]);
            return { data: items.map(() => ({ code: 200, body: '{"data":[]}' })), headers: { 'x-app-usage': '{"call_count":91}' } };
        };
        const graph = new GraphSession('tok');
        const outcomes = await graph.batch(Array.from({ length: 60 }, (_, i) => ({ relative_url: `${i}/insights?metric=reach` })));
        assert.equal(batches.length, 1, 'the second batch of 10 was never sent');
        assert.equal(graph.throttled, true);
        assert.equal(outcomes.filter((o) => o.ok).length, 50);
        assert.match((outcomes[55] as { error: { message: string } }).error.message, /rate limit/);
    });
});
