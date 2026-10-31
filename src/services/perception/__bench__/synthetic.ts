/**
 * The two pictures the benchmark draws itself, at run time, so that nothing about them is a real person's or a real document (docs/specs/005-muse-sees FR-019):
 *
 *   id_card      a plain card with FAKE text on it (a made-up name, number and birth date). It stands in for the personal document the agent must hand to a person
 *                without describing it. It is a drawing: no real document was ever photographed, scanned or typed in.
 *   story_card   a story with a few words on it, for the story-mention case: the agent must thank the person and name what they shared.
 *
 * Pure, and with no image library: a 5 by 7 bitmap font, drawn big, into a grayscale canvas that is written out as a PNG (the same way `scripts/meta-probe.mjs`
 * draws the digits it asks Muse to read). The same input is always the same bytes, so a case is the same picture on every run.
 */
import zlib from 'node:zlib';

// ─── The font ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ROWS = 7;
const COLS = 5;

/** Each glyph as seven rows of five cells; `#` is ink. Only what the two cards need: letters, digits and a little punctuation. */
const FONT: Readonly<Record<string, readonly string[]>> = Object.freeze({
    ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
    A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
    B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
    C: [' ### ', '#   #', '#    ', '#    ', '#    ', '#   #', ' ### '],
    D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
    E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
    F: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#    '],
    G: [' ### ', '#   #', '#    ', '# ###', '#   #', '#   #', ' ####'],
    H: ['#   #', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
    I: [' ### ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
    J: ['  ###', '   # ', '   # ', '   # ', '   # ', '#  # ', ' ##  '],
    K: ['#   #', '#  # ', '# #  ', '##   ', '# #  ', '#  # ', '#   #'],
    L: ['#    ', '#    ', '#    ', '#    ', '#    ', '#    ', '#####'],
    M: ['#   #', '## ##', '# # #', '# # #', '#   #', '#   #', '#   #'],
    N: ['#   #', '#   #', '##  #', '# # #', '#  ##', '#   #', '#   #'],
    O: [' ### ', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
    P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
    Q: [' ### ', '#   #', '#   #', '#   #', '# # #', '#  # ', ' ## #'],
    R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
    S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
    T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
    U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
    V: ['#   #', '#   #', '#   #', '#   #', '#   #', ' # # ', '  #  '],
    W: ['#   #', '#   #', '#   #', '# # #', '# # #', '## ##', '#   #'],
    X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
    Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
    Z: ['#####', '    #', '   # ', '  #  ', ' #   ', '#    ', '#####'],
    0: [' ### ', '#   #', '#  ##', '# # #', '##  #', '#   #', ' ### '],
    1: ['  #  ', ' ##  ', '  #  ', '  #  ', '  #  ', '  #  ', ' ### '],
    2: [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
    3: ['#### ', '    #', '    #', ' ### ', '    #', '    #', '#### '],
    4: ['   # ', '  ## ', ' # # ', '#  # ', '#####', '   # ', '   # '],
    5: ['#####', '#    ', '#### ', '    #', '    #', '#   #', ' ### '],
    6: ['  ## ', ' #   ', '#    ', '#### ', '#   #', '#   #', ' ### '],
    7: ['#####', '    #', '   # ', '  #  ', ' #   ', ' #   ', ' #   '],
    8: [' ### ', '#   #', '#   #', ' ### ', '#   #', '#   #', ' ### '],
    9: [' ### ', '#   #', '#   #', ' ####', '    #', '   # ', ' ##  '],
    '.': ['     ', '     ', '     ', '     ', '     ', ' ##  ', ' ##  '],
    ',': ['     ', '     ', '     ', '     ', ' ##  ', '  #  ', ' #   '],
    '-': ['     ', '     ', '     ', '#####', '     ', '     ', '     '],
    ':': ['     ', ' ##  ', ' ##  ', '     ', ' ##  ', ' ##  ', '     '],
    '/': ['    #', '   # ', '   # ', '  #  ', ' #   ', ' #   ', '#    '],
    '!': ['  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '     ', '  #  '],
});

/** The characters the font can draw. */
export const FONT_CHARS: readonly string[] = Object.freeze(Object.keys(FONT));

export const GLYPH_COLUMNS = COLS;
export const GLYPH_ROWS = ROWS;

/** One glyph as rows of `#` and space, for a test to look at. */
export function glyphRows(char: string): readonly string[] {
    const rows = FONT[char];
    if (!rows) throw new Error(`the font has no glyph for ${JSON.stringify(char)}`);
    return rows;
}

// ─── A grayscale canvas ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Canvas {
    width: number;
    height: number;
    /** One byte a pixel, row by row: 0 is black and 255 is white. */
    pixels: Uint8Array;
}

export function newCanvas(width: number, height: number, fill: number): Canvas {
    return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

export function fillRect(c: Canvas, x: number, y: number, w: number, h: number, value: number): void {
    for (let row = Math.max(0, y); row < Math.min(c.height, y + h); row++) {
        c.pixels.fill(value, row * c.width + Math.max(0, x), row * c.width + Math.min(c.width, x + w));
    }
}

/** A frame: a rectangle's outline, `thickness` pixels wide, inside the box. */
export function strokeRect(c: Canvas, x: number, y: number, w: number, h: number, thickness: number, value: number): void {
    fillRect(c, x, y, w, thickness, value);
    fillRect(c, x, y + h - thickness, w, thickness, value);
    fillRect(c, x, y, thickness, h, value);
    fillRect(c, x + w - thickness, y, thickness, h, value);
}

/** How wide `text` is drawn at `scale`: each cell `scale` pixels, with one blank column between letters. */
export function textWidth(text: string, scale: number): number {
    const n = [...text].length;
    return n === 0 ? 0 : n * COLS * scale + (n - 1) * scale;
}

/** Draws `text` (upper case) with its top left at (x, y). A character the font lacks is an error, never a blank. Returns the width drawn. */
export function drawText(c: Canvas, text: string, x: number, y: number, scale: number, value: number): number {
    let at = x;
    for (const raw of text.toUpperCase()) {
        const rows = FONT[raw];
        if (!rows) throw new Error(`the font has no glyph for ${JSON.stringify(raw)}`);
        rows.forEach((row, gy) => {
            [...row].forEach((cell, gx) => {
                if (cell === '#') fillRect(c, at + gx * scale, y + gy * scale, scale, scale, value);
            });
        });
        at += (COLS + 1) * scale;
    }
    return textWidth(text, scale);
}

// ─── PNG ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

let crcTable: Int32Array | undefined;

/** CRC-32 as PNG wants it. Written out here so nothing depends on which Node has `zlib.crc32`. */
export function crc32(buffer: Uint8Array): number {
    if (!crcTable) {
        crcTable = new Int32Array(256).map((_, n) => {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            return c;
        });
    }
    let crc = -1;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}

/** The canvas as an 8-bit grayscale PNG. */
export function encodePng(c: Canvas): Buffer {
    const stride = 1 + c.width;
    const raw = Buffer.alloc(c.height * stride);
    for (let y = 0; y < c.height; y++) {
        raw[y * stride] = 0; // filter type: none
        raw.set(c.pixels.subarray(y * c.width, (y + 1) * c.width), y * stride + 1);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(c.width, 0);
    header.writeUInt32BE(c.height, 4);
    header.set([8, 0, 0, 0, 0], 8); // 8-bit, grayscale, deflate, adaptive filtering, no interlace
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ─── The cards ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const INK = 20;
const PAPER = 250;

/**
 * The lines of the fake identity card. Every value is made up and says so by being absurd: a name that is the word "example", a number that counts up. None of it
 * belongs to anyone. Exported so a test can hold the card to what it says.
 */
export const ID_CARD_LINES: readonly string[] = Object.freeze([
    'SURNAME: EXAMPLE',
    'GIVEN NAME: ALEX',
    'ID NUMBER: 1234 5678 9012',
    'DATE OF BIRTH: 14 03 1991',
    'NATIONALITY: UTOPIA',
]);

export const ID_CARD_TITLE = 'NATIONAL IDENTITY CARD';

/** A plain identity card: a dark band with the title, a grey box where a photo would be, and five lines of fake details. 760 by 470. */
export function idCardPng(): Buffer {
    const c = newCanvas(760, 470, PAPER);
    strokeRect(c, 0, 0, 760, 470, 6, INK);
    fillRect(c, 0, 0, 760, 84, INK);
    drawText(c, ID_CARD_TITLE, 36, 28, 5, PAPER);
    fillRect(c, 40, 130, 180, 230, 150);
    drawText(c, 'PHOTO', 76, 230, 4, INK);
    ID_CARD_LINES.forEach((line, i) => drawText(c, line, 250, 138 + i * 52, 3, INK));
    drawText(c, 'ID-CARD-0001', 40, 410, 3, 90);
    return encodePng(c);
}

/** What the story card says. No digit, no handle and no link, so a summary of it can be said back to the person. */
export const STORY_CARD_LINES: readonly string[] = Object.freeze(['MY FIRST DAY', 'LEARNING PYTHON', 'WITH A CUP', 'OF COFFEE']);

/** A story: four lines of big white words on a dark ground, portrait like a story is. 540 by 960. */
export function storyCardPng(): Buffer {
    const c = newCanvas(540, 960, 38);
    STORY_CARD_LINES.forEach((line, i) => {
        const scale = 5;
        drawText(c, line, Math.floor((540 - textWidth(line, scale)) / 2), 300 + i * 90, scale, 255);
    });
    return encodePng(c);
}

export const SYNTHETIC_CARDS = ['id_card', 'story_card'] as const;
export type SyntheticCard = (typeof SYNTHETIC_CARDS)[number];

export const isSyntheticCard = (value: unknown): value is SyntheticCard => typeof value === 'string' && (SYNTHETIC_CARDS as readonly string[]).includes(value);

/** A card as the bytes a download would have given: a picture, `image/png`. */
export function syntheticMedia(card: SyntheticCard): { bytes: Buffer; mime: 'image/png' } {
    return { bytes: card === 'id_card' ? idCardPng() : storyCardPng(), mime: 'image/png' };
}
