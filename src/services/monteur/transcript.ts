/**
 * The transcript as the Monteur reads it, and the code that turns its answer into clips
 * (MONTEUR.md §6.1). Pure: no database, no model.
 *
 * The model answers with LINE NUMBERS, never times. Times it copies drift (a model rounds, or
 * reads 01:05.3 as 65.3 minutes); a line number is either right or visibly out of range. Code
 * then owns every number in the cut:
 *
 *   start   the first word's t0 − 0.15 s, never before 0
 *   end     the last word's t1 + 0.3 s, never past the source's end
 *   length  inside [min_seconds, max_seconds], or the clip is dropped
 *   overlap two clips never share a second: the higher score keeps it
 *   keep    the best `reels_per_video` that score at least 5
 */
import type { TranscriptWord } from '../../db/rows.js';
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
/** MONTEUR.md §6.1: a clip scoring less is not worth a reel. */
export const MIN_SCORE = 5;
export const MAX_TITLE = 60;
const MAX_HOOK = 500;
const MAX_WHY = 300;
const EPSILON = 1e-6;

/** Sentence punctuation, Latin and Arabic, with any closing quote or bracket after it. */
const SENTENCE_END = /[.!?؟…۔]["'»”)\]]*$/u;

export interface TranscriptLine {
    /** 1-based: what the model sees as `L<n>`. */
    n: number;
    /** Index of the line's first and last word in the source's words. */
    first: number;
    last: number;
    t0: number;
    t1: number;
    text: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Words grouped into lines: a line ends at sentence punctuation, before a pause of 0.6 s or more,
 * and before a word that would take it past 12 s.
 */
export function groupLines(words: readonly TranscriptWord[]): TranscriptLine[] {
    const lines: TranscriptLine[] = [];
    let first = -1;
    const close = (last: number): void => {
        if (first < 0 || last < first) return;
        const text = words.slice(first, last + 1).map((w) => w[2].trim()).filter(Boolean).join(' ');
        lines.push({ n: lines.length + 1, first, last, t0: words[first]![0], t1: words[last]![1], text });
        first = -1;
    };
    words.forEach((word, i) => {
        if (first >= 0) {
            // Times have two decimals, and 1.9 − 1.3 is 0.5999… in floating point: compare with a margin.
            const pause = word[0] - words[i - 1]![1];
            const tooLong = word[1] - words[first]![0] > LINE_MAX_S + EPSILON;
            if (pause >= LINE_PAUSE_S - EPSILON || tooLong) close(i - 1);
        }
        if (first < 0) first = i;
        if (SENTENCE_END.test(word[2].trim())) close(i);
    });
    close(words.length - 1);
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

/**
 * Where a clip of whole lines cuts, in seconds of the source: the lead-in before its first word,
 * the tail after its last, clamped to the video.
 */
export function snapClip(
    lines: readonly TranscriptLine[], words: readonly TranscriptWord[], startLine: number, endLine: number,
    duration: number | null
): { start: number; end: number } {
    const first = words[lines[startLine - 1]!.first]!;
    const last = words[lines[endLine - 1]!.last]!;
    const start = Math.max(0, first[0] - LEAD_IN_S);
    const ceiling = duration !== null && duration > 0 ? Math.max(duration, last[1]) : Number.POSITIVE_INFINITY;
    return { start: round2(start), end: round2(Math.min(ceiling, last[1] + TAIL_S)) };
}

export interface PickedClip {
    /** 1 = the best. */
    rank: number;
    startLine: number;
    endLine: number;
    start: number;
    end: number;
    title: string;
    /** The spoken opening line. */
    hook: string;
    why: string | null;
    score: number;
}

export interface ClipChoice {
    kept: PickedClip[];
    /** How many clips the model proposed. */
    considered: number;
    /** What a repair round would be told: lines that don't exist, and lengths out of range. */
    problems: string[];
}

const intOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/**
 * The model's answer turned into clips by the rules above. Anything it got wrong is a problem to
 * repair (a line that doesn't exist, a length out of range), never a guess at what it meant.
 */
export function chooseClips(
    raw: unknown,
    lines: readonly TranscriptLine[],
    words: readonly TranscriptWord[],
    opts: { minSeconds: number; maxSeconds: number; keep: number; duration: number | null }
): ClipChoice {
    const proposed = raw && typeof raw === 'object' && Array.isArray((raw as { clips?: unknown }).clips)
        ? ((raw as { clips: unknown[] }).clips)
        : [];
    const problems: string[] = [];
    const candidates: Omit<PickedClip, 'rank'>[] = [];

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
        const { start, end } = snapClip(lines, words, s, e, opts.duration);
        const length = round2(end - start);
        if (length < opts.minSeconds || length > opts.maxSeconds) {
            problems.push(`${label}: L${s}–L${e} is ${length.toFixed(1)} s; a clip must be ${opts.minSeconds}–${opts.maxSeconds} s`);
            return;
        }
        const score = typeof c.score === 'number' && Number.isFinite(c.score) ? Math.round(Math.min(10, Math.max(0, c.score)) * 10) / 10 : 0;
        const why = typeof c.why === 'string' && oneLine(c.why) ? trimText(oneLine(c.why), MAX_WHY) : null;
        candidates.push({
            startLine: s, endLine: e, start, end, title, why, score,
            hook: trimText(lines[s - 1]!.text, MAX_HOOK),
        });
    });

    // Best first; on a tie the earlier moment. An overlap keeps the higher score.
    candidates.sort((a, b) => b.score - a.score || a.start - b.start);
    const kept: Omit<PickedClip, 'rank'>[] = [];
    for (const c of candidates) {
        if (kept.some((k) => c.start < k.end && k.start < c.end)) continue;
        kept.push(c);
    }
    const best = kept.filter((c) => c.score >= MIN_SCORE).slice(0, Math.max(0, opts.keep));
    return {
        kept: best.map((c, i) => ({ ...c, rank: i + 1 })),
        considered: proposed.length,
        problems,
    };
}
