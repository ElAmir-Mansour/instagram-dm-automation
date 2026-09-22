/**
 * Charts, drawn here rather than by a library.
 *
 * ─── Why this replaced Chart.js ──────────────────────────────────────────────
 *
 * The previous version loaded Chart.js 4.4.4 from a CDN — ~201KB of UMD, lazily,
 * for four charts across two of ten screens. The file's own header complained
 * about that. Three reasons it is gone:
 *
 *   1. It looked generic, because it WAS generic. The charts were Chart.js
 *      defaults with a token-aware palette bolted on. Restyling a charting
 *      engine deeply enough to stop looking like a charting engine is more work
 *      than drawing the four things this product actually needs.
 *   2. It could not be tested. A canvas render is opaque: there is nothing to
 *      assert. Every function below is pure — data in, SVG string out — so the
 *      geometry, the empty states and the RTL handling all have real tests.
 *   3. It was a third-party script on the critical path of a dashboard that
 *      handles a live Meta token. Worth being precise about the benefit: this
 *      does NOT let `cdn.jsdelivr.net` leave the CSP, because Lucide still loads
 *      from there. What it removes is one more pinned dependency, one more SRI
 *      hash to keep current, and ~201KB that a CDN outage could withhold.
 *
 * ─── The chart language ──────────────────────────────────────────────────────
 *
 * `dayStrip`  — one cell per day. Replaces a line chart that was drawing a
 *               straight line between two points and labelling it "last 7
 *               days", which reads as a declining trend when it is two days of
 *               data with nothing in between. A strip cannot lie about a gap:
 *               an empty day is an empty cell.
 * `splitBar`  — one horizontal bar. Replaces a doughnut, which is the weakest
 *               way to show a two-part split: the eye compares angles badly,
 *               and it costs a whole card to say "59 and 37".
 * `sparkline` — a thin trend line for when a trend is real (>= 3 points).
 *
 * ─── Two things every chart here does that the canvas could not ──────────────
 *
 * ACCESSIBILITY. A `<canvas>` is a black box to a screen reader; the old charts
 * carried an `aria-label` naming the chart and nothing about its contents. Each
 * builder emits a `<table class="sr-only">` of the real numbers, so the data is
 * readable rather than merely announced.
 *
 * RTL. SVG does not mirror with `dir`. A day strip must run right-to-left in
 * Arabic or "most recent" ends up on the wrong end, so cell order is reversed
 * explicitly. Chart.js needed `rtl: true` in three separate places for this and
 * still got tooltips wrong.
 */

