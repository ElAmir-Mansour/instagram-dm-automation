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

    for (const f of ['dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/charts.js']) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    // I18N.isRtl is what the strip consults; override it rather than mutating language state.
    vm.runInContext('I18N.isRtl = () => globalThis.__rtl === true;', ctx);
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
        assert.match(out, /<span class="chart-split-pct">61%<\/span>/);
        assert.match(out, /<span class="chart-split-pct">39%<\/span>/);
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
