/**
 * The two pictures the benchmark draws (`synthetic.ts`): that they are valid PNGs of the size they say, that the same input is always the same bytes, that the font can draw every
 * letter the cards use (and refuses one it cannot, instead of leaving a blank), and that what they say is made up.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import {
    crc32, drawText, encodePng, FONT_CHARS, glyphRows, GLYPH_COLUMNS, GLYPH_ROWS, ID_CARD_LINES, ID_CARD_TITLE, idCardPng, isSyntheticCard, newCanvas, STORY_CARD_LINES, storyCardPng, SYNTHETIC_CARDS,
    syntheticMedia, textWidth,
} from './synthetic.js';

/** A PNG read as a decoder would: the signature, then every chunk with its CRC checked. */
function chunks(png: Buffer): { type: string; data: Buffer }[] {
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the PNG signature');
    const out: { type: string; data: Buffer }[] = [];
    for (let at = 8; at < png.length;) {
        const length = png.readUInt32BE(at);
        const type = png.toString('ascii', at + 4, at + 8);
        const data = png.subarray(at + 8, at + 8 + length);
        assert.equal(png.readUInt32BE(at + 8 + length), crc32(png.subarray(at + 4, at + 8 + length)), `the CRC of ${type}`);
        out.push({ type, data });
        at += 12 + length;
    }
    return out;
}

describe('crc32', () => {
    it('is the standard CRC-32 (the check value of "123456789" is cbf43926)', () => {
        assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
        assert.equal(crc32(Buffer.alloc(0)), 0);
    });
});

describe('the font', () => {
    it('is seven rows of five cells for every character, and nothing else in a row', () => {
        for (const ch of FONT_CHARS) {
            const rows = glyphRows(ch);
            assert.equal(rows.length, GLYPH_ROWS, ch);
            for (const row of rows) assert.match(row, /^[# ]{5}$/, `${ch}: ${row}`);
            assert.equal(GLYPH_COLUMNS, 5);
        }
    });

    it('draws every letter and digit the benchmark could ask for, and the space', () => {
        for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ') assert.ok(FONT_CHARS.includes(ch), ch);
    });

    it('gives every letter its own shape: no two glyphs are the same picture (a typo in a table would show here)', () => {
        const seen = new Map<string, string>();
        for (const ch of FONT_CHARS) {
            const key = glyphRows(ch).join('/');
            assert.equal(seen.get(key), undefined, `${ch} is drawn as ${seen.get(key)}`);
            seen.set(key, ch);
        }
    });

    it('draws an A as an A', () => {
        assert.deepEqual([...glyphRows('A')], [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #']);
    });

    it('refuses a character it has no glyph for, instead of leaving a gap', () => {
        const c = newCanvas(100, 40, 255);
        assert.throws(() => drawText(c, 'a b @', 0, 0, 2, 0), /no glyph for "@"/);
        assert.throws(() => glyphRows('é'), /no glyph/);
    });

    it('draws lower case as upper case, inside the canvas, in the ink it was given', () => {
        const c = newCanvas(120, 30, 255);
        const width = drawText(c, 'hi', 4, 4, 3, 10);
        assert.equal(width, textWidth('HI', 3));
        const ink = [...c.pixels].filter((v) => v === 10).length;
        assert.ok(ink > 0);
        assert.equal(c.pixels.length, 120 * 30);
        assert.ok([...c.pixels].every((v) => v === 10 || v === 255));
    });

    it('measures a text as its letters and the one blank column between them, at the scale', () => {
        assert.equal(textWidth('', 4), 0);
        assert.equal(textWidth('A', 4), 5 * 4);
        assert.equal(textWidth('AB', 4), 2 * 5 * 4 + 4);
    });
});

describe('the PNGs', () => {
    it('are valid: IHDR, one IDAT that inflates to exactly the rows, IEND, every CRC right', () => {
        for (const [name, png, width, height] of [['id card', idCardPng(), 760, 470], ['story', storyCardPng(), 540, 960]] as const) {
            const parts = chunks(png);
            assert.deepEqual(parts.map((p) => p.type), ['IHDR', 'IDAT', 'IEND'], name);
            const ihdr = parts[0]!.data;
            assert.deepEqual([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)], [width, height], name);
            assert.deepEqual([...ihdr.subarray(8)], [8, 0, 0, 0, 0], `${name}: 8-bit grayscale, deflate, adaptive filtering, no interlace`);
            const raw = zlib.inflateSync(parts[1]!.data);
            assert.equal(raw.length, height * (1 + width), name);
            for (let y = 0; y < height; y++) assert.equal(raw[y * (1 + width)], 0, `${name}: row ${y} has filter type none`);
        }
    });

    it('are the same bytes every time: a case is the same picture on every run', () => {
        assert.ok(idCardPng().equals(idCardPng()));
        assert.ok(storyCardPng().equals(storyCardPng()));
        assert.ok(!idCardPng().equals(storyCardPng()));
    });

    it('have some ink and some paper: neither is blank', () => {
        for (const png of [idCardPng(), storyCardPng()]) {
            const raw = zlib.inflateSync(chunks(png)[1]!.data);
            assert.ok(new Set(raw).size >= 3, 'at least a paper, an ink and a filter byte');
        }
    });

    it('can be drawn by the font: every letter on the cards has a glyph', () => {
        for (const line of [ID_CARD_TITLE, ...ID_CARD_LINES, ...STORY_CARD_LINES, 'PHOTO', 'ID-CARD-0001']) {
            for (const ch of line.toUpperCase()) assert.ok(FONT_CHARS.includes(ch), `${ch} in "${line}"`);
        }
    });

    it('say things that are made up: an example surname, a counting number, a country that does not exist', () => {
        const all = ID_CARD_LINES.join(' ');
        assert.match(all, /SURNAME: EXAMPLE/);
        assert.match(all, /1234 5678 9012/);
        assert.match(all, /UTOPIA/);
        assert.equal(ID_CARD_TITLE, 'NATIONAL IDENTITY CARD');
    });

    it('give the story no digit, no handle and no link, so that a summary of it can be said back to the person', () => {
        const all = STORY_CARD_LINES.join(' ');
        assert.doesNotMatch(all, /[0-9@/.]/);
        assert.doesNotMatch(all, /https?|www|\.com/i);
    });

    it('come out of syntheticMedia as the bytes a download would give: a picture, image/png', () => {
        assert.deepEqual([...SYNTHETIC_CARDS], ['id_card', 'story_card']);
        for (const card of SYNTHETIC_CARDS) {
            const m = syntheticMedia(card);
            assert.equal(m.mime, 'image/png');
            assert.ok(m.bytes.equals(card === 'id_card' ? idCardPng() : storyCardPng()));
        }
        assert.equal(isSyntheticCard('id_card'), true);
        assert.equal(isSyntheticCard('passport'), false);
    });

    it('encodePng writes the canvas it is given', () => {
        const c = newCanvas(3, 2, 7);
        const parts = chunks(encodePng(c));
        const raw = zlib.inflateSync(parts[1]!.data);
        assert.deepEqual([...raw], [0, 7, 7, 7, 0, 7, 7, 7]);
    });
});
