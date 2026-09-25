/**
 * Meta's JSON → our rows. The shapes here are the ones verified against production on v26.0
 * (README.md §2): `values[0].value` with a `total_value.value` fallback, breakdowns under
 * `total_value.breakdowns[0].results`, and time series stamped with the END of their day.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    dayBounds, dayOfEndTime, daysToSync, fbMediaType, followsBreakdown, igMediaType, igMetricsFor, IG_FEED_METRICS,
    IG_REELS_METRICS, insightValues, mapFbInsights, mapFbPageDays, mapFbPost, mapIgDay, mapIgInsights, mapIgMedia, mapIgSplit,
} from './mapping.js';

describe('Instagram media', () => {
    it('maps a reel by media_product_type, whatever its media_type says', () => {
        assert.equal(igMediaType({ media_type: 'VIDEO', media_product_type: 'REELS' }), 'REELS');
        assert.equal(igMediaType({ media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED' }), 'CAROUSEL_ALBUM');
        assert.deepEqual(igMetricsFor('REELS'), IG_REELS_METRICS);
        assert.deepEqual(igMetricsFor('CAROUSEL_ALBUM'), IG_FEED_METRICS);
        assert.ok(!IG_REELS_METRICS.includes('profile_visits' as never), 'reels have no profile_visits');
    });

    it('keeps the list’s public counts, the thumbnail and the id it is linked by', () => {
        const post = mapIgMedia({
            id: '1789', media_type: 'IMAGE', media_product_type: 'FEED', timestamp: '2026-09-20T18:30:00+0000',
            like_count: 2, comments_count: 0, permalink: 'https://instagram.com/p/x', caption: 'hello', media_url: 'https://cdn/i.jpg',
        })!;
        assert.equal(post.media_id, '1789');
        assert.equal(post.published_at, '2026-09-20T18:30:00.000Z');
        assert.deepEqual(post.metrics, { likes: 2, comments: 0 }, 'a real 0 is kept; nothing else is invented');
        assert.equal(post.thumbnail_url, 'https://cdn/i.jpg');
        assert.deepEqual(post.link_ids, ['1789']);

        const reel = mapIgMedia({ id: '1790', media_type: 'VIDEO', media_product_type: 'REELS', media_url: 'https://cdn/v.mp4' })!;
        assert.equal(reel.thumbnail_url, null, 'a video’s media_url is the video, not a thumbnail');
        assert.equal(mapIgMedia({ caption: 'no id' }), null);
    });

    it('reads insights from values[0].value, falling back to total_value.value, and renames watch time', () => {
        const metrics = mapIgInsights([
            { name: 'views', values: [{ value: 130 }] },
            { name: 'reach', total_value: { value: 110 } },
            { name: 'ig_reels_avg_watch_time', values: [{ value: 3200 }] },
            { name: 'ig_reels_video_view_total_time', values: [{ value: 416000 }] },
            { name: 'reels_skip_rate', values: [{ value: 86.5 }] },
            { name: 'saved', values: [] },
        ]);
        assert.deepEqual(metrics, { views: 130, reach: 110, avg_watch_time_ms: 3200, video_view_total_time_ms: 416000, skip_rate: 86.5 });
        assert.ok((IG_REELS_METRICS as readonly string[]).includes('reels_skip_rate'), 'the sync asks for it');
        assert.equal('saved' in metrics, false, 'no value is absent, not 0');
        assert.deepEqual(insightValues('nonsense'), {});
    });
});

describe('Facebook posts', () => {
    it('maps album to a carousel and video to VIDEO, and links by post id and attachment target', () => {
        const post = mapFbPost({
            id: '100560442828593_123', created_time: '2026-09-21T10:00:00+0000', message: 'مرحبا',
            permalink_url: 'https://facebook.com/x', full_picture: 'https://cdn/f.jpg',
            attachments: { data: [{ media_type: 'video', target: { id: '555' } }] },
        })!;
        assert.equal(post.media_type, 'VIDEO');
        assert.deepEqual(post.link_ids, ['100560442828593_123', '555'], 'a /videos publish stored the video id');
        assert.deepEqual(post.metrics, {}, 'the list carries no numbers');
        assert.equal(fbMediaType({ attachments: { data: [{ media_type: 'album' }] } }), 'CAROUSEL_ALBUM');
        assert.equal(fbMediaType({}), 'TEXT');
    });

    it('sums every reaction into likes and renames the video metrics', () => {
        assert.deepEqual(mapFbInsights([
            { name: 'post_media_view', values: [{ value: 800 }] },
            { name: 'post_total_media_view_unique', values: [{ value: 640 }] },
            { name: 'post_reactions_by_type_total', values: [{ value: { like: 5, love: 2 } }] },
            { name: 'post_video_avg_time_watched', values: [{ value: 4100 }] },
        ]), { views: 800, reach: 640, likes: 7, avg_watch_time_ms: 4100 });
    });
});

describe('Account days', () => {
    it('reads the per-day totals under the contract’s names', () => {
        const day = mapIgDay([
            { name: 'reach', total_value: { value: 61 } },
            { name: 'views', total_value: { value: 79 } },
            { name: 'profile_views', total_value: { value: 3 } },
            { name: 'website_clicks', total_value: { value: 0 } },
        ]);
        assert.deepEqual(day, { reach: 61, views: 79, profile_views: 3, website_clicks: 0 });
    });

    it('splits reach and views by follow_type, and reach by surface', () => {
        const byFollow = (metric: string) => [{
            name: metric,
            total_value: { breakdowns: [{ results: [{ dimension_values: ['FOLLOWER'], value: 17 }, { dimension_values: ['NON_FOLLOWER'], value: 1704 }] }] },
        }];
        assert.deepEqual(mapIgSplit('ig_reach_follow', byFollow('reach')), { reach_followers: 17, reach_non_followers: 1704 });
        assert.deepEqual(mapIgSplit('ig_views_follow', byFollow('views')), { views_followers: 17, views_non_followers: 1704 });
        assert.deepEqual(mapIgSplit('ig_reach_surface', [{
            name: 'reach',
            total_value: { breakdowns: [{ results: [{ dimension_values: ['REEL'], value: 1714 }, { dimension_values: ['POST'], value: 1 }] }] },
        }]), { reach_by_surface: { REEL: 1714, POST: 1 } });
        assert.deepEqual(mapIgSplit('ig_reach_follow', []), {}, 'no split data is no keys');
        assert.deepEqual(followsBreakdown([{
            name: 'follows_and_unfollows',
            total_value: { breakdowns: [{ results: [{ dimension_values: ['FOLLOWER'], value: 4 }, { dimension_values: ['NON_FOLLOWER'], value: 1 }] }] },
        }]), { follows: 4, unfollows: 1 });
    });

    it('puts a series value on the day that ended at its end_time', () => {
        assert.equal(dayOfEndTime('2026-09-21T07:00:00+0000'), '2026-09-20', 'midnight Pacific ends the 20th');
        assert.equal(dayOfEndTime('2026-09-21T00:00:00+0000'), '2026-09-20');
        assert.equal(dayOfEndTime('garbage'), null);
    });

    it('takes page_follows as the day’s follower total, never a sum', () => {
        const days = mapFbPageDays([
            { name: 'page_follows', values: [{ value: 117, end_time: '2026-09-20T07:00:00+0000' }, { value: 118, end_time: '2026-09-21T07:00:00+0000' }] },
            { name: 'page_media_view', values: [{ value: 280, end_time: '2026-09-21T07:00:00+0000' }] },
        ]);
        assert.deepEqual(days.get('2026-09-19'), { followers: 117 });
        assert.deepEqual(days.get('2026-09-20'), { followers: 118, views: 280 });
    });

    it('backfills 28 days on a first sync and re-reads the last 3 on later ones, ending yesterday', () => {
        const first = daysToSync(null, '2026-09-25');
        assert.equal(first.length, 28);
        assert.equal(first[0], '2026-08-28');
        assert.equal(first.at(-1), '2026-09-24');
        assert.deepEqual(daysToSync('2026-09-24', '2026-09-25'), ['2026-09-22', '2026-09-23', '2026-09-24']);
        assert.deepEqual(daysToSync('2026-09-25', '2026-09-25'), ['2026-09-23', '2026-09-24'], 'today is never read');
        assert.deepEqual(dayBounds('2026-09-24'), { since: 1790208000, until: 1790294400 });
    });
});
