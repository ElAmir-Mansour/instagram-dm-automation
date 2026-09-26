/**
 * The Monteur's transcript lines and the code that owns the cut (MONTEUR.md §6.1): the model
 * names lines; everything numeric here is code.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptWord } from '../../db/rows.js';
import { clipWords, ctaLines } from './render.js';
import { chooseClips, formatLines, formatStamp, groupLines, snapClip } from './transcript.js';
import { defaultStudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';

/** Words every `step` seconds, each lasting `len`, with an optional pause before word `pauseAt`. */
function words(texts: string[], from = 0, step = 0.5, len = 0.4): TranscriptWord[] {
    return texts.map((text, i) => [from + i * step, from + i * step + len, text] as TranscriptWord);
}

describe('groupLines', () => {
    it('breaks at sentence punctuation, Latin and Arabic', () => {
        const lines = groupLines(words(['This', 'works.', 'هذا', 'يشتغل؟', 'Yes!', '«تمام».', 'end']));
        assert.deepEqual(lines.map((l) => l.text), ['This works.', 'هذا يشتغل؟', 'Yes!', '«تمام».', 'end']);
        assert.deepEqual(lines.map((l) => l.n), [1, 2, 3, 4, 5]);
    });

    it('breaks before a pause of 0.6 s or more, not a shorter one', () => {
        const w: TranscriptWord[] = [[0, 0.4, 'one'], [0.99, 1.3, 'two'], [1.9, 2.2, 'three']];
        // 0.59 s after "one", 0.6 s after "two".
        assert.deepEqual(groupLines(w).map((l) => l.text), ['one two', 'three']);
    });

    it('never lets a line run past 12 s', () => {
        const lines = groupLines(words(Array.from({ length: 40 }, (_, i) => `w${i}`), 0, 0.5, 0.45));
        for (const l of lines) assert.ok(l.t1 - l.t0 <= 12, `${l.t0}–${l.t1}`);
        assert.ok(lines.length >= 2);
        assert.equal(lines.map((l) => l.text).join(' ').split(' ').length, 40, 'no word lost at a break');
    });

    it('keeps each line’s word range and times, and trims the tokens it joins', () => {
        const [line] = groupLines([[1, 1.2, ' مرحبا'], [1.3, 1.6, 'بكم ']]);
        assert.deepEqual(line, { n: 1, first: 0, last: 1, t0: 1, t1: 1.6, text: 'مرحبا بكم' });
        assert.deepEqual(groupLines([]), []);
    });
});

describe('the transcript as sent', () => {
    it('stamps each line mm:ss.s, rounding into the next minute rather than to :60', () => {
        assert.equal(formatStamp(65.34), '01:05.3');
        assert.equal(formatStamp(59.96), '01:00.0');
        assert.equal(formatStamp(0), '00:00.0');
        assert.equal(formatStamp(3725.2), '62:05.2');
    });

    it('is one `L<n> [mm:ss.s] text` per line', () => {
        const lines = groupLines([[3.21, 3.5, 'Hello.'], [65.3, 65.6, 'Again']]);
        assert.equal(formatLines(lines), 'L1 [00:03.2] Hello.\nL2 [01:05.3] Again');
    });
});

describe('snapClip', () => {
    const w: TranscriptWord[] = [[0.1, 0.5, 'Start.'], [10, 10.4, 'Mid'], [10.5, 11, 'line.'], [20, 20.5, 'End.']];
    const lines = groupLines(w);

    it('starts 0.15 s before the first word and ends 0.3 s after the last', () => {
        assert.deepEqual(snapClip(lines, w, 2, 3, 100), { start: 9.85, end: 20.8 });
    });

    it('never starts before 0, nor ends past the source — but never cuts the last word itself', () => {
        assert.deepEqual(snapClip(lines, w, 1, 1, 100), { start: 0, end: 0.8 });
        assert.equal(snapClip(lines, w, 3, 3, 20.6).end, 20.6, 'clamped to the video’s end');
        assert.equal(snapClip(lines, w, 3, 3, 20.2).end, 20.5, 'a duration shorter than the last word keeps the word');
        assert.equal(snapClip(lines, w, 3, 3, null).end, 20.8, 'no duration known: the tail stands');
    });
});

