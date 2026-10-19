/**
 * Honest numbers on Overview and Analytics (UX overhaul US1, T042, T043, T050; audit OV-03, OV-06, OV-18, OV-20 and the quickstart's
 * false-signals rows 4, 5, 6 and 8).
 *
 * The server now says what became of each DM (src/services/outcomes.ts) and gives an exact comparison for views. These pin what the
 * screens do with it, which a screenshot cannot: that a DM skipped on purpose is never red, that there is ONE success definition,
 * that the Overview strip draws two labelled series and neither is invented, and that the views comparison is the server's.
 *
 * Loaded the way the other dashboard suites load: the REAL shipped files, through `_harness.ts`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const FILES = ['dashboard/js/charts.js', 'dashboard/js/pages/overview.js', 'dashboard/js/pages/analytics.js'];

function load(lang: 'ar' | 'en' = 'en', globals: Record<string, unknown> = {}): Dashboard & { O: Json; A: Json; Charts: Json } {
    const h = loadDashboard({ lang, files: FILES, globals: { Admin: { emptyState: (_i: string, title: string) => `<div class="empty-state">${title}</div>` }, ...globals } });
    return Object.assign(h, { O: h.run('OverviewPage'), A: h.run('AnalyticsPage'), Charts: h.run('Charts') });
}

const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
const ok = (value: unknown) => ({ status: 'fulfilled', value });
const failed = (message: string) => ({ status: 'rejected', reason: new Error(message) });
/** The tags out, the isolates out, the spaces tidy. */
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '').replace(/\s+/g, ' ').trim();
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** One day of the new `/stats/daily`. */
const day = (d: string, over: Json = {}): Json => ({
    day: d, sent: 0, failed: 0, delivered: 0, by_design: 0, actionable: 0, pending: 0, blocked: 0, assistant_replies: 0, ...over,
});
const sevenDays = (rows: Json[] = []): Json[] => Array.from({ length: 7 }, (_, i) => rows[i] ?? day(`2026-10-${String(13 + i).padStart(2, '0')}`));

/** Point the page at a host element for its `data-region`, so a render writes somewhere a test can read. */
function regionHost(h: ReturnType<typeof load>, name: string) {
    const host = h.el(`region:${name}`);
    h.O.region = (n: string) => (n === name ? host : null);
    return host;
}

// ─── The pill ─────────────────────────────────────────────────────────────────────────────────
describe('UI.outcomePill — what became of one DM', () => {
    const h = load();
    const pill = (row: Json): string => String(h.UI.outcomePill(row));

    it('is a glyph, a word and a tone for every outcome, and only "needs you" is red', () => {
        const tones: Record<string, string> = { delivered: 'success', by_design: 'neutral', actionable: 'danger', pending: 'info', blocked: 'neutral' };
        for (const [outcome, tone] of Object.entries(tones)) {
            const out = pill({ outcome });
            assert.ok(out.includes(`data-tone="${tone}"`), `${outcome}: ${tone}`);
            assert.ok(out.includes(`data-status="outcome.${outcome}"`), outcome);
            assert.ok(out.includes(h.t(`status.outcome.${outcome}`)), `${outcome} has its word`);
            assert.match(out, /status-pill-glyph[^>]*aria-hidden="true">[^<]+</, `${outcome} has a glyph`);
        }
        assert.equal(Object.entries(tones).filter(([, tone]) => tone === 'danger').length, 1);
    });

    it('says what it means for the person in the title (and by design says nothing needs doing)', () => {
        assert.ok(pill({ outcome: 'by_design' }).includes(`title="${h.t('status.outcome.by_design.hint')}"`));
        assert.match(h.t('status.outcome.by_design.hint'), /Nothing to do/);
        assert.match(h.t('status.outcome.actionable.hint'), /activity log/);
    });

    it('trusts the server’s outcome over the status the row was written with', () => {
        // The row is FAILED because that is how the comment path writes a DM it chose not to send.
        const row = { status: 'FAILED', outcome: 'by_design', error_log: 'Skipped: recipient already received an automated DM within 24 hours.' };
        assert.equal(h.UI.outcomeOf(row), 'by_design');
        assert.ok(!pill(row).includes('badge-danger'), 'a FAILED row the product chose is not red');
        assert.ok(pill(row).includes('badge-neutral'));
    });

    it('without the server’s word, reads the status, and a FAILED row is never assumed to be fine', () => {
        assert.equal(h.UI.outcomeOf({ status: 'SENT' }), 'delivered');
        assert.equal(h.UI.outcomeOf({ status: 'PENDING' }), 'pending');
        assert.equal(h.UI.outcomeOf({ status: 'USER_BLOCKED_DMS' }), 'blocked');
        assert.equal(h.UI.outcomeOf({ status: 'SKIPPED' }), 'by_design');
        assert.equal(h.UI.outcomeOf({ status: 'FAILED' }), 'actionable');
        assert.equal(h.UI.outcomeOf({ status: 'FAILED', error_log: 'Skipped: hourly DM quota' }), 'actionable', 'the client holds no copy of which failures were expected');
    });

    it('treats anything it does not know as needing a look, and ignores an outcome that is not in the vocabulary', () => {
        for (const row of [{}, null, undefined, { status: 'DONE' }, { status: 7 }, { outcome: 'fine', status: 'FAILED' }, { outcome: '<b>x</b>' }]) {
            assert.equal(h.UI.outcomeOf(row), 'actionable', JSON.stringify(row));
        }
        assert.ok(!pill({ outcome: '<img src=x onerror=alert(1)>' }).includes('<img'), 'nothing from the row reaches the markup');
    });

    it('speaks Arabic with the same shape', () => {
        const ar = load('ar');
        const out = String(ar.UI.outcomePill({ outcome: 'actionable' }));
        assert.ok(out.includes('يحتاج إليك'));
        assert.ok(String(ar.UI.outcomePill({ outcome: 'by_design' })).includes('مقصود'));
    });
});

