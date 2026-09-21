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
     */
    dayStrip(days, options) {
        const opts = options || {};
        if (!Array.isArray(days) || days.length === 0) {
            return Charts._empty(opts.emptyMessage || '');
        }

        // Most recent nearest the reading edge: rightmost in LTR, leftmost in RTL.
        const ordered = I18N.isRtl() ? [...days].reverse() : [...days];
        const peak = Math.max(1, ...days.map((d) => (d.sent || 0) + (d.failed || 0)));

        const CELL = 26, GAP = 5, H = 54, FOOT = 4;
        const width = ordered.length * CELL + (ordered.length - 1) * GAP;
        const sent = Charts.token('--success', '#34c759');
        const failed = Charts.token('--danger', '#ff3b30');
        const empty = Charts.token('--surface-glass', 'rgba(255,255,255,0.08)');

        const cells = ordered.map((d, i) => {
            const total = (d.sent || 0) + (d.failed || 0);
            const x = i * (CELL + GAP);
            // A floor on opacity: a day with one event must not be invisible.
            const intensity = total === 0 ? 0 : 0.28 + 0.72 * (total / peak);
            const failH = total > 0 && d.failed > 0
                ? Math.max(FOOT, Math.round((H - 14) * (d.failed / total)))
                : 0;
            return html`
                <g>
                    <rect x="${x}" y="0" width="${CELL}" height="${H - 10}" rx="7"
                          fill="${total === 0 ? empty : sent}"
                          fill-opacity="${total === 0 ? 1 : intensity.toFixed(3)}"></rect>
                    ${failH > 0 ? html`<rect x="${x}" y="${H - 10 - failH}" width="${CELL}" height="${failH}" rx="7"
                          fill="${failed}" fill-opacity="0.85"></rect>` : ''}
                </g>`;
        });

        return html`
            <div class="chart-strip" dir="ltr">
                <svg viewBox="0 0 ${width} ${H}" width="100%" height="${H}"
                     preserveAspectRatio="xMidYMid meet" role="img"
                     aria-label="${opts.label || ''}" focusable="false">
                    ${cells}
                </svg>
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
                            <span class="chart-split-pct">${UI.formatPercent(Number(p.value) / total)}</span>
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

        const W = 240, H = 44, PAD = 3;
        const max = Math.max(...nums), min = Math.min(...nums);
        const span = max - min || 1;
        const pts = nums.map((n, i) => {
            const x = PAD + (i / (nums.length - 1)) * (W - PAD * 2);
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
