/**
 * The kind and the size of a PNG or a JPEG, read from the first bytes of the file (illustrated explainers, `pictures/`).
 *
 * Why this exists: FLUX.2 klein takes each reference picture only when it is smaller than 512×512 (research.md R5), and this app has no image
 * library and must not get one (a native dependency in a serverless bundle, for a few header bytes). The guard "refuse a reference that is too
 * big, with a clear message" therefore reads the width and the height itself. It is also what tells the provider's answer, which is base64 with
 * no declared type, from a PNG or a JPEG, so the file is stored with the type it really is (`/api/uploads/:id` serves that type as it is).
 *
 * Nothing here decodes a picture. A file that is not a PNG or a JPEG, or whose header is cut short or does not make sense, gives `null`: the
 * caller refuses it, rather than guessing a size for it. It never throws, whatever the bytes.
 */

export type PictureMime = 'image/png' | 'image/jpeg';

export interface PictureInfo {
    mime: PictureMime;
    width: number;
    height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** What these bytes claim to be, by their first bytes: a PNG signature, or a JPEG start-of-image followed by a marker. */
export function sniffPictureMime(bytes: Uint8Array): PictureMime | null {
    if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    return null;
}

/** The kind and the size of a PNG or JPEG, or null when the bytes are neither or their header cannot be read. */
export function readPictureInfo(bytes: Uint8Array): PictureInfo | null {
    const mime = sniffPictureMime(bytes);
    const size = mime === 'image/png' ? pngSize(bytes) : mime === 'image/jpeg' ? jpegSize(bytes) : null;
    return mime && size ? { mime, ...size } : null;
}

const u16 = (b: Uint8Array, at: number): number => (b[at]! << 8) | b[at + 1]!;
/** `>>> 0`: a 32-bit side with its top bit set is a large number, not a negative one. */
const u32 = (b: Uint8Array, at: number): number => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;

type Size = { width: number; height: number };

/** The signature, then the IHDR chunk: 4 bytes of length, "IHDR", the width and the height as 32-bit numbers. */
function pngSize(b: Uint8Array): Size | null {
    if (b.length < 24) return null;
    if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
    const width = u32(b, 16);
    const height = u32(b, 20);
    return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * A JPEG is a list of segments, each a 0xFF, a marker byte and, for most, a length that counts its own two bytes. The size is in the first
 * start-of-frame segment (SOF0 to SOF15, except the three markers in that range that are tables, not frames). A segment is stepped over by its
 * length, so the markers inside an EXIF thumbnail are never read as the picture's own frame.
 */
function jpegSize(b: Uint8Array): Size | null {
    let i = 2; // after the start-of-image
    while (i < b.length) {
        if (b[i] !== 0xff) return null; // lost the markers: this is not a header any more
        while (i < b.length && b[i] === 0xff) i++; // a writer may pad with extra 0xFF before a marker
        const marker = b[i++];
        if (marker === undefined) return null;
        // Markers with no length: a second start-of-image, TEM and the restart markers.
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        // The end of the image, or the start of the scan, before any frame: there is nothing to read.
        if (marker === 0xd9 || marker === 0xda) return null;
        if (i + 1 >= b.length) return null;
        const length = u16(b, i);
        if (length < 2) return null;
        const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isFrame) {
            // length (2), precision (1), height (2), width (2)
            if (i + 6 >= b.length) return null;
            const height = u16(b, i + 3);
            const width = u16(b, i + 5);
            return width > 0 && height > 0 ? { width, height } : null;
        }
        i += length;
    }
    return null;
}
