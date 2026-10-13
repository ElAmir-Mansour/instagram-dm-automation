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
 * tightest is 5.05:1 in dark and 4.76:1 in light, so there is little headroom and that is
 * exactly why this is checked.
 *
 * Since the Ink & Cardamom palette (DESIGN.md §2) the guard also measures the accent as a
 * FILL, not only as a label: the label on the fill (`--text-on-accent` on `--accent`, its hover
 * and press steps and every stop of `--gradient-brand`), the fill against the canvas as a
 * non-text shape (3:1), and `--accent-text` on the `--accent-soft` highlighter, which is the
 * ground behind the keyword, the eyebrow and the active nav row.
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

// Text tokens actually painted on content surfaces. `text-on-accent` is excluded here: it is
// the label on the accent FILL, never on a content surface, and is measured against the fill
// (and its hover and press steps) in FILL_PAIRS below. `surface-scrim` is excluded as a text
// surface: it is the modal backdrop (styles.css:910), nothing reads on top of it.
const TEXT = ['text-strong', 'text-default', 'text-muted',
              'accent-text', 'success-text', 'danger-text', 'warning-text', 'info-text',
              'brand-instagram-text', 'brand-facebook-text'];
/**
 * Surfaces text is painted on, as a COMPOSITE CHAIN down to the opaque canvas.
 *
 * This used to be a flat "opaque" list plus one hardcoded glass parent, and that broke the
 * moment the design went glassmorphic: `--surface-raised` is now `rgba(40,40,44,0.65)` — a
 * glass card — so treating it as opaque and compositing the hover tint over its RAW rgba
 * produced numbers that were simply wrong. It reported failures that were artefacts of its
 * own arithmetic, which is worse than reporting none.
 *
 * Each entry is the stack a pixel actually passes through, topmost first. `--surface-page`
 * is the only surface guaranteed opaque, so every chain ends there.
 */
const SURFACE_STACKS = [
    ['surface-page'],
    ['surface-sunken', 'surface-page'],
    ['surface-solid'],
    ['surface-raised', 'surface-page'],
    ['surface-overlay', 'surface-page'],
    // The tint on a glass card, which is itself on the canvas.
    ['surface-glass', 'surface-raised', 'surface-page'],
    ['surface-glass-hover', 'surface-raised', 'surface-page'],
    // The same tint directly on the canvas.
    ['surface-glass', 'surface-page'],
    ['surface-glass-hover', 'surface-page'],
    // The window chrome (the sidebar and the top bar share one token), and a hover row on
    // it — which is where the nav items and the page title actually sit. Measured over the
    // canvas; content scrolling under the top bar shows through 14%, which the blur evens out.
    ['surface-chrome', 'surface-page'],
    ['surface-glass', 'surface-chrome', 'surface-page'],
    ['surface-glass-hover', 'surface-chrome', 'surface-page'],
    // The platform badge: a -soft tint on a card, or directly on the canvas. The label on
    // it is the matching -text token and nothing else (see coOccurs below).
    ['brand-instagram-soft', 'surface-raised', 'surface-page'],
    ['brand-facebook-soft', 'surface-raised', 'surface-page'],
    ['brand-instagram-soft', 'surface-page'],
    ['brand-facebook-soft', 'surface-page'],
    // The accent highlighter: the keyword (.kw), the eyebrow, .chip-accent, the active nav row
    // (.nav-indicator, which sits on the chrome) and a text selection. Its labels are
    // `--accent-text` and, for the nav row and ::selection, `--text-strong`.
    ['accent-soft', 'surface-raised', 'surface-page'],
    ['accent-soft', 'surface-page'],
    ['accent-soft', 'surface-solid'],
    ['accent-soft', 'surface-sunken', 'surface-page'],
    ['accent-soft', 'surface-chrome', 'surface-page'],
];

/**
 * Which text/stack pairs actually exist, for the one place the cartesian product lies.
 *
 * A platform label is painted only on its own tint (`.badge-instagram`, `.platform-tag.ig`
 * and the Facebook pair, styles.css:987 and :1042), and nothing else is ever painted on
 * that tint. So `--brand-instagram-text` is measured on the two Instagram stacks and on
 * nothing else, and the general text tokens skip the tinted stacks. Left unscoped, the
 * product reports `--text-muted on --brand-instagram-soft` at ~4.5:1 - a pair that does
 * not exist, sitting exactly on the floor, which is the kind of failure that gets a guard
 * switched off.
 */
const TINT_LABEL = {
    'brand-instagram-soft': ['brand-instagram-text'],
    'brand-facebook-soft': ['brand-facebook-text'],
    // The highlighter carries two labels: the accent's own, and the strong text of the active nav
    // row and of a selection. Nothing else is painted on it.
    'accent-soft': ['accent-text', 'text-strong'],
};
const BRAND_TEXT = new Set(['brand-instagram-text', 'brand-facebook-text']);
const coOccurs = (txt, stack) => {
    const labels = TINT_LABEL[stack[0]];
    return labels ? labels.includes(txt) : !BRAND_TEXT.has(txt);
};

