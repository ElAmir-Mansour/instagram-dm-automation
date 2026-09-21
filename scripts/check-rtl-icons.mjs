#!/usr/bin/env node
/**
 * Guards RTL icon mirroring.
 *
 * The dashboard is RTL-first Arabic. An icon whose meaning depends on reading direction —
 * a back arrow, a send button — points the wrong way in RTL unless it is mirrored. An icon
 * whose meaning does NOT depend on reading direction — a clock, a clockwise refresh arrow —
 * becomes wrong if you mirror it: `rotate-cw` mirrored reads counter-clockwise.
 *
 * Material Design 3 is the one published design system with an enumerated rule for this,
 * and it is explicit in both directions:
 * https://m3.material.io/foundations/layout/bidirectionality-rtl
 *
 * This used to be three hand-written per-component CSS rules covering four icons. They were
 * correct, but they had to be remembered — so the failure mode was a new directional icon
 * silently pointing the wrong way, in the language the product is actually used in. Nothing
 * would catch that: it renders fine, it just reads backwards.
 *
 * Two checks:
 *   1. Every DIRECTIONAL icon in use must be in the mirror list in styles.css.
 *   2. No NEVER_MIRROR icon may be in that list.
 *
 * Unknown icons are reported as a note, not a failure — the taxonomy below cannot be
 * exhaustive over lucide's whole set, and a new *non*-directional icon is the common case.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const DASHBOARD = 'dashboard';
const STYLES = 'dashboard/css/styles.css';

/** Meaning depends on reading direction — must mirror in RTL. */
const DIRECTIONAL = new Set([
    'arrow-left', 'arrow-right', 'arrow-left-to-line', 'arrow-right-to-line',
    'move-left', 'move-right',
    'chevron-left', 'chevron-right', 'chevrons-left', 'chevrons-right',
    'circle-chevron-left', 'circle-chevron-right',
    'square-chevron-left', 'square-chevron-right',
    'corner-down-left', 'corner-down-right', 'corner-up-left', 'corner-up-right',
    'send', 'send-horizontal', 'reply', 'reply-all', 'forward',
    'log-in', 'log-out', 'external-link',
    'indent-increase', 'indent-decrease',
]);

/**
 * Meaning does NOT depend on reading direction — mirroring these is a bug, not an omission.
 * MD3 names clocks, circular refresh and clockwise progress explicitly; the rest are the
 * same principle (a magnifying glass and a vertical arrow carry no reading direction).
 */
const NEVER_MIRROR = new Set([
    'rotate-cw', 'rotate-ccw', 'refresh-cw', 'refresh-ccw',
    'clock', 'calendar-clock', 'file-clock', 'calendar', 'calendar-days',
    'check', 'check-circle', 'x', 'search',
    'download', 'upload', 'chevron-up', 'chevron-down', 'chevrons-down-up', 'chevrons-up-down',
    'play', 'pause', 'square', 'skip-forward', 'skip-back',
    'trending-up', 'trending-down', 'bar-chart-3',
]);

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (['.js', '.html'].includes(extname(p))) out.push(p);
    }
    return out;
}

/** Every icon the dashboard renders, with one example file each. */
const inUse = new Map();
for (const file of walk(DASHBOARD)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/data-lucide=["']([a-z0-9-]+)["']/g)) {
        if (!inUse.has(m[1])) inUse.set(m[1], file);
    }
}

/** Icons the stylesheet mirrors under html[dir='rtl']. */
const css = readFileSync(STYLES, 'utf8');
const mirrored = new Set(
    [...css.matchAll(/html\[dir=['"]rtl['"]\]\s*\[data-lucide=['"]([a-z0-9-]+)['"]\]/g)].map(m => m[1])
);

const fail = [];

/**
 * A name-shape fallback, because the taxonomy above cannot enumerate all of lucide.
 *
 * Any icon whose name contains `left` or `right` as a word almost certainly encodes a
 * reading direction — `arrow-big-right`, `panel-left-open`, `align-right`. Without this,
 * such an icon is waved through as "unknown, assumed non-directional", which is exactly
 * the silent-wrong-way failure this script exists to prevent. NEVER_MIRROR still wins, so
 * a deliberate exception is a one-line addition there rather than a special case here.
 */
const looksDirectional = (icon) => /(^|-)(left|right)(-|$)/.test(icon);

for (const [icon, file] of inUse) {
    if (!DIRECTIONAL.has(icon) && !NEVER_MIRROR.has(icon) && looksDirectional(icon) && !mirrored.has(icon)) {
        fail.push(
            `'${icon}' is not in the taxonomy but its name encodes a reading direction ` +
            `(first used in ${file}).\n` +
            `      Either add it to DIRECTIONAL in this script and to the RTL icon block in ${STYLES},\n` +
            `      or — if it genuinely must not mirror — add it to NEVER_MIRROR here with a reason.`
        );
        continue;
    }
    if (DIRECTIONAL.has(icon) && !mirrored.has(icon)) {
        fail.push(
            `'${icon}' is directional but is not mirrored in RTL (first used in ${file}).\n` +
            `      Add   html[dir='rtl'] [data-lucide='${icon}'],   to the RTL icon block in ${STYLES}.`
        );
    }
}

for (const icon of mirrored) {
    if (NEVER_MIRROR.has(icon)) {
        fail.push(
            `'${icon}' is mirrored in RTL but its meaning does not depend on reading direction.\n` +
            `      Mirroring it is a bug — a clockwise arrow would read counter-clockwise. ` +
            `Remove it from the RTL icon block in ${STYLES}.`
        );
    }
}

if (fail.length > 0) {
    console.error('\n❌ RTL icon mirroring check failed:\n');
    for (const f of fail) console.error(`   • ${f}\n`);
    process.exit(1);
}

const usedDirectional = [...inUse.keys()].filter(i => DIRECTIONAL.has(i));
const unknown = [...inUse.keys()].filter(i => !DIRECTIONAL.has(i) && !NEVER_MIRROR.has(i) && !looksDirectional(i));
console.log(
    `✓ RTL icons: ${usedDirectional.length} directional icon(s) in use, all mirrored; ` +
    `${mirrored.size} rule(s) in the stylesheet.`
);
if (unknown.length > 0) {
    console.log(`  note: ${unknown.length} icon(s) not in the taxonomy (assumed non-directional): ${unknown.slice(0, 12).join(', ')}${unknown.length > 12 ? ', …' : ''}`);
}
