/**
 * Growth's "Paid" series (A6, research R20): what the ads did, day by day, beside the organic numbers on `#/growth`. Read from the ads
 * stored copy through the same `getAdsResults` the Results tab uses (src/services/ads/results.ts), so the two screens cannot disagree, and
 * never from Meta.
 *
 *   - One currency: the ad account's (the stored account check), else the one with the most spend. Rows in any other currency are left out
 *     and named in `otherCurrencies`, because money in two currencies is never added together.
 *   - `results` is each ad's own result (conversations, link clicks, leads or follows, by what it was bought for), summed per day.
 *   - The last three days are `provisional`: Meta restates results for up to 28 days.
 *   - Spend excludes tax; Meta's invoices are the accounting record. There is no sales-based figure: sales happen on another website, which
 *     neither Meta nor the app can see.
 *   - `null` when the window has no ads rows (no ads, ads off, or the ads tables not there yet), so Growth draws no empty card.
 */
import { getAdsResults, type AdsResults } from '../ads/results.js';
import { readHealth } from '../ads/settings.js';
import { isMissingSchema } from '../health.js';
import { describeError, log } from '../../utils/log.js';

export interface PaidDay {
    day: string;
    spend: number;
    results: number | null;
    follows: number | null;
    conversations: number;
    linkClicks: number;
    provisional: boolean;
}

export interface PaidSeries {
    currency: string;
    daily: PaidDay[];
    syncedAt: string | null;
    provisionalFrom: string | null;
    otherCurrencies: string[];
    excludesTax: true;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Pure: the series from an account-level results answer. */
export function buildPaidSeries(results: Pick<AdsResults, 'rows' | 'currencies' | 'syncedAt'>, accountCurrency: string | null): PaidSeries | null {
    if (results.rows.length === 0) return null;
    const spendBy = new Map<string, number>();
    for (const r of results.rows) if (r.currency) spendBy.set(r.currency, (spendBy.get(r.currency) ?? 0) + r.spend);
    const currency = accountCurrency && spendBy.has(accountCurrency)
        ? accountCurrency
        : [...spendBy.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (!currency) return null;

    const byDay = new Map<string, PaidDay>();
    for (const r of results.rows) {
        if (r.currency !== currency) continue;
        let d = byDay.get(r.day);
        if (!d) {
            d = { day: r.day, spend: 0, results: null, follows: null, conversations: 0, linkClicks: 0, provisional: false };
            byDay.set(r.day, d);
        }
        d.spend = round2(d.spend + r.spend);
        if (r.results !== null) d.results = (d.results ?? 0) + r.results;
        if (r.follows !== null) d.follows = (d.follows ?? 0) + r.follows;
        d.conversations += r.conversations;
        d.linkClicks += r.linkClicks;
        d.provisional = d.provisional || r.provisional;
    }
    const daily = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    return {
        currency,
        daily,
        syncedAt: results.syncedAt,
        provisionalFrom: daily.find((d) => d.provisional)?.day ?? null,
        otherCurrencies: [...spendBy.keys()].filter((c) => c !== currency).sort(),
        excludesTax: true,
    };
}

/** The series for the `windowDays` days ending `today`. Never throws: Growth must open whether or not ads work. */
export async function readPaidSeries(creatorId: string, from: string, to: string): Promise<PaidSeries | null> {
    try {
        const [results, health] = await Promise.all([
            getAdsResults(creatorId, { level: 'account', from, to }),
            readHealth(creatorId).catch(() => null),
        ]);
        return buildPaidSeries(results, health?.account?.currency ?? null);
    } catch (err) {
        if (!isMissingSchema(err)) log('warn', 'growth.paid_unreadable', { creator_id: creatorId, ...describeError(err) });
        return null;
    }
}