describe('chooseClips', () => {
    // One line every 5 s, each 4.5 s long: L1 at 0 s … L20 at 95 s.
    const w: TranscriptWord[] = Array.from({ length: 20 }, (_, i) => [i * 5, i * 5 + 4.5, `line${i + 1}.`] as TranscriptWord);
    const lines = groupLines(w);
    const opts = { minSeconds: 20, maxSeconds: 45, keep: 2, duration: 100 };
    const clip = (start_line: number, end_line: number, score: number, title = 'A hook') => ({ start_line, end_line, title, why: 'why', score });

    it('turns lines into cut times, with the start line’s words as the hook', () => {
        const { kept } = chooseClips({ clips: [clip(3, 7, 8)] }, lines, w, opts);
        assert.deepEqual(kept, [{
            rank: 1, startLine: 3, endLine: 7, start: 9.85, end: 34.8, title: 'A hook', hook: 'line3.', why: 'why', score: 8,
        }]);
    });

    it('drops a clip outside [min, max] seconds, and says so for the repair', () => {
        const choice = chooseClips({ clips: [clip(1, 2, 9), clip(1, 12, 9), clip(5, 9, 6)] }, lines, w, opts);
        assert.deepEqual(choice.kept.map((c) => c.startLine), [5]);
        assert.equal(choice.considered, 3);
        assert.ok(choice.problems.some((p) => /clip 1: L1–L2 is 9\.8 s; a clip must be 20–45 s/.test(p)), choice.problems.join('\n'));
        assert.ok(choice.problems.some((p) => /clip 2: L1–L12 is 59\.8 s/.test(p)));
    });

    it('refuses line numbers that do not exist or run backwards', () => {
        const choice = chooseClips({ clips: [clip(0, 4, 9), clip(18, 25, 9), clip(9, 5, 9), { ...clip(2, 6, 9), start_line: 2.5 }] }, lines, w, opts);
        assert.equal(choice.kept.length, 0);
        assert.equal(choice.problems.length, 4);
        assert.ok(choice.problems.every((p) => /is not a range of lines \(L1–L20/.test(p)));
    });

    it('drops an overlap, keeping the higher score', () => {
        const { kept } = chooseClips({ clips: [clip(2, 6, 6), clip(4, 8, 9), clip(12, 16, 7)] }, lines, w, opts);
        assert.deepEqual(kept.map((c) => [c.startLine, c.score]), [[4, 9], [12, 7]]);
        assert.deepEqual(kept.map((c) => c.rank), [1, 2]);
    });

    it('keeps the top reels_per_video, and only those scoring 5 or more', () => {
        const { kept } = chooseClips({ clips: [clip(1, 5, 5), clip(6, 10, 4.9), clip(11, 15, 9), clip(16, 20, 7)] }, lines, w, { ...opts, keep: 2 });
        assert.deepEqual(kept.map((c) => c.score), [9, 7]);
        const low = chooseClips({ clips: [clip(1, 5, 4), clip(6, 10, 3)] }, lines, w, opts);
        assert.deepEqual(low.kept, [], 'nothing worth a reel');
        assert.deepEqual(low.problems, [], 'and nothing to repair');
    });

    it('clamps a score into 0–10, cuts a long title to 60, and refuses an empty one', () => {
        const long = 'word '.repeat(30);
        const { kept, problems } = chooseClips({ clips: [clip(1, 5, 42, long), clip(6, 10, 8, '  ')] }, lines, w, opts);
        assert.equal(kept[0]!.score, 10);
        assert.ok(kept[0]!.title.length <= 60);
        assert.ok(problems.some((p) => /clip 2: the title is empty/.test(p)));
    });

    it('reads a malformed answer as no clips', () => {
        assert.deepEqual(chooseClips(null, lines, w, opts).kept, []);
        assert.deepEqual(chooseClips({ clips: 'L1' }, lines, w, opts).kept, []);
    });
});

describe('what the render gets', () => {
    it('the words that start inside the clip, on its clock, none running past its end', () => {
        const w: TranscriptWord[] = [[9.7, 9.95, 'before'], [10, 10.4, 'first'], [12, 12.6, 'last'], [12.75, 13.2, 'after']];
        // "before" ended in the lead-in: out. "after" starts in the tail: in, cut at the clip's end.
        assert.deepEqual(clipWords(w, 9.85, 12.9), [[0.15, 0.55, 'first'], [2.15, 2.75, 'last'], [2.9, 3.05, 'after']]);
    });

    it('the CTA card: the slide’s short ask with the keyword quoted, then its second line', () => {
        assert.deepEqual(ctaLines(ELAMIR_SETTINGS, 'دفتر'), { line1: 'اكتب في التعليقات «دفتر»', line2: 'ويوصلك الرابط بالخاص 📩' });
        assert.deepEqual(ctaLines(defaultStudioSettings(), 'AI'), { line1: 'Comment below "AI"', line2: 'and I\'ll DM you the link 📩' });
    });
});
