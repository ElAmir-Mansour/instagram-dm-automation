/**
 * The Monteur's transcript lines and the code that owns the cut (MONTEUR.md §6, §6.1): the model
 * names lines and scores them; everything numeric here is code.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptWord } from '../../db/rows.js';
import { defaultStudioSettings } from '../studio/settingsTypes.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { clipWords, ctaLines, tiktokCtaLines } from './render.js';
import {
    chooseClips, formatLines, formatStamp, groupLines, leaningOpening, snapClip, snapEdges, textOverlap,
} from './transcript.js';

/** Words every `step` seconds, each lasting `len`. */
function words(texts: string[], from = 0, step = 0.5, len = 0.4): TranscriptWord[] {
    return texts.map((text, i) => [from + i * step, from + i * step + len, text] as TranscriptWord);
}

describe('groupLines', () => {
    it('breaks at sentence punctuation, Latin and Arabic', () => {
        const lines = groupLines(words(['This', 'works.', 'هذا', 'يشتغل؟', 'Yes!', '«تمام».', 'end']));
        assert.deepEqual(lines.map((l) => l.text), ['This works.', 'هذا يشتغل؟', 'Yes!', '«تمام».', 'end']);
        assert.deepEqual(lines.map((l) => l.n), [1, 2, 3, 4, 5]);
    });

    it('breaks before a pause of 0.6 s or more — 1.9 − 1.3 included — not a shorter one', () => {
        const w: TranscriptWord[] = [[0, 0.4, 'one'], [0.99, 1.3, 'two'], [1.9, 2.2, 'three']];
        assert.deepEqual(groupLines(w).map((l) => l.text), ['one two', 'three']);
    });

    it('never lets a line run past 12 s, and marks the edges that break made', () => {
        const lines = groupLines(words(Array.from({ length: 40 }, (_, i) => `w${i}`), 0, 0.5, 0.45));
        for (const l of lines) assert.ok(l.t1 - l.t0 <= 12, `${l.t0}–${l.t1}`);
        assert.ok(lines.length >= 2);
        assert.equal(lines.map((l) => l.text).join(' ').split(' ').length, 40, 'no word lost at a break');
        assert.equal(lines[0]!.forcedStart, false);
        assert.equal(lines[0]!.forcedEnd, true);
        assert.equal(lines[1]!.forcedStart, true);
        const natural = groupLines(words(['one.', 'two.']));
        assert.ok(natural.every((l) => !l.forcedStart && !l.forcedEnd));
    });

    it('keeps each line’s word range and times, and trims the tokens it joins', () => {
        const [line] = groupLines([[1, 1.2, ' مرحبا'], [1.3, 1.6, 'بكم ']]);
        assert.deepEqual(line, { n: 1, first: 0, last: 1, t0: 1, t1: 1.6, text: 'مرحبا بكم', forcedStart: false, forcedEnd: false });
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

describe('snapEdges — only the edges the 12 s break made', () => {
    // 30 words, 0.5 s apart with no pauses and one comma at word 22 ("w22,"): the forced break
    // lands inside the run, where nothing marks a sentence edge.
    const texts = Array.from({ length: 30 }, (_, i) => (i === 22 ? `w${i},` : `w${i}`));
    const w = words(texts, 0, 0.5, 0.45);
    const lines = groupLines(w);

    it('moves a forced start to the nearest punctuation within 2 s', () => {
        assert.equal(lines[1]!.forcedStart, true);
        const snapped = snapEdges(lines, w, 2, lines.length);
        assert.ok(snapped);
        assert.equal(snapped!.startWord, 23, 'just after «w22,»');
    });

    it('drops a clip whose forced edge has no pause or punctuation within 2 s', () => {
        const flat = words(Array.from({ length: 30 }, (_, i) => `w${i}`), 0, 0.5, 0.45);
        const flatLines = groupLines(flat);
        assert.equal(snapEdges(flatLines, flat, 2, flatLines.length), null);
    });

    it('leaves a natural edge where it is', () => {
        const natural = words(['One.', 'Two', 'three.']);
        const nl = groupLines(natural);
        assert.deepEqual(snapEdges(nl, natural, 2, 2), { startWord: 1, endWord: 2 });
    });
});

describe('the opening guard', () => {
    it('catches openings that lean on what was said before', () => {
        for (const opening of ['وبعدين نسوي كذا', 'فبعدين نبدأ', 'يعني الفكرة', 'بس المهم', 'عشان كذا نبدأ', 'زي ما قلت قبل', 'ف لما تضغط', 'فإذا ضغطت', 'فهذا هو']) {
            assert.ok(leaningOpening(opening), opening);
        }
    });

    it('lets a cold open through', () => {
        for (const opening of ['النتيجة كانت مذهلة', 'بسيطة جدا', 'فكرة واحدة', 'This saved me an hour']) {
            assert.equal(leaningOpening(opening), null, opening);
        }
    });
});

describe('chooseClips', () => {
    // One line every 5 s, each 4.5 s long: L1 at 0 s … L20 at 95 s.
    const w: TranscriptWord[] = Array.from({ length: 20 }, (_, i) => [i * 5, i * 5 + 4.5, `جملة${i + 1}.`] as TranscriptWord);
    const lines = groupLines(w);
    const opts = { minSeconds: 20, maxSeconds: 45, keep: 2, duration: 100 };
    const strong = { hook: 3, alone: 3, payoff: 2, send: 2 };
    const clip = (start_line: number, end_line: number, scores: Record<string, number> = strong, extra: Record<string, unknown> = {}) =>
        ({ start_line, end_line, title: 'A hook', hook_type: 'promise', why: 'why', scores, ...extra });

    it('ranks by 3·hook + alone + payoff + send, shown as round(rank / 1.8), with the start line as the hook', () => {
        const choice = chooseClips({ topic: 'الفكرة', clips: [clip(3, 7)] }, lines, w, opts);
        assert.equal(choice.topic, 'الفكرة');
        const [kept] = choice.kept;
        assert.equal(kept!.score, Math.round(16 / 1.8));
        assert.deepEqual(kept!.scores, strong);
        assert.equal(kept!.hookType, 'promise');
        assert.deepEqual([kept!.start, kept!.end, kept!.hook], [9.85, 34.8, 'جملة3.']);
        assert.equal(kept!.text, 'جملة3. جملة4. جملة5. جملة6. جملة7.');
    });

    it('drops a weak hook or a clip that leans on its context, and anything under rank 9, without a repair', () => {
        const choice = chooseClips({
            clips: [
                clip(1, 5, { hook: 1, alone: 3, payoff: 3, send: 3 }),
                clip(6, 10, { hook: 3, alone: 1, payoff: 3, send: 3 }),
                clip(11, 15, { hook: 2, alone: 2, payoff: 0, send: 0 }),
                clip(16, 20, { hook: 2, alone: 2, payoff: 1, send: 0 }),
            ],
        }, lines, w, opts);
        assert.deepEqual(choice.kept.map((c) => c.startLine), [16], 'rank 9 is the floor');
        assert.deepEqual(choice.problems, []);
    });

    it('drops a clip outside [min, max] seconds, and says so for the repair', () => {
        const choice = chooseClips({ clips: [clip(1, 2), clip(1, 12), clip(5, 9)] }, lines, w, opts);
        assert.deepEqual(choice.kept.map((c) => c.startLine), [5]);
        assert.equal(choice.considered, 3);
        assert.ok(choice.problems.some((p) => /clip 1: L1–L2 is 9\.8 s; a clip must be 20–45 s/.test(p)), choice.problems.join('\n'));
    });

    it('refuses line numbers that do not exist or run backwards', () => {
        const choice = chooseClips({ clips: [clip(0, 4), clip(18, 25), clip(9, 5), { ...clip(2, 6), start_line: 2.5 }] }, lines, w, opts);
        assert.equal(choice.kept.length, 0);
        assert.equal(choice.problems.length, 4);
        assert.ok(choice.problems.every((p) => /is not a range of lines \(L1–L20/.test(p)));
    });

    it('refuses an opening that leans on what came before, for the repair to fix', () => {
        const lw: TranscriptWord[] = w.map(([a, b, t], i) => [a, b, i === 2 ? 'وبعدين نبدأ.' : t] as TranscriptWord);
        const choice = chooseClips({ clips: [clip(3, 7)] }, groupLines(lw), lw, opts);
        assert.equal(choice.kept.length, 0);
        assert.match(choice.problems[0]!, /clip 1: L3 opens on «وبعدين»/);
    });

    it('drops a repeat of a live or recent reel, and of a better clip in the same answer', () => {
        const repeat = chooseClips({ clips: [clip(3, 7)] }, lines, w, { ...opts, existingTexts: ['جملة3. جملة4. جملة5. جملة6. جملة7. and more'] });
        assert.equal(repeat.kept.length, 0);
        assert.match(repeat.problems[0]!, /repeats a reel already made/);
        const fresh = chooseClips({ clips: [clip(3, 7)] }, lines, w, { ...opts, existingTexts: ['something else entirely'] });
        assert.equal(fresh.kept.length, 1);
    });

    it('drops a clip sharing a line with a better one, keeping the higher rank', () => {
        const { kept } = chooseClips({ clips: [clip(2, 6, { hook: 2, alone: 3, payoff: 3, send: 1 }), clip(4, 8), clip(12, 16)] }, lines, w, opts);
        assert.deepEqual(kept.map((c) => c.startLine), [4, 12]);
        assert.deepEqual(kept.map((c) => c.rank), [1, 2]);
    });

    it('keeps two clips that only border each other, cut at the middle of the gap', () => {
        // Lines 0.2 s apart: less than the 0.45 s of lead-in and tail, which used to count as an overlap.
        const tight: TranscriptWord[] = Array.from({ length: 20 }, (_, i) => [i * 5, i * 5 + 4.8, `جملة${i + 1}.`] as TranscriptWord);
        const tl = groupLines(tight);
        const { kept } = chooseClips({ clips: [clip(1, 6), clip(7, 12, { hook: 3, alone: 2, payoff: 2, send: 2 })] }, tl, tight, opts);
        assert.equal(kept.length, 2, 'both reels are made');
        const [a, b] = [...kept].sort((x, y) => x.start - y.start);
        assert.equal(a!.end, 29.9, 'the middle of the gap between L6 (ends 29.8) and L7 (starts 30)');
        assert.equal(b!.start, 29.9);
    });

    it('keeps the top reels_per_video', () => {
        const { kept } = chooseClips({ clips: [clip(1, 5), clip(6, 10), clip(11, 15)] }, lines, w, { ...opts, keep: 2 });
        assert.equal(kept.length, 2);
    });

    it('clamps each sub-score into 0–3, cuts a long title to 60, and refuses an empty one', () => {
        const long = 'word '.repeat(30);
        const { kept, problems } = chooseClips({ clips: [clip(1, 5, { hook: 9, alone: 9, payoff: 9, send: 9 }, { title: long }), clip(6, 10, strong, { title: '  ' })] }, lines, w, opts);
        assert.deepEqual(kept[0]!.scores, { hook: 3, alone: 3, payoff: 3, send: 3 });
        assert.equal(kept[0]!.score, 10);
        assert.ok(kept[0]!.title.length <= 60);
        assert.ok(problems.some((p) => /clip 2: the title is empty/.test(p)));
    });

    it('reads a malformed answer as no clips', () => {
        assert.deepEqual(chooseClips(null, lines, w, opts).kept, []);
        assert.deepEqual(chooseClips({ clips: 'L1' }, lines, w, opts).kept, []);
    });
});

describe('textOverlap', () => {
    it('is the share of the smaller text’s words the other has', () => {
        assert.equal(textOverlap('one two three', 'one two three four five six'), 1);
        assert.equal(textOverlap('alpha beta gamma delta', 'alpha beta other words'), 0.5);
        assert.equal(textOverlap('', 'anything'), 0);
    });
});

describe('what the render gets', () => {
    it('the words that start inside the clip, on its clock, none running past its end', () => {
        const w: TranscriptWord[] = [[9.7, 9.95, 'before'], [10, 10.4, 'first'], [12, 12.6, 'last'], [12.75, 13.2, 'after']];
        // "before" ended in the lead-in: out. "after" starts in the tail: in, cut at the clip's end.
        assert.deepEqual(clipWords(w, 9.85, 12.9), [[0.15, 0.55, 'first'], [2.15, 2.75, 'last'], [2.9, 3.05, 'after']]);
    });

    it('the CTA: the slide’s short ask with «keyword» in every language, then its second line', () => {
        assert.deepEqual(ctaLines(ELAMIR_SETTINGS, 'دفتر'), { line1: 'اكتب في التعليقات «دفتر»', line2: 'ويوصلك الرابط بالخاص 📩' });
        assert.deepEqual(ctaLines(defaultStudioSettings(), 'AI'), { line1: 'Comment below «AI»', line2: 'and I\'ll DM you the link 📩' });
    });

    it('TikTok’s CTA: the pill and its sub-line, never "comment"', () => {
        assert.deepEqual(tiktokCtaLines(ELAMIR_SETTINGS), { line1: 'رابطه في البايو', line2: 'ادخل البروفايل واضغط الرابط 👆' });
    });
});
