/**
 * The platform map's timeline (L11), with no WebGL in it, so a test can pin it.
 *
 * The table says: which platform can do what. Comment-to-DM is Instagram and Facebook; TikTok and YouTube have no such thing,
 * and the table says so with a dash. The scene shows the table's rows settling into place in a little depth, swaying a hair, and
 * the one thing the product does on a comment: the platform's name is lit by the cardamom highlighter (the comment that matched),
 * a message leaves its logo for its own "Comment to DM" cell and the cell rings once. A row whose cell is a dash never gets a message.
 *
 * Time is seconds. The settling happens once, from the scene's first frame (T); the highlight and the messages loop every LOOP.
 */
import { clamp01, easeFly, easeStandard, span } from '../core.mjs';

export const LOOP = 10;
/** The table's rows settle one after another, each over ROW_LEN, the first one at T = 0. */
export const ROW_GAP = 0.2;
export const ROW_LEN = 0.8;
export const TIMES = {
    sweep: [3.0, 4.3],      // the platform's name is lit: --kw-sweep (320 ms) times four
    fly: [4.8, 6.4],        // after the hold (120 ms times four): --kw-deliver (320 ms) times four
    ring: 0.8,              // a received cell rings once: --kw-receipt (200 ms) times four
    away: [8.6, 9.6],
};
/** The second message leaves a little after the first: one event after another, not two at once. */
export const FLY_GAP = 0.3;
export const FLY_LEN = TIMES.fly[1] - TIMES.fly[0] - FLY_GAP;
/** How far back, in pixels, and how far tipped, in radians, a row starts from. */
export const SETTLE = { rise: 56, tip: 0.5 };
/** The sway a settled row keeps: tiny, so what it says stays exactly where the table puts it. */
export const SWAY = { x: 0.018, y: 0.026, z: 2.4 };

/** How far row `r` has settled (0..1): from T = 0, staggered, and never again. */
export function rowIn(r, T) {
    return easeStandard(clamp01((T - r * ROW_GAP) / ROW_LEN));
}

/** The gentle drift of row `r` at time T: { x, y } are tips in radians, z a bob in pixels. Slow, out of step from row to row. */
export function sway(r, T) {
    return {
        x: SWAY.x * Math.sin(T * 0.7 + r * 1.3),
        y: SWAY.y * Math.sin(T * 0.5 + r * 0.9),
        z: SWAY.z * Math.sin(T * 0.9 + r * 1.7),
    };
}

/** How far the highlighter has swept the platform's name (0..1). */
export function lit(u) {
    return easeStandard(span(u, TIMES.sweep));
}
/** How much of the highlighter shows: all of it until the end of the loop, which lets go. */
export const litAlpha = (u) => 1 - span(u, TIMES.away);

/** Where message `k` is on its way (0..1), staggered by FLY_GAP. */
export function fly(k, u) {
    return easeFly(clamp01((u - TIMES.fly[0] - k * FLY_GAP) / FLY_LEN));
}
export const arrival = (k) => TIMES.fly[0] + k * FLY_GAP + FLY_LEN;

/** How much of message `k` shows: from when it leaves until it is put into its cell. */
export function messageAlpha(k, u) {
    const start = TIMES.fly[0] + k * FLY_GAP;
    if (u < start) return 0;
    return clamp01((u - start) / 0.12) * (1 - clamp01((u - arrival(k) + 0.12) / 0.12));
}

/** The ring on a received cell (0..1, then 0): once, from the moment its message arrives. */
export function ring(k, u) {
    const t = clamp01((u - arrival(k)) / TIMES.ring);
    return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t);
}
