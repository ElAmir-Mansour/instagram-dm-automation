/**
 * What perception keeps in Postgres (`store.ts`): the record on the inbound row, written ONCE and read back by a retry, and the library's notes on a reel.
 *
 * `pool.query` is replaced by a recorder that answers what a test arranges, so what is pinned is the statement itself: that it names the tenant, that the write
 * only happens while the row has no record, that `stored_at` is the database's clock, and that a row's old text is left alone when there is nothing readable.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { parseStoredPerception, readReelAnalysis, readStoredPerception, storePerception } from './store.js';
import type { Perception } from './types.js';

const STORED: Perception = {
    v: 1, kind: 'reel', status: 'ok', seen: 'A reel about a backend.', transcript: 'Today we build an API', about_owner: 'own_content', confidence: 0.9, model: 'muse-spark-1.3',
    stored_at: '2026-10-30T22:13:14.123456+00:00', ms: 4100, usd: 0.0123,
};

const originalQuery = pool.query;
afterEach(() => { (pool as any).query = originalQuery; });

function answering(rows: unknown[]): { sql: string; params: any[] }[] {
    const executed: { sql: string; params: any[] }[] = [];
    (pool as any).query = async (sql: string, params: any[] = []) => { executed.push({ sql, params }); return { rows, rowCount: rows.length }; };
    return executed;
}

describe('parseStoredPerception: only a record this code wrote', () => {
    it('reads a stored record whole', () => {
        assert.deepEqual(parseStoredPerception(STORED), STORED);
    });

    it('is null for anything else: not an object, another version, a kind perception does not read, an unknown status, no time', () => {
        for (const bad of [null, undefined, 'x', 3, [], {}, { ...STORED, v: 2 }, { ...STORED, kind: 'sticker' }, { ...STORED, kind: 'file' }, { ...STORED, status: 'done' }, { ...STORED, stored_at: undefined }, { ...STORED, stored_at: 5 }]) {
            assert.equal(parseStoredPerception(bad), null, JSON.stringify(bad));
        }
    });

    it('keeps a reason, a mention summary and a recall when they are well formed, and drops a field of the wrong type', () => {
        const rich = parseStoredPerception({
            ...STORED, status: 'failed', reason: 'expired_url', mention_summary: 'رحلة', recall: { reel_id: 'r', permalink: 'https://www.instagram.com/reel/x/', second: 13 }, about_owner: 'other_content',
        })!;
        assert.equal(rich.reason, 'expired_url');
        assert.equal(rich.mention_summary, 'رحلة');
        assert.deepEqual(rich.recall, { reel_id: 'r', permalink: 'https://www.instagram.com/reel/x/', second: 13 });
        assert.equal(rich.about_owner, 'other_content');

        const wrong = parseStoredPerception({ ...STORED, seen: 5, confidence: 'high', about_owner: 'nobody', recall: { reel_id: 1 }, ms: 'fast', usd: null, model: 3 })!;
        assert.equal(wrong.seen, undefined);
        assert.equal(wrong.confidence, undefined);
        assert.equal(wrong.about_owner, undefined);
        assert.equal(wrong.recall, undefined);
        assert.equal(wrong.ms, 0);
        assert.equal(wrong.usd, 0);
        assert.equal(wrong.model, '');
    });
});

describe('readStoredPerception', () => {
    it('reads one row of one tenant, and is what a retry reuses', async () => {
        const executed = answering([{ perception: STORED }]);
        assert.deepEqual(await readStoredPerception('msg-1', 'creator-1'), STORED);
        assert.equal(executed.length, 1);
        assert.match(executed[0]!.sql, /FROM messages WHERE id = \$1 AND creator_id = \$2/);
        assert.deepEqual(executed[0]!.params, ['msg-1', 'creator-1']);
    });

    it('is null for a row that never had one, and for a row that is not there', async () => {
        answering([{ perception: null }]);
        assert.equal(await readStoredPerception('msg-1', 'creator-1'), null);
        answering([]);
        assert.equal(await readStoredPerception('msg-1', 'creator-1'), null);
    });
});

describe('storePerception', () => {
    const draft: Omit<Perception, 'stored_at'> = { v: 1, kind: 'reel', status: 'ok', seen: 'A reel about a backend.', about_owner: 'own_content', confidence: 0.9, model: 'muse-spark-1.3', ms: 4100, usd: 0.0123 };

    it('writes the record ONCE, to a row with none, of this tenant, with the database\'s clock for `stored_at` and the readable text in the same statement', async () => {
        const executed = answering([{ perception: STORED }]);
        const stored = await storePerception({ messageId: 'msg-1', creatorId: 'creator-1', perception: draft, text: '[shared reel] A reel about a backend.' });

        assert.deepEqual(stored, STORED, 'the record as the database stored it');
        const sql = executed[0]!.sql.replace(/\s+/g, ' ');
        assert.match(sql, /^UPDATE messages SET perception = \$3::jsonb \|\| jsonb_build_object\('stored_at', to_jsonb\(NOW\(\)\)\), text = COALESCE\(\$4::text, text\) WHERE id = \$1 AND creator_id = \$2 AND perception IS NULL RETURNING perception$/);
        assert.deepEqual(executed[0]!.params.slice(0, 2), ['msg-1', 'creator-1']);
        assert.deepEqual(JSON.parse(executed[0]!.params[2]), draft, 'and what is written is the draft: no media, no stored_at of the application\'s');
        assert.equal(executed[0]!.params[3], '[shared reel] A reel about a backend.');
        assert.equal(executed.length, 1);
    });

    it('with nothing readable to say leaves the row\'s text as it is (the parameter is null, and COALESCE keeps the old one)', async () => {
        const executed = answering([{ perception: { ...STORED, status: 'failed', reason: 'expired_url' } }]);
        await storePerception({ messageId: 'msg-1', creatorId: 'creator-1', perception: { ...draft, status: 'failed', reason: 'expired_url' }, text: null });
        assert.equal(executed[0]!.params[3], null);
    });

    it('is null when the row already had a record (another attempt got there first): the statement matched nothing', async () => {
        answering([]);
        assert.equal(await storePerception({ messageId: 'msg-1', creatorId: 'creator-1', perception: draft, text: 'x' }), null);
    });

    it('lets a database error through: a job that could not store its perception is retried', async () => {
        (pool as any).query = async () => { throw new Error('connection terminated'); };
        await assert.rejects(storePerception({ messageId: 'msg-1', creatorId: 'creator-1', perception: draft, text: 'x' }), /connection terminated/);
    });
});

describe('readReelAnalysis', () => {
    it('reads the library\'s row of THIS tenant for one media id, and only one that ended ok', async () => {
        const executed = answering([{ result: { summary: 's' }, model: 'muse-spark-1.3' }]);
        assert.deepEqual(await readReelAnalysis('creator-1', '17900000000000001'), { result: { summary: 's' }, model: 'muse-spark-1.3' });
        assert.match(executed[0]!.sql.replace(/\s+/g, ' '), /FROM reel_analyses WHERE creator_id = \$1 AND ig_media_id = \$2 AND status = 'ok' LIMIT 1/);
        assert.deepEqual(executed[0]!.params, ['creator-1', '17900000000000001']);
    });

    it('is null when the library has no such reel', async () => {
        answering([]);
        assert.equal(await readReelAnalysis('creator-1', '1'), null);
    });
});