/** Flatten a stack to one opaque colour by compositing each layer over the one below. */
function flatten(theme, stack) {
    let out = null;
    for (const name of [...stack].reverse()) {
        const c = resolve(theme, theme[name]);
        if (!c) return null;
        out = out === null ? c.slice(0, 3) : over(c, out);
    }
    return out;
}

const MIN = 4.5;
const failures = [];
let total = 0;
const worstBy = {};   // theme -> { r, label }: the tightest TEXT pair in each theme

for (const name of Object.keys(THEMES)) {
    const t = THEMES[name];

    for (const txt of TEXT) {
        const fg4 = resolve(t, t[txt]);
        if (!fg4) { failures.push(`--${txt} (${name}) could not be resolved to a colour - the guard cannot measure it.`); continue; }

        for (const stack of SURFACE_STACKS) {
            if (!coOccurs(txt, stack)) continue;
            const bg = flatten(t, stack);
            if (!bg) continue; // a surface this theme does not define
            // Text can itself be translucent; composite it onto the same ground.
            const fg = fg4[3] === 1 ? fg4.slice(0, 3) : over(fg4, bg);
            const r = ratio(fg, bg);
            total++;
            const label = stack.map(x => `--${x}`).join(' on ');
            if (!worstBy[name] || r < worstBy[name].r) worstBy[name] = { r, label: `--${txt} on ${label}` };
            if (r < MIN) {
                failures.push(`${r.toFixed(2)}:1 - --${txt} on ${label} (${name} theme) is below the ${MIN}:1 AA floor.`);
            }
        }
    }
}

// ─── The accent as a FILL ───────────────────────────────────────────────────────────────────
//
// The loop above measures text on the surfaces it is painted on. The accent is also a surface
// of its own (the primary button, the outgoing bubble, a switch that is on), so the other half
// of the contract is measured here:
//
//   text      the label on the fill: `--text-on-accent` on `--accent`, on its hover and press
//             steps, and on every stop of `--gradient-brand` (the button face is that gradient,
//             not the flat token, so a stop that dips under 4.5:1 is a button nobody can read).
//   non-text  the fill against the grounds it sits on, at the WCAG 1.4.11 floor of 3:1: the
//             focus outline and the active marker are `--accent`, and a switch track is too.
//   bubble    the outgoing bubble's own furniture, which is `currentColor` mixed into the bubble:
//             the quick-reply pill (12% of the label colour as its fill) and the timestamp (78%
//             of it as its ink). The pill once inherited `--text-default` on `--surface-glass`
//             and measured 1.10:1 in dark and 1.51:1 in light on the bubble, in the inbox.
//   chart     `--chart-tick` is the axis label and the native select's chevron is a glyph;
//             `--chart-accent` is the data series (a shape, 3:1). All three are theme values.
//
// `--accent-text` on the `--accent-soft` highlighter is in SURFACE_STACKS above.

