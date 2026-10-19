/**
 * The usage ledger: the rate table, the market and period rules, and the one upsert that counts a delivery.
 *
 * `pool.query` is replaced by a recorder, so the SQL's shape and its parameters are what is pinned (a stub cannot prove what Postgres does with
 * `ON CONFLICT`, so the statement is read for the clause that makes counts add up instead of overwrite). No database.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import {
    estimateCost, freeUsed, marketOf, periodOf, periodUsage, projectMonthEnd, RATES_EFFECTIVE, RATES_USD, recordDelivery, wouldBeBillable,
} from './channelUsage.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const PHONE = '106540352242922';

let statements: Array<{ sql: string; params: unknown[] }>;
let answer: (sql: string) => { rows: any[]; rowCount?: number };
const originalQuery = pool.query;

beforeEach(() => {
    statements = [];
    answer = () => ({ rows: [] });
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const r = answer(sql);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
});

describe('the rate table', () => {
    it('is the table effective 2026-10-01, value for value', () => {
        assert.equal(RATES_EFFECTIVE, '2026-10-01');
        assert.deepEqual(RATES_USD.service, { EG: 0.0036, SA: 0.0107, other: 0.0091 });
        assert.deepEqual(RATES_USD.utility, { EG: 0.0036, SA: 0.0107, other: 0.0091 });
        assert.deepEqual(RATES_USD.authentication, { EG: 0.0036, SA: 0.0107, other: 0.0091 });
        assert.deepEqual(RATES_USD.marketing, { EG: 0.0644, SA: 0.0576, other: 0.0392 });
    });

    it('is frozen: nothing can edit a rate at run time', () => {
        assert.throws(() => { (RATES_USD.service as any).EG = 0; }, TypeError);
        assert.throws(() => { (RATES_USD as any).marketing = {}; }, TypeError);
    });
});

describe('marketOf', () => {
    it('reads a BSUID by its country prefix', () => {
        assert.equal(marketOf('EG.13491208655302741918'), 'EG');
        assert.equal(marketOf('SA.1234'), 'SA');
        assert.equal(marketOf('sa.1234'), 'SA', 'a prefix is a country whatever its case');
        assert.equal(marketOf('US.ENT.9988'), 'other');
        assert.equal(marketOf('AE.123'), 'other');
    });

    it('reads a phone number by its calling code, with a plus or 00 tolerated', () => {
        assert.equal(marketOf('201000000000'), 'EG');
        assert.equal(marketOf('+201000000000'), 'EG');
        assert.equal(marketOf('00201000000000'), 'EG');
        assert.equal(marketOf('966501234567'), 'SA');
        assert.equal(marketOf('971501234567'), 'other');
        assert.equal(marketOf('15550253483'), 'other');
    });

    it('is `other` for anything that is neither, rather than guessing', () => {
        for (const v of [null, undefined, '', '   ', 'abc', '12', '20', 'EG', '20abc']) assert.equal(marketOf(v as string), 'other', String(v));
    });
});

describe('periodOf', () => {
    it('is YYYY-MM in UTC', () => {
        assert.equal(periodOf(new Date('2026-10-19T12:00:00Z')), '2026-10');
        assert.equal(periodOf(new Date('2026-01-01T00:00:00Z')), '2026-01');
    });

    it('turns over at midnight UTC, not at the server’s local midnight', () => {
        assert.equal(periodOf(new Date('2026-10-31T23:59:59.999Z')), '2026-10');
        assert.equal(periodOf(new Date('2026-11-01T00:00:00.000Z')), '2026-11');
        assert.equal(periodOf(new Date('2026-12-31T23:30:00-05:00')), '2027-01', '23:30 in New York on the 31st is already January in UTC');
    });
});

describe('estimateCost', () => {
    it('is the category’s rate in the recipient’s market when Meta marked the message billable', () => {
        assert.equal(estimateCost({ category: 'service', market: 'EG', billable: true }), 0.0036);
        assert.equal(estimateCost({ category: 'service', market: 'SA', billable: true }), 0.0107);
        assert.equal(estimateCost({ category: 'utility', market: 'other', billable: true }), 0.0091);
        assert.equal(estimateCost({ category: 'marketing', market: 'EG', billable: true }), 0.0644);
        assert.equal(estimateCost({ category: 'marketing', market: 'SA', billable: true }), 0.0576);
        assert.equal(estimateCost({ category: 'Marketing', market: 'other', billable: true }), 0.0392, 'the category is not case sensitive');
    });

    it('is zero for anything that is not literally billable: a free service message costs nothing', () => {
        for (const billable of [false, null, undefined]) assert.equal(estimateCost({ category: 'marketing', market: 'SA', billable }), 0);
    });

    it('prices a billable category the table does not know at the marketing rate, the highest: over-estimated, never hidden', () => {
        assert.equal(estimateCost({ category: 'marketing_lite', market: 'EG', billable: true }), 0.0644);
        assert.equal(estimateCost({ category: null, market: 'SA', billable: true }), 0.0576);
        assert.equal(estimateCost({ category: 'referral_conversion', market: 'EG', billable: false }), 0);
    });

    it('does not read a category off the prototype', () => {
        assert.equal(estimateCost({ category: 'toString', market: 'EG', billable: true }), 0.0644);
        assert.equal(estimateCost({ category: 'constructor', market: 'EG', billable: true }), 0.0644);
    });
});

describe('wouldBeBillable', () => {
    it('keeps service free while fewer than 1,000 have been delivered, and bills from the 1,001st', () => {
        assert.equal(wouldBeBillable({ category: 'service', freeUsed: 0 }), false);
        assert.equal(wouldBeBillable({ category: 'service', freeUsed: 999 }), false);
        assert.equal(wouldBeBillable({ category: 'service', freeUsed: 1000 }), true);
        assert.equal(wouldBeBillable({ category: 'service', freeUsed: 5000 }), true);
    });

    it('never treats utility, authentication or marketing as inside the free tier', () => {
        for (const category of ['utility', 'authentication', 'marketing']) assert.equal(wouldBeBillable({ category, freeUsed: 0 }), true, category);
    });

    it('assumes a category nobody has priced costs money', () => {
        assert.equal(wouldBeBillable({ category: 'something_new', freeUsed: 0 }), true);
        assert.equal(wouldBeBillable({ category: null, freeUsed: 0 }), true);
    });
});

describe('recordDelivery', () => {
    const delivery = (over: Record<string, unknown> = {}) => ({
        creatorId: CREATOR, phoneNumberId: PHONE, category: 'service', pricingType: 'free_customer_service', billable: false,
        recipient: 'EG.134912', at: new Date('2026-10-19T09:00:00Z'), ...over,
    });

    it('upserts the bucket so concurrent deliveries add up: one row per (creator, number, period, category, type, market)', async () => {
        await recordDelivery(delivery());
        assert.equal(statements.length, 1);
        const { sql, params } = statements[0]!;
        assert.match(sql, /^INSERT INTO channel_usage/);
        assert.match(sql, /ON CONFLICT \(creator_id, platform, external_account_id, period, category, pricing_type, market\) DO UPDATE/);
        assert.match(sql, /delivered = channel_usage\.delivered \+ 1/);
        assert.match(sql, /billable = channel_usage\.billable \+ EXCLUDED\.billable/);
        assert.match(sql, /est_cost_usd = channel_usage\.est_cost_usd \+ EXCLUDED\.est_cost_usd/);
        assert.deepEqual(params, [CREATOR, PHONE, '2026-10', 'service', 'free_customer_service', 'EG', 0, 0]);
    });

    it('counts a billable message with its estimated cost, in the recipient’s market', async () => {
        await recordDelivery(delivery({ category: 'marketing', pricingType: 'regular', billable: true, recipient: 'SA.55' }));
        assert.deepEqual(statements[0]!.params, [CREATOR, PHONE, '2026-10', 'marketing', 'regular', 'SA', 1, 0.0576]);
    });

    it('takes the market from a phone number when that is all there is, and `other` when there is nothing', async () => {
        await recordDelivery(delivery({ recipient: '201000000000' }));
        await recordDelivery(delivery({ recipient: null }));
        assert.equal(statements[0]!.params[5], 'EG');
        assert.equal(statements[1]!.params[5], 'other');
    });

    it('files a status with no pricing under `unknown` instead of refusing the count', async () => {
        await recordDelivery(delivery({ category: null, pricingType: null, billable: null }));
        assert.deepEqual(statements[0]!.params.slice(3, 5), ['unknown', 'unknown']);
        assert.equal(statements[0]!.params[6], 0, 'not billable unless Meta said so');
    });

    it('takes the period from the delivery, so a late webhook lands in the month the message arrived', async () => {
        await recordDelivery(delivery({ at: new Date('2026-09-30T23:59:00Z') }));
        assert.equal(statements[0]!.params[2], '2026-09');
    });

    it('writes through the client it is given, so the count commits with the status that earned it', async () => {
        const seen: string[] = [];
        const tx = { query: async (sql: string) => { seen.push(sql); return { rows: [], rowCount: 0 } as any; } };
        await recordDelivery(delivery(), tx);
        assert.equal(seen.length, 1);
        assert.equal(statements.length, 0, 'the pool was not used');
    });
});

describe('freeUsed and periodUsage', () => {
    it('freeUsed counts delivered service messages for this tenant, number and period', async () => {
        answer = () => ({ rows: [{ n: '37' }] });
        assert.equal(await freeUsed(CREATOR, PHONE, '2026-10'), 37);
        const { sql, params } = statements[0]!;
        assert.match(sql, /SUM\(delivered\)/);
        assert.match(sql, /category = 'service'/);
        assert.match(sql, /creator_id = \$1 AND platform = 'whatsapp' AND external_account_id = \$2 AND period = \$3/);
        assert.deepEqual(params, [CREATOR, PHONE, '2026-10']);
    });

    it('freeUsed is zero for a period with no rows', async () => {
        answer = () => ({ rows: [] });
        assert.equal(await freeUsed(CREATOR, PHONE, '2026-10'), 0);
        answer = () => ({ rows: [{ n: null }] });
        assert.equal(await freeUsed(CREATOR, PHONE, '2026-10'), 0);
    });

    it('periodUsage reads the whole month in one statement and converts the numerics', async () => {
        answer = () => ({ rows: [{ service: '120', billable: '4', cost: '0.0144' }] });
        assert.deepEqual(await periodUsage(CREATOR, PHONE, '2026-10'), { period: '2026-10', serviceDelivered: 120, billable: 4, estCostUsd: 0.0144 });
        assert.equal(statements.length, 1);
        assert.deepEqual(statements[0]!.params, [CREATOR, PHONE, '2026-10']);
    });

    it('periodUsage of an empty period is all zeros', async () => {
        assert.deepEqual(await periodUsage(CREATOR, PHONE, '2026-10'), { period: '2026-10', serviceDelivered: 0, billable: 0, estCostUsd: 0 });
    });
});

describe('projectMonthEnd', () => {
    it('is zero for no spend', () => {
        assert.equal(projectMonthEnd(0, new Date('2026-10-15T00:00:00Z')), 0);
        assert.equal(projectMonthEnd(-1, new Date('2026-10-15T00:00:00Z')), 0);
        assert.equal(projectMonthEnd(Number.NaN, new Date('2026-10-15T00:00:00Z')), 0);
    });

    it('extends the spend so far in a straight line to the end of the month', () => {
        // Day 16 of a 31-day month starts after exactly 15 days: $1.50 so far projects to $3.10.
        assert.equal(projectMonthEnd(1.5, new Date('2026-10-16T00:00:00Z')), 3.1);
    });

    it('never divides by less than a day, so the first hours of a month do not project a fortune', () => {
        assert.equal(projectMonthEnd(0.0036, new Date('2026-10-01T00:05:00Z')), 0.1116, '31 days of one day');
    });

    it('is the spend itself on the last instant of the month', () => {
        assert.equal(projectMonthEnd(2, new Date('2026-10-31T23:59:59.999Z')), 2);
    });
});