// ─── T042: the strip ──────────────────────────────────────────────────────────────────────────
describe('Overview strip — two labelled series (quickstart row 6)', () => {
    it('is named "Comment auto-replies" and "Assistant replies", in both languages', () => {
        for (const [lang, comments, assistant] of [
            ['en', 'Comment auto-replies', 'Assistant replies'],
            ['ar', 'الردود الآلية على التعليقات', 'ردود المساعد'],
        ] as const) {
            const h = load(lang);
            const host = regionHost(h, 'charts');
            h.O.renderCharts(ok(sevenDays()));
            const markup = host.innerHTML;
            assert.match(markup, /id="overview-series-comments"/);
            assert.match(markup, /id="overview-series-assistant"/);
            assert.ok(text(markup).includes(comments), `${lang}: ${comments}`);
            assert.ok(text(markup).includes(assistant), `${lang}: ${assistant}`);
            assert.equal(h.t('overview.chart.series.comments'), comments);
            assert.equal(h.t('overview.chart.series.assistant'), assistant);
        }
    });

    it('draws the week the assistant answered people and no comment DM went out: one series at 0, the other not', () => {
        // The audit's row: "DM activity — last 7 days" read all zero while the assistant had replied.
        const h = load();
        const host = regionHost(h, 'charts');
        const rows = sevenDays([0, 1, 2, 3, 4, 5, 6].map((i) => day(`2026-10-${13 + i}`, { assistant_replies: i === 3 ? 4 : i === 5 ? 2 : 0 })));
        h.O.renderCharts(ok(rows));
        const comments = host.innerHTML.slice(host.innerHTML.indexOf('overview-series-comments'), host.innerHTML.indexOf('overview-series-assistant'));
        const assistant = host.innerHTML.slice(host.innerHTML.indexOf('overview-series-assistant'));
        assert.ok(text(comments).includes(h.t('overview.stat.inWeek', { n: '0' })), 'no comment DM went out');
        assert.ok(text(assistant).includes(h.t('overview.stat.inWeek', { n: '6' })), 'the assistant answered six times');
        // Seven cells in each strip; the assistant's has its two busy days filled, in the accent token's fallback.
        assert.equal(count(assistant, '<title>'), 7);
        assert.ok(assistant.includes('Assistant replies'), 'its tooltips name it');
        assert.equal(count(assistant, 'fill="currentColor"'), 2, 'two days with replies');
    });

    it('draws a day’s delivered DMs and a red foot only for what needs the owner', () => {
        const h = load();
        const host = regionHost(h, 'charts');
        h.O.renderCharts(ok(sevenDays([
            day('2026-10-13', { delivered: 5 }),
            day('2026-10-14', { delivered: 2, actionable: 3 }),
            day('2026-10-15', { by_design: 9 }),
        ])));
        const comments = host.innerHTML.slice(host.innerHTML.indexOf('overview-series-comments'), host.innerHTML.indexOf('overview-series-assistant'));
        assert.equal(count(comments, 'fill="#ff3b30"'), 1, 'one red foot: the day with 3 that need the owner');
        // The day with nine skipped on purpose has no red and no colour of its own: it is an empty cell, and the tooltip says why.
        assert.ok(comments.includes('0 Delivered, 0 Needs you, 9 By design'), 'by design is named, neutrally, in the tooltip');
    });

    it('says what the week added up to, with by-design as its own number and never in "need you"', () => {
        const h = load();
        const host = regionHost(h, 'charts');
        h.O.renderCharts(ok(sevenDays([day('2026-10-13', { delivered: 10, actionable: 1, by_design: 4 })])));
        assert.match(host.innerHTML, /id="overview-week-summary"/);
        assert.ok(text(host.innerHTML).includes('7 days: 10 delivered · 1 need you · 4 by design'));
    });

    it('leaves the assistant series out when the answer does not carry it, instead of drawing zeros nobody measured', () => {
        const h = load();
        const host = regionHost(h, 'charts');
        h.O.renderCharts(ok(sevenDays().map(({ assistant_replies, ...rest }) => rest)));
        assert.ok(!host.innerHTML.includes('overview-series-assistant'));
        assert.ok(host.innerHTML.includes('overview-series-comments'));
    });

    it('reads a series without the outcome split as it always did (sent, failed), and does not invent a split', () => {
        const h = load();
        const host = regionHost(h, 'charts');
        h.O.renderCharts(ok([10, 12, 14, 8, 16, 12, 12].map((sent, i) => ({ day: `2026-10-${13 + i}`, sent, failed: i === 6 ? 2 : i === 2 ? 4 : 0 }))));
        assert.ok(text(host.innerHTML).includes('7 days: 84 sent · 6 failed (7%)'));
        assert.ok(!host.innerHTML.includes('overview-series-assistant'));
    });

    it('a failed read is an error line, not a quiet week', () => {
        const h = load();
        const host = regionHost(h, 'charts');
        h.O.renderCharts(failed('down'));
        assert.match(host.innerHTML, /id="overview-strip-unavailable"[^>]*role="status"/);
        assert.ok(text(host.innerHTML).includes(h.t('overview.chart.unavailable')));
        assert.ok(!host.innerHTML.includes(h.t('overview.chart.noActivity')), 'a failed fetch is not "no activity"');
        assert.ok(!host.innerHTML.includes('<svg'));
    });

    it('labels each day as the calendar day it is, whatever the browser’s zone', () => {
        // '2026-10-19' parsed as an instant is the evening of the 18th anywhere west of UTC.
        const h = load();
        assert.equal(h.Charts.dayLabel('2026-10-19'), 'Oct 19');
        assert.equal(h.Charts.dayLabel('2026-01-01'), 'Jan 1');
    });
});

