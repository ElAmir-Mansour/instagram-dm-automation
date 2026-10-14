/**
 * The helpers the sales modules share (`text.ts`): digits and numbers in both scripts, and the cut that keeps a reply inside Instagram's
 * limit. Instagram counts UTF-8 BYTES (1,000), Arabic is two bytes a letter, and an emoji is up to twenty-five: a cut by characters
 * overshoots, and a cut by bytes can split a letter from its mark or an emoji from its joiner.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonNumber, capUtf8Bytes, extractNumbers, graphemes, normalizeDigits, numberSpans, utf8Bytes } from './text.js';
import { MAX_REPLY_BYTES } from './types.js';

describe('normalizeDigits', () => {
    it('writes Arabic-Indic and Eastern Arabic-Indic digits as ASCII, and the Arabic decimal and thousands marks as "." and ","', () => {
        assert.equal(normalizeDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
        assert.equal(normalizeDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
        assert.equal(normalizeDigits('٤٩٫٩٩'), '49.99');
        assert.equal(normalizeDigits('١٬٢٠٠'), '1,200');
    });

    it('keeps every position: one character in, one out', () => {
        const text = 'السعر ٣٤٩ ريال';
        assert.equal(normalizeDigits(text).length, text.length);
        assert.equal(normalizeDigits(text), 'السعر 349 ريال');
    });
});

describe('canonNumber and extractNumbers: one number, one spelling', () => {
    const same: [string, string][] = [
        ['1,000', '1000'], ['1,299.50', '1299.5'], ['09', '9'], ['007', '7'], ['00', '0'], ['49.0', '49'], ['49.50', '49.5'], ['49.990', '49.99'], ['0.5', '0.5'], ['0', '0'],
    ];
    for (const [raw, canon] of same) it(`${raw} is ${canon}`, () => assert.equal(canonNumber(raw), canon));

    it('finds the numbers of a text, in either script', () => {
        assert.deepEqual([...extractNumbers('فيه ٤٩ درس و12 مشروع، والسعر ٣٤٩٫٥٠ و1,200 طالب')].sort(), ['12', '1200', '349.5', '49']);
        assert.deepEqual([...extractNumbers('09:00-17:30')].sort(), ['0', '17', '30', '9']);
    });

    it('reads a number glued to a letter, as Arabic is typed: «100ريال», «ب49»', () => {
        assert.deepEqual([...extractNumbers('100ريال')], ['100']);
        assert.deepEqual([...extractNumbers('بـ49')], ['49']);
        assert.deepEqual([...extractNumbers('49USD')], ['49']);
    });

    it('does not read "1,5" as one decimal: a comma that is not a thousands mark separates two numbers', () => {
        assert.deepEqual([...extractNumbers('1,5')].sort(), ['1', '5']);
    });

    it('does not count a keycap emoji or the "1." that opens a list line', () => {
        assert.deepEqual([...extractNumbers('1️⃣ ابدأ 2️⃣ ثم')], []);
        assert.deepEqual([...extractNumbers('1. ابدأ\n2) ثم\n 3- وأخيراً')], []);
        assert.deepEqual([...extractNumbers('بعد 3 خطوات')], ['3']);
    });

    it('says where each number is', () => {
        const spans = numberSpans('a 12 b 3.5');
        assert.deepEqual(spans.map((s) => [s.value, s.start, s.end]), [['12', 2, 4], ['3.5', 7, 10]]);
    });
});

/** The bytes round-trip: no replacement character, no half of a pair. */
function assertWholeText(out: string): void {
    assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out, 'it is valid UTF-8');
    assert.ok(!out.includes('�'), 'no replacement character');
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out), 'no lone surrogate');
}

