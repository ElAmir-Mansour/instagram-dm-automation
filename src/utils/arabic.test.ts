/**
 * Normalisation is what decides whether a real comment triggers a campaign, and every failure
 * mode here is silent: the comment matches nothing, no row is written, and the operator sees
 * an empty dashboard rather than an error.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    isKeywordMatchMode, keywordMatches, normalizeArabic, normalizeArabicWithMap, normalizeMatchMode,
} from './arabic.js';

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

describe('normalizeMatchMode', () => {
    it("reads 'word' and passes 'substring' through", () => {
        assert.equal(normalizeMatchMode('word'), 'word');
        assert.equal(normalizeMatchMode('substring'), 'substring');
    });

    it('falls back to substring for anything unrecognised', () => {
        // This runs on the webhook's critical path against a value read from a row —
        // including a row from a query that forgot to select the column, and every campaign
        // created before migration v14. The alternative to falling back is answering nobody.
        for (const bad of [undefined, null, '', 'WORD', 'exact', 'regex', 0, 1, true, {}, []]) {
            assert.equal(normalizeMatchMode(bad), 'substring', `input ${JSON.stringify(bad)}`);
        }
    });
});

describe('isKeywordMatchMode', () => {
    it('accepts exactly the two supported modes', () => {
        assert.equal(isKeywordMatchMode('substring'), true);
        assert.equal(isKeywordMatchMode('word'), true);
    });

    it('rejects everything else, so a typo in the API is a 400 and not a silent default', () => {
        // Deliberately stricter than normalizeMatchMode. A campaign owner who types
        // `match_mode: "exact"` and is quietly given substring matching has been told their
        // short keyword is safe when it is not.
        for (const bad of [undefined, null, '', 'WORD', 'Word', 'exact', 'substring ', 0, true]) {
            assert.equal(isKeywordMatchMode(bad), false, `input ${JSON.stringify(bad)}`);
        }
    });
});

describe('normalizeArabicWithMap', () => {
    const SAMPLES = [
        '', ' ', '   \n\t ', 'abc', 'ABC DEF', 'اكـــسب 500$ يوميـاً', 'إحصل على وظيفة', 'أحصل  على\u00A0وظيفة  ',
        '  بِدُونِ مَجْهُود ', 'برمجة وعلى وأوبال وآية', 'تـ ـم', 'a ـ b', 'a\u064Bb', '\u064Bابت', 'ابت\u064B ', 'İstanbul İ',
        'ΟΔΟΣ ΣΟΦΟΣ', 'x\u{1D7D8}y \u{10400}A', 'مرحبا\u200Bبكم', 'line1\nline2\r\n\r\nline3',
    ];

    it('returns exactly the text normalizeArabic returns, for hand-picked inputs', () => {
        for (const s of SAMPLES) {
            assert.equal(normalizeArabicWithMap(s).text, normalizeArabic(s), JSON.stringify(s));
        }
    });

    it('returns exactly the text normalizeArabic returns, for random Arabic/Latin/whitespace soup', () => {
        // A small deterministic generator (no Math.random: a failure must reproduce).
        let seed = 20261022;
        const next = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
        const alphabet = [
            'ا', 'أ', 'إ', 'آ', 'ب', 'ت', 'ة', 'ه', 'ى', 'ي', 'ك', 'م', 'ـ', '\u064E', '\u064F', '\u0651', '\u0670',
            ' ', ' ', '\n', '\t', '\u00A0', 'a', 'B', 'Z', '5', '٥', '$', '%', 'Σ', 'İ', '\u{1F600}', '\u200B',
        ];
        for (let n = 0; n < 2000; n++) {
            let s = '';
            const len = Math.floor(next() * 14);
            for (let i = 0; i < len; i++) s += alphabet[Math.floor(next() * alphabet.length)];
            assert.equal(normalizeArabicWithMap(s).text, normalizeArabic(s), JSON.stringify(s));
        }
    });

    it('has one map entry per output character plus a sentinel equal to the original length', () => {
        for (const s of SAMPLES) {
            const { text, map } = normalizeArabicWithMap(s);
            assert.equal(map.length, text.length + 1, JSON.stringify(s));
            assert.equal(map[map.length - 1], s.length, JSON.stringify(s));
            for (let i = 1; i < map.length; i++) assert.ok(map[i]! >= map[i - 1]!, 'the map never goes backwards');
        }
    });

    it('maps each output character to the character it came from', () => {
        const s = 'اكـــسب  ٥٠٠$ يوميـاً';
        const { text, map } = normalizeArabicWithMap(s);
        assert.equal(text, 'اكسب ٥٠٠$ يوميا');
        assert.equal(s[map[0]!], 'ا');
        assert.equal(s[map[2]!], 'س', 'the tatweels are skipped');
        assert.equal(s[map[4]!], ' ', 'a whitespace run maps to its first character');
        assert.equal(map[5], s.indexOf('٥'), 'the next word starts after the whole run');
        assert.equal(s[map[text.indexOf('ا', 10)]!], 'ا', 'the alef before the trailing tanween');
    });

    it('trims, mapping the first kept character to its original position', () => {
        const { text, map } = normalizeArabicWithMap('  \u064B كور\u064Bس  ');
        assert.equal(text, 'كورس');
        assert.deepEqual(map, [4, 5, 6, 8, 11]);
    });

    it('folds a folded character in place (أ -> ا keeps its index) and maps an empty result', () => {
        assert.deepEqual(normalizeArabicWithMap('أب').map, [0, 1, 2]);
        assert.deepEqual(normalizeArabicWithMap('\u0640\u0640'), { text: '', map: [2] });
        assert.deepEqual(normalizeArabicWithMap(''), { text: '', map: [0] });
    });
});
