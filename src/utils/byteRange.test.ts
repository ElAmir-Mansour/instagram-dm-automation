import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentRange, parseByteRange } from './byteRange.js';

describe('parseByteRange', () => {
    it('reads the three single-range forms', () => {
        assert.deepEqual(parseByteRange('bytes=0-1023', 6000), { kind: 'range', start: 0, end: 1023, total: 6000 });
        assert.deepEqual(parseByteRange('bytes=1000-', 6000), { kind: 'range', start: 1000, end: 5999, total: 6000 });
        assert.deepEqual(parseByteRange('bytes=-500', 6000), { kind: 'range', start: 5500, end: 5999, total: 6000 });
    });

    it('clamps an end past the file, and a suffix longer than the file', () => {
        assert.deepEqual(parseByteRange('bytes=5000-99999', 6000), { kind: 'range', start: 5000, end: 5999, total: 6000 });
        assert.deepEqual(parseByteRange('bytes=-99999', 6000), { kind: 'range', start: 0, end: 5999, total: 6000 });
        assert.deepEqual(parseByteRange(' bytes=0-0 ', 1), { kind: 'range', start: 0, end: 0, total: 1 });
    });

    it('is unsatisfiable when the range starts at or past the end', () => {
        assert.deepEqual(parseByteRange('bytes=6000-', 6000), { kind: 'unsatisfiable', total: 6000 });
        assert.deepEqual(parseByteRange('bytes=7000-8000', 6000), { kind: 'unsatisfiable', total: 6000 });
        assert.deepEqual(parseByteRange('bytes=-0', 6000), { kind: 'unsatisfiable', total: 6000 });
        assert.deepEqual(parseByteRange('bytes=0-', 0), { kind: 'unsatisfiable', total: 0 });
    });

    it('ignores what it will not process: the whole file is served instead', () => {
        for (const header of [undefined, '', 'bytes=', 'bytes=-', 'bytes=0-1,5-6', 'items=0-1', 'bytes=5-1', 'bytes=a-b', 'bytes=1-2-3', ['bytes=0-1']]) {
            assert.deepEqual(parseByteRange(header, 6000), { kind: 'none' }, String(header));
        }
    });

    it('ignores any range when the size is not known', () => {
        assert.deepEqual(parseByteRange('bytes=0-1023', null), { kind: 'none' });
    });

    it('writes Content-Range', () => {
        assert.equal(contentRange({ start: 0, end: 1023, total: 6000 }), 'bytes 0-1023/6000');
    });
});
