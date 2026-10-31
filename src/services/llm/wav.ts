/**
 * The header of a WAV file, read: enough to say whether Meta's speech endpoint will take it and how long it plays (docs/specs/005-muse-sees T047 and T048).
 * Pure: bytes in, facts out. Nothing here reads a database, a clock or the network.
 *
 * `POST /asr/transcribe` takes ONE format, a RIFF/WAVE file holding mono, 16-bit integer PCM at 16 kHz or 24 kHz, and answers anything else with a 400
 * (dev.meta.ai/docs/speech-to-text and api-reference/voice/transcribe, read 2026-10-31). The decoder (`perception/transcode.ts`) makes exactly that, and
 * this is how both ends check it without a probe tool.
 *
 * **The samples do not start at byte 44.** ffmpeg writes a `LIST` chunk with its own `ISFT` tag ("Lavf60.3.100") between `fmt ` and `data`, and
 * `-map_metadata -1` does not take it out (it is the muxer's tag, not the input's): the 1-second tone of the 2026-10-30 probe came out as 49,118 bytes
 * with 78 of them header. So the chunks are walked, each one found by its own id and size, and the duration is the `data` chunk's bytes over the byte rate.
 *
 * A `data` size larger than what the file holds (a stream that was never finalised writes 0xFFFFFFFF) is read as "the rest of the file", never trusted:
 * the duration is what is really there.
 */

/** The sample rates the endpoint takes. */
export const ASR_SAMPLE_RATES: readonly number[] = Object.freeze([16_000, 24_000]);

export interface WavInfo {
    /** 1 is integer PCM. */
    format: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    /** Where the samples start, and how many bytes of them the file holds (the header's claim, cut to what is there). */
    dataOffset: number;
    dataBytes: number;
    /** How long it plays, in whole milliseconds (rounded). */
    durationMs: number;
}

/** Why a file is not a WAV this reader can measure. */
export type WavProblem = 'not_wav' | 'bad_fmt' | 'no_fmt' | 'no_data';

export type WavParse = { ok: true; info: WavInfo } | { ok: false; problem: WavProblem };

const ascii = (bytes: Uint8Array, at: number, length: number): string => String.fromCharCode(...bytes.subarray(at, at + length));
const u16 = (bytes: Uint8Array, at: number): number => bytes[at]! | (bytes[at + 1]! << 8);
const u32 = (bytes: Uint8Array, at: number): number => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;

/** Read a WAV's format and the length of its samples. Never throws: a file that is not one is a `problem`. */
export function parseWav(bytes: Uint8Array): WavParse {
    if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return { ok: false, problem: 'not_wav' };

    let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
    let pos = 12;
    while (pos + 8 <= bytes.length) {
        const id = ascii(bytes, pos, 4);
        const size = u32(bytes, pos + 4);
        const body = pos + 8;
        if (id === 'fmt ') {
            if (size < 16 || body + 16 > bytes.length) return { ok: false, problem: 'bad_fmt' };
            fmt = { format: u16(bytes, body), channels: u16(bytes, body + 2), sampleRate: u32(bytes, body + 4), bitsPerSample: u16(bytes, body + 14) };
        } else if (id === 'data') {
            if (!fmt) return { ok: false, problem: 'no_fmt' };
            const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
            if (!(bytesPerSecond > 0)) return { ok: false, problem: 'bad_fmt' };
            const dataBytes = Math.min(size, bytes.length - body);
            return { ok: true, info: { ...fmt, dataOffset: body, dataBytes, durationMs: Math.round((dataBytes / bytesPerSecond) * 1000) } };
        }
        // A chunk is padded to an even length.
        pos = body + size + (size & 1);
    }
    return { ok: false, problem: fmt ? 'no_data' : 'no_fmt' };
}

/** Is it what the speech endpoint takes: integer PCM, one channel, 16 bits, 16 or 24 kHz? */
export const isAsrWav = (info: WavInfo): boolean =>
    info.format === 1 && info.channels === 1 && info.bitsPerSample === 16 && ASR_SAMPLE_RATES.includes(info.sampleRate);
