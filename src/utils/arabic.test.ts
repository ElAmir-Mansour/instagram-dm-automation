/**
 * Normalisation is what decides whether a real comment triggers a campaign, and every failure
 * mode here is silent: the comment matches nothing, no row is written, and the operator sees
 * an empty dashboard rather than an error.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { keywordMatches, normalizeArabic } from './arabic.js';

describe('normalizeArabic', () => {
    it('strips tatweel (kashida)', () => {
        // Stretched text is everywhere in social-media Arabic. "تـــم" and "تم" are the same
        // word and used to be two different keys.
        assert.equal(normalizeArabic('تـــم'), 'تم');
        assert.equal(normalizeArabic('كـورس'), 'كورس');
        assert.equal(normalizeArabic('ـــ'), '');
    });

    it('folds the alef variants onto a bare alef', () => {
        assert.equal(normalizeArabic('أوبال'), 'اوبال');
        assert.equal(normalizeArabic('إيلاف'), 'ايلاف');
        assert.equal(normalizeArabic('آية'), 'ايه');
    });

    it('folds teh marbuta onto heh and alef maksura onto yeh', () => {
        assert.equal(normalizeArabic('برمجة'), 'برمجه');
        assert.equal(normalizeArabic('على'), 'علي');
        assert.equal(normalizeArabic('علي'), 'علي', 'a standard yeh is left alone');
    });

    it('strips the tashkeel marks', () => {
        assert.equal(normalizeArabic('تَمَّ'), 'تم');
        assert.equal(normalizeArabic('كِتَابٌ'), 'كتاب');
        for (const mark of ['\u064B', '\u064C', '\u064D', '\u064E', '\u064F', '\u0650', '\u0651', '\u0652']) {
            assert.equal(normalizeArabic(`ت${mark}م`), 'تم', `mark U+${mark.codePointAt(0)?.toString(16)}`);
        }
    });

    it('strips the superscript alef and the combining hamza/maddah marks', () => {
        assert.equal(normalizeArabic('هٰذا'), 'هذا');
        // NFD decomposition turns أ into a bare alef plus U+0654, which is invisible to anyone
        // typing a keyword but would otherwise be a different string.
        assert.equal(normalizeArabic('أوبال'.normalize('NFD')), 'اوبال');
        assert.equal(normalizeArabic('إيلاف'.normalize('NFD')), 'ايلاف');
    });

    it('collapses whitespace and lowercases', () => {
        assert.equal(normalizeArabic('  كورس  برمجة  '), 'كورس برمجه');
        assert.equal(normalizeArabic('كورس\n\tبرمجة'), 'كورس برمجه');
        assert.equal(normalizeArabic('COURSE'), 'course', 'keywords are not always Arabic');
    });

    it('returns an empty string for empty or whitespace-only input', () => {
        assert.equal(normalizeArabic(''), '');
        assert.equal(normalizeArabic('   '), '');
    });

    it('keeps Arabic-Indic digits and numeric punctuation', () => {
        // The diacritics class stops at U+0655 and then picks up U+0670 on its own. Widening
        // it to a single U+064B–U+0670 range — which reads as the same thing, and renders
        // almost identically in an RTL terminal — would swallow U+0660–U+0669 (٠-٩) and
        // U+066A–U+066D (٪ ٫ ٬ ٭) with it. A campaign keyed on "خصم ٥٠٪" would normalise to
        // "خصم", and one keyed on "٥٠" alone to nothing at all, never firing again.
        assert.equal(normalizeArabic('٥٠'), '٥٠');
        assert.equal(normalizeArabic('خصم ٥٠٪'), 'خصم ٥٠٪');
        assert.equal(normalizeArabic('كورس 50'), 'كورس 50', 'ASCII digits too');
    });
});

describe('keywordMatches — substring mode (the default)', () => {
    const TAMM = normalizeArabic('تم');

    it('matches a standalone keyword', () => {
        assert.equal(keywordMatches(normalizeArabic('تم التسجيل'), TAMM), true);
    });

    it('fires inside longer unrelated words — the documented hazard', () => {
        // This is why short keywords are dangerous. Substring is still the default so that
        // existing campaigns keep behaving exactly as they do today.
        assert.equal(keywordMatches(normalizeArabic('اهتمام'), TAMM), true);
        assert.equal(keywordMatches(normalizeArabic('تمام'), TAMM), true);
        assert.equal(keywordMatches(normalizeArabic('يتم'), TAMM), true);
    });

    it('matches across a tatweel-stretched comment', () => {
        assert.equal(keywordMatches(normalizeArabic('تـــم التسجيل'), TAMM), true);
    });

    it('returns false for an empty keyword', () => {
        // A trailing comma in a campaign's keyword list produces one of these. An empty string
        // is a substring of everything, so without the guard that campaign fires on every
        // comment that arrives.
        assert.equal(keywordMatches(normalizeArabic('اي تعليق'), ''), false);
    });

    it('returns false for empty text', () => {
        assert.equal(keywordMatches('', TAMM), false);
    });
});

describe('keywordMatches — word mode', () => {
    const TAMM = normalizeArabic('تم');

    it('does not fire inside longer words', () => {
        assert.equal(keywordMatches(normalizeArabic('اهتمام'), TAMM, 'word'), false);
        assert.equal(keywordMatches(normalizeArabic('تمام'), TAMM, 'word'), false);
        assert.equal(keywordMatches(normalizeArabic('يتم'), TAMM, 'word'), false);
        assert.equal(keywordMatches(normalizeArabic('اهتمامي بالتمام'), TAMM, 'word'), false);
    });

    it('still matches a standalone occurrence anywhere in the comment', () => {
        assert.equal(keywordMatches(normalizeArabic('تم'), TAMM, 'word'), true);
        assert.equal(keywordMatches(normalizeArabic('تم التسجيل'), TAMM, 'word'), true);
        assert.equal(keywordMatches(normalizeArabic('اخيرا تم'), TAMM, 'word'), true);
        assert.equal(keywordMatches(normalizeArabic('اخيرا تم التسجيل'), TAMM, 'word'), true);
    });

    it('treats punctuation and emoji as token boundaries', () => {
        // \b is defined over [A-Za-z0-9_], so every Arabic letter reads as a non-word
        // character and \b fires in all the wrong places — hence the Unicode lookarounds.
        assert.equal(keywordMatches(normalizeArabic('تم!'), TAMM, 'word'), true);
        assert.equal(keywordMatches(normalizeArabic('(تم)'), TAMM, 'word'), true);
        assert.equal(keywordMatches(normalizeArabic('تم 🎉'), TAMM, 'word'), true);
    });

    it('anchors only the outer edges of a multi-word keyword', () => {
        const keyword = normalizeArabic('كورس برمجة');
        assert.equal(keywordMatches(normalizeArabic('اريد كورس برمجة الان'), keyword, 'word'), true);
        assert.equal(keywordMatches(normalizeArabic('كورس برمجةx'), keyword, 'word'), false);
    });

    it('returns false for an empty keyword', () => {
        assert.equal(keywordMatches(normalizeArabic('اي تعليق'), '', 'word'), false);
    });

    it('returns false for empty text', () => {
        assert.equal(keywordMatches('', TAMM, 'word'), false);
    });

    it('treats regex metacharacters in a keyword as literals', () => {
        // Unescaped, "c++" is not a valid pattern and constructing the RegExp throws — a
        // campaign keyword is operator input, not a pattern.
        assert.equal(keywordMatches('c++ course', 'c++', 'word'), true);
        assert.equal(keywordMatches('c# course', 'c++', 'word'), false);
        assert.doesNotThrow(() => keywordMatches('anything', '(', 'word'));
        assert.doesNotThrow(() => keywordMatches('anything', '[a-', 'word'));
    });
});
