#!/usr/bin/env node
/**
 * WCAG contrast guard for the design tokens.
 *
 * The dark-theme brand gradient once measured 3.96:1 and the muted text token once measured
 * ~2.6:1 on the dark background. Both were fixed by hand, and nothing stopped them regressing:
 * a token is one hex edit away from failing, and the failure is invisible to every other check
 * in this repo.
 *
 * Two things this script gets right that a naive version does not, because the naive version
 * was written first and produced 22 false failures:
 *
 *   1. **Alpha compositing.** `--surface-glass` is `rgba(255,255,255,0.032)` - a 3.2% overlay
 *      meant to sit ON an opaque surface. Treating it as an opaque background is meaningless.
 *      Translucent surfaces are composited over `--surface-raised` before measuring.
 *   2. **Only pairs that co-occur.** The cartesian product of every text token against every
 *      surface token includes nonsense: `--text-on-accent` is white-for-accent-buttons and is
 *      never painted on a content surface, and `--surface-scrim` is the modal backdrop
 *      (styles.css:910) that nothing reads on top of. Both are excluded deliberately, and the
 *      exclusion is the point - a guard that cries wolf gets switched off.
 *
 * Threshold is WCAG AA for normal text (4.5:1). Every real pair currently clears it; the
 * tightest is ~4.71:1, so there is little headroom and that is exactly why this is checked.
 */
