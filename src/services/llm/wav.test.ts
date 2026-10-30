/**
 * The WAV reader (`wav.ts`): what Meta's speech endpoint takes, and how long a file plays, without ffprobe. The headers here are built by hand, including the one
 * ffmpeg really writes (a `LIST` chunk before `data`: the 2026-10-30 probe's 1-second tone was 49,118 bytes, 78 of them header).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wavBytes } from './testAudio.js';
import { ASR_SAMPLE_RATES, isAsrWav, parseWav } from './wav.js';

const info = (spec: Parameters<typeof wavBytes>[0]) => {
    const parsed = parseWav(wavBytes(spec));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    return parsed.info;
};

describe('parseWav: what a file is', () => {
    it('reads the format, where the samples start and how long they play, for a plain 44-byte header', () => {
        const wav = info({ seconds: 2 });
        assert.deepEqual(wav, { format: 1, channels: 1, sampleRate: 24_000, bitsPerSample: 16, dataOffset: 44, dataBytes: 96_000, durationMs: 2000 });
    });

    it('walks the chunks: ffmpeg\'s LIST/INFO chunk puts the samples at byte 78, and the duration is the samples\' and not the file\'s', () => {
        const bytes = wavBytes({ seconds: 1, info: true });
        assert.equal(bytes.length, 78 + 48_000);
        const parsed = parseWav(bytes);
        assert.ok(parsed.ok);
        assert.equal(parsed.info.dataOffset, 78);
        assert.equal(parsed.info.dataBytes, 48_000);
        assert.equal(parsed.info.durationMs, 1000);
    });

    it('measures the probe\'s own file: 49,118 bytes with a 78-byte header is 49,040 bytes of samples, 1,021.7 ms', () => {
        // The shape the Vercel preview returned on 2026-10-30 for a 1-second AAC tone: the encoder's padding makes it a little longer than a second.
        const parsed = parseWav(wavBytes({ seconds: 49_040 / 48_000, info: true }));
        assert.ok(parsed.ok);
        assert.equal(parsed.info.dataBytes, 49_040);
        assert.equal(parsed.info.durationMs, 1022);
    });

    it('takes the length from the byte rate: 16 kHz is 32,000 bytes a second, and stereo or 8-bit change it', () => {
        assert.equal(info({ seconds: 1, rate: 16_000 }).durationMs, 1000);
        assert.equal(info({ seconds: 1, rate: 16_000 }).dataBytes, 32_000);
        assert.equal(info({ seconds: 1, rate: 24_000, channels: 2 }).dataBytes, 96_000);
        assert.equal(info({ seconds: 3, rate: 24_000, channels: 2 }).durationMs, 3000);
        assert.equal(info({ seconds: 1, rate: 8_000, bits: 8 }).dataBytes, 8_000);
    });

    it('a data size larger than the file (a stream that was never finalised writes 0xFFFFFFFF) is read as the rest of the file, never trusted', () => {
        assert.equal(info({ seconds: 1, dataSize: 0xffffffff }).dataBytes, 48_000);
        assert.equal(info({ seconds: 1, dataSize: 0xffffffff }).durationMs, 1000);
        assert.equal(info({ seconds: 1, dataSize: 10_000_000 }).durationMs, 1000);
    });

    it('a data size smaller than the file is what it says: the samples end where the header says, and what follows is not audio', () => {
        assert.equal(info({ seconds: 1, dataSize: 24_000 }).durationMs, 500);
    });

    it('a file with no samples is a WAV of zero length', () => {
        const wav = info({ seconds: 0 });
        assert.equal(wav.dataBytes, 0);
        assert.equal(wav.durationMs, 0);
    });

    it('skips a chunk it does not know, and the pad byte after an odd-sized one', () => {
        const base = wavBytes({ seconds: 1 });
        // Insert a 5-byte chunk "junk" (padded to 6) between `fmt ` (ends at 36) and `data`.
        const junk = Buffer.concat([Buffer.from('junk'), Buffer.from([5, 0, 0, 0]), Buffer.from([1, 2, 3, 4, 5, 0])]);
        const bytes = Buffer.concat([base.subarray(0, 36), junk, base.subarray(36)]);
        const parsed = parseWav(bytes);
        assert.ok(parsed.ok);
        assert.equal(parsed.info.dataOffset, 36 + 14 + 8);
        assert.equal(parsed.info.durationMs, 1000);
    });
});

describe('parseWav: what is not a WAV', () => {
    it('is not_wav for anything without RIFF at the start and WAVE at 8: an MP4, text, an empty buffer', () => {
        const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(64)]);
        for (const bytes of [mp4, Buffer.from('hello world, this is not audio'), Buffer.alloc(0), Buffer.alloc(11)]) {
            assert.deepEqual(parseWav(bytes), { ok: false, problem: 'not_wav' });
        }
        const avi = wavBytes();
        avi.write('AVI ', 8, 'ascii');
        assert.deepEqual(parseWav(avi), { ok: false, problem: 'not_wav' });
    });

    it('is no_fmt when data comes before the format, or there is none, and no_data when there are no samples chunk at all', () => {
        const wav = wavBytes();
        const dataFirst = Buffer.concat([wav.subarray(0, 12), wav.subarray(36), wav.subarray(12, 36)]);
        assert.deepEqual(parseWav(dataFirst), { ok: false, problem: 'no_fmt' });
        assert.deepEqual(parseWav(wav.subarray(0, 12)), { ok: false, problem: 'no_fmt' });
        assert.deepEqual(parseWav(wav.subarray(0, 36)), { ok: false, problem: 'no_data' });
    });

    it('is bad_fmt for a format chunk that is too short or cut off, and for a zero byte rate', () => {
        const wav = wavBytes();
        const shortFmt = Buffer.from(wav);
        shortFmt.writeUInt32LE(8, 16);
        assert.deepEqual(parseWav(shortFmt), { ok: false, problem: 'bad_fmt' });
        assert.deepEqual(parseWav(wav.subarray(0, 30)), { ok: false, problem: 'bad_fmt' });
        const zeroRate = wavBytes({ rate: 0 });
        assert.deepEqual(parseWav(zeroRate), { ok: false, problem: 'bad_fmt' });
    });

    it('never throws, whatever the bytes', () => {
        const wav = wavBytes({ info: true });
        for (let cut = 0; cut <= 100; cut++) assert.doesNotThrow(() => parseWav(wav.subarray(0, cut)));
        for (let i = 0; i < wav.length && i < 90; i++) {
            const bent = Buffer.from(wav);
            bent[i] = 0xff;
            assert.doesNotThrow(() => parseWav(bent));
        }
    });
});

describe('isAsrWav: the one format the endpoint takes', () => {
    it('is integer PCM, one channel, 16 bits, at 16 kHz or 24 kHz', () => {
        assert.deepEqual([...ASR_SAMPLE_RATES], [16_000, 24_000]);
        assert.equal(isAsrWav(info({ rate: 24_000 })), true);
        assert.equal(isAsrWav(info({ rate: 16_000 })), true);
        assert.equal(isAsrWav(info({ info: true })), true);
    });

    it('is not any other rate, stereo, 8 or 24 bits, or float and other non-PCM formats', () => {
        assert.equal(isAsrWav(info({ rate: 44_100 })), false);
        assert.equal(isAsrWav(info({ rate: 48_000 })), false);
        assert.equal(isAsrWav(info({ rate: 8_000 })), false);
        assert.equal(isAsrWav(info({ channels: 2 })), false);
        assert.equal(isAsrWav(info({ bits: 8 })), false);
        assert.equal(isAsrWav(info({ bits: 24 })), false);
        assert.equal(isAsrWav(info({ format: 3 })), false);
        assert.equal(isAsrWav(info({ format: 0xfffe })), false);
    });
});
