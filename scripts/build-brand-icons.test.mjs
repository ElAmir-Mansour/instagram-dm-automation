/**
 * The Kufi «رد» icon set (B5): the favicon .svg and .ico, the apple-touch icon, the manifest's PNGs and the pages that name them.
 *
 * `npm run check:brand-icons` is the guard CI runs; this file tests the guard and the rasteriser under it. The first block asserts the
 * committed files pass the whole check on a clean tree (a check that fails on a clean tree would make every mutation below
 * meaningless). The second proves the rasteriser instead of trusting it: exact area, whole-pixel edges at the sizes the kit says are
 * exact, PNG and ICO round trips with every PNG filter. The third mutates one file at a time IN MEMORY (`makeIo` lays overrides over
 * the repo) and requires a problem that names the mutation; each mutation first asserts its anchor exists, because one that matched
 * nothing would pass silently. The fourth reads every inline mark in the repo against the kit's geometry.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
    BRAND_DIR,
    CARDAMOM,
    GLYPH_MASTER,
    HEAD_TAGS,
    ICON_FILE,
    ICO_MAX_BYTES,
    INK,
    MANIFEST,
    OUTPUTS,
    PAGES,
    SOURCES,
    SRC_DIR,
    WEBMANIFEST,
    collectProblems,
    coverage,
    decodeIco,
    decodePng,
    encodeIco,
    encodePng,
    parseMark,
    pngInfo,
    renderMark,
    roundedRect,
    subpaths,
} from './build-brand-icons.mjs';

const read = (rel) => readFileSync(rel, 'utf8');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const manifest = JSON.parse(read(MANIFEST));
const problemsWith = (overrides) => collectProblems(process.cwd(), overrides);
const source = (name) => read(`${SRC_DIR}/${name}`);

/** Replace `from` with `to` in a file's text, failing first if `from` is not there exactly `times` times. */
function mutate(rel, from, to, times = 1) {
    const text = read(rel);
    assert.equal(text.split(from).length - 1, times, `mutation anchor "${from}" in ${rel}`);
    return text.split(from).join(to);
}

/** The area of a simple polygon, by the shoelace formula: the independent number the rasteriser's coverage must add up to. */
const area = (poly) => Math.abs(poly.reduce((a, [x0, y0], i) => { const [x1, y1] = poly[(i + 1) % poly.length]; return a + (x0 * y1 - x1 * y0); }, 0)) / 2;
const sum = (arr) => arr.reduce((a, b) => a + b, 0);

