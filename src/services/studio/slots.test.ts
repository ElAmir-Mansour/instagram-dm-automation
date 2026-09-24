/**
 * Posting slots: wall-clock times in the tenant's timezone, converted per day, minus the ones a
 * pending Meta post already holds.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import {
    candidateSlots, freeSlots, MAX_SLOT_COUNT, nextFreeSlots, parseSlotCount, SLOT_HOLD_WINDOW_MS, zonedTimeToUtc,
} from './slots.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RIYADH = { timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] };
const iso = (ms: number) => new Date(ms).toISOString();

describe('zonedTimeToUtc', () => {
    it('reads 13:00 and 21:00 in Riyadh as 10:00Z and 18:00Z', () => {
        assert.equal(iso(zonedTimeToUtc(2026, 10, 1, 13, 0, 'Asia/Riyadh')), '2026-10-01T10:00:00.000Z');
        assert.equal(iso(zonedTimeToUtc(2026, 10, 1, 21, 0, 'Asia/Riyadh')), '2026-10-01T18:00:00.000Z');
    });

    it('follows daylight saving: 13:00 in London is 12:00Z in July and 13:00Z in December', () => {
        // The reason slots are converted per day: a fixed offset would be an hour out for half the year.
        assert.equal(iso(zonedTimeToUtc(2026, 7, 1, 13, 0, 'Europe/London')), '2026-07-01T12:00:00.000Z');
        assert.equal(iso(zonedTimeToUtc(2026, 12, 1, 13, 0, 'Europe/London')), '2026-12-01T13:00:00.000Z');
    });

    it('lands on the previous UTC day for a morning slot east of UTC', () => {
        assert.equal(iso(zonedTimeToUtc(2026, 10, 2, 8, 0, 'Asia/Tokyo')), '2026-10-01T23:00:00.000Z');
    });
});

describe('candidateSlots', () => {
    it('lists today’s remaining slots, then each following day’s, in order, whatever order they were saved in', () => {
        const now = Date.parse('2026-10-01T12:00:00Z'); // 15:00 in Riyadh: 13:00 has passed, 21:00 has not
        const slots = candidateSlots({ timezone: 'Asia/Riyadh', slots: ['21:00', '13:00'] }, now, 2).map(iso);
        assert.deepEqual(slots, ['2026-10-01T18:00:00.000Z', '2026-10-02T10:00:00.000Z', '2026-10-02T18:00:00.000Z']);
    });

    it('starts from the tenant’s local date, not the UTC one', () => {
        // 22:30Z on the 1st is already 01:30 on the 2nd in Riyadh.
        const now = Date.parse('2026-10-01T22:30:00Z');
        const [first] = candidateSlots(RIYADH, now, 2).map(iso);
        assert.equal(first, '2026-10-02T10:00:00.000Z');
    });
});

describe('freeSlots', () => {
    const at = (s: string) => Date.parse(s);
    const candidates = [at('2026-10-01T10:00:00Z'), at('2026-10-01T18:00:00Z'), at('2026-10-02T10:00:00Z')];

    it('skips a slot a pending post sits within 30 minutes of, on either side', () => {
        assert.deepEqual(freeSlots(candidates, [at('2026-10-01T10:10:00Z')], 2),
            ['2026-10-01T18:00:00.000Z', '2026-10-02T10:00:00.000Z']);
        assert.deepEqual(freeSlots(candidates, [at('2026-10-01T09:45:00Z')], 1), ['2026-10-01T18:00:00.000Z']);
    });

    it('keeps a slot that a post is a full window away from', () => {
        const clear = at('2026-10-01T10:00:00Z') + SLOT_HOLD_WINDOW_MS;
        assert.deepEqual(freeSlots(candidates, [clear], 1), ['2026-10-01T10:00:00.000Z']);
    });
});

describe('parseSlotCount', () => {
    it('clamps to 1..30 and reads anything unreadable as 1', () => {
        assert.equal(parseSlotCount('4'), 4);
        assert.equal(parseSlotCount(undefined), 1);
        assert.equal(parseSlotCount('abc'), 1);
        assert.equal(parseSlotCount('0'), 1);
        assert.equal(parseSlotCount('500'), MAX_SLOT_COUNT);
    });
});

describe('nextFreeSlots', () => {
    let statements: { sql: string; params: unknown[] }[] = [];
    let taken: Date[] = [];
    const originalQuery = pool.query;

    beforeEach(() => {
        statements = [];
        taken = [];
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            statements.push({ sql: sql.replace(/\s+/g, ' '), params });
            return { rows: taken.map((t) => ({ scheduled_time: t })), rowCount: taken.length };
        };
    });
    afterEach(() => {
        (pool as unknown as { query: unknown }).query = originalQuery;
    });

    it('skips a slot a PENDING Meta post holds, and counts nothing else as holding one', async () => {
        taken = [new Date('2026-10-01T18:00:00Z')];
        const slots = await nextFreeSlots(TENANT, RIYADH, 2, Date.parse('2026-10-01T12:00:00Z'));
        assert.deepEqual(slots, ['2026-10-02T10:00:00.000Z', '2026-10-02T18:00:00.000Z']);

        const [query] = statements;
        assert.equal(query!.params[0], TENANT);
        assert.match(query!.sql, /status = 'PENDING'/);
        // A TikTok row is the sibling of a Meta post that already holds the slot.
        assert.match(query!.sql, /platform IN \('instagram', 'facebook', 'both'\)/);
    });
});