// ─── T042: the recent rows ────────────────────────────────────────────────────────────────────
describe('Overview — recent activity rows show outcome pills (quickstart row 4)', () => {
    const rows = [
        { id: '1', status: 'SENT', outcome: 'delivered', trigger_keyword: 'a', timestamp: '2026-10-19T08:00:00Z', error_log: null },
        { id: '2', status: 'FAILED', outcome: 'by_design', trigger_keyword: 'b', timestamp: '2026-10-19T08:01:00Z', error_log: 'This comment already had its private reply.' },
        { id: '3', status: 'FAILED', outcome: 'actionable', trigger_keyword: 'c', timestamp: '2026-10-19T08:02:00Z', error_log: 'Private Reply Failed: Error validating access token (Code: 190)' },
    ];

    it('a DM that was never sent because the person already had their reply is neutral, and only the real failure is red', () => {
        const h = load();
        const markup = String(h.O.renderRecent(rows));
        const cells = markup.split('<tr>').slice(2);
        assert.equal(cells.length, 3);
        assert.ok(cells[0]!.includes('badge-success'));
        assert.ok(cells[1]!.includes('badge-neutral') && !cells[1]!.includes('badge-danger'), 'by design: neutral');
        assert.ok(cells[2]!.includes('badge-danger'), 'actionable: red');
        assert.equal(count(markup, 'badge-danger'), 1, 'exactly one red pill in the table');
        // The reason still sits under both FAILED rows: the owner can read why, and what to do is in the pill.
        assert.equal(count(markup, 'class="cell-note"'), 2);
    });

    it('every pill has a glyph and a word, so colour is never the only signal', () => {
        const h = load();
        const markup = String(h.O.renderRecent(rows));
        assert.equal(count(markup, 'status-pill-glyph'), 3);
        for (const word of [h.t('status.outcome.delivered'), h.t('status.outcome.by_design'), h.t('status.outcome.actionable')]) {
            assert.ok(text(markup).includes(word), word);
        }
    });
});