describe('the committed icon set', () => {
    it('passes the whole check on a clean tree', () => {
        assert.deepEqual(collectProblems(), []);
    });

    it('is every file the build writes: the stable names, and one content-hashed file each under public/brand', () => {
        assert.deepEqual(Object.keys(manifest.outputs).sort(), Object.keys(OUTPUTS).sort());
        for (const [key, rec] of Object.entries(manifest.outputs)) {
            const bytes = readFileSync(rec.file);
            assert.equal(sha(bytes), rec.sha256, key);
            assert.equal(bytes.length, rec.bytes, key);
            if (!OUTPUTS[key].path) assert.match(rec.file, new RegExp(`^${BRAND_DIR}/${OUTPUTS[key].stem}\\.${sha(bytes).slice(0, 8)}\\.${OUTPUTS[key].ext}$`), `${key} is named for its own bytes`);
        }
        // scripts/build-hero3d.mjs lets exactly these names live in public/brand (its check fails on any other file there).
        const hashed = Object.values(manifest.outputs).filter((o) => o.file.startsWith(`${BRAND_DIR}/`)).map((o) => o.file.slice(BRAND_DIR.length + 1));
        assert.equal(hashed.length, 4);
        for (const name of hashed) assert.match(name, ICON_FILE);
        const stable = Object.values(OUTPUTS).filter((o) => o.path).map((o) => o.path).sort();
        assert.deepEqual(stable, ['public/apple-touch-icon.png', 'public/favicon.ico', 'public/favicon.svg']);
    });

    it('has the sizes IDENTITY.md section 8 names: 16, 32 and 48 in the .ico, 180 apple-touch, 192 and 512 any, 512 maskable', () => {
        const ico = decodeIco(readFileSync('public/favicon.ico'));
        assert.deepEqual(ico.map((e) => e.declared), [[16, 16], [32, 32], [48, 48]]);
        assert.deepEqual(ico.map((e) => pngInfo(e.png).colorType), [6, 6, 6], 'RGBA: the tile has rounded corners');
        assert.ok(readFileSync('public/favicon.ico').length <= ICO_MAX_BYTES && ICO_MAX_BYTES === 15 * 1000);
        const info = (key) => pngInfo(readFileSync(manifest.outputs[key].file));
        assert.deepEqual([info('apple_touch').width, info('apple_touch').height, info('apple_touch').colorType], [180, 180, 2], 'apple-touch: 180, no alpha');
        assert.deepEqual([info('icon_192').width, info('icon_192').colorType], [192, 6]);
        assert.deepEqual([info('icon_512').width, info('icon_512').colorType], [512, 6]);
        assert.deepEqual([info('icon_maskable_512').width, info('icon_maskable_512').colorType], [512, 2], 'maskable: full-bleed, no alpha');
    });

    it('draws each ICO layer from the cut IDENTITY.md names: the micro at 16, the master at 32, the small cut at 2x for 48', () => {
        const ico = decodeIco(readFileSync('public/favicon.ico'));
        const from = [['mark-micro-16.svg', 16], ['mark-cardamom.svg', 32], ['mark-small-24.svg', 48]];
        from.forEach(([name, size], i) => {
            assert.deepEqual(Array.from(decodePng(ico[i].png).rgba), Array.from(renderMark(source(name), size).rgba), `${name} at ${size}`);
        });
        // The cuts differ: the master at 16 would be a different image from the micro, which is the reason the micro exists.
        assert.notDeepEqual(Array.from(renderMark(source('mark-cardamom.svg'), 16).rgba), Array.from(renderMark(source('mark-micro-16.svg'), 16).rgba));
    });

    it('the favicon is Cardamom whichever the scheme: favicon.svg carries no media query or style', () => {
        const svg = read('public/favicon.svg');
        assert.equal(svg, source('mark-micro-16.svg'));
        assert.equal(/prefers-color-scheme|<style|@media/.test(svg), false);
    });
});

describe('the sources are the kit\'s finals, and the guard knows what that means', () => {
    it('five files, each pinned by hash, each one tile and one path of straight edges', () => {
        assert.deepEqual(Object.keys(manifest.sources).sort(), [...SOURCES].sort());
        for (const name of SOURCES) {
            assert.equal(sha(source(name)), manifest.sources[name], name);
            const m = parseMark(source(name));
            assert.equal(subpaths(m.glyph.d).length, 2, `${name}: the د and the ر, no dot`);
            assert.equal(/[^MHVLZ0-9.\-\s,]/.test(m.glyph.d), false, `${name}: M H V L Z only`);
        }
    });

    it('the master has 14 anchors and the edges IDENTITY.md section 2 names: orthogonal, plus the ر\'s 45 degree tail', () => {
        const subs = subpaths(GLYPH_MASTER);
        assert.equal(sum(subs.map((s) => s.length)), 14);
        const slopes = new Set();
        for (const s of subs) {
            s.forEach(([x0, y0], i) => {
                const [x1, y1] = s[(i + 1) % s.length];
                if (x0 === x1) slopes.add('vertical');
                else if (y0 === y1) slopes.add('horizontal');
                else slopes.add(Math.abs(Math.abs((y1 - y0) / (x1 - x0)) - 1) < 1e-9 ? '45' : `other ${(y1 - y0) / (x1 - x0)}`);
            });
        }
        assert.deepEqual([...slopes].sort(), ['45', 'horizontal', 'vertical']);
    });

    it('the Cardamom and Ink colourways are the ones IDENTITY.md section 2 measured', () => {
        const cardamom = parseMark(source('mark-cardamom.svg'));
        assert.deepEqual([cardamom.tile.fill, cardamom.glyph.fill], [CARDAMOM.tile, CARDAMOM.glyph]);
        const ink = parseMark(source('mark-ink.svg'));
        assert.deepEqual([ink.tile.fill, ink.glyph.fill], [INK.tile, INK.glyph]);
        for (const name of ['mark-micro-16.svg', 'mark-small-24.svg', 'mark-fullbleed-maskable.svg']) {
            const m = parseMark(source(name));
            assert.deepEqual([m.tile.fill, m.glyph.fill], [CARDAMOM.tile, CARDAMOM.glyph], `${name}: every icon is Cardamom`);
        }
    });

    it('if the local kit is present, the committed copies are byte-equal to it (docs/ is gitignored, so CI skips this)', (t) => {
        const kit = '../../../docs/brand/mark/final';
        const dir = [join(process.cwd(), 'docs/brand/mark/final'), join(process.cwd(), kit)].find((d) => existsSync(join(d, 'mark-cardamom.svg')));
        if (!dir) return t.skip('docs/brand/mark/final is not here');
        for (const name of SOURCES) assert.equal(read(join(dir, name)), source(name), name);
    });
});

