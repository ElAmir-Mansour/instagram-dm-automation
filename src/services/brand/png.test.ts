import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pngCanHoldAlpha } from './png.js';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]): number[] => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const ihdr = (colourType: number): number[] => chunk('IHDR', [...u32(300), ...u32(300), 8, colourType, 0, 0, 0]);
const png = (colourType: number, ...chunks: number[][]): Uint8Array => new Uint8Array([...SIGNATURE, ...ihdr(colourType), ...chunks.flat()]);

describe('pngCanHoldAlpha', () => {
    it('colour types 4 (grey + alpha) and 6 (RGBA) can', () => {
        assert.equal(pngCanHoldAlpha(png(6, chunk('IDAT', [1, 2, 3]), chunk('IEND', []))), true);
        assert.equal(pngCanHoldAlpha(png(4, chunk('IDAT', [1]))), true);
    });

    it('colour types 0 (grey) and 2 (RGB) without tRNS cannot', () => {
        assert.equal(pngCanHoldAlpha(png(0, chunk('IDAT', [1]), chunk('IEND', []))), false);
        assert.equal(pngCanHoldAlpha(png(2, chunk('IDAT', [1]), chunk('IEND', []))), false);
    });

    it('a tRNS chunk before the first IDAT can, for a palette (3), grey and RGB image', () => {
        for (const type of [0, 2, 3]) assert.equal(pngCanHoldAlpha(png(type, chunk('PLTE', [0, 0, 0]), chunk('tRNS', [0]), chunk('IDAT', [1]))), true, `type ${type}`);
    });

    it('a tRNS chunk after the first IDAT does not count', () => {
        assert.equal(pngCanHoldAlpha(png(2, chunk('IDAT', [1]), chunk('tRNS', [0]), chunk('IEND', []))), false);
    });

    it('an unknown chunk is stepped over by its length: its bytes are never read as a chunk name', () => {
        // The data of the first chunk spells "tRNS" at a place where a name would be: stepping by length must skip it.
        const decoy = chunk('tEXt', [0, 0, 0, 0, 0x74, 0x52, 0x4e, 0x53, 0, 0, 0, 0]);
        assert.equal(pngCanHoldAlpha(png(2, decoy, chunk('IDAT', [1]))), false);
    });

    it('bytes that are not a PNG, or are cut short, are false and never throw', () => {
        assert.equal(pngCanHoldAlpha(new Uint8Array([])), false);
        assert.equal(pngCanHoldAlpha(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), false);
        assert.equal(pngCanHoldAlpha(new Uint8Array(png(6).slice(0, 20))), false);
        assert.equal(pngCanHoldAlpha(png(2).slice(0, 40)), false);
        // A chunk that claims more than the file holds.
        assert.equal(pngCanHoldAlpha(new Uint8Array([...SIGNATURE, ...ihdr(2), ...u32(0xffffffff), 0x49, 0x44, 0x41, 0x54])), false);
    });
});
