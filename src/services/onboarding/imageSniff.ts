/**
 * What an image really is, from its first bytes. `safeFetch` fetches images only to look at them
 * (a logo candidate, never `og:image`), and a server's `Content-Type` is a claim: an HTML page or an
 * executable served as `image/png` must not be taken for one. Pure.
 */

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp' | 'ico' | 'svg';

/** The `Content-Type` values an image may be declared as, and what each claims to be. */
export const IMAGE_CONTENT_TYPES: Readonly<Record<string, ImageType>> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpeg',
    'image/pjpeg': 'jpeg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/ico': 'ico',
    'image/svg+xml': 'svg',
};

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0): boolean => magic.every((b, i) => bytes[at + i] === b);
const ascii = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

/**
 * SVG is text: no NUL byte anywhere in the sniffed prefix, and an `<svg` element after at most a BOM,
 * an XML declaration, a doctype and comments. It is only ever parsed as text (for its colours), never
 * rendered or fetched further, but a binary blob or an HTML page is still not an SVG.
 */
function looksLikeSvg(bytes: Uint8Array): boolean {
    const head = bytes.subarray(0, 4096);
    if (head.includes(0)) return false;
    const text = new TextDecoder('utf-8').decode(head).replace(/^\uFEFF/, '');
    // An element before `<svg` that is not part of the prolog means this is some other document.
    const stripped = text.replace(/^(?:\s|<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '');
    return /^<svg[\s>/]/i.test(stripped);
}

/** The type the bytes say they are, or null when they are none of the allowed kinds. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
    if (bytes.byteLength < 4) return null;
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
    if (bytes.byteLength >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'gif';
    if (bytes.byteLength >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'webp';
    if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'ico';
    if (looksLikeSvg(bytes)) return 'svg';
    return null;
}

/** A PNG's pixel size, from its IHDR chunk, or null. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
    if (sniffImage(bytes) !== 'png' || bytes.byteLength < 24 || ascii(bytes, 12, 16) !== 'IHDR') return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
}
