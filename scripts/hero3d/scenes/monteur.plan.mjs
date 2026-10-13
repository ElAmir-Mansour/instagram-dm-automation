/**
 * The Monteur scene's timeline and plan (L11), with no WebGL in it, so it can be pinned by a test.
 *
 * The figure it re-draws says: a long video in its folder, listened to on a Mac, moments that open with a hook, a 9:16 reel with
 * a title, captions and a cover, your approval, and your slots on the platforms you choose (Instagram, Facebook, YouTube, and
 * TikTok as a draft only you see). The scene shows exactly that, and nothing the figure does not say: a strip of the long
 * video, the hooks lit on it by the cardamom highlighter, each hook cut out as a reel, the reels passing your approval, and
 * one landing on each platform. Four times the product's tempo (IDENTITY.md section 6), like the hero.
 *
 * Time is seconds into a 10-second loop. Everything returns numbers in 0..1 and the scene maps them to space.
 */
import { clamp01, easeFly, easeStandard, span } from '../core.mjs';

export const LOOP = 10;
/** Frames in the strip of the long video, and which of them a hook opens: four, one reel for each place the figure names. */
export const CELLS = 10;
export const HOOKS = [5, 6, 7, 8];
/** Where the four reels go, in the order the figure lists them: Instagram, Facebook and YouTube are slots; TikTok is a draft. */
export const TARGETS = ['instagram', 'facebook', 'youtube', 'tiktok'];
/** Which of those a ring answers: a scheduled slot is received; a TikTok draft is only placed in the drafts. */
export const SCHEDULED = [true, true, true, false];

export const TIMES = {
    strip: [0, 1.6],        // the strip comes out of the folder
    listen: [1.2, 3.0],     // the Mac listens to it
    sweep: [3.0, 4.3],      // the highlighter sweeps the hooks: --kw-sweep (320 ms) times four
    fly: [4.8, 6.4],        // the reels leave, one after another: --kw-deliver (320 ms) times four, with the hold (120 ms times four) before
    ring: 0.8,              // a received slot rings once: --kw-receipt (200 ms) times four
    away: [8.6, 9.6],       // everything lets go before the loop starts again
};
export const FLY_GAP = 0.1;
export const FLY_LEN = TIMES.fly[1] - TIMES.fly[0] - FLY_GAP * (HOOKS.length - 1);

/** How far cell `i` has come out of the folder (0..1): one after another, each over 0.4 s. */
export function cellIn(i, u) {
    const rise = clamp01((u - TIMES.strip[0] - (i / CELLS) * (TIMES.strip[1] - TIMES.strip[0] - 0.4)) / 0.4);
    return rise * (1 - span(u, TIMES.away));
}

/** How loud the Mac is listening (0..1): a bell over its window, so the waveform swells and settles. */
export function listening(u) {
    const t = span(u, TIMES.listen);
    return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t);
}

/** How far the highlighter has swept across the hooks (0..1). */
export function sweep(u) {
    return easeStandard(span(u, TIMES.sweep));
}

/** How far hook `j` is lit: the sweep covers the four in turn, from the reading start. */
export function lit(j, u) {
    return clamp01(sweep(u) * HOOKS.length - j);
}

/** Where reel `j` is on its way (0..1): staggered by FLY_GAP, each over FLY_LEN, symmetric so the visible part is a good half of it. */
export function fly(j, u) {
    const start = TIMES.fly[0] + j * FLY_GAP;
    return easeFly(clamp01((u - start) / FLY_LEN));
}

/** The moment reel `j` arrives. */
export const arrival = (j) => TIMES.fly[0] + j * FLY_GAP + FLY_LEN;

/** The cell becoming a reel (0..1) over the first fifth of its flight: from a frame of the strip to a 9:16 card. */
export function becomes(j, u) {
    return clamp01(fly(j, u) / 0.2);
}

/** Reel `j` passing your approval (0..1): the check mark appears as it crosses the middle of the way, and stays. */
export function approved(j, u) {
    return clamp01((fly(j, u) - 0.45) / 0.12);
}

/** How much of reel `j` shows (0..1): the lit cell until it leaves, the card in flight, then a delivered reel goes into its slot. */
export function reelAlpha(j, u) {
    const f = fly(j, u);
    if (u < TIMES.fly[0] + j * FLY_GAP) return 0;
    if (SCHEDULED[j]) return 1 - clamp01((u - arrival(j)) / 0.25);
    // A TikTok draft stays where it was put, a little quieter, until everything lets go.
    return (f < 1 ? 1 : 0.6) * (1 - span(u, TIMES.away));
}

/** The ring on a received slot (0..1, then 0): once, 0 -> 1 -> 0, from the moment its reel arrives. */
export function ring(j, u) {
    if (!SCHEDULED[j]) return 0;
    const t = clamp01((u - arrival(j)) / TIMES.ring);
    return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t);
}

/** The lit hook cell is shown until its reel has left it; then the strip's frame behind it is just a frame. */
export const litAlpha = (j, u) => (u < TIMES.fly[0] + j * FLY_GAP ? 1 : 0) * (1 - span(u, TIMES.away));
