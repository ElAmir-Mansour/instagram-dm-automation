/**
 * The overview's arithmetic, from rows: engagement rate, the best-times heatmap, the KPIs and
 * where each came from, the follower / non-follower split, and the "why is this empty" notes.
 * Pure — `buildOverview` takes rows, so none of this needs a database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PostInsightRow, PostMetrics } from '../../db/rows.js';
import {
    bestTimes, buildOverview, engagementRate, interactionsOf, slotOf, sortPosts, toPostInsight, type OverviewInput,
} from './overview.js';

let n = 0;
function post(metrics: PostMetrics, fields: Partial<PostInsightRow> = {}) {
    n++;
    return toPostInsight({
        id: `p${n}`, creator_id: 't', platform: 'instagram', media_id: `m${n}`, scheduled_post_id: null, media_type: 'REELS',
        permalink: null, caption: `caption ${n}`, thumbnail_url: null, published_at: new Date('2026-09-20T18:00:00Z'),
        metrics, fetched_at: new Date('2026-09-25T00:00:00Z'), ...fields,
    });
}

describe('engagement', () => {
    it('uses Meta’s total_interactions when there is one, else the sum of the counts', () => {
        assert.equal(interactionsOf({ total_interactions: 9, likes: 100 }), 9);
        assert.equal(interactionsOf({ likes: 2, comments: 1, saved: 1 }), 4);
        assert.equal(interactionsOf({ views: 130 }), null, 'no counts is unknown, not 0');
    });

    it('is interactions over reach, and null without a reach', () => {
        assert.equal(engagementRate({ likes: 3, comments: 1, reach: 100 }), 0.04);
        assert.equal(engagementRate({ likes: 3 }), null);
        assert.equal(engagementRate({ likes: 3, reach: 0 }), null, 'no division by zero');
    });

    it('gives every PostInsight the same metric keys, null when unknown', () => {
        const p = post({ views: 130 });
        assert.equal(p.metrics.views, 130);
        assert.equal(p.metrics.reach, null);
        assert.equal(p.engagement_rate, null);
        assert.equal(p.published_at, '2026-09-20T18:00:00.000Z');
    });
});

describe('best times', () => {
    it('places a post in its weekday and hour in the tenant’s timezone', () => {
        // 18:00 UTC on Sunday 2026-09-20 is 21:00 in Riyadh, and 11:00 in Los Angeles.
        assert.deepEqual(slotOf(new Date('2026-09-20T18:00:00Z'), 'Asia/Riyadh'), { weekday: 0, hour: 21 });
        assert.deepEqual(slotOf(new Date('2026-09-20T18:00:00Z'), 'America/Los_Angeles'), { weekday: 0, hour: 11 });
    });

    it('averages views per slot and counts the posts behind each', () => {
        const posts = [
            post({ views: 100 }), post({ views: 200 }),
            post({ views: 30 }, { published_at: new Date('2026-09-22T09:00:00Z') }),
        ];
        const best = bestTimes(posts, 'Asia/Riyadh');
        assert.equal(best.metric, 'views');
        assert.equal(best.grid[0]![21], 150);
        assert.equal(best.counts[0]![21], 2);
        assert.equal(best.grid[2]![12], 30, 'Tuesday 09:00 UTC is 12:00 in Riyadh');
        assert.equal(best.grid.length, 7);
        assert.ok(best.grid.every((row) => row.length === 24));
    });

    it('falls back to interactions when no post has views, and to nothing when there is nothing', () => {
        assert.equal(bestTimes([post({ likes: 2 })], 'UTC').metric, 'interactions');
        const empty = bestTimes([post({})], 'UTC');
        assert.equal(empty.metric, null);
        assert.equal(empty.posts, 0);
    });
});

describe('buildOverview', () => {
    const base = (over: Partial<OverviewInput> = {}): OverviewInput => ({
        posts: [], days: [], latestFollowers: {}, windowDays: 7, today: '2026-09-25', timezone: 'Asia/Riyadh',
        platforms: ['instagram', 'facebook'], ...over,
    });

    it('takes reach and views from the account days, and says so', () => {
        const o = buildOverview(base({
            days: [
                { platform: 'instagram', day: '2026-09-23', metrics: { reach: 60, views: 80, saves: 2 } },
                { platform: 'facebook', day: '2026-09-23', metrics: { reach: 40, views: 280 } },
            ],
            posts: [post({ reach: 10, saved: 5 })],
        }), 'all');
        assert.equal(o.kpis.reach, 100);
        assert.equal(o.kpis.views, 360);
        assert.equal(o.kpi_sources.reach, 'account');
        assert.equal(o.kpis.saves, 2, 'account-level saves count old posts too');
        assert.equal(o.kpis.profile_visits, null, 'unavailable is null, not 0');
        assert.equal(o.kpi_sources.profile_visits, null);
    });

    it('falls back to the posts when there are no account days', () => {
        const o = buildOverview(base({ posts: [post({ reach: 10, views: 12, likes: 1 }), post({ reach: 30, views: 40, likes: 3 })] }), 'instagram');
        assert.equal(o.kpis.reach, 40);
        assert.equal(o.kpi_sources.reach, 'posts');
        assert.equal(o.kpis.engagement_rate, 0.1, 'Σ interactions / Σ reach = 4 / 40');
        assert.equal(o.kpis.posts, 2);
    });

    it('surfaces the follower / non-follower split and its share', () => {
        const o = buildOverview(base({
            days: [
                { platform: 'instagram', day: '2026-09-23', metrics: { reach_followers: 10, reach_non_followers: 990, reach_by_surface: { REEL: 995, POST: 5 } } },
                { platform: 'instagram', day: '2026-09-24', metrics: { reach_followers: 7, reach_non_followers: 714, views_followers: 144, views_non_followers: 2202 } },
            ],
        }), 'instagram');
        assert.deepEqual(o.audience_split?.reach, { followers: 17, non_followers: 1704 });
        assert.equal(o.kpis.non_follower_reach_share, 0.9901);
        assert.deepEqual(o.reach_by_surface, { REEL: 995, POST: 5 });
    });

    it('counts followers from the newest total and the change from the oldest in the window', () => {
        const o = buildOverview(base({
            latestFollowers: { instagram: 36, facebook: 118 },
            days: [
                { platform: 'instagram', day: '2026-09-20', metrics: { followers: 33 } },
                { platform: 'facebook', day: '2026-09-19', metrics: { followers: 117 } },
            ],
        }), 'all');
        assert.equal(o.kpis.followers, 154);
        assert.equal(o.kpis.followers_delta, 4);

        const one = buildOverview(base({ latestFollowers: { instagram: 36 }, days: [{ platform: 'instagram', day: '2026-09-25', metrics: { followers: 36 } }] }), 'instagram');
        assert.equal(one.kpis.followers_delta, null, 'one snapshot is no change to report');
    });

    it('draws one trend point per day, with no invented values', () => {
        const o = buildOverview(base({ days: [{ platform: 'instagram', day: '2026-09-24', metrics: { reach: 5 } }] }), 'instagram');
        assert.equal(o.trend.length, 7);
        assert.equal(o.trend[0]!.day, '2026-09-19');
        assert.deepEqual(o.trend.find((t) => t.day === '2026-09-24'), { day: '2026-09-24', reach: 5, views: null, followers: null });
        assert.equal(o.trend[0]!.reach, null);
    });

    it('explains the empty follow metrics under 100 followers, and where best times come from', () => {
        const o = buildOverview(base({ latestFollowers: { instagram: 36 }, posts: [post({ views: 100 })] }), 'instagram');
        assert.match(o.notes.follows!, /100\+ followers/);
        assert.match(o.notes.online_followers!, /your own posts/);
        assert.match(o.notes.best_times!, /Average views of your own 1 post/);
        assert.equal(o.best_times_meta.source, 'own_posts');
    });

    it('ranks top posts by views and groups by type', () => {
        const reel = post({ views: 150, reach: 120, likes: 3 });
        const carousel = post({ views: 14, reach: 6, likes: 1 }, { media_type: 'CAROUSEL_ALBUM' });
        const o = buildOverview(base({ posts: [carousel, reel] }), 'instagram');
        assert.deepEqual(o.top_posts.map((p) => p.media_id), [reel.media_id, carousel.media_id]);
        assert.deepEqual(o.by_type.map((t) => [t.type, t.posts, t.avg_views]), [['CAROUSEL_ALBUM', 1, 14], ['REELS', 1, 150]]);
    });

    it('sorts the posts table descending with unknowns last', () => {
        const a = post({ views: 5 });
        const b = post({});
        const c = post({ views: 50 });
        assert.deepEqual(sortPosts([a, b, c], 'views').map((p) => p.media_id), [c.media_id, a.media_id, b.media_id]);
        assert.deepEqual(sortPosts([a, b, c], 'nonsense').length, 3, 'an unknown sort falls back to date');
    });
});
