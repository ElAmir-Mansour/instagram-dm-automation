/**
 * The parts of the hero scene that need no WebGL (L10).
 *
 * scene.mjs draws; this file decides. Everything here is a pure function of its arguments, so the
 * timeline, the colour parser, the slot plan and the budgets can be pinned by core.test.mjs on a
 * machine with no GPU, and so the scene has nothing to get wrong that a test cannot reach.
 */

/** One loop is ten seconds: drift, notice (highlight), answer (deliver), settle. */
export const LOOP = 10;

/** The camera. A narrow lens at a long distance keeps the bubbles flat, which is the look: no lights, fog only. */
export const CAMERA = { fov: 28, z: 14, near: 0.1, far: 40 };

/** Fog is the one depth cue: from this far from the camera, to this far (page colour). */
export const FOG = { near: 12, far: 22 };

export const MAX_DPR = 1.5;

/** What a frame may cost. The scene asserts these through renderer.info under ?debug3d=1; the tests pin the plan. */
export const PROFILES = {
    full: { bubbles: 8, calls: 40, triangles: 3000 },
    lite: { bubbles: 5, calls: 25, triangles: 2000 },
};
export const MAX_TEXTURES = 16;
export const MAX_TEXTURE = { width: 512, height: 192 };

/**
 * highlight -> deliver (IDENTITY.md section 6). The product's motion is 320 ms of sweep, a 120 ms hold, 320 ms of
 * delivery and a 200 ms receipt; the hero shows it four times slower, because it is read, not clicked.
 * Seconds into the loop.
 */
export const TIMES = {
    lift: [2.4, 3.0],     // the commenter's bubble turns to face the camera
    sweep: [3.0, 4.3],    // 320 ms x 4: the highlighter grows from the reading start
    fly: [4.8, 6.4],      // after the 120 ms (x 4) hold: the packet travels
    fade: [6.4, 7.2],     // delivered: it leaves through the card
    back: [7.2, 10],      // and a quiet bubble takes its place
};
/** The DOM card's own receipt (the ring that goes 0 -> --ring -> 0), 200 ms x 4. */
export const RECEIPT_MS = 800;

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress, so the 3D uses the same curves as the tokens. */
export function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const X = (t) => ((ax * t + bx) * t + cx) * t;
    const Y = (t) => ((ay * t + by) * t + cy) * t;
    const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {
            const e = X(t) - x;
            if (Math.abs(e) < 1e-6) return Y(t);
            const d = dX(t);
            if (Math.abs(d) < 1e-6) break;
            t -= e / d;
        }
        let lo = 0, hi = 1;
        t = x;
        for (let i = 0; i < 30; i++) {
            const e = X(t);
            if (Math.abs(e - x) < 1e-6) break;
            if (e < x) lo = t; else hi = t;
            t = (lo + hi) / 2;
        }
        return Y(t);
    };
}
/** tokens.css: --ease-standard and --ease-exit. */
export const easeStandard = cubicBezier(0.16, 1, 0.3, 1);
export const easeExit = cubicBezier(0.4, 0, 1, 1);
/**
 * The flight's own curves. --ease-standard spends most of its distance in the first quarter of the time, which is right for
 * a packet crossing a diagram and wrong here: the card is solid and hides the last part of the path, so what a visitor can
 * see (the leg along the margin) would be over in a quarter of a second. The flight is two legs instead: along the margin
 * for the first FLY_SPLIT of its 1.6 s, symmetric (easeFly), then down through the card, accelerating (easeDive), out of sight.
 */
export const easeFly = cubicBezier(0.45, 0.05, 0.55, 0.95);
export const easeDive = cubicBezier(0.5, 0, 1, 0.8);
export const FLY_SPLIT = 0.64;

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Progress of `t` through [a, b], clamped. */
export const span = (t, [a, b]) => clamp01((t - a) / (b - a));

/**
 * Where one bubble is in the loop, `u` seconds in (0 <= u < LOOP).
 * `flies` is whether its comment carries a keyword: a comment without one is read (it comes forward) and goes
 * back, and is never lit, never sent.
 */
