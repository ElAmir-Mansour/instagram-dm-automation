/**
 * Ads, phase A6: the Results tab (`#/ads_results`), the dashboard half (spec 002, T119).
 *
 * The REAL `ads_results.js` (with `ads_campaigns.js` for the shared tab bar, and `charts.js`) in the shared `node:vm` harness, with
 * `GET /api/ads/results` stubbed to a fixture: ten days, the last three provisional, two ads, an Egypt / Saudi split.
 *
 *   - the charts render from the fixture (an SVG and a screen-reader row per day), one measure per chart;
 *   - provisional days are shaded on the chart, marked in its table, and named in a sentence;
 *   - "last updated" is shown; Refresh asks the server to queue a refresh (owner only) and says when it is expected, or when to try again;
 *   - two currencies are two totals strips, never one sum; every spend figure carries the excluding-tax note;
 *   - a comparison by country reads the split; ads, ADS_DISABLED and empty states are calm; nothing says ROAS.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const plain = (markup: unknown): string => text(markup).replace(/[⁦⁧⁨⁩]/g, '');

const DAYS = Array.from({ length: 10 }, (_, i) => `2026-10-${String(10 + i).padStart(2, '0')}`);
const SOON = new Date(Date.now() + 10 * 60_000).toISOString();

function row(day: string, i: number, over: Json = {}): Json {
    return {
        day, id: 'account', key: null, currency: 'EGP', spend: 10 + i, impressions: 1000, reach: null, clicks: 40, linkClicks: 20, conversations: 4,
        firstReplies: 3, leads: 0, follows: null, results: 4, provisional: i >= 7, ...over,
    };
}

function totals(over: Json = {}): Json {
    return {
        spend: 145, impressions: 10000, clicks: 400, linkClicks: 200, conversations: 40, leads: 2, follows: 5, results: 40,
        trackedClicks: { direct: 12, viaChat: 8 }, handoffs: 3, costPerResult: 3.63, costPerConversation: 3.63, costPerLinkClick: 0.73,
        costPerLead: 72.5, costPerFollow: 29, costPerTrackedClick: 7.25, ...over,
    };
}

function answer(over: Json = {}): Json {
    return {
        level: 'account', from: DAYS[0], to: DAYS[9], breakdown: null, currency: 'EGP', currencies: ['EGP'],
        syncedAt: '2026-10-19T06:00:00.000Z', provisionalFrom: DAYS[7], excludesTax: true,
        objects: [{ id: 'account', appId: null, level: 'account', name: null, effectiveStatus: null, resultKind: 'conversations' }],
        rows: DAYS.map((d, i) => row(d, i)),
        appDaily: DAYS.map((d) => ({ day: d, id: 'account', trackedDirect: 1, trackedViaChat: 1, handoffs: 0 })),
        perObject: [{ id: 'account', currency: 'EGP', ...totals() }],
        totals: { byCurrency: { EGP: totals() } },
        appJoins: { trackedClicks: { direct: 12, viaChat: 8 }, handoffs: 3 },
        ...over,
    };
}

const ADS = answer({
    level: 'ad',
    objects: [
        { id: 'ad1', appId: 'a1', level: 'ad', name: 'Reel: spring offer', effectiveStatus: 'ACTIVE', resultKind: 'conversations' },
        { id: 'ad2', appId: 'a2', level: 'ad', name: 'Post: workshop', effectiveStatus: 'PAUSED', resultKind: 'link_clicks' },
    ],
    perObject: [
        { id: 'ad1', currency: 'EGP', ...totals({ spend: 100, trackedClicks: { direct: 9, viaChat: 7 } }) },
        { id: 'ad2', currency: 'EGP', ...totals({ spend: 45, trackedClicks: { direct: 3, viaChat: 1 } }) },
    ],
});

const SPLIT = answer({
    breakdown: 'country',
    rows: DAYS.flatMap((d, i) => [row(d, i, { key: 'EG', spend: 6 }), row(d, i, { key: 'SA', spend: 4 + i })]),
});

interface Setup { results?: (params: Json) => Promise<Json>; api?: Json; canAdminister?: boolean; lang?: 'ar' | 'en' }

async function open(setup: Setup = {}) {
    const toasts: Array<[string, string]> = [];
    const calls: Array<[string, unknown[]]> = [];
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push([name, args]); return fn(...args); };
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const api: Json = {
        token: 't',
        getAdsResults: record('getAdsResults', setup.results ?? (async (p: Json) => clone(p.breakdown ? SPLIT : p.level === 'ad' ? ADS : answer()))),
        getAdsObjects: record('getAdsObjects', async () => ({ items: [{ id: 'c1', metaId: '101', name: 'Spring offer', level: 'campaign' }], syncedAt: null })),
        requestAdsSync: record('requestAdsSync', async () => ({ queued: true, notBefore: SOON })),
        ...(setup.api ?? {}),
    };
    const h = loadDashboard({
        lang: setup.lang ?? 'en',
        files: ['dashboard/js/charts.js', 'dashboard/js/pages/ads_campaigns.js', 'dashboard/js/pages/ads_results.js'],
        globals: {
            API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
            App: { canOperate: () => true, canAdminister: () => setup.canAdminister !== false },
        },
    });
    h.UI.toast = (message: string, type?: unknown) => { toasts.push([String(message), typeof type === 'string' ? type : 'success']); };
    const container = h.el('page-container');
    const page: Json = h.run('AdsResultsPage');
    await page.render();
    await settle();
    return { h, page, container, toasts, calls, screen: (): string => String(container.innerHTML), called: (name: string) => calls.filter(([n]) => n === name) };
}

describe('Results tab: the charts (T119)', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`renders every chart from the stored rows, one point per day (${lang})`, async () => {
            const { h, screen, called } = await open({ lang });
            const html = screen();
            for (const m of ['spend', 'results', 'costPerResult', 'costPerConversation', 'costPerTrackedClick']) {
                const at = html.indexOf(`id="adsres-chart-${m}"`);
                assert.ok(at >= 0, `the ${m} chart`);
                const card = html.slice(at, html.indexOf('</section>', at));
                assert.match(card, /<svg class="chart-line-svg"/, `${m} draws a line`);
                const body = card.slice(card.indexOf('<tbody>'), card.indexOf('</tbody>'));
                assert.equal((body.match(/<tr>/g) ?? []).length, 10, `${m}: one table row per day`);
            }
            assert.ok(text(html).includes(h.t('adsResults.title')));
            // The page asks for its scope and the ads over the same days; never anything that is not the stored copy.
            const params = called('getAdsResults').map(([, args]) => args[0] as Json);
            assert.ok(params.some((p) => p.level === 'account') && params.some((p) => p.level === 'ad'));
            assert.ok(params.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to)));
        });
    }

    it('shades the provisional days, marks them in the table and says from when', async () => {
        const { h, screen } = await open();
        const html = screen();
        const spend = html.slice(html.indexOf('id="adsres-chart-spend"'), html.indexOf('</section>', html.indexOf('id="adsres-chart-spend"')));
        assert.equal((spend.match(/class="chart-line-provisional"/g) ?? []).length, 3, 'three shaded days');
        assert.equal((spend.match(new RegExp(`\\(${h.t('adsResults.provisional.short')}\\)`, 'g')) ?? []).length, 6, 'each marked in the tooltip and the table');
        assert.match(html, /id="adsres-provisional"/);
        assert.ok(plain(html).includes(h.t('adsResults.provisional.note', { day: 'Oct 17' }).replace(/[⁦⁩]/g, '')));
    });

    it('shows "last updated" from the stored copy', async () => {
        const { h, screen } = await open();
        assert.ok(plain(screen()).includes(h.t('ads.camp.updated', { time: '' }).trim()));
    });

    it('says it has never been updated when nothing was synced', async () => {
        const { h, screen } = await open({ results: async (p: Json) => (p.level === 'ad' ? ADS : answer({ syncedAt: null })) });
        assert.ok(text(screen()).includes(h.t('ads.camp.neverSynced')));
    });

    it('a series with no measured cost (no tracked clicks) leaves the day as a gap, not a zero', async () => {
        const { page } = await open({ results: async (p: Json) => (p.level === 'ad' ? ADS : answer({ appDaily: [] })) });
        const series = page.series('costPerTrackedClick') as Json[];
        assert.equal(series.length, 10);
        assert.ok(series.every((pt) => pt.value === null));
    });
});

describe('Results tab: money', () => {
    it('every spend figure carries the excluding-tax note', async () => {
        const { h, screen } = await open();
        const html = screen();
        assert.ok(text(html).includes(h.t('ads.tax.note')), 'the page note');
        assert.match(html, /id="adsres-spend-EGP"[\s\S]*?stat-sub[^>]*>[^<]*Excluding tax/, 'the spend tile');
        for (const m of ['spend', 'costPerResult', 'costPerConversation', 'costPerTrackedClick']) {
            const at = html.indexOf(`id="adsres-chart-${m}"`);
            assert.ok(text(html.slice(at, html.indexOf('</section>', at))).includes(h.t('adsResults.taxShort')), `${m} chart`);
        }
        assert.ok(text(html.slice(html.indexOf('id="adsres-ads"'))).includes(h.t('adsResults.taxShort')), 'the ads table');
    });

    it('two currencies are two totals strips and are never added together', async () => {
        const two = answer({
            currency: null, currencies: ['EGP', 'USD'],
            rows: [...DAYS.map((d, i) => row(d, i)), row(DAYS[9]!, 9, { currency: 'USD', spend: 3 })],
            totals: { byCurrency: { EGP: totals(), USD: totals({ spend: 3, results: 1 }) } },
        });
        const { h, screen } = await open({ results: async (p: Json) => (p.level === 'ad' ? ADS : two) });
        const html = screen();
        assert.match(html, /data-currency="EGP"/);
        assert.match(html, /data-currency="USD"/);
        assert.ok(plain(html).includes('145 EGP') && plain(html).includes('3 USD'));
        assert.equal(plain(html).includes('148'), false, 'never 145 + 3');
        assert.ok(plain(html).includes(h.t('adsResults.currency.note', { shown: 'EGP', others: 'USD' })));
    });
});

describe('Results tab: comparisons and tables', () => {
    it('compares by ad by default, most spend first, with the tracked clicks', async () => {
        const { screen } = await open();
        const compare = screen().slice(screen().indexOf('id="adsres-compare"'));
        assert.ok(plain(compare).indexOf('Reel: spring offer') < plain(compare).indexOf('Post: workshop'));
        assert.match(compare, /class="chart-bars-fill"/);
    });

    it('compare by country reads the stored split and Egypt + Saudi Arabia add up to the total', async () => {
        const { page, screen, called } = await open();
        await page.setCompare({ dataset: { compare: 'country' } });
        await settle();
        assert.ok(called('getAdsResults').some(([, a]) => (a[0] as Json).breakdown === 'country'));
        const items = page.comparison() as Json[];
        assert.deepEqual(JSON.parse(JSON.stringify(items.map((i) => i.key).sort())), ['EG', 'SA']);
        const sum = items.reduce((s, i) => s + i.spend, 0);
        const expected = SPLIT.rows.reduce((s: number, r: Json) => s + r.spend, 0);
        assert.equal(Math.round(sum * 100) / 100, Math.round(expected * 100) / 100);
        assert.match(screen(), /aria-pressed="true"[^>]*>[^<]*Country|id="adsres-compare-country"[^>]*aria-pressed="true"/);
    });

    it('the per-ad table has the app\'s own clicks and hand-offs', async () => {
        const { h, screen } = await open();
        const table = screen().slice(screen().indexOf('id="adsres-ads"'));
        assert.ok(text(table).includes(h.t('adsResults.m.trackedDirect')) && text(table).includes(h.t('adsResults.m.trackedViaChat')));
        assert.match(table, /data-ad="ad1"[\s\S]*?<td>9<\/td>[\s\S]*?<td>7<\/td>/);
    });
});

describe('Results tab: refresh is queued', () => {
    it('the owner asks for a refresh; the page says when it is expected', async () => {
        const { h, page, toasts, called } = await open();
        await page.sync({ disabled: false, dataset: {}, setAttribute() {}, removeAttribute() {}, classList: { add() {}, remove() {} } });
        assert.equal(called('requestAdsSync').length, 1);
        assert.equal(toasts.at(-1)?.[1], 'success');
        assert.ok(toasts.at(-1)?.[0].startsWith(h.t('adsResults.refresh.queuedAt', { time: '' }).split('{')[0]!.trim().slice(0, 10)));
        page.destroy();
    });

    it('429 RATE_LIMITED says when to try again', async () => {
        const err = Object.assign(new Error('limited'), { status: 429, code: 'RATE_LIMITED', body: { retryAt: SOON } });
        const { h, page, toasts } = await open({ api: { requestAdsSync: async () => { throw err; } } });
        await page.sync({ disabled: false, dataset: {}, setAttribute() {}, removeAttribute() {}, classList: { add() {}, remove() {} } });
        assert.equal(toasts.at(-1)?.[1], 'info');
        assert.ok(plain(toasts.at(-1)?.[0]).startsWith(h.t('ads.camp.refreshLimited', { time: '' }).split(' ').slice(0, 2).join(' ')));
    });

    it('only the owner gets the Refresh button', async () => {
        const viewer = await open({ canAdminister: false });
        assert.equal(viewer.screen().includes('data-action="adsres:sync"'), false);
        const owner = await open();
        assert.match(owner.screen(), /data-action="adsres:sync"/);
    });
});

describe('Results tab: calm states', () => {
    it('404 ADS_DISABLED is a calm panel without the tab bar', async () => {
        const err = Object.assign(new Error('off'), { status: 404, code: 'ADS_DISABLED' });
        const { h, screen } = await open({ results: async () => { throw err; } });
        assert.ok(text(screen()).includes(h.t('ads.disabled.title')));
        assert.equal(screen().includes('id="ads-tabs"'), false);
    });

    it('no rows: an empty state, not empty axes', async () => {
        const { h, screen } = await open({ results: async () => answer({ rows: [], appDaily: [], perObject: [], totals: { byCurrency: {} }, currencies: [], currency: null, provisionalFrom: null }) });
        assert.ok(text(screen()).includes(h.t('adsResults.empty.title')));
        assert.equal(screen().includes('chart-line-svg'), false);
    });

    it('the tab bar has Overview, Campaigns and Results, with Results current', async () => {
        const { h, screen } = await open();
        assert.match(screen(), /href="#\/ads_results" aria-current="page"/);
        assert.ok(text(screen()).includes(h.t('ads.tabs.results')));
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`never says ROAS or return on ad spend (${lang})`, async () => {
            const { screen } = await open({ lang });
            assert.doesNotMatch(screen(), /roas|return on ad spend|العائد على الإنفاق/i);
        });
    }
});
