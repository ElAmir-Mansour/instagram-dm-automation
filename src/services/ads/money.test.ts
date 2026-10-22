/**
 * THE money rule (research R7), pure: one function decides whether anything may start or raise spend, and every screen shows the
 * `remaining` it computes. worst case this month =
 *     what the ad account spent this month (all campaigns, the account's own calendar month)
 *   + what every ACTIVE and about-to-run budget can still spend this month (a daily budget × the days left, today counted at 1.75×
 *     because Meta may spend up to 75% over a daily budget on one day; a lifetime budget's unspent part)
 *   + the candidate,
 * and it must be at most the monthly cap. The daily max applies to the average a day: a lifetime budget as `amount / days`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    accountMonthEnd, candidateRemaining, checkCandidate, checkDailyMax, currencyOffset, DAILY_OVERSPEND, daysLeftThisMonth, fromMinorUnits,
    oneDayRemaining, parseCandidate, remainingThisMonth, shouldPauseAll, toMinorUnits, worstCase, type RawCampaign,
} from './money.js';

const NOW = new Date('2026-10-22T10:00:00Z');

describe('worstCase and checkCandidate', () => {
    it('adds the spend so far, every running budget\'s remaining, what is about to run and the candidate', () => {
        assert.equal(worstCase({ spentThisMonth: 40, othersRemaining: 30, aboutToRun: 5, candidate: 20 }), 95);
    });

    it('fits at exactly the cap and not a cent over, in cents (0.1 + 0.2 is 0.3)', () => {
        assert.equal(checkCandidate({ spentThisMonth: 40, othersRemaining: 30, aboutToRun: 10, candidate: 20, monthlyCap: 100 }).fits, true);
        const over = checkCandidate({ spentThisMonth: 40, othersRemaining: 30, aboutToRun: 10, candidate: 20.01, monthlyCap: 100 });
        assert.equal(over.fits, false);
        assert.equal(over.reason, 'OVER_MONTHLY_CAP');
        assert.equal(checkCandidate({ spentThisMonth: 0.1, othersRemaining: 0.2, aboutToRun: 0, candidate: 0, monthlyCap: 0.3 }).fits, true);
    });

    it('says what is left for anything new: the cap minus the worst case without the candidate, never below 0', () => {
        assert.equal(checkCandidate({ spentThisMonth: 40, othersRemaining: 30, aboutToRun: 5, candidate: 0, monthlyCap: 100 }).remaining, 25);
        assert.equal(checkCandidate({ spentThisMonth: 140, othersRemaining: 0, aboutToRun: 0, candidate: 0, monthlyCap: 100 }).remaining, 0);
    });

    it('counts an about-to-run activation against a second one: together they may not pass the cap', () => {
        const first = checkCandidate({ spentThisMonth: 50, othersRemaining: 0, aboutToRun: 0, candidate: 30, monthlyCap: 100 });
        const second = checkCandidate({ spentThisMonth: 50, othersRemaining: 0, aboutToRun: 30, candidate: 30, monthlyCap: 100 });
        assert.equal(first.fits, true);
        assert.equal(second.fits, false);
    });
});

describe('the month is the ad account\'s own', () => {
    it('ends at midnight in the account\'s time zone, not UTC', () => {
        // Riyadh is UTC+3: November starts at 2026-10-31T21:00Z there.
        assert.equal(new Date(accountMonthEnd(new Date('2026-10-31T20:59:00Z'), 3)).toISOString(), '2026-10-31T21:00:00.000Z');
        assert.equal(new Date(accountMonthEnd(new Date('2026-10-31T21:30:00Z'), 3)).toISOString(), '2026-11-30T21:00:00.000Z', '00:30 on 1 November in Riyadh is November');
        assert.equal(new Date(accountMonthEnd(new Date('2026-10-31T23:30:00Z'), 0)).toISOString(), '2026-11-01T00:00:00.000Z');
    });

    it('counts the days left in that month', () => {
        assert.equal(daysLeftThisMonth(null, null, NOW, 0), 10); // 22 Oct 10:00 → 1 Nov 00:00 is 9.58 days, rounded up
        assert.equal(daysLeftThisMonth(null, new Date('2026-10-25T10:00:00Z'), NOW, 0), 3);
        assert.equal(daysLeftThisMonth(new Date('2026-11-02T00:00:00Z'), null, NOW, 0), 0, 'a window that starts next month spends nothing this month');
    });
});

describe('remainingThisMonth of a running campaign', () => {
    const daily = (minor: number, extra: Partial<RawCampaign> = {}): RawCampaign => ({ id: '1', status: 'ACTIVE', daily_budget: String(minor), ...extra });

    it('a daily budget counts today at 1.75× and each later day once', () => {
        assert.equal(DAILY_OVERSPEND, 1.75);
        // $10 a day, 10 days left: 17.50 today + 9 × 10.
        assert.equal(remainingThisMonth(daily(1000), 'USD', 0, NOW, 0), 107.5);
        // Ending in 3 days: 17.50 + 2 × 10.
        assert.equal(remainingThisMonth(daily(1000, { stop_time: '2026-10-25T10:00:00Z' }), 'USD', 0, NOW, 0), 37.5);
    });

    it('a daily budget that starts later this month has no 1.75× day today', () => {
        assert.equal(remainingThisMonth(daily(1000, { start_time: '2026-10-29T10:00:00Z' }), 'USD', 0, NOW, 0), 30);
    });

    it('a lifetime budget counts what is left of it, whenever it ends', () => {
        const c: RawCampaign = { id: '2', status: 'ACTIVE', lifetime_budget: '5000', stop_time: '2026-12-31T00:00:00Z' };
        assert.equal(remainingThisMonth(c, 'USD', 12.5, NOW, 0), 37.5);
        assert.equal(remainingThisMonth({ ...c, stop_time: '2026-10-01T00:00:00Z' }, 'USD', 0, NOW, 0), 0, 'ended');
    });

    it('sums the running ad sets of a campaign whose budgets are on its ad sets, and skips paused ones', () => {
        const c: RawCampaign = { id: '3', status: 'ACTIVE', adsets: { data: [
            { id: 'a', status: 'ACTIVE', daily_budget: '1000' },
            { id: 'b', status: 'PAUSED', daily_budget: '1000' },
            { id: 'c', status: 'ACTIVE', lifetime_budget: '2000' },
        ] } };
        assert.equal(remainingThisMonth(c, 'USD', 0, NOW, 0), 127.5);
    });

    it('works in a whole-unit currency', () => {
        assert.equal(remainingThisMonth({ id: '4', status: 'ACTIVE', lifetime_budget: '5000' }, 'JPY', 0, NOW, 0), 5000);
    });
});

describe('oneDayRemaining (the hourly guard\'s look-ahead)', () => {
    it('is one more day of every daily budget at 1.75×, and every lifetime budget\'s unspent part', () => {
        assert.equal(oneDayRemaining({ id: '1', status: 'ACTIVE', daily_budget: '1000' }, 'USD', 0, NOW), 17.5);
        assert.equal(oneDayRemaining({ id: '2', status: 'ACTIVE', lifetime_budget: '5000' }, 'USD', 20, NOW), 30);
    });
});

describe('shouldPauseAll', () => {
    it('pauses once the month reached the cap, or when one more day could carry it past', () => {
        assert.equal(shouldPauseAll({ spentThisMonth: 100, nextDayRemaining: 0, monthlyCap: 100 }), true);
        assert.equal(shouldPauseAll({ spentThisMonth: 90, nextDayRemaining: 10.01, monthlyCap: 100 }), true);
        assert.equal(shouldPauseAll({ spentThisMonth: 90, nextDayRemaining: 10, monthlyCap: 100 }), false);
    });
});

describe('candidates', () => {
    it('parses the query form daily|lifetime:<amount>:<days>', () => {
        assert.deepEqual(parseCandidate('daily:10:5'), { kind: 'daily', amount: 10, days: 5 });
        assert.deepEqual(parseCandidate('lifetime:50:5'), { kind: 'lifetime', amount: 50, days: 5 });
        assert.deepEqual(parseCandidate('daily:10'), { kind: 'daily', amount: 10, days: null });
        for (const bad of ['', 'weekly:1:1', 'daily:-1:1', 'daily:abc:1', 'lifetime:10:0', 'lifetime:10:1.5', 'daily:1e9:1', null, 7]) {
            assert.equal(parseCandidate(bad as never), null, String(bad));
        }
    });

    it('a lifetime candidate counts its whole amount (Meta may spend it early); a daily one 1.75× today plus the rest of its days this month', () => {
        assert.equal(candidateRemaining({ kind: 'lifetime', amount: 50, days: 5 }, NOW, 0), 50);
        assert.equal(candidateRemaining({ kind: 'daily', amount: 10, days: 3 }, NOW, 0), 37.5);
        assert.equal(candidateRemaining({ kind: 'daily', amount: 10, days: null }, NOW, 0), 107.5, 'no end: to the end of the month');
    });
});

describe('checkDailyMax', () => {
    it('holds a daily budget to the max, and a lifetime budget\'s average a day', () => {
        assert.equal(checkDailyMax({ kind: 'daily', amount: 10, days: 3 }, 10).ok, true);
        assert.equal(checkDailyMax({ kind: 'daily', amount: 10.01, days: 3 }, 10).ok, false);
        assert.equal(checkDailyMax({ kind: 'lifetime', amount: 30, days: 3 }, 10).ok, true);
        const over = checkDailyMax({ kind: 'lifetime', amount: 30.04, days: 3 }, 10);
        assert.equal(over.ok, false);
        assert.equal(!over.ok && over.code, 'OVER_DAILY_MAX');
    });
});

describe('minor units', () => {
    it('EGP, SAR and USD have cents (offset 100); a whole-unit currency has none (offset 1)', () => {
        for (const c of ['EGP', 'SAR', 'USD']) {
            assert.equal(currencyOffset(c), 100);
            assert.equal(toMinorUnits(12.34, c), 1234);
            assert.equal(fromMinorUnits(1234, c), 12.34);
        }
        assert.equal(currencyOffset('JPY'), 1);
        assert.equal(toMinorUnits(500, 'JPY'), 500);
        assert.equal(fromMinorUnits(500, 'jpy'), 500);
    });
});
