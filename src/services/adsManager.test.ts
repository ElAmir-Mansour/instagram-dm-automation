/**
 * The Ads screen's pure parts: where a campaign's budget lives, the most it can still spend this month, the worst-case cap check, and
 * the account's status and payment method as Meta reports them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { campaignBudget, campaignInsights, checkWorstCase, daysLeftThisMonth, oneDayRemaining, remainingThisMonth, shouldPauseAll, type RawCampaign } from './adsCap.js';
import { accountStatusLabel, billingUrl, readAccountState } from './metaAds.js';

const NOW = new Date('2026-10-22T10:00:00Z');

describe('campaignBudget: where an edit writes to', () => {
    it('a campaign budget is edited on the campaign', () => {
        assert.deepEqual(campaignBudget({ id: '111111', daily_budget: '1500' }, 'USD'),
            { kind: 'daily', amount: 15, level: 'campaign', holderId: '111111', adsetId: null, editable: true });
        assert.equal(campaignBudget({ id: '111111', lifetime_budget: '5000' }, 'USD').kind, 'lifetime');
    });

    it('a single ad set (every boost) is edited on the ad set', () => {
        const b = campaignBudget({ id: '111111', adsets: { data: [{ id: '222222', lifetime_budget: '1500' }] } }, 'USD');
        assert.deepEqual(b, { kind: 'lifetime', amount: 15, level: 'adset', holderId: '222222', adsetId: '222222', editable: true });
    });

    it('several ad sets with their own budgets are shown, not edited', () => {
        const b = campaignBudget({ id: '111111', adsets: { data: [{ id: '2', daily_budget: '100' }, { id: '3', daily_budget: '200' }] } }, 'USD');
        assert.equal(b.kind, 'none');
        assert.equal(b.editable, false);
    });

    it('a whole-unit currency is not divided by 100', () => {
        assert.equal(campaignBudget({ id: '111111', daily_budget: '500' }, 'JPY').amount, 500);
    });
});

describe('daysLeftThisMonth', () => {
    it('counts the days begun until the month ends, or the window does', () => {
        assert.equal(daysLeftThisMonth(null, null, NOW), 10, 'Oct 22 10:00 → Nov 1: 9 days 14 hours, rounded up');
        assert.equal(daysLeftThisMonth(null, new Date('2026-10-25T10:00:00Z'), NOW), 3);
        assert.equal(daysLeftThisMonth(new Date('2026-10-30T00:00:00Z'), null, NOW), 2, 'a window starting later counts from its start');
        assert.equal(daysLeftThisMonth(null, new Date('2026-10-20T00:00:00Z'), NOW), 0, 'ended');
        assert.equal(daysLeftThisMonth(new Date('2026-11-05T00:00:00Z'), null, NOW), 0, 'starts next month');
    });
});

describe('remainingThisMonth: the most a campaign can still spend this month', () => {
    it('a daily budget × the days left in its window this month, today at 1.75× (Meta may overspend a day by 75%)', () => {
        assert.equal(remainingThisMonth({ id: '1', daily_budget: '500' }, 'USD', 0, NOW), 53.75);
        assert.equal(remainingThisMonth({ id: '1', daily_budget: '500', stop_time: '2026-10-25T10:00:00Z' }, 'USD', 0, NOW), 18.75);
    });

    it("a lifetime budget's unspent part, and nothing once it has ended", () => {
        assert.equal(remainingThisMonth({ id: '1', lifetime_budget: '3000' }, 'USD', 12.5, NOW), 17.5);
        assert.equal(remainingThisMonth({ id: '1', lifetime_budget: '3000', stop_time: '2026-10-01T00:00:00Z' }, 'USD', 0, NOW), 0);
    });

    it('a boost: its one ad set, with the campaign spend set against it', () => {
        const boost: RawCampaign = { id: '1', adsets: { data: [{ id: '2', status: 'ACTIVE', lifetime_budget: '1500', end_time: '2026-10-25T10:00:00Z' }] } };
        assert.equal(remainingThisMonth(boost, 'USD', 4, NOW), 11);
    });

    it('several ad sets add up; paused ones count nothing', () => {
        const c: RawCampaign = { id: '1', adsets: { data: [
            { id: '2', status: 'ACTIVE', daily_budget: '100' },
            { id: '3', status: 'ACTIVE', daily_budget: '200' },
            { id: '4', status: 'PAUSED', daily_budget: '9900' },
        ] } };
        assert.equal(remainingThisMonth(c, 'USD', 0, NOW), 32.25, '(1 + 2) × (1.75 + 9 days)');
    });
});

describe('checkWorstCase: the cap for campaigns made anywhere', () => {
    it('fits when spent + the others + this one is at most the cap', () => {
        assert.deepEqual(checkWorstCase({ spentThisMonth: 40, othersRemaining: 30, thisRemaining: 30, monthlyCap: 100 }), { ok: true, worstCase: 100 });
    });

    it('refuses a cent over, and says what is left for this one', () => {
        const c = checkWorstCase({ spentThisMonth: 40, othersRemaining: 30, thisRemaining: 30.01, monthlyCap: 100 });
        assert.deepEqual(c, { ok: false, worstCase: 100.01, left: 30 });
    });

    it('leaves nothing when the month is already over the cap', () => {
        const c = checkWorstCase({ spentThisMonth: 120, othersRemaining: 0, thisRemaining: 1, monthlyCap: 100 });
        assert.equal(c.ok, false);
        assert.equal(!c.ok && c.left, 0);
    });
});

describe('campaignInsights', () => {
    it("reads lifetime insights, with the objective's own result", () => {
        const c: RawCampaign = { id: '1', objective: 'OUTCOME_TRAFFIC', insights: { data: [{ spend: '3.2', reach: '100', impressions: '150', clicks: '9', actions: [{ action_type: 'link_click', value: '7' }] }] } };
        assert.equal(campaignInsights(c)?.results, 7);
        assert.equal(campaignInsights(c)?.spend, 3.2);
    });

    it('gives no result number for an objective Boost does not use', () => {
        const c: RawCampaign = { id: '1', objective: 'OUTCOME_SALES', insights: { data: [{ spend: '1', reach: '50' }] } };
        assert.equal(campaignInsights(c)?.results, 0);
        assert.equal(campaignInsights({ id: '1' }), null);
    });
});

describe('the account: status and payment method', () => {
    it('names the statuses', () => {
        assert.equal(accountStatusLabel(1), 'active');
        assert.equal(accountStatusLabel(2), 'disabled');
        assert.equal(accountStatusLabel(3), 'unsettled');
        assert.equal(accountStatusLabel(101), 'closed');
        assert.equal(accountStatusLabel(null), 'other');
    });

    it('no funding source is "no payment method"; a card is shown by Meta\'s own string', () => {
        const none = readAccountState('509787248064459', { name: 'Shop', currency: 'USD', account_status: 1, min_daily_budget: 100, funding_source: null }, true);
        assert.equal(none.hasPaymentMethod, false);
        assert.equal(none.minDailyBudget, 1);
        assert.equal(none.billingUrl, billingUrl('509787248064459'));
        const card = readAccountState('509787248064459', { currency: 'USD', account_status: 1, funding_source: '123456', funding_source_details: { display_string: 'Visa *1234' } }, true);
        assert.equal(card.hasPaymentMethod, true);
        assert.equal(card.paymentMethod, 'Visa *1234');
    });

    it('says "unknown", never "none", when the billing fields could not be read or were left out', () => {
        assert.equal(readAccountState('509787248064459', { currency: 'USD', account_status: 1 }, false).hasPaymentMethod, null);
        assert.equal(readAccountState('509787248064459', { currency: 'USD', account_status: 1 }, true).hasPaymentMethod, null, 'asked, but Meta left the field out');
    });

    it("reads the account's timezone offset, and ignores nonsense", () => {
        assert.equal(readAccountState('1', { currency: 'USD', timezone_offset_hours_utc: 3 }, true).timezoneOffsetHours, 3);
        assert.equal(readAccountState('1', { currency: 'USD', timezone_offset_hours_utc: 99 }, true).timezoneOffsetHours, 0);
    });

    it('reads a disable reason', () => {
        assert.equal(readAccountState('1', { currency: 'USD', account_status: 2, disable_reason: 3 }, true).disableReason, 'Payment risk');
    });

    it('links to Meta\'s billing page for the account', () => {
        assert.equal(billingUrl('509787248064459'), 'https://business.facebook.com/billing_hub/payment_settings/?asset_id=509787248064459');
    });
});

describe('the account month', () => {
    it("ends at midnight in the ad account's timezone, not UTC", () => {
        // 22:00 UTC on Oct 31 is already Nov 1 in Riyadh (UTC+3): the account's month has 30 days left, not a few hours.
        const lateOct = new Date('2026-10-31T22:00:00Z');
        assert.equal(daysLeftThisMonth(null, null, lateOct, 0), 1, 'UTC: two hours of October left, counted as a day');
        assert.equal(daysLeftThisMonth(null, null, lateOct, 3), 30, 'Riyadh: November has begun, 30 days');
    });
});

describe('oneDayRemaining and shouldPauseAll: the hourly guard', () => {
    it('counts one day of a daily budget at 1.75×, even on the last day of the month', () => {
        assert.equal(oneDayRemaining({ id: '1', daily_budget: '500' }, 'USD', 0, new Date('2026-10-31T23:30:00Z')), 8.75);
    });

    it("counts a lifetime budget's whole unspent part, and nothing for an ended window", () => {
        assert.equal(oneDayRemaining({ id: '1', lifetime_budget: '3000' }, 'USD', 10, NOW), 20);
        assert.equal(oneDayRemaining({ id: '1', daily_budget: '500', stop_time: '2026-10-01T00:00:00Z' }, 'USD', 0, NOW), 0);
    });

    it('pauses everything once the month reaches the cap, or today could pass it', () => {
        assert.equal(shouldPauseAll({ spentThisMonth: 100, nextDayRemaining: 0, monthlyCap: 100 }), true, 'reached');
        assert.equal(shouldPauseAll({ spentThisMonth: 95, nextDayRemaining: 5.01, monthlyCap: 100 }), true, 'today could pass it');
        assert.equal(shouldPauseAll({ spentThisMonth: 95, nextDayRemaining: 5, monthlyCap: 100 }), false, 'exactly fits');
    });
});

describe('remainingThisMonth: a paused ad set does not shrink the running one', () => {
    it("sets the campaign's spend against the ad set only when it is the campaign's ONLY ad set", () => {
        const c: RawCampaign = { id: '1', adsets: { data: [
            { id: '2', status: 'ACTIVE', lifetime_budget: '2000' },
            { id: '3', status: 'PAUSED', lifetime_budget: '9000' },
        ] } };
        assert.equal(remainingThisMonth(c, 'USD', 15, NOW), 20, 'the paused sibling\'s spend is not subtracted from the running one');
    });
});
