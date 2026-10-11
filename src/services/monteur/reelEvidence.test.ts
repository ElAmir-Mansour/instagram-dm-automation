/**
 * The Monteur's evidence from the creator's own reels (reelEvidence.ts, MONTEUR.md §6.1).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    BEST_REELS, EVIDENCE_DAYS, evidenceLine, loadReelEvidence, MIN_FOR_SKIP, MIN_FOR_WORST, MIN_VIEWS_FOR_SKIP, rankReels, REEL_EVIDENCE_SQL,
    type ReelEvidenceRow, WORST_REELS,
} from './reelEvidence.js';
import { installFakeDb, type FakeDb } from './testDb.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const row = (over: Partial<ReelEvidenceRow> & { views: number; skip?: number }): ReelEvidenceRow => ({
    group_key: over.group_key ?? `k-${Math.random()}`,
    platform: over.platform ?? 'facebook',
    caption: over.caption ?? `reel ${over.views}\nbody`,
    published_at: over.published_at ?? daysAgo(10),
    metrics: { views: over.views, ...(over.skip === undefined ? {} : { skip_rate: over.skip }) },
    title: over.title ?? null,
    topic: over.topic ?? null,
});

describe('rankReels', () => {
    it('adds a post\'s Instagram and Facebook views, and takes the skip rate from Instagram', () => {
        const { best } = rankReels([
            row({ group_key: 'p1', platform: 'facebook', views: 900, title: 'Google Stitch: صفحة كاملة', topic: 'شرح Google Stitch' }),
            row({ group_key: 'p1', platform: 'instagram', views: 77, skip: 70.25 }),
            row({ group_key: 'p2', views: 500 }),
        ], NOW);
        assert.deepEqual(best[0], {
            views: 977, skipRate: 70.25, title: 'Google Stitch: صفحة كاملة', topic: 'شرح Google Stitch', opening: 'reel 900',
        });
        assert.equal(best[1]!.views, 500);
    });

    it('counts a repost of the same video once, by its better post', () => {
        const { best } = rankReels([
            row({ caption: 'عملت الفيديو ده كله\nx', views: 780 }),
            row({ caption: 'عملت الفيديو ده كله\ny', views: 506 }),
            row({ views: 400 }),
        ], NOW);
        assert.deepEqual(best.map((r) => r.views), [780, 400]);
    });

    it(`keeps the ${BEST_REELS} best, and the ${WORST_REELS} worst only once there are ${MIN_FOR_WORST} reels`, () => {
        const five = [900, 800, 700, 20, 10].map((views) => row({ views }));
        assert.deepEqual(rankReels(five, NOW).worst, [], 'too few reels to call any of them the worst');
        const { best, worst } = rankReels([...five, row({ views: 5 })], NOW);
        assert.deepEqual(best.map((r) => r.views), [900, 800, 700]);
        assert.deepEqual(worst.map((r) => r.views), [5, 10]);
    });

    it('never calls a reel younger than 3 days one of the worst: its views are still coming in', () => {
        const rows = [900, 800, 700, 300, 200, 100].map((views) => row({ views }));
        rows.push(row({ views: 2, published_at: daysAgo(1) }));
        assert.deepEqual(rankReels(rows, NOW).worst.map((r) => r.views), [100, 200]);
    });
});

describe('rankReels: held and lost viewers (skip rate)', () => {
    const ig = (views: number, skip: number, over: Partial<ReelEvidenceRow> = {}) => row({ platform: 'instagram', views, skip, ...over });
    const six = [60, 70, 80, 90, 95, 99].map((skip, i) => ig(100 + i, skip));
    it('lists the lowest skip rates as held and the highest as lost, once there are enough reels with a trustworthy rate', () => {
        const { held, lost } = rankReels(six, NOW);
        assert.deepEqual(held!.map((r) => r.skipRate), [60, 70]);
        assert.deepEqual(lost!.map((r) => r.skipRate), [99, 95]);
        assert.equal(MIN_FOR_SKIP, 6);
    });
    it('says nothing below the minimum, ignores reels under the view floor and ones younger than 3 days', () => {
        assert.deepEqual(rankReels(six.slice(0, MIN_FOR_SKIP - 1), NOW).held, []);
        const noisy = [...six.slice(0, 5), ig(MIN_VIEWS_FOR_SKIP - 1, 100), ig(500, 10, { published_at: daysAgo(1) })];
        const out = rankReels(noisy, NOW);
        assert.deepEqual(out.held, [], '5 settled reels with a usable rate is still too few');
        assert.deepEqual(out.lost, []);
    });
    it('Facebook-only reels have no skip rate and never enter either list', () => {
        const out = rankReels([...six, ...[1, 2, 3].map((i) => row({ views: 1000 + i }))], NOW);
        assert.ok(out.held!.every((r) => r.skipRate !== null));
    });
});

describe('evidenceLine', () => {
    it('says only what it has', () => {
        assert.equal(
            evidenceLine({ views: 977, skipRate: 70.25, title: 'T', topic: 'Topic', opening: 'Open' }),
            '- 977 views, skipped in 3s 70.3%: title «T»; topic «Topic»; opening «Open»',
        );
        assert.equal(evidenceLine({ views: 1344, skipRate: null, title: null, topic: null, opening: 'Open' }), '- 1,344 views: opening «Open»');
    });
});

describe('loadReelEvidence', () => {
    let db: FakeDb;
    beforeEach(() => { db = installFakeDb(); });
    afterEach(() => db.restore());

    it('reads reels and videos of the last 90 days, joined to the clip each was cut as', async () => {
        db.routes.push([/FROM post_insights p/, () => ({ rows: [row({ views: 10 })] })]);
        const set = await loadReelEvidence('creator-1');
        assert.equal(set.best.length, 1);
        const [q] = db.ran(/FROM post_insights p/);
        assert.deepEqual(q!.params, ['creator-1', EVIDENCE_DAYS]);
        const sql = REEL_EVIDENCE_SQL.replace(/\s+/g, ' ');
        assert.match(sql, /media_type IN \('REELS', 'VIDEO'\)/, 'carousels and photos are not reels');
        assert.match(sql, /c\.schedule->>'meta_row_id' = p\.scheduled_post_id::text/);
        assert.match(sql, /c\.creator_id = p\.creator_id/, 'never another tenant\'s clip');
    });

    it('is fail-soft: no table, no evidence', async () => {
        db.routes.push([/FROM post_insights p/, () => { throw new Error('relation "post_insights" does not exist'); }]);
        assert.deepEqual(await loadReelEvidence('creator-1'), { best: [], worst: [] });
    });
});
