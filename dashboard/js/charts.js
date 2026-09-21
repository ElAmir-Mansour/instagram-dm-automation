/**
 * Chart defaults — one definition, shared by Overview and Analytics.
 *
 * Previously each page carried its own copy of the tick colour, the grid
 * colour, the green/red series hex values and the legend font, so a change to
 * either meant editing two files and the two screens drifted apart.
 *
 * Two things this adds beyond deduplication:
 *
 * 1. THEME. Colours are read from the CSS custom properties at build time, so
 *    the charts follow the light/dark token set instead of hardcoding dark-mode
 *    hex values that vanish on a white background.
 *
 * 2. DIRECTION. In an RTL document a time series reads right-to-left like the
 *    rest of the page, so the category axis is reversed and the value axis
 *    moves to the right. Chart.js also needs `rtl: true` on the legend and
 *    tooltip, or their swatches sit on the wrong side of the label.
 *
 * 3. LOADING. Chart.js itself is ~201KB of UMD and two of the ten screens use
 *    it, so it is no longer a <script> in index.html. `Charts.ensure()` injects
 *    it on demand — same pinned version, same SRI hash, same CDN that is
 *    already in the CSP — and memoises the promise, so the eight screens that
 *    draw no chart never pay for it and the two that do pay once per session.
 *    An injected <script> is used rather than `import()` because SRI cannot be
 *    attached to a dynamic import, and dropping SRI to save a wrapper would be
 *    a bad trade for a third-party script.
 */
const Charts = {

    SRC: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
    INTEGRITY: 'sha384-NrKB+u6Ts6AtkIhwPixiKTzgSKNblyhlk0Sohlgar9UHUBzai/sgnNNWWd291xqt',

    _loading: null,

    /**
     * Resolve true once `window.Chart` exists, false if the CDN is unreachable.
     * Never rejects: a missing chart must degrade to an empty frame, which is
     * what `Charts.create()` already does.
     */
    ensure() {
        if (typeof Chart !== 'undefined') return Promise.resolve(true);
        if (Charts._loading) return Charts._loading;

        Charts._loading = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = Charts.SRC;
            script.integrity = Charts.INTEGRITY;
            script.crossOrigin = 'anonymous';
            script.async = true;
            script.onload = () => resolve(typeof Chart !== 'undefined');
            script.onerror = () => {
                console.warn('Chart.js failed to load from the CDN; charts will be skipped.');
                // Allow a later page visit to retry rather than caching the failure.
                Charts._loading = null;
                resolve(false);
            };
            document.head.appendChild(script);
        });
        return Charts._loading;
    },
    /** Read a design token. Falls back so a missing token can never blank a chart. */
    token(name, fallback) {
        try {
            const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            return value || fallback;
        } catch {
            return fallback;
        }
    },

    palette() {
        return {
            positive: Charts.token('--chart-positive', '#2dd4a7'),
            negative: Charts.token('--chart-negative', '#f87171'),
            grid: Charts.token('--chart-grid', 'rgba(255,255,255,0.07)'),
            tick: Charts.token('--chart-tick', '#9aa7b8'),
            instagram: Charts.token('--brand-instagram', '#e1306c'),
            facebook: Charts.token('--brand-facebook', '#1877f2'),
        };
    },

    /** A colour with an alpha applied, for area fills under a line. */
    alpha(color, a) {
        const hex = String(color).trim();
        const m = /^#?([0-9a-f]{6})$/i.exec(hex);
        if (!m) return hex;
        const int = parseInt(m[1], 16);
        return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${a})`;
    },

    font() {
        // Cairo renders the Arabic legend labels; Inter has no Arabic glyphs.
        return { family: I18N.isRtl() ? 'Cairo' : 'Inter', size: 12 };
    },

    /** Shared options for any cartesian chart. */
    cartesian(extra) {
        const c = Charts.palette();
        const rtl = I18N.isRtl();
        const base = {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    rtl,
                    textDirection: rtl ? 'rtl' : 'ltr',
                    labels: { color: c.tick, font: Charts.font(), boxWidth: 12, padding: 14 },
                },
                tooltip: {
                    rtl,
                    textDirection: rtl ? 'rtl' : 'ltr',
                    bodyFont: Charts.font(),
                    titleFont: Charts.font(),
                },
            },
            scales: {
                x: {
                    // Time reads in the document's direction.
                    reverse: rtl,
                    ticks: { color: c.tick, font: Charts.font(), maxRotation: 0, autoSkipPadding: 12 },
                    grid: { color: c.grid },
                },
                y: {
                    position: rtl ? 'right' : 'left',
                    beginAtZero: true,
                    ticks: { color: c.tick, font: Charts.font(), precision: 0 },
                    grid: { color: c.grid },
                },
            },
        };
        return Charts.merge(base, extra || {});
    },

    /** Shared options for the sent/failed doughnut. */
    doughnut(extra) {
        const c = Charts.palette();
        const rtl = I18N.isRtl();
        return Charts.merge({
            responsive: true,
            maintainAspectRatio: false,
            cutout: '72%',
            plugins: {
                legend: {
                    position: 'bottom',
                    rtl,
                    textDirection: rtl ? 'rtl' : 'ltr',
                    labels: { color: c.tick, font: Charts.font(), padding: 16, boxWidth: 12 },
                },
                tooltip: { rtl, textDirection: rtl ? 'rtl' : 'ltr', bodyFont: Charts.font() },
            },
        }, extra || {});
    },

    /** The sent/failed dataset, identical on both screens. */
    statusData(sent, failed) {
        const c = Charts.palette();
        return {
            labels: [t('common.sent'), t('common.failed')],
            datasets: [{
                data: [Number(sent) || 0, Number(failed) || 0],
                backgroundColor: [c.positive, c.negative],
                borderWidth: 0,
                hoverOffset: 8,
            }],
        };
    },

    /** Shallow-ish merge good enough for Chart.js option trees. */
    merge(base, extra) {
        const out = Array.isArray(base) ? base.slice() : { ...base };
        Object.keys(extra).forEach((key) => {
            const value = extra[key];
            if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
                out[key] = Charts.merge(base[key], value);
            } else {
                out[key] = value;
            }
        });
        return out;
    },

    /** Create a chart, or return null if Chart.js failed to load from the CDN. */
    create(canvasId, config) {
        if (typeof Chart === 'undefined') return null;
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        try {
            return new Chart(canvas.getContext('2d'), config);
        } catch (err) {
            console.warn(`Chart "${canvasId}" failed:`, err);
            return null;
        }
    },
};