const MIN_NON_TEXT = 3.0;
const gradientStops = (v) => [...(v || '').matchAll(/#[0-9a-fA-F]{6}\b/g)].map(m => parse(m[0]));
const chevronStroke = (v) => {
    const m = (v || '').match(/stroke='%23([0-9a-fA-F]{6})'/);
    return m ? parse('#' + m[1]) : null;
};
const nonText = {};   // theme -> { r, label }: the tightest accent-as-a-shape pair
const nonTextChart = {};   // theme -> { r, label }: the tightest chart-accent pair
let fillTotal = 0;

for (const [name, t] of Object.entries(THEMES)) {
    const onAccent = resolve(t, t['text-on-accent']);
    if (!onAccent) { failures.push(`--text-on-accent (${name}) could not be resolved.`); continue; }

    // The label on the fill, its steps, and every stop of the brand gradient.
    const fills = [
        ['--accent', resolve(t, t['accent'])],
        ['--accent-hover', resolve(t, t['accent-hover'])],
        ['--accent-active', resolve(t, t['accent-active'])],
        ...gradientStops(t['gradient-brand']).map((c, i) => [`--gradient-brand stop ${i + 1}`, c]),
    ];
    if (gradientStops(t['gradient-brand']).length < 2) failures.push(`--gradient-brand (${name}) has no hex stops the guard can read.`);
    for (const [label, fill] of fills) {
        if (!fill) { failures.push(`${label} (${name}) could not be resolved.`); continue; }
        const r = ratio(onAccent.slice(0, 3), fill.slice(0, 3));
        fillTotal++;
        if (r < MIN) failures.push(`${r.toFixed(2)}:1 - --text-on-accent on ${label} (${name} theme) is below the ${MIN}:1 AA floor.`);
    }

    // The outgoing bubble's furniture, on the flat accent and every stop of the gradient: the
    // quick-reply pill (`.bubble-outbound .qr-pill`: label colour, filled with 12% of itself) and the
    // timestamp (`.message-time`: 78% of the label colour). Both are mixes of `currentColor`.
    const label3 = onAccent.slice(0, 3);
    for (const [label, fill] of fills.filter(([l]) => l === '--accent' || l.startsWith('--gradient-brand'))) {
        if (!fill) continue;
        const ground = fill.slice(0, 3);
        const pillBg = over([...label3, 0.12], ground);
        const timeInk = over([...label3, 0.78], ground);
        fillTotal += 2;
        const rp = ratio(label3, pillBg);
        const rt = ratio(timeInk, ground);
        if (rp < MIN) failures.push(`${rp.toFixed(2)}:1 - the quick-reply pill (label colour on 12% of itself) on the outgoing bubble at ${label} (${name} theme) is below the ${MIN}:1 AA floor.`);
        if (rt < MIN) failures.push(`${rt.toFixed(2)}:1 - the timestamp (78% label colour) on the outgoing bubble at ${label} (${name} theme) is below the ${MIN}:1 AA floor.`);
    }

    // The fill, and the chart accent, as shapes on the grounds they are painted on: the canvas, an
    // opaque card, a glass card.
    for (const [token, record, what] of [
        ['accent', nonText, 'focus outline, active marker, switch track'],
        ['chart-accent', nonTextChart, 'a chart series: the line, the heat map, the split bar'],
    ]) {
        const shape = resolve(t, t[token]);
        if (!shape) { failures.push(`--${token} (${name}) could not be resolved.`); continue; }
        for (const stack of [['surface-page'], ['surface-solid'], ['surface-raised', 'surface-page']]) {
            const bg = flatten(t, stack);
            if (!bg) continue;
            const r = ratio(shape.slice(0, 3), bg);
            fillTotal++;
            const label = `--${token} on ${stack.map(x => `--${x}`).join(' on ')}`;
            if (!record[name] || r < record[name].r) record[name] = { r, label };
            if (r < MIN_NON_TEXT) failures.push(`${r.toFixed(2)}:1 - ${label} (${name} theme) is below the ${MIN_NON_TEXT}:1 non-text floor (${what}).`);
        }
    }

    // The axis label is text; the chevron is a glyph. Both sit on the card or the input well.
    const tick = resolve(t, t['chart-tick']);
    for (const stack of [['surface-page'], ['surface-solid']]) {
        const bg = flatten(t, stack);
        if (!tick || !bg) continue;
        const r = ratio(tick.slice(0, 3), bg);
        fillTotal++;
        if (r < MIN) failures.push(`${r.toFixed(2)}:1 - --chart-tick on --${stack[0]} (${name} theme) is below the ${MIN}:1 AA floor.`);
    }
    const chev = chevronStroke(t['select-chevron']);
    const well = flatten(t, ['surface-sunken', 'surface-page']);
    if (!chev || !well) failures.push(`--select-chevron (${name}) has no stroke colour the guard can read.`);
    else {
        const r = ratio(chev.slice(0, 3), well);
        fillTotal++;
        if (r < MIN_NON_TEXT) failures.push(`${r.toFixed(2)}:1 - the select chevron on --surface-sunken (${name} theme) is below the ${MIN_NON_TEXT}:1 non-text floor.`);
    }
}

// ─── Semantic hue separation ────────────────────────────────────────────────────────────────
//
// Contrast is not the only way a palette fails. The accent was once terracotta (hue ~16), which
// sat BETWEEN the two alarm colours: danger was at 358 and warning at 38 — 18 and 22 degrees
// away. Two solid buttons side by side at that separation are genuinely hard to tell apart at a
// glance, and "delete" must never be mistakable for "publish".
//
// So danger went cooler and warning yellower until both cleared 25 degrees. This check is
// what stops that widening being quietly undone by the next colour tweak — nobody would
// notice, because each colour still passes contrast on its own.
//
// The accent is cardamom now (hue ~78) and its nearest neighbour is success (135), because both
// are green-ish: "published" and "primary action" must not collapse into one colour either, and
// a tweak that pulled the accent toward #34c759 would pass every contrast row above.
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
    ['accent', 'success', 'a primary action must not read as a success state (cardamom is never a status)'],

    // NOT accent-vs-platform. That pair was checked here and it was the wrong test: it
    // assumed both are used as solid fills, and in this codebase the platform colours never
    // are on a control - `.badge-facebook` and `.platform-tag.fb` use `--brand-facebook-soft`
    // as a 14% tint with `--brand-facebook-text` as the label, and the tag also carries the
    // literal letters "FB". A solid blue button and a faint blue tint reading "FB" are
    // distinguishable whatever their hue, so the hue rule blocked legitimate palettes (both
    // a Facebook-inspired and an Apple-inspired accent) while protecting nothing.
    //
    // The property that actually matters is structural, and is checked by
    // checkPlatformColourUsage() below: a platform colour may be a SOLID fill only in data
    // visualisation, never on an interactive control.
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

/**
 * Platform colours are Meta's, and DESIGN.md §3 says they are DATA, never decoration.
 *
 * The line that matters is not hue, it is what they fill. A solid `--brand-facebook`
 * background on a chart bar is data: it says "this segment is Facebook". The same solid on a
 * button or a pill is decoration, and it borrows Meta's brand for our own interface — which
 * their platform terms forbid (a third party may not "imply an endorsement or partnership of
 * any kind"), and which also makes a control indistinguishable from a platform tag.
 *
 * So: solid use is allowed only on the selectors below, which are chart geometry. Everything
 * else must go through `-soft` (a tint) and `-text` (a label).
 */
function checkPlatformColourUsage() {
    const DATA_VIZ_SELECTORS = ['.platform-bar-ig', '.platform-bar-fb'];
    let css;
    try {
        css = readFileSync('dashboard/css/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    } catch {
        failures.push('dashboard/css/styles.css could not be read, so platform-colour usage is unchecked.');
        return;
    }
    // Bare --brand-x (not -soft, not -text) used as a background, border or fill.
    const re = /([^{}]+)\{[^}]*?(?:background|border[a-z-]*|fill)\s*:[^;}]*var\(--brand-(?:instagram|facebook|tiktok)\)/g;
    for (const m of css.matchAll(re)) {
        const selector = m[1].split('\n').pop().trim();
        const allowed = DATA_VIZ_SELECTORS.some(a => selector.includes(a));
        if (!allowed) {
            failures.push(
                `${selector} fills with a bare --brand-* colour. Platform colours may be solid only in `
                + `data visualisation (${DATA_VIZ_SELECTORS.join(', ')}); on a control, use --brand-*-soft `
                + `as a tint with --brand-*-text as the label.`
            );
        }
    }
}

/**
 * The bubble pairs measured above are CONSTANTS in this file: they describe what
 * `.bubble-outbound .qr-pill` and `.message-time` are meant to paint. A guard that models a rule it
 * never reads passes when the rule is deleted, so this checks the rules still say what the model
 * assumes (the pill inherits the label and fills with 12% of it; the timestamp is 78% of it).
 */
function checkBubbleFurniture() {
    let css;
    try {
        css = readFileSync('dashboard/css/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    } catch {
        failures.push('dashboard/css/styles.css could not be read, so the outgoing bubble furniture is unchecked.');
        return;
    }
    const rule = (sel) => (css.match(new RegExp(`${sel.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) || [])[1] || '';
    const pill = rule('.bubble-outbound .qr-pill');
    if (!/color:\s*inherit/.test(pill) || !/background:\s*color-mix\(in srgb,\s*currentColor 12%/.test(pill)) {
        failures.push('.bubble-outbound .qr-pill no longer inherits the label colour and fills with 12% of it: the quick-reply pill would sit on the outgoing bubble as --text-default on --surface-glass (1.10:1 dark, 1.51:1 light).');
    }
    if (!/color:\s*color-mix\(in srgb,\s*currentColor 78%/.test(rule('.message-time'))) {
        failures.push('.message-time is no longer 78% of the bubble label colour, which is what check-contrast measures.');
    }
}

checkPlatformColourUsage();
checkBubbleFurniture();

if (failures.length > 0) {
    console.error('\n\u274c contrast check failed:\n');
    for (const f of failures) console.error(`   \u2022 ${f}`);
    console.error('');
    process.exit(1);
}
const tightest = Object.entries(worstBy)
    .map(([theme, w]) => `${w.r.toFixed(2)}:1 ${theme} - ${w.label}`).join('; ');
console.log(
    `\u2713 colour system: ${total} text pairs clear ${MIN}:1 (tightest ${tightest}); `
    + `${fillTotal} accent-fill / bubble / chart / chevron pairs clear their floors `
    + `(accent shape vs ground tightest ${Object.entries(nonText).map(([th, w]) => `${w.r.toFixed(2)}:1 ${th}`).join(', ')}; `
    + `chart accent ${Object.entries(nonTextChart).map(([th, w]) => `${w.r.toFixed(2)}:1 ${th}`).join(', ')}); `
    + `${MUST_DIFFER.length * 2} semantic pair(s) at least ${MIN_HUE_SEPARATION}\u00b0 apart; `
    + `platform colours solid only in data viz`
);
