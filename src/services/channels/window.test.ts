/**
 * The 24 h customer-service window and the free-entry window, as one rule.
 *
 * The boundary and the missing-value cases are the point: a send one millisecond past the window is
 * answered by Meta with 131047, and a window that quietly treats "no data" as "open" would send into it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CUSTOMER_SERVICE_WINDOW_MS, isWindowOpen, windowClosesAt } from './window.js';

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-10-19T09:00:00.000Z');

describe('CUSTOMER_SERVICE_WINDOW_MS', () => {
    it('is 24 hours', () => {
        assert.equal(CUSTOMER_SERVICE_WINDOW_MS, 24 * HOUR);
    });
});

describe('isWindowOpen: the 24 h customer-service window', () => {
    it('is open right after the customer wrote', () => {
        assert.equal(isWindowOpen({ lastInboundAt: new Date(T0), freeWindowExpiresAt: null, now: new Date(T0) }), true);
    });

    it('is open one millisecond before 24 h', () => {
        assert.equal(isWindowOpen({ lastInboundAt: new Date(T0), freeWindowExpiresAt: null, now: new Date(T0 + 24 * HOUR - 1) }), true);
    });

    it('is closed at exactly 24 h (the boundary is exclusive)', () => {
        assert.equal(isWindowOpen({ lastInboundAt: new Date(T0), freeWindowExpiresAt: null, now: new Date(T0 + 24 * HOUR) }), false);
    });

    it('is closed after 24 h', () => {
        assert.equal(isWindowOpen({ lastInboundAt: new Date(T0), freeWindowExpiresAt: null, now: new Date(T0 + 25 * HOUR) }), false);
    });

    it('is open when "now" is before the last inbound (clock skew), never negative-closed', () => {
        assert.equal(isWindowOpen({ lastInboundAt: new Date(T0), freeWindowExpiresAt: null, now: new Date(T0 - HOUR) }), true);
    });
});

describe('isWindowOpen: the free-entry window', () => {
    it('is open inside the free window although the 24 h window has closed', () => {
        const input = { lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 + 7 * 24 * HOUR), now: new Date(T0 + 3 * 24 * HOUR) };
        assert.equal(isWindowOpen(input), true);
    });

    it('is closed at exactly the free window end when the 24 h window is also over', () => {
        const input = { lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 + 7 * 24 * HOUR), now: new Date(T0 + 7 * 24 * HOUR) };
        assert.equal(isWindowOpen(input), false);
    });

    it('is open one millisecond before the free window end', () => {
        const input = { lastInboundAt: null, freeWindowExpiresAt: new Date(T0 + 7 * 24 * HOUR), now: new Date(T0 + 7 * 24 * HOUR - 1) };
        assert.equal(isWindowOpen(input), true);
    });

    it('stays open on the 24 h window when the free window already ended', () => {
        const input = { lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 - HOUR), now: new Date(T0 + HOUR) };
        assert.equal(isWindowOpen(input), true);
    });

    it('is closed when both windows are over', () => {
        const input = { lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 + 2 * HOUR), now: new Date(T0 + 30 * HOUR) };
        assert.equal(isWindowOpen(input), false);
    });
});

describe('isWindowOpen: missing and invalid values fail closed', () => {
    it('is closed when the customer never wrote and there is no free window', () => {
        assert.equal(isWindowOpen({ lastInboundAt: null, freeWindowExpiresAt: null, now: new Date(T0) }), false);
        assert.equal(isWindowOpen({ lastInboundAt: undefined, freeWindowExpiresAt: undefined, now: new Date(T0) }), false);
    });

    it('ignores an invalid lastInboundAt but still honours a valid free window', () => {
        const free = new Date(T0 + HOUR);
        for (const bad of [new Date('nope'), 'not a date', '', '   ', NaN, Infinity]) {
            assert.equal(isWindowOpen({ lastInboundAt: bad, freeWindowExpiresAt: null, now: new Date(T0) }), false, `bad=${String(bad)}`);
            assert.equal(isWindowOpen({ lastInboundAt: bad, freeWindowExpiresAt: free, now: new Date(T0) }), true, `bad=${String(bad)} + free`);
        }
    });

    it('ignores an invalid freeWindowExpiresAt but still honours a valid 24 h window', () => {
        for (const bad of [new Date('nope'), 'garbage', '', NaN]) {
            assert.equal(isWindowOpen({ lastInboundAt: new Date(T0), freeWindowExpiresAt: bad, now: new Date(T0 + HOUR) }), true, `bad=${String(bad)}`);
            assert.equal(isWindowOpen({ lastInboundAt: new Date(T0), freeWindowExpiresAt: bad, now: new Date(T0 + 25 * HOUR) }), false, `bad=${String(bad)}`);
        }
    });

    it('is closed when "now" is not a usable instant, even if both windows are far in the future', () => {
        const input = { lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 + 100 * 24 * HOUR) };
        for (const bad of [null, undefined, new Date('nope'), 'garbage', NaN]) {
            assert.equal(isWindowOpen({ ...input, now: bad }), false, `now=${String(bad)}`);
        }
    });

    it('treats an out-of-range epoch as unusable instead of throwing', () => {
        assert.equal(isWindowOpen({ lastInboundAt: 8.64e15, freeWindowExpiresAt: null, now: new Date(T0) }), false);
        assert.equal(windowClosesAt({ lastInboundAt: 8.64e15, freeWindowExpiresAt: null }), null);
    });
});

describe('isWindowOpen: accepted instant shapes', () => {
    it('reads ISO strings (a serialised TIMESTAMPTZ), epoch milliseconds and Dates alike', () => {
        const iso = new Date(T0).toISOString();
        assert.equal(isWindowOpen({ lastInboundAt: iso, freeWindowExpiresAt: null, now: T0 + HOUR }), true);
        assert.equal(isWindowOpen({ lastInboundAt: T0, freeWindowExpiresAt: null, now: new Date(T0 + HOUR).toISOString() }), true);
        assert.equal(isWindowOpen({ lastInboundAt: iso, freeWindowExpiresAt: null, now: T0 + 24 * HOUR }), false);
    });

    it('accepts epoch 0 as a real instant', () => {
        assert.equal(isWindowOpen({ lastInboundAt: 0, freeWindowExpiresAt: null, now: 0 }), true);
        assert.equal(isWindowOpen({ lastInboundAt: 0, freeWindowExpiresAt: null, now: 24 * HOUR }), false);
    });

    it('does not mutate the Dates it is given', () => {
        const last = new Date(T0);
        const free = new Date(T0 + HOUR);
        isWindowOpen({ lastInboundAt: last, freeWindowExpiresAt: free, now: new Date(T0) });
        windowClosesAt({ lastInboundAt: last, freeWindowExpiresAt: free });
        assert.equal(last.getTime(), T0);
        assert.equal(free.getTime(), T0 + HOUR);
    });
});

describe('windowClosesAt', () => {
    it('is the last inbound plus 24 h when there is no free window', () => {
        assert.equal(windowClosesAt({ lastInboundAt: new Date(T0), freeWindowExpiresAt: null })?.getTime(), T0 + 24 * HOUR);
    });

    it('is the free window end when there is no inbound', () => {
        assert.equal(windowClosesAt({ lastInboundAt: null, freeWindowExpiresAt: new Date(T0 + 7 * 24 * HOUR) })?.getTime(), T0 + 7 * 24 * HOUR);
    });

    it('is the later of the two', () => {
        assert.equal(
            windowClosesAt({ lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 + 7 * 24 * HOUR) })?.getTime(),
            T0 + 7 * 24 * HOUR,
        );
        assert.equal(
            windowClosesAt({ lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 + HOUR) })?.getTime(),
            T0 + 24 * HOUR,
        );
    });

    it('is null when neither source is usable', () => {
        assert.equal(windowClosesAt({ lastInboundAt: null, freeWindowExpiresAt: null }), null);
        assert.equal(windowClosesAt({ lastInboundAt: 'garbage', freeWindowExpiresAt: new Date('nope') }), null);
    });

    it('agrees with isWindowOpen at the boundary: open iff now < windowClosesAt', () => {
        const input = { lastInboundAt: new Date(T0), freeWindowExpiresAt: new Date(T0 + 2 * HOUR) };
        const closes = windowClosesAt(input)!.getTime();
        for (const now of [closes - 1, closes, closes + 1]) {
            assert.equal(isWindowOpen({ ...input, now }), now < closes, `now=${now - closes}`);
        }
    });
});
