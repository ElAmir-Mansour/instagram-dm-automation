/**
 * The instants the lifecycle waits for (time.ts): midnight in a time zone, across daylight saving time, and the two resets it needs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextGeminiQuotaReset, nextMidnightIn, nextUtcMidnight } from './time.js';

const at = (iso: string) => Date.parse(iso);

describe('nextGeminiQuotaReset: midnight Pacific', () => {
    it('is 07:00 UTC while Pacific Daylight Time is on', () => {
        assert.equal(nextGeminiQuotaReset(at('2026-10-25T12:00:00Z')).toISOString(), '2026-10-26T07:00:00.000Z');
        assert.equal(nextGeminiQuotaReset(at('2026-07-04T00:00:00Z')).toISOString(), '2026-07-04T07:00:00.000Z', 'it is still the evening of the 3rd in California');
    });

    it('is 08:00 UTC in winter', () => {
        assert.equal(nextGeminiQuotaReset(at('2026-12-15T09:00:00Z')).toISOString(), '2026-12-16T08:00:00.000Z');
        assert.equal(nextGeminiQuotaReset(at('2027-01-10T23:59:00Z')).toISOString(), '2027-01-11T08:00:00.000Z');
    });

    it('lands on midnight on the days the clocks change: 2026-11-01 (back) and 2027-03-14 (forward)', () => {
        // 2026-10-31 13:00 PDT: the next midnight is the start of Nov 1, still PDT.
        assert.equal(nextGeminiQuotaReset(at('2026-10-31T20:00:00Z')).toISOString(), '2026-11-01T07:00:00.000Z');
        // 2026-11-01 02:00 PST (10:00Z, after the clocks went back at 09:00Z): the next midnight is the start of Nov 2, PST.
        assert.equal(nextGeminiQuotaReset(at('2026-11-01T10:00:00Z')).toISOString(), '2026-11-02T08:00:00.000Z');
        // 2027-03-13 20:00 PST: the next midnight is the start of Mar 14, PST (the clocks go forward at 02:00 that day).
        assert.equal(nextGeminiQuotaReset(at('2027-03-14T04:00:00Z')).toISOString(), '2027-03-14T08:00:00.000Z');
        // 2027-03-14 12:00 PDT (19:00Z): the next midnight is the start of Mar 15, PDT.
        assert.equal(nextGeminiQuotaReset(at('2027-03-14T19:00:00Z')).toISOString(), '2027-03-15T07:00:00.000Z');
    });

    it('is always in the future, and less than a day and an hour away', () => {
        for (let hour = 0; hour < 24 * 30; hour += 7) {
            const now = at('2026-10-20T00:00:00Z') + hour * 3_600_000;
            const reset = nextGeminiQuotaReset(now).getTime();
            assert.ok(reset > now && reset - now <= 25 * 3_600_000, new Date(now).toISOString());
        }
    });
});

describe('nextMidnightIn', () => {
    it('works for a zone east of Greenwich: Cairo is UTC+3 in the summer of 2026 and UTC+2 after the clocks go back', () => {
        assert.equal(nextMidnightIn('Africa/Cairo', at('2026-07-01T10:00:00Z')).toISOString(), '2026-07-01T21:00:00.000Z');
        assert.equal(nextMidnightIn('Africa/Cairo', at('2026-12-01T10:00:00Z')).toISOString(), '2026-12-01T22:00:00.000Z');
    });

    it('is UTC itself for UTC', () => {
        assert.equal(nextMidnightIn('UTC', at('2026-10-25T23:59:59Z')).toISOString(), '2026-10-26T00:00:00.000Z');
    });
});

describe('nextUtcMidnight', () => {
    it('is the start of the next UTC day, and the instant before midnight is not midnight', () => {
        assert.equal(nextUtcMidnight(at('2026-10-25T12:34:56Z')).toISOString(), '2026-10-26T00:00:00.000Z');
        assert.equal(nextUtcMidnight(at('2026-10-25T23:59:59.999Z')).toISOString(), '2026-10-26T00:00:00.000Z');
        assert.equal(nextUtcMidnight(at('2026-10-26T00:00:00.000Z')).toISOString(), '2026-10-27T00:00:00.000Z', 'at midnight exactly, the next one is a day away');
        assert.equal(nextUtcMidnight(at('2026-12-31T18:00:00Z')).toISOString(), '2027-01-01T00:00:00.000Z');
    });
});