describe('the rasteriser is exact, not merely plausible', () => {
    it('the coverage of each glyph adds up to its polygon area, at the sizes the icons use', () => {
        for (const name of ['mark-cardamom.svg', 'mark-micro-16.svg', 'mark-small-24.svg', 'mark-fullbleed-maskable.svg']) {
            const m = parseMark(source(name));
            for (const size of [16, 24, 32, 48, 64, 180, 192, 512]) {
                const k = size / m.size;
                const polys = subpaths(m.glyph.d).map((p) => p.map(([x, y]) => [x * k, y * k]));
                const cov = coverage(polys, size, size);
                const expected = sum(polys.map(area));
                assert.ok(Math.abs(sum(Array.from(cov)) - expected) < 1e-7, `${name} at ${size}: coverage ${sum(Array.from(cov))} vs area ${expected}`);
            }
        }
    });

    it('the rounded tile covers its area: w*h minus the four corners (4 - pi) r^2', () => {
        for (const [size, r] of [[16, 4], [32, 8], [64, 16], [512, 128]]) {
            const cov = coverage([roundedRect(size, size, r)], size, size);
            const expected = size * size - (4 - Math.PI) * r * r;
            // 96 chords a corner are a sag of 0.004px on a 128px radius (under 1/255 of a pixel): the area is off by r^2 * 3e-4.
            assert.ok(Math.abs(sum(Array.from(cov)) - expected) < r * r * 4e-4, `${size}: ${sum(Array.from(cov))} vs ${expected}`);
        }
    });

    it('the micro cut at 16px: every pixel of the glyph is 0, a clean 50% cut, or 1 (every anchor a whole pixel)', () => {
        const m = parseMark(source('mark-micro-16.svg'));
        const cov = coverage(subpaths(m.glyph.d).map((p) => p.map(([x, y]) => [x, y])), 16, 16);
        const odd = Array.from(cov).filter((v) => Math.min(Math.abs(v), Math.abs(v - 0.5), Math.abs(v - 1)) > 1e-9);
        assert.deepEqual(odd, [], 'a fractional pixel that is not a 50% edge');
        assert.ok(Array.from(cov).some((v) => Math.abs(v - 0.5) < 1e-9), 'the 45 degree edges are 50% cuts, so the check is looking at something');
    });

    it('the small cut at 24px and at 48px (its 2x): the same', () => {
        const m = parseMark(source('mark-small-24.svg'));
        for (const size of [24, 48]) {
            const k = size / 24;
            const cov = coverage(subpaths(m.glyph.d).map((p) => p.map(([x, y]) => [x * k, y * k])), size, size);
            const odd = Array.from(cov).filter((v) => Math.min(Math.abs(v), Math.abs(v - 0.5), Math.abs(v - 1)) > 1e-9);
            assert.deepEqual(odd, [], `${size}px`);
        }
    });

    it('the master\'s د is on whole pixels at 32 and 64 (so those are the sizes), and between pixels at 38 and 62 (so they were not)', () => {
        const [dal] = subpaths(GLYPH_MASTER);
        const fractional = (size) => {
            const k = size / 256;
            const cov = coverage([dal.map(([x, y]) => [x * k, y * k])], size, size);
            return Array.from(cov).filter((v) => v > 1e-9 && v < 1 - 1e-9).length;
        };
        assert.equal(fractional(32), 0);
        assert.equal(fractional(64), 0);
        assert.ok(fractional(38) > 20, 'at 38px the edges fall between pixels');
        assert.ok(fractional(62) > 20, 'at 62px too');
    });

    it('renders the tile transparent at its corners and opaque at its centre, the glyph in ink and the tile in Cardamom', () => {
        const img = renderMark(source('mark-cardamom.svg'), 64);
        const px = (x, y) => Array.from(img.rgba.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
        assert.equal(px(0, 0)[3], 0, 'the corner pixel is outside the radius');
        assert.deepEqual(px(2, 32), [0xbc, 0xde, 0x70, 255], 'Cardamom tile, fully opaque');
        // The د's vertical stem: x 104..136 of 256 is 26..34 at 64px, y 56..152 is 14..38.
        assert.deepEqual(px(30, 20), [0x14, 0x16, 0x10, 255], 'the glyph is #141610');
    });

    it('is deterministic: the same source renders to the same bytes twice', () => {
        for (const [name, size] of [['mark-cardamom.svg', 192], ['mark-fullbleed-maskable.svg', 180]]) {
            const a = encodePng(renderMark(source(name), size), { alpha: name !== 'mark-fullbleed-maskable.svg' });
            const b = encodePng(renderMark(source(name), size), { alpha: name !== 'mark-fullbleed-maskable.svg' });
            assert.ok(a.equals(b));
        }
    });

    it('refuses to drop the alpha channel from a transparent image (a rounded tile cannot be an apple-touch icon)', () => {
        assert.throws(() => encodePng(renderMark(source('mark-cardamom.svg'), 32), { alpha: false }), /not opaque/);
    });
});

describe('PNG and ICO, by hand', () => {
    /** A PNG with every row filtered the same way, to decode it with each of the five filters the decoder must know. */
    function withFilter(img, f, alpha) {
        const bpp = alpha ? 4 : 3;
        const stride = img.width * bpp;
        const px = Buffer.alloc(img.height * stride);
        for (let i = 0; i < img.width * img.height; i++) for (let c = 0; c < bpp; c++) px[i * bpp + c] = img.rgba[i * 4 + c];
        const raw = Buffer.alloc(img.height * (1 + stride));
        for (let y = 0; y < img.height; y++) {
            raw[y * (1 + stride)] = f;
            for (let i = 0; i < stride; i++) {
                const left = i >= bpp ? px[y * stride + i - bpp] : 0;
                const up = y ? px[(y - 1) * stride + i] : 0;
                const upLeft = y && i >= bpp ? px[(y - 1) * stride + i - bpp] : 0;
                const p = left + up - upLeft;
                const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
                const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
                raw[y * (1 + stride) + 1 + i] = (px[y * stride + i] - [0, left, up, (left + up) >> 1, paeth][f]) & 0xff;
            }
        }
        return raw;
    }

    it('decodes what the encoder wrote, exactly, in RGBA and in RGB', () => {
        for (const [name, size, alpha] of [['mark-cardamom.svg', 48, true], ['mark-fullbleed-maskable.svg', 48, false]]) {
            const img = renderMark(source(name), size);
            const back = decodePng(encodePng(img, { alpha }));
            assert.deepEqual([back.width, back.height], [size, size]);
            assert.deepEqual(Array.from(back.rgba), Array.from(img.rgba), name);
        }
    });

    it('decodes all five PNG filters to the same pixels (the committed files use Up; a PNG from anywhere else may not)', async () => {
        const { deflateSync } = await import('node:zlib');
        const img = renderMark(source('mark-cardamom.svg'), 24);
        const ref = encodePng(img, { alpha: true });
        for (let f = 0; f <= 4; f++) {
            const raw = withFilter(img, f, true);
            // The same container as the encoder's, with this filter's rows: take its IHDR, swap the IDAT.
            const ihdr = ref.subarray(8, 8 + 12 + 13);
            const idat = deflateSync(raw);
            const chunk = (type, data) => {
                const out = Buffer.alloc(12 + data.length);
                out.writeUInt32BE(data.length, 0);
                out.write(type, 4, 'latin1');
                data.copy(out, 8);
                return out; // the decoder reads lengths and types, not CRCs
            };
            const png = Buffer.concat([ref.subarray(0, 8), ihdr, chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
            assert.deepEqual(Array.from(decodePng(png).rgba), Array.from(img.rgba), `filter ${f}`);
        }
    });

    it('pngInfo and decodePng refuse what they do not understand', () => {
        assert.equal(pngInfo(Buffer.from('GIF89a')), null);
        assert.throws(() => decodePng(Buffer.from('not a png at all, not at all, not at all, no')), /not an 8-bit/);
    });

    it('an ICO round-trips: the directory, the sizes, and each PNG intact', () => {
        const pngs = [16, 32, 48].map((n) => encodePng(renderMark(source('mark-cardamom.svg'), n), { alpha: true }));
        const entries = decodeIco(encodeIco(pngs));
        assert.deepEqual(entries.map((e) => e.declared), [[16, 16], [32, 32], [48, 48]]);
        entries.forEach((e, i) => assert.ok(e.png.equals(pngs[i])));
        assert.equal(decodeIco(Buffer.from('not an ico')), null);
    });
});

describe('the guard catches what it exists to catch (each mutation applied in memory, anchor asserted first)', () => {
    it('a dot added to the ر: a third subpath, and a changed source', () => {
        const rel = `${SRC_DIR}/mark-cardamom.svg`;
        const text = mutate(rel, 'L168 165.25Z"/>', 'L168 165.25ZM170 230H180V240H170Z"/>');
        const problems = problemsWith({ [rel]: text });
        assert.ok(problems.some((p) => /3 subpaths, expected 2/.test(p) && /Zid/.test(p)), problems.join('\n'));
        assert.ok(problems.some((p) => /not the kit's final the manifest pinned/.test(p)));
        assert.ok(problems.some((p) => /not the master geometry/.test(p)));
    });

    it('the ر redrawn without a hair of its tail: a source that is not the pinned final', () => {
        const rel = `${SRC_DIR}/mark-micro-16.svg`;
        const problems = problemsWith({ [rel]: mutate(rel, 'M11 3H13V11L11 13H8L11 10Z', 'M11 3H13V11L11 13H9L11 10Z') });
        assert.ok(problems.some((p) => /mark-micro-16\.svg is not the kit's final/.test(p)), problems.join('\n'));
    });

    it('a tile in the Ink colourway as an icon: refused (Ink at 16px is Linktree\'s pattern, and 1.07:1 on a dark tab strip)', () => {
        const rel = `${SRC_DIR}/mark-micro-16.svg`;
        const text = mutate(rel, 'fill="#BCDE70"/>', 'fill="#1A1C15"/>').replace('<path fill="#141610"', '<path fill="#BCDE70"');
        assert.ok(problemsWith({ [rel]: text }).some((p) => /every icon is the Cardamom colourway/.test(p)));
    });

    it('a committed PNG with one pixel changed: the pixels, not the hash, are what is checked', () => {
        const rec = manifest.outputs.icon_192;
        const png = readFileSync(rec.file);
        const img = decodePng(png);
        const i = (96 * 192 + 96) * 4;
        img.rgba[i] = img.rgba[i] ^ 0xff;
        const forged = encodePng(img, { alpha: true });
        const name = `icon-192.${sha(forged).slice(0, 8)}.png`;
        const m = JSON.parse(JSON.stringify(manifest));
        m.outputs.icon_192 = { ...rec, file: `${BRAND_DIR}/${name}`, sha256: sha(forged), bytes: forged.length };
        // A forger who also renames the file and updates the manifest still fails: the pixels are not what the source renders to.
        const problems = problemsWith({ [`${BRAND_DIR}/${name}`]: forged, [MANIFEST]: JSON.stringify(m) });
        assert.ok(problems.some((p) => /icon-192\.[0-9a-f]{8}\.png: image 0 differs from mark-cardamom\.svg rendered at 192px at pixel 96,96/.test(p)), problems.join('\n'));
    });

    it('a file edited without its name or manifest following: the hash named in the file name and the manifest both fail', () => {
        const rec = manifest.outputs.icon_512;
        const bytes = Buffer.from(readFileSync(rec.file));
        bytes[bytes.length - 20] ^= 1;
        const problems = problemsWith({ [rec.file]: bytes });
        assert.ok(problems.some((p) => /not named for the SHA-256 of its own bytes/.test(p)), problems.join('\n'));
        assert.ok(problems.some((p) => /records a different hash than the file has/.test(p)));
    });

    it('a missing file, and a missing record', () => {
        const rec = manifest.outputs.apple_touch;
        assert.ok(problemsWith({ [rec.file]: null }).some((p) => /public\/apple-touch-icon\.png is missing/.test(p)));
        const m = JSON.parse(JSON.stringify(manifest));
        delete m.outputs.favicon_ico;
        assert.ok(problemsWith({ [MANIFEST]: JSON.stringify(m) }).some((p) => /has no record of favicon_ico/.test(p)));
    });

    it('an apple-touch icon with an alpha channel, and one of the wrong size', () => {
        const rec = manifest.outputs.apple_touch;
        const withAlpha = encodePng(renderMark(source('mark-fullbleed-maskable.svg'), 180), { alpha: true });
        const p1 = problemsWith({ [rec.file]: withAlpha });
        assert.ok(p1.some((p) => /colour type 6, expected 2 \(RGB: no alpha channel\)/.test(p)), p1.join('\n'));
        const wrongSize = encodePng(renderMark(source('mark-fullbleed-maskable.svg'), 192), { alpha: false });
        assert.ok(problemsWith({ [rec.file]: wrongSize }).some((p) => /is 192x192, expected 180x180/.test(p)));
    });

    it('an .ico over 15 KB, and one with a layer missing', () => {
        const ico = Buffer.concat([readFileSync('public/favicon.ico'), Buffer.alloc(ICO_MAX_BYTES)]);
        assert.ok(problemsWith({ 'public/favicon.ico': ico }).some((p) => /over the 15000 limit/.test(p)));
        const two = encodeIco([16, 32].map((n) => encodePng(renderMark(source('mark-cardamom.svg'), n), { alpha: true })));
        assert.ok(problemsWith({ 'public/favicon.ico': two }).some((p) => /not a PNG-in-ICO with 3 images/.test(p)));
    });

    it('a copy of the favicon that is not the micro cut', () => {
        const problems = problemsWith({ 'public/favicon.svg': mutate('public/favicon.svg', 'rx="4"', 'rx="5"') });
        assert.ok(problems.some((p) => /public\/favicon\.svg is not a byte-for-byte copy of scripts\/brand-icons\/mark-micro-16\.svg/.test(p)), problems.join('\n'));
    });

    it('the webmanifest naming a stale icon, the old blue, or the wrong page colour', () => {
        const stale = mutate(WEBMANIFEST, manifest.outputs.icon_192.file.replace('public', ''), '/brand/icon-192.00000000.png');
        assert.ok(problemsWith({ [WEBMANIFEST]: stale }).some((p) => /icons is/.test(p)));
        const blue = mutate(WEBMANIFEST, '"theme_color": "#111210"', '"theme_color": "#0071e3"');
        assert.ok(problemsWith({ [WEBMANIFEST]: blue }).some((p) => /theme_color is "#0071e3", expected "#111210"/.test(p)));
        const bg = mutate(WEBMANIFEST, '"background_color": "#111210"', '"background_color": "#161617"');
        assert.ok(problemsWith({ [WEBMANIFEST]: bg }).some((p) => /background_color is "#161617"/.test(p)));
    });

    for (const page of PAGES) {
        it(`${page}: a head that loses a link, gains a second icon, or keeps only the old SVG is refused`, () => {
            const html = read(page);
            const tag = HEAD_TAGS[2];
            const lost = mutate(page, `${tag}\n`, '');
            assert.ok(problemsWith({ [page]: lost }).some((p) => p.includes(`${page}: expected exactly one ${tag}`)), 'apple-touch lost');
            const svgOnly = html.replace(`    ${HEAD_TAGS[0]}\n`, '');
            assert.notEqual(svgOnly, html, 'the .ico link is there to remove');
            assert.ok(problemsWith({ [page]: svgOnly }).some((p) => p.includes(HEAD_TAGS[0])), '.ico lost');
            const extra = html.replace(HEAD_TAGS[3], `<link rel="icon" href="/other.png">\n    ${HEAD_TAGS[3]}`);
            assert.ok(problemsWith({ [page]: extra }).some((p) => /3 rel="icon" links/.test(p)), 'a third icon');
        });
    }

    it('tokens.css painting the mark in the wrong colourway, or keeping the lit gradient', () => {
        const css = 'dashboard/css/tokens.css';
        const swapped = mutate(css, '    --mark-tile: #bcde70;\n    --mark-glyph: #141610;', '    --mark-tile: #1a1c15;\n    --mark-glyph: #bcde70;');
        assert.ok(problemsWith({ [css]: swapped }).some((p) => /tokens\.css \(dark\)/.test(p)));
        const light = mutate(css, '    --mark-tile: #1a1c15;\n    --mark-glyph: #bcde70;\n}\n\n/* Latin', '    --mark-tile: #bcde70;\n    --mark-glyph: #141610;\n}\n\n/* Latin');
        assert.ok(problemsWith({ [css]: light }).some((p) => /tokens\.css \(light \(pinned\)\)/.test(p)));
        const lit = read(css).replace('--mark-glyph: #141610;', '--mark-glyph: #141610;\n    --mark-tile-lit: linear-gradient(#0a7cf0, #0064cc);');
        assert.ok(problemsWith({ [css]: lit }).some((p) => /still defines --mark-tile-lit/.test(p)));
    });

    it('a root file with no route: public/** has no static handler, so it would 404 in production', () => {
        const index = 'src/index.ts';
        const gone = mutate(index, "app.get('/favicon.ico'", "app.get('/favicon-old.ico'");
        assert.ok(problemsWith({ [index]: gone }).some((p) => /does not serve \/favicon\.ico/.test(p)));
        const wrongFile = mutate(index, "'../public/apple-touch-icon.png'", "'../public/apple-touch.png'");
        assert.ok(problemsWith({ [index]: wrongFile }).some((p) => /does not serve \/apple-touch-icon\.png/.test(p)));
    });

    it('old releases are pruned: a third copy of a hashed icon in public/brand is refused', () => {
        const extra = `${BRAND_DIR}/icon-512.deadbeef.png`;
        const extra2 = `${BRAND_DIR}/icon-512.cafebabe.png`;
        const problems = problemsWith({ [extra]: 'x', [extra2]: 'y' });
        assert.ok(problems.some((p) => /holds 3 copies of icon-512/.test(p)), problems.join('\n'));
    });
});

describe('every inline mark in the repo is the master geometry, painted from the mark tokens', () => {
    const PATH = new RegExp(`<path class="mark-glyph" d="([^"]*)"/>`, 'g');
    const TILE = '<rect class="mark-tile" width="256" height="256" rx="64"/>';
    const files = [
        ['dashboard/index.html', 2],
        ['dashboard/js/components.js', 1],
        ...['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404'].map((p) => [`public/${p}.html`, 2]),
    ];

    for (const [file, count] of files) {
        it(`${file}: ${count} mark${count > 1 ? 's' : ''}, the master's tile and glyph, decorative`, () => {
            const text = read(file);
            const paths = [...text.matchAll(PATH)].map((m) => m[1]);
            assert.equal(paths.length, count);
            for (const d of paths) assert.equal(d, GLYPH_MASTER);
            assert.equal(text.split(TILE).length - 1, count, 'the tile: 256, radius 64 (two modules)');
            const svgs = [...text.matchAll(/<svg [^>]*viewBox="0 0 256 256"[^>]*>/g)].map((m) => m[0]);
            assert.equal(svgs.length, count);
            for (const tag of svgs) assert.ok(tag.includes('aria-hidden="true"'), 'the name beside it (or the link\'s own) is the accessible name');
        });
    }

    it('the pages that draw a lockup carry the name in the link, in both languages, so a mark-only bar still has one', () => {
        for (const p of ['landing', 'pricing', 'privacy', 'terms', 'data-deletion', '404']) {
            const html = read(`public/${p}.html`);
            const links = [...html.matchAll(/<a class="wordmark[^"]*" href="\/"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]);
            assert.equal(links.length, 2, `${p}: the bar and the footer`);
            for (const inner of links) {
                assert.ok(inner.includes('<bdi class="t-ar" lang="ar" dir="rtl">أوتوريبلاي برو</bdi>') && inner.includes('<bdi class="t-en" lang="en" dir="ltr">AutoReply Pro</bdi>'), p);
            }
        }
    });

    it('no page, script or stylesheet in the shell still draws a mark by other means (a tile div with a lucide glyph)', () => {
        for (const f of ['dashboard/index.html', 'dashboard/js/pages/invite.js', 'dashboard/js/pages/welcome.js']) {
            const text = read(f);
            assert.equal(/(?:logo-mark|login-mark)[^>]*><i data-lucide/.test(text), false, f);
        }
    });
});

describe('the raster agrees with headless Chrome where Chrome is exact (opt-in: needs a local Chrome, skipped in CI)', () => {
    const chrome = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((b) => b && existsSync(b));

    it('the master at 64px and the full-bleed file at 180px differ from Chrome only by Skia\'s antialiasing', (t) => {
        if (!chrome) return t.skip('no local Chrome');
        const dir = mkdtempSync(join(tmpdir(), 'brand-icons-'));
        try {
            for (const [name, size] of [['mark-cardamom.svg', 64], ['mark-fullbleed-maskable.svg', 180]]) {
                const page = join(dir, 'p.html');
                writeFileSync(page, `<!doctype html><body style="margin:0;background:#808080"><img src="file://${process.cwd()}/${SRC_DIR}/${name}" width="${size}" height="${size}" style="display:block">`);
                const out = join(dir, `${name}.png`);
                execFileSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--force-color-profile=srgb', '--no-first-run', `--user-data-dir=${join(dir, 'profile')}`, '--window-size=600,600', `--screenshot=${out}`, `file://${page}`], { stdio: 'ignore', timeout: 60_000 });
                const shot = decodePng(readFileSync(out));
                const mine = renderMark(source(name), size);
                let worst = 0;
                let total = 0;
                for (let y = 0; y < size; y++) {
                    for (let x = 0; x < size; x++) {
                        const a = mine.rgba[(y * size + x) * 4 + 3] / 255;
                        for (let c = 0; c < 3; c++) {
                            const over = mine.rgba[(y * size + x) * 4 + c] * a + 128 * (1 - a); // over the page's grey, as Chrome drew it
                            const d = Math.abs(over - shot.rgba[(y * shot.width + x) * 4 + c]);
                            worst = Math.max(worst, d);
                            total += d;
                        }
                    }
                }
                assert.ok(worst <= 60, `${name} at ${size}: worst channel difference ${worst}`);
                assert.ok(total / (size * size * 3) < 1.5, `${name} at ${size}: mean difference ${total / (size * size * 3)}`);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('the build leaves nothing behind', () => {
    it('public/brand holds this release of each icon and at most one before it', () => {
        const names = readdirSync(BRAND_DIR);
        for (const spec of Object.values(OUTPUTS).filter((o) => o.stem)) {
            const mine = names.filter((n) => new RegExp(`^${spec.stem}\\.[0-9a-f]{8}\\.${spec.ext}$`).test(n));
            assert.ok(mine.length >= 1 && mine.length <= 2, `${spec.stem}: ${mine.join(', ')}`);
        }
    });
});
