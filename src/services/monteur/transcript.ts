/**
 * The transcript as the Monteur reads it, and the code that turns its answer into clips
 * (MONTEUR.md §6 and §6.1). Pure: no database, no model.
 *
 * The model answers with LINE NUMBERS, never times. Times it copies drift (a model rounds, or
 * reads 01:05.3 as 65.3 minutes); a line number is either right or visibly out of range. Code
 * then owns every number in the cut, in this order:
 *
 *   gates   hook ≤ 1 or alone ≤ 1 is dropped; rank = 3·hook + alone + payoff + send, kept at ≥ 9
 *   snap    an edge made by the 12 s forced line break moves to the nearest punctuation or 0.3 s
 *           pause within 2 s, or the clip is dropped: it would start or end mid-sentence
 *   guard   a clip opening on «وبعدين», «يعني», «زي ما قلت»… needs what came before it: dropped
 *   length  first word − 0.15 s to last word + 0.3 s, inside [min_seconds, max_seconds]
 *   dedupe  60% of its words shared with a live clip, or one from the last 90 days: dropped
 *   overlap two clips never share a word; where they border, both cut at the gap's midpoint
 *   keep    the best `reels_per_video`, shown as score = round(rank / 1.8)
 */
import type { ClipScores, HookType, TranscriptWord } from '../../db/rows.js';
import { normalizeArabic } from '../../utils/arabic.js';
import { trimText } from '../studio/generate.js';
import { oneLine } from '../studio/prompts.js';

/** A silence this long ends a line. */
export const LINE_PAUSE_S = 0.6;
/** A line never runs longer than this: the model needs somewhere to cut a monologue. */
export const LINE_MAX_S = 12;
/** A cut starts this far before the first word, so its first syllable is not clipped. */
export const LEAD_IN_S = 0.15;
/** And ends this far after the last word, so the last word is not swallowed. */
export const TAIL_S = 0.3;
/** §6.1: an edge from a forced break moves at most this far, to a pause at least this long. */
export const SNAP_WINDOW_S = 2;
export const SNAP_PAUSE_S = 0.3;
/** §6.1: `rank = 3·hook + alone + payoff + send`, each 0–3, so 0–18; kept at this or more. */
export const MIN_RANK = 9;
/** §6.1: a clip sharing this much of its words with another is the same idea. */
export const DEDUPE_OVERLAP = 0.6;
export const MAX_TITLE = 60;
export const HOOK_TYPES: readonly HookType[] = ['promise', 'problem', 'intent', 'question'];
const MAX_HOOK = 500;
const MAX_WHY = 300;
const MAX_TOPIC = 200;
const EPSILON = 1e-6;

