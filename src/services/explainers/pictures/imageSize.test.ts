/**
 * The size and kind of a PNG or JPEG, read from its header bytes (imageSize.ts). The app has no image library and must not get one, so the
 * guard "a reference must be smaller than 512×512" stands on these few lines: every shape of header the browser's canvas, a phone or an
 * editor writes has to give the right answer, and a file that is not a picture, or is cut short, has to give none rather than a guess.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readPictureInfo, sniffPictureMime } from './imageSize.js';

/** The first 33 bytes of a PNG: the signature and the IHDR chunk, which is all the size lives in. */
function png(width: number, height: number): Buffer {
    const out = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
    out.writeUInt32BE(13, 8);
    out.write('IHDR', 12, 'ascii');
    out.writeUInt32BE(width, 16);
    out.writeUInt32BE(height, 20);
    out[24] = 8; // bit depth
    out[25] = 6; // colour type: RGBA
    return out;
}

/** A segment: marker, a length that counts itself, then the payload. */
const segment = (marker: number, payload: Buffer): Buffer => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);

/** A start-of-frame payload: precision, height, width, then one component. */
const frame = (width: number, height: number): Buffer => Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]);

/** A JPEG as far as its header: SOI, whatever comes before the frame, the frame, and the start of the scan. */
function jpeg(width: number, height: number, opts: { sof?: number; before?: Buffer[]; padding?: number } = {}): Buffer {
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        ...(opts.before ?? []),
        Buffer.alloc(opts.padding ?? 0, 0xff),
        segment(opts.sof ?? 0xc0, frame(width, height)),
        segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
        Buffer.from([0x12, 0x34, 0xff, 0xd9]),
    ]);
}

const JFIF = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary'));
const EXIF = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), Buffer.alloc(300, 7)]));

describe('sniffPictureMime', () => {
    it('knows a PNG by its signature and a JPEG by its start-of-image, and nothing else', () => {
        assert.equal(sniffPictureMime(png(10, 10)), 'image/png');
        assert.equal(sniffPictureMime(jpeg(10, 10)), 'image/jpeg');
        assert.equal(sniffPictureMime(Buffer.from('RIFF....WEBPVP8 ', 'ascii')), null, 'a WebP is not a picture the provider takes');
        assert.equal(sniffPictureMime(Buffer.from('GIF89a', 'ascii')), null);
        assert.equal(sniffPictureMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')), null);
        assert.equal(sniffPictureMime(Buffer.alloc(0)), null);
        assert.equal(sniffPictureMime(Buffer.from([0xff, 0xd8])), null, 'two bytes are not enough to be sure');
    });
});

describe('readPictureInfo — PNG', () => {
    it('reads the width and height from the IHDR chunk', () => {
        assert.deepEqual(readPictureInfo(png(448, 448)), { mime: 'image/png', width: 448, height: 448 });
        assert.deepEqual(readPictureInfo(png(1024, 576)), { mime: 'image/png', width: 1024, height: 576 });
        assert.deepEqual(readPictureInfo(png(16, 9)), { mime: 'image/png', width: 16, height: 9 });
    });

    it('reads sides over 16 bits: a PNG can be 70000 pixels wide', () => {
        assert.deepEqual(readPictureInfo(png(70_000, 3)), { mime: 'image/png', width: 70_000, height: 3 });
    });

    it('gives nothing for a PNG cut short, one whose first chunk is not IHDR, or one with a side of zero', () => {
        assert.equal(readPictureInfo(png(448, 448).subarray(0, 23)), null);
        const wrongChunk = png(448, 448);
        wrongChunk.write('IDAT', 12, 'ascii');
        assert.equal(readPictureInfo(wrongChunk), null);
        assert.equal(readPictureInfo(png(0, 448)), null);
        assert.equal(readPictureInfo(png(448, 0)), null);
    });
});

describe('readPictureInfo — JPEG', () => {
    it('reads the frame header of a baseline JPEG (the height comes first in the segment, the width second)', () => {
        assert.deepEqual(readPictureInfo(jpeg(448, 300)), { mime: 'image/jpeg', width: 448, height: 300 });
        assert.deepEqual(readPictureInfo(jpeg(300, 448)), { mime: 'image/jpeg', width: 300, height: 448 });
    });

    it('finds the frame after the segments a camera or an editor writes first (JFIF, EXIF)', () => {
        assert.deepEqual(readPictureInfo(jpeg(512, 384, { before: [JFIF, EXIF] })), { mime: 'image/jpeg', width: 512, height: 384 });
    });

    it('reads every kind of frame: baseline, extended, progressive, lossless, arithmetic', () => {
        for (const sof of [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
            assert.deepEqual(readPictureInfo(jpeg(640, 480, { sof })), { mime: 'image/jpeg', width: 640, height: 480 }, `SOF 0x${sof.toString(16)}`);
        }
    });

    it('does not take the Huffman table (0xC4), the JPEG extension (0xC8) or the arithmetic table (0xCC) for a frame', () => {
        for (const marker of [0xc4, 0xc8, 0xcc]) {
            assert.equal(readPictureInfo(jpeg(640, 480, { sof: marker })), null, `marker 0x${marker.toString(16)}`);
        }
    });

    it('skips the fill bytes (extra 0xFF) a writer may put before a marker', () => {
        assert.deepEqual(readPictureInfo(jpeg(500, 400, { before: [JFIF], padding: 5 })), { mime: 'image/jpeg', width: 500, height: 400 });
    });

    it('steps over a thumbnail inside an EXIF segment: its own frame is not the picture’s', () => {
        const thumbnail = jpeg(160, 120);
        const exifWithThumb = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), thumbnail]));
        assert.deepEqual(readPictureInfo(jpeg(900, 700, { before: [exifWithThumb] })), { mime: 'image/jpeg', width: 900, height: 700 });
    });

    it('gives nothing when the scan or the end comes before any frame, when the data is cut short, or when a side is zero', () => {
        assert.equal(readPictureInfo(Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, Buffer.from([1, 1, 0]))])), null);
        assert.equal(readPictureInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
        assert.equal(readPictureInfo(jpeg(448, 448).subarray(0, 8)), null);
        assert.equal(readPictureInfo(jpeg(0, 448)), null);
        assert.equal(readPictureInfo(jpeg(448, 0)), null);
    });

    it('gives nothing for a segment whose length would run past the end, or that is shorter than its own length field', () => {
        assert.equal(readPictureInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 1, 2, 3])), null);
        assert.equal(readPictureInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0xff, 0xc0])), null);
    });

    it('gives nothing when the markers lose their 0xFF prefix: that is not a JPEG header any more', () => {
        assert.equal(readPictureInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0x12, 0x34, 0x56, 0x78])), null);
    });
});

describe('readPictureInfo — anything else', () => {
    it('gives nothing for bytes that are not a PNG or a JPEG, and never throws', () => {
        assert.equal(readPictureInfo(Buffer.from('not a picture at all', 'utf8')), null);
        assert.equal(readPictureInfo(Buffer.alloc(0)), null);
        assert.equal(readPictureInfo(Buffer.alloc(64, 0xff)), null);
        for (let i = 0; i < 200; i++) {
            const noise = Buffer.alloc(40 + (i % 30));
            for (let j = 0; j < noise.length; j++) noise[j] = (i * 31 + j * 17) & 0xff;
            assert.doesNotThrow(() => readPictureInfo(noise));
        }
    });

    it('takes a Uint8Array as well as a Buffer', () => {
        assert.deepEqual(readPictureInfo(new Uint8Array(png(300, 200))), { mime: 'image/png', width: 300, height: 200 });
    });
});
