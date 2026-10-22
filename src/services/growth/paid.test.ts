/**
 * Growth's "Paid" series (A6): one currency, per-day sums, provisional days, null without rows, and a Growth page that opens even when the
 * ads tables are not there yet.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { buildPaidSeries, readPaidSeries } from './paid.js';
import type { ResultsRow } from '../ads/results.js';

function row(day: string, over: Partial<ResultsRow> = {}): ResultsRow {
    return {
        day, id: 'account', key: null, currency: 'EGP', spend: 0, impressions: 0, reach: null, clicks: 0, linkClicks: 0, conversations: 0,
        firstReplies: 0, leads: 0, follows: null, results: null, provisional: false, ...over,
    };
}

describe('buildPaidSeries', () => {
    it('null without rows', () => {
        assert.equal(buildPaidSeries({ rows: [], currencies: [], syncedAt: null }, 'EGP'), null);
    });

    it('one point per day in the account currency, other currencies named and left out', () => {
        const out = buildPaidSeries({
            rows: [
                row('2026-10-01', { spend: 10.1, results: 3, conversations: 3, linkClicks: 5 }),
                row('2026-10-02', { spend: 5.25, results: 1, follows: 2, conversations: 1, provisional: true }),
                row('2026-10-02', { currency: 'USD', spend: 99, results: 7 }),
            ],
            currencies: ['EGP', 'USD'],
            syncedAt: '2026-10-03T06:00:00.000Z',
        }, 'EGP')!;
        assert.equal(out.currency, 'EGP');
        assert.deepEqual(out.otherCurrencies, ['USD']);
        assert.deepEqual(out.daily.map((d) => [d.day, d.spend, d.results, d.follows, d.provisional]), [
            ['2026-10-01', 10.1, 3, null, false],
            ['2026-10-02', 5.25, 1, 2, true],
        ]);
        assert.equal(out.provisionalFrom, '2026-10-02');
        assert.equal(out.excludesTax, true);
        assert.equal(out.syncedAt, '2026-10-03T06:00:00.000Z');
    });

    it('without a stored account currency, the currency with the most spend wins', () => {
        const out = buildPaidSeries({ rows: [row('2026-10-01', { spend: 1 }), row('2026-10-01', { currency: 'USD', spend: 9 })], currencies: ['EGP', 'USD'], syncedAt: null }, null)!;
        assert.equal(out.currency, 'USD');
        assert.deepEqual(out.otherCurrencies, ['EGP']);
    });

    it('never says ROAS or anything sales-based', () => {
        const out = buildPaidSeries({ rows: [row('2026-10-01', { spend: 1 })], currencies: ['EGP'], syncedAt: null }, 'EGP');
        assert.doesNotMatch(JSON.stringify(out), /roas|revenue|purchase|sales/i);
    });
});

describe('readPaidSeries', () => {
    const original = { query: pool.query, connect: pool.connect };
    let fail: Error | null = null;
    beforeEach(() => {
        const run = async (sql: string) => {
            if (fail && /ads_/.test(sql)) throw fail;
            return { rows: [], rowCount: 0 };
        };
        (pool as any).query = run;
        (pool as any).connect = async () => ({ query: run, release() {} });
    });
    afterEach(() => {
        (pool as any).query = original.query;
        (pool as any).connect = original.connect;
        fail = null;
    });

    it('null when nothing is stored', async () => {
        assert.equal(await readPaidSeries('11111111-1111-4111-8111-111111111111', '2026-10-01', '2026-10-28'), null);
    });

    it('null, not a throw, when the ads tables are missing or the read fails', async () => {
        fail = Object.assign(new Error('relation "ads_insights_daily" does not exist'), { code: '42P01' });
        assert.equal(await readPaidSeries('11111111-1111-4111-8111-111111111111', '2026-10-01', '2026-10-28'), null);
        fail = new Error('boom');
        assert.equal(await readPaidSeries('11111111-1111-4111-8111-111111111111', '2026-10-01', '2026-10-28'), null);
    });
});