/** Sentence punctuation, Latin and Arabic, with any closing quote or bracket after it. */
const SENTENCE_END = /[.!?؟…۔]["'»”)\]]*$/u;
/** Any punctuation that ends a word: where a cut may fall inside a sentence. */
const ANY_PUNCTUATION = /[.!?؟…۔,،;:؛]["'»”)\]]*$/u;

export interface TranscriptLine {
    /** 1-based: what the model sees as `L<n>`. */
    n: number;
    /** Index of the line's first and last word in the source's words. */
    first: number;
    last: number;
    t0: number;
    t1: number;
    text: string;
    /** The line begins, or ends, where the 12 s limit cut a sentence rather than a pause or a full stop. */
    forcedStart: boolean;
    forcedEnd: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Words grouped into lines: a line ends at sentence punctuation, before a pause of 0.6 s or more,
 * and before a word that would take it past 12 s — the only break that can fall mid-sentence.
 */
export function groupLines(words: readonly TranscriptWord[]): TranscriptLine[] {
    const lines: TranscriptLine[] = [];
    let first = -1;
    let forcedStart = false;
    const close = (last: number, forced: boolean): void => {
        if (first < 0 || last < first) return;
        const text = words.slice(first, last + 1).map((w) => w[2].trim()).filter(Boolean).join(' ');
        lines.push({ n: lines.length + 1, first, last, t0: words[first]![0], t1: words[last]![1], text, forcedStart, forcedEnd: forced });
        first = -1;
        forcedStart = forced;
    };
    words.forEach((word, i) => {
        if (first >= 0) {
            // Times have two decimals, and 1.9 − 1.3 is 0.5999… in floating point: compare with a margin.
            const pause = word[0] - words[i - 1]![1];
            if (pause >= LINE_PAUSE_S - EPSILON) close(i - 1, false);
            else if (word[1] - words[first]![0] > LINE_MAX_S + EPSILON) close(i - 1, true);
        }
        if (first < 0) first = i;
        if (SENTENCE_END.test(word[2].trim())) close(i, false);
    });
    close(words.length - 1, false);
    return lines;
}

/** `65.34` → `01:05.3`. Minutes keep counting past 59, which a line number never needs to parse. */
export function formatStamp(t: number): string {
    const tenths = Math.max(0, Math.round(t * 10));
    const minutes = Math.floor(tenths / 600);
    const seconds = (tenths % 600) / 10;
    return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/** The transcript as sent: one `L<n> [mm:ss.s] text` per line. */
export function formatLines(lines: readonly TranscriptLine[]): string {
    return lines.map((l) => `L${l.n} [${formatStamp(l.t0)}] ${l.text}`).join('\n');
}

/** How long the whole transcript is: what no clip can exceed. */
export function spokenSpan(lines: readonly TranscriptLine[]): number {
    return lines.length ? lines[lines.length - 1]!.t1 - lines[0]!.t0 : 0;
}

// ─── Words, for the guard and the dedupe ────────────────────────────────────────────────

/** Normalised word tokens: Arabic folded as the matcher folds it, punctuation gone. */
export function tokens(text: string): string[] {
    return normalizeArabic(text).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
}

/**
 * How much of the smaller text's vocabulary the other one has, 0–1 (words of 3 letters or more,
 * so «في» and «the» don't make two unrelated lines look alike).
 */
export function textOverlap(a: string, b: string): number {
    const A = new Set(tokens(a).filter((w) => w.length >= 3));
    const B = new Set(tokens(b).filter((w) => w.length >= 3));
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const w of A) if (B.has(w)) shared++;
    return shared / Math.min(A.size, B.size);
}

/** Openings that lean on what was said before them (§6.1), as normalised token sequences. */
const LEANING_OPENINGS: readonly string[][] = [
    ['وبعدين'], ['فبعدين'], ['يعني'], ['بس'], ['عشان', 'كذا'], ['زي', 'ما', 'قلت'],
    ['ف', 'لما'], ['ف', 'اذا'], ['ف', 'هذا'], ['فلما'], ['فاذا'], ['فهذا'],
].map((seq) => seq.map((w) => normalizeArabic(w)));

/** The opening this clip leans on, or null when it can start cold. */
export function leaningOpening(text: string): string | null {
    const first = tokens(text).slice(0, 3);
    const hit = LEANING_OPENINGS.find((seq) => seq.every((w, i) => first[i] === w));
    return hit ? hit.join(' ') : null;
}

// ─── The cut ────────────────────────────────────────────────────────────────────────────

/** A cut may fall before word `j`: it starts the transcript, or follows punctuation or a 0.3 s pause. */
function cutBefore(words: readonly TranscriptWord[], j: number): boolean {
    if (j <= 0 || j >= words.length) return true;
    return ANY_PUNCTUATION.test(words[j - 1]![2].trim()) || words[j]![0] - words[j - 1]![1] >= SNAP_PAUSE_S - EPSILON;
}

/** The instant a cut before word `k` falls at: the middle of the gap between words k−1 and k. */
function cutInstant(words: readonly TranscriptWord[], k: number): number {
    if (k <= 0) return words[0]![0];
    if (k >= words.length) return words[words.length - 1]![1];
    return (words[k - 1]![1] + words[k]![0]) / 2;
}

/**
 * Where a boundary the 12 s limit made — a cut before word `b` — really cuts: before the word
 * whose cut is natural (punctuation, or a 0.3 s pause) and nearest the boundary's own instant,
 * within 2 s; the earlier on a tie. Null when there is none. The clip ending at the boundary and
 * the clip starting at it both ask with the same `b`, so they cut at the same point and can
 * never share a word.
 */
export function snapBoundary(words: readonly TranscriptWord[], b: number): number | null {
    const at = cutInstant(words, b);
    let best: number | null = null;
    for (let k = 1; k < words.length; k++) {
        if (!cutBefore(words, k)) continue;
        const d = Math.abs(cutInstant(words, k) - at);
        if (d > SNAP_WINDOW_S + EPSILON) continue;
        if (best === null || d < Math.abs(cutInstant(words, best) - at) - EPSILON) best = k;
    }
    return best;
}

/**
 * The clip's first and last word. An edge the 12 s limit made is moved to the nearest natural
 * cut (`snapBoundary`); null when there is none within 2 s.
 */
export function snapEdges(
    lines: readonly TranscriptLine[], words: readonly TranscriptWord[], startLine: number, endLine: number
): { startWord: number; endWord: number } | null {
    const startL = lines[startLine - 1]!;
    const endL = lines[endLine - 1]!;
    let startWord = startL.first;
    let endWord = endL.last;
    if (startL.forcedStart) {
        const b = snapBoundary(words, startL.first);
        if (b === null) return null;
        startWord = b;
    }
    if (endL.forcedEnd) {
        const b = snapBoundary(words, endL.last + 1);
        if (b === null) return null;
        endWord = b - 1;
    }
    return startWord <= endWord ? { startWord, endWord } : null;
}

/** Where words `startWord..endWord` cut, in seconds of the source: lead-in and tail, clamped to the video. */
export function cutTimes(
    words: readonly TranscriptWord[], startWord: number, endWord: number, duration: number | null
): { start: number; end: number } {
    const first = words[startWord]!;
    const last = words[endWord]!;
    const ceiling = duration !== null && duration > 0 ? Math.max(duration, last[1]) : Number.POSITIVE_INFINITY;
    return { start: round2(Math.max(0, first[0] - LEAD_IN_S)), end: round2(Math.min(ceiling, last[1] + TAIL_S)) };
}

/** Where a clip of whole lines cuts. The lines' own edges, with the lead-in and tail. */
export function snapClip(
    lines: readonly TranscriptLine[], words: readonly TranscriptWord[], startLine: number, endLine: number,
    duration: number | null
): { start: number; end: number } {
    return cutTimes(words, lines[startLine - 1]!.first, lines[endLine - 1]!.last, duration);
}

export interface PickedClip {
    /** 1 = the best. */
    rank: number;
    startLine: number;
    endLine: number;
    startWord: number;
    endWord: number;
    start: number;
    end: number;
    title: string;
    /** The spoken opening line. */
    hook: string;
    why: string | null;
    /** 0–10: round(rank / 1.8). */
    score: number;
    scores: ClipScores;
    hookType: HookType | null;
    /** Every word of the clip, for the next pick's dedupe. */
    text: string;
}

export interface ClipChoice {
    kept: PickedClip[];
    /** The video's main idea, as the model put it. */
    topic: string | null;
    /** How many clips the model proposed. */
    considered: number;
    /** What a repair round would be told: lines that don't exist, cuts that can't be made. */
    problems: string[];
}

const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const subScore = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(3, Math.max(0, v))) : 0);

/**
 * The model's answer turned into clips by the rules in the header. A wrong line number, a cut
 * that can't be made, an opening that leans on what came before, a length out of range or a
 * repeat is a problem a repair round is told about; a weak score is simply not a reel.
 */
export function chooseClips(
    raw: unknown,
    lines: readonly TranscriptLine[],
    words: readonly TranscriptWord[],
    opts: { minSeconds: number; maxSeconds: number; keep: number; duration: number | null; existingTexts?: readonly string[] }
): ClipChoice {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const proposed = Array.isArray(r.clips) ? r.clips : [];
    const topic = typeof r.topic === 'string' && oneLine(r.topic) ? trimText(oneLine(r.topic), MAX_TOPIC) : null;
    const problems: string[] = [];
    type Candidate = Omit<PickedClip, 'rank' | 'score'> & { total: number };
    const candidates: Candidate[] = [];
    const existing = opts.existingTexts ?? [];

    proposed.forEach((item, i) => {
        const c = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
        const label = `clip ${i + 1}`;
        const s = intOf(c.start_line);
        const e = intOf(c.end_line);
        if (s === null || e === null || s < 1 || e > lines.length || s > e) {
            problems.push(`${label}: L${String(c.start_line)}–L${String(c.end_line)} is not a range of lines (L1–L${lines.length}, start before end)`);
            return;
        }
        const title = typeof c.title === 'string' ? trimText(oneLine(c.title), MAX_TITLE) : '';
        if (!title) {
            problems.push(`${label}: the title is empty`);
            return;
        }
        const raw = c.scores && typeof c.scores === 'object' ? (c.scores as Record<string, unknown>) : {};
        const scores: ClipScores = { hook: subScore(raw.hook), alone: subScore(raw.alone), payoff: subScore(raw.payoff), send: subScore(raw.send) };
        const total = 3 * scores.hook + scores.alone + scores.payoff + scores.send;
        // The model's own judgement that it is weak: not a reel, and nothing to repair.
        if (scores.hook <= 1 || scores.alone <= 1 || total < MIN_RANK) return;

        const edges = snapEdges(lines, words, s, e);
        if (!edges) {
            problems.push(`${label}: L${s}–L${e} would cut mid-sentence (no pause or punctuation within ${SNAP_WINDOW_S} s of its edge)`);
            return;
        }
        const text = words.slice(edges.startWord, edges.endWord + 1).map((w) => w[2].trim()).filter(Boolean).join(' ');
        const leaning = leaningOpening(text);
        if (leaning) {
            problems.push(`${label}: L${s} opens on «${leaning}», which needs what was said before it`);
            return;
        }
        const { start, end } = cutTimes(words, edges.startWord, edges.endWord, opts.duration);
        const length = round2(end - start);
        if (length < opts.minSeconds || length > opts.maxSeconds) {
            problems.push(`${label}: L${s}–L${e} is ${length.toFixed(1)} s; a clip must be ${opts.minSeconds}–${opts.maxSeconds} s`);
            return;
        }
        if (existing.some((t) => textOverlap(text, t) >= DEDUPE_OVERLAP)) {
            problems.push(`${label}: L${s}–L${e} repeats a reel already made`);
            return;
        }
        const hookEnd = Math.max(edges.startWord, lines[s - 1]!.last);
        const why = typeof c.why === 'string' && oneLine(c.why) ? trimText(oneLine(c.why), MAX_WHY) : null;
        candidates.push({
            startLine: s, endLine: e, startWord: edges.startWord, endWord: edges.endWord, start, end, title, why, scores, total,
            hookType: (HOOK_TYPES as readonly unknown[]).includes(c.hook_type) ? (c.hook_type as HookType) : null,
            hook: trimText(words.slice(edges.startWord, hookEnd + 1).map((w) => w[2].trim()).filter(Boolean).join(' '), MAX_HOOK),
            text,
        });
    });

    // Best first; on a tie the earlier moment. A clip sharing a word with a better one, or saying
    // the same thing as one, goes. Clips that only border each other both stay, cut at the gap.
    candidates.sort((a, b) => b.total - a.total || a.start - b.start);
    const kept: Candidate[] = [];
    for (const c of candidates) {
        if (kept.some((k) => c.startWord <= k.endWord && k.startWord <= c.endWord)) continue;
        if (kept.some((k) => textOverlap(c.text, k.text) >= DEDUPE_OVERLAP)) continue;
        kept.push(c);
        if (kept.length === Math.max(0, opts.keep)) break;
    }
    for (const a of kept) {
        for (const b of kept) {
            if (a === b || a.endWord >= b.startWord || !(a.end > b.start)) continue;
            // a is before b and their padding meets: both cut at the middle of the gap between them.
            const mid = round2((words[a.endWord]![1] + words[b.startWord]![0]) / 2);
            a.end = Math.min(a.end, mid);
            b.start = Math.max(b.start, mid);
        }
    }
    return {
        kept: kept.map(({ total, ...c }, i) => ({ ...c, rank: i + 1, score: Math.round(total / 1.8) })),
        topic,
        considered: proposed.length,
        problems,
    };
}
