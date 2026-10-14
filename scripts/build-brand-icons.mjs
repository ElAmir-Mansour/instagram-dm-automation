#!/usr/bin/env node
/**
 * Builds and checks the icon files of the Kufi «رد» mark (identity item B5): the favicon set, the apple-touch icon and the manifest's icons.
 *
 *   public/favicon.svg                       the micro cut (16 grid), byte for byte; no light/dark swap, Cardamom at every size
 *   public/favicon.ico                       PNG-in-ICO: 16 from the micro, 32 from the master, 48 from the small cut at 2x
 *   public/apple-touch-icon.png              180x180 from the full-bleed file, no alpha
 *   public/brand/mark.<sha8>.svg             the master (Cardamom tile), named for its own bytes: `/brand` is served `immutable`
 *   public/brand/icon-192.<sha8>.png         192 and 512 "any" from the master
 *   public/brand/icon-512.<sha8>.png
 *   public/brand/icon-maskable-512.<sha8>.png  512 maskable from the full-bleed file, no alpha
 *   public/site.webmanifest                  theme_color and background_color `#111210`, and `icons` naming the four files above
 *   scripts/brand-icons/manifest.json        what the build recorded: each source's hash and each output's hash, size and pixel hash
 *   scripts/brand-icons/mark-*.svg           the kit's finals (docs/brand/mark/final/ is gitignored and absent from CI), pinned by hash
 *
 * Why a rasteriser lives in this file. The kit rendered with headless Chrome, which a CI runner would rasterise differently from this
 * Mac, so a check could only compare hashes of whatever was last committed and prove nothing about the pixels. Every shape in the mark
 * is a polygon (a rounded-rectangle tile and a glyph of straight edges at 0, 90 and 45 degrees), so the exact area each polygon covers
 * in each pixel is a short integer-free computation, and the same input gives the same pixels on every machine. `--check` therefore
 * re-renders the committed sources and compares PIXELS with the committed PNGs: deflate's output may differ between Node versions,
 * the decoded image may not. It is exact where Chrome's Skia is approximate: the test file proves the coverage adds up to each
 * polygon's area and that every edge pixel of the cuts the kit calls pixel-exact is a clean 50% cut, and, where a local Chrome
 * exists, that the two differ only by Skia's antialiasing (up to ~60 levels on a shallow corner arc; Skia rounds those). No tool
 * outside node is needed, and nothing is downloaded.
 *
 *   node scripts/build-brand-icons.mjs            render everything, write it, update the manifest and public/site.webmanifest
 *   node scripts/build-brand-icons.mjs --check    change nothing. Exit 1 unless
 *                                                   - the sources are the pinned kit finals (hash, two subpaths, no dot, no stroke),
 *                                                   - every output exists, is named for its own bytes and holds exactly the pixels
 *                                                     the sources render to, at the size, colour type and byte budget it must have,
 *                                                   - the manifest names this release's icons and the dark page colour,
 *                                                   - the eight pages name the favicon set (and nothing else as an icon),
 *                                                   - tokens.css paints the mark in the colourways the sources are,
 *                                                   - src/index.ts serves the root files the pages ask for by name.
 *   node scripts/build-brand-icons.mjs --reproduce  --check, then render again and compare BYTES with the committed files.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { makeIo } from './build-font.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = 'scripts/brand-icons';
export const MANIFEST = `${SRC_DIR}/manifest.json`;
export const BRAND_DIR = 'public/brand';
export const WEBMANIFEST = 'public/site.webmanifest';
export const TOKENS_CSS = 'dashboard/css/tokens.css';
export const INDEX_TS = 'src/index.ts';

/** The pages whose <head> names the icons: the dashboard shell, the Eid page and the six public pages. */
export const PAGES = ['dashboard/index.html', 'dashboard/eid.html', ...['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'].map((p) => `public/${p}.html`)];
/** The exact tags every page carries, once each. The .ico says 32x32 so that Chrome, which would otherwise pick it over the SVG, takes the SVG. */
export const HEAD_TAGS = [
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
];

/** IDENTITY.md section 2's two colourways: Cardamom for every icon and the dark UI, Ink for the light UI. */
export const CARDAMOM = { tile: '#BCDE70', glyph: '#141610' };
export const INK = { tile: '#1A1C15', glyph: '#BCDE70' };
/** The dark page, which is what the manifest's theme_color and background_color are (IDENTITY.md section 8). */
export const PAGE_COLOUR = '#111210';
/** The master's glyph, the one drawing the inline marks in the dashboard and the public pages repeat. */
export const GLYPH_MASTER = 'M72 56H136V152H40V120H104V88H72ZM168 56H200V178.51L158.51 220H113.25L168 165.25Z';
/** IDENTITY.md section 8: the .ico takes at most 15 KB. */
export const ICO_MAX_BYTES = 15 * 1000;
/** Every content-hashed file this script puts under public/brand: `<stem>.<sha8>.<ext>`. scripts/build-hero3d.mjs's check lets exactly these names live there. */
export const ICON_FILE = /^(?:mark|icon-192|icon-512|icon-maskable-512)\.([0-9a-f]{8})\.(?:svg|png)$/;
/** This release's files and the one before it, as for the share cards: a manifest cached for a day may still name the last. */
export const MAX_RELEASES = 2;

