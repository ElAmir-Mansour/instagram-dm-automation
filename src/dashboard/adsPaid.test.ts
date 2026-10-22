/**
 * Ads, phase A6: paid results beside organic ones (spec 002, T123, FR-043).
 *
 *   - Growth: the "Paid (ads)" card from `overview.paid` — its own chart (never a second axis on the organic trend), the totals, the
 *     excluding-tax note, the provisional days, the currencies it leaves out; and no card at all without ads data.
 *   - Results (`#/analytics`): ad rows under the DM campaigns, each labelled "Ad", most spend first; hidden (and silent) when the ads read
 *     fails, so the DM campaigns are never touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const plain = (markup: unknown): string => text(markup).replace(/[⁦⁧⁨⁩]/g, '');

const PAID = {
    currency: 'EGP',
    daily: [
        { day: '2026-10-10', spend: 10, results: 3, follows: 1, conversations: 3, linkClicks: 5, provisional: false },
        { day: '2026-10-11', spend: 12.5, results: 4, follows: null, conversations: 4, linkClicks: 6, provisional: false },
        { day: '2026-10-13', spend: 8, results: 2, follows: 2, conversations: 2, linkClicks: 1, provisional: true },
    ],
    syncedAt: '2026-10-13T06:00:00.000Z', provisionalFrom: '2026-10-13', otherCurrencies: ['USD'], excludesTax: true,
};

function growth(lang: 'ar' | 'en' = 'en') {
    const h = loadDashboard({ lang, files: ['dashboard/js/charts.js', 'dashboard/js/pages/growth.js'] });
    return { h, page: h.run('GrowthPage') as Json };
}

describe('Growth: the paid series (T123)', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`draws its own card from overview.paid: spend per day, totals, tax note, provisional day, left-out currencies (${lang})`, () => {
            const { h, page } = growth(lang);
            page.overview = { paid: PAID };
            const html = String(page.paidMarkup());
            assert.match(html, /id="growth-paid"/);
            assert.match(html, /<svg class="chart-line-svg"/);
            const body = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
            assert.equal((body.match(/<tr>/g) ?? []).length, 4, 'one row per day from the first to the last, the missing day a gap');
            assert.match(body, /—/, 'the missing day is a gap, not a zero');
            assert.equal((html.match(/class="chart-line-provisional"/g) ?? []).length, 1);
            assert.ok(text(html).includes(h.t('ads.tax.note')));
            assert.match(html, /id="growth-paid-provisional"/);
            assert.ok(plain(html).includes('30.5 EGP'), 'the period spend');
            assert.ok(text(html).includes(h.t('growth.paid.otherCurrencies', { currencies: 'USD' })));
            assert.match(html, /href="#\/ads_results"/);
            assert.doesNotMatch(html, /roas|return on ad spend|العائد على الإنفاق/i);
        });
    }

    it('no ads data: no card at all', () => {
        const { page } = growth();
        for (const overview of [{ paid: null }, {}, { paid: { currency: 'EGP', daily: [] } }, null]) {
            page.overview = overview;
            assert.equal(String(page.paidMarkup()), '');
        }
    });

    it('sits in the summary after the organic trend, as a separate chart', () => {
        const { page } = growth();
        page.overview = { paid: PAID, trend: [], kpis: {} };
        page.showsSkeleton = () => false;
        const html = String(page.summaryMarkup());
        assert.ok(html.indexOf('id="growth-trend"') >= 0 && html.indexOf('id="growth-paid"') > html.indexOf('id="growth-trend"'));
    });
});

const ADS = {
    objects: [
        { id: 'ad1', name: 'Reel: spring offer', effectiveStatus: 'ACTIVE' },
        { id: 'ad2', name: 'Post: workshop', effectiveStatus: 'PAUSED' },
        { id: 'ad3', name: 'Old idle ad', effectiveStatus: 'PAUSED' },
        { id: 'ad4', name: 'New, nothing yet', effectiveStatus: 'ACTIVE' },
    ],
    perObject: [
        { id: 'ad2', currency: 'EGP', spend: 45, conversations: 2, trackedClicks: { direct: 3, viaChat: 1 }, handoffs: 0 },
        { id: 'ad1', currency: 'EGP', spend: 100, conversations: 9, trackedClicks: { direct: 9, viaChat: 7 }, handoffs: 2 },
        { id: 'ad3', currency: 'EGP', spend: 0, conversations: 0, trackedClicks: { direct: 0, viaChat: 0 }, handoffs: 0 },
        { id: 'ad4', currency: 'EGP', spend: 0, conversations: 0, trackedClicks: { direct: 0, viaChat: 0 }, handoffs: 0 },
    ],
};

function analytics(getAdsResults: (p: Json) => Promise<Json>) {
    const calls: Json[] = [];
    const h = loadDashboard({
        lang: 'en',
        files: ['dashboard/js/charts.js', 'dashboard/js/pages/analytics.js'],
        globals: { API: { getAdsResults: (p: Json) => { calls.push(p); return getAdsResults(p); } } },
    });
    const host = h.el('analytics-ad-rows');
    host.hidden = true;
    return { h, page: h.run('AnalyticsPage') as Json, host, calls };
}

describe('Results: ad rows labelled "Ad" (T123)', () => {
    it('lists the running or spending ads, most spend first, each with the Ad badge and the app\'s own figures', async () => {
        const { h, page, host, calls } = analytics(async () => ADS);
        await page.fillAdRows(28, () => true);
        await settle();
        assert.equal(host.hidden, false);
        const html = String(host.innerHTML);
        assert.equal((html.match(/data-ad="/g) ?? []).length, 3, 'the idle paused ad is left out; the running one with no spend stays');
        assert.ok(html.indexOf('data-ad="ad1"') < html.indexOf('data-ad="ad2"'), 'most spend first');
        assert.equal((html.match(new RegExp(`class="badge badge-info analytics-ad-badge">${h.t('analytics.adRow.badge')}<`, 'g')) ?? []).length, 3);
        assert.match(html, /data-ad="ad1"[\s\S]*?100 EGP[\s\S]*?>9<[\s\S]*?>16<[\s\S]*?>2</);
        assert.ok(text(html).includes(h.t('ads.tax.note')));
        assert.equal(calls[0].level, 'ad');
        assert.match(calls[0].from, /^\d{4}-\d{2}-\d{2}$/);
        assert.doesNotMatch(html, /roas|return on ad spend/i);
    });

    for (const [name, fail] of [['403', 403], ['404 ADS_DISABLED', 404], ['a network failure', 0]] as const) {
        it(`${name}: the rows stay hidden, silently`, async () => {
            const { page, host } = analytics(async () => { throw Object.assign(new Error('no'), { status: fail || undefined }); });
            await page.fillAdRows(7, () => true);
            assert.equal(host.hidden, true);
            assert.equal(String(host.innerHTML ?? ''), '');
        });
    }

    it('no ads in the window: hidden', async () => {
        const { page, host } = analytics(async () => ({ objects: [], perObject: [] }));
        await page.fillAdRows(7, () => true);
        assert.equal(host.hidden, true);
    });

    it('a slow answer that lands after the page moved on paints nothing', async () => {
        const { page, host } = analytics(async () => ADS);
        await page.fillAdRows(7, () => false);
        assert.equal(host.hidden, true);
    });
});
