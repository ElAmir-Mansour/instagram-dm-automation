/**
 * The subtitles show the narration as written, on the spoken words' times (subtitles.ts). The cases come from the pilot (2026-10-25): its subtitles
 * read «أوبن إيه آي» and «نوتبوك إل إم» because they were the spoken words.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { subtitleWords, subtitleWordsFor, type TimedWord } from './subtitles.js';

/** Spoken words, each 0.5 s, from `start`. */
const timed = (text: string, start = 0): TimedWord[] => text.split(' ').map((word, i) => [start + i * 0.5, start + i * 0.5 + 0.5, word]);
const words = (list: TimedWord[]) => list.map((w) => w[2]);

describe('subtitleWords', () => {
    it('keeps the spoken times and words when the narration is the same sentence', () => {
        const spoken = timed('يجيبك الذكاء الاصطناعي بثقة وهو مخطئ،');
        assert.deepEqual(subtitleWords('يجيبك الذكاء الاصطناعي بثقة وهو مخطئ،', spoken), spoken);
    });

    it('shows an English term as written, across the span of its spoken run (OpenAI over «أوبن إيه آي»)', () => {
        const spoken = timed('رأى باحثون من أوبن إيه آي أن التدريب');
        const out = subtitleWords('رأى باحثون من OpenAI أن التدريب', spoken);
        assert.deepEqual(words(out), ['رأى', 'باحثون', 'من', 'OpenAI', 'أن', 'التدريب']);
        assert.deepEqual(out[3], [1.5, 3, 'OpenAI'], 'from the start of «أوبن» to the end of «آي»');
        assert.deepEqual(out[4], [3, 3.5, 'أن'], 'the next anchor keeps its own time');
    });

    it('handles a run of written words against a run of spoken ones, sharing the span by length', () => {
        const spoken = timed('وأداة نوتبوك إل إم تعرض كل استشهاد');
        const out = subtitleWords('وأداة NotebookLM تعرض كل استشهاد', spoken);
        assert.deepEqual(words(out), ['وأداة', 'NotebookLM', 'تعرض', 'كل', 'استشهاد']);
        assert.deepEqual(out[1], [0.5, 2, 'NotebookLM']);
        const two = subtitleWords('في Facebook AI Research قدموا', timed('في فيسبوك إيه آي ريسيرتش قدموا'));
        assert.deepEqual(words(two), ['في', 'Facebook', 'AI', 'Research', 'قدموا']);
        assert.equal(two[1]![0], 0.5);
        assert.equal(two[3]![1], 2.5, 'the written run ends where the spoken run ends');
        assert.ok(two[1]![1] - two[1]![0] > two[2]![1] - two[2]![0], '"Facebook" is on screen longer than "AI"');
    });

    it('compares words without punctuation, tatweel and diacritics, so «مخطئ،» and «مخطئ» are one word', () => {
        const out = subtitleWords('وهو مخطئ، فعلًا', timed('وهو مخطـئ فعلا'));
        assert.deepEqual(out.map((w) => w.slice(0, 2)), [[0, 0.5], [0.5, 1], [1, 1.5]]);
        assert.deepEqual(words(out), ['وهو', 'مخطئ،', 'فعلًا'], 'the written spelling is the one shown');
    });

    it('joins a written token with no spoken word (punctuation on its own) to the word before it, or to the next one at the start', () => {
        assert.deepEqual(words(subtitleWords('RAG — يقلل الأخطاء', timed('راغ يقلل الأخطاء'))), ['RAG —', 'يقلل', 'الأخطاء']);
        assert.deepEqual(words(subtitleWords('« يقلل الأخطاء', timed('يقلل الأخطاء'))), ['« يقلل', 'الأخطاء']);
    });

    it('spreads the whole narration over the whole speech when no word matches, and returns the spoken words when either side is empty', () => {
        const out = subtitleWords('Retrieval Augmented Generation', timed('ريتريفال أوجمنتد جينيريشن'));
        assert.deepEqual(words(out), ['Retrieval', 'Augmented', 'Generation']);
        assert.equal(out[0]![0], 0);
        assert.equal(out[2]![1], 1.5);
        assert.deepEqual(subtitleWords('', timed('كلمة')), timed('كلمة'));
        assert.deepEqual(subtitleWords('كلمة', []), []);
    });

    it('never goes back in time: every word starts where or after the one before it ended', () => {
        const out = subtitleWords('في 2020 قدّم باتريك لويس وفريقه في Facebook AI Research نماذج RAG في مؤتمر NeurIPS.',
            timed('في 2020 قدّم باتريك لويس وفريقه في فيسبوك إيه آي ريسيرتش نماذج راغ في مؤتمر نيوريبس.'));
        for (let i = 1; i < out.length; i++) assert.ok(out[i]![0] >= out[i - 1]![1] - 1e-9, `word ${i}`);
        assert.deepEqual(words(out).slice(-3), ['في', 'مؤتمر', 'NeurIPS.']);
    });
});

describe('subtitleWordsFor', () => {
    it('maps every scene by its position, and leaves a scene it does not know as spoken', () => {
        const out = subtitleWordsFor([{ position: 0, narration: 'نماذج RAG' }], { 0: timed('نماذج راغ'), 7: timed('بلا مشهد') });
        assert.deepEqual(words(out['0']!), ['نماذج', 'RAG']);
        assert.deepEqual(out['7'], timed('بلا مشهد'));
    });
});
