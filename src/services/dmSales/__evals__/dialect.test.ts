/**
 * Language and dialect, decided in code (`dialect.ts`): a reply to Arabic is mostly Arabic and to English mostly English; a reply to a
 * person writing MSA has no dialect word in it; a reply to one writing a dialect has no OTHER dialect's word in it, and with `lean` has
 * at least one of their own.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkVariety, dialectWords, LANGUAGE_SHARE, scriptShares } from './dialect.js';

describe('scriptShares', () => {
    it('counts letters by script and ignores digits, emoji and punctuation', () => {
        assert.deepEqual(scriptShares('مرحبا'), { arabic: 5, latin: 0, letters: 5 });
        assert.deepEqual(scriptShares('Hello 123 👋 !'), { arabic: 0, latin: 5, letters: 5 });
        assert.deepEqual(scriptShares('Agentic AI كورس'), { arabic: 4, latin: 9, letters: 13 });
        assert.deepEqual(scriptShares('٣٤ 🙏 ...'), { arabic: 0, latin: 0, letters: 0 });
    });
});

describe('dialectWords', () => {
    it('finds the words that belong to one variety, folded the way the pre-filter folds a message', () => {
        assert.deepEqual(dialectWords('وش تبي؟ الحين أرسل لك'), { gulf: ['وش', 'تبي', 'الحين'], egyptian: [], levantine: [] });
        assert.deepEqual(dialectWords('ازاي أساعدك؟ الكورس ده كويس'), { gulf: [], egyptian: ['ازاي', 'ده'], levantine: [] });
        assert.deepEqual(dialectWords('شو بدك؟ كتير منيح'), { gulf: [], egyptian: [], levantine: ['شو', 'بدك', 'كتير', 'منيح'] });
        // أ إ آ and ى ة are unified, and marks and stretching are out.
        assert.deepEqual(dialectWords('ابغى').gulf, ['ابغي']);
        assert.deepEqual(dialectWords('دلوقتـــي').egyptian, ['دلوقتي']);
    });

    it('tags a word two dialects share with both, and the glued «هال» as Gulf and Levantine', () => {
        const shared = dialectWords('ليش؟');
        assert.deepEqual([shared.gulf, shared.levantine, shared.egyptian], [['ليش'], ['ليش'], []]);
        const glued = dialectWords('هالكورس ممتاز');
        assert.deepEqual([glued.gulf, glued.levantine], [['هالكورس'], ['هالكورس']]);
    });

    it('does not count words that are ordinary standard Arabic, so a polite reply is never blamed for them', () => {
        const plain = dialectWords('الدورة مناسبة للمبتدئين، وهي تبدأ من الصفر. يسعدنا أن نساعدك، وهذا هو الرابط. مرة أخرى شكراً، كذا وكذا، طيب.');
        assert.deepEqual(plain, { gulf: [], egyptian: [], levantine: [] });
    });

    it('lists each word once', () => {
        assert.deepEqual(dialectWords('وش وش وش').gulf, ['وش']);
    });
});

describe('checkVariety: the language', () => {
    it('passes Arabic with technical terms in English, and fails Arabic that is mostly English', () => {
        assert.equal(checkVariety('الكورس يشرح Agentic AI و RAG خطوة بخطوة', 'msa').pass, true);
        const mostlyEnglish = checkVariety('The course explains agents step by step ولا شيء', 'msa');
        assert.equal(mostlyEnglish.pass, false);
        assert.match(mostlyEnglish.detail, /expected Arabic/);
    });

    it('passes English with an Arabic course name in it, and fails English that is mostly Arabic', () => {
        assert.equal(checkVariety('It is the "Agentic AI: الدليل العملي" course, and it starts from zero, with no code needed first.', 'english').pass, true);
        const arabic = checkVariety('الكورس مناسب للمبتدئين', 'english');
        assert.equal(arabic.pass, false);
        assert.match(arabic.detail, /expected English/);
    });

    it('fails a reply with no words in it', () => {
        for (const text of ['', '🙏', '٣٤', '..']) assert.equal(checkVariety(text, 'gulf').pass, false, JSON.stringify(text));
    });

    it('draws the line at half the letters', () => {
        assert.equal(LANGUAGE_SHARE, 0.5);
        // 5 Arabic letters against 6 Latin ones: 45%, under. Against 4: 56%, over.
        assert.equal(checkVariety('مرحبا abcdef', 'msa').pass, false);
        assert.equal(checkVariety('مرحبا abcd', 'msa').pass, true);
        assert.equal(checkVariety('hello مرحب', 'english').pass, true, '6 of 9 letters are Latin');
        assert.equal(checkVariety('hi مرحبا', 'english').pass, false, '2 of 7 are Latin');
    });
});

describe('checkVariety: the dialect', () => {
    it('MSA: no dialect word at all', () => {
        assert.equal(checkVariety('الدورة مناسبة للمبتدئين وتبدأ من الصفر. هل ترغب في الرابط؟', 'msa').pass, true);
        const gulf = checkVariety('الدورة مناسبة للمبتدئين، وش رايك؟', 'msa');
        assert.equal(gulf.pass, false);
        assert.match(gulf.detail, /dialect words: «وش»/);
        assert.equal(checkVariety('الدورة ده مناسبة', 'msa').pass, false);
    });

    it('Gulf: another dialect\'s word fails it, Gulf and shared words do not', () => {
        assert.equal(checkVariety('هلا فيك! السعر الحالي في الصفحة، تبي أرسل لك الرابط؟', 'gulf').pass, true);
        assert.equal(checkVariety('الكورس هالمرة ليش ما تجربه', 'gulf').pass, true, 'ليش and هال are Gulf too');
        const egyptian = checkVariety('الكورس ده مناسب ليك وبيبدأ من الصفر', 'gulf');
        assert.equal(egyptian.pass, false);
        assert.match(egyptian.detail, /expected Gulf, but it uses another dialect's words: «ده»/);
        assert.equal(checkVariety('شو رأيك؟ الكورس كتير منيح', 'gulf').pass, false, 'Levantine');
    });

    it('Egyptian: Gulf and Levantine words fail it, and ليش is not Egyptian (ليه is)', () => {
        assert.equal(checkVariety('الكورس ده مناسب للمبتدئين، وبيبدأ من الصفر', 'egyptian').pass, true);
        const gulf = checkVariety('الكورس مناسب، وش تبي تتعلم؟', 'egyptian');
        assert.equal(gulf.pass, false);
        assert.match(gulf.detail, /expected Egyptian/);
        assert.equal(checkVariety('الكورس ده مناسب، ليش لا؟', 'egyptian').pass, false);
        assert.equal(checkVariety('الكورس ده مناسب، ليه لا؟', 'egyptian').pass, true);
    });

    it('lean: the reply must also use a word of the person\'s own dialect, not merely avoid another\'s', () => {
        const plain = 'الدورة مناسبة للمبتدئين وتبدأ من الصفر.';
        assert.equal(checkVariety(plain, 'egyptian').pass, true, 'without lean, plain Arabic is fine');
        const lean = checkVariety(plain, 'egyptian', true);
        assert.equal(lean.pass, false);
        assert.match(lean.detail, /leans Egyptian, but it uses no Egyptian word/);
        assert.equal(checkVariety('الكورس ده مناسب للمبتدئين', 'egyptian', true).pass, true);
        assert.equal(checkVariety(plain, 'gulf', true).pass, false);
        assert.equal(checkVariety('تبي أرسل لك الرابط؟', 'gulf', true).pass, true);
    });

    it('English has no dialect: lean is ignored and Arabic dialect words cannot be in it anyway', () => {
        assert.equal(checkVariety('It starts from zero, so yes, it suits a beginner.', 'english', true).pass, true);
    });
});