export const SOURCES = ['mark-cardamom.svg', 'mark-ink.svg', 'mark-micro-16.svg', 'mark-small-24.svg', 'mark-fullbleed-maskable.svg'];

/**
 * What the build writes. `path` is a stable name a browser asks for; `stem` + `ext` is a content-hashed copy under public/brand.
 * `from` is the source, `size` the pixel size it renders at (the small cut's 24 grid at 48 is the "2x").
 */
export const OUTPUTS = {
    favicon_svg: { kind: 'copy', path: 'public/favicon.svg', from: 'mark-micro-16.svg' },
    mark_svg: { kind: 'copy', stem: 'mark', ext: 'svg', from: 'mark-cardamom.svg' },
    favicon_ico: {
        kind: 'ico',
        path: 'public/favicon.ico',
        layers: [
            { size: 16, from: 'mark-micro-16.svg' },
            { size: 32, from: 'mark-cardamom.svg' },
            { size: 48, from: 'mark-small-24.svg' },
        ],
    },
    apple_touch: { kind: 'png', path: 'public/apple-touch-icon.png', from: 'mark-fullbleed-maskable.svg', size: 180, alpha: false },
    icon_192: { kind: 'png', stem: 'icon-192', ext: 'png', from: 'mark-cardamom.svg', size: 192, alpha: true },
    icon_512: { kind: 'png', stem: 'icon-512', ext: 'png', from: 'mark-cardamom.svg', size: 512, alpha: true },
    icon_maskable_512: { kind: 'png', stem: 'icon-maskable-512', ext: 'png', from: 'mark-fullbleed-maskable.svg', size: 512, alpha: false },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const kb = (n) => (n / 1000).toFixed(1);
const hex = (c) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16));

// ─── reading a source ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The kit's finals are one `<rect>` tile and one `<path>` of absolute M, H, V, L and Z, nothing else (the kit audited that by script;
 * so does this). Anything else throws: a renderer that quietly drew half a mark would be worse than none.
 */
export function parseMark(svg) {
    const vb = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
    if (!vb || vb[1] !== vb[2]) throw new Error('the mark has no square viewBox starting at 0 0');
    const rect = /<rect\b([^>]*)\/>/.exec(svg);
    const path = /<path\b([^>]*)\/>/.exec(svg);
    if (!rect || !path) throw new Error('the mark must be one <rect> and one <path>');
    const attr = (src, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(src)?.[1];
    const d = attr(path[1], 'd');
    if (!d || /[^MHVLZ0-9.\-\s,]/.test(d)) throw new Error(`the glyph path uses a command other than M H V L Z: ${d}`);
    const size = Number(vb[1]);
    return {
        size,
        tile: { width: Number(attr(rect[1], 'width')), height: Number(attr(rect[1], 'height')), rx: Number(attr(rect[1], 'rx') ?? 0), fill: attr(rect[1], 'fill') },
        glyph: { d, fill: attr(path[1], 'fill') },
    };
}

/** A path's subpaths as lists of points, each closed. */
export function subpaths(d) {
    const out = [];
    let cur = null;
    let x = 0;
    let y = 0;
    for (const m of d.matchAll(/([MHVLZ])([^MHVLZ]*)/g)) {
        const n = (m[2].match(/-?\d*\.?\d+/g) ?? []).map(Number);
        switch (m[1]) {
            case 'M':
                cur = [[(x = n[0]), (y = n[1])]];
                out.push(cur);
                break;
            case 'H':
                cur.push([(x = n[0]), y]);
                break;
            case 'V':
                cur.push([x, (y = n[0])]);
                break;
            case 'L':
                cur.push([(x = n[0]), (y = n[1])]);
                break;
            case 'Z':
                break;
        }
    }
    return out;
}

// ─── the rasteriser: exact area coverage of polygons ─────────────────────────────────────────────────────────────────

/** One edge's signed area into an accumulation buffer (the signed-area scan of font-rs): a row's running sum is the pixel's coverage. */
function addEdge(a, stride, h, x0, y0, x1, y1) {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) {
        [x0, y0, x1, y1] = [x1, y1, x0, y0];
        dir = -1;
    }
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    if (y0 < 0) x -= y0 * dxdy;
    const yEnd = Math.min(h, Math.ceil(y1));
    for (let y = Math.max(0, Math.floor(y0)); y < yEnd; y++) {
        const dy = Math.min(y + 1, y1) - Math.max(y, y0);
        const xNext = x + dxdy * dy;
        const d = dy * dir;
        const [xa, xb] = x < xNext ? [x, xNext] : [xNext, x];
        const xaf = Math.floor(xa);
        const xbc = Math.ceil(xb);
        const row = y * stride;
        if (xbc <= xaf + 1) {
            const xmf = 0.5 * (x + xNext) - xaf;
            a[row + xaf] += d - d * xmf;
            a[row + xaf + 1] += d * xmf;
        } else {
            const s = 1 / (xb - xa);
            const x0f = xa - xaf;
            const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
            const x1f = xb - xbc + 1;
            const am = 0.5 * s * x1f * x1f;
            a[row + xaf] += d * a0;
            if (xbc === xaf + 2) {
                a[row + xaf + 1] += d * (1 - a0 - am);
            } else {
                const a1 = s * (1.5 - x0f);
                a[row + xaf + 1] += d * (a1 - a0);
                for (let xi = xaf + 2; xi < xbc - 1; xi++) a[row + xi] += d * s;
                const a2 = a1 + (xbc - xaf - 3) * s;
                a[row + xbc - 1] += d * (1 - a2 - am);
            }
            a[row + xbc] += d * am;
        }
        x = xNext;
    }
}