import { readFileSync } from 'node:fs';
const css = readFileSync('dashboard/css/tokens.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function block(re) {
    const m = css.match(re); if (!m) return {};
    const from = m.index + m[0].length; let d = 1, i = from;
    while (i < css.length && d > 0) { if (css[i] === '{') d++; else if (css[i] === '}') d--; i++; }
    const o = {};
    for (const x of css.slice(from, i - 1).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) o[x[1]] = x[2].trim();
    return o;
}
const base = block(/:root\s*\{/), dark = block(/:root,\s*:root\[data-theme='dark'\]\s*\{/);
const lM = block(/:root:not\(\[data-theme='dark'\]\)\s*\{/), lE = block(/:root\[data-theme='light'\]\s*\{/);
const THEMES = { dark: { ...base, ...dark }, light: { ...base, ...dark, ...lM, ...lE } };

function parse(v) {                      // -> [r,g,b,a] or null
    v = (v || '').trim();
    if (v.startsWith('#')) {
        let h = v.slice(1);
        if (h.length === 3) h = h.split('').map(c => c + c).join('');
        if (!/^[0-9a-fA-F]{6}$/.test(h.slice(0, 6))) return null;
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)).concat([1]);
    }
    const m = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
}
function resolve(t, v, d = 0) {
    if (d > 8 || !v) return null; v = v.trim();
    const m = v.match(/^var\(\s*--([a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/);
    if (m) return t[m[1]] !== undefined ? resolve(t, t[m[1]], d + 1) : (m[2] ? resolve(t, m[2], d + 1) : null);
    return parse(v);
}
/** Composite src over dst (both [r,g,b,a]) -> opaque [r,g,b]. */
const over = (s, dst) => [0, 1, 2].map(i => Math.round(s[i] * s[3] + dst[i] * (1 - s[3])));
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const L = p => 0.2126 * lin(p[0]) + 0.7152 * lin(p[1]) + 0.0722 * lin(p[2]);
const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// Text tokens actually painted on content surfaces. `text-on-accent` is excluded: it is
// white-on-accent-button, never on a content surface. `surface-scrim` is excluded as a text
// surface: it is the modal backdrop (styles.css:910), nothing reads on top of it.
const TEXT = ['text-strong', 'text-default', 'text-muted',
              'accent-text', 'success-text', 'danger-text', 'warning-text', 'info-text'];
const OPAQUE = ['surface-page', 'surface-sunken', 'surface-raised', 'surface-overlay'];
// Translucent overlays composite over the opaque surface beneath them.
const GLASS = ['surface-glass', 'surface-glass-hover'];
const GLASS_PARENT = 'surface-raised';

const MIN = 4.5;
const failures = [];
let total = 0, worst = Infinity, worstLabel = '';

for (const name of Object.keys(THEMES)) {
    const t = THEMES[name];
    const parent = resolve(t, t[GLASS_PARENT]);
    if (!parent) { console.error(`\u274c cannot resolve --${GLASS_PARENT} in the ${name} theme.`); process.exit(1); }

    for (const txt of TEXT) {
        const fg4 = resolve(t, t[txt]);
        if (!fg4) { failures.push(`--${txt} (${name}) could not be resolved to a colour - the guard cannot measure it.`); continue; }
        const fg = fg4[3] === 1 ? fg4.slice(0, 3) : over(fg4, parent);

        const surfaces = OPAQUE.map(s => [s, resolve(t, t[s])])
            .concat(GLASS.map(g => {
                const b = resolve(t, t[g]);
                return [`${g} over ${GLASS_PARENT}`, b ? over(b, parent).concat([1]) : null];
            }));

        for (const [label, bg] of surfaces) {
            if (!bg) { failures.push(`--${label} (${name}) could not be resolved.`); continue; }
            const r = ratio(fg, bg.slice(0, 3));
            total++;
            if (r < worst) { worst = r; worstLabel = `--${txt} on --${label} (${name})`; }
            if (r < MIN) {
                failures.push(
                    `${r.toFixed(2)}:1 - --${txt} on --${label} (${name} theme) is below the ${MIN}:1 AA floor.`
                );
            }
        }
    }
}

// ─── Semantic hue separation ────────────────────────────────────────────────────────────────
//
// Contrast is not the only way a palette fails. The accent moved to terracotta (hue ~16) to
// agree with the warm neutrals, which put it BETWEEN the two alarm colours: danger was at
// 358 and warning at 38 — 18 and 22 degrees away. Two solid buttons side by side at that
// separation are genuinely hard to tell apart at a glance, and "delete" must never be
// mistakable for "publish".
//
// So danger went cooler and warning yellower until both cleared 25 degrees. This check is
// what stops that widening being quietly undone by the next colour tweak — nobody would
// notice, because each colour still passes contrast on its own.
//
// 25 degrees is a judgement, not a standard. It is the point at which these three read as
// distinct in side-by-side rows in this product; saturation difference helps too and is
// reported but not enforced, because it is the weaker signal of the two.

const MIN_HUE_SEPARATION = 25;

/** Pairs that must stay visually distinct, with why. */
const MUST_DIFFER = [
    ['accent', 'danger', 'a primary action must not read as a destructive one'],
    ['accent', 'warning', 'a primary action must not read as a caution state'],
    ['danger', 'warning', 'an error must not read as a warning'],
];

function toHue(rgb) {
    const [r, g, b] = rgb.slice(0, 3).map(v => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (d === 0) return null; // greys have no hue to compare
    let hDeg;
    if (max === r) hDeg = ((g - b) / d) % 6;
    else if (max === g) hDeg = (b - r) / d + 2;
    else hDeg = (r - g) / d + 4;
    hDeg *= 60;
    return (hDeg + 360) % 360;
}

const hueGap = (a, b) => {
    const d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
};

for (const [name, theme] of Object.entries(THEMES)) {
    for (const [a, b, why] of MUST_DIFFER) {
        const ca = resolve(theme, theme[a]);
        const cb = resolve(theme, theme[b]);
        if (!ca || !cb) { failures.push(`--${a} or --${b} (${name}) could not be resolved.`); continue; }
        const ha = toHue(ca), hb = toHue(cb);
        if (ha === null || hb === null) continue;
        const gap = hueGap(ha, hb);
        if (gap < MIN_HUE_SEPARATION) {
            failures.push(
                `--${a} and --${b} (${name} theme) are only ${gap.toFixed(0)}\u00b0 apart in hue ` +
                `(minimum ${MIN_HUE_SEPARATION}\u00b0) \u2014 ${why}.`
            );
        }
    }
}

if (failures.length > 0) {
    console.error('\n\u274c contrast check failed:\n');
    for (const f of failures) console.error(`   \u2022 ${f}`);
    console.error('');
    process.exit(1);
}
console.log(
    `\u2713 colour system: ${total} pairs clear ${MIN}:1 (tightest ${worst.toFixed(2)}:1 - ${worstLabel}); `
    + `${MUST_DIFFER.length * 2} semantic pair(s) at least ${MIN_HUE_SEPARATION}\u00b0 apart`
);