export function phase(u, flies) {
    if (!flies) {
        // Comes forward as it is read, goes back as the next one is read.
        const lift = easeStandard(span(u, TIMES.lift)) * (1 - easeStandard(span(u, TIMES.fade)));
        return { lift, sweep: 0, fly: 0, alpha: 1, delivered: false };
    }
    const faded = span(u, TIMES.fade);
    const back = span(u, TIMES.back);
    // Out through the card (6.4-7.2), then in again from home (7.2-10).
    const alpha = u < TIMES.fade[0] ? 1 : u < TIMES.back[0] ? 1 - faded : easeStandard(back);
    return {
        lift: u >= TIMES.back[0] ? 0 : easeStandard(span(u, TIMES.lift)),
        sweep: u >= TIMES.back[0] ? 0 : easeStandard(span(u, TIMES.sweep)),
        fly: span(u, TIMES.fly), // linear: the scene shapes it into two legs
        alpha,
        delivered: u >= TIMES.fly[1],
    };
}

/** A cubic bezier through four [x, y, z] points, written into `out`. */
export function bezier3(p0, p1, p2, p3, t, out) {
    const m = 1 - t;
    const a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
    for (let i = 0; i < 3; i++) out[i] = a * p0[i] + b * p1[i] + c * p2[i] + d * p3[i];
    return out;
}