/** Coverage in [0, 1] of the union of non-overlapping polygons (pixel coordinates), one value per pixel of a width x height canvas. */
export function coverage(polygons, width, height) {
    const out = new Float64Array(width * height);
    const stride = width + 2;
    for (const poly of polygons) {
        const acc = new Float64Array(stride * height);
        const clamp = (v) => Math.min(Math.max(v, 0), width);
        for (let i = 0; i < poly.length; i++) {
            const [x0, y0] = poly[i];
            const [x1, y1] = poly[(i + 1) % poly.length];
            addEdge(acc, stride, height, clamp(x0), y0, clamp(x1), y1);
        }
        for (let y = 0; y < height; y++) {
            let sum = 0;
            for (let x = 0; x < width; x++) {
                sum += acc[y * stride + x];
                out[y * width + x] += Math.min(1, Math.abs(sum));
            }
        }
    }
    for (let i = 0; i < out.length; i++) out[i] = Math.min(1, out[i]);
    return out;
}

/** A rounded rectangle as a polygon: each corner is 96 chords of its arc, which is 0.004px off a 128px radius. */
export function roundedRect(w, h, r) {
    if (!r) return [[0, 0], [w, 0], [w, h], [0, h]];
    const pts = [];
    const corner = (cx, cy, from) => {
        for (let i = 0; i <= 96; i++) {
            const t = from + (Math.PI / 2) * (i / 96);
            pts.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
        }
    };
    corner(w - r, r, -Math.PI / 2);
    corner(w - r, h - r, 0);
    corner(r, h - r, Math.PI / 2);
    corner(r, r, Math.PI);
    return pts;
}

/** Render a mark source at `size` pixels square. Straight (non-premultiplied) RGBA, the glyph composited over the tile. */
export function renderMark(svg, size) {
    const m = parseMark(svg);
    const k = size / m.size;
    const tileCov = coverage([roundedRect(m.tile.width * k, m.tile.height * k, m.tile.rx * k)], size, size);
    const glyphCov = coverage(subpaths(m.glyph.d).map((p) => p.map(([x, y]) => [x * k, y * k])), size, size);
    const tile = hex(m.tile.fill);
    const glyph = hex(m.glyph.fill);
    const rgba = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
        const at = tileCov[i];
        const ag = glyphCov[i];
        const alpha = ag + at * (1 - ag);
        for (let c = 0; c < 3; c++) {
            const premult = glyph[c] * ag + tile[c] * at * (1 - ag);
            rgba[i * 4 + c] = alpha > 0 ? Math.round(premult / alpha) : 0;
        }
        rgba[i * 4 + 3] = Math.round(alpha * 255);
    }
    return { width: size, height: size, rgba };
}