// ─── Overview tiles and the briefing ──────────────────────────────────────────────────────────
describe('Overview — "failed" is what needs the owner', () => {
    const ok2 = (v: unknown) => ok(v);

    it('the failed-today tile counts actionable only, and names the by-design ones under it', () => {
        const h = load();
        const rows = sevenDays();
        rows[6] = day('2026-10-19', { delivered: 12, by_design: 3, actionable: 2, failed: 5, sent: 12 });
        rows[5] = day('2026-10-18', { delivered: 4, by_design: 7, actionable: 0, failed: 7, sent: 4 });
        const markup = String(h.O.renderStats({ activeCampaigns: 1 }, ok2(rows), ok2({ data: [] })));
        assert.match(markup, /class="stat-value text-danger" id="stat-failed-today">2</, 'two need the owner today (the legacy count was 5)');
        assert.match(markup, /id="stat-sent-today">12</);
        assert.ok(text(markup).includes(h.t('overview.stat.inWeekByDesign', { n: '2', d: '10' })), '2 in the week, 10 skipped on purpose');
    });

    it('a day of nothing but by-design skips is not red', () => {
        const h = load();
        const rows = sevenDays();
        rows[6] = day('2026-10-19', { by_design: 9, failed: 9 });
        const markup = String(h.O.renderStats({ activeCampaigns: 1 }, ok2(rows), ok2({ data: [] })));
        assert.match(markup, /class="stat-value" id="stat-failed-today">0</, 'zero is not red');
    });

    it('the week-long alert uses the one success definition: skips on purpose do not make a failing week', () => {
        const h = load();
        // 40 delivered, 60 skipped on purpose, none that needs the owner: the old rate was 40% and fired the red alert.
        const rows = sevenDays([day('2026-10-13', { delivered: 40, sent: 40, by_design: 60, failed: 60 })]);
        const alerts = h.O.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), ok({ status: 'valid' }), ok([]), ok({ data: [] }), ok(rows));
        assert.equal(alerts.some((a: Json) => a.icon === 'trending-down'), false, 'no low-success alert');
        // And it still fires for a week that really went badly: 10 delivered, 40 that need the owner.
        const bad = sevenDays([day('2026-10-13', { delivered: 10, sent: 10, actionable: 40, failed: 40 })]);
        const fired = h.O.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), ok({ status: 'valid' }), ok([]), ok({ data: [] }), ok(bad));
        const low = fired.find((a: Json) => a.icon === 'trending-down');
        assert.ok(low, 'a real failing week is still red');
        assert.ok(low.title.includes('20%'), '10 ÷ (10 + 40)');
    });

    it('asks the server for the failures that need the owner, and drops a row that says it is not one', () => {
        const h = load();
        const now = new Date().toISOString();
        const alerts = h.O.buildAlerts({ activeCampaigns: 1 },
            ok({ data: [{ timestamp: now, outcome: 'actionable' }, { timestamp: now, outcome: 'by_design' }, { timestamp: now }], pagination: { total: 3 } }),
            ok({ status: 'valid' }), ok([]), ok({ data: [] }), failed('x'));
        const failedToday = alerts.find((a: Json) => a.icon === 'send-horizontal');
        assert.ok(failedToday);
        assert.equal(failedToday.title, h.t('overview.alert.failedToday', { count: 2 }), 'the by-design row is not counted; a legacy row with no outcome still is');
    });
});