export function median(values) {
    if (!values.length) return 0;
    const s = [...values].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A small deterministic generator: the same drift on every load, so a screenshot is a fact and a test can pin it. */
export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * A CSS colour as the token authors it: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()` in the comma
 * and the space/slash syntax. Channels are 0..1 in sRGB, alpha 0..1. null for anything else (the caller keeps its
 * fallback). This exists because Color.setStyle warns when it meets alpha, and the tokens are full of it.
 */
export function parseColor(input) {
    const s = String(input ?? '').trim().toLowerCase();
    let m = /^#([0-9a-f]{3,8})$/.exec(s);
    if (m) {
        let h = m[1];
        if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
        if (h.length !== 6 && h.length !== 8) return null;
        const n = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
        return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
    }
    m = /^rgba?\(\s*([^)]+?)\s*\)$/.exec(s);
    if (!m) return null;
    const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const ch = (p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255);
    const rgb = parts.slice(0, 3).map(ch);
    const a = parts.length === 4 ? (parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    if (rgb.some((v) => !Number.isFinite(v)) || !Number.isFinite(a)) return null;
    return { r: clamp01(rgb[0]), g: clamp01(rgb[1]), b: clamp01(rgb[2]), a: clamp01(a) };
}
/** `rgba(r, g, b, a)` for Canvas 2D, from a parsed colour. */
export const cssColor = ({ r, g, b, a }, alpha = 1) =>
    `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${+(a * alpha).toFixed(3)})`;

/** What may follow a keyword for it to be a word of its own (the landing test pins the same list on the markup). */
const AFTER = new Set([' ', '؟', '?', '،', '.', ',']);

/**
 * Split a comment at its keyword: {before, word, after}, or null when it has none or the keyword is not a word of
 * its own there (a keyword inside another word would light half of it). Matched on code points, so Arabic is exact.
 */
export function splitAtKeyword(text, kw) {
    if (!kw) return null;
    const at = text.indexOf(kw);
    if (at < 0) return null;
    const next = text[at + kw.length];
    if ((at > 0 && text[at - 1] !== ' ') || next === undefined || !AFTER.has(next)) return null;
    return { before: text.slice(0, at), word: kw, after: text.slice(at + kw.length) };
}

/**
 * Where each bubble rests, in the order they are used (the lite profile takes the first five). A slot is placed
 * against the card, not the canvas, so it follows the card at every width:
 *   edge  which margin of the card it sits in: 'top' | 'bottom' | 'start' | 'end'
 *   along 0..1 along that edge, from the reading start of the card
 *   z     depth: 0 is the card's plane, negative is behind it
 *   s     size
 *   ry    how far it is turned away (radians; mirrored for RTL by the scene)
 * Deeper means smaller, quieter (fog) and slower to parallax past.
 */
export const SLOTS = [
    { edge: 'top',    along: 0.10, z: -0.5, s: 1.0,  ry: 0.20 },
    { edge: 'bottom', along: 0.84, z: -0.7, s: 1.0,  ry: -0.18 },
    { edge: 'top',    along: 0.66, z: -2.4, s: 0.92, ry: -0.24 },
    { edge: 'bottom', along: 0.18, z: -2.2, s: 0.92, ry: 0.24 },
    { edge: 'top',    along: 0.40, z: -4.8, s: 0.88, ry: 0.14 },
    { edge: 'start',  along: 0.30, z: -3.0, s: 0.92, ry: 0.32 },
    { edge: 'end',    along: 0.72, z: -3.4, s: 0.92, ry: -0.32 },
    { edge: 'bottom', along: 0.52, z: -5.0, s: 0.88, ry: -0.12 },
];

/** How many bubbles a profile shows for a given list of comments. */
export function bubbleCount(profile, comments) {
    return Math.min(PROFILES[profile].bubbles, comments.length, SLOTS.length);
}

/** The loop a given absolute time is in, and how far into it. */
export function loopAt(T) {
    const k = Math.floor(T / LOOP);
    return { k, u: T - k * LOOP };
}

// ── The bubble's shape ─────────────────────────────────────────────────────────────────────────────────────────────
// Built by hand, not with three's Shape and ShapeGeometry: those drag in an earcut triangulator, curve classes and path
// classes (about 7 KB gzipped) to cut up what is a convex rounded rectangle and the band round it. Flat: no bevel, no
// UVs, no normals (the material is unlit and untextured), counter-clockwise as seen from +z so front-face culling and the
// hover raycast agree with what the camera sees, centred on the origin at z = 0.

/** Segments in each quarter-circle corner. */
export const CORNER_SEGMENTS = 12;

/** The outline of a rounded rectangle centred on the origin, counter-clockwise from +z: 4 * (segments + 1) points. */
export function roundedRectContour(w, h, r, segments = CORNER_SEGMENTS) {
    const points = [];
    const cx = w / 2 - r, cy = h / 2 - r;
    // Each corner's centre and where its quarter turn starts (degrees), in counter-clockwise order from the bottom right.
    for (const [x, y, from] of [[cx, -cy, -90], [cx, cy, 0], [-cx, cy, 90], [-cx, -cy, 180]]) {
        for (let i = 0; i <= segments; i++) {
            const a = ((from + (90 * i) / segments) * Math.PI) / 180;
            points.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
        }
    }
    return points;
}

/** The body: a triangle fan from the centre (vertex 0) round the outline. */
export function roundedRectBody(w, h, r, segments = CORNER_SEGMENTS) {
    const outline = roundedRectContour(w, h, r, segments);
    const n = outline.length;
    const positions = new Float32Array((n + 1) * 3);
    outline.forEach(([x, y], i) => positions.set([x, y, 0], (i + 1) * 3));
    const index = new Uint16Array(n * 3);
    for (let i = 0; i < n; i++) index.set([0, 1 + i, 1 + ((i + 1) % n)], i * 3);
    return { positions, index };
}

/**
 * The ring: a strip between the outline and the same outline inset by `ring` with the corner radius reduced by `ring`
 * (so the band has one thickness all the way round). Outer vertices first, then inner; two triangles per segment.
 */
export function roundedRectRing(w, h, r, ring, segments = CORNER_SEGMENTS) {
    const outer = roundedRectContour(w, h, r, segments);
    const inner = roundedRectContour(w - 2 * ring, h - 2 * ring, r - ring, segments);
    const n = outer.length;
    const positions = new Float32Array(n * 2 * 3);
    outer.forEach(([x, y], i) => positions.set([x, y, 0], i * 3));
    inner.forEach(([x, y], i) => positions.set([x, y, 0], (n + i) * 3));
    const index = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
        const o0 = i, o1 = (i + 1) % n, i0 = n + i, i1 = n + ((i + 1) % n);
        index.set([o0, o1, i1, o0, i1, i0], i * 6);
    }
    return { positions, index };
}
