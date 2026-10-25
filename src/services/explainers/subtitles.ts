/**
 * The words an explainer's subtitles show: each scene's narration AS WRITTEN, on the times of the words AS SPOKEN.
 *
 * The voice step times the `spoken` sentence (explainers.words), and `spoken` is the narration with every English term, name and acronym written
 * in Arabic letters so the voice says it right ("OpenAI" → «أوبن إيه آي»). Shown as it was spoken, the subtitles read «أوبن إيه آي» and
 * «نوتبوك إل إم» under a picture whose label says NotebookLM (the pilot, 2026-10-25). So the two token lists are lined up: the words both share
 * (most of them: the prompt changes `spoken` only where the voice needs help) are anchors and keep their own times, and a run that differs between
 * two anchors (one written word, three spoken ones) is shown as written across the span of the spoken run, its time shared by the written words in
 * proportion to their length. Pure.
 */
import type { ExplainerWords } from '../../db/rows.js';

export type TimedWord = [number, number, string];

/** A token as compared: letters and digits only, of any script, with Arabic diacritics and tatweel dropped. "مخطئ،" and "مخطئ" are one word. */
function key(token: string): string {
    return token.normalize('NFC').replace(/[ـً-ٰٟ]/g, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/** The longest common subsequence of two token lists, as index pairs in order: the anchors. Tokens with no letter or digit never anchor. */
function anchors(written: readonly string[], spoken: readonly string[]): [number, number][] {
    const a = written.map(key);
    const b = spoken.map(key);
    const n = a.length;
    const m = b.length;
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i]![j] = a[i] && a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
        }
    }
    const pairs: [number, number][] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] && a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

const round = (seconds: number): number => Math.round(seconds * 1000) / 1000;

/** Tokens with no letter or digit (a dash, a quote mark) joined to the word before them, or to the next one when they come first. */
function attachPunctuation(tokens: readonly string[]): string[] {
    const out: string[] = [];
    let lead: string[] = [];
    for (const token of tokens) {
        if (key(token)) {
            out.push(lead.length ? `${lead.join(' ')} ${token}` : token);
            lead = [];
        } else if (out.length) {
            out[out.length - 1] = `${out[out.length - 1]} ${token}`;
        } else {
            lead.push(token);
        }
    }
    if (lead.length) out.push(lead.join(' '));
    return out;
}

/**
 * Written tokens `tokens` spread over [start, end]: each word gets a share in proportion to its letters (at least one), so a long name is on screen
 * longer than a short word beside it. Punctuation on its own rides with a neighbouring word and gets no time of its own.
 */
function spread(tokens: readonly string[], start: number, end: number): TimedWord[] {
    const words = attachPunctuation(tokens);
    const weights = words.map((word) => Math.max(1, key(word).length));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const out: TimedWord[] = [];
    let at = start;
    words.forEach((word, index) => {
        const until = index === words.length - 1 ? end : at + ((end - start) * weights[index]!) / total;
        out.push([round(at), round(until), word]);
        at = until;
    });
    return out;
}

/**
 * One scene's subtitle words: `narration` split into its written words, timed by `spoken` (the scene's [start, end, word] list from the voice
 * step). Anchors keep their spoken times. A differing run between anchors spans its spoken run; a written run with no spoken words between its
 * anchors (punctuation on its own, a word the voice dropped) is joined to the word before it, or to the next one at the start. With no spoken
 * words, or no narration, the spoken list is returned as it is.
 */
export function subtitleWords(narration: string, spoken: readonly TimedWord[]): TimedWord[] {
    const written = narration.split(/\s+/).filter(Boolean);
    if (!written.length || !spoken.length) return spoken.map(([s, e, w]) => [s, e, w]);

    const pairs = anchors(written, spoken.map((word) => word[2]));
    const out: TimedWord[] = [];
    const pending: string[] = []; // written words waiting for a time: joined to the next word that gets one
    let wi = 0;
    let si = 0;
    const flush = (runWritten: string[], runSpoken: readonly TimedWord[]) => {
        if (!runWritten.length) return;
        if (runSpoken.length) {
            out.push(...spread(runWritten, runSpoken[0]![0], runSpoken[runSpoken.length - 1]![1]));
        } else if (out.length) {
            const last = out[out.length - 1]!;
            last[2] = `${last[2]} ${runWritten.join(' ')}`;
        } else {
            pending.push(...runWritten);
        }
    };
    for (const [wa, sa] of [...pairs, [written.length, spoken.length] as [number, number]]) {
        flush(written.slice(wi, wa), spoken.slice(si, sa));
        if (wa < written.length) {
            const [s, e] = spoken[sa]!;
            const word = pending.length ? `${pending.splice(0).join(' ')} ${written[wa]}` : written[wa]!;
            out.push([s, e, word]);
        }
        wi = wa + 1;
        si = sa + 1;
    }
    if (pending.length) out.push([spoken[0]![0], spoken[spoken.length - 1]![1], pending.join(' ')]);
    return out;
}

/** Every scene's subtitle words, keyed by its position as `explainers.words` is. A scene with no spoken words keeps none. */
export function subtitleWordsFor(scenes: readonly { position: number; narration: string }[], words: ExplainerWords): ExplainerWords {
    const out: ExplainerWords = {};
    for (const [position, list] of Object.entries(words)) {
        const scene = scenes.find((s) => String(s.position) === position);
        out[position] = scene ? subtitleWords(scene.narration, list) : list;
    }
    return out;
}