// ─── PNG and ICO, by hand ────────────────────────────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
};
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An 8-bit PNG, every row filtered "Up" (a flat tile compresses to almost nothing). `alpha: false` throws if any pixel is not opaque. */
export function encodePng({ width, height, rgba }, { alpha }) {
    const bpp = alpha ? 4 : 3;
    const raw = Buffer.alloc(height * (1 + width * bpp));
    const pixel = (x, y, c) => (c === 3 && !alpha ? 0 : rgba[(y * width + x) * 4 + c]);
    for (let y = 0; y < height; y++) {
        const at = y * (1 + width * bpp);
        raw[at] = 2;
        for (let x = 0; x < width; x++) {
            if (!alpha && rgba[(y * width + x) * 4 + 3] !== 255) throw new Error(`pixel ${x},${y} is not opaque, and this PNG has no alpha channel`);
            for (let c = 0; c < bpp; c++) raw[at + 1 + x * bpp + c] = (pixel(x, y, c) - (y ? pixel(x, y - 1, c) : 0)) & 0xff;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = alpha ? 6 : 2;
    return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Width, height and colour type from a PNG's IHDR, or null when it is not a PNG. */
export function pngInfo(buf) {
    if (buf.length < 29 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), depth: buf[24], colorType: buf[25], interlace: buf[28] };
}

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG to straight RGBA, all five filters. Throws on anything else. */
export function decodePng(buf) {
    const info = pngInfo(buf);
    if (!info || info.depth !== 8 || info.interlace !== 0 || (info.colorType !== 2 && info.colorType !== 6)) throw new Error('not an 8-bit non-interlaced RGB/RGBA PNG');
    const idat = [];
    for (let at = 8; at < buf.length; ) {
        const len = buf.readUInt32BE(at);
        if (buf.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
        at += 12 + len;
    }
    const bpp = info.colorType === 6 ? 4 : 3;
    const stride = info.width * bpp;
    const data = inflateSync(Buffer.concat(idat));
    if (data.length !== info.height * (1 + stride)) throw new Error('the PNG data is not the size its header says');
    const px = Buffer.alloc(info.height * stride);
    for (let y = 0; y < info.height; y++) {
        const f = data[y * (1 + stride)];
        for (let i = 0; i < stride; i++) {
            const left = i >= bpp ? px[y * stride + i - bpp] : 0;
            const up = y ? px[(y - 1) * stride + i] : 0;
            const upLeft = y && i >= bpp ? px[(y - 1) * stride + i - bpp] : 0;
            const v = data[y * (1 + stride) + 1 + i];
            const p = left + up - upLeft;
            const pa = Math.abs(p - left);
            const pb = Math.abs(p - up);
            const pc = Math.abs(p - upLeft);
            const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
            px[y * stride + i] = (v + [0, left, up, (left + up) >> 1, paeth][f]) & 0xff;
        }
    }
    const rgba = new Uint8Array(info.width * info.height * 4);
    for (let i = 0; i < info.width * info.height; i++) {
        for (let c = 0; c < 3; c++) rgba[i * 4 + c] = px[i * bpp + c];
        rgba[i * 4 + 3] = bpp === 4 ? px[i * 4 + 3] : 255;
    }
    return { width: info.width, height: info.height, rgba };
}

/** An ICO whose images are PNGs (Vista and later, every browser): the directory, then each PNG. */
export function encodeIco(pngs) {
    const head = Buffer.alloc(6 + 16 * pngs.length);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(pngs.length, 4);
    let offset = head.length;
    pngs.forEach((png, i) => {
        const { width, height } = pngInfo(png);
        const at = 6 + 16 * i;
        head[at] = width >= 256 ? 0 : width;
        head[at + 1] = height >= 256 ? 0 : height;
        head.writeUInt16LE(1, at + 4);
        head.writeUInt16LE(32, at + 6);
        head.writeUInt32LE(png.length, at + 8);
        head.writeUInt32LE(offset, at + 12);
        offset += png.length;
    });
    return Buffer.concat([head, ...pngs]);
}

/** The PNG images of an ICO, in directory order, or null when the file is not a well-formed PNG-in-ICO. */
export function decodeIco(buf) {
    if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return null;
    const out = [];
    for (let i = 0; i < buf.readUInt16LE(4); i++) {
        const at = 6 + 16 * i;
        if (at + 16 > buf.length) return null;
        const size = buf.readUInt32LE(at + 8);
        const offset = buf.readUInt32LE(at + 12);
        if (offset + size > buf.length) return null;
        out.push({ declared: [buf[at] || 256, buf[at + 1] || 256], png: buf.subarray(offset, offset + size) });
    }
    return out;
}

// ─── the build: sources to files ─────────────────────────────────────────────────────────────────────────────────────

const pixelsHash = (img) => sha256(Buffer.from(img.rgba));
/** How far a committed pixel may sit from a fresh render, per channel: rounding across platforms, never a different mark. */
const PIXEL_TOLERANCE = 16;
/**
 * The first channel index where two RGBA buffers differ by more than PIXEL_TOLERANCE in what is actually seen: alpha, and each colour
 * channel premultiplied by its alpha. An edge pixel that one platform leaves at alpha 0 and another at alpha 1 carries an arbitrary
 * colour that nobody sees, so its raw colour is not compared. -1 when they match.
 */
function firstVisibleDifference(a, b) {
    for (let p = 0; p < a.length; p += 4) {
        if (Math.abs(a[p + 3] - b[p + 3]) > PIXEL_TOLERANCE) return p + 3;
        for (let c = 0; c < 3; c++) {
            if (Math.abs((a[p + c] * a[p + 3]) / 255 - (b[p + c] * b[p + 3]) / 255) > PIXEL_TOLERANCE) return p + c;
        }
    }
    return -1;
}

/** Every output as bytes, keyed as OUTPUTS is, with the pixel hash of each image. `read(name)` returns a source's text. */
export function renderAll(read) {
    const out = {};
    for (const [key, spec] of Object.entries(OUTPUTS)) {
        if (spec.kind === 'copy') {
            out[key] = { bytes: Buffer.from(read(spec.from)) };
        } else if (spec.kind === 'png') {
            const img = renderMark(read(spec.from), spec.size);
            out[key] = { bytes: encodePng(img, { alpha: spec.alpha }), pixels: pixelsHash(img) };
        } else {
            const images = spec.layers.map((l) => renderMark(read(l.from), l.size));
            out[key] = { bytes: encodeIco(images.map((img) => encodePng(img, { alpha: true }))), layers: images.map(pixelsHash) };
        }
    }
    return out;
}

/** `mark.1a2b3c4d.svg`: the stem, then the first 8 hex digits of the SHA-256 of the file's own bytes. */
export const hashedName = (spec, bytes) => `${spec.stem}.${sha256(bytes).slice(0, 8)}.${spec.ext}`;
export const fileOf = (spec, bytes) => (spec.path ? spec.path : `${BRAND_DIR}/${hashedName(spec, bytes)}`);
const RELEASE = (spec) => new RegExp(`^${spec.stem}\\.([0-9a-f]{8})\\.${spec.ext}$`);

/** The manifest the site serves at /site.webmanifest, from the one on disk: only the colours and the icons are this script's. */
export function webManifestFor(current, files) {
    const icon = (key, extra) => ({ src: `/${files[key]}`.replace('/public', ''), ...extra });
    return {
        ...current,
        background_color: PAGE_COLOUR,
        theme_color: PAGE_COLOUR,
        icons: [
            icon('icon_192', { sizes: '192x192', type: 'image/png', purpose: 'any' }),
            icon('icon_512', { sizes: '512x512', type: 'image/png', purpose: 'any' }),
            icon('icon_maskable_512', { sizes: '512x512', type: 'image/png', purpose: 'maskable' }),
            icon('mark_svg', { sizes: 'any', type: 'image/svg+xml', purpose: 'any' }),
        ],
    };
}

/** JSON, two spaces, with each icon on one line as the file has always been written. `icons` is the last key. */
export function formatWebManifest(m) {
    const { icons, ...rest } = m;
    const head = JSON.stringify(rest, null, 2).slice(0, -2);
    const line = (i) => `    { ${Object.entries(i).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ')} }`;
    return `${head},\n  "icons": [\n${icons.map(line).join(',\n')}\n  ]\n}\n`;
}

// ─── --check ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first definition of `--name` inside the block whose selector line matches `selector`, lowercased, or null. */
function tokenIn(css, selector, name) {
    const open = css.search(selector);
    if (open < 0) return null;
    let depth = 0;
    let end = css.indexOf('{', open);
    const from = end + 1;
    for (let i = end; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) {
            end = i;
            break;
        }
    }
    const m = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css.slice(from, end));
    return m ? m[1].trim().toLowerCase() : null;
}

/** Everything wrong with the committed icons and everything that names them, as readable lines. `overrides` as in build-font's makeIo. */
export function collectProblems(root = ROOT, overrides = {}) {
    const io = makeIo(root, overrides);
    const problems = [];
    let manifest;
    try {
        manifest = JSON.parse(io.text(MANIFEST));
    } catch (e) {
        return [`${MANIFEST} is missing or not JSON (${e.message}): run node scripts/build-brand-icons.mjs`];
    }

    // 1. The sources are the kit's finals, and each is still the drawing IDENTITY.md section 2 describes.
    const texts = {};
    for (const name of SOURCES) {
        let text;
        try {
            text = io.text(`${SRC_DIR}/${name}`);
        } catch {
            problems.push(`${SRC_DIR}/${name} is missing`);
            continue;
        }
        texts[name] = text;
        if (sha256(text) !== manifest.sources?.[name]) problems.push(`${SRC_DIR}/${name} is not the kit's final the manifest pinned: the mark changes by a new kit and a rebuild, not by an edit`);
        if (/<text|transform=|stroke|<filter|<g[\s>]|<image/.test(text)) problems.push(`${name}: the finals hold paths only: no text, transform, stroke, filter, group or image`);
        let m;
        try {
            m = parseMark(text);
        } catch (e) {
            problems.push(`${name}: ${e.message}`);
            continue;
        }
        const subs = subpaths(m.glyph.d);
        // The د and the ر: two subpaths. A third is a dot, and ر with a dot is ز: «زد» is Zid, a competitor's name (IDENTITY.md Never).
        if (subs.length !== 2) problems.push(`${name}: the glyph has ${subs.length} subpaths, expected 2 (the د and the ر). Never add a dot: ر with a dot reads «زد», which is Zid`);
        const anchors = subs.reduce((n, s) => n + s.length, 0);
        if (name !== 'mark-micro-16.svg' && name !== 'mark-small-24.svg' && anchors !== 14) problems.push(`${name}: ${anchors} anchors, expected 14`);
        if (name === 'mark-cardamom.svg' || name === 'mark-ink.svg') {
            if (m.glyph.d !== GLYPH_MASTER) problems.push(`${name}: the glyph is not the master geometry the inline marks repeat`);
            const want = name === 'mark-cardamom.svg' ? CARDAMOM : INK;
            if (m.tile.fill !== want.tile || m.glyph.fill !== want.glyph) problems.push(`${name}: colours ${m.tile.fill}/${m.glyph.fill}, expected ${want.tile}/${want.glyph}`);
        }
        if (name === 'mark-micro-16.svg' || name === 'mark-cardamom.svg' || name === 'mark-small-24.svg' || name === 'mark-fullbleed-maskable.svg') {
            if (m.tile.fill !== CARDAMOM.tile || m.glyph.fill !== CARDAMOM.glyph) problems.push(`${name}: every icon is the Cardamom colourway (${CARDAMOM.tile}/${CARDAMOM.glyph}), not ${m.tile.fill}/${m.glyph.fill}`);
        }
    }
    if (SOURCES.some((s) => !texts[s])) return problems;
    const read = (name) => texts[name];

    // 2. Every output: present, named for its bytes, as recorded, and holding exactly the pixels the sources render to.
    const brand = io.names(BRAND_DIR);
    const files = {};
    for (const [key, spec] of Object.entries(OUTPUTS)) {
        const rec = manifest.outputs?.[key];
        if (!rec) {
            problems.push(`${MANIFEST} has no record of ${key}`);
            continue;
        }
        files[key] = rec.file;
        const expectedPath = spec.path ?? `${BRAND_DIR}/${rec.file.split('/').pop()}`;
        if (rec.file !== expectedPath) problems.push(`${MANIFEST}: ${key} is recorded as ${rec.file}, expected ${spec.path ?? `${BRAND_DIR}/${spec.stem}.<sha8>.${spec.ext}`}`);
        let bytes;
        try {
            bytes = io.bytes(rec.file);
        } catch {
            problems.push(`${rec.file} is missing`);
            continue;
        }
        if (sha256(bytes) !== rec.sha256) problems.push(`${rec.file}: ${MANIFEST} records a different hash than the file has`);
        if (!spec.path) {
            const name = rec.file.split('/').pop();
            const m = RELEASE(spec).exec(name);
            if (!m) problems.push(`${rec.file} is not named ${spec.stem}.<sha8>.${spec.ext}`);
            else if (m[1] !== sha256(bytes).slice(0, 8)) problems.push(`${rec.file} is not named for the SHA-256 of its own bytes (${sha256(bytes).slice(0, 8)})`);
            const releases = brand.filter((n) => RELEASE(spec).test(n));
            if (releases.length > MAX_RELEASES) problems.push(`${BRAND_DIR} holds ${releases.length} copies of ${spec.stem} (${releases.join(', ')}); keep this release and one before it`);
        }
        if (spec.kind === 'copy') {
            if (!bytes.equals(Buffer.from(read(spec.from)))) problems.push(`${rec.file} is not a byte-for-byte copy of ${SRC_DIR}/${spec.from}`);
            continue;
        }
        const wantLayers = spec.kind === 'ico' ? spec.layers.map((l) => ({ ...l, alpha: true })) : [{ size: spec.size, from: spec.from, alpha: spec.alpha }];
        let images;
        if (spec.kind === 'ico') {
            const entries = decodeIco(bytes);
            if (!entries || entries.length !== wantLayers.length) {
                problems.push(`${rec.file} is not a PNG-in-ICO with ${wantLayers.length} images`);
                continue;
            }
            if (bytes.length > ICO_MAX_BYTES) problems.push(`${rec.file} is ${bytes.length} bytes, over the ${ICO_MAX_BYTES} limit`);
            images = entries.map((e) => e.png);
            entries.forEach((e, i) => {
                const [w, h] = e.declared;
                const info = pngInfo(e.png);
                if (!info || info.width !== w || info.height !== h) problems.push(`${rec.file}: image ${i} is declared ${w}x${h} but is ${info ? `${info.width}x${info.height}` : 'not a PNG'}`);
            });
        } else {
            images = [bytes];
        }
        images.forEach((png, i) => {
            const want = wantLayers[i];
            const info = pngInfo(png);
            if (!info) return problems.push(`${rec.file}: image ${i} is not a PNG`);
            if (info.width !== want.size || info.height !== want.size) return problems.push(`${rec.file}: image ${i} is ${info.width}x${info.height}, expected ${want.size}x${want.size}`);
            if (info.colorType !== (want.alpha ? 6 : 2)) problems.push(`${rec.file}: image ${i} has colour type ${info.colorType}, expected ${want.alpha ? '6 (RGBA)' : '2 (RGB: no alpha channel)'}`);
            try {
                const fresh = renderMark(read(want.from), want.size);
                const actual = decodePng(png);
                // A small per-channel tolerance: the coverage arithmetic lands antialiased edge pixels differently on CI's Linux/Node than on
                // the Mac (seen at 181,16 on the 192 tile's corner arc). A real change to the mark moves pixels by far more than 16 levels.
                const diff = firstVisibleDifference(fresh.rgba, actual.rgba);
                if (diff >= 0) problems.push(`${rec.file}: image ${i} differs from ${want.from} rendered at ${want.size}px at pixel ${Math.floor(diff / 4) % want.size},${Math.floor(diff / 4 / want.size)} (channel ${diff % 4}: committed ${actual.rgba[diff]}, fresh ${fresh.rgba[diff]}): re-render with node scripts/build-brand-icons.mjs`);
            } catch (e) {
                problems.push(`${rec.file}: image ${i} could not be compared (${e.message})`);
            }
        });
    }

    // 3. The webmanifest names this release's icons and the dark page's colour.
    try {
        const wm = JSON.parse(io.text(WEBMANIFEST));
        if (Object.keys(files).length === Object.keys(OUTPUTS).length) {
            const want = webManifestFor(wm, files);
            for (const field of ['background_color', 'theme_color', 'icons']) {
                if (JSON.stringify(wm[field]) !== JSON.stringify(want[field])) problems.push(`${WEBMANIFEST}: ${field} is ${JSON.stringify(wm[field])}, expected ${JSON.stringify(want[field])}`);
            }
        }
    } catch (e) {
        problems.push(`${WEBMANIFEST} is missing or not JSON (${e.message})`);
    }

    // 4. Every page names the set, once, and no other icon.
    for (const page of PAGES) {
        let html;
        try {
            html = io.text(page);
        } catch {
            problems.push(`${page} is missing`);
            continue;
        }
        const head = html.replace(/<!--[\s\S]*?-->/g, '');
        for (const tag of HEAD_TAGS) if (head.split(tag).length !== 2) problems.push(`${page}: expected exactly one ${tag}`);
        const icons = [...head.matchAll(/<link\b[^>]*\brel="(?:shortcut )?icon"[^>]*>/g)].length;
        if (icons !== 2) problems.push(`${page}: ${icons} rel="icon" links, expected the .ico and the .svg`);
    }

    // 5. tokens.css paints the mark in the colourways the sources are.
    try {
        const css = io.text(TOKENS_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
        const want = [
            ["dark", /:root,\s*:root\[data-theme='dark'\]\s*\{/, CARDAMOM],
            ["light (media)", /:root:not\(\[data-theme='dark'\]\)\s*\{/, INK],
            ["light (pinned)", /:root\[data-theme='light'\]\s*\{/, INK],
        ];
        for (const [theme, selector, colours] of want) {
            const tile = tokenIn(css, selector, '--mark-tile');
            const glyph = tokenIn(css, selector, '--mark-glyph');
            if (tile !== colours.tile.toLowerCase() || glyph !== colours.glyph.toLowerCase()) problems.push(`tokens.css (${theme}): --mark-tile ${tile} / --mark-glyph ${glyph}, expected ${colours.tile.toLowerCase()} / ${colours.glyph.toLowerCase()}`);
        }
        if (/--mark-tile-lit/.test(css)) problems.push('tokens.css still defines --mark-tile-lit: the new tile is flat');
        const page = tokenIn(css, /:root,\s*:root\[data-theme='dark'\]\s*\{/, '--surface-page');
        if (page !== PAGE_COLOUR.toLowerCase()) problems.push(`the manifest's colour is ${PAGE_COLOUR} but the dark --surface-page is ${page}`);
    } catch {
        problems.push(`${TOKENS_CSS} is missing`);
    }

    // 6. The root files the pages ask for by name have a route: `public/**` has no static handler, so a missing route is a 404 in production.
    try {
        const index = io.text(INDEX_TS);
        for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'site.webmanifest']) {
            if (!index.includes(`app.get('/${file}'`) || !index.includes(`path.join(__dirname, '../public/${file}')`)) problems.push(`${INDEX_TS} does not serve /${file} from public/${file}`);
        }
    } catch {
        problems.push(`${INDEX_TS} is missing`);
    }
    return problems;
}

// ─── build ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function build() {
    const read = (name) => readFileSync(join(ROOT, SRC_DIR, name), 'utf8');
    for (const name of SOURCES) {
        const m = parseMark(read(name));
        if (subpaths(m.glyph.d).length !== 2) throw new Error(`${name}: the glyph must be exactly two subpaths (never add a dot)`);
    }
    const previous = existsSync(join(ROOT, MANIFEST)) ? JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8')) : { outputs: {} };
    const rendered = renderAll(read);
    const recorded = {};
    const files = {};
    for (const [key, spec] of Object.entries(OUTPUTS)) {
        const { bytes, pixels, layers } = rendered[key];
        const file = fileOf(spec, bytes);
        writeFileSync(join(ROOT, file), bytes);
        files[key] = file;
        recorded[key] = { file, sha256: sha256(bytes), bytes: bytes.length, ...(pixels ? { pixels } : {}), ...(layers ? { layers } : {}) };
        if (!spec.path) {
            // This release and the one before it stay; anything older goes.
            const keep = new Set([file.split('/').pop(), previous.outputs?.[key]?.file?.split('/').pop()]);
            for (const n of readdirSync(join(ROOT, BRAND_DIR))) if (RELEASE(spec).test(n) && !keep.has(n)) unlinkSync(join(ROOT, BRAND_DIR, n));
        }
    }
    if (rendered.favicon_ico.bytes.length > ICO_MAX_BYTES) throw new Error(`favicon.ico is ${rendered.favicon_ico.bytes.length} bytes, over the ${ICO_MAX_BYTES} limit`);
    const sources = Object.fromEntries(SOURCES.map((n) => [n, sha256(read(n))]));
    writeFileSync(join(ROOT, MANIFEST), `${JSON.stringify({ renderer: 'scripts/build-brand-icons.mjs: exact polygon coverage, node zlib', sources, outputs: recorded }, null, 2)}\n`);
    const current = JSON.parse(readFileSync(join(ROOT, WEBMANIFEST), 'utf8'));
    writeFileSync(join(ROOT, WEBMANIFEST), formatWebManifest(webManifestFor(current, files)));
    for (const r of Object.values(recorded)) console.log(`built ${r.file}: ${kb(r.bytes)} KB`);
    console.log(`wrote ${MANIFEST} and ${WEBMANIFEST}; run npm run check:brand-icons`);
}

function main() {
    const args = process.argv.slice(2);
    if (args.includes('--check') || args.includes('--reproduce')) {
        const problems = collectProblems();
        if (problems.length) {
            console.error('\nbrand-icons check failed:\n');
            for (const p of problems) console.error(`   - ${p}\n`);
            process.exit(1);
        }
        const m = JSON.parse(readFileSync(join(ROOT, MANIFEST), 'utf8'));
        const total = Object.values(m.outputs).reduce((n, o) => n + o.bytes, 0);
        console.log(`brand icons ok: ${Object.keys(m.outputs).length} files, ${kb(total)} KB, ico ${kb(m.outputs.favicon_ico.bytes)} KB (limit ${kb(ICO_MAX_BYTES)}), named by ${PAGES.length} pages`);
        if (args.includes('--reproduce')) {
            const read = (name) => readFileSync(join(ROOT, SRC_DIR, name), 'utf8');
            let bad = 0;
            for (const [key, o] of Object.entries(renderAll(read))) {
                if (sha256(o.bytes) !== m.outputs[key].sha256) {
                    console.error(`not byte-reproducible: ${key} renders to ${sha256(o.bytes)} on this node, the committed file to ${m.outputs[key].sha256} (the pixels were just proved equal; deflate may differ between Node versions)`);
                    bad++;
                }
            }
            if (bad) process.exit(1);
            console.log('reproduced: every file is byte-identical to a fresh render');
        }
        return;
    }
    build();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