// ─── T050: the views comparison ───────────────────────────────────────────────────────────────
describe('Overview — the views comparison is the server’s (quickstart row 8)', () => {
    const trend = (views: Array<number | null>): Json[] => views.map((v, i) => ({ day: `2026-10-${String(6 + i).padStart(2, '0')}`, views: v, reach: null, followers: null }));

    it('reads kpis.views against previous.views, and is labelled "Last 7 days to yesterday"', () => {
        const h = load();
        // A 14-day trend that the old derivation would have read as 150×6 = 900 against 100×7 = 700 (and, with an unmeasured day,
        // as the famous -92%): none of it is used.
        const wild = trend([100, 100, 100, 100, 100, 100, 100, 1, 1, 1, 1, 1, 1, null]);
        const markup = String(h.O.renderGrowth(
            ok({ kpis: { followers: 500, skip_rate: 30 }, trend: wild }), ok({ settings: {} }),
            ok({ kpis: { views: 840 }, previous: { views: 700, days: 7 } }),
        ));
        assert.match(markup, /id="overview-views"[\s\S]*?class="stat-value">840</);
        assert.ok(text(markup).includes('+20%'), '840 against 700');
        assert.ok(text(markup).includes('Views, last 7 days to yesterday'));
        assert.ok(text(markup).includes(h.t('overview.growth.vsPrev', { n: '700' })));
    });

    it('in Arabic, with the same label', () => {
        const h = load('ar');
        const markup = String(h.O.renderGrowth(
            ok({ kpis: { followers: 500, skip_rate: 30 }, trend: [] }), ok({ settings: {} }),
            ok({ kpis: { views: 840 }, previous: { views: 700 } }),
        ));
        assert.ok(text(markup).includes('المشاهدات، آخر 7 أيام حتى أمس'));
    });

    it('never falls back to summing the daily series: with no server comparison there is no arrow', () => {
        const h = load();
        const huge = trend([5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
        const noPrev = String(h.O.renderGrowth(ok({ kpis: { followers: 500 }, trend: huge }), ok({ settings: {} }),
            ok({ kpis: { views: 300 }, previous: { views: null, days: 7 } })));
        assert.match(noPrev, /id="overview-views"[\s\S]*?class="stat-value">300</);
        assert.ok(!noPrev.includes('stat-trend'), 'no arrow without an exact comparison');
        assert.ok(text(noPrev).includes(h.t('overview.growth.noPrev')));

        const unmeasured = String(h.O.renderGrowth(ok({ kpis: { followers: 500 }, trend: huge }), ok({ settings: {} }),
            ok({ kpis: { views: null }, previous: { views: null } })));
        assert.match(unmeasured, /id="overview-views"[\s\S]*?class="stat-value">—</, 'not measured is a dash, not the 70,000 the series would sum to');
        assert.equal(h.O.sumMeasured, undefined, 'the client derivation is gone');
    });

    it('a zero a week earlier is a plain signed difference, not a percentage of nothing', () => {
        const h = load();
        const markup = String(h.O.renderGrowth(ok({ kpis: { followers: 500 }, trend: [] }), ok({ settings: {} }),
            ok({ kpis: { views: 40 }, previous: { views: 0 } })));
        assert.ok(markup.includes('stat-trend is-up'));
        assert.ok(!text(markup).includes('Infinity') && !text(markup).includes('NaN'));
        assert.ok(text(markup).includes('+40'));
    });

    it('a views read that failed on its own says why under the dash, while the rest of the region still shows', () => {
        const h = load();
        const markup = String(h.O.renderGrowth(ok({ kpis: { followers: 500, skip_rate: 30 }, trend: [] }), ok({ settings: {} }), failed('growth timed out')));
        assert.match(markup, /id="overview-views"[\s\S]*?class="stat-value">—</);
        assert.ok(text(markup).includes(h.t('overview.growth.unavailable', { reason: 'growth timed out' })));
        assert.match(markup, /id="overview-followers"[\s\S]*?class="stat-value">500</);
    });

    it('asks Growth for seven days for the views, and still two weeks for the followers and the skip rate', async () => {
        const calls: Json[] = [];
        const h = load('en');
        const api: Json = {
            getStats: () => Promise.resolve({ activeCampaigns: 1 }),
            getInteractions: () => Promise.resolve({ data: [], pagination: { total: 0 } }),
            getTokenStatus: () => Promise.resolve({ status: 'valid' }),
            getMetaConnection: () => Promise.resolve({}),
            getScheduledPosts: () => Promise.resolve([]),
            getConversations: () => Promise.resolve({ data: [] }),
            getDailyStats: () => Promise.resolve(sevenDays()),
            getGrowthOverview: (days: number) => { calls.push(days); return Promise.resolve({ kpis: { views: 10 }, previous: { views: 5 }, trend: [] }); },
            getGrowthSettings: () => Promise.resolve({ settings: {} }),
            getProfileProgress: () => Promise.reject(new Error('not under test')),
        };
        h.ctx.API = new Proxy(api, { get: (target, prop: string) => (prop === 'token' ? 't' : target[prop] ?? (() => Promise.reject(new Error(`API.${prop} not stubbed`)))) });
        for (const name of ['profile', 'briefing', 'growth', 'stats', 'charts', 'recent', 'busy']) h.el(`region:${name}`);
        const container = h.el('page-container');
        (container as Json).querySelector = (sel: string) => h.dom.get(`region:${(/data-region="([a-z]+)"/.exec(sel) || [])[1]}`) ?? null;
        h.run('OverviewPage').render();
        await settle(20);
        assert.deepEqual(plain(calls).sort((a: number, b: number) => b - a), [14, 7]);
        h.run('OverviewPage').destroy();
    });
});

// ─── T043: Analytics ──────────────────────────────────────────────────────────────────────────
describe('Analytics — one success definition (quickstart row 5)', () => {
    /** Run the page's real render against a stubbed API and return what it wrote. */
    async function renderPage(h: ReturnType<typeof load>, answers: { stats?: Json; daily?: Json; campaigns?: Json; failures?: Json }) {
        const api: Json = {
            getStats: () => Promise.resolve(answers.stats ?? {}),
            getDailyStats: () => Promise.resolve(answers.daily ?? []),
            getCampaignStats: () => Promise.resolve(answers.campaigns ?? []),
            getFailureReasons: () => Promise.resolve(answers.failures ?? { days: 30, total: 0, reasons: [] }),
        };
        h.ctx.API = new Proxy(api, { get: (target, prop: string) => target[prop] ?? (() => Promise.reject(new Error(`API.${prop} not stubbed`))) });
        const container = h.el('page-container');
        h.A.range = 'all';
        await h.A.render();
        await settle();
        return container.innerHTML;
    }

    it('shows the server’s rate, not 58%: skips on purpose are out of it, and it says so', async () => {
        const h = load();
        // 100 rows: 58 delivered, 31 skipped on purpose, 11 that need the owner. The old tile said 58% in red; this one says 84%.
        const page = await renderPage(h, { stats: {
            totalInteractions: 100, sent: 58, failed: 42, successRate: 84, uniqueUsersReached: 90, instagramCount: 60, facebookCount: 40,
            outcomes: { delivered: 58, by_design: 31, actionable: 11, pending: 0, blocked: 0 },
        } });
        assert.match(page, /class="stat-value[^"]*" id="analytics-success-rate">\u206684%\u2069</);
        assert.ok(!/id="analytics-success-rate"[^>]*>[^<]*58/.test(page));
        assert.ok(!/class="stat-value text-danger[^"]*" id="analytics-success-rate"/.test(page), '84 is not a red rate');
        assert.ok(text(page).includes(h.t('analytics.successRate.definition')));
        assert.match(page, /id="analytics-by-design"/);
        assert.ok(text(page).includes(h.t('analytics.successRate.byDesign', { n: '31' })), 'the skipped ones are named, neutral, under the rate');
    });

    it('a rate that really is low is still red (red for real failures only)', async () => {
        const h = load();
        const page = await renderPage(h, { stats: { totalInteractions: 100, successRate: 30, outcomes: { delivered: 30, by_design: 0, actionable: 70, pending: 0, blocked: 0 } } });
        assert.match(page, /class="stat-value text-danger" id="analytics-success-rate">\u206630%\u2069</);
    });

    it('is a dash, not 0%, before anything was attempted', async () => {
        const h = load();
        const page = await renderPage(h, { stats: { totalInteractions: 5, successRate: null, outcomes: { delivered: 0, by_design: 5, actionable: 0, pending: 0, blocked: 0 } } });
        assert.match(page, /id="analytics-success-rate">—</);
        assert.ok(!/class="stat-value text-danger" id="analytics-success-rate"/.test(page), 'no rate is not a red rate');
    });

    it('today’s sub-line counts what needs the owner, not every FAILED row', async () => {
        const h = load();
        const rows = sevenDays();
        rows[6] = day('2026-10-19', { sent: 9, delivered: 9, failed: 8, by_design: 6, actionable: 2 });
        const page = await renderPage(h, { stats: { successRate: 82, outcomes: {} }, daily: rows });
        assert.ok(text(page).includes(h.t('analytics.todaySub', { failed: '2' })), 'two need you; the legacy count was eight');
    });

    it('the 30-day line uses the same definition: delivered ÷ (delivered + needs you), with by-design as its own number', () => {
        const h = load();
        const rows = [day('2026-10-12', { delivered: 40, by_design: 60, actionable: 10 }), day('2026-10-13', { delivered: 10 })];
        const line = h.A.summary30(rows);
        assert.ok(text(line).includes('50 delivered · 10 need you · 60 by design · success 83%'), '50 ÷ (50 + 10)');
        assert.equal(h.A.summary30([day('2026-10-12', { by_design: 4 })]).includes('success —'), true, 'nothing attempted: a dash');
        assert.equal(h.A.summary30([day('2026-10-12')]), '');
    });

    it('draws the 30-day strip from delivered with a red foot for what needs the owner only', () => {
        const h = load();
        const split = h.A.stripOptions([day('2026-10-12', { delivered: 1 })]);
        assert.deepEqual(plain(split).valueKey, 'delivered');
        assert.deepEqual([split.badKey, split.noteKey], ['actionable', 'by_design']);
        const legacy = h.A.stripOptions([{ day: '2026-10-12', sent: 1, failed: 0 }]);
        assert.equal(legacy.valueKey, undefined, 'a series without the split is drawn as it always was');
    });

    it('the campaign table: delivered green, by design neutral, red only where something needs the owner, one rate', () => {
        const h = load();
        const markup = String(h.A.campaignsMarkup([
            { id: 'c1', trigger_keyword: 'promo', total_triggers: 20, sent_count: 12, failed_count: 8, delivered: 12, by_design: 7, actionable: 1, pending: 0, blocked: 0 },
            { id: 'c2', trigger_keyword: 'price', total_triggers: 6, sent_count: 0, failed_count: 6, delivered: 0, by_design: 6, actionable: 0, pending: 0, blocked: 0 },
        ]));
        for (const key of ['status.outcome.delivered', 'status.outcome.by_design', 'status.outcome.actionable']) assert.ok(markup.includes(h.t(key)), key);
        const first = markup.split('<tr>')[2]!;
        const second = markup.split('<tr>')[3]!;
        assert.ok(first.includes('cell-num text-success">12<'), 'delivered is green');
        assert.ok(first.includes('cell-num text-muted">7<'), 'by design is muted, not red');
        assert.ok(first.includes('cell-num text-danger">1<'), 'one needs the owner: red');
        assert.ok(first.includes('92%'), '12 ÷ (12 + 1), not 12 ÷ 20');
        assert.ok(!second.includes('text-danger'), 'a campaign whose six were all skipped on purpose has nothing red');
        assert.ok(second.includes('>—<'), 'and no rate: nothing was attempted');
    });

    it('reads a campaign row without the split as sent / failed, the old numbers', () => {
        const h = load();
        const row = { id: 'c1', trigger_keyword: 'x', total_triggers: 10, sent_count: 9, failed_count: 1 };
        assert.equal(h.A.campaignRate(row), 90);
        assert.equal(h.A.campaignRate({ sent_count: 0, failed_count: 0 }), null);
        assert.equal(h.A.campaignRate({ delivered: 0, by_design: 5, actionable: 0 }), null);
    });

    it('sorts the table by what was delivered', () => {
        const h = load();
        const markup = String(h.A.campaignsMarkup([
            { id: 'a', trigger_keyword: 'few', total_triggers: 30, delivered: 1, by_design: 29, actionable: 0 },
            { id: 'b', trigger_keyword: 'many', total_triggers: 10, delivered: 9, by_design: 0, actionable: 1 },
        ]));
        assert.ok(markup.indexOf('>many<') < markup.indexOf('>few<'));
    });
});

describe('Analytics — "Why DMs fail" groups expected against actionable', () => {
    const summary = {
        days: 30, total: 40, expected_total: 31, actionable_total: 9,
        reasons: [
            { reason_code: 'recipient_cap', count: 20, expected: true, expected_count: 20, sample: 'Skipped: recipient already received an automated DM within 24 hours.', last_at: '2026-10-18T08:00:00.000Z' },
            { reason_code: '190', count: 6, expected: false, expected_count: 0, sample: 'Private Reply Failed: Error validating access token (Code: 190)', last_at: '2026-10-18T09:00:00.000Z' },
            // One reason, two kinds of row: 11 were answered publicly (by design), 3 were not.
            { reason_code: '100', count: 14, expected: false, expected_count: 11, sample: "won't accept a private reply", last_at: '2026-10-18T10:00:00.000Z' },
        ],
    };

    it('puts what the product chose in one group under a neutral pill, and what needs the owner in the other under the red one', () => {
        const h = load();
        const markup = String(h.A.failuresMarkup(summary));
        const needs = markup.slice(markup.indexOf('analytics-failures-actionable'), markup.indexOf('analytics-failures-by-design'));
        const design = markup.slice(markup.indexOf('analytics-failures-by-design'));
        assert.ok(needs.includes('badge-danger') && !needs.includes('badge-neutral'));
        assert.ok(design.includes('badge-neutral') && !design.includes('badge-danger'));
        // The totals are the server's, over every failed DM; the lists are its top reasons.
        assert.match(needs, /failure-group-count">9</);
        assert.match(design, /failure-group-count">31</);
        assert.ok(text(design).includes(h.t('analytics.failures.byDesignNote')));
        assert.ok(text(design).includes(h.t('activity.err.recipientCap')), 'the send cap is in the by-design group');
        assert.ok(text(needs).includes(h.t('activity.err.token')), 'a dead token needs the owner');
    });

    it('a mixed reason is listed under "needs you" with only the part that needs him, and says how many were answered publicly', () => {
        const h = load();
        const markup = String(h.A.failuresMarkup(summary));
        const needs = markup.slice(markup.indexOf('analytics-failures-actionable'), markup.indexOf('analytics-failures-by-design'));
        assert.equal(count(needs, 'class="failure-reason"'), 2, 'the token, and the refusal that was not answered');
        assert.ok(text(needs).includes(h.t('analytics.failures.mixedNote', { n: '11' })));
        assert.match(needs, /failure-reason-count">3</, '14 - 11');
        assert.ok(needs.indexOf('>6<') < needs.indexOf('>3<'), 'most frequent first within the group');
    });

    it('says nothing here needs the owner when every reason was by design, and never shows an empty red group as a problem', () => {
        const h = load();
        const markup = String(h.A.failuresMarkup({ days: 30, total: 20, expected_total: 20, actionable_total: 0, reasons: [summary.reasons[0]] }));
        assert.match(markup, /id="analytics-failures-allclear"/);
        assert.ok(text(markup).includes(h.t('analytics.failures.allClear')));
        assert.match(markup, /id="analytics-failures-actionable"[\s\S]*?failure-group-count">0</);
        assert.equal(count(markup, 'class="failure-reason"'), 1);
    });

    it('with no failures at all, keeps its "none in the last 30 days" line', () => {
        const h = load();
        assert.ok(text(h.A.failuresMarkup({ days: 30, total: 0, reasons: [] })).includes('No failed DMs in the last 30 days.'));
    });

    it('an answer from before the split puts everything under "needs you": no guessing that it was fine', () => {
        const h = load();
        const old = { days: 30, total: 5, reasons: [{ reason_code: 'recipient_cap', count: 5, sample: 'x', last_at: null }] };
        const markup = String(h.A.failuresMarkup(old));
        assert.ok(!markup.includes('analytics-failures-by-design'));
        assert.match(markup, /id="analytics-failures-actionable"[\s\S]*?failure-group-count">5</);
    });

    it('speaks Arabic', () => {
        const h = load('ar');
        const markup = text(h.A.failuresMarkup(summary));
        assert.ok(markup.includes('يحتاج إليك') && markup.includes('مقصود'));
        assert.ok(markup.includes(h.t('analytics.failures.byDesignNote')));
    });
});

// ─── No second copy of the judgement on the client ────────────────────────────────────────────
describe('the dashboard holds no copy of which failures were expected', () => {
    it('neither page, nor the shared pill, names a failure wording or a Meta code to decide an outcome', () => {
        for (const file of ['dashboard/js/pages/overview.js', 'dashboard/js/pages/analytics.js']) {
            const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
            for (const wording of ['already had its private reply', 'already has a reply', 'Skipped: ', 'Replied publicly', '10900']) {
                assert.ok(!source.includes(wording), `${file} must not decide an outcome from "${wording}": the server classifies`);
            }
        }
    });
});
