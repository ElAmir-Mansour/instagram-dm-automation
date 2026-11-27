/**
 * What a PNG's own header says about transparency (Brand Kit, docs: contract §2.2 step 4). Pure: it reads the signature, the IHDR and
 * the chunk list up to the first IDAT, and decodes nothing (the server has no image library, and must not get one: I7).
 *
 * The browser measures whether a logo has transparent pixels (`alpha`), and the server does not take its word where the file can
 * prove it wrong: a PNG of colour type 0 (grey) or 2 (RGB) holds no alpha channel, unless a `tRNS` chunk names a transparent colour.
 */

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** The signature (8) + IHDR: length (4), name (4), 13 data bytes, CRC (4). The chunk list starts here. */
const IHDR_END = 33;
const COLOUR_TYPE_AT = 25;

const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const name = (b: Uint8Array, at: number): string => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * Can this PNG hold transparent pixels? True when its colour type is 4 (grey + alpha) or 6 (RGBA), or when a `tRNS` chunk comes before
 * the first `IDAT` (a palette or colour-key transparency). False for anything else, including bytes that are not a PNG or are cut short.
 */
export function pngCanHoldAlpha(bytes: Uint8Array): boolean {
    if (bytes.length < COLOUR_TYPE_AT + 1 || !SIGNATURE.every((byte, i) => bytes[i] === byte)) return false;
    if (name(bytes, 12) !== 'IHDR') return false;
    const colourType = bytes[COLOUR_TYPE_AT];
    if (colourType === 4 || colourType === 6) return true;
    // Chunks: length (4), name (4), data, CRC (4). Stepped by length, so no byte of one is read as another's name.
    let at = IHDR_END;
    while (at + 8 <= bytes.length) {
        const length = u32(bytes, at);
        const kind = name(bytes, at + 4);
        if (kind === 'IDAT' || kind === 'IEND') return false;
        if (kind === 'tRNS') return true;
        at += 12 + length;
    }
    return false;
}
