/**
 * Tests only: WAV files built by hand, and a reader for the multipart body Meta's speech endpoint is sent. Not a test file itself, so `npm test` does not run it.
 * Shared by the tests of `wav.ts`, `metaAsr.ts`, `aiProviders/asr.ts` and the voice pipeline (`perception/transcode.ts`, `voice.ts`).
 */

export interface WavSpec {
    /** Default 1. */
    seconds?: number;
    /** Default 24 000. */
    rate?: number;
    /** Default 1. */
    channels?: number;
    /** Default 16. */
    bits?: number;
    /** 1 is integer PCM. Default 1. */
    format?: number;
    /** The `LIST`/`INFO`/`ISFT` chunk ffmpeg puts between `fmt ` and `data` ("Lavf60.3.100"): 34 bytes, so the samples start at 78 and not at 44. */
    info?: boolean;
    /** What the `data` header claims instead of the real size (0xFFFFFFFF is a stream that was never finalised). */
    dataSize?: number;
    /** A sine tone instead of silence. */
    tone?: boolean;
}

/** A RIFF/WAVE file: `fmt `, optionally ffmpeg's `LIST`, then `data`. */
export function wavBytes(spec: WavSpec = {}): Buffer {
    const rate = spec.rate ?? 24_000;
    const channels = spec.channels ?? 1;
    const bits = spec.bits ?? 16;
    const seconds = spec.seconds ?? 1;
    const bytesPerFrame = channels * (bits / 8);
    const frames = Math.round(seconds * rate);
    const samples = Buffer.alloc(frames * bytesPerFrame);
    if (spec.tone && bits === 16) for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 9000), (i * channels + c) * 2);

    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'ascii');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(spec.format ?? 1, 8);
    fmt.writeUInt16LE(channels, 10);
    fmt.writeUInt32LE(rate, 12);
    fmt.writeUInt32LE(rate * bytesPerFrame, 16);
    fmt.writeUInt16LE(bytesPerFrame, 20);
    fmt.writeUInt16LE(bits, 22);

    const chunks = [fmt];
    if (spec.info) {
        const list = Buffer.alloc(34);
        list.write('LIST', 0, 'ascii');
        list.writeUInt32LE(26, 4);
        list.write('INFO', 8, 'ascii');
        list.write('ISFT', 12, 'ascii');
        list.writeUInt32LE(13, 16);
        list.write('Lavf60.3.100\0', 20, 'ascii'); // 13 bytes, then one byte of padding to an even length
        chunks.push(list);
    }
    const dataHeader = Buffer.alloc(8);
    dataHeader.write('data', 0, 'ascii');
    dataHeader.writeUInt32LE(spec.dataSize ?? samples.length, 4);
    chunks.push(dataHeader, samples);

    const body = Buffer.concat(chunks);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'ascii');
    riff.writeUInt32LE(4 + body.length, 4);
    riff.write('WAVE', 8, 'ascii');
    return Buffer.concat([riff, body]);
}

export interface ParsedPart {
    name: string;
    filename: string | undefined;
    /** The part's own `Content-Type`, when it has one. */
    type: string | undefined;
    /** Every header line of the part, as written. */
    headers: string[];
    data: Buffer;
}

/** The parts of a `multipart/form-data` body, binary-safe: what a server would see. */
export function parseMultipart(body: Uint8Array, contentType: string): ParsedPart[] {
    const boundary = /boundary=([^;\s]+)/.exec(contentType)?.[1];
    if (!boundary) throw new Error(`no boundary in "${contentType}"`);
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const delimiter = Buffer.from(`--${boundary}`);
    const between = Buffer.from(`\r\n--${boundary}`);
    const parts: ParsedPart[] = [];
    let at = buf.indexOf(delimiter);
    while (at !== -1) {
        let start = at + delimiter.length;
        if (buf.subarray(start, start + 2).toString('ascii') === '--') break;
        start += 2; // the line break after the boundary
        const next = buf.indexOf(between, start);
        if (next === -1) throw new Error('a part is not closed by a boundary');
        const part = buf.subarray(start, next);
        const split = part.indexOf('\r\n\r\n');
        if (split === -1) throw new Error('a part has no blank line after its headers');
        const headers = part.subarray(0, split).toString('utf8').split('\r\n');
        const disposition = headers.find((h) => /^content-disposition:/i.test(h)) ?? '';
        parts.push({
            name: /\bname="([^"]*)"/.exec(disposition)?.[1] ?? '',
            filename: /\bfilename="([^"]*)"/.exec(disposition)?.[1],
            type: headers.find((h) => /^content-type:/i.test(h))?.replace(/^content-type:\s*/i, ''),
            headers,
            data: part.subarray(split + 4),
        });
        at = next + 2;
    }
    return parts;
}
