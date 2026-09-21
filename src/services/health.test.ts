/**
 * The health view's pure parts.
 *
 * `newestOf` is the one that matters. `lastWebhookAt` is the answer to "are webhooks still
 * arriving?", and it is the newest of three separately-nullable signals — a tenant that only
 * ever gets comments, or only DMs, or whose comments stopped matching any campaign, must each
 * report correctly rather than reporting nothing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMissingSchema, newestOf, SHORT_KEYWORD_MAX_LENGTH, STORAGE_TIER_BYTES, toIso } from './health.js';

describe('toIso', () => {
    it('passes a Date through as ISO', () => {
        assert.equal(toIso(new Date('2026-09-21T10:00:00.000Z')), '2026-09-21T10:00:00.000Z');
    });

    it('maps absent to null rather than to the epoch', () => {
        assert.equal(toIso(null), null);
        assert.equal(toIso(undefined), null);
    });

    it('returns null instead of "Invalid Date" for junk', () => {
        // `new Date(null).toISOString()` throws RangeError, and an unparseable string
        // stringifies to "Invalid Date" — either would end up rendered in the dashboard.
        assert.equal(toIso('not a date'), null);
        assert.equal(toIso({}), null);
    });
});

describe('newestOf', () => {
    const older = new Date('2026-09-20T10:00:00.000Z');
    const newer = new Date('2026-09-21T10:00:00.000Z');

    it('picks the newest regardless of argument order', () => {
        assert.equal(newestOf(older, newer), newer.toISOString());
        assert.equal(newestOf(newer, older), newer.toISOString());
    });

    it('ignores the absent signals instead of being defeated by them', () => {
        // A tenant that only ever receives DMs has no interactions row, and must still report
        // a last-webhook time. A single non-null signal is enough.
        assert.equal(newestOf(null, newer, null), newer.toISOString());
        assert.equal(newestOf(undefined, undefined, older), older.toISOString());
    });

    it('is null only when every signal is absent', () => {
        // Which is the honest answer for a tenant that has genuinely never received anything.
        assert.equal(newestOf(null, undefined), null);
        assert.equal(newestOf(), null);
    });

    it('lets the jobs signal win when nothing matched a campaign', () => {
        // The whole point of folding `jobs` in: a delivery that matched no keyword writes no
        // interactions row and no message, so without it a tenant whose keywords stopped
        // matching would be indistinguishable from one whose webhooks stopped arriving.
        const lastComment = new Date('2026-08-01T00:00:00.000Z');
        const lastJob = new Date('2026-09-21T09:00:00.000Z');

        assert.equal(newestOf(lastComment, null, lastJob), lastJob.toISOString());
    });
});

describe('isMissingSchema', () => {
    it('recognises the two Postgres codes a pending migration produces', () => {
        assert.equal(isMissingSchema({ code: '42P01' }), true);  // undefined_table
        assert.equal(isMissingSchema({ code: '42703' }), true);  // undefined_column
    });

    it('does not swallow an unrelated failure as a migration hint', () => {
        // Telling an operator to run a migration when the real problem is a dead connection
        // sends them to the wrong place entirely.
        for (const err of [{ code: '23505' }, { code: 'ECONNREFUSED' }, new Error('boom'), null, undefined]) {
            assert.equal(isMissingSchema(err), false, JSON.stringify(err));
        }
    });
});

describe('thresholds', () => {
    it('treats a three-character keyword as short', () => {
        // `scripts/diagnose.mjs` uses `< 3`, which misses the case this surfaces: عيد is three
        // characters and fires inside سعيد under substring matching.
        assert.equal('عيد'.length <= SHORT_KEYWORD_MAX_LENGTH, true);
        assert.equal('سعيد'.length <= SHORT_KEYWORD_MAX_LENGTH, false);
    });

    it('reports the Supabase free tier, which is what the percentage is against', () => {
        assert.equal(STORAGE_TIER_BYTES, 500 * 1024 * 1024);
    });
});
