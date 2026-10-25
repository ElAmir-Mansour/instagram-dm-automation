/**
 * The SVG chart builders.
 *
 * These exist because Chart.js could not be tested. A canvas render is opaque — there is
 * nothing to assert about it — so the old charts had zero coverage and their two worst
 * properties went unnoticed for as long as they shipped: a two-point line chart labelled
 * "last 7 days", and a `<canvas>` that told a screen reader only that a chart existed.
 *
 * Every builder here is pure: data in, SVG string out. So the geometry, the empty states, the
 * RTL ordering, the accessibility table and the escaping are all assertable, and each of the
 * rules below is one the old charts broke.
 *
 * Loaded the same way as escaping.test.ts: the REAL dashboard files in a `node:vm` context,
 * so these test what ships rather than a copy.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

interface Loaded {
    Charts: {
        dayStrip: (days: unknown[], opts?: Record<string, unknown>) => { toString(): string };
        splitBar: (parts: unknown[], opts?: Record<string, unknown>) => { toString(): string };
        sparkline: (values: number[], opts?: Record<string, unknown>) => { toString(): string };
        dayLabel: (day: unknown) => string;
    };
    setRtl: (on: boolean) => void;
}

function load(): Loaded {
    const noop = (): void => {};
    const stubEl = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [],
        querySelector: () => null, appendChild: noop, setAttribute: noop,
        getAttribute: () => null, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [],
    };
    let rtl = false;
    const ctx: Record<string, unknown> = {
        document: {
            ...stubEl,
            createElement: () => ({ ...stubEl }),
            body: { ...stubEl }, head: { ...stubEl },
            documentElement: { ...stubEl, lang: 'en', dir: 'ltr' },
            getElementById: () => null, activeElement: null,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        Intl, console, setTimeout, clearTimeout,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: 'en' },
        // Charts reads colour tokens through getComputedStyle. In jsdom-less Node there is no
        // cascade, so this returns '' and every builder falls back to the literal it was
        // given — which is itself worth asserting: a chart must still draw when a token is
        // unreadable rather than emitting `fill=""`.
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    for (const f of ['dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/charts.js']) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    // I18N.isRtl is what the strip consults; override it rather than mutating language state.
    vm.runInContext('I18N.isRtl = () => globalThis.__rtl === true;', ctx);
    // English, so a label can be asserted by what it says ("Oct 19"); direction is `isRtl`'s, set above, not the language's.
    vm.runInContext("I18N.lang = 'en';", ctx);
    const Charts = vm.runInContext('Charts', ctx) as Loaded['Charts'];
    return {
        Charts,
        setRtl: (on: boolean) => { (ctx as Record<string, unknown>)['__rtl'] = on; rtl = on; void rtl; },
    };
}

const { Charts, setRtl } = load();
const s = (v: { toString(): string }): string => String(v);
const DAYS = [
    { day: '2026-09-19', sent: 0, failed: 0 },
    { day: '2026-09-20', sent: 5, failed: 0 },
    { day: '2026-09-21', sent: 2, failed: 3 },
];

describe('dayStrip', () => {
    it('draws one cell per day', () => {
        const out = s(Charts.dayStrip(DAYS, { label: 'Activity' }));
        // Three days: three cell rects, plus one foot rect for the day that had failures.
        assert.equal((out.match(/<rect /g) || []).length, 4);
    });

    it('shows an empty day as an empty cell, not as nothing', () => {
        // The whole reason this replaced a line chart: a gap has to be visible. A zero day
        // gets the neutral fill at FULL opacity so it reads as "nothing happened", where an
        // interpolated line would have drawn straight through it.
        const out = s(Charts.dayStrip(DAYS));
        assert.match(out, /fill-opacity="1"/);
    });

    it('never renders a day with activity invisibly', () => {
        // A single event on a busy peak would otherwise compute to a near-zero opacity.
        const out = s(Charts.dayStrip([
            { day: 'a', sent: 1, failed: 0 },
            { day: 'b', sent: 400, failed: 0 },
        ]));
        const opacities = [...out.matchAll(/fill-opacity="([0-9.]+)"/g)].map((m) => Number(m[1]));
        const active = opacities.filter((o) => o < 1);
        assert.ok(active.length > 0, 'expected a scaled cell');
        assert.ok(Math.min(...active) >= 0.28, `floor breached: ${Math.min(...active)}`);
    });

    it('reverses cell order in RTL so the latest day is at the reading edge', () => {
        // SVG does not mirror with `dir`, so this has to be explicit. Getting it wrong puts
        // "most recent" at the wrong end for every Arabic user, silently.
        setRtl(false);
        const ltr = s(Charts.dayStrip(DAYS));
        setRtl(true);
        const rtl = s(Charts.dayStrip(DAYS));
        setRtl(false);
        // The rightmost cell has the largest x. In LTR that is the last day (2 sent, 3
        // failed -> has a foot rect); in RTL it must be the first day (0,0 -> no foot).
        assert.notEqual(ltr, rtl, 'RTL output must differ from LTR');
        const lastX = (out: string): number => Math.max(...[...out.matchAll(/<rect x="(\d+)"/g)].map((m) => Number(m[1])));
        assert.equal(lastX(ltr), lastX(rtl), 'same geometry, different order');
    });

    it('emits a screen-reader table of the real numbers', () => {
        // What a <canvas> could not do. The old chart's aria-label named the chart and said
        // nothing about its contents.
        const out = s(Charts.dayStrip(DAYS, { label: 'Activity', sentHeader: 'Sent', failedHeader: 'Failed' }));
        assert.match(out, /class="sr-only"/);
        assert.match(out, /<caption>Activity<\/caption>/);
        assert.match(out, /Sent/);
        assert.ok(out.includes('>5<') || out.includes('>5</td>'), 'the value 5 should appear in the table');
    });

    it('says there is nothing rather than drawing empty axes', () => {
        const out = s(Charts.dayStrip([], { emptyMessage: 'No activity in this period.' }));
        assert.match(out, /No activity in this period\./);
        assert.ok(!out.includes('<svg'), 'no chart should be drawn');
    });

    it('survives a missing colour token instead of emitting an empty fill', () => {
        const out = s(Charts.dayStrip(DAYS));
        assert.ok(!out.includes('fill=""'), 'a fallback literal must be used');
    });

    it('caps its own width instead of stretching a handful of cells to fill the card', () => {
        // The regression this guards: /api/stats/daily used to return a row only for a day
        // that had activity, so a week with two real days sent dayStrip an array of length 2.
        // preserveAspectRatio="none" then stretched those two cells to fill the whole card —
        // two giant pills instead of seven modest cells. The endpoint now zero-fills every
        // day, but the cap stays as the thing that makes a short array safe regardless.
        const sparse = s(Charts.dayStrip([
            { day: '2026-09-20', sent: 5, failed: 0 },
            { day: '2026-09-21', sent: 2, failed: 3 },
        ]));
        const maxWidth = Number(sparse.match(/max-width:(\d+)px/)?.[1]);
        assert.ok(Number.isFinite(maxWidth), 'expected a max-width style on the strip');
        // Proportional to cell count, not a flat cap — seven cells must be allowed more room
        // than two, or a full week would be squeezed as tightly as a two-day stub.
        const full = s(Charts.dayStrip(DAYS));
        const maxWidthFull = Number(full.match(/max-width:(\d+)px/)?.[1]);
        assert.ok(maxWidth < maxWidthFull, `2-cell cap (${maxWidth}) should be smaller than 3-cell cap (${maxWidthFull})`);
    });
});

describe('dayStrip — any series, and a calendar day is a calendar day (US1 T042)', () => {
    const SPLIT = [
        { day: '2026-10-17', delivered: 0, actionable: 0, by_design: 0, assistant_replies: 0 },
        { day: '2026-10-18', delivered: 6, actionable: 0, by_design: 4, assistant_replies: 2 },
        { day: '2026-10-19', delivered: 2, actionable: 3, by_design: 0, assistant_replies: 0 },
    ];

    it('draws the column it is told to, with a red foot only for the column it is told is bad', () => {
        const out = s(Charts.dayStrip(SPLIT, { valueKey: 'delivered', badKey: 'actionable', noteKey: 'by_design' }));
        // Three cells; one foot rect (the day with 3 that need the owner). The 4 skipped on purpose draw nothing red.
        assert.equal((out.match(/<rect /g) || []).length, 4);
        assert.equal((out.match(/fill="#ff3b30"/g) || []).length, 1);
    });

    it('names the neutral count in the tooltip and the screen-reader table, and draws it nowhere', () => {
        const out = s(Charts.dayStrip(SPLIT, {
            valueKey: 'delivered', badKey: 'actionable', noteKey: 'by_design',
            valueHeader: 'Delivered', badHeader: 'Needs you', noteHeader: 'By design', dayHeader: 'Day', label: 'Replies',
        }));
        assert.match(out, /<title>Oct 18: 6 Delivered, 0 Needs you, 4 By design<\/title>/);
        assert.match(out, /<th scope="col">Delivered<\/th><th scope="col">Needs you<\/th><th scope="col">By design<\/th>/);
        assert.match(out, /<td>Oct 18<\/td><td>6<\/td><td>0<\/td><td>4<\/td>/);
    });

    it('draws a series with nothing to flag (badKey null): no foot, no empty "bad" column', () => {
        const out = s(Charts.dayStrip(SPLIT, { valueKey: 'assistant_replies', badKey: null, valueHeader: 'Assistant replies', valueToken: '--chart-accent', valueFallback: 'currentColor' }));
        assert.equal((out.match(/<rect /g) || []).length, 3, 'one cell per day and no foot');
        assert.equal((out.match(/fill="currentColor"/g) || []).length, 1, 'the one day with replies');
        assert.match(out, /<title>Oct 18: 2 Assistant replies<\/title>/);
        assert.ok(!/<th scope="col">Failed<\/th>/.test(out));
        assert.equal((out.match(/<th /g) || []).length, 2, 'day and the series');
    });

    it('scales each strip to its own peak, so a quiet series is not flattened by a busy one', () => {
        const quiet = s(Charts.dayStrip([{ day: '2026-10-18', assistant_replies: 1 }, { day: '2026-10-19', assistant_replies: 2 }], { valueKey: 'assistant_replies', badKey: null }));
        const opacities = [...quiet.matchAll(/fill-opacity="([0-9.]+)"/g)].map((m) => Number(m[1]));
        assert.equal(Math.max(...opacities), 1, 'the busiest day is fully drawn');
    });

    it('keeps the defaults when no keys are given: sent and failed, as before', () => {
        const out = s(Charts.dayStrip([{ day: '2026-10-19', sent: 5, failed: 5 }], { sentHeader: 'Sent', failedHeader: 'Failed' }));
        assert.match(out, /<title>Oct 19: 5 Sent, 5 Failed<\/title>/);
    });

    it('labels a calendar day as that day, not as the evening before it in a zone west of UTC', () => {
        // Parsed as an instant, '2026-10-19' is 2026-10-18 20:00 in New York. A calendar day is read, and formatted, in UTC.
        assert.equal(Charts.dayLabel('2026-10-19'), 'Oct 19');
        assert.equal(Charts.dayLabel('2026-03-01'), 'Mar 1');
        // An instant is still an instant.
        assert.notEqual(Charts.dayLabel('2026-10-19T23:30:00Z'), '—');
        assert.equal(Charts.dayLabel('nope'), '—');
    });
});

describe('splitBar', () => {
    it('sizes segments in proportion and states the exact values', () => {
        const out = s(Charts.splitBar([
            { label: 'Sent', value: 59, token: '--success', fallback: '#34c759' },
            { label: 'Failed', value: 37, token: '--danger', fallback: '#ff3b30' },
        ], { label: 'Status' }));
        // Scoped to segment rects: the <svg> itself carries width="100%", and counting
        // that as a segment is how the first version of this assertion lied.
        const widths = [...out.matchAll(/<rect x="[0-9.]+%"[^>]*?width="([0-9.]+)%"/gs)].map((m) => Number(m[1]));
        assert.equal(widths.length, 2);
        assert.ok(Math.abs(widths[0]! + widths[1]! - 100) < 0.01, `widths sum to ${widths[0]! + widths[1]!}`);
        assert.ok(Math.abs(widths[0]! - (59 / 96) * 100) < 0.01);
        // The numbers are the point — a doughnut could only approximate them.
        assert.match(out, /59/);
        assert.match(out, /37/);
        // formatPercent() takes an already-scaled number ("72" -> "72%"), not a 0-1
        // fraction — passing the raw fraction here used to render as "0.615%".
        assert.match(out, /<span class="chart-split-pct">\u206661%\u2069<\/span>/);
        assert.match(out, /<span class="chart-split-pct">\u206639%\u2069<\/span>/);
    });

    it('gives each bar a unique clip id, so two on one page do not collide', () => {
        // A fixed id made clip-path resolve to whichever bar rendered first, clipping the
        // second to the wrong geometry.
        const a = s(Charts.splitBar([{ label: 'A', value: 1, token: '--success' }], {}));
        const b = s(Charts.splitBar([{ label: 'B', value: 1, token: '--success' }], {}));
        const idOf = (out: string): string | undefined => out.match(/<clipPath id="([^"]+)"/)?.[1];
        assert.ok(idOf(a) && idOf(b));
        assert.notEqual(idOf(a), idOf(b));
    });

    it('drops zero and negative series rather than drawing a zero-width segment', () => {
        const out = s(Charts.splitBar([
            { label: 'Sent', value: 10, token: '--success' },
            { label: 'Failed', value: 0, token: '--danger' },
        ], {}));
        assert.equal((out.match(/<rect x="[0-9.]+%"/g) || []).length, 1);
        assert.ok(!out.includes('Failed'), 'an empty series should not get a legend row');
    });

    it('says there is nothing when every series is zero', () => {
        const out = s(Charts.splitBar([{ label: 'Sent', value: 0, token: '--success' }], { emptyMessage: 'No data.' }));
        assert.match(out, /No data\./);
        assert.ok(!out.includes('<svg'));
    });

    it('escapes a hostile label', () => {
        // Series labels come from i18n today, but the builder must not be the weak link if
        // one ever comes from a tenant name or a campaign.
        const out = s(Charts.splitBar([
            { label: '<img src=x onerror=alert(1)>', value: 1, token: '--success' },
        ], {}));
        assert.ok(!out.includes('<img'), 'no live tag');
        assert.match(out, /&lt;img/);
    });
});

describe('sparkline', () => {
    it('refuses to draw a trend from two points', () => {
        // Two points are a straight line, and a straight line reads as a trend the data does
        // not support. That is exactly what the chart this replaced was doing.
        const out = s(Charts.sparkline([1, 9], { emptyMessage: 'Not enough data.' }));
        assert.match(out, /Not enough data\./);
        assert.ok(!out.includes('<polyline'));
    });

    it('draws once there are three points', () => {
        const out = s(Charts.sparkline([1, 5, 3], { label: 'Trend' }));
        assert.match(out, /<polyline/);
        assert.equal((s(Charts.sparkline([1, 5, 3], {})).match(/,/g) || []).length, 3);
    });

    it('ignores non-numeric values instead of producing NaN coordinates', () => {
        const out = s(Charts.sparkline([1, Number.NaN, 5, 3] as number[], {}));
        assert.ok(!out.includes('NaN'), 'NaN in a points attribute silently breaks the path');
    });

    it('handles a flat series without dividing by zero', () => {
        const out = s(Charts.sparkline([4, 4, 4], {}));
        assert.match(out, /<polyline/);
        assert.ok(!out.includes('NaN') && !out.includes('Infinity'));
    });
});