const Charts = {
    /** Monotonic, so two charts on one page cannot share an SVG element id. */
    _seq: 0,

    /** Every chart reads its colours from the design tokens, never a literal. */
    token(name, fallback) {
        const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        return v || fallback;
    },

    /** Nothing to draw. Says so, rather than rendering empty axes. */
    _empty(message) {
        return html`<p class="chart-empty">${message}</p>`;
    },

    /**
     * A screen-reader table of the values behind a chart.
     *
     * Visually hidden, immediately after the graphic. This is the part a canvas
     * cannot do: the numbers are in the accessibility tree, not just a label
     * saying a chart exists.
     */
    _srTable(caption, headers, rows) {
        return html`
            <table class="sr-only">
                <caption>${caption}</caption>
                <thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
                <tbody>${rows.map((r) => html`<tr>${r.map((cell) => html`<td>${cell}</td>`)}</tr>`)}</tbody>
            </table>`;
    },

    /**
     * One cell per day; opacity carries volume, a foot-bar carries failures.
     *
     * Deliberately NOT a scale with a y-axis. The question this answers is "did
     * anything happen, and when", and for that a reader needs to see gaps. A
     * line chart interpolates across them and invents a trend.
     *
     * The X axis is a relative coordinate space — CELL/GAP are proportions, not
     * pixels — stretched to fill the card's real width via
     * `preserveAspectRatio="none"` (see splitBar below). `width="100%"` alone
     * used to do nothing here: with the SVG's own `height` fixed and already
     * equal to the viewBox height, the default `meet` locks the scale at 1 on
     * that already-satisfied axis, so the strip rendered at its tiny native
     * size, centered in a lot of empty card. The Y axis is never stretched —
     * SVG height always equals viewBox height — so it stays literal pixels.
     *
     * That split is also why the day labels below are plain HTML and not SVG
     * `<text>`: glyphs inside a non-uniformly scaled viewBox stretch right
     * along with the rects, which reads as visibly distorted type the moment
     * the card is wider than the viewBox's own units. A `<div>` row outside
     * the `<svg>` has no such problem, and lines up with the cells above it
     * because both split the same width into the same number of equal shares.
     *
     * At most 8 labels are ever drawn, evenly spaced and always including the
     * most recent day — this same builder also renders a 30-day strip
     * (`analytics.chart30`), and a label under every one of 30 cells would be
     * overlapping noise, not information.
     *
     * The strip's own max-width is capped at a fixed size per cell (see
     * MAX_SLOT_PX below), so filling the card cannot turn a handful of cells
     * into giant pills — it did exactly that in production once, when
     * `/api/stats/daily` only returned rows for days with activity: two real
     * days stretched to fill a whole week's width. That is now also fixed at
     * the data layer (the endpoint zero-fills every day), but the cap stays
     * as the thing that keeps a cell a cell no matter how sparse the input is.
     */
    dayStrip(days, options) {
        const opts = options || {};
        if (!Array.isArray(days) || days.length === 0) {
            return Charts._empty(opts.emptyMessage || '');
        }

        // Most recent nearest the reading edge: rightmost in LTR, leftmost in RTL.
        const ordered = I18N.isRtl() ? [...days].reverse() : [...days];
        const peak = Math.max(1, ...days.map((d) => (d.sent || 0) + (d.failed || 0)));

        // CELL/GAP are proportions (see the class comment above). GAP is even
        // so a cell's x stays a whole number — cosmetic, but it keeps the
        // geometry easy to reason about (and to test).
        const CELL = 26, GAP = 6, SLOT = CELL + GAP;
        const BAR_H = 52, TOP_SLIVER = 4, FOOT_MIN = 4;
        const width = ordered.length * SLOT;
        // `preserveAspectRatio="none"` below fills the card's real width — the fix for cells
        // that used to render at a tiny fixed size. Uncapped, that stretch is proportional to
        // 1 / cell count: a week with only two non-empty days (2 rows, since the caller may
        // not zero-fill every day) stretched those two cells into giant pills rather than
        // seven modest ones. Capping the STRIP's own width, not each cell, keeps every cell
        // the same size regardless of how many there are — narrow strips still fill their
        // card, and a strip with few cells just leaves margin instead of ballooning.
        const MAX_SLOT_PX = 56;
        const maxWidthPx = ordered.length * MAX_SLOT_PX;
        const sent = Charts.token('--success', '#34c759');
        const failed = Charts.token('--danger', '#ff3b30');
        const empty = Charts.token('--surface-glass', 'rgba(255,255,255,0.08)');
        // A hairline outline so an empty day reads as a deliberate, bounded
        // slot rather than a near-invisible smudge on a mostly-empty week.
        const emptyLine = Charts.token('--border-subtle', 'rgba(255,255,255,0.12)');
        const sentLabel = opts.sentHeader || 'Sent';
        const failedLabel = opts.failedHeader || 'Failed';

        const cells = ordered.map((d, i) => {
            const total = (d.sent || 0) + (d.failed || 0);
            const x = i * SLOT + GAP / 2;
            const dayLabel = UI.formatDayShort(d.day);
            // A floor on opacity: a day with one event must not be invisible.
            const intensity = total === 0 ? 0 : 0.28 + 0.72 * (total / peak);
            const failH = total > 0 && d.failed > 0
                ? Math.max(FOOT_MIN, Math.round((BAR_H - TOP_SLIVER) * (d.failed / total)))
                : 0;
            // A native tooltip on hover, with exact numbers — the one thing the
            // sr-only table below cannot offer a sighted mouse user.
            const tip = `${dayLabel}: ${UI.formatNumber(d.sent || 0)} ${sentLabel}, ${UI.formatNumber(d.failed || 0)} ${failedLabel}`;
            return html`
                <g>
                    <title>${tip}</title>
                    <rect x="${x}" y="0" width="${CELL}" height="${BAR_H}" rx="7"
                          fill="${total === 0 ? empty : sent}"
                          fill-opacity="${total === 0 ? 1 : intensity.toFixed(3)}"
                          stroke="${total === 0 ? emptyLine : 'none'}"
                          stroke-width="${total === 0 ? 1 : 0}"></rect>
                    ${failH > 0 ? html`<rect x="${x}" y="${BAR_H - failH}" width="${CELL}" height="${failH}" rx="7"
                          fill="${failed}" fill-opacity="0.85"></rect>` : ''}
                </g>`;
        });

        // Thin the labels once there are more than 8 days rather than cramming
        // one under every cell — see the class comment above.
        const labelStep = Math.max(1, Math.ceil(ordered.length / 8));
        const labels = ordered.map((d, i) => {
            const show = i % labelStep === 0 || i === ordered.length - 1;
            return html`<span style="flex:1 1 0%;min-width:0;overflow:visible;white-space:nowrap;text-align:center;font-size:var(--fs-100, 12px);color:var(--text-muted, #aeaeb2);">${show ? UI.formatDayShort(d.day) : ''}</span>`;
        });

        return html`
            <div class="chart-strip" dir="ltr" style="max-width:${maxWidthPx}px">
                <svg viewBox="0 0 ${width} ${BAR_H}" width="100%" height="${BAR_H}"
                     preserveAspectRatio="none" role="img"
                     aria-label="${opts.label || ''}" focusable="false">
                    ${cells}
                </svg>
                <div style="display:flex;margin-top:6px" aria-hidden="true">${labels}</div>
            </div>
            ${Charts._srTable(
                opts.label || '',
                [opts.dayHeader || 'Day', opts.sentHeader || 'Sent', opts.failedHeader || 'Failed'],
                days.map((d) => [UI.formatDayShort(d.day), UI.formatNumber(d.sent || 0), UI.formatNumber(d.failed || 0)])
            )}`;
    },

    /**
     * One bar, segments proportional, numbers stated beneath.
     *
     * The numbers are the point. A proportion bar shows the ratio at a glance
     * and the labels give the exact values, which is everything a doughnut was
     * being asked for and could only approximate.
     */
    splitBar(parts, options) {
        const opts = options || {};
        const clean = (parts || []).filter((p) => p && Number(p.value) > 0);
        const total = clean.reduce((sum, p) => sum + Number(p.value), 0);
        if (total === 0) return Charts._empty(opts.emptyMessage || '');

        const H = 14;
        // A fixed id would collide when two split bars render on one page, and a
        // duplicate id makes clip-path resolve to whichever appeared first.
        const clipId = `chart-split-clip-${++Charts._seq}`;
        let cursor = 0;
        const segments = clean.map((p) => {
            const w = (Number(p.value) / total) * 100;
            const seg = html`<rect x="${cursor.toFixed(3)}%" y="0" width="${w.toFixed(3)}%" height="${H}"
                                   fill="${Charts.token(p.token, p.fallback || '#888')}"></rect>`;
            cursor += w;
            return seg;
        });

        return html`
            <div class="chart-split">
                <svg viewBox="0 0 100 ${H}" width="100%" height="${H}" preserveAspectRatio="none"
                     role="img" aria-label="${opts.label || ''}" focusable="false">
                    <clipPath id="${clipId}"><rect x="0" y="0" width="100" height="${H}" rx="${H / 2}"></rect></clipPath>
                    <g clip-path="url(#${clipId})">${segments}</g>
                </svg>
                <ul class="chart-split-legend">
                    ${clean.map((p) => html`
                        <li>
                            <span class="chart-dot" style="background: ${Charts.token(p.token, p.fallback || '#888')}"></span>
                            <span class="chart-split-label">${p.label}</span>
                            <span class="chart-split-value">${UI.formatNumber(p.value)}</span>
                            <span class="chart-split-pct">${UI.formatPercent(Math.round((Number(p.value) / total) * 100))}</span>
                        </li>`)}
                </ul>
            </div>
            ${Charts._srTable(
                opts.label || '',
                [opts.nameHeader || 'Series', opts.valueHeader || 'Value'],
                clean.map((p) => [p.label, UI.formatNumber(p.value)])
            )}`;
    },

    /**
     * A thin trend line. Refuses to draw below three points.
     *
     * Two points are a straight line, and a straight line reads as a trend that
     * the data does not support — the exact failure the day strip replaced.
     */
    sparkline(values, options) {
        const opts = options || {};
        const nums = (values || []).map(Number).filter((n) => Number.isFinite(n));
        if (nums.length < 3) return Charts._empty(opts.emptyMessage || '');

        // Most recent nearest the reading edge, exactly like dayStrip. Unused by
        // any page today, but wrong-by-default here is a trap for whichever page
        // adopts it first.
        const ordered = I18N.isRtl() ? [...nums].reverse() : nums;

        const W = 240, H = 44, PAD = 3;
        const max = Math.max(...nums), min = Math.min(...nums);
        const span = max - min || 1;
        const pts = ordered.map((n, i) => {
            const x = PAD + (i / (ordered.length - 1)) * (W - PAD * 2);
            const y = H - PAD - ((n - min) / span) * (H - PAD * 2);
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        });
        const stroke = Charts.token(opts.token || '--accent', '#0071e3');

        return html`
            <div class="chart-spark" dir="ltr">
                <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none"
                     role="img" aria-label="${opts.label || ''}" focusable="false">
                    <polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}"
                              stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></polyline>
                </svg>
            </div>`;
    },
};