describe('capUtf8Bytes: Instagram counts bytes, and a character is never split', () => {
    it('counts bytes, not letters: Arabic is two a letter, an emoji four, the family emoji twenty-five', () => {
        assert.equal(utf8Bytes('abc'), 3);
        assert.equal(utf8Bytes('مرحبا'), 10);
        assert.equal(utf8Bytes('🙏'), 4);
        assert.equal(utf8Bytes('👨‍👩‍👧'), 18);
        assert.equal(utf8Bytes('…'), 3);
    });

    it('leaves a text inside the cap exactly as it is', () => {
        for (const text of ['', 'hello', 'مرحبا بك', 'a'.repeat(900), 'ا'.repeat(450), 'ا'.repeat(448) + 'abc']) {
            assert.equal(capUtf8Bytes(text, MAX_REPLY_BYTES), text);
        }
    });

    it('cuts 600 Arabic letters, which are about 1,200 bytes, to at most 900 bytes: the case a character cap gets wrong', () => {
        const text = 'ك'.repeat(600);
        assert.ok(utf8Bytes(text) > 1000, 'it would be refused by Instagram');
        const out = capUtf8Bytes(text, MAX_REPLY_BYTES);
        assert.ok(utf8Bytes(out) <= MAX_REPLY_BYTES, `${utf8Bytes(out)} bytes`);
        assert.ok(utf8Bytes(out) >= MAX_REPLY_BYTES - 6, 'and it keeps as much as fits');
        assertWholeText(out);
    });

    it('one byte over is cut, exactly at the cap is not', () => {
        assert.equal(capUtf8Bytes('a'.repeat(900), 900).length, 900);
        assert.ok(utf8Bytes(capUtf8Bytes('a'.repeat(901), 900)) <= 900);
        assert.ok(utf8Bytes(capUtf8Bytes('ا'.repeat(451), 900)) <= 900);
    });

    it('cuts at the end of a sentence when the second half has one, and does not close it with a mark', () => {
        const text = `${'كلمة '.repeat(60).trim()}. ${'أخرى '.repeat(120).trim()}`;
        const out = capUtf8Bytes(text, 400);
        assert.ok(utf8Bytes(out) <= 400);
        assert.ok(out.endsWith('.') || out.endsWith('…'));
        const sentences = capUtf8Bytes('Short. '.repeat(200), 100);
        assert.ok(sentences.endsWith('.'), sentences);
        assert.ok(utf8Bytes(sentences) <= 100);
    });

    it('cuts at a space and closes with "…" when there is no sentence end, and the "…" is counted', () => {
        const out = capUtf8Bytes('word '.repeat(300), 100);
        assert.ok(out.endsWith('…'), out);
        assert.ok(utf8Bytes(out) <= 100);
        assert.ok(!out.endsWith(' …'), 'no space before it');
        assert.ok(out.slice(0, -1).split(' ').every((w) => w === 'word'), 'whole words only');
    });

    it('cuts a word with no space in it, and says so with "…"', () => {
        const out = capUtf8Bytes('x'.repeat(2000), 100);
        assert.equal(out, `${'x'.repeat(97)}…`);
        assert.equal(utf8Bytes(out), 100);
    });

    it('never splits an emoji from its joiners: a family that does not fit is left out whole', () => {
        const family = '👨‍👩‍👧';
        const text = `${'ا'.repeat(446)}${family}`;
        assert.equal(utf8Bytes(text), 892 + 18);
        const out = capUtf8Bytes(text, 900);
        assertWholeText(out);
        assert.ok(!out.includes('‍') && !out.includes('👨') && !out.includes('👩') && !out.includes('👧'), out.slice(-8));
        assert.ok(utf8Bytes(out) <= 900);
    });

    it('never splits a letter from its marks: Arabic diacritics and a Latin accent stay with their base', () => {
        const marked = 'مَرْحَبًا'.repeat(100);
        const accents = 'é'.repeat(800);
        for (const text of [marked, accents]) {
            const out = capUtf8Bytes(text, 400);
            assertWholeText(out);
            assert.ok(utf8Bytes(out) <= 400);
            const body = out.endsWith('…') ? out.slice(0, -1) : out;
            // What is left is a whole number of the text's own graphemes: a cut inside one would leave a mark without its base.
            assert.deepEqual(graphemes(body), graphemes(text).slice(0, graphemes(body).length));
            assert.ok(!/^[̀-ًͯ-ٟ]/.test(body), 'does not start with a stray mark');
        }
    });

    it('never splits an emoji with a skin tone or a flag', () => {
        for (const emoji of ['👍🏽', '🇸🇦', '🧑🏽‍💻', '1️⃣']) {
            const text = 'ا'.repeat(447) + emoji + 'ب'.repeat(10);
            const out = capUtf8Bytes(text, 900);
            assertWholeText(out);
            assert.ok(utf8Bytes(out) <= 900);
            const g = graphemes(out.endsWith('…') ? out.slice(0, -1) : out);
            assert.ok(g.every((x) => graphemes(text).includes(x)), `${emoji}: every piece is a piece of the text`);
        }
    });

    it('drops a half of a surrogate pair that was already broken, instead of sending U+FFFD', () => {
        const broken = `abc${'\ud83d'}def`;
        assert.equal(capUtf8Bytes(broken, 900), 'abcdef');
        assert.equal(capUtf8Bytes(`x${'\ude4f'}y`, 900), 'xy');
    });

    it('fits whatever is thrown at it, for every cap from 4 to 200 bytes (a seeded sweep over scripts)', () => {
        const pieces = ['a', 'ب', 'ك', 'é', 'é', '🙏', '👍🏽', '👨‍👩‍👧', '🇸🇦', '1️⃣', ' ', ' ', '.', '،', '؟', '日', '\n'];
        let seed = 20261014;
        const next = (): number => {
            seed = (seed * 1664525 + 1013904223) >>> 0;
            return seed / 2 ** 32;
        };
        for (let n = 0; n < 60; n++) {
            const text = Array.from({ length: 5 + Math.floor(next() * 120) }, () => pieces[Math.floor(next() * pieces.length)]!).join('');
            for (const cap of [4, 5, 9, 17, 40, 100, 200]) {
                const out = capUtf8Bytes(text, cap);
                assert.ok(utf8Bytes(out) <= cap, `${JSON.stringify(text)} at ${cap}: ${utf8Bytes(out)} bytes`);
                assertWholeText(out);
            }
        }
    });

    it('with no room for a mark at all, keeps the whole graphemes that fit', () => {
        assert.equal(capUtf8Bytes('abcdef', 2), 'ab');
        assert.equal(capUtf8Bytes('🙏🙏', 0), '');
    });
});
