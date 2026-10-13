/**
 * The Studio scene's timeline and plan (L11), with no WebGL in it, so it can be pinned by a test.
 *
 * The figure it re-draws says: a lesson, what it teaches and its frames, a carousel in 4:5 and 9:16, you review it, and it is
 * scheduled: Instagram and Facebook, and TikTok scheduled or held in a queue until TikTok approves the app. The scene shows
 * that: a lesson turns into a stack of slides that riffle out and fan in depth, one slide turns over to show its keyword lit by
 * the cardamom highlighter (the carousel's campaign keyword: the Studio writes it), the slides pass your review, and one lands
 * on each platform: Instagram and Facebook are received (a ring), TikTok gets the 9:16 version and holds it (a queue, no ring).
 *
 * Time is seconds into a 10-second loop; everything returns numbers in 0..1.
 */
import { clamp01, easeFly, easeStandard, span } from '../core.mjs';

export const LOOP = 10;
/** The slides of the carousel in the stack: a cover, the middle ones, and the last, which asks for the keyword. */
export const SLIDES = 5;
export const KEYWORD_SLIDE = SLIDES - 1;
/** Which slides leave for which place, in the order the figure lists them; the third is the 9:16 version for TikTok. */
export const SENT = [
    { slide: 1, to: 'instagram', ring: true },
    { slide: 2, to: 'facebook', ring: true },
    { slide: 3, to: 'tiktok', ring: false },
];
/** How far apart the stack's slides fan in depth, in the order they were dealt. */
export const FAN = { turn: 0.16, rise: 9 };

export const TIMES = {
    lesson: [0, 0.8],       // the lesson card is there
    riffle: [0.8, 2.2],     // the slides come off it, one after another
    fan: [2.0, 2.8],        // and spread in depth
    flip: [2.5, 3.2],       // the last slide turns over
    sweep: [3.0, 4.3],      // its keyword is lit: --kw-sweep (320 ms) times four
    fly: [4.8, 6.4],        // after the hold (120 ms times four): --kw-deliver (320 ms) times four
    ring: 0.8,              // a received slot rings once: --kw-receipt (200 ms) times four
    away: [8.6, 9.6],
};
export const FLY_GAP = 0.12;
export const FLY_LEN = TIMES.fly[1] - TIMES.fly[0] - FLY_GAP * (SENT.length - 1);

const dealt = (s) => TIMES.riffle[0] + (s / SLIDES) * (TIMES.riffle[1] - TIMES.riffle[0] - 0.6);

/** The lesson card (0..1): there from the start, gone with everything else. */
export const lesson = (u) => span(u, TIMES.lesson) * (1 - span(u, TIMES.away));

/** How far slide `s` has come off the lesson (0..1): dealt one after another, each over 0.6 s. */
export function dealtOut(s, u) {
    return easeStandard(clamp01((u - dealt(s)) / 0.6));
}

/** How far the stack has fanned in depth (0..1). */
export function fanned(u) {
    return easeStandard(span(u, TIMES.fan));
}

/** How far the last slide has turned over (0..1): 0 shows its front, 1 its back, where the keyword is. */
export function flipped(u) {
    return easeStandard(span(u, TIMES.flip));
}

/** How far the highlighter has swept the keyword on the back of the last slide (0..1). */
export function sweep(u) {
    return easeStandard(span(u, TIMES.sweep));
}

/** Where sent slide `j` is on its way (0..1), staggered by FLY_GAP. */
export function fly(j, u) {
    return easeFly(clamp01((u - TIMES.fly[0] - j * FLY_GAP) / FLY_LEN));
}
export const arrival = (j) => TIMES.fly[0] + j * FLY_GAP + FLY_LEN;

/** Passing your review (0..1): the check appears as the slide crosses the middle of the way, and stays. */
export function reviewed(j, u) {
    return clamp01((fly(j, u) - 0.45) / 0.12);
}

/** The TikTok slide becoming the 9:16 version (0..1) over the first part of its flight. */
export function tall(j, u) {
    return SENT[j].to === 'tiktok' ? clamp01(fly(j, u) / 0.35) : 0;
}

/** How much of slide `s` of the stack shows (0..1): the ones that are sent stay in the stack until they leave; the rest let go at the end. */
export function stackAlpha(s, u) {
    const sent = SENT.findIndex((x) => x.slide === s);
    const gone = sent < 0 ? 0 : clamp01((u - (TIMES.fly[0] + sent * FLY_GAP)) / 0.01);
    return dealtOut(s, u) * (1 - gone) * (1 - span(u, TIMES.away));
}

/** How much of sent slide `j` shows while it is on its way and after: a received one goes into its slot, the queued one is held. */
export function sentAlpha(j, u) {
    if (u < TIMES.fly[0] + j * FLY_GAP) return 0;
    if (SENT[j].ring) return 1 - clamp01((u - arrival(j)) / 0.25);
    return (fly(j, u) < 1 ? 1 : 0.6) * (1 - span(u, TIMES.away));
}

/** The ring on a received slot (0..1, then 0): once, from the moment its slide arrives. */
export function ring(j, u) {
    if (!SENT[j].ring) return 0;
    const t = clamp01((u - arrival(j)) / TIMES.ring);
    return t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t);
}
